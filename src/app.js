// Wiring: tabs, transport, instruments, patterns, storage and files.

import {
  makeInstrument, makePattern, makeSong, songFromJson, songToJson,
} from "./song.js?v=13";
import { Engine } from "./engine.js?v=13";
import { Grid } from "./grid.js?v=13";
import { Pad } from "./pad.js?v=13";
import * as store from "./store.js?v=13";

const $ = (id) => document.getElementById(id);

// Must match version.json and the ?v= cache keys. GitHub Pages caches
// every file for ten minutes, so a reload inside that window can pair a
// fresh page with stale scripts, or the reverse -- and the result is a
// page that half works, which is worse than one that says so.
const BUILD = 13;

let song = makeSong();
let engine = new Engine(song);
let grid = null;
let pad = null;
let dirty = false;
let autosaveTimer = null;

function markDirty() {
  dirty = true;
  $("songName").classList.add("dirty");
  // Debounced, because an edit arrives per keystroke and serialising the
  // song on each one would make fast entry stutter.
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => store.autosave(songToJson(song)), 800);
}

function setStatus(text) {
  $("status").textContent = text || "";
}

// ----------------------------------------------------------------- tabs

function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("sel", t.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((p) =>
    p.classList.toggle("sel", p.id === `tab-${name}`));

  // The grid only exists while its tab is shown, so the cursor has to be
  // repainted when it comes back -- and refocused, or the keys go nowhere.
  if (name === "tracker") {
    grid.render();
    grid.root.focus({ preventScroll: true });
  }
  if (name === "instruments") { renderInstruments(); syncEditor(); }
  if (name === "patterns") renderPatterns();
  if (name === "sequence") renderSequence();
  if (name === "songs") renderSongs();
}

// ------------------------------------------------------------- transport

// Start (or move) playback at a row of the pattern on screen. In the
// sequence, that means its slot in the song; not in the sequence, or with
// Loop on, the pattern plays on its own, round and round.
function locate(row) {
  const seq = sequenceIndexShowing();
  if (loopOn || seq < 0) {
    engine.seek(engine.sequenceIndex, row, grid.patternIndex);
    if (seq < 0 && !loopOn)
      setStatus(`Looping pattern ${song.patterns[grid.patternIndex].name}: it is not in the sequence`);
  } else {
    engine.seek(seq, row, null);
  }
}

let loopOn = false;

function play() {
  engine.song = song;
  // From the cursor, in the pattern on screen: the row you are looking at
  // is the one you want to hear.
  locate(grid.cursor.row);
  engine.start();
  if (!engine.playing) return;
  $("playBtn").textContent = "■";
  // The display is driven from here, not from the scheduler: each frame
  // asks the engine which row the listener is hearing at this audio time
  // and draws that. Audio is queued a quarter second ahead of this and does
  // not wait for it.
  const frame = () => {
    if (!engine.playing) return;
    const pos = engine.positionAt(Z.aC.currentTime);
    grid.showPlayhead(pos.pat, pos.row);
    frameHandle = requestAnimationFrame(frame);
  };
  frameHandle = requestAnimationFrame(frame);
}

let frameHandle = 0;

function stop() {
  engine.stop();
  cancelAnimationFrame(frameHandle);
  $("playBtn").textContent = "▶";
  // The highlight stays where playback got to: that is where it resumes.
  const p = engine.position;
  grid.showPlayhead(p.pat, p.row);
}

// Show a pattern for editing: cursor to the top, and playback -- if it is
// running -- to the top of the same pattern, so what is heard is what is
// on screen.
function switchPattern(idx) {
  if (idx < 0 || idx >= song.patterns.length) return;
  grid.patternIndex = idx;
  grid.cursor.row = 0;
  grid.render();
  $("patLength").value = String(song.patterns[idx].length);
  $("patSelect").value = String(idx);
  if (engine.playing) locate(0);
  else { const p = engine.position; if (p.pat === idx) grid.showPlayhead(idx, p.row); }
}

