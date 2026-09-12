// The pattern grid: rows down, tracks across, six columns per track.
//
// Plain DOM rather than a canvas. A pattern is at most 256 rows and the only
// thing that moves during playback is one highlighted row, so the cost of
// keeping real elements is a class toggle per frame -- and in exchange the
// cursor, selection and text rendering are things the browser already does
// correctly.

import { NOTE_OFF, emptyCell, isEmptyCell, noteName } from "./song.js?v=13";

// Which column of a track the cursor is in.
export const COLS = ["note", "inst", "vel", "rel", "cut", "vol"];

// The tracker keyboard: two rows of the QWERTY layout laid out as piano
// octaves, which is the layout every tracker since Ultimate Soundtracker has
// used and the one a player's fingers already know.
const KEYMAP = {
  z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11,
  ",": 12, l: 13, ".": 14, ";": 15, "/": 16,
  q: 12, 2: 13, w: 14, 3: 15, e: 16, r: 17, 5: 18, t: 19, 6: 20, y: 21,
  7: 22, u: 23, i: 24, 9: 25, o: 26, 0: 27, p: 28,
};

export class Grid {
  constructor(root, song, engine) {
    this.root = root;
    this.song = song;
    this.engine = engine;
    this.patternIndex = 0;
    this.cursor = { row: 0, track: 0, col: 0 };
    this.octave = 0;          // octaves added to typed notes
    this.step = 1;            // rows the cursor advances after entry
    this.playRow = -1;
    this.onEdit = null;       // () => void, for marking the song dirty
    this.onCursor = null;     // () => void, so the input pad can follow
    this.onSeek = null;       // (row) => void, a tap on a row number
    this.onInstrument = null; // () => void, currentInstrument changed

    // A block: the anchor is where Shift was first held, the cursor is the
    // other corner. null when nothing is selected.
    this.anchor = null;
    this.selEls = [];
    // The clipboard: rows x tracks of cells, and which columns were taken.
    this.clip = null;
    // Undo: snapshots of the pattern's cells, taken before each change.
    this.undoStack = [];
    this.redoStack = [];

    this.root.tabIndex = 0;
    this.root.addEventListener("keydown", (e) => this.onKey(e));
    // Pointer events rather than mousedown. iOS only synthesises mouse events
    // for elements it deems clickable -- links, controls, anything with its
    // own click handler -- and a span inside a div is none of those, so on an
    // iPhone a tap on a cell used to do nothing at all. A tap is a pointer
    // that comes back up more or less where it went down; anything else is
    // the grid being scrolled, and must not move the cursor.
    this.root.addEventListener("pointerdown", (e) => {
      this.press = { x: e.clientX, y: e.clientY, target: e.target };
    });
    this.root.addEventListener("pointerup", (e) => this.onTap(e));
    this.root.addEventListener("pointercancel", () => { this.press = null; });
  }

  pattern() {
    return this.song.patterns[this.patternIndex];
  }

  cell(row, track, create = false) {
    const p = this.pattern();
    if (!p || row < 0 || row >= p.length) return null;
    const rows = p.tracks[track];
    if (!rows) return null;
    if (!rows[row] && create) rows[row] = emptyCell();
    return rows[row];
  }

  // ------------------------------------------------------------- drawing

