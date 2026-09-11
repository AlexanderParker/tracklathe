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

import { NOTE_OFF, patternAt, rowDuration } from "./song.js?v=4";

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
    this.held = new Array(16).fill(null);

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
    // Per-row variants of an instrument, keyed on what the row changed.
    // zyn keys its effect nodes on the instrument config, so a fresh copy
    // per note would mean a fresh set of nodes per note.
    this.voiceCache = new Map();
  }

  ready() {
    return typeof Z !== "undefined" && Z.aC;
  }

  ensureAudio() {
    if (typeof Z === "undefined") return false;
    if (!Z.aC) Z.init();
    // zyn keeps a small cache of effect nodes and, past a limit, disconnects
    // the oldest half of them -- including the ones carrying notes that are
    // still sounding. Eight instruments with a couple of oscillators each
    // sit right at that limit, so a song would fall silent every few bars
    // and come back as new nodes were built. Raise it out of reach: the
    // nodes are gains and a handful of convolvers, and a song has a bounded
    // set of them.
    Z.maxFxNodes = 100000;
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
    this.voiceCache.clear();
  }

  // A per-note copy of the instrument with the row's own filter and release
  // applied.
  //
  // Both are done by editing the instrument rather than by a live control,
  // because a live control in zyn is global: it would bend every sounding
  // note on every track, and a tracker column has to mean "this note". The
  // filter is multiplicative on the envelope, which is the same thing a
  // detune in cents does to a biquad, and the release scales the gain
  // envelope's own R.
  voiceFor(slot, cell) {
    const base = this.instrumentFor(slot);
    if (!base) return null;

    const cut = cell.cut ?? 0;
    const rel = cell.rel;
    if (!cut && (rel === null || rel === undefined)) return base;

    const key = `${this.song.instruments[slot].seed}:${cut}:${rel ?? ""}`;
    const cached = this.voiceCache.get(key);
    if (cached) return cached;

    // Shallow per-oscillator copy: only the two envelopes are touched, and
    // the fx sub-objects stay identical by value so zyn's node cache --
    // which keys on the config -- shares the reverb with the original.
    const ratio = Math.pow(2, cut / 12);
    const relScale = rel === null || rel === undefined ? 1 : Math.max(rel, 1) / 25;

    const copy = { ...base, oscs: base.oscs.map((o) => {
      const osc = { ...o };
      if (cut) {
        const f = o.adsrFilter;
        osc.adsrFilter = {
          A: [f.A[0], Math.min(1, f.A[1] * ratio)],
          D: [f.D[0], Math.min(1, f.D[1] * ratio)],
          S: [f.S[0], Math.min(1, f.S[1] * ratio)],
          R: [f.R[0], Math.min(1, f.R[1] * ratio)],
        };
      }
      if (relScale !== 1) {
        const g = o.adsrGain;
        osc.adsrGain = { A: g.A, D: g.D, S: g.S, R: [g.R[0] * relScale, g.R[1]] };
      }
      return osc;
    }) };
    this.voiceCache.set(key, copy);
    return copy;
  }

  // Build every instrument's effect chain before the first row, silently.
  // A reverb is a convolver with an impulse the length of its tail, and zyn
  // generates that the first time an instrument sounds -- on the main
  // thread, in the middle of the bar. Better in the moment before the song
  // starts.
  prewarm() {
    const when = Z.aC.currentTime;
    this.song.instruments.forEach((def, slot) => {
      const inst = this.instrumentFor(slot);
      if (!inst) return;
      try {
        const id = Z.noteOn(0, inst, 0, when);
        if (id) Z.noteOff(id, when);
      } catch (e) { /* a broken seed is a broken seed */ }
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
    if (this.onStop) this.onStop();
  }

  rewind() {
    this.sequenceIndex = 0;
    this.row = 0;
    this.position = { seq: 0, row: 0 };
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
      const inst = this.voiceFor(slot, cell);
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
      const id = Z.noteOn(note, inst, gain, when);
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
    const inst = this.voiceFor(slot, cell);
    if (!inst) return;
    const vel = (cell.vel ?? 64) / 64;
    const vol = (cell.vol ?? 64) / 64;
    Z.play(cell.note + def.octave * 12, inst, (def.volume / 100) * vel * vol);
  }
}