// The sequence position that plays the pattern on screen: the current one
// if it does, else the first that does. -1 if the pattern is not in the
// sequence at all, in which case there is nowhere to seek to.
function sequenceIndexShowing() {
  const idx = grid.patternIndex;
  if (song.sequence[engine.position.seq] === idx) return engine.position.seq;
  return song.sequence.indexOf(idx);
}

function togglePlay() {
  if (engine.playing) stop(); else play();
}

// ---------------------------------------------------------- instruments

function renderInstSelect() {
  const sel = $("instSelect");
  sel.replaceChildren();
  song.instruments.forEach((inst, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `${String(i).padStart(2, "0")} ${inst.name}`;
    sel.appendChild(opt);
  });
  sel.value = String(Math.min(grid.currentInstrument ?? 0, song.instruments.length - 1));
}

function renderPatSelect() {
  const sel = $("patSelect");
  sel.replaceChildren();
  song.patterns.forEach((p, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `${String(i).padStart(2, "0")} ${p.name}`;
    sel.appendChild(opt);
  });
  sel.value = String(grid.patternIndex);
  $("trackCount").textContent = String(song.patterns[0].tracks.length);
}

function newPattern() {
  const n = song.patterns.length;
  const name = String.fromCharCode(65 + (n % 26)) + (n >= 26 ? String(Math.floor(n / 26)) : "");
  const tracks = song.patterns[0].tracks.length;
  song.patterns.push(makePattern(name, song.patterns[grid.patternIndex]?.length ?? 64, tracks));
  song.sequence.push(n);
  renderPatSelect();
  switchPattern(n);
  markDirty();
  setStatus(`Pattern ${name} added to the end of the sequence`);
}

// Every pattern has the same number of tracks; adding or removing one
// changes them all. Removing drops the last track, which is the only
// destructive thing here, so it asks if anything is in it.
function setTrackCount(n) {
  n = Math.max(1, Math.min(32, n));
  const cur = song.patterns[0].tracks.length;
  if (n === cur) return;
  if (n < cur) {
    const used = song.patterns.some((p) => p.tracks.slice(n).some((rows) => rows.some((c) => c)));
    if (used && !confirm(`Track ${cur} has notes in it. Remove it anyway?`)) return;
  }
  song.patterns.forEach((p) => {
    while (p.tracks.length < n) p.tracks.push(Array.from({ length: p.length }, () => null));
    p.tracks.length = n;
  });
  if (grid.cursor.track >= n) grid.cursor.track = n - 1;
  grid.render();
  renderPatSelect();
  markDirty();
}

// --------------------------------------------------------------- editor
//
// The zyn editor, in a frame, bound to the selected instrument. Selecting
// an instrument shows it in the editor; anything done in the editor -- a
// seed typed, rolled or found, the octave, the volume -- lands on the
// instrument as it happens, and the next note played uses it.

const EDITOR_ORIGIN = "https://alexanderparker.github.io";
let editorReady = false;     // the frame has posted its first state
let editorPending = null;    // a state to show once it has

function editorFrame() { return $("zynFrame"); }

function selectedInstrument() {
  const i = Math.min(grid.currentInstrument ?? 0, song.instruments.length - 1);
  return { i, inst: song.instruments[i] };
}

// Show the selected instrument in the editor. Loads the frame on first use
// (only once the Instruments tab has been opened: the editor is a whole
// page and nobody who never looks at it should pay for it).
function syncEditor() {
  const { i, inst } = selectedInstrument();
  if (!inst) return;
  $("editorTarget").textContent = `editing ${String(i).padStart(2, "0")} ${inst.name}`;
  const frame = editorFrame();
  const state = { type: "zyn-load", seed: inst.seed, octave: inst.octave, volume: inst.volume / 100 };
  if (!frame.src) {
    if (!$("tab-instruments").classList.contains("sel")) return;
    editorReady = false;
    editorPending = state;
    frame.src = `${EDITOR_ORIGIN}/zyn/?instrumentSeed=${inst.seed}`;
    return;
  }
  if (!editorReady) { editorPending = state; return; }
  frame.contentWindow.postMessage(state, EDITOR_ORIGIN);
}

