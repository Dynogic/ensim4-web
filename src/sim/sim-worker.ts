// Simulation Web Worker: owns the authoritative engine and runs it on its own
// thread, decoupled from the main thread's rendering/GC and from rAF throttling.
//
// - Produces 800-sample audio buffers into the SharedArrayBuffer ring (drained by
//   the AudioWorklet). Pacing is by Atomics.wait on the ring, so it stays
//   real-time even when the page is backgrounded (timers would be throttled).
// - Drains input commands from the command SAB each iteration.
// - Posts compact viz snapshots to the main thread (~30 Hz) via postMessage.
//
// The init message (with the SABs) arrives on onmessage; after that the worker
// enters its produce loop and never returns to the event loop, so all runtime
// input must come through the command queue.

import { precomputeCp } from "./gamma";
import {
  buildEngineFor, ALL_ENGINES,
  type CylConfig,
} from "./blueprints";
import { type Engine, type EngineTime } from "./engine";
import { Sampler } from "./sampler";
import { Synth } from "./synth";
import { SYNTH_BUFFER_SIZE } from "./constants";
import {
  NodeType, deselectAllNodes, selectNodes, selectNext, removeNextSelected,
} from "./nodes";
import { waveTable } from "./wave";
import { WavePipeClient } from "./wave-pipe";
import { RingProducer, RING_CAPACITY } from "./audio-ring";
import { CommandReader, OP } from "./command-queue";
import { SnapshotPacker } from "./protocol";

const TARGET_FILL = 2400;          // keep ~50 ms of audio queued (cushion vs latency)
const WAIT_TIMEOUT_MS = 100;       // re-check commands at least this often
const SNAPSHOT_EVERY_BUFFERS = 2;  // ~30 Hz viz

const CFGS: CylConfig[] = ALL_ENGINES;

let prod: RingProducer;
let cmd: CommandReader;
let engine: Engine;
let sampler: Sampler;
let synth: Synth;
let samplerSynth: Float32Array;
let packer: SnapshotPacker;
let cfgId = 0;
let started = false;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const et: EngineTime = {
  getTicksMs: now,
  fluids_time_ms: 0, kinematics_time_ms: 0, thermo_time_ms: 0, synth_time_ms: 0, wave_time_ms: 0,
};

function buildFor(id: number): void {
  cfgId = id;
  const cfg = CFGS[id];
  engine = buildEngineFor(cfg);
  engine.reset();
  engine.enableCfd(true);        // CFD on by default like the native build; pipe
                                 // solves run on their own workers so it sustains
                                 // real-time.
  engine.use_convolution = true;
  sampler = new Sampler();
  synth = new Synth();
  samplerSynth = new Float32Array(SYNTH_BUFFER_SIZE);
  packer = new SnapshotPacker(engine.nodes.length, cfg.num_eplenums);
}

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

function applyCommand(op: number, arg: number): void {
  switch (op) {
    case OP.STARTER: engine.starter.is_on = arg !== 0; break;
    case OP.IGNITE: engine.can_ignite = !engine.can_ignite; break;
    case OP.THROTTLE:
      engine.throttle_open_ratio =
        arg === 0 ? engine.no_throttle : arg === 1 ? engine.low_throttle :
        arg === 2 ? engine.mid_throttle : engine.high_throttle;
      break;
    case OP.THROTTLE_SET:
      engine.throttle_open_ratio = arg / 10000.0;
      break;
    case OP.CFD: engine.enableCfd(!engine.use_cfd); break;
    case OP.CONVO: engine.use_convolution = !engine.use_convolution; break;
    case OP.PLOTFILTER: engine.use_plot_filter = !engine.use_plot_filter; break;
    case OP.SELECT:
      if (arg === 0) { deselectAllNodes(engine.nodes); selectNodes(engine.nodes, NodeType.piston); }
      else if (arg === 1) selectIntakes();
      else if (arg === 2) selectExhausts();
      else if (arg === 3) deselectAllNodes(engine.nodes);
      else if (arg === 4) selectNext(engine.nodes);
      break;
    case OP.TOGGLE_NODE: {
      removeNextSelected(engine.nodes);
      const i = arg;
      if (i >= 0 && i < engine.nodes.length) {
        sampler.clearChannel();
        engine.nodes[i].is_selected = !engine.nodes[i].is_selected;
      }
      break;
    }
    case OP.SWITCH:
      if (arg !== cfgId) buildFor(arg);
      break;
  }
}

function produceBuffer(): void {
  et.fluids_time_ms = 0; et.kinematics_time_ms = 0; et.thermo_time_ms = 0;
  et.synth_time_ms = 0; et.wave_time_ms = 0;
  synth.clear();
  engine.run(et, sampler, synth, 0, samplerSynth);
  prod.write(synth.value, SYNTH_BUFFER_SIZE);
}

function postSnapshot(): void {
  const snap = packer.pack(
    cfgId, engine, sampler, samplerSynth, waveTable,
    {
      fluidsMs: et.fluids_time_ms, kinematicsMs: et.kinematics_time_ms,
      thermoMs: et.thermo_time_ms, synthMs: et.synth_time_ms, waveMs: et.wave_time_ms,
    },
    prod.fill(),
  );
  (self as unknown as Worker).postMessage(snap);
}

function loop(): void {
  let sinceSnapshot = 0;
  for (;;) {
    cmd.drain(applyCommand);
    while (prod.fill() < TARGET_FILL && prod.free() >= SYNTH_BUFFER_SIZE) {
      produceBuffer();
      if (++sinceSnapshot >= SNAPSHOT_EVERY_BUFFERS) {
        sinceSnapshot = 0;
        postSnapshot();
      }
    }
    // Ring at target: block until the consumer drains below it (or timeout, so we
    // still poll commands when audio is suspended).
    prod.waitForSpace(RING_CAPACITY - TARGET_FILL + 1, WAIT_TIMEOUT_MS);
  }
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg && msg.type === "init" && !started) {
    started = true;
    precomputeCp();
    prod = new RingProducer(msg.ringSab as SharedArrayBuffer);
    cmd = new CommandReader(msg.cmdSab as SharedArrayBuffer);
    // Attach a pipe worker per wave so CFD solves run on their own threads and
    // overlap the step loop. Absent (e.g. spawn failed) -> CFD solves inline.
    const waveSabs = msg.waveSabs as SharedArrayBuffer[] | undefined;
    if (Array.isArray(waveSabs)) {
      for (let k = 0; k < waveSabs.length; k++) {
        waveTable.attachParallel(k, new WavePipeClient(waveSabs[k]));
      }
    }
    buildFor(typeof msg.cfgId === "number" ? msg.cfgId : 0);
    loop(); // never returns
  }
};
