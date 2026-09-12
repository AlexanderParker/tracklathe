// Playback: turning rows into scheduled notes.
//
// Two clocks, deliberately kept apart, the way a game keeps physics apart
// from rendering.
//
// The AUDIO side runs off the AudioContext clock. A timer in a Worker wakes
// the scheduler every few milliseconds; each wake, it queues every row that
// falls inside the next half second, handing each note to zyn with an
// explicit start time. From then on the audio thread owns those notes. The
// main thread can stall for four hundred milliseconds -- a pattern switch on
// a phone, a garbage collection -- and nothing is heard, because everything
// due in that window was already queued before the stall.
//
// The UI side never hears from the scheduler. It asks, once per animation
// frame, "which row is sounding at this audio time?" and draws that. No DOM
// work happens in the scheduler, and no audio work happens in the frame.
//
// setTimeout on its own jitters by whole milliseconds and stops being called
// in a background tab; a Worker's timer keeps going, and is not queued behind
// the page's layout and paint the way a main-thread timer is.

import { NOTE_OFF, patternAt, rowDuration } from "./song.js?v=10";

const TICK_MS = 20;           // how often the scheduler looks
const SCHEDULE_AHEAD = 0.5;   // how far ahead it queues, in seconds

// The Worker is nothing but a metronome: it has no access to the audio
// context and does not want any.
const WORKER_SRC = `
  let timer = null;
  onmessage = (e) => {
    if (e.data === "start") timer = setInterval(() => postMessage(0), ${TICK_MS});
    else { clearInterval(timer); timer = null; }
  };
`;

export class Engine {
  constructor(song) {
    this.song = song;
    this.playing = false;
    this.sequenceIndex = 0;
    this.row = 0;
    this.nextRowTime = 0;
    this.worker = null;
    this.fallbackTimer = null;

    // What each track is currently holding, so a note can be cut by the next
    // one on the same track or by an explicit OFF -- which is what makes a
    // tracker monophonic per track and lets a held pad end where you say.
    this.held = [];

    // Rows queued but not yet audible, in time order. The display reads the
    // one whose time has come; nothing here calls out to it.
    this.pending = [];
    this.position = { seq: 0, row: 0 };
    this.onStop = null;

    // Rows the scheduler found already in the past when it got to them:
    // the main thread was held longer than the lookahead. Zero in normal
    // running; anything else is the number to look at first.
    this.lateRows = 0;

    // Instruments are generated once and cached: getInstrument is pure, and
    // regenerating a five-oscillator patch on every note would be the most
    // expensive thing in the loop by a wide margin.
    this.instCache = new Map();
  }

  ready() {
    return typeof Z !== "undefined" && Z.aC;
  }

  ensureAudio() {
    if (typeof Z === "undefined") return false;
    if (!Z.aC) Z.init();
    // zyn caches effect nodes per instrument config and drops the least
    // recently used idle ones past a limit. Eight instruments with a couple
    // of oscillators each sit right at its default of fifty, and a dropped
    // node is a convolver to rebuild in the middle of a bar; give a song
    // room to keep all of its own. It must not be unbounded: every seed
    // rolled during playback leaves a convolver and a delay loop behind,
    // each costing the audio thread something until it is dropped, and at
    // a thousand of them the audio clock was measured falling seconds
    // behind real time.
    Z.maxFxNodes = 96;
    Z.warmUp();
    if (Z.aC.state === "suspended") Z.aC.resume();
    return true;
  }

  // The generated instrument for a slot, with the slot's own voicing already
  // folded in where zyn has no other way to take it.
  instrumentFor(slot) {
    const def = this.song.instruments[slot];
    if (!def) return null;
    let inst = this.instCache.get(def.seed);
    if (!inst) {
      inst = Z.getInstrument(def.seed);
      this.instCache.set(def.seed, inst);
    }
    return inst;
  }

  clearCache() {
    this.instCache.clear();
  }

  // The row's own filter and release, as per-note options for zyn.
  //
  // These used to be done by editing a copy of the instrument, and that was
  // the thing that killed playback: zyn keys its effect nodes on the
  // instrument config, so every distinct cut value was a new instrument to
  // it, with its own nodes. An arpeggio sweeping the filter across sixty-four
  // rows minted sixty-four instruments a pattern and flooded the cache; the
  // trim then evicted the reverbs of everything else, which were rebuilt on
  // their next note, in the middle of the bar, until the audio thread gave
  // up. Now the instrument is the same object for every note and zyn applies
  // the offsets to the note's own nodes.
  noteOptions(cell) {
    const rel = cell.rel;
    return {
      cutoff: cell.cut ?? 0,
      release: rel === null || rel === undefined ? 1 : Math.max(rel, 1) / 25,
    };
  }

  // Build every instrument's effect chain before the first row, silently.
  // A reverb is a convolver with an impulse the length of its tail, and zyn
  // generates that the first time an instrument sounds -- on the main
  // thread, in the middle of the bar. Better in the moment before the song
  // starts.
  prewarm() {
    this.song.instruments.forEach((def, slot) => {
      const inst = this.instrumentFor(slot);
      if (!inst) return;
      // No voice, no sound: zyn builds the effect chains and nothing else.
      // (A note at gain zero is not silent in zyn -- a gain LFO adds to the
      // parameter whatever the envelope is doing -- which is how this used
      // to play a chord of every instrument on every press of play.)
      try { Z.prepare(inst); } catch (e) { /* a broken seed is a broken seed */ }
    });
  }