// The editor changed: the selected instrument follows.
function applyEditorState(d) {
  const { i, inst } = selectedInstrument();
  if (!inst) return;
  const seed = Number(d.seed) >>> 0;
  const octave = d.octave === undefined ? inst.octave : Math.max(-3, Math.min(3, Math.round(Number(d.octave)) || 0));
  const volume = d.volume === undefined ? inst.volume
    : Math.max(0, Math.min(500, Math.round(Number(d.volume) * 100)));
  if (seed === inst.seed && octave === inst.octave && volume === inst.volume) return;
  inst.seed = seed;
  inst.octave = octave;
  inst.volume = volume;
  engine.clearCache();
  renderInstruments();
  markDirty();
  setStatus(`Instrument ${String(i).padStart(2, "0")} is now seed ${seed}`);
}

function renderInstruments() {
  renderInstSelect();
  renderPatSelect();
  const list = $("instList");
  list.replaceChildren();

  song.instruments.forEach((inst, i) => {
    const row = document.createElement("div");
    row.className = "inst-row";
    if (i === (grid?.currentInstrument ?? 0)) row.classList.add("sel");

    const idx = document.createElement("span");
    idx.className = "inst-idx";
    idx.textContent = String(i).padStart(2, "0");
    row.appendChild(idx);

    const name = document.createElement("input");
    name.className = "inst-name";
    name.value = inst.name;
    name.addEventListener("input", () => { inst.name = name.value; markDirty(); });
    row.appendChild(name);

    const seed = document.createElement("input");
    seed.className = "inst-seed";
    seed.type = "number";
    seed.value = String(inst.seed);
    seed.title = "The seed. This whole instrument is generated from it.";
    seed.addEventListener("change", () => {
      inst.seed = Math.max(0, Math.min(4294967295, Number(seed.value) || 0));
      seed.value = String(inst.seed);
      engine.clearCache();
      markDirty();
      if (i === grid.currentInstrument) syncEditor();
    });
    row.appendChild(seed);

    row.appendChild(mini("🎲", "Roll a new seed", () => {
      inst.seed = Math.floor(Math.random() * 4294967296);
      engine.clearCache();
      renderInstruments();
      markDirty();
      if (i === grid.currentInstrument) syncEditor();
    }));

    for (const [key, label, min, max, unit] of [
      ["octave", "oct", -3, 3, ""],
      ["volume", "vol", 0, 500, "%"],
      ["cutoff", "cut", -48, 48, "st"],
      ["resonance", "res", -30, 30, "dB"],
    ]) {
      const wrap = document.createElement("label");
      wrap.className = "inst-num";
      const input = document.createElement("input");
      input.type = "number";
      input.value = String(inst[key]);
      input.min = String(min);
      input.max = String(max);
      input.addEventListener("change", () => {
        inst[key] = Math.max(min, Math.min(max, Number(input.value) || 0));
        input.value = String(inst[key]);
        markDirty();
      });
      wrap.append(label, input, unit);
      row.appendChild(wrap);
    }

    row.appendChild(mini("♪", "Audition", () =>
      engine.preview({ note: 0, inst: i, vel: 64, vol: 64, rel: null, cut: null }, i)));

    if (song.instruments.length > 1)
      row.appendChild(mini("×", "Remove", () => {
        song.instruments.splice(i, 1);
        engine.clearCache();
        renderInstruments();
        markDirty();
      }, "btn-danger"));

    row.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "BUTTON") return;
      grid.currentInstrument = i;
      renderInstruments();
      syncEditor();
    });

    list.appendChild(row);
  });
}

