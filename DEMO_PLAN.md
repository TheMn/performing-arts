# Build spec: "Dance × Farandole". Interactive ensemble demo in the browser

> **Instructions for Claude Code**
> Build the complete, working demo described in this file in one go. Plain HTML + JavaScript (ES modules), **no build step, no frameworks, no npm install**. Libraries come from CDNs only (listed in §3). When finished, the demo must run with `python3 -m http.server 8000` and work fully in **Simulation mode** without a webcam. Follow the file structure, behaviour and acceptance checklist exactly. If something in this spec is technically impossible, choose the simplest working alternative and note it in `README.md` under "Deviations from spec".

---

## 1. The idea in one paragraph

We are building a university art installation around Matisse's painting *Dance* (1910): five dancers holding hands in a ring, with a gap where two hands don't quite meet. **4–5 visitors** stand in front of the projected painting. A webcam tracks each of them. **Every visitor is given their own instrument** for as long as they stay, and each one hears their instrument respond to **their own body**. All instruments play parts of Bizet's **Farandole** (from *L'Arlésienne*) on **one shared clock**, so together the visitors form an ensemble. When everyone dances at the same time, **the ring closes**: the gap in the painting joins and the music blooms. The goal is the feeling of *making music together with strangers*.

## 2. Core interaction rules (the most important section)

### 2.1 Each person = one instrument (stable identity)
- The system tracks up to **5 people** and gives each a **slot 1–5**. Slot = instrument = dancer in the ring = colour.
- A new person takes the **lowest free slot**. They keep it while they're tracked, even if they move around or pass other people.
- A person is removed after being missing for `LEAVE_TIMEOUT` (default 1.5 s). Their slot is then free.
- Slot order (the first person gets slot 1, so a single visitor already hears a melody):

| Slot | Colour | Instrument | Part of the Farandole | Synth (Tone.js) |
|---|---|---|---|---|
| 1 | red | **Flute** | Theme B: the fast farandole dance tune | `Tone.Synth` triangle wave + light vibrato |
| 2 | orange | **Tambourin drum** | Rhythm: low hit on beat 1, light hit on the off-beat, fills when energetic | `Tone.MembraneSynth` + short `Tone.NoiseSynth` |
| 3 | yellow | **Cello / drone** | Bass: the MIDI bass line, or a D–A drone if unavailable | `Tone.FMSynth`, low, through a low-pass filter |
| 4 | blue | **Oboe** | Theme A: the "March of the Kings" melody | `Tone.FMSynth`, reedy (harmonicity ~3) |
| 5 | purple | **Violin** | Counter-melody: a third MIDI track (inner voice), or Theme A an octave up if none | `Tone.Synth` sawtooth through a low-pass filter + vibrato |

### 2.2 Your body controls your instrument
All parts play on **one shared timeline** (`Tone.Transport`), so they always fit together harmonically. Each person controls **how their instrument sounds**, never *which* notes come next (that would break the ensemble).

| Your body | Effect on YOUR instrument | Why |
|---|---|---|
| **Moving / dancing** (motion energy above `MOVE_THRESHOLD`) | Your instrument **plays** (fades in over 0.2 s) | Clear cause and effect: "when I dance, my instrument plays" |
| **Standing still** for > `STILL_TIMEOUT` (1.5 s) | Fades down to `IDLE_LEVEL` (default 10%). Never fully silent, so you can still hear "your" voice | You're still part of the group |
| **Closeness to the screen** | Volume band: far 25%, mid-far 50%, mid-near 75%, near 100% (multiplied with the above) | Matches our project brief |
| **Left/right position** | Stereo pan (-0.8 … +0.8) | Your sound comes from where you stand |
| **Arms raised** (either wrist above the shoulders) | Brighter tone (filter cutoff up) and melodic instruments jump **up one octave** | Matches the raised arms of the dancers |
| **Movement intensity** (how much you move) | Drum: more fills. Melodic instruments: louder accents (velocity) | More energy, more sound |

All changes ramp over `RAMP_SECONDS` (0.3 s). Nothing jumps.