  render() {
    const p = this.pattern();
    if (!p) return;

    const frag = document.createDocumentFragment();
    const header = document.createElement("div");
    header.className = "tl-row tl-head";
    header.appendChild(this.el("div", "tl-rownum", ""));
    p.tracks.forEach((_, t) => {
      const cell = this.el("div", "tl-track", `Track ${t + 1}`);
      header.appendChild(cell);
    });
    frag.appendChild(header);

    for (let r = 0; r < p.length; ++r) {
      const row = document.createElement("div");
      row.className = "tl-row";
      // A line every beat, the way a tracker marks time.
      if (r % this.song.rowsPerBeat === 0) row.classList.add("tl-beat");
      row.dataset.row = String(r);

      row.appendChild(this.el("div", "tl-rownum", String(r).padStart(3, "0")));

      p.tracks.forEach((rows, t) => {
        const track = this.el("div", "tl-track", "");
        const c = rows[r];
        COLS.forEach((col, ci) => {
          const span = this.el("span", `tl-col tl-${col}`, this.text(c, col));
          span.dataset.track = String(t);
          span.dataset.col = String(ci);
          if (isEmptyCell(c)) span.classList.add("tl-empty");
          track.appendChild(span);
        });
        row.appendChild(track);
      });
      frag.appendChild(row);
    }

    this.root.replaceChildren(frag);
    this.rows = Array.from(this.root.querySelectorAll(".tl-row[data-row]"));
    this.lastCursorEl = this.lastHereRow = this.lastPlayingRow = null;
    this.selEls = [];
    this.paintCursor();
  }

  text(c, col) {
    if (col === "note") return noteName(c ? c.note : null);
    const v = c ? c[col] : null;
    // Every column is a fixed width so the grid never reflows as values are
    // typed -- the cut column is three wide because it carries a sign.
    if (col === "cut") {
      if (v === null || v === undefined) return "---";
      const n = Math.min(99, Math.abs(v));
      return (v < 0 ? "-" : "+") + String(n).padStart(2, "0");
    }
    if (v === null || v === undefined) return "--";
    return String(Math.min(99, v)).padStart(2, "0");
  }

