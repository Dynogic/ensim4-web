// ensim4 — web port entry. Wires the simulation, canvas visualizer, Web Audio
// output, and input.
//
// Preferred (SAB) path: the simulation runs in a dedicated Web Worker and writes
// audio into a SharedArrayBuffer ring drained by the AudioWorklet, so audio is
// independent of the main thread's rendering/GC. The main thread keeps a
// structurally identical "display" Engine that it patches from the worker's viz
// snapshots, so render.ts / widgets.ts are unchanged.
//
// Fallback (legacy) path, when the page isn't cross-origin isolated (no
// SharedArrayBuffer): the simulation runs on the main thread and feeds the
// AudioWorklet by postMessage — the original architecture, plus the
// allocation-free hot path.

import "./style.css";

import { precomputeCp } from "./sim/gamma";
import {
  buildEngineFor, ALL_ENGINES, ENGINE_GROUPS,
  type CylConfig,
} from "./sim/blueprints";
import { type Engine, type EngineTime } from "./sim/engine";
import { Sampler } from "./sim/sampler";
import { Synth } from "./sim/synth";
import { AUDIO_SAMPLE_RATE_HZ, SYNTH_BUFFER_SIZE } from "./sim/constants";
import {
  NodeType, deselectAllNodes, selectNodes, selectNext, removeNextSelected,
} from "./sim/nodes";
import { waveTable } from "./sim/wave";
import { UIState, pushWidgets, type WidgetTime } from "./ui/widgets";
import { Renderer, drawScene, radialNodeAt, XRES, YRES } from "./ui/render";
import { setupControls, type Controller, type SelectMode } from "./ui/controls";
import { syncThrottleSlider } from "./ui/controls";
import { AudioOut } from "./audio";
import { createRingSAB } from "./sim/audio-ring";
import { createCommandSAB, CommandWriter, OP } from "./sim/command-queue";
import { applySnapshot, type Snapshot } from "./sim/protocol";
import { createWavePipeSAB } from "./sim/wave-pipe";
import { WAVE_MAX_WAVES } from "./sim/wave";

precomputeCp();

const canUseSAB =
  typeof SharedArrayBuffer !== "undefined" &&
  typeof Atomics !== "undefined" &&
  (typeof crossOriginIsolated === "undefined" || crossOriginIsolated === true);

const CFGS: CylConfig[] = ALL_ENGINES;
const ENGINE_GROUPS_UI = ENGINE_GROUPS.map((g) => ({
  label: g.label,
  engines: g.configs.map((c) => ({ name: c.name, id: ALL_ENGINES.indexOf(c) })),
}));

// Wall-clock audio duration of one produced buffer; the sim runs at N x real-time
// when it computes a buffer in (BUFFER_MS / N) ms.
const BUFFER_MS = (SYNTH_BUFFER_SIZE / AUDIO_SAMPLE_RATE_HZ) * 1000;
const updateRealtime = (instant: number): void => {
  if (instant > 0 && isFinite(instant)) {
    ui.realtimeFactor += (instant - ui.realtimeFactor) * 0.08; // EMA smoothing
  }
};

function freshEngine(cfgId: number): Engine {
  const e = buildEngineFor(CFGS[cfgId]);
  e.reset();
  // CFD on by default in SAB mode (parallel pipe workers sustain it, like the
  // native build); off in the legacy single-thread fallback where serial CFD
  // can't keep up. In SAB mode this is just the display engine's initial value
  // anyway — worker snapshots are the source of truth.
  e.enableCfd(canUseSAB);
  e.use_convolution = true;
  return e;
}

// In SAB mode `engine` is a display shadow patched from snapshots; in legacy mode
// it is the live simulated engine.
let engine = freshEngine(0);
const sampler = new Sampler();
const synth = new Synth(); // legacy mode only
const samplerSynth = new Float32Array(SYNTH_BUFFER_SIZE);
const ui = new UIState();
const audio = new AudioOut();
let displayCfgId = 0;

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d", { alpha: false })!;
const renderer = new Renderer(ctx);

let scale = 1;
let offsetX = 0;
let offsetY = 0;
let dpr = 1;

function resize(): void {
  dpr = window.devicePixelRatio || 1;
  const cssW = window.innerWidth;
  const cssH = window.innerHeight;
  canvas.width = Math.max(1, Math.floor(cssW * dpr));
  canvas.height = Math.max(1, Math.floor(cssH * dpr));
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  scale = Math.min(cssW / XRES, cssH / YRES);
  offsetX = (cssW - XRES * scale) / 2;
  offsetY = (cssH - YRES * scale) / 2;
}
window.addEventListener("resize", resize);
resize();

// --- SAB infrastructure ----------------------------------------------------

