# Tracklathe

A tracker in the browser, where the instruments are numbers.

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

## Writing something

Click a cell and type. `Z` to `M` are the lower octave and `Q` to `P` the
upper, laid out as piano keys — the layout trackers have used since Ultimate
Soundtracker. `` ` `` is a note off. Space plays and stops.

Each track has six columns:

| Column | Meaning |
|---|---|
| note | `C-4` is middle C. `OFF` stops whatever the track is holding |
| inst | which instrument, from the table on the right |
| vel | how hard, 64 for unity |
| rel | scales this note's release, 25 for unity |
| cut | shifts this note's filter cutoff, in semitones |
| vol | level, 64 for unity |

A track is monophonic: the next note on a track cuts the one before it, which
is what lets a held pad end where you say.

### Instruments

Each slot is a seed and a few settings. Roll the dice until something is
worth keeping, or paste a seed from
[the zyn demo](https://alexanderparker.github.io/zyn/) or from
[Seedlathe](https://github.com/AlexanderParker/seedlathe), which is the same
synthesizer as a VST plugin. The same number sounds the same in all three.

Octave, volume, cutoff and resonance belong to the instrument; the per-row
columns are offsets on top.

### Patterns and the sequence

Patterns are written once and arranged in the sequence list, so a chorus that
appears four times is stored once. The pattern shown follows the playhead
only when it is the one sounding, because a highlight on a pattern you are
not hearing is a lie.

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

Rows are scheduled against the AudioContext clock, not fired from a timer. A
25 ms interval decides *when to look*; every note it finds is handed to zyn
with an explicit start time about 120 ms ahead. `setTimeout` on its own
jitters by whole milliseconds and stops being called at all in a background
tab, and on a tracker row either is audible as a flam.

This needed a small addition to zyn — `play`, `noteOn` and `render` take an
optional AudioContext time — so Tracklathe requires a zyn build from
September 2026 or later. The bundled copy in `vendor/Z.js` is new enough.

## Layout

| Path | What it is |
|---|---|
| `src/song.js` | the data model, and JSON in and out |
| `src/engine.js` | the scheduler and the bridge to zyn |
| `src/grid.js` | the pattern editor |
| `src/app.js` | transport, instruments, sequence, files |
| `vendor/Z.js` | a build of zyn.js, copied from that repo |

To update the synth, rebuild zyn (`npm run build` there) and copy its `Z.js`
over `vendor/Z.js`.

## How this was built

zyn.js came first, and its synth core was written by hand. Tracklathe was
written by Claude (Anthropic's Claude Code), under my direction and review.

## Licence

MIT.