  el(tag, cls, text) {
    const e = document.createElement(tag);
    e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  // Only the classes that move, rather than a re-render: this runs on every
  // row while playing.
  paintCursor() {
    if (!this.rows) return;
    this.paintSelection();
    if (this.lastCursorEl) this.lastCursorEl.classList.remove("tl-cursor");
    if (this.lastHereRow) this.lastHereRow.classList.remove("tl-here");
    if (this.lastPlayingRow) this.lastPlayingRow.classList.remove("tl-playing");
    this.lastHereRow = this.lastPlayingRow = null;

    const row = this.rows[this.cursor.row];
    if (row) {
      row.classList.add("tl-here");
      this.lastHereRow = row;
      const sel = row.querySelector(
        `.tl-col[data-track="${this.cursor.track}"][data-col="${this.cursor.col}"]`);
      if (sel) {
        sel.classList.add("tl-cursor");
        this.lastCursorEl = sel;
        this.scrollIntoView(row);
      }
    }
    if (this.playRow >= 0 && this.rows[this.playRow]) {
      this.rows[this.playRow].classList.add("tl-playing");
      this.lastPlayingRow = this.rows[this.playRow];
    }
  }

  // Redraw one track of one row in place. An edit touches one cell, and
  // rebuilding all three thousand spans for it took most of a fifth of a
  // second on a phone -- long enough that typing felt like wading.
  refreshCell(r, t) {
    const row = this.rows && this.rows[r];
    if (!row) return;
    const c = this.pattern().tracks[t][r];
    const empty = isEmptyCell(c);
    row.querySelectorAll(`.tl-col[data-track="${t}"]`).forEach((span) => {
      span.textContent = this.text(c, COLS[Number(span.dataset.col)]);
      span.classList.toggle("tl-empty", empty);
    });
  }

  scrollIntoView(row) {
    const box = this.root.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    if (r.top < box.top + 40) this.root.scrollTop -= box.top + 40 - r.top;
    else if (r.bottom > box.bottom - 40)
      this.root.scrollTop += r.bottom - (box.bottom - 40);
  }

  // Called once per animation frame while playing. Follows the song: when
  // the sequence moves to another pattern the grid switches to it, and the
  // sounding row is kept in the middle of the view, the way every tracker
  // since the Amiga has scrolled.
  showPlayhead(idx, row) {
    if (idx !== undefined && idx !== this.patternIndex) {
      this.patternIndex = idx;
      if (this.cursor.row >= this.pattern().length) this.cursor.row = 0;
      this.render();
      if (this.onPattern) this.onPattern(idx);
    }
    if (row === this.playRow) return;
    this.playRow = row;
    this.paintCursor();
    const el = this.rows && this.rows[row];
    if (el) this.scrollToCentre(el);
  }

  clearPlayhead() {
    this.playRow = -1;
    this.paintCursor();
  }

  scrollToCentre(row) {
    const box = this.root.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const target = box.top + box.height * 0.4;
    const delta = r.top - target;
    // Small drift is corrected each frame; a jump (a new pattern) lands at
    // once rather than easing, which would read as the display lagging.
    if (Math.abs(delta) > 2) this.root.scrollTop += delta;
  }

  // -------------------------------------------------------------- input

  onTap(e) {
    const press = this.press;
    this.press = null;
    if (!press) return;
    if (Math.abs(e.clientX - press.x) > 8 || Math.abs(e.clientY - press.y) > 8) return;
    const row = press.target.closest(".tl-row[data-row]");
    if (!row) return;
    // The row number is the transport: a tap there moves playback, the way
    // clicking a bar number does in any sequencer.
    if (press.target.closest(".tl-rownum")) {
      if (this.onSeek) this.onSeek(Number(row.dataset.row));
      return;
    }
    const col = press.target.closest(".tl-col");
    if (!col) return;
    this.cursor.row = Number(row.dataset.row);
    this.cursor.track = Number(col.dataset.track);
    this.cursor.col = Number(col.dataset.col);
    this.anchor = null;
    this.typingAt = null;
    this.cutSign = null;
    this.paintCursor();
    this.root.focus({ preventScroll: true });
    if (this.onCursor) this.onCursor();
  }

  move(dRow, dTrack, dCol, extend = false) {
    const p = this.pattern();
    if (!p) return;
    if (extend) { if (!this.anchor) this.anchor = { ...this.cursor }; }
    else this.anchor = null;
    this.cursor.row = (this.cursor.row + dRow + p.length) % p.length;

    let col = this.cursor.col + dCol;
    let track = this.cursor.track + dTrack;
    while (col < 0) { col += COLS.length; track -= 1; }
    while (col >= COLS.length) { col -= COLS.length; track += 1; }
    const n = p.tracks.length;
    this.cursor.track = (track + n) % n;
    this.cursor.col = col;
    this.typingAt = null;
    this.cutSign = null;
    this.paintCursor();
    if (this.onCursor) this.onCursor();
  }

  jumpTo(row, extend = false) {
    const p = this.pattern();
    if (!p) return;
    if (extend) { if (!this.anchor) this.anchor = { ...this.cursor }; }
    else this.anchor = null;
    this.cursor.row = Math.max(0, Math.min(p.length - 1, row));
    this.typingAt = null;
    this.cutSign = null;
    this.paintCursor();
    if (this.onCursor) this.onCursor();
  }

  edit(fn) {
    const c = this.cell(this.cursor.row, this.cursor.track, true);
    if (!c) return;
    this.snapshot();
    fn(c);
    const p = this.pattern();
    if (isEmptyCell(c)) p.tracks[this.cursor.track][this.cursor.row] = null;
    this.refreshCell(this.cursor.row, this.cursor.track);
    if (this.onEdit) this.onEdit();
  }

  onKey(e) {
    const k = e.key;
    const lower = k.length === 1 ? k.toLowerCase() : k;
    const ctrl = e.ctrlKey || e.metaKey;
    const sh = e.shiftKey;

    // --- values: Ctrl+Up/Down nudge, Ctrl+Shift+Up/Down by an octave or ten
    if (ctrl && k === "ArrowUp") return this.consume(e, () => this.nudge(sh ? "big" : 1));
    if (ctrl && k === "ArrowDown") return this.consume(e, () => this.nudge(sh ? "-big" : -1));
    // Impulse Tracker's transpose keys, on notes: Alt+Q/A a semitone, Alt+W/S an octave.
    if (e.altKey && !ctrl && lower === "q") return this.consume(e, () => this.transpose(1));
    if (e.altKey && !ctrl && lower === "a") return this.consume(e, () => this.transpose(-1));
    if (e.altKey && !ctrl && lower === "w") return this.consume(e, () => this.transpose(12));
    if (e.altKey && !ctrl && lower === "s") return this.consume(e, () => this.transpose(-12));

    // --- movement, with Shift extending a block
    if (k === "ArrowDown") return this.consume(e, () => this.move(1, 0, 0, sh));
    if (k === "ArrowUp") return this.consume(e, () => this.move(-1, 0, 0, sh));
    if (k === "ArrowRight") return this.consume(e, () => this.move(0, 0, 1, sh));
    if (k === "ArrowLeft") return this.consume(e, () => this.move(0, 0, -1, sh));
    // Page and Home/End clamp rather than wrap: they are for getting to the
    // ends, and wrapping past an end is never what was meant.
    if (k === "PageDown") return this.consume(e, () => this.jumpTo(this.cursor.row + 16, sh));
    if (k === "PageUp") return this.consume(e, () => this.jumpTo(this.cursor.row - 16, sh));
    if (k === "Home") return this.consume(e, () => this.jumpTo(0, sh));
    if (k === "End") return this.consume(e, () => this.jumpTo(Infinity, sh));
    if (k === "Tab")
      return this.consume(e, () => this.move(0, sh ? -1 : 1, 0));
    if (k === "Escape") return this.consume(e, () => { this.anchor = null; this.paintCursor(); });

    // --- blocks: select, copy, cut, paste, interpolate, undo
    if (ctrl && lower === "a") return this.consume(e, () => this.selectAll(sh));
    if (ctrl && lower === "l") return this.consume(e, () => this.selectTrack());
    if ((ctrl || e.altKey) && lower === "c") return this.consume(e, () => this.copy());
    if ((ctrl || e.altKey) && lower === "x") {
      // Alt+X is interpolate in Impulse Tracker, cut everywhere else.
      return this.consume(e, () => (e.altKey && !ctrl ? this.interpolate() : this.cut()));
    }
    if ((ctrl || e.altKey) && lower === "v") return this.consume(e, () => this.paste());
    if (ctrl && lower === "i") return this.consume(e, () => this.interpolate());
    if (ctrl && (lower === "z" || lower === "y")) {
      return this.consume(e, () => ((lower === "y" || sh) ? this.redo() : this.undo()));
    }

    if (k === "Delete") return this.consume(e, () => (this.anchor ? this.clearBlock() : this.clearCell()));
    // Backspace works upward, as it does in text: clear, then step back.
    if (k === "Backspace") return this.consume(e, () => (this.anchor ? this.clearBlock() : this.clearCellUp()));

    // Note off, the tracker convention.
    if (k === "`" || k === "'")
      return this.consume(e, () => this.typeNoteOff());

    const isNote = this.cursor.col === 0;
    if (isNote && lower in KEYMAP && !e.ctrlKey && !e.altKey)
      return this.consume(e, () => this.typeNote(KEYMAP[lower]));

    if (!isNote && /^[0-9]$/.test(k) && !e.ctrlKey)
      return this.consume(e, () => this.typeDigit(Number(k)));

    // The cut column is signed, so it needs a way to say "down".
    if (!isNote && COLS[this.cursor.col] === "cut" && (k === "-" || k === "+"))
      return this.consume(e, () => this.setCutSign(k === "-" ? -1 : 1));
  }

  consume(e, fn) {
    e.preventDefault();
    e.stopPropagation();
    fn();
    return true;
  }

  // Everything below is called by BOTH the keyboard and the on-screen pad.
  // Routing the two through one set of actions is what stops the pad
  // becoming a second, subtly different editor.

  clearCell() {
    this.edit((c) => { for (const col of COLS) c[col] = null; });
    this.move(this.step, 0, 0);
  }

  clearCellUp() {
    this.edit((c) => { for (const col of COLS) c[col] = null; });
    this.move(-this.step, 0, 0);
  }

  typeNoteOff() {
    this.edit((c) => { c.note = NOTE_OFF; });
    this.move(this.step, 0, 0);
  }

  // The sign is remembered for the digits that follow, because negating an
  // empty cell gives -0, and -0 is not less than zero -- which silently
  // dropped the minus off everything typed after it.
  setCutSign(sign) {
    this.cutSign = sign;
    this.edit((c) => { c.cut = sign * Math.abs(c.cut ?? 0); });
  }

  typeNote(semi) {
    const note = semi + this.octave * 12;
    this.edit((c) => {
      c.note = note;
      // Typing a note into an empty cell fills in the instrument, because a
      // note with no instrument is silent and nobody means that.
      if (c.inst === null) c.inst = this.currentInstrument ?? 0;
    });
    const c = this.cell(this.cursor.row, this.cursor.track);
    if (c) this.engine.preview(c, c.inst ?? 0);
    this.move(this.step, 0, 0);
  }

  // Two-digit columns fill left to right, as a tracker's do: type 4 then 2
  // and you get 42, not 4 then 2.
  typeDigit(d) {
    const col = COLS[this.cursor.col];
    this.edit((c) => {
      const cur = c[col];
      const typing = this.typingAt === `${this.cursor.row}:${this.cursor.track}:${col}`;
      const next = typing && cur !== null ? (Math.abs(cur) % 10) * 10 + d : d;
      if (col !== "cut") { c[col] = next; return; }
      // An explicit sign wins; otherwise keep whatever the cell already had.
      const sign = this.cutSign ?? ((cur ?? 0) < 0 ? -1 : 1);
      c.cut = sign * next;
    });
    this.typingAt = `${this.cursor.row}:${this.cursor.track}:${col}`;
    // Typing an instrument number is choosing an instrument: the next notes
    // entered should get it without a trip to the selector.
    if (col === "inst") {
      const c = this.cell(this.cursor.row, this.cursor.track);
      if (c && c.inst !== null && c.inst < this.song.instruments.length) {
        this.currentInstrument = c.inst;
        if (this.onInstrument) this.onInstrument();
      }
    }
    // A second digit lands in the same cell; a third starts over, and the
    // sign only applies to the number it was typed in front of.
    clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => {
      this.typingAt = null;
      this.cutSign = null;
    }, 700);
  }

