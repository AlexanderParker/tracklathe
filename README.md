# Tracklathe

A tracker in the browser, where the instruments are numbers.

**[Open it](https://alexanderparker.github.io/tracklathe/)** — no install.

Built on [zyn.js](https://github.com/AlexanderParker/zyn), a synthesizer that
generates a complete instrument from a single integer. A Tracklathe song is
therefore just notes plus a handful of seeds — no samples, no soundfonts, no
synth state. A whole tune with all its sounds is a few kilobytes of JSON.

## Running it

```bash
git clone https://github.com/AlexanderParker/tracklathe
cd tracklathe
python -m http.server 8000     # or: npx serve
```

Then open `http://localhost:8000`.

It needs a server rather than opening the file directly, because the source
is ES modules and browsers refuse to load those over `file://`.

## Hearing something

The Songs tab has **Load the demo song**: a minute and a quarter in E minor,
six patterns, eight instruments. It is also the quickest way to see what the
columns do. The arpeggio is one long filter sweep written into the `cut`
column, the break holds a bass note per bar and opens it a little more each
time, the fills ramp `vel`, and the bell's long notes use `rel`.

## Writing something

Click a cell and type. `Z` to `M` are the lower octave and `Q` to `P` the
upper, laid out as piano keys — the layout trackers have used since Ultimate
Soundtracker. `` ` `` is a note off. Space plays and stops.

On a phone, tap a cell and use the pad under the grid instead. It has the
notes, the digits, a d-pad and an octave control, and it changes to suit
whichever column the cursor is in. There is no hidden text field anywhere in
the editor, so the soft keyboard never appears over the pattern you are
editing.

Each track has six columns:

| Column | Meaning |
|---|---|
| note | `C-4` is middle C. `OFF` stops whatever the track is holding |
| inst | which instrument, from the Instruments tab |
| vel | how hard, 64 for unity |
| rel | scales this note's release, 25 for unity |
| cut | shifts this note's filter cutoff, in semitones |
| vol | level, 64 for unity |

A track is monophonic: the next note on a track cuts the one before it, which
is what lets a held pad end where you say.

### Instruments

Each slot is a seed and a few settings. Roll the dice until something is
worth keeping, or design one: the Instruments tab embeds
[the zyn editor](https://alexanderparker.github.io/zyn/) itself, and *Use
editor seed* hands whatever it is showing to the selected instrument. Seeds
from [Seedlathe](https://github.com/AlexanderParker/seedlathe), the same
synthesizer as a VST plugin, work too. The same number sounds the same in
all three.

The selector above the grid is the instrument new notes get; typing an
instrument number into a cell selects it as well.

Octave, volume, cutoff and resonance belong to the instrument; the per-row
columns are offsets on top.

### Patterns and the sequence

Patterns are written once and arranged in the Sequence tab, so a chorus that
appears four times is stored once. *+ pattern* above the grid makes a new
one, switches to it and appends it to the sequence. Songs start with eight
tracks; the tracker bar adds more, up to thirty-two. While playing, the grid
follows the song -- switching pattern as the sequence moves on -- and a tap
on a row number moves playback there.

### Keeping a song

**Save** puts the song in this browser's storage, on this device: it is still
there when you come back. The Songs tab lists what is saved, and edits are
autosaved to a separate slot, so closing the tab by accident does not cost
the session.

Browser storage does not travel. **Export** writes the same song as a JSON
file, which is what to use to move it to another machine, keep it in a repo,
or send it to somebody.

## The file format

A song is one JSON file: the instrument table, the patterns, and the order
the patterns play in. Patterns are stored sparsely — only rows that hold
something — so an empty track costs nothing and a diff between two versions
shows the notes that changed.

```json
{
  "format": "tracklathe-song",
  "version": 1,
  "name": "Untitled",
  "bpm": 125,
  "rowsPerBeat": 4,
  "instruments": [
    { "name": "Lead", "seed": 2360196101, "octave": 0,
      "volume": 100, "cutoff": 0, "resonance": 0 }
  ],
  "patterns": [
    { "name": "A", "length": 64,
      "tracks": [ { "0": { "note": 0, "inst": 0, "vel": 99 } }, {} ] }
  ],
  "sequence": [0]
}
```

Everything read from a file is bounded, and a malformed pattern costs that
pattern rather than the song.

## How it keeps time

Two clocks, kept apart the way a game keeps physics apart from rendering.

The audio side runs off the AudioContext clock. A timer in a Worker wakes
the scheduler every 20 ms; each wake it queues every row due in the next
half second, handing each note -- and each note's end -- to zyn with an
explicit time. From then on the audio thread owns them. The page can stall
for a pattern switch or a garbage collection and nothing is heard, because
everything due in that window was queued before the stall.

The display never hears from the scheduler. Once per animation frame it asks
which row is sounding at the current audio time and draws that, switching
pattern and scrolling as the song moves. No DOM work happens in the
scheduler and no audio work happens in the frame.

This needed two small additions to zyn -- `play`, `noteOn`, `render` and
`noteOff` take an optional AudioContext time -- so Tracklathe requires a zyn
build from September 2026 or later. The bundled copy in `vendor/Z.js` is new
enough.

## Layout

| Path | What it is |
|---|---|
| `src/song.js` | the data model, and JSON in and out |
| `src/engine.js` | the scheduler and the bridge to zyn |
| `src/grid.js` | the pattern editor |
| `src/pad.js` | the on-screen input pad |
| `src/store.js` | songs in browser storage |
| `src/app.js` | tabs, transport, instruments, sequence, files |
| `songs/demo.json` | the demo song |
| `vendor/Z.js` | a build of zyn.js, copied from that repo |

To update the synth, rebuild zyn (`npm run build` there) and copy its `Z.js`
over `vendor/Z.js`.

After any change to the scripts, run `python tools/bump.py <n>` with the next
build number. It rewrites the `?v=` cache keys, the `BUILD` constant and
`version.json` together. GitHub Pages caches every file for ten minutes, so
without the keys a reload can pair a fresh page with stale scripts; the page
compares its build against `version.json` on load and offers a reload when
they differ.

## How this was built

zyn.js came first, and its synth core was written by hand. Tracklathe was
written by Claude (Anthropic's Claude Code), under my direction and review.

## Licence

MIT.
