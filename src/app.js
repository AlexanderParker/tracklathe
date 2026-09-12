// Wiring: tabs, transport, instruments, patterns, storage and files.

import {
  makeInstrument, makePattern, makeSong, songFromJson, songToJson,
} from "./song.js?v=10";
import { Engine } from "./engine.js?v=10";
import { Grid } from "./grid.js?v=10";
import { Pad } from "./pad.js?v=10";
import * as store from "./store.js?v=10";

const $ = (id) => document.getElementById(id);

// Must match version.json and the ?v= cache keys. GitHub Pages caches
// every file for ten minutes, so a reload inside that window can pair a
// fresh page with stale scripts, or the reverse -- and the result is a
// page that half works, which is worse than one that says so.
const BUILD = 10;

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
  if (name === "instruments") { renderInstruments(); ensureEditor(); }
  if (name === "patterns") renderPatterns();
  if (name === "sequence") renderSequence();
  if (name === "songs") renderSongs();
}

// ------------------------------------------------------------- transport

function play() {
  engine.song = song;
  // From the cursor, in the pattern on screen -- if that pattern is in the
  // sequence at all. If it is not, play from wherever playback last was.
  const seq = sequenceIndexShowing();
  if (seq >= 0) engine.seek(seq, grid.cursor.row);
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
    grid.showPlayhead(pos.seq, pos.row);
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
  grid.showPlayhead(p.seq, p.row);
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
  grid.patternIndex = n;
  grid.cursor.row = 0;
  grid.render();
  $("patLength").value = String(song.patterns[n].length);
  renderPatSelect();
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

const EDITOR_ORIGIN = "https://alexanderparker.github.io";
let editorSeed = null;

function ensureEditor() {
  const frame = $("zynFrame");
  if (frame.src) return;
  sendToEditor();
}

function sendToEditor() {
  const inst = song.instruments[grid.currentInstrument ?? 0];
  const seed = inst ? inst.seed : 0;
  $("zynFrame").src = `${EDITOR_ORIGIN}/zyn/?instrumentSeed=${seed}`;
}

function takeFromEditor() {
  if (editorSeed === null) return;
  const i = grid.currentInstrument ?? 0;
  const inst = song.instruments[i];
  if (!inst) return;
  inst.seed = editorSeed >>> 0;
  engine.clearCache();
  renderInstruments();
  markDirty();
  setStatus(`Instrument ${String(i).padStart(2, "0")} is now seed ${inst.seed}`);
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
    });
    row.appendChild(seed);

    row.appendChild(mini("🎲", "Roll a new seed", () => {
      inst.seed = Math.floor(Math.random() * 4294967296);
      engine.clearCache();
      renderInstruments();
      markDirty();
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
      grid.patternIndex = i;
      $("patLength").value = String(p.length);
      renderPatterns();
      renderPatSelect();
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

function renderSequence() {
  const list = $("seqList");
  list.replaceChildren();

  song.sequence.forEach((patIdx, i) => {
    const item = document.createElement("div");
    item.className = "seq-item";

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

    if (song.sequence.length > 1)
      item.appendChild(mini("×", "Remove from the sequence", () => {
        song.sequence.splice(i, 1);
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
  grid.onInstrument = () => renderInstruments();
  $("instSelect").addEventListener("change", () => {
    grid.currentInstrument = Number($("instSelect").value);
    renderInstruments();
    grid.root.focus({ preventScroll: true });
  });
  $("patSelect").addEventListener("change", () => {
    grid.patternIndex = Number($("patSelect").value);
    grid.cursor.row = Math.min(grid.cursor.row, song.patterns[grid.patternIndex].length - 1);
    grid.render();
    $("patLength").value = String(song.patterns[grid.patternIndex].length);
    grid.root.focus({ preventScroll: true });
  });
  grid.onPattern = (idx) => {
    $("patLength").value = String(song.patterns[idx].length);
    $("patSelect").value = String(idx);
  };
  $("newPattern").addEventListener("click", newPattern);
  $("moreTracks").addEventListener("click", () => setTrackCount(song.patterns[0].tracks.length + 1));
  $("fewerTracks").addEventListener("click", () => setTrackCount(song.patterns[0].tracks.length - 1));

  $("editorSend").addEventListener("click", sendToEditor);
  $("editorTake").addEventListener("click", takeFromEditor);
  window.addEventListener("message", (e) => {
    if (e.origin !== EDITOR_ORIGIN) return;
    const d = e.data;
    if (!d || d.type !== "zyn-seed" || !Number.isFinite(Number(d.seed))) return;
    editorSeed = Number(d.seed);
    $("editorSeed").textContent = `Editor is showing seed ${editorSeed}`;
    $("editorTake").disabled = false;
  });

  pad = new Pad($("pad"), grid);
  // For poking at from the console: the engine's lateRows counter is the
  // first thing to read when playback misbehaves.
  window.tracklathe = { get engine() { return engine; }, get grid() { return grid; } };
  grid.render();
  renderInstruments();
  renderPatterns();
  renderSequence();

  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => showTab(t.dataset.tab)));

  $("playBtn").addEventListener("click", togglePlay);
  $("rewindBtn").addEventListener("click", () => {
    engine.rewind();
    grid.showPlayhead(0, 0);
  });
  grid.onSeek = (row) => {
    const seq = sequenceIndexShowing();
    if (seq < 0) { setStatus("This pattern is not in the sequence, so it cannot be played from here"); return; }
    engine.seek(seq, row);
    grid.showPlayhead(seq, row);
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
