// Wiring: transport, the instrument table, the pattern sequence, and files.

import {
  makeInstrument, makePattern, makeSong, songFromJson, songToJson,
} from "./song.js";
import { Engine } from "./engine.js";
import { Grid } from "./grid.js";

const $ = (id) => document.getElementById(id);

let song = makeSong();
let engine = new Engine(song);
let grid = null;
let dirty = false;

function markDirty() {
  dirty = true;
  $("songName").classList.add("dirty");
}

// ------------------------------------------------------------- transport

function play() {
  engine.song = song;
  engine.start();
  $("playBtn").textContent = "■ Stop";
}

function stop() {
  engine.stop();
  $("playBtn").textContent = "▶ Play";
  grid.playRow = -1;
  grid.paintCursor();
}

function togglePlay() {
  if (engine.playing) stop(); else play();
}

// ---------------------------------------------------------- instruments

function renderInstruments() {
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

    const roll = document.createElement("button");
    roll.className = "btn-mini";
    roll.textContent = "🎲";
    roll.title = "Roll a new seed";
    roll.addEventListener("click", () => {
      inst.seed = Math.floor(Math.random() * 4294967296);
      engine.clearCache();
      renderInstruments();
      markDirty();
    });
    row.appendChild(roll);

    for (const [key, label, min, max, unit] of [
      ["octave", "oct", -3, 3, ""],
      ["volume", "vol", 0, 500, "%"],
      ["cutoff", "cut", -48, 48, "st"],
      ["resonance", "res", -30, 30, "dB"],
    ]) {
      const wrap = document.createElement("label");
      wrap.className = "inst-num";
      wrap.title = label;
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

    const audition = document.createElement("button");
    audition.className = "btn-mini";
    audition.textContent = "♪";
    audition.title = "Audition";
    audition.addEventListener("click", () =>
      engine.preview({ note: 0, inst: i, vel: 64, vol: 64, rel: null, cut: null }, i));
    row.appendChild(audition);

    row.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "BUTTON") return;
      grid.currentInstrument = i;
      renderInstruments();
    });

    list.appendChild(row);
  });
}

// ------------------------------------------------------------- sequence

function renderSequence() {
  const list = $("seqList");
  list.replaceChildren();

  song.sequence.forEach((patIdx, i) => {
    const item = document.createElement("div");
    item.className = "seq-item";
    if (patIdx === grid.patternIndex) item.classList.add("sel");

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
      renderSequence();
    });
    item.appendChild(sel);

    const del = document.createElement("button");
    del.className = "btn-mini";
    del.textContent = "×";
    del.title = "Remove from the sequence";
    del.addEventListener("click", () => {
      if (song.sequence.length <= 1) return;
      song.sequence.splice(i, 1);
      markDirty();
      renderSequence();
    });
    item.appendChild(del);

    item.addEventListener("mousedown", (e) => {
      if (e.target.tagName !== "DIV" && e.target.tagName !== "SPAN") return;
      grid.patternIndex = song.sequence[i];
      grid.render();
      renderSequence();
    });

    list.appendChild(item);
  });
}

// ----------------------------------------------------------------- files

function download(name, text) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function saveSong() {
  song.name = $("songName").value || "Untitled";
  download(`${song.name.replace(/[^\w \-().]/g, "_")}.json`,
           JSON.stringify(songToJson(song), null, 2));
  dirty = false;
  $("songName").classList.remove("dirty");
}

function loadSongText(text) {
  let loaded;
  try {
    loaded = songFromJson(JSON.parse(text));
  } catch (err) {
    setStatus(`Could not load that file: ${err.message}`);
    return;
  }
  stop();
  song = loaded;
  engine = new Engine(song);
  engine.onRow = (seq, row) => grid.setPlayRow(seq, row);
  grid.song = song;
  grid.engine = engine;
  grid.patternIndex = 0;
  grid.cursor = { row: 0, track: 0, col: 0 };
  $("songName").value = song.name;
  $("bpm").value = String(song.bpm);
  $("rpb").value = String(song.rowsPerBeat);
  grid.render();
  renderInstruments();
  renderSequence();
  dirty = false;
  $("songName").classList.remove("dirty");
  setStatus(`Loaded "${song.name}"`);
}

function setStatus(text) {
  $("status").textContent = text || "";
}

// ------------------------------------------------------------------ init

function init() {
  grid = new Grid($("grid"), song, engine);
  grid.currentInstrument = 0;
  grid.onEdit = markDirty;
  engine.onRow = (seq, row) => grid.setPlayRow(seq, row);

  grid.render();
  renderInstruments();
  renderSequence();

  $("playBtn").addEventListener("click", togglePlay);
  $("rewindBtn").addEventListener("click", () => {
    engine.rewind();
    grid.setPlayRow(0, 0);
  });

  $("songName").addEventListener("input", () => { song.name = $("songName").value; markDirty(); });
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
  $("octave").addEventListener("change", () => {
    grid.octave = Number($("octave").value) || 0;
  });
  $("step").addEventListener("change", () => {
    grid.step = Math.max(0, Math.min(16, Number($("step").value) || 1));
  });

  $("addInst").addEventListener("click", () => {
    if (song.instruments.length >= 100) return;
    song.instruments.push(
      makeInstrument(`Instrument ${song.instruments.length}`,
                     Math.floor(Math.random() * 4294967296)));
    renderInstruments();
    markDirty();
  });

  $("addPattern").addEventListener("click", () => {
    const name = String.fromCharCode(65 + (song.patterns.length % 26)) +
                 (song.patterns.length >= 26 ? String(Math.floor(song.patterns.length / 26)) : "");
    song.patterns.push(makePattern(name, song.patterns[grid.patternIndex]?.length ?? 64));
    grid.patternIndex = song.patterns.length - 1;
    grid.render();
    renderSequence();
    markDirty();
  });

  $("addSeq").addEventListener("click", () => {
    song.sequence.push(grid.patternIndex);
    renderSequence();
    markDirty();
  });

  $("saveBtn").addEventListener("click", saveSong);
  $("loadBtn").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    loadSongText(await file.text());
    e.target.value = "";
  });

  // Space plays and stops from anywhere that is not a text field, which is
  // the one shortcut every tracker shares.
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
    e.preventDefault();
    e.returnValue = "";
  });

  $("grid").focus();
  setStatus("Click the grid and type. Z–M are the lower octave, Q–P the upper.");
}

window.addEventListener("load", init);