### 2.3 Togetherness mechanics (what makes it a shared experience)
1. **Shared pulse:** a soft ambient pulse on the downbeat whenever ≥1 person is present, so everyone hears the common beat.
2. **Holding hands:** when two people stand next to each other (horizontal gap < `HAND_DISTANCE`), their dancers' hands **join on screen** (a coloured arc), and a soft two-note chime sounds once.
3. **The ring closes (the climax):** when **at least `RING_MIN_PEOPLE` (default 4) people are present AND all present people are moving at the same time for `RING_HOLD` (2 s)**:
   - On screen, the gap in the ring closes, all dancers glow, and the background saturates.
   - The music blooms: a sustained string pad on the current chord fades in, the reverb gets bigger, and every present instrument is raised to at least 75%.
   - It lasts while everyone keeps moving. When someone stops, it fades out over 2 s.
   - Show the text "The circle is closed" briefly the first time it happens.
4. **Group energy:** the average motion of everyone present slightly raises the drum's and pad's intensity, even for people who are standing still.

## 3. Tech stack (exactly this, nothing more)

| Purpose | Library | Load from |
|---|---|---|
| Multi-person body tracking | **MediaPipe Tasks Vision: Pose Landmarker (lite model)**, `runningMode: "VIDEO"`, `numPoses: 5`, GPU delegate with CPU fallback | `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision` (+ model `.task` file from Google's storage URL in the MediaPipe docs) |
| Synthesis, effects, shared clock | **Tone.js** (v14/15) | jsDelivr or esm.sh |
| Reading the Farandole MIDI | **@tonejs/midi** | esm.sh |
| Drawing | HTML `<canvas>` 2D | none |
| Local server | `python3 -m http.server 8000` | none |

## 4. Files

```
farandole-demo/
├── index.html      # layout; big "Start" button (browsers need a click before audio)
├── style.css
├── config.js       # EVERY tunable number and the slot→instrument table (§2.1)
├── tracking.js     # webcam + MediaPipe → raw poses
├── people.js       # raw poses OR simulated people → stable people with slots + features
├── simulate.js     # Simulation mode (no webcam needed)
├── melody.js       # load MIDI (file or drag-and-drop), extract parts, placeholder fallback
├── music.js        # instruments, shared transport, per-slot control, ring-close bloom
├── visuals.js      # painting/ring, people overlays, debug panel
├── ui.js           # settings panel (sliders, MIDI track pickers)
├── main.js         # wiring + main loop (requestAnimationFrame)
├── tests.html      # small in-browser tests for the pure logic in people.js
├── assets/
│   ├── farandole.mid   # we add it (IMSLP / MuseScore). Optional at first
│   └── dance.jpg       # we add it. Optional
└── README.md
```

## 5. Data model (single source of truth, produced every frame by `people.js`)

```js
person = {
  slot: 1..5,              // stable while present
  x: 0..1,                 // horizontal position, mirrored (like a mirror)
  closeness: 0..1,         // 0 = far, 1 = near
  band: 0|25|50|75|100,    // volume band from closeness
  motion: 0..1,            // smoothed motion energy
  moving: bool,            // motion > MOVE_THRESHOLD (with hysteresis)
  stillFor: seconds,
  armsUp: bool,
  lastSeen: timestamp
}
group = { count, avgMotion, allMoving, ringClosed: bool, handPairs: [[slotA, slotB], ...] }
```
`music.js` and `visuals.js` only read this. They never touch MediaPipe or simulation directly.

## 6. Tracking details (`tracking.js` + `people.js`)

- **Position x:** midpoint of the hips (landmarks 23/24), falling back to the shoulders (11/12). Mirror it: `x = 1 - x`.
- **Closeness:** shoulder width (distance between 11 and 12) mapped linearly from `CLOSE_MIN`→0 to `CLOSE_MAX`→1, then clamped. Bands at 0.25 / 0.5 / 0.75.
- **Motion energy:** the average frame-to-frame displacement of landmarks **wrists (15, 16), elbows (13, 14), hips (23, 24), knees (25, 26)**, divided by shoulder width (so near and far people are comparable), per second, smoothed with an exponential moving average (`MOTION_SMOOTHING`), normalised 0..1 by `MOTION_MAX`. Dancing in place counts as moving.
- **Moving hysteresis:** turns on above `MOVE_THRESHOLD` and off below `MOVE_THRESHOLD * 0.6`, to avoid flicker.
- **Arms up:** either wrist's y is above (smaller than) the average shoulder y by more than `ARMS_UP_MARGIN`.
- **Identity matching (no IDs from MediaPipe):** each frame, match new detections to existing people using a **greedy nearest-neighbour** match on (x, closeness), allowing at most `MAX_JUMP` distance. Unmatched detections become new people in the lowest free slot (if one is free). Unmatched existing people keep their last values until `LEAVE_TIMEOUT`.
- Ignore poses whose average landmark visibility is below `MIN_VISIBILITY`.
- Write these as **pure functions** (`matchPeople`, `computeMotion`, `closenessToBand`, `isArmsUp`, `checkRing`) so `tests.html` can test them.

## 7. Music details (`music.js`)

- `Tone.Transport` at `BPM` (config, default 120). The time signature and loop length come from the MIDI section in use.
- **At Start, every part of every slot is scheduled on the transport (`Tone.Part`, looped) at volume 0.** People only change gain, pan, filter and octave. This guarantees sync.
- Each slot has its own chain: `instrument → filter → Tone.Panner → Tone.Gain → master`. Master chain: `Tone.Reverb` (wet 0.2, rising to 0.45 when the ring closes) → `Tone.Limiter(-1)` → destination.
- **Final gain per slot** = `presence × activity × band`, where:
  - presence: 1 if the slot is occupied, else 0;
  - activity: 1 if moving, `IDLE_LEVEL` if still for longer than `STILL_TIMEOUT`;
  - band: 0.25 / 0.5 / 0.75 / 1.0;
  - ring-closed override: max(gain, 0.75).
- **Octave jump** (arms up) applies to slots 1, 4 and 5 only. Implement it by transposing in the `Tone.Part` callback with a per-slot `octaveShift` variable.
- **Drum:** the base pattern plays on every beat. When motion > 0.7, add 16th-note fills. Velocity follows motion.
- **Ring pad:** a `Tone.PolySynth` (soft sawtooth, slow attack of 1.5 s) playing the root + fifth of the current bar's bass note (from the bass part), fading in when the ring closes.
- **Hand chime:** a `Tone.MetalSynth` or a soft sine `Tone.Synth` playing D6 + A6 once per new hand pair. Rate-limited to once every 2 s.

## 8. Melody data (`melody.js`)

- At startup, try to load `assets/farandole.mid`. **Also accept a MIDI file dragged onto the page** at any time (it re-schedules the parts).
- **The settings panel lists every MIDI track** (index, name, instrument, note count) with a dropdown per slot role: Theme B (slot 1), Bass (slot 3), Theme A (slot 4), Counter-melody (slot 5), plus **start bar / end bar** fields for the loop region. Selections are saved in `localStorage` (wrapped in try/catch).
- For melodic roles, keep only the **highest note** at any moment (melody extraction). For bass, keep the **lowest**.
- The drum part is generated (not read from the MIDI).
- **Fallback when there is no MIDI file:** use short, simple **PLACEHOLDER** loops in D (Theme B: a lively stepwise D-major line; Theme A: a slower D-minor march line; bass: D–A; counter-melody: long notes). Show a visible banner: "Placeholder melodies. Drop the Farandole MIDI file here." **Do not attempt to reproduce Bizet's actual melody from memory.**

## 9. Simulation mode (`simulate.js`): must be complete and fun to use

Needed so we can test everything on one laptop.
- **`T`** toggles Simulation mode / Webcam mode. Simulation is the default if the webcam is unavailable or permission is denied.
- **`1`–`5`** add or remove simulated person 1–5.
- **Click-drag** a simulated person: left/right changes x, up/down changes closeness (up = closer).
- **Hold `Space`**: all simulated people "dance" (motion is high).
- **Shift + `1`–`5`**: toggle "dancing" on that one person so it stays on.
- **`A`** while hovering a simulated person: toggle arms up.
- Simulated people must produce exactly the same `person` objects as the webcam pipeline (same `people.js` code path after the raw-input stage).

## 10. Visuals (`visuals.js`)

- **Background:** `assets/dance.jpg` if present (cover-fit), else a flat deep blue (top 55%) and green (bottom) field.
- **The ring:** five dancer figures (simple shapes: a circle for the head and a rounded body; no need to copy the painting) on an ellipse, each in its slot colour.
  - Empty slot: a faint grey outline.
  - Present: solid colour. Moving: the figure sways, and its size pulses with its slot's gain. Arms up: draw the arms raised.
  - Hands between neighbouring dancers in the ring: drawn joined only between **present** neighbours. The gap between dancer 5 and dancer 1 (as in the painting) closes **only when the ring closes**.
- **Webcam overlay** (Webcam mode): a small mirrored preview in a corner with each person's skeleton dots coloured by slot, and the instrument name above each person's head ("Flute", "Drum"…). This is what gives each visitor the feeling "this one is me".
- **Simulation overlay:** draggable circles in the bottom area, coloured by slot, labelled with the instrument name.
- **Debug panel** (toggle with **`D`**): FPS, count, and per person: slot, instrument, x, closeness, band, motion bar, moving, armsUp, gain. Also BPM, ring state, and MIDI status.

## 11. Settings panel (`ui.js`, toggle with **`S`**)

Live sliders for: `BPM`, `CLOSE_MIN`, `CLOSE_MAX`, `MOVE_THRESHOLD`, `MOTION_MAX`, `IDLE_LEVEL`, `RING_MIN_PEOPLE`, `RING_HOLD`, `HAND_DISTANCE`, master volume. Plus the MIDI track pickers and bar range from §8. A "Reset to defaults" button.

## 12. `config.js` defaults

```js
export const CONFIG = {
  BPM: 120,
  MAX_PEOPLE: 5,
  LEAVE_TIMEOUT: 1.5, STILL_TIMEOUT: 1.5, RAMP_SECONDS: 0.3,
  MIN_VISIBILITY: 0.5,
  CLOSE_MIN: 0.08, CLOSE_MAX: 0.30,          // shoulder width (normalised); tune on site
  BANDS: [0.25, 0.5, 0.75, 1.0],
  MOTION_SMOOTHING: 0.25, MOTION_MAX: 1.5, MOVE_THRESHOLD: 0.15,
  ARMS_UP_MARGIN: 0.03,
  MAX_JUMP: 0.25,
  IDLE_LEVEL: 0.10,
  HAND_DISTANCE: 0.18,
  RING_MIN_PEOPLE: 4, RING_HOLD: 2.0,
  SLOTS: [ /* table from §2.1: name, colour, role, synth settings, octaveShiftAllowed */ ]
};
```

## 13. Main loop (`main.js`)

1. Start button → `await Tone.start()` → load the MIDI (or placeholder) → schedule parts → start the transport → start the webcam (or Simulation).
2. Every animation frame: get raw input (MediaPipe result or simulation) → `people.update(raw, now)` → `music.update(people, group)` → `visuals.draw(people, group)`.
3. Run MediaPipe `detectForVideo` at most once per video frame. If FPS < 20, skip every other frame automatically.

## 14. Acceptance checklist (Claude Code: verify each item you can; list results in README)

- [ ] `python3 -m http.server 8000` → `http://localhost:8000` → Start → no console errors, in Chrome.
- [ ] With no webcam and no MIDI file: Simulation mode and placeholder melodies run, and the banner is shown.
- [ ] Simulation: pressing 1, 2, 3, 4, 5 adds Flute, Drum, Cello, Oboe, Violin, in that order, each with its colour and label.
- [ ] Each simulated person is silent-ish (10%) when still and plays clearly when dancing (Space / Shift+n).
- [ ] Dragging a person closer steps through 25 → 50 → 75 → 100% with smooth fades. Dragging sideways pans the sound.
- [ ] Arms up (A) makes melodic instruments jump an octave and brighten.
- [ ] Two simulated people placed close together: hands join on screen and the chime plays once.
- [ ] 4+ simulated people all dancing for 2 s: the ring closes visually, the pad blooms and the reverb rises. When one stops, it fades out.
- [ ] After 5 minutes, all parts are still perfectly in time.
- [ ] Removing person 2 and then adding a new one: the new person gets slot 2 (Drum).
- [ ] Dropping a MIDI file: the track list appears, track choices change the parts, and the choices persist after reload.
- [ ] Webcam mode: 1–2 real people at 1.5–4 m are detected, get stable slots, and their dancing audibly controls their own instrument.
- [ ] `tests.html` passes for `matchPeople`, `closenessToBand`, `computeMotion`, `isArmsUp`, `checkRing`.

## 15. README must include

How to run; keyboard controls; how to add the MIDI and choose tracks; camera placement tips (wide-angle webcam, at screen height or slightly above, 3–5 m of floor space, even lighting, people facing the screen); how to tune `CLOSE_MIN`/`CLOSE_MAX` on site (stand at the farthest and nearest spots and read the shoulder width in the debug panel); known limitations; deviations from spec.

## 16. Out of scope (later phases)

Kinect, TouchDesigner, Ableton, projection mapping, real instrument samples, stepping through melodies note by note with footsteps.