function mini(text, title, onClick, cls = "") {
  const b = document.createElement("button");
  b.className = `btn-mini ${cls}`;
  b.textContent = text;
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

// ------------------------------------------------------------- patterns

function renderPatterns() {
  const list = $("patList");
  list.replaceChildren();

  song.patterns.forEach((p, i) => {
    const item = document.createElement("div");
    item.className = "pat-item";
    if (i === grid.patternIndex) item.classList.add("sel");

    const idx = document.createElement("span");
    idx.className = "pat-idx";
    idx.textContent = String(i).padStart(2, "0");
    item.appendChild(idx);

    const name = document.createElement("input");
    name.className = "pat-name";
    name.value = p.name;
    name.addEventListener("input", () => {
      p.name = name.value; markDirty(); renderSequence();
    });
    item.appendChild(name);

    const len = document.createElement("span");
    len.className = "song-meta";
    len.textContent = `${p.length} rows`;
    item.appendChild(len);

    item.appendChild(mini("Edit", "Edit this pattern", () => {
      renderPatSelect();
      switchPattern(i);
      renderPatterns();
      showTab("tracker");
    }));

    if (song.patterns.length > 1)
      item.appendChild(mini("×", "Delete this pattern", () => {
        song.patterns.splice(i, 1);
        song.sequence = song.sequence
          .map((n) => (n === i ? -1 : n > i ? n - 1 : n))
          .filter((n) => n >= 0);
        if (!song.sequence.length) song.sequence = [0];
        if (grid.patternIndex >= song.patterns.length)
          grid.patternIndex = song.patterns.length - 1;
        renderPatterns();
        renderSequence();
        markDirty();
      }, "btn-danger"));

    list.appendChild(item);
  });
}

function moveSequenceEntry(from, to) {
  if (to < 0 || to >= song.sequence.length || from === to) return;
  const [entry] = song.sequence.splice(from, 1);
  song.sequence.splice(to, 0, entry);
  // Keep the playhead on the same entry, wherever it went.
  if (engine.position.seq === from) { engine.sequenceIndex = to; engine.position.seq = to; }
  else if (from < engine.position.seq && to >= engine.position.seq) { engine.sequenceIndex--; engine.position.seq--; }
  else if (from > engine.position.seq && to <= engine.position.seq) { engine.sequenceIndex++; engine.position.seq++; }
  markDirty();
  renderSequence();
}

// Reordering by dragging the handle. Pointer events rather than HTML drag
// and drop, which touch screens do not do; the item follows the finger up
// and down the list and the song is rewritten from the list on release.
function dragToReorder(handle, item) {
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const list = item.parentElement;
    const from = Array.from(list.children).indexOf(item);
    item.classList.add("dragging");
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".seq-item");
      if (!over || over === item || over.parentElement !== list) return;
      const r = over.getBoundingClientRect();
      const before = ev.clientY < r.top + r.height / 2;
      list.insertBefore(item, before ? over : over.nextSibling);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      item.classList.remove("dragging");
      const to = Array.from(list.children).indexOf(item);
      moveSequenceEntry(from, to);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  });
}

function renderSequence() {
  const list = $("seqList");
  list.replaceChildren();

  song.sequence.forEach((patIdx, i) => {
    const item = document.createElement("div");
    item.className = "seq-item";
    if (engine.position.seq === i && engine.loopPattern === null) item.classList.add("sel");

    const handle = document.createElement("span");
    handle.className = "seq-handle";
    handle.textContent = "≡";
    handle.title = "Drag to reorder";
    item.appendChild(handle);
    dragToReorder(handle, item);

    const pos = document.createElement("span");
    pos.className = "seq-pos";
    pos.textContent = String(i).padStart(2, "0");
    item.appendChild(pos);

    const sel = document.createElement("select");
    song.patterns.forEach((p, pi) => {
      const opt = document.createElement("option");
      opt.value = String(pi);
      opt.textContent = p.name;
      if (pi === patIdx) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", () => {
      song.sequence[i] = Number(sel.value);
      markDirty();
    });
    item.appendChild(sel);

    item.appendChild(mini("▲", "Move up", () => moveSequenceEntry(i, i - 1)));
    item.appendChild(mini("▼", "Move down", () => moveSequenceEntry(i, i + 1)));

    if (song.sequence.length > 1)
      item.appendChild(mini("×", "Remove from the sequence", () => {
        song.sequence.splice(i, 1);
        if (engine.sequenceIndex >= song.sequence.length) engine.sequenceIndex = 0;
        markDirty();
        renderSequence();
      }, "btn-danger"));

    list.appendChild(item);
  });
}

