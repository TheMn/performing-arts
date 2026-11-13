// main.js — wiring + the main loop (spec §13).
//   Start → Tone.start() → load MIDI (or placeholder) → schedule parts → start transport → camera / Simulation
//   every frame: raw input → people.update → music.update → visuals.draw

import { CONFIG, loadSettings, saveSettings, resetSettings } from "./config.js";
import { PeopleTracker } from "./people.js";
import { Simulation } from "./simulate.js";
import { Visuals, DebugPanel } from "./visuals.js";
import { createSettings } from "./ui.js";
import { PoseTracker } from "./tracking.js";
import {
  loadInitialSong, parseMidi, buildArrangement, loadSelection, saveSelection, normalizeSelection,
  storeMidiFile, clearStoredMidiFile, placeholderSong,
} from "./melody.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

loadSettings();

// start loading the audio module right away so "Start" is quick (errors are reported on Start)
const musicImport = import("./music.js").catch((e) => ({ error: e }));

const canvas = $("stage"), video = $("cam");
const visuals = new Visuals(canvas);
const debug = new DebugPanel($("debug"));
const sim = new Simulation(CONFIG);
const tracker = new PeopleTracker(CONFIG);
const tracking = new PoseTracker(video);

const app = {
  started: false, mode: "sim", music: null, song: null, selection: null, arrangement: null,
  pendingSong: null, switching: false, midiStatus: "not loaded",
};

// ---------------------------------------------------------------------------------------------
// small UI helpers
let toastTimer = 0;
function toast(msg, ms = 2600) {
  const el = $("toast");
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  if (ms > 0) toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
function setStatus(msg, isErr = false) { const s = $("start-status"); s.textContent = msg; s.className = isErr ? "err" : ""; }
function updateHint() {
  const el = $("hint");
  el.hidden = !app.started;
  el.innerHTML = app.mode === "sim"
    ? "<b>Simulation</b> — <b>1</b>–<b>5</b> add / remove people · drag them · hold <b>Space</b> to dance · <b>Shift+1–5</b> keep one dancing · hover + <b>A</b> arms up · <b>T</b> webcam · <b>D</b> debug · <b>S</b> settings"
    : "<b>Webcam</b> — step in front of the camera and dance · <b>T</b> simulation · <b>D</b> debug · <b>S</b> settings";
}

// ---------------------------------------------------------------------------------------------
// settings panel
const settings = createSettings($("settings"), {
  onChange(key, value) {
    saveSettings();
    if (!app.music) return;
    if (key === "BPM") app.music.setBpm(value);
    if (key === "MASTER_VOLUME") app.music.setMasterVolume(value);
  },
  onReset() {
    resetSettings();
    if (app.music) { app.music.setBpm(CONFIG.BPM); app.music.setMasterVolume(CONFIG.MASTER_VOLUME); }
    toast("Settings reset to defaults");
  },
  onSelection(sel) { applySelection(sel); },
  onLoadFile(file) { loadMidiFile(file); },
  onClearMidi() {
    clearStoredMidiFile();
    loadInitialSong().then((s) => applySong(s));
  },
});

// ---------------------------------------------------------------------------------------------
// melody handling
function describeSong() {
  const s = app.song;
  if (!s) return "not loaded";
  if (s.placeholder) return "placeholder melodies (no MIDI file)";
  const a = app.arrangement;
  return `${s.name} · ${s.tracks.length} tracks · bars ${a.startBar}–${a.endBar} of ${s.totalBars}`;
}

function applySong(song) {
  app.song = song;
  app.selection = loadSelection(song);
  rebuildArrangement();
  $("banner").hidden = !song.placeholder;
}

function rebuildArrangement() {
  app.arrangement = buildArrangement(app.song, app.selection);
  if (app.music) app.music.setArrangement(app.arrangement);
  app.midiStatus = describeSong();
  settings.setSong(app.song, app.selection, app.arrangement);
}

function applySelection(sel) {
  if (!app.song || app.song.placeholder) return;
  app.selection = normalizeSelection({ ...sel, file: app.song.name }, app.song);
  saveSelection(app.selection);
  rebuildArrangement();
}

async function loadMidiFile(file) {
  try {
    const buf = await file.arrayBuffer();
    const song = await parseMidi(buf, file.name);
    if (!song.tracks.some((t) => t.noteCount > 0)) throw new Error("no notes in this file");
    storeMidiFile(file.name, buf);
    if (app.music) { applySong(song); toast(`Loaded ${file.name} — ${song.tracks.length} tracks. Choose tracks in Settings (S).`, 4200); }
    else { app.pendingSong = song; toast(`${file.name} will be used when you press Start`, 3000); }
  } catch (e) {
    console.warn("[midi]", e);
    toast(`Could not read that MIDI file (${e.message})`, 4200);
  }
}

// drag & drop a MIDI file anywhere, any time
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
window.addEventListener("dragenter", (e) => { if (hasFiles(e)) { dragDepth++; $("drop").hidden = false; e.preventDefault(); } });
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("drop").hidden = true; });
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $("drop").hidden = true;
  const f = [...e.dataTransfer.files].find((x) => /\.midi?$/i.test(x.name)) || e.dataTransfer.files[0];
  if (f) loadMidiFile(f);
});