const ringSab = canUseSAB ? createRingSAB() : null;
const cmdSab = canUseSAB ? createCommandSAB() : null;
const cmdWriter = cmdSab ? new CommandWriter(cmdSab) : null;
const waveSabs = canUseSAB ? Array.from({ length: WAVE_MAX_WAVES }, () => createWavePipeSAB()) : null;
let worker: Worker | null = null;
let waveWorkers: Worker[] = [];
let pendingSnap: Snapshot | null = null;

const SELECT_INDEX: Record<SelectMode, number> = {
  pistons: 0, intakes: 1, exhausts: 2, clear: 3, next: 4,
};

function rebuildDisplay(cfgId: number): void {
  displayCfgId = cfgId;
  engine = freshEngine(cfgId);
  waveTable.resetAll();
  sampler.clearChannel();
  sampler.index = 0;
  sampler.size = 0;
  sampler.channel_index = 0;
}

// --- Controllers -----------------------------------------------------------

const sabController: Controller = {
  starter: (on) => cmdWriter?.push(OP.STARTER, on ? 1 : 0),
  ignite: () => cmdWriter?.push(OP.IGNITE),
  throttle: (lvl) => cmdWriter?.push(OP.THROTTLE, lvl),
  throttleSet: (v) => cmdWriter?.push(OP.THROTTLE_SET, Math.round(v * 10000)),
  cfd: () => cmdWriter?.push(OP.CFD),
  convo: () => cmdWriter?.push(OP.CONVO),
  plotFilter: () => cmdWriter?.push(OP.PLOTFILTER),
  select: (mode) => cmdWriter?.push(OP.SELECT, SELECT_INDEX[mode]),
  toggleNode: (i) => cmdWriter?.push(OP.TOGGLE_NODE, i),
  switchEngine: (id) => cmdWriter?.push(OP.SWITCH, id),
};

const selectIntakes = () => {
  deselectAllNodes(engine.nodes);
  selectNodes(engine.nodes, NodeType.afilter);
  selectNodes(engine.nodes, NodeType.throttle);
  selectNodes(engine.nodes, NodeType.iplenum);
  selectNodes(engine.nodes, NodeType.irunner);
};
const selectExhausts = () => {
  deselectAllNodes(engine.nodes);
  selectNodes(engine.nodes, NodeType.eplenum);
  selectNodes(engine.nodes, NodeType.erunner);
  selectNodes(engine.nodes, NodeType.exhaust);
};

const legacyController: Controller = {
  starter: (on) => { engine.starter.is_on = on; },
  ignite: () => { engine.can_ignite = !engine.can_ignite; },
  throttle: (lvl) => {
    engine.throttle_open_ratio =
      lvl === 0 ? engine.no_throttle : lvl === 1 ? engine.low_throttle :
      lvl === 2 ? engine.mid_throttle : engine.high_throttle;
  },
  throttleSet: (v) => { engine.throttle_open_ratio = v; },
  cfd: () => engine.enableCfd(!engine.use_cfd),
  convo: () => { engine.use_convolution = !engine.use_convolution; },
  plotFilter: () => { engine.use_plot_filter = !engine.use_plot_filter; },
  select: (mode) => {
    if (mode === "pistons") { deselectAllNodes(engine.nodes); selectNodes(engine.nodes, NodeType.piston); }
    else if (mode === "intakes") selectIntakes();
    else if (mode === "exhausts") selectExhausts();
    else if (mode === "clear") deselectAllNodes(engine.nodes);
    else if (mode === "next") selectNext(engine.nodes);
  },
  toggleNode: (i) => {
    removeNextSelected(engine.nodes);
    sampler.clearChannel();
    engine.nodes[i].is_selected = !engine.nodes[i].is_selected;
  },
  switchEngine: (id) => {
    engine.copyFrom(freshEngine(id));
    sampler.clearChannel();
    sampler.index = 0;
    sampler.size = 0;
    displayCfgId = id;
  },
};

const controller = canUseSAB ? sabController : legacyController;

  setupControls(controller, ENGINE_GROUPS_UI, () => { void resumeAudio(); });

canvas.addEventListener("pointerdown", (e) => {
  const rect = canvas.getBoundingClientRect();
  const lx = (e.clientX - rect.left - offsetX) / scale;
  const ly = (e.clientY - rect.top - offsetY) / scale;
  const i = radialNodeAt(engine, lx, ly);
  if (i >= 0) controller.toggleNode(i);
  void resumeAudio();
});

// --- Startup (audio + worker on first gesture) -----------------------------

