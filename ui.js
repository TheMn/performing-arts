// ui.js — settings panel (toggle with S): live sliders + MIDI track pickers (spec §11).

import { CONFIG, getDefault } from "./config.js";
import { ROLES } from "./melody.js";

const SLIDERS = [
  { key: "BPM", label: "Tempo (BPM)", min: 60, max: 200, step: 1, digits: 0 },
  { key: "MASTER_VOLUME", label: "Master volume", min: 0, max: 1, step: 0.01, digits: 2 },
  { key: "CLOSE_MIN", label: "CLOSE_MIN (shoulder width = far)", min: 0.03, max: 0.2, step: 0.005, digits: 3 },
  { key: "CLOSE_MAX", label: "CLOSE_MAX (shoulder width = near)", min: 0.15, max: 0.6, step: 0.005, digits: 3 },
  { key: "MOVE_THRESHOLD", label: "MOVE_THRESHOLD", min: 0.02, max: 0.6, step: 0.01, digits: 2 },
  { key: "MOTION_MAX", label: "MOTION_MAX (shoulder widths/s)", min: 0.3, max: 4, step: 0.05, digits: 2 },
  { key: "IDLE_LEVEL", label: "IDLE_LEVEL (volume when still)", min: 0, max: 0.5, step: 0.01, digits: 2 },
  { key: "RING_MIN_PEOPLE", label: "RING_MIN_PEOPLE", min: 2, max: 5, step: 1, digits: 0 },
  { key: "RING_HOLD", label: "RING_HOLD (seconds)", min: 0.5, max: 6, step: 0.1, digits: 1 },
  { key: "HAND_DISTANCE", label: "HAND_DISTANCE", min: 0.05, max: 0.4, step: 0.01, digits: 2 },
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function createSettings(el, handlers) {
  let song = null, selection = null, arrangement = null;

  el.innerHTML = `
    <div class="set-head"><h2>Settings</h2><button type="button" class="set-close" aria-label="Close">×</button></div>
    <div class="set-body">
      <section id="set-sliders"></section>
      <button type="button" id="set-reset" class="set-btn">Reset to defaults</button>
      <h3>Music (MIDI)</h3>
      <div id="set-midi"></div>
    </div>`;
  const slidersEl = el.querySelector("#set-sliders");
  const midiEl = el.querySelector("#set-midi");

  // sliders -------------------------------------------------------------------------------------
  const inputs = new Map();
  for (const s of SLIDERS) {
    const row = document.createElement("label");
    row.className = "set-row";
    row.innerHTML = `<span class="set-label">${s.label}</span><output></output><input type="range" min="${s.min}" max="${s.max}" step="${s.step}">`;
    const input = row.querySelector("input"), out = row.querySelector("output");
    const show = () => { out.textContent = Number(CONFIG[s.key]).toFixed(s.digits); };
    input.addEventListener("input", () => {
      CONFIG[s.key] = Number(input.value);
      show();
      handlers.onChange(s.key, CONFIG[s.key]);
    });
    input.addEventListener("pointerup", () => input.blur());
    inputs.set(s.key, { input, show });
    slidersEl.appendChild(row);
  }
  function refreshSliders() {
    for (const s of SLIDERS) { const i = inputs.get(s.key); i.input.value = CONFIG[s.key]; i.show(); }
  }
  el.querySelector("#set-reset").addEventListener("click", () => { handlers.onReset(); refreshSliders(); });
  el.querySelector(".set-close").addEventListener("click", () => toggle(false));
  refreshSliders();

  // MIDI section ---------------------------------------------------------------------------------
  function renderMidi() {
    if (!song) { midiEl.innerHTML = ""; return; }
    let html = `<label class="set-file">Load MIDI file… <input type="file" id="set-file" accept=".mid,.midi,audio/midi"></label>`;
    if (song.placeholder) {
      html += `<p class="set-note">No MIDI file loaded — using placeholder melodies in D. Drop the Farandole <code>.mid</code> anywhere on the page, or put it at <code>assets/farandole.mid</code>.</p>`;
      midiEl.innerHTML = html;
      wireFile();
      return;
    }
    html += `<p class="set-note"><b>${esc(song.name)}</b> — ${song.totalBars} bars, ${song.beatsPerBar} beats/bar <button type="button" id="set-clear" class="set-link">forget file</button></p>`;
    html += `<table class="set-tracks"><tr><th>#</th><th>name</th><th>instrument</th><th>notes</th></tr>`;
    for (const t of song.tracks) {
      html += `<tr class="${t.noteCount ? "" : "dim"}"><td>${t.index}</td><td>${esc(t.name)}</td><td>${esc(t.instrument)}${t.percussion ? " (perc)" : ""}</td><td>${t.noteCount}</td></tr>`;
    }
    html += `</table>`;
    for (const r of ROLES) {
      const cfg = CONFIG.SLOTS[r.slot - 1];
      html += `<label class="set-row set-pick"><span class="set-label" style="color:${cfg.colour}">${r.label}</span><select data-slot="${r.slot}">`;
      html += `<option value="auto">auto${r.slot === 5 ? " (3rd track, else Theme A +8va)" : ""}</option><option value="ph">placeholder</option>`;
      for (const t of song.tracks) if (t.noteCount) html += `<option value="${t.index}">${t.index}: ${esc(t.name)} (${t.noteCount})</option>`;
      html += `</select></label>`;
      if (arrangement) html += `<div class="set-src">→ ${esc(arrangement.sources[r.slot])}</div>`;
    }
    html += `<div class="set-row set-bars"><span class="set-label">Loop region (bars)</span>
      <input type="number" id="set-start" min="1" max="${song.totalBars}" step="1" value="${selection.startBar}">
      <span>to</span>
      <input type="number" id="set-end" min="1" max="${song.totalBars}" step="1" value="${selection.endBar}"></div>`;
    midiEl.innerHTML = html;
    midiEl.querySelectorAll("select[data-slot]").forEach((sel) => { sel.value = String(selection.tracks[sel.dataset.slot]); });
    midiEl.querySelectorAll("select[data-slot]").forEach((sel) => sel.addEventListener("change", () => {
      selection.tracks[sel.dataset.slot] = sel.value;
      handlers.onSelection(selection);
    }));
    const start = midiEl.querySelector("#set-start"), end = midiEl.querySelector("#set-end");
    const bars = () => {
      selection.startBar = Number(start.value) || 1;
      selection.endBar = Number(end.value) || 0;
      handlers.onSelection(selection);
    };
    start.addEventListener("change", bars); end.addEventListener("change", bars);
    midiEl.querySelector("#set-clear").addEventListener("click", () => handlers.onClearMidi());
    wireFile();
  }
  function wireFile() {
    const f = midiEl.querySelector("#set-file");
    if (f) f.addEventListener("change", () => { if (f.files[0]) handlers.onLoadFile(f.files[0]); f.value = ""; });
  }

  function setSong(s, sel, arr) { song = s; selection = sel; arrangement = arr; renderMidi(); }

  // show / hide ---------------------------------------------------------------------------------
  let visible = false;
  function toggle(force) {
    visible = force === undefined ? !visible : force;
    el.hidden = !visible;
    return visible;
  }
  el.hidden = true;

  return { toggle, refreshSliders, setSong, isVisible: () => visible };
}