  // ------------------------------------------------------------- blocks
  //
  // The selection is the rectangle between the anchor and the cursor:
  // a range of rows, a range of tracks, and within a track a range of
  // columns (the first track's from-column to the last track's to-column,
  // as every tracker since Scream Tracker has drawn it).

  selection() {
    if (!this.anchor) return null;
    const a = this.anchor, c = this.cursor;
    const r0 = Math.min(a.row, c.row), r1 = Math.max(a.row, c.row);
    let t0 = a.track, c0 = a.col, t1 = c.track, c1 = c.col;
    if (t1 < t0 || (t1 === t0 && c1 < c0)) { [t0, c0, t1, c1] = [t1, c1, t0, c0]; }
    return { r0, r1, t0, t1, c0, c1 };
  }

  // Which columns of track t the selection covers.
  colsIn(sel, t) {
    const from = t === sel.t0 ? sel.c0 : 0;
    const to = t === sel.t1 ? sel.c1 : COLS.length - 1;
    return COLS.slice(from, to + 1);
  }

  paintSelection() {
    this.selEls.forEach((el) => el.classList.remove("tl-sel"));
    this.selEls = [];
    const sel = this.selection();
    if (!sel || !this.rows) return;
    for (let r = sel.r0; r <= sel.r1; ++r) {
      const row = this.rows[r];
      if (!row) continue;
      for (let t = sel.t0; t <= sel.t1; ++t) {
        for (const col of this.colsIn(sel, t)) {
          const el = row.querySelector(`.tl-col[data-track="${t}"][data-col="${COLS.indexOf(col)}"]`);
          if (el) { el.classList.add("tl-sel"); this.selEls.push(el); }
        }
      }
    }
  }

