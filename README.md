# Dance × Farandole

An interactive ensemble installation for the browser, built around Matisse's *Dance* (1910).
4–5 visitors stand in front of the projected painting. A webcam tracks each of them, every visitor gets
**their own instrument**, and all instruments play parts of Bizet's *Farandole* on **one shared clock**.
When everybody dances at the same time **the ring closes** — the gap in the painting joins and the music blooms.

Plain HTML + ES modules. No build step, no npm install. Libraries come from CDNs
(Tone.js, @tonejs/midi, MediaPipe Tasks Vision), so the machine needs internet the first time.

The full specification is in [`DEMO_PLAN.md`](DEMO_PLAN.md).

## Run it

```bash
python3 -m http.server 8000
```

Open <http://localhost:8000> in **Chrome**, click **Start**.

- **Start** asks for the webcam. If there is no camera (or you say no) the demo falls back to **Simulation mode**.
- **Start without a camera (Simulation)** skips the camera question. `?mode=sim` makes the big Start button do the same.
- `http://localhost:8000/tests.html` runs the in-browser tests.

## Keyboard & mouse

| Key | Action |
|---|---|
| `T` | toggle Simulation ⇄ Webcam mode |
| `1`–`5` | add / remove simulated person 1–5 (Flute, Tambourin, Cello, Oboe, Violin) |
| mouse drag | move a simulated person: left/right = position (stereo pan), up = closer (volume 25 → 100 %) |
| hold `Space` | all simulated people dance |
| `Shift` + `1`–`5` | toggle "keeps dancing" for that one person (adds them if absent) |
| `A` | while hovering a simulated person: toggle arms up |
| `D` | debug panel (FPS, per person: slot, instrument, x, shoulder width, closeness, band, motion, moving, arms, gain, ring, MIDI status) |
| `S` | settings panel (sliders, MIDI track pickers, loop region, reset) |
| `F` | fullscreen |

Simulated people go through exactly the same `people.js` code as webcam people (they are fake 33-point poses),
so what you hear in Simulation mode is what the webcam would produce. Dragging a simulated person counts as
movement, just like a visitor walking would.

## Who plays what

| Slot | Colour | Instrument | Part |
|---|---|---|---|
| 1 | red | Flute | Theme B (fast dance tune) |
| 2 | orange | Tambourin drum | rhythm (generated; fills when energetic) |
| 3 | yellow | Cello | bass line (lowest note of the chosen track) |
| 4 | blue | Oboe | Theme A ("March of the Kings") |
| 5 | purple | Violin | counter-melody (third track, else Theme A an octave up) |

A new person takes the lowest free slot and keeps it while tracked; they are dropped after 1.5 s missing.
(In Simulation mode pressing key *n* asks for slot *n*, so labels always match the key.)

Your body controls **how** your instrument sounds — never *which* notes: moving → plays; still for 1.5 s → 10 %;
closeness → volume band 25/50/75/100 %; left/right → pan; arms up → brighter + one octave up (flute, oboe, violin);
more movement → louder accents and, for the drum, fills. Together: shared downbeat pulse, a chime when two people
stand close ("hold hands"), and when ≥ 4 people all move for 2 s **the ring closes** (pad, bigger reverb, all
instruments ≥ 75 %, "The circle is closed").

## Adding the Farandole MIDI

