// Message protocol between the main thread and the simulation Web Worker.
//
//   main -> worker : Cmd (input/control; rare, plain objects)
//   worker -> main : Snapshot (viz state; ~30 Hz, reused typed arrays)
//
// The worker owns the authoritative Engine. The main thread keeps a structurally
// identical "display" Engine (built from the same blueprint) and patches its
// dynamic fields from each Snapshot, so render.ts / widgets.ts read it exactly as
// before. Snapshots are posted WITHOUT transfer: structured clone copies them at
// postMessage time, so the worker can keep reusing its scratch arrays with no
// per-frame allocation.

import { type Engine } from "./engine";
import {
  MAX_CHANNELS, SAMPLE_NAME_E_SIZE, MAX_SAMPLES, type Sampler,
} from "./sampler";
import { type WaveTable } from "./wave";

export const DISPLAY_SAMPLES = MAX_SAMPLES / 16; // 1024, matches render's cap
const WAVE_CELLS = 128;

// ---- main -> worker -------------------------------------------------------

export type Cmd =
  | { t: "starter"; on: boolean }
  | { t: "ignite" }
  | { t: "throttle"; v: number }
  | { t: "cfd" }
  | { t: "convolution" }
  | { t: "plotfilter" }
  | { t: "select"; mode: "pistons" | "intakes" | "exhausts" | "clear" | "next" }
  | { t: "toggleNode"; i: number }
  | { t: "switchEngine"; id: number };

// ---- worker -> main -------------------------------------------------------

export interface Snapshot {
  cfgId: number; // which engine config is live (so main can rebuild its display engine)
  // engine scalars
  omega: number;
  theta: number;
  throttle: number;
  canIgnite: boolean;
  starterOn: boolean;
  useCfd: boolean;
  useConvolution: boolean;
  usePlotFilter: boolean;
  // per-node dynamic state
  nozzle: Float32Array;       // [nodeCount]
  flowCycles: Float64Array;   // [nodeCount]
  panic: Uint8Array;          // [nodeCount]
  selected: Uint8Array;       // [nodeCount]
  nextSelected: Uint8Array;   // [nodeCount]
  // sampler (downsampled)
  channelIndex: number;
  size: number;               // downsampled sample count, <= DISPLAY_SAMPLES
  channel: Float32Array;      // [channelIndex*19*size], packed (ch*19+name)*size + i
  starter: Float32Array;      // [size]
  synth: Float32Array;        // [800]
  // waves
  numWaves: number;
  wavePrimP: Float32Array;    // [numWaves*128]
  waveScalars: Float64Array;  // [numWaves*3] -> maxSpeed, pipeLen, micPos
  // timing / meters
  fluidsMs: number;
  kinematicsMs: number;
  thermoMs: number;
  synthMs: number;
  waveMs: number;
  audioFill: number;          // ring fill in samples
  powerW: number;            // indicated power = cycle-avg gas torque × ω (computed in the worker)
  limiterEnabled: boolean;   // rev limiter on/off (toggled by user)
}

function downsampleInto(
  src: Float64Array, srcStart: number, size: number, cap: number,
  dst: Float32Array, dstStart: number,
): number {
  if (size > cap) {
    const step = ((size + cap - 1) / cap) | 0;
    let j = 0;
    for (let i = 0; i < size; i += step) dst[dstStart + j++] = src[srcStart + i];
    return j;
  }
  for (let i = 0; i < size; i++) dst[dstStart + i] = src[srcStart + i];
  return size;
}

// Builds Snapshots from the worker's live engine, reusing scratch arrays.
export class SnapshotPacker {
  private nodeCount: number;
  private numWaves: number;
  private nozzle: Float32Array;
  private flowCycles: Float64Array;
  private panic: Uint8Array;
  private selected: Uint8Array;
  private nextSelected: Uint8Array;
  private channel: Float32Array;
  private starter: Float32Array;
  private wavePrimP: Float32Array;
  private waveScalars: Float64Array;

  constructor(nodeCount: number, numWaves: number) {
    this.nodeCount = nodeCount;
    this.numWaves = numWaves;
    this.nozzle = new Float32Array(nodeCount);
    this.flowCycles = new Float64Array(nodeCount);
    this.panic = new Uint8Array(nodeCount);
    this.selected = new Uint8Array(nodeCount);
    this.nextSelected = new Uint8Array(nodeCount);
    this.channel = new Float32Array(MAX_CHANNELS * SAMPLE_NAME_E_SIZE * DISPLAY_SAMPLES);
    this.starter = new Float32Array(DISPLAY_SAMPLES);
    this.wavePrimP = new Float32Array(numWaves * WAVE_CELLS);
    this.waveScalars = new Float64Array(numWaves * 3);
  }