// ---------------------------------------------------------------------------------------------
// start + modes
async function start(wantCamera) {
  if (app.started) return;
  $("start-btn").disabled = true; $("start-sim").disabled = true;
  setStatus("Loading the audio engine…");
  try {
    const mod = await musicImport;
    if (mod.error) throw mod.error;
    app.music = new mod.Music();
    await app.music.init();                         // includes Tone.start() (needs this click)
  } catch (e) {
    console.error(e);
    setStatus(`Could not start audio: ${e.message || e}`, true);
    $("start-btn").disabled = false; $("start-sim").disabled = false;
    app.music = null;
    return;
  }
  setStatus("Loading melodies…");
  let song = app.pendingSong;
  if (!song) { try { song = await loadInitialSong(); } catch (e) { song = placeholderSong(); } }
  applySong(song);
  app.music.setBpm(CONFIG.BPM); app.music.setMasterVolume(CONFIG.MASTER_VOLUME);
  app.music.start();
  app.started = true;
  $("start-screen").hidden = true;
  updateHint();
  if (wantCamera) await switchMode("webcam"); else await switchMode("sim");
}

function cameraProblem(e) {
  const name = e && e.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "camera permission denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no camera found";
  if (name === "NotReadableError") return "camera is busy";
  return (e && e.message) || "unknown error";
}

async function switchMode(next) {
  if (app.switching) return;
  app.switching = true;
  try {
    if (next === "webcam") {
      if (!tracking.ready) {
        toast("Starting camera and tracker…", 0);
        try { await tracking.start(); }
        catch (e) {
          console.warn("[tracking]", e);
          tracking.stop();
          app.mode = "sim"; tracker.reset(); updateHint();
          toast(`Webcam unavailable (${cameraProblem(e)}) — Simulation mode`, 5000);
          return;
        }
      }
      app.mode = "webcam";
      toast(`Webcam mode (${tracking.delegate} tracker)`);
    } else {
      app.mode = "sim";
      toast("Simulation mode — press 1–5 to add people");
    }
    tracker.reset();
    updateHint();
  } finally { app.switching = false; }
}

$("start-btn").addEventListener("click", () => start(params.get("mode") !== "sim"));
$("start-sim").addEventListener("click", () => start(false));