// --------------------------------------------------------------- songs

function renderSongs() {
  $("storeNote").textContent = store.canStore
    ? ""
    : "This browser will not let the page store anything -- export to a file instead.";

  const list = $("songList");
  list.replaceChildren();

  const songs = store.listSongs();
  if (!songs.length) {
    const empty = document.createElement("div");
    empty.className = "song-empty";
    empty.textContent = "Nothing saved yet.";
    list.appendChild(empty);
    return;
  }

  for (const entry of songs) {
    const item = document.createElement("div");
    item.className = "song-item";

    const name = document.createElement("span");
    name.className = "song-name";
    name.textContent = entry.name;
    item.appendChild(name);

    const meta = document.createElement("span");
    meta.className = "song-meta";
    meta.textContent = `${store.describeAge(entry.savedAt)} · ${Math.round(entry.bytes / 102.4) / 10} kB`;
    item.appendChild(meta);

    item.appendChild(mini("Load", "Open this song", () => {
      if (dirty && !confirm(`Discard unsaved changes to "${song.name}"?`)) return;
      const json = store.loadSong(entry.name);
      if (!json) { setStatus("That saved song could not be read"); return; }
      adoptSong(json, `Loaded "${entry.name}"`);
    }));

    item.appendChild(mini("×", "Delete", () => {
      if (!confirm(`Delete "${entry.name}" from this browser?`)) return;
      store.deleteSong(entry.name);
      renderSongs();
      setStatus(`Deleted "${entry.name}"`);
    }, "btn-danger"));

    list.appendChild(item);
  }
}

function saveToBrowser() {
  song.name = $("songName").value || "Untitled";
  if (store.songExists(song.name) &&
      !confirm(`"${song.name}" already exists here. Replace it?`)) return;

  const res = store.saveSong(song.name, songToJson(song));
  if (!res.ok) { setStatus(res.error); return; }
  dirty = false;
  $("songName").classList.remove("dirty");
  renderSongs();
  setStatus(`Saved "${song.name}" in this browser`);
}

// ----------------------------------------------------------------- files

function exportFile() {
  song.name = $("songName").value || "Untitled";
  const text = JSON.stringify(songToJson(song), null, 2);
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${song.name.replace(/[^\w \-().]/g, "_")}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus(`Exported "${song.name}"`);
}

function adoptSong(json, message) {
  let loaded;
  try {
    loaded = songFromJson(json);
  } catch (err) {
    setStatus(`Could not load that: ${err.message}`);
    return false;
  }
  stop();
  song = loaded;
  engine = new Engine(song);
  grid.song = song;
  grid.engine = engine;
  grid.patternIndex = 0;
  grid.cursor = { row: 0, track: 0, col: 0 };
  loopOn = false;
  $("loopBtn").classList.remove("on");
  grid.currentInstrument = 0;

  $("songName").value = song.name;
  $("bpm").value = String(song.bpm);
  $("rpb").value = String(song.rowsPerBeat);
  $("patLength").value = String(song.patterns[0].length);

  grid.render();
  pad.sync();
  renderInstruments();
  renderPatterns();
  renderSequence();
  $("zynFrame").removeAttribute("src");
  editorReady = false;
  editorPending = null;
  dirty = false;
  $("songName").classList.remove("dirty");
  setStatus(message);
  return true;
}

