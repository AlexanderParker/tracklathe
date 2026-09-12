// The song: instruments, patterns, and the order the patterns play in.
//
// A song file carries note data and nothing else. Instruments are seeds plus
// the handful of settings a sound is voiced at, which means a whole song --
// every instrument in it included -- is a few kilobytes of JSON that can sit
// in a gist. There are no samples to lose and no synth state to go stale,
// because the seed regenerates the instrument wherever it is opened.

export const FORMAT = "tracklathe-song";
export const VERSION = 1;

export const MAX_TRACKS = 32;
export const DEFAULT_TRACKS = 8;
export const MAX_PATTERN_ROWS = 256;

// A cell is null when empty. `note` is a semitone offset from middle C, so 0
// is C-4 and negatives go down -- the same numbering zyn uses, which saves a
// conversion at the only place it would be easy to get wrong.
//
// NOTE_OFF is a cell that stops whatever the track is holding.
export const NOTE_OFF = "off";

export function emptyCell() {
  return { note: null, inst: null, vel: null, rel: null, cut: null, vol: null };
}

export function isEmptyCell(c) {
  return !c || (c.note === null && c.inst === null && c.vel === null &&
                c.rel === null && c.cut === null && c.vol === null);
}

export function makeInstrument(name, seed) {
  return {
    name: name || "Instrument",
    seed: seed >>> 0,
    octave: 0,
    volume: 100,      // percent
    cutoff: 0,        // semitones of filter transposition
    resonance: 0,     // dB added to the filter Q
  };
}

export function makePattern(name, length = 64, tracks = DEFAULT_TRACKS) {
  return {
    name: name || "Pattern",
    length,
    // Dense in memory because a grid wants O(1) indexing; sparse on disk,
    // where a 64-row 8-track pattern would otherwise be five hundred nulls.
    tracks: Array.from({ length: tracks }, () =>
      Array.from({ length }, () => null)),
  };
}

export function makeSong() {
  const song = {
    format: FORMAT,
    version: VERSION,
    name: "Untitled",
    bpm: 125,
    rowsPerBeat: 4,
    instruments: [makeInstrument("Lead", 2360196101)],
    patterns: [makePattern("A")],
    sequence: [0],
  };
  return song;
}

// Seconds per row. A tracker's clock is rows, not beats: rowsPerBeat 4 at
// 125 BPM is the 120 ms row that most chiptune was written on.
export function rowDuration(song) {
  return 60 / song.bpm / song.rowsPerBeat;
}

export function patternAt(song, sequenceIndex) {
  const idx = song.sequence[sequenceIndex];
  return song.patterns[idx] ?? null;
}

// ---------------------------------------------------------------- saving

function cellToJson(c) {
  const out = {};
  for (const k of ["note", "inst", "vel", "rel", "cut", "vol"])
    if (c[k] !== null && c[k] !== undefined) out[k] = c[k];
  return out;
}

export function songToJson(song) {
  return {
    format: FORMAT,
    version: VERSION,
    name: song.name,
    bpm: song.bpm,
    rowsPerBeat: song.rowsPerBeat,
    instruments: song.instruments.map((i) => ({ ...i })),
    patterns: song.patterns.map((p) => ({
      name: p.name,
      length: p.length,
      // Sparse: row index -> cell, so an empty pattern costs almost nothing
      // and a diff of two songs shows the notes that changed.
      tracks: p.tracks.map((rows) => {
        const out = {};
        rows.forEach((c, i) => {
          if (!isEmptyCell(c)) out[i] = cellToJson(c);
        });
        return out;
      }),
    })),
    sequence: [...song.sequence],
  };
}

// ---------------------------------------------------------------- loading

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, dflt) => (typeof v === "number" && Number.isFinite(v) ? v : dflt);