  selectAll(wholePattern) {
    const p = this.pattern();
    if (!p) return;
    // Once selects the track, again (or with Shift) the whole pattern.
    const sel = this.selection();
    const trackAlready = sel && sel.r0 === 0 && sel.r1 === p.length - 1 &&
      sel.t0 === this.cursor.track && sel.t1 === this.cursor.track && sel.c0 === 0 && sel.c1 === COLS.length - 1;
    if (wholePattern || trackAlready) {
      this.anchor = { row: 0, track: 0, col: 0 };
      this.cursor = { row: p.length - 1, track: p.tracks.length - 1, col: COLS.length - 1 };
    } else {
      this.selectTrack();
      return;
    }
    this.paintCursor();
  }

  selectTrack() {
    const p = this.pattern();
    if (!p) return;
    this.anchor = { row: 0, track: this.cursor.track, col: 0 };
    this.cursor = { row: p.length - 1, track: this.cursor.track, col: COLS.length - 1 };
    this.paintCursor();
  }

  // The block under the selection, or the single cell under the cursor.
  blockOrCell() {
    return this.selection() ?? {
      r0: this.cursor.row, r1: this.cursor.row,
      t0: this.cursor.track, t1: this.cursor.track,
      c0: this.cursor.col, c1: this.cursor.col,
    };
  }