// Pick up where the last session left off. Offered rather than applied:
// silently replacing what someone opened the page expecting is worse than
// asking. A banner rather than confirm(), because a modal raised from the
// load handler stops the page finishing loading at all -- and on a phone it
// is a system alert before anything has even been drawn.
function offerRestore() {
  const auto = store.readAutosave();
  if (!auto) return;
  const name = (auto.song && auto.song.name) || "Untitled";

  const bar = document.createElement("div");
  bar.className = "restore";

  const text = document.createElement("span");
  text.textContent = `Unsaved work on "${name}" from ${store.describeAge(auto.savedAt)}.`;
  bar.appendChild(text);

  const yes = document.createElement("button");
  yes.className = "btn-primary";
  yes.textContent = "Restore";
  yes.addEventListener("click", () => {
    adoptSong(auto.song, `Restored "${name}"`);
    bar.remove();
  });
  bar.appendChild(yes);

  const no = document.createElement("button");
  no.className = "btn";
  no.textContent = "Discard";
  no.addEventListener("click", () => {
    store.clearAutosave();
    bar.remove();
  });
  bar.appendChild(no);

  document.body.insertBefore(bar, document.querySelector("main"));
}

// Ask the server, bypassing every cache, which build it is serving; if
// that is not the one running, offer a reload. Failure is silence: this
// is a courtesy, not a gate.
async function checkForNewerBuild() {
  try {
    const res = await fetch("version.json", { cache: "no-store" });
    if (!res.ok) return;
    const { v } = await res.json();
    if (!Number.isInteger(v) || v === BUILD) return;
    const bar = document.createElement("div");
    bar.className = "restore";
    const text = document.createElement("span");
    text.textContent = `A newer Tracklathe is available (build ${v}; this is ${BUILD}).`;
    const btn = document.createElement("button");
    btn.className = "btn-primary";
    btn.textContent = "Reload";
    btn.addEventListener("click", () => location.reload());
    bar.append(text, btn);
    document.body.insertBefore(bar, document.querySelector("main"));
  } catch (e) { /* offline, or a file:// page */ }
}

// ------------------------------------------------------------------ init