function cellFromJson(j) {
  if (!j || typeof j !== "object") return null;
  const c = emptyCell();
  if (j.note === NOTE_OFF) c.note = NOTE_OFF;
  else if (typeof j.note === "number") c.note = clamp(Math.round(j.note), -60, 60);
  if (typeof j.inst === "number") c.inst = clamp(Math.round(j.inst), 0, 99);
  if (typeof j.vel === "number") c.vel = clamp(Math.round(j.vel), 0, 99);
  if (typeof j.rel === "number") c.rel = clamp(Math.round(j.rel), 0, 99);
  if (typeof j.cut === "number") c.cut = clamp(Math.round(j.cut), -99, 99);
  if (typeof j.vol === "number") c.vol = clamp(Math.round(j.vol), 0, 99);
  return isEmptyCell(c) ? null : c;
}

// Anything at all can be dropped on this, so every field is bounded and a
// malformed pattern costs that pattern rather than the whole song.
export function songFromJson(j) {
  if (!j || typeof j !== "object") throw new Error("not a song file");
  if (j.format !== FORMAT) throw new Error("not a Tracklathe song");

  const song = makeSong();
  song.name = typeof j.name === "string" ? j.name.slice(0, 64) : "Untitled";
  song.bpm = clamp(num(j.bpm, 125), 20, 400);
  song.rowsPerBeat = clamp(Math.round(num(j.rowsPerBeat, 4)), 1, 16);

  song.instruments = [];
  if (Array.isArray(j.instruments)) {
    for (const ij of j.instruments.slice(0, 100)) {
      if (!ij || typeof ij !== "object") continue;
      const inst = makeInstrument(
        typeof ij.name === "string" ? ij.name.slice(0, 32) : "Instrument",
        num(ij.seed, 0));
      inst.octave = clamp(Math.round(num(ij.octave, 0)), -3, 3);
      inst.volume = clamp(num(ij.volume, 100), 0, 500);
      inst.cutoff = clamp(num(ij.cutoff, 0), -48, 48);
      inst.resonance = clamp(num(ij.resonance, 0), -30, 30);
      song.instruments.push(inst);
    }
  }
  if (!song.instruments.length) song.instruments = [makeInstrument("Lead", 2360196101)];

  song.patterns = [];
  if (Array.isArray(j.patterns)) {
    for (const pj of j.patterns.slice(0, 256)) {
      if (!pj || typeof pj !== "object") continue;
      const length = clamp(Math.round(num(pj.length, 64)), 1, MAX_PATTERN_ROWS);
      const trackCount = Array.isArray(pj.tracks)
        ? clamp(pj.tracks.length, 1, MAX_TRACKS) : DEFAULT_TRACKS;
      const p = makePattern(
        typeof pj.name === "string" ? pj.name.slice(0, 32) : "Pattern",
        length, trackCount);

      if (Array.isArray(pj.tracks)) {
        pj.tracks.slice(0, MAX_TRACKS).forEach((rows, t) => {
          if (!rows || typeof rows !== "object") return;
          for (const [key, cj] of Object.entries(rows)) {
            const row = Number(key);
            if (!Number.isInteger(row) || row < 0 || row >= length) continue;
            p.tracks[t][row] = cellFromJson(cj);
          }
        });
      }
      song.patterns.push(p);
    }
  }
  if (!song.patterns.length) song.patterns = [makePattern("A")];

  song.sequence = Array.isArray(j.sequence)
    ? j.sequence
        .filter((n) => Number.isInteger(n) && n >= 0 && n < song.patterns.length)
        .slice(0, 1024)
    : [];
  if (!song.sequence.length) song.sequence = [0];

  return song;
}

// ------------------------------------------------------------ note names

const NAMES = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];

// Middle C is note 0 and shows as C-4, which is what a tracker player expects
// to see even though the engine counts from zero.
export function noteName(n) {
  if (n === NOTE_OFF) return "OFF";
  if (n === null || n === undefined) return "---";
  const semi = ((n % 12) + 12) % 12;
  const octave = 4 + Math.floor(n / 12);
  return NAMES[semi] + octave;
}
