// The on-screen input pad.
//
// A phone has no typing keyboard to offer: the grid is a div, and a div
// never raises the soft keyboard however much it is tapped. Asking for one
// anyway -- a hidden input stealing focus -- gives you autocorrect, a
// shrinking viewport and a keyboard covering the pattern you are editing.
//
// So the tracker brings its own. The pad also happens to be the fastest way
// in on a desktop for anyone who has not learnt the QWERTY note layout, and
// it doubles as the discoverable version of it: the keys are labelled.
//
// It follows the cursor's column, because "what can I type here" is exactly
// the question a tracker's columns raise, and the answer differs per column.

import { COLS } from "./grid.js?v=3";

const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const COLUMN_HELP = {
  note: "note",
  inst: "instrument",
  vel: "velocity, 64 is unity",
  rel: "release, 25 is unity",
  cut: "filter, in semitones",
  vol: "volume, 64 is unity",
};

export class Pad {
  constructor(root, grid) {
    this.root = root;
    this.grid = grid;
    this.render();
  }

  // Rebuilt when the cursor moves to a different KIND of column, not on
  // every move: replacing the buttons under a finger mid-tap loses the tap.
  sync() {
    const col = COLS[this.grid.cursor.col];
    const mode = col === "note" ? "note" : "number";
    if (mode !== this.mode) this.render();
    else this.updateLabel();
  }

  updateLabel() {
    if (!this.label) return;
    const col = COLS[this.grid.cursor.col];
    this.label.textContent =
      `Track ${this.grid.cursor.track + 1} · row ${String(this.grid.cursor.row).padStart(3, "0")} · ${COLUMN_HELP[col]}`;
  }

  button(text, title, onTap, cls = "") {
    const b = document.createElement("button");
    b.className = `pad-btn ${cls}`;
    b.textContent = text;
    if (title) b.title = title;
    // pointerdown, not click: a tap should register on contact, and it stops
    // the grid losing focus to the button on desktop.
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      onTap();
      this.grid.root.focus({ preventScroll: true });
      this.sync();
    });
    return b;
  }

  render() {
    const col = COLS[this.grid.cursor.col];
    this.mode = col === "note" ? "note" : "number";

    const frag = document.createDocumentFragment();

    // --- where the cursor is, and what this column means
    this.label = document.createElement("div");
    this.label.className = "pad-label";
    frag.appendChild(this.label);
    this.updateLabel();

    // --- moving about, because a 2-character column is not a tap target
    const nav = document.createElement("div");
    nav.className = "pad-row pad-nav";
    nav.append(
      this.button("◀", "Previous column", () => this.grid.move(0, 0, -1)),
      this.button("▲", "Up a row", () => this.grid.move(-1, 0, 0)),
      this.button("▼", "Down a row", () => this.grid.move(1, 0, 0)),
      this.button("▶", "Next column", () => this.grid.move(0, 0, 1)),
      this.button("⇤", "Previous track", () => this.grid.move(0, -1, 0)),
      this.button("⇥", "Next track", () => this.grid.move(0, 1, 0)),
    );

    const oct = document.createElement("span");
    oct.className = "pad-oct";
    const octLabel = document.createElement("span");
    const showOct = () => { octLabel.textContent = `oct ${this.grid.octave >= 0 ? "+" : ""}${this.grid.octave}`; };
    showOct();
    nav.append(
      this.button("−", "Octave down", () => {
        this.grid.octave = Math.max(-3, this.grid.octave - 1); showOct();
      }, "pad-small"),
      octLabel,
      this.button("+", "Octave up", () => {
        this.grid.octave = Math.min(3, this.grid.octave + 1); showOct();
      }, "pad-small"),
    );
    nav.appendChild(oct);
    frag.appendChild(nav);

    // --- the keys for this column
    const keys = document.createElement("div");
    keys.className = "pad-row pad-keys";

    if (this.mode === "note") {
      NOTES.forEach((name, semi) => {
        const black = name.includes("#");
        keys.appendChild(this.button(name, `${name}${4 + this.grid.octave}`,
          () => this.grid.typeNote(semi), black ? "pad-black" : "pad-white"));
      });
      keys.appendChild(this.button("OFF", "Stop the note this track is holding",
        () => this.grid.typeNoteOff(), "pad-off"));
    } else {
      for (let d = 0; d <= 9; ++d)
        keys.appendChild(this.button(String(d), "", () => this.grid.typeDigit(d)));
      if (col === "cut") {
        keys.appendChild(this.button("−", "Negative", () => this.grid.setCutSign(-1), "pad-small"));
        keys.appendChild(this.button("+", "Positive", () => this.grid.setCutSign(1), "pad-small"));
      }
    }

    keys.appendChild(this.button("DEL", "Clear this cell",
      () => this.grid.clearCell(), "pad-del"));
    frag.appendChild(keys);

    this.root.replaceChildren(frag);
  }
}
