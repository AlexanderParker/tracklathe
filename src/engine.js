// Playback: turning rows into scheduled notes.
//
// The clock is the AudioContext's, never setTimeout's. A timer tells us WHEN
// TO LOOK, and every note it finds is handed to zyn with an explicit start
// time slightly in the future. setTimeout on its own jitters by whole
// milliseconds and stops being called at all in a background tab, both of
// which a listener hears immediately on a tracker row.
//
// This is the standard Web Audio lookahead loop: wake often, schedule ahead,
// and let the audio clock place the notes.

import { NOTE_OFF, patternAt, rowDuration } from "./song.js";

const TICK_MS = 25;          // how often we look
const SCHEDULE_AHEAD = 0.12; // how far ahead we queue, in seconds

export class Engine {
  constructor(song) {
    this.song = song;
    this.playing = false;
    this.sequenceIndex = 0;
    this.row = 0;
    this.nextRowTime = 0;
    this.timer = null;

    // What each track is currently holding, so a note can be cut by the next
    // one on the same track or by an explicit OFF -- which is what makes a
    // tracker monophonic per track and lets a held pad end where you say.
    this.held = new Array(16).fill(null);

    // Rows already scheduled but not yet audible, so the display can show
    // the row being heard rather than the one being queued.
    this.pending = [];
    this.onRow = null;      // (sequenceIndex, row) => void
    this.onStop = null;

    // Instruments are generated once and cached: getInstrument is pure, and
    // regenerating a five-oscillator patch on every note would be the most
    // expensive thing in the loop by a wide margin.
    this.instCache = new Map();
  }

  ready() {
    return typeof Z !== "undefined" && Z.aC;
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

    // Shallow per-oscillator copy: only the two envelopes are touched, and
    // the fx sub-objects must stay identical by value or zyn's node cache --
    // which keys on the config -- would build a fresh reverb per note.
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
    return copy;
  }

  start() {
    if (this.playing) return;
    if (typeof Z === "undefined") return;
    if (!Z.aC) Z.init();
    Z.warmUp();
    if (Z.aC.state === "suspended") Z.aC.resume();

    this.playing = true;
    this.pending = [];
    this.nextRowTime = Z.aC.currentTime + 0.05;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this.timer);
    this.timer = null;
    this.pending = [];
    for (let t = 0; t < this.held.length; ++t) this.releaseTrack(t);
    Z.stopAll();
    if (this.onStop) this.onStop();
  }

  rewind() {
    this.sequenceIndex = 0;
    this.row = 0;
  }

  releaseTrack(track) {
    const id = this.held[track];
    if (!id) return;
    this.held[track] = null;
    try { Z.noteOff(id); } catch (e) { /* already gone */ }
  }

  tick() {
    if (!this.playing) return;
    const now = Z.aC.currentTime;

    while (this.nextRowTime < now + SCHEDULE_AHEAD) {
      this.scheduleRow(this.nextRowTime);
      this.advance();
    }

    // Report the row the listener is actually hearing, which is behind the
    // one being queued by up to SCHEDULE_AHEAD.
    while (this.pending.length && this.pending[0].at <= now) {
      const done = this.pending.shift();
      if (this.onRow) this.onRow(done.seq, done.row);
    }
  }

  scheduleRow(when) {
    const pattern = patternAt(this.song, this.sequenceIndex);
    if (!pattern) return;
    this.pending.push({ at: when, seq: this.sequenceIndex, row: this.row });

    pattern.tracks.forEach((rows, track) => {
      const cell = rows[this.row];
      if (!cell || cell.note === null || cell.note === undefined) return;

      // Any new event on a track ends what that track was holding. Without
      // this a track would stack notes on top of each other, which is not
      // what a single column means.
      this.releaseTrack(track);
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

  // Audition one cell immediately, for editing.
  preview(cell, slot) {
    if (typeof Z === "undefined") return;
    if (!Z.aC) Z.init();
    Z.warmUp();
    if (Z.aC.state === "suspended") Z.aC.resume();

    const def = this.song.instruments[slot];
    if (!def || cell.note === null || cell.note === NOTE_OFF) return;
    const inst = this.voiceFor(slot, cell);
    if (!inst) return;
    const vel = (cell.vel ?? 64) / 64;
    const vol = (cell.vol ?? 64) / 64;
    Z.play(cell.note + def.octave * 12, inst, (def.volume / 100) * vel * vol);
  }
}