function init() {
  grid = new Grid($("grid"), song, engine);
  grid.currentInstrument = 0;
  grid.onEdit = () => { markDirty(); pad.sync(); };
  grid.onCursor = () => pad.sync();
  grid.onInstrument = () => { renderInstruments(); syncEditor(); };
  $("instSelect").addEventListener("change", () => {
    grid.currentInstrument = Number($("instSelect").value);
    renderInstruments();
    syncEditor();
    grid.root.focus({ preventScroll: true });
  });
  $("patSelect").addEventListener("change", () => {
    switchPattern(Number($("patSelect").value));
    grid.root.focus({ preventScroll: true });
  });
  grid.onPattern = (idx) => {
    $("patLength").value = String(song.patterns[idx].length);
    $("patSelect").value = String(idx);
  };
  $("newPattern").addEventListener("click", newPattern);
  $("moreTracks").addEventListener("click", () => setTrackCount(song.patterns[0].tracks.length + 1));
  $("fewerTracks").addEventListener("click", () => setTrackCount(song.patterns[0].tracks.length - 1));

  window.addEventListener("message", (e) => {
    if (e.origin !== EDITOR_ORIGIN) return;
    const d = e.data;
    if (!d || d.type !== "zyn-state" || !Number.isFinite(Number(d.seed))) return;
    if (!editorReady) {
      // First word from the frame: it is up. Show it what it should be
      // showing, and ignore what it loaded with.
      editorReady = true;
      if (editorPending) { editorFrame().contentWindow.postMessage(editorPending, EDITOR_ORIGIN); editorPending = null; }
      return;
    }
    applyEditorState(d);
  });

  pad = new Pad($("pad"), grid);
  // For poking at from the console: the engine's lateRows counter is the
  // first thing to read when playback misbehaves.
  window.tracklathe = {
    get engine() { return engine; }, get grid() { return grid; },
    get editor() { return { ready: editorReady, pending: editorPending }; },
  };
  grid.render();
  renderInstruments();
  renderPatterns();
  renderSequence();

  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => showTab(t.dataset.tab)));

  $("playBtn").addEventListener("click", togglePlay);
  $("rewindBtn").addEventListener("click", () => {
    engine.rewind();
    grid.showPlayhead(engine.position.pat, 0);
  });
  $("loopBtn").addEventListener("click", () => {
    loopOn = !loopOn;
    $("loopBtn").classList.toggle("on", loopOn);
    if (engine.playing) locate(engine.position.row);
    setStatus(loopOn ? "Looping the pattern on screen" : "Playing the sequence");
  });
  grid.onSeek = (row) => {
    locate(row);
    grid.showPlayhead(grid.patternIndex, row);
  };

  $("songName").addEventListener("input", () => {
    song.name = $("songName").value; markDirty();
  });
  $("bpm").addEventListener("change", () => {
    song.bpm = Math.max(20, Math.min(400, Number($("bpm").value) || 125));
    $("bpm").value = String(song.bpm);
    markDirty();
  });
  $("rpb").addEventListener("change", () => {
    song.rowsPerBeat = Math.max(1, Math.min(16, Number($("rpb").value) || 4));
    $("rpb").value = String(song.rowsPerBeat);
    grid.render();
    markDirty();
  });
  $("patLength").addEventListener("change", () => {
    const p = song.patterns[grid.patternIndex];
    if (!p) return;
    const want = Math.max(1, Math.min(256, Number($("patLength").value) || 64));
    $("patLength").value = String(want);
    // Growing pads with empty rows; shrinking drops what is past the end,
    // which is the only destructive edit here -- hence the confirmation.
    const loses = p.tracks.some((rows) => rows.slice(want).some((c) => c));
    if (want < p.length && loses &&
        !confirm(`Shortening "${p.name}" will delete the notes past row ${want - 1}.`)) {
      $("patLength").value = String(p.length);
      return;
    }
    p.tracks = p.tracks.map((rows) => {
      const next = rows.slice(0, want);
      while (next.length < want) next.push(null);
      return next;
    });
    p.length = want;
    if (grid.cursor.row >= want) grid.cursor.row = want - 1;
    grid.render();
    renderPatterns();
    renderPatSelect();
    markDirty();
  });

  $("addInst").addEventListener("click", () => {
    if (song.instruments.length >= 100) return;
    song.instruments.push(
      makeInstrument(`Instrument ${song.instruments.length}`,
                     Math.floor(Math.random() * 4294967296)));
    renderInstruments();
    markDirty();
  });

  $("addPattern").addEventListener("click", () => { newPattern(); renderPatterns(); });

  $("addSeq").addEventListener("click", () => {
    song.sequence.push(grid.patternIndex);
    renderSequence();
    markDirty();
  });

  $("quickSave").addEventListener("click", saveToBrowser);
  $("saveAs").addEventListener("click", saveToBrowser);
  $("exportBtn").addEventListener("click", exportFile);
  $("importBtn").addEventListener("click", () => $("fileInput").click());
  $("demoBtn").addEventListener("click", async () => {
    if (dirty && !confirm(`Discard unsaved changes to "${song.name}"?`)) return;
    try {
      const res = await fetch("songs/demo.json");
      if (!res.ok) throw new Error(String(res.status));
      adoptSong(await res.json(), "Loaded the demo. Press play.");
      showTab("tracker");
    } catch (err) {
      setStatus("The demo song could not be fetched");
    }
  });
  $("fileInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      adoptSong(JSON.parse(await file.text()), `Imported "${file.name}"`);
    } catch (err) {
      setStatus("That file is not valid JSON");
    }
    e.target.value = "";
  });

  // Space plays and stops from anywhere that is not a field.
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space") return;
    const t = document.activeElement;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT"))
      return;
    e.preventDefault();
    togglePlay();
  });

  window.addEventListener("beforeunload", (e) => {
    if (!dirty) return;
    // Autosave has almost certainly already run, but the browser's own
    // warning is the only thing that can stop the tab closing.
    store.autosave(songToJson(song));
    e.preventDefault();
    e.returnValue = "";
  });

  offerRestore();
  checkForNewerBuild();

  $("grid").focus({ preventScroll: true });
  if (!$("status").textContent)
    setStatus("Tap a cell, then use the pad below. Or type: Z–M and Q–P are notes.");
}

window.addEventListener("load", init);