  pack(
    cfgId: number,
    engine: Engine, sampler: Sampler, samplerSynth: Float32Array,
    waveTable: WaveTable,
    timing: { fluidsMs: number; kinematicsMs: number; thermoMs: number; synthMs: number; waveMs: number },
    audioFill: number,
  ): Snapshot {
    const nodes = engine.nodes;
    const nc = this.nodeCount;
    for (let i = 0; i < nc; i++) {
      const n = nodes[i];
      this.nozzle[i] = n.chamber.nozzle_open_ratio;
      this.flowCycles[i] = n.chamber.flow_cycles;
      this.panic[i] = n.chamber.should_panic ? 1 : 0;
      this.selected[i] = n.is_selected ? 1 : 0;
      this.nextSelected[i] = n.is_next_selected ? 1 : 0;
    }

    const ci = Math.min(sampler.channel_index, MAX_CHANNELS);
    const size = sampler.size;
    const realN = packChannels(sampler, ci, size, this.channel);
    downsampleInto(sampler.starter, 0, size, DISPLAY_SAMPLES, this.starter, 0);

    const nw = this.numWaves;
    for (let k = 0; k < nw; k++) {
      const primP = waveTable.primPView(k);
      const base = k * WAVE_CELLS;
      for (let i = 0; i < WAVE_CELLS; i++) this.wavePrimP[base + i] = primP[i];
      this.waveScalars[k * 3 + 0] = waveTable.maxWaveSpeedMPerS(k);
      this.waveScalars[k * 3 + 1] = waveTable.pipeLengthM(k);
      this.waveScalars[k * 3 + 2] = waveTable.micPositionRatio(k);
    }

    return {
      cfgId,
      omega: engine.crankshaft.angular_velocity_r_per_s,
      theta: engine.crankshaft.theta_r,
      throttle: engine.throttle_open_ratio,
      powerW: engine.power_w,
      canIgnite: engine.can_ignite,
      limiterEnabled: engine.limiter.enabled,
      starterOn: engine.starter.is_on,
      useCfd: engine.use_cfd,
      useConvolution: engine.use_convolution,
      usePlotFilter: engine.use_plot_filter,
      nozzle: this.nozzle,
      flowCycles: this.flowCycles,
      panic: this.panic,
      selected: this.selected,
      nextSelected: this.nextSelected,
      channelIndex: ci,
      size: realN,
      channel: this.channel.subarray(0, ci * SAMPLE_NAME_E_SIZE * realN),
      starter: this.starter.subarray(0, realN),
      synth: samplerSynth,
      numWaves: nw,
      wavePrimP: this.wavePrimP,
      waveScalars: this.waveScalars,
      fluidsMs: timing.fluidsMs,
      kinematicsMs: timing.kinematicsMs,
      thermoMs: timing.thermoMs,
      synthMs: timing.synthMs,
      waveMs: timing.waveMs,
      audioFill,
    };
  }
}

function dsNStride(size: number): number {
  return size > DISPLAY_SAMPLES ? DISPLAY_SAMPLES : size;
}

// Packs all selected channels tightly as (ch*19+name)*N + i, returns N.
function packChannels(sampler: Sampler, ci: number, size: number, dst: Float32Array): number {
  const N = dsNStride(size);
  if (N === 0) return 0;
  for (let ch = 0; ch < ci; ch++) {
    for (let name = 0; name < SAMPLE_NAME_E_SIZE; name++) {
      const srcStart = ((ch * SAMPLE_NAME_E_SIZE) + name) * MAX_SAMPLES;
      const dstStart = ((ch * SAMPLE_NAME_E_SIZE) + name) * N;
      downsampleInto(sampler.channel, srcStart, size, DISPLAY_SAMPLES, dst, dstStart);
    }
  }
  return N;
}

// Patches the main-thread display engine/sampler/waveTable from a Snapshot.
export function applySnapshot(
  s: Snapshot, engine: Engine, sampler: Sampler, waveTable: WaveTable,
): void {
  engine.crankshaft.angular_velocity_r_per_s = s.omega;
  engine.crankshaft.theta_r = s.theta;
  engine.throttle_open_ratio = s.throttle;
  engine.power_w = s.powerW;
  engine.can_ignite = s.canIgnite;
  engine.limiter.enabled = s.limiterEnabled;
  engine.starter.is_on = s.starterOn;
  engine.use_cfd = s.useCfd;
  engine.use_convolution = s.useConvolution;
  engine.use_plot_filter = s.usePlotFilter;

  const nodes = engine.nodes;
  const nc = Math.min(nodes.length, s.nozzle.length);
  for (let i = 0; i < nc; i++) {
    const n = nodes[i];
    n.chamber.nozzle_open_ratio = s.nozzle[i];
    n.chamber.flow_cycles = s.flowCycles[i];
    n.chamber.should_panic = s.panic[i] !== 0;
    n.is_selected = s.selected[i] !== 0;
    n.is_next_selected = s.nextSelected[i] !== 0;
  }
  // Recompute piston geometry from the patched crank angle so the piston row and
  // sparkplug indicators draw correctly without simulating on the main thread.
  engine.rigPistons();

  const ci = s.channelIndex;
  const N = s.size;
  sampler.channel_index = ci;
  sampler.size = N;
  for (let ch = 0; ch < ci; ch++) {
    for (let name = 0; name < SAMPLE_NAME_E_SIZE; name++) {
      const dstStart = ((ch * SAMPLE_NAME_E_SIZE) + name) * MAX_SAMPLES;
      const srcStart = ((ch * SAMPLE_NAME_E_SIZE) + name) * N;
      for (let i = 0; i < N; i++) sampler.channel[dstStart + i] = s.channel[srcStart + i];
    }
  }
  for (let i = 0; i < N; i++) sampler.starter[i] = s.starter[i];

  const nw = s.numWaves;
  for (let k = 0; k < nw; k++) {
    const primP = waveTable.primPView(k);
    const base = k * WAVE_CELLS;
    for (let i = 0; i < WAVE_CELLS; i++) primP[i] = s.wavePrimP[base + i];
    waveTable.setDisplayScalars(k, s.waveScalars[k * 3 + 0], s.waveScalars[k * 3 + 1], s.waveScalars[k * 3 + 2]);
  }
}