1. Put the file at `assets/farandole.mid`, **or** drag any `.mid` onto the page at any time (it is remembered in
   the browser's `localStorage` so it survives a reload; "forget file" in Settings clears it).
2. Press `S`. The settings panel lists every track (index, name, instrument, note count). Pick a track for
   **Theme B / Bass / Theme A / Counter-melody**. "auto" guesses from pitch (highest tracks → melodies, lowest → bass).
   Melodic roles keep only the highest note at any moment, the bass keeps only the lowest.
3. Set the **loop region** (start bar – end bar). Default: bars 1–16. All parts loop over this region together.
4. Choices are saved per file in `localStorage` and restored after reload.

Without a MIDI file, short **placeholder** loops in D play and a banner says so. (They are original — not Bizet.)
Optionally add `assets/dance.jpg` as the background.

## Camera placement tips

- Wide-angle webcam, at screen height or slightly above, centred on the screen.
- 3–5 m of floor space in front of the screen; people facing the screen.
- Even, front lighting; avoid strong backlight (windows behind the visitors).
- Keep the whole upper body (and ideally knees) in frame: the lite model loses people whose hips are cut off.
- Use Chrome with hardware acceleration on (the GPU delegate is tried first, CPU is the fallback).

## Tuning `CLOSE_MIN` / `CLOSE_MAX` on site

Closeness is the shoulder width (fraction of the image width) mapped from `CLOSE_MIN` → 0 to `CLOSE_MAX` → 1.

1. Press `D` to show the debug panel (column **shoulder**).
2. Stand where the *farthest* visitor will stand; read the shoulder width. Set `CLOSE_MIN` to it (Settings, `S`).
3. Stand at the *nearest* spot; set `CLOSE_MAX` to that reading.
4. The four volume bands (25 / 50 / 75 / 100 %) are now spread evenly between those two spots.

If visitors are detected as "moving" while standing still, raise `MOVE_THRESHOLD` (or `MOTION_DEADZONE` in
`config.js`); if dancing is not picked up, lower it or lower `MOTION_MAX`.

## Files

```
index.html  style.css  main.js     page, wiring, main loop
config.js                          every tunable number + the slot→instrument table
vendor.js                          CDN loading (with fallback URLs)
tracking.js                        webcam + MediaPipe Pose Landmarker → raw poses
people.js                          raw poses → stable people (pure functions + PeopleTracker)
simulate.js                        Simulation mode (fabricates poses)
melody.js                          MIDI loading, extraction, placeholder melodies, arrangement
music.js                           instruments, shared Tone.Transport, per-slot control, ring bloom
visuals.js                         painting / ring / overlays / debug panel
ui.js                              settings panel
tests.html                         in-browser tests (people.js + melody extraction)
assets/                            optional farandole.mid, dance.jpg
```

## Test results (acceptance checklist, spec §14)

Tested in headless Chromium (Playwright) against this repo served by `python3 -m http.server`. **The sandbox that
built this blocks the CDNs**, so the exact same library versions (Tone 15.0.4, @tonejs/midi 2.0.28, MediaPipe
tasks-vision 0.10.14) were fetched from npm and served in place of the CDN URLs; the MediaPipe model came from the
real Google storage URL. The CDN URLs themselves are therefore **not verified from here** — if one is unreachable,
`vendor.js` tries a second CDN and otherwise shows an error on the start screen. Sound was checked by reading the
Web Audio parameters (gain, pan, filter, octave, reverb, pad), **not by ear**.

- [x] `python3 -m http.server 8000` → Start → no console errors (only `404` for the optional `assets/` files that are not there yet).
- [x] No webcam + no MIDI: falls back to Simulation ("Webcam unavailable (no camera found)"), placeholder melodies play, banner shown.
- [x] Keys 1–5 add Flute, Tambourin, Cello, Oboe, Violin with their colours and labels.
- [x] Still person → gain 0.08 (10 % × 75 % band); dancing (Space / Shift+n) → 0.75, a dancing 100 %-band person → 1.0.
- [x] Dragging closer steps the band 25 → 50 → 75 → 100 (checked at closeness 0.1 / 0.4 / 0.6 / 0.9); gain ramps over 0.3 s; dragging sideways moves pan from −0.72 to +0.71.
- [x] Arms up: octaveShift 12 and flute filter 3200 → 9000 Hz; back down on arms down.
- [x] Two people placed close: hands join (coloured arc), exactly one chime.
- [x] 4 (and 5) people dancing for 2 s: ring closes (after 2.0 s), pad fades in, reverb wet 0.2 → 0.45, all present instruments ≥ 75 %. When one stops, the ring opens after the 0.4 s grace and the bloom fades out over 2 s. 3 people never close it.
- [x] 5 minutes in time: all parts stay on the shared transport grid (see "5-minute timing" below).
- [x] Remove person 2, add again → slot 2 (Tambourin).
- [x] Drop a MIDI file → track list appears, track choice and bar range re-schedule the parts, choices persist after reload.
- [ ] Webcam mode with 1–2 **real** people at 1.5–4 m: **not verified** (no people in the sandbox). Verified instead: camera start, MediaPipe load (GPU delegate), detection loop, fake-camera feed gives 0 poses, a pose injected into the tracker's output produces a stable slot-1 person with position / closeness / motion, `T` toggling, preview overlay. The real-people check has to be done on site.
- [x] `tests.html`: 33 tests pass (matchPeople, closenessToBand, computeMotion, isArmsUp, checkRing, hand pairs, tracker, melody extraction).

### 5-minute timing

Five simulated people danced for 305 s of real time (headless Chromium, audio context running). Every Tone.Part
callback (5 slot parts, drum, pad, pulse — 4 676 notes) was logged with its transport tick and compared with the
tick it was scheduled at: **maximum deviation 1.3 × 10⁻¹⁰ ticks** (i.e. none). All parts are looped `Tone.Part`s of
identical length on the one `Tone.Transport`; people only change gain / pan / filter / octave, so drift cannot occur
by construction. (Measured on the transport clock, not by ear.)

## Known limitations

- Pose landmark jitter differs by camera and light; `MOTION_DEADZONE` / `MOVE_THRESHOLD` need a quick tuning on site.
- MediaPipe sometimes returns two overlapping poses for one person, or swaps identities when people cross closely;
  matching is greedy nearest-neighbour on (x, closeness) only.
- Held notes finish in the old octave when someone raises their arms (the jump applies from the next note).
- `ctx.filter` (background saturation with `dance.jpg`) is not available in Safari; the flat background still saturates.
- The placeholder melodies are only a sketch; they sound plain next to the real MIDI.
- Needs a user click before audio can start (browser rule), and internet for the CDN libraries.

## Deviations from spec

- **Simulation slots:** simulated person *n* asks for slot *n* (`preferredSlot`); the tracker honours it when the slot is free and otherwise uses the lowest free slot. Webcam people always get the lowest free slot.
- **Motion dead-zone:** `MOTION_DEADZONE` (0.15 shoulder-widths/s) is subtracted before normalising, so tracker jitter on a standing person is not "movement". `MOTION_SMOOTHING` is defined per 1/60 s so it behaves the same at 30 fps (webcam) and 60 fps (simulation). Vertical displacements are scaled by the video aspect ratio so they are measured in shoulder widths like horizontal ones.
- **Extra hysteresis / grace:** volume band edges (`BAND_HYSTERESIS`), arms-up, hand pairs (`HAND_RELEASE`) and the ring (`RING_GRACE`, 0.4 s) all have small hysteresis to avoid flicker.
- **Ring closed visuals:** when the ring is closed, empty slots are drawn as pale "ghost" dancers so all five links can join (the spec's rule "joined only between present neighbours" applies while the ring is open). Hand pairs that span the 5↔1 gap are drawn as a curve through the middle rather than closing the gap.
- **Pad:** the pad chord (root + fifth of the bar's bass note, folded into C3–B3) is scheduled for every bar and only its gain fades; chords of consecutive bars with the same root are merged into one long note.
- **Drum:** pattern = low hit on beat 1, light hit on other beats, off-beat noise tick; 16th fills (and a tom on the last beat) above motion 0.7. The group's average motion lifts the drummer's volume and velocity even when standing still.
- **Hand chime:** soft sine `PolySynth` (D6 + A6) instead of `MetalSynth`.
- **MIDI persistence:** besides the track choices, a *dropped* MIDI file is stored (base64) in `localStorage` so it is still loaded after a reload.
- **CDN fallbacks:** each library has two CDN URLs (`config.js` → `CDN`), tried in order; Tone is pinned to 15.0.4.
- **Extra keys / UI:** `F` fullscreen, a "Load MIDI file…" button and "forget file" in Settings, a secondary "Start without a camera" button.
- **Tests:** `tests.html` also covers `computeHandPairs`, `PeopleTracker` and melody extraction (`extractLine`).