  start() {
    if (this.playing) return;
    if (!this.ensureAudio()) return;

    this.playing = true;
    this.pending = [];
    this.lateRows = 0;
    this.prewarm();
    this.nextRowTime = Z.aC.currentTime + 0.08;
    this.position = { seq: this.sequenceIndex, row: this.row };

    try {
      const blob = new Blob([WORKER_SRC], { type: "application/javascript" });
      this.worker = new Worker(URL.createObjectURL(blob));
      this.worker.onmessage = () => this.tick();
      this.worker.postMessage("start");
    } catch (e) {
      // No Worker (a file:// page, an old browser): the main thread's timer
      // is worse, but it is what there is.
      this.worker = null;
      this.fallbackTimer = setInterval(() => this.tick(), TICK_MS);
    }
    this.tick();
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    if (this.fallbackTimer) { clearInterval(this.fallbackTimer); this.fallbackTimer = null; }
    this.pending = [];
    for (let t = 0; t < this.held.length; ++t) this.releaseTrack(t);
    Z.stopAll();
    // The scheduler is a lookahead past what was heard; pick up again from
    // the row the listener actually got to, not the one that was queued.
    this.sequenceIndex = this.position.seq;
    this.row = this.position.row;
    if (this.onStop) this.onStop();
  }

  rewind() {
    this.seek(0, 0);
  }

  // Move playback to a row. While playing, everything queued past this
  // moment is abandoned and the tracks are released, so the jump is heard
  // at once rather than after the lookahead has drained.
  seek(seq, row) {
    this.sequenceIndex = seq;
    this.row = row;
    this.position = { seq, row };
    if (!this.playing) return;
    this.pending = [];
    for (let t = 0; t < this.held.length; ++t) this.releaseTrack(t);
    this.nextRowTime = Z.aC.currentTime + 0.05;
  }

  releaseTrack(track, when = null) {
    const id = this.held[track];
    if (!id) return;
    this.held[track] = null;
    try { Z.noteOff(id, when); } catch (e) { /* already gone */ }
  }

  // ------------------------------------------------------------ audio side

  tick() {
    if (!this.playing) return;
    const now = Z.aC.currentTime;
    if (this.nextRowTime < now) this.lateRows += 1;

    while (this.nextRowTime < now + SCHEDULE_AHEAD) {
      this.scheduleRow(this.nextRowTime);
      this.advance();
    }
  }

  scheduleRow(when) {
    const pattern = patternAt(this.song, this.sequenceIndex);
    if (!pattern) return;
    this.pending.push({ at: when, seq: this.sequenceIndex, row: this.row });

    pattern.tracks.forEach((rows, track) => {
      const cell = rows[this.row];
      if (!cell || cell.note === null || cell.note === undefined) return;

      // Any new event on a track ends what that track was holding -- at the
      // row's own time, not now, or every note would end a lookahead early.
      // Without this a track would stack notes on top of each other, which
      // is not what a single column means.
      this.releaseTrack(track, when);
      if (cell.note === NOTE_OFF) return;

      const slot = cell.inst ?? 0;
      const def = this.song.instruments[slot];
      if (!def) return;
      const inst = this.instrumentFor(slot);
      if (!inst) return;

      // Velocity and the volume column multiply: velocity is how hard the
      // note was struck, volume is where the fader sits. 64 reads as unity
      // in both, the tracker convention.
      const vel = (cell.vel ?? 64) / 64;
      const vol = (cell.vol ?? 64) / 64;
      const gain = (def.volume / 100) * vel * vol;
      const note = cell.note + def.octave * 12;

      // Sustained, so the next note on this track can cut it. A one-shot
      // would ignore both OFF and the note after it.
      const id = Z.noteOn(note, inst, gain, when, this.noteOptions(cell));
      this.held[track] = id;
    });
  }

  advance() {
    this.nextRowTime += rowDuration(this.song);
    const pattern = patternAt(this.song, this.sequenceIndex);
    const length = pattern ? pattern.length : 64;

    if (++this.row >= length) {
      this.row = 0;
      if (++this.sequenceIndex >= this.song.sequence.length) this.sequenceIndex = 0;
    }
  }

  // --------------------------------------------------------------- UI side

  // The row being heard at the given audio time. Called from the animation
  // frame; the scheduler is up to SCHEDULE_AHEAD ahead of this.
  positionAt(time) {
    while (this.pending.length && this.pending[0].at <= time)
      this.position = this.pending.shift();
    return this.position;
  }

  // Audition one cell immediately, for editing.
  preview(cell, slot) {
    if (!this.ensureAudio()) return;
    const def = this.song.instruments[slot];
    if (!def || cell.note === null || cell.note === NOTE_OFF) return;
    const inst = this.instrumentFor(slot);
    if (!inst) return;
    const vel = (cell.vel ?? 64) / 64;
    const vol = (cell.vol ?? 64) / 64;
    Z.play(cell.note + def.octave * 12, inst, (def.volume / 100) * vel * vol,
           null, this.noteOptions(cell));
  }
}