// ---------------------------------------------------------------------------------------------
// keyboard + pointer
window.addEventListener("keydown", (e) => {
  if (!app.started) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target && e.target.matches && e.target.matches("input[type=text],input[type=number],textarea,select")) return;
  const code = e.code;
  if (code === "Space") {
    e.preventDefault();
    if (document.activeElement && document.activeElement.blur && document.activeElement.tagName === "BUTTON") document.activeElement.blur();
    sim.setSpace(true);
    return;
  }
  const m = /^Digit([1-5])$/.exec(code);
  if (m) {
    if (e.repeat) return;
    const id = Number(m[1]);
    if (app.mode !== "sim") { toast("Press T to switch to Simulation mode first"); return; }
    if (e.shiftKey) {
      if (!sim.has(id)) { sim.toggle(id); sim.toggleSticky(id); }
      else sim.toggleSticky(id);
    } else sim.toggle(id);
    return;
  }
  if (e.repeat) return;
  switch (code) {
    case "KeyT": switchMode(app.mode === "sim" ? "webcam" : "sim"); break;
    case "KeyD": debug.toggle(); break;
    case "KeyS": settings.toggle(); break;
    case "KeyA": {
      if (app.mode !== "sim") break;
      const id = sim.hovered();
      if (id) { const on = sim.toggleArms(id); toast(`Person ${id}: arms ${on ? "up" : "down"}`, 1200); }
      else toast("Hover the mouse over a person, then press A", 1800);
      break;
    }
    case "KeyF":
      if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
      break;
    default:
  }
});
window.addEventListener("keyup", (e) => { if (e.code === "Space") sim.setSpace(false); });
window.addEventListener("blur", () => sim.setSpace(false));
window.addEventListener("resize", () => visuals.resize());

canvas.addEventListener("pointerdown", (e) => {
  if (app.mode !== "sim" || !app.started) return;
  if (sim.pointerDown(e.clientX, e.clientY, visuals.w, visuals.h)) {
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = "grabbing";
  }
});
canvas.addEventListener("pointermove", (e) => {
  if (app.mode !== "sim") return;
  sim.pointerMove(e.clientX, e.clientY, visuals.w, visuals.h);
  if (sim.dragId === null) canvas.style.cursor = sim.hovered() ? "grab" : "default";
});
const endDrag = () => { sim.pointerUp(); canvas.style.cursor = sim.hovered() ? "grab" : "default"; };
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
canvas.addEventListener("pointerleave", () => { sim.hoverId = null; });

// ---------------------------------------------------------------------------------------------
// main loop
let last = performance.now() / 1000, fps = 60, skipping = false;

function frame(tms) {
  requestAnimationFrame(frame);
  const now = tms / 1000;
  const dt = Math.min(0.1, Math.max(0.0001, now - last));
  last = now;
  fps += (1 / dt - fps) * 0.05;
  if (fps < 20) skipping = true; else if (fps > 26) skipping = false;

  // 1. raw input: webcam pose OR simulated poses
  let raw = null;
  if (app.mode === "sim") raw = sim.step(dt);
  else if (tracking.ready) { tracking.skipOther = skipping; raw = tracking.detect(); }

  // 2. people (the single source of truth), 3. music, 4. visuals
  const { people, group } = tracker.update(raw, now);
  const music = app.music;
  if (music) music.update(people, group, dt);

  const ex = {
    dt, now, mode: app.mode, simView: sim.view(), video, beat: music ? music.beat() : 0,
    gains: music ? music.slots.map((s) => s.visGain) : null,
    midiStatus: app.midiStatus,
    trackerInfo: `${tracking.delegate || "–"} · inference ${tracking.inferenceMs.toFixed(0)} ms${skipping ? " · skipping frames" : ""}`,
    music: debug.visible && music ? music.snapshot() : null,
  };
  visuals.draw(people, group, ex);
  debug.update(people, group, ex, tms);
}
requestAnimationFrame(frame);

// handy for tests / the browser console
window.__demo = {
  CONFIG, sim, tracker, tracking, app, visuals,
  get music() { return app.music; },
  get mode() { return app.mode; },
  switchMode, applySong, parseMidi,
};