  // Apply fn(cell, col) to every selected column of every selected cell,
  // creating cells as needed and dropping the ones left empty.
  forBlock(sel, fn) {
    const p = this.pattern();
    for (let r = sel.r0; r <= sel.r1; ++r) {
      for (let t = sel.t0; t <= sel.t1; ++t) {
        const c = this.cell(r, t, true);
        if (!c) continue;
        for (const col of this.colsIn(sel, t)) fn(c, col, r, t);
        if (isEmptyCell(c)) p.tracks[t][r] = null;
      }
    }
  }

  afterBlockEdit(sel) {
    for (let r = sel.r0; r <= sel.r1; ++r)
      for (let t = sel.t0; t <= sel.t1; ++t) this.refreshCell(r, t);
    if (this.onEdit) this.onEdit();
  }

  copy() {
    const sel = this.blockOrCell();
    const rows = [];
    for (let r = sel.r0; r <= sel.r1; ++r) {
      const line = [];
      for (let t = sel.t0; t <= sel.t1; ++t) {
        const c = this.cell(r, t);
        const cols = this.colsIn(sel, t);
        const taken = {};
        for (const col of cols) taken[col] = c ? c[col] : null;
        line.push({ cols, values: taken });
      }
      rows.push(line);
    }
    this.clip = rows;
  }

  cut() {
    this.copy();
    this.clearBlock();
  }

  clearBlock() {
    const sel = this.blockOrCell();
    this.snapshot();
    this.forBlock(sel, (c, col) => { c[col] = null; });
    this.afterBlockEdit(sel);
    this.anchor = null;
    this.paintCursor();
  }

  // Pasted at the cursor: the block lands with its top-left on the cursor's
  // row and track, taking the columns it was copied with. Overwrites what is
  // there in those columns; the rest of each cell is left alone.
  paste() {
    if (!this.clip) return;
    const p = this.pattern();
    if (!p) return;
    this.snapshot();
    const r0 = this.cursor.row, t0 = this.cursor.track;
    let r1 = r0, t1 = t0;
    this.clip.forEach((line, dr) => {
      const r = r0 + dr;
      if (r >= p.length) return;
      line.forEach((entry, dt) => {
        const t = t0 + dt;
        if (t >= p.tracks.length) return;
        const c = this.cell(r, t, true);
        for (const col of entry.cols) c[col] = entry.values[col];
        if (isEmptyCell(c)) p.tracks[t][r] = null;
        r1 = Math.max(r1, r); t1 = Math.max(t1, t);
      });
    });
    this.afterBlockEdit({ r0, r1, t0, t1 });
    this.anchor = null;
    this.paintCursor();
  }