let audioStarted = false;
async function resumeAudio(): Promise<void> {
  if (!audioStarted) {
    audioStarted = true;
    try {
      await audio.init(ringSab);
    } catch (err) {
      audioStarted = false;
      console.error("audio init failed", err);
      return;
    }
    if (canUseSAB && ringSab && cmdSab && waveSabs && !worker) {
      // One wave worker per pipe (recovers the native build's per-eplenum
      // threading); they idle until the sim worker dispatches a solve.
      waveWorkers = waveSabs.map((sab) => {
        const ww = new Worker(new URL("./sim/wave-worker.ts", import.meta.url), { type: "module" });
        ww.postMessage({ type: "init", sab });
        return ww;
      });
      worker = new Worker(new URL("./sim/sim-worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (e: MessageEvent<Snapshot>) => {
        const snap = e.data;
        if (snap.cfgId !== displayCfgId) rebuildDisplay(snap.cfgId);
        pendingSnap = snap;
      };
      worker.postMessage({ type: "init", ringSab, cmdSab, waveSabs, cfgId: displayCfgId });
      console.info(`[ensim4] spawned sim worker + ${waveWorkers.length} wave workers`);
    }
  }
  await audio.resume();
}

const now = (): number => performance.now();

// --- SAB render loop (draws from the patched display engine) ----------------

function frameSAB(): void {
  const t0 = now();
  const snap = pendingSnap;
  if (snap) {
    applySnapshot(snap, engine, sampler, waveTable);
    samplerSynth.set(snap.synth);
    syncThrottleSlider(snap.throttle);
    if (snap.waveMs > 0) updateRealtime(BUFFER_MS / snap.waveMs);
  }
  const t2 = now();

  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, offsetX * dpr, offsetY * dpr);
  drawScene(renderer, engine, sampler, ui, samplerSynth);
  const t3 = now();

  const et: EngineTime = {
    getTicksMs: now,
    fluids_time_ms: snap?.fluidsMs ?? 0,
    kinematics_time_ms: snap?.kinematicsMs ?? 0,
    thermo_time_ms: snap?.thermoMs ?? 0,
    synth_time_ms: snap?.synthMs ?? 0,
    wave_time_ms: snap?.waveMs ?? 0,
  };
  const wt: WidgetTime = {
    n_a_time_ms: 0,
    engine_time_ms: snap?.waveMs ?? 0,
    draw_time_ms: t3 - t2,
    vsync_time_ms: now() - t0,
  };
  pushWidgets(ui, engine, et, sampler, samplerSynth, snap?.audioFill ?? 0, wt);
  requestAnimationFrame(frameSAB);
}

// --- Legacy render loop (simulation on the main thread) ---------------------

let lastNow = now();
function frameLegacy(t: number): void {
  const dt = t - lastNow;
  lastNow = t;

  const et: EngineTime = {
    getTicksMs: now,
    fluids_time_ms: 0, kinematics_time_ms: 0, thermo_time_ms: 0,
    synth_time_ms: 0, wave_time_ms: 0,
  };
  const wt: WidgetTime = { n_a_time_ms: 0, engine_time_ms: 0, draw_time_ms: 0, vsync_time_ms: 0 };

  const t1 = now();
  let producedCount = 0;
  if (audioStarted) {
    const toProduce = Math.max(
      1,
      Math.min(4, Math.round((dt / 1000) * AUDIO_SAMPLE_RATE_HZ / SYNTH_BUFFER_SIZE)),
    );
    for (let i = 0; i < toProduce; i++) {
      if (now() - t1 > 13) break;
      synth.clear(); // one independent buffer per produced block
      const produced = engine.run(et, sampler, synth, audio.fill, samplerSynth);
      if (produced) { audio.post(synth.value); producedCount++; }
      else break;
    }
  }
  const t2 = now();
  // Legacy mode: power_w is the cycle-averaged indicated power maintained in
  // Engine.crank() (same as the worker), so nothing extra to compute here.
  wt.engine_time_ms = t2 - t1;
  if (producedCount > 0) updateRealtime((producedCount * BUFFER_MS) / (t2 - t1));
  syncThrottleSlider(engine.throttle_open_ratio);

  ctx.setTransform(scale * dpr, 0, 0, scale * dpr, offsetX * dpr, offsetY * dpr);
  drawScene(renderer, engine, sampler, ui, samplerSynth);
  const t3 = now();
  wt.draw_time_ms = t3 - t2;

  pushWidgets(ui, engine, et, sampler, samplerSynth, audio.fill, wt);
  wt.vsync_time_ms = now() - t1;
  requestAnimationFrame(frameLegacy);
}

if (canUseSAB) requestAnimationFrame(frameSAB);
else requestAnimationFrame(frameLegacy);

console.info(`[ensim4] sim mode: ${canUseSAB ? "worker + SAB (off main thread)" : "legacy (main thread)"}`);