  // Linear interpolation down each selected column, from the value in the
  // block's first row to the value in its last: the tracker way to write a
  // fade, a filter sweep or a run of notes.
  interpolate() {
    const sel = this.selection();
    if (!sel || sel.r1 - sel.r0 < 2) return;
    this.snapshot();
    let did = false;
    for (let t = sel.t0; t <= sel.t1; ++t) {
      for (const col of this.colsIn(sel, t)) {
        const a = this.cell(sel.r0, t), b = this.cell(sel.r1, t);
        const v0 = a ? a[col] : null, v1 = b ? b[col] : null;
        if (typeof v0 !== "number" || typeof v1 !== "number") continue;
        const n = sel.r1 - sel.r0;
        for (let r = sel.r0 + 1; r < sel.r1; ++r) {
          const c = this.cell(r, t, true);
          c[col] = Math.round(v0 + (v1 - v0) * (r - sel.r0) / n);
          if (col === "note" && c.inst === null) c.inst = (a && a.inst !== null) ? a.inst : (this.currentInstrument ?? 0);
        }
        did = true;
      }
    }
    if (did) this.afterBlockEdit(sel);
  }

  // Nudge the value under the cursor (or every selected value in that
  // column) by a step: 1, or "big" -- an octave for notes, ten otherwise.
  nudge(step) {
    const sel = this.blockOrCell();
    const big = step === "big" || step === "-big";
    const sign = step === "-big" || step === -1 ? -1 : 1;
    this.snapshot();
    this.forBlock(sel, (c, col) => {
      const v = c[col];
      if (typeof v !== "number") return;
      if (col === "note") c.note = Math.max(-60, Math.min(60, v + sign * (big ? 12 : 1)));
      else if (col === "cut") c.cut = Math.max(-99, Math.min(99, v + sign * (big ? 10 : 1)));
      else if (col === "inst") c.inst = Math.max(0, Math.min(this.song.instruments.length - 1, v + sign));
      else c[col] = Math.max(0, Math.min(99, v + sign * (big ? 10 : 1)));
    });
    this.afterBlockEdit(sel);
  }

  transpose(semis) {
    const sel = this.blockOrCell();
    this.snapshot();
    // Transpose acts on notes wherever the cursor is in the cell.
    const whole = { ...sel, c0: 0, c1: COLS.length - 1 };
    this.forBlock(whole, (c, col) => {
      if (col === "note" && typeof c.note === "number")
        c.note = Math.max(-60, Math.min(60, c.note + semis));
    });
    this.afterBlockEdit(whole);
  }

  // --------------------------------------------------------------- undo

  snapshot() {
    const p = this.pattern();
    if (!p) return;
    this.undoStack.push({ pattern: this.patternIndex, tracks: p.tracks.map((rows) => rows.map((c) => (c ? { ...c } : null))) });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  restore(snap) {
    const p = this.song.patterns[snap.pattern];
    if (!p) return;
    p.tracks = snap.tracks;
    p.length = p.tracks[0] ? p.tracks[0].length : p.length;
    this.patternIndex = snap.pattern;
    this.anchor = null;
    this.render();
    if (this.onEdit) this.onEdit();
  }

  current() {
    const p = this.pattern();
    return { pattern: this.patternIndex, tracks: p.tracks.map((rows) => rows.map((c) => (c ? { ...c } : null))) };
  }

  undo() {
    const snap = this.undoStack.pop();
    if (!snap) return;
    this.redoStack.push(this.current());
    this.restore(snap);
  }

  redo() {
    const snap = this.redoStack.pop();
    if (!snap) return;
    this.undoStack.push(this.current());
    this.restore(snap);
  }
}
