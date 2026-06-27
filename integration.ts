// End-to-end check of the new threading data path (without a browser):
//  1. Audio integrity: samples drained from the SAB ring == a straight engine run.
//  2. Snapshot fidelity: a display engine patched from snapshots reproduces the
//     fields render.ts reads from the worker's live engine.

import { buildEngine, ENGINE_8_CYL } from "./src/sim/blueprints.ts";
import { precomputeCp } from "./src/sim/gamma.ts";
import { Sampler } from "./src/sim/sampler.ts";
import { Synth } from "./src/sim/synth.ts";
import { type EngineTime } from "./src/sim/engine.ts";
import { SYNTH_BUFFER_SIZE } from "./src/sim/constants.ts";
import { SAMPLE_NAME_E_SIZE, MAX_SAMPLES } from "./src/sim/sampler.ts";
import { createRingSAB, RingProducer, RingConsumer } from "./src/sim/audio-ring.ts";
import { SnapshotPacker, applySnapshot } from "./src/sim/protocol.ts";
import { waveTable } from "./src/sim/wave.ts";

const now = () => 0;
function makeEt(): EngineTime {
  return { getTicksMs: now, fluids_time_ms: 0, kinematics_time_ms: 0, thermo_time_ms: 0, synth_time_ms: 0, wave_time_ms: 0 };
}
function makeRunning(cfg: typeof ENGINE_8_CYL) {
  const e = buildEngine(cfg);
  e.reset();
  e.enableCfd(false);
  e.use_convolution = true;
  e.starter.is_on = true;
  e.can_ignite = true;
  e.throttle_open_ratio = 1.0;
  return e;
}

const N = 400;

// ---- 1. audio integrity ---------------------------------------------------
precomputeCp();
const refEngine = makeRunning(ENGINE_8_CYL);
const refSampler = new Sampler();
const refSynth = new Synth();
const refSS = new Float32Array(SYNTH_BUFFER_SIZE);
const refStream = new Float32Array(N * SYNTH_BUFFER_SIZE);
for (let b = 0; b < N; b++) {
  refSynth.clear();
  refEngine.run(makeEt(), refSampler, refSynth, 0, refSS);
  refStream.set(refSynth.value, b * SYNTH_BUFFER_SIZE);
}

const wEngine = makeRunning(ENGINE_8_CYL);
const wSampler = new Sampler();
const wSynth = new Synth();
const wSS = new Float32Array(SYNTH_BUFFER_SIZE);
const sab = createRingSAB();
const prod = new RingProducer(sab);
const cons = new RingConsumer(sab);
const outStream = new Float32Array(N * SYNTH_BUFFER_SIZE);
const drainBuf = new Float32Array(128);
let outPos = 0;
function drainSome(maxBlocks: number) {
  for (let k = 0; k < maxBlocks; k++) {
    const got = cons.read(drainBuf);
    for (let i = 0; i < got; i++) outStream[outPos++] = drainBuf[i];
    if (got < drainBuf.length) break;
  }
}
for (let b = 0; b < N; b++) {
  while (prod.free() < SYNTH_BUFFER_SIZE) drainSome(8);
  wSynth.clear();
  wEngine.run(makeEt(), wSampler, wSynth, 0, wSS);
  prod.write(wSynth.value, SYNTH_BUFFER_SIZE);
  if ((b & 3) === 0) drainSome(4);
}
while (outPos < N * SYNTH_BUFFER_SIZE) {
  const before = outPos;
  drainSome(64);
  if (outPos === before) break;
}

let audioMax = 0, audioMism = 0;
for (let i = 0; i < refStream.length; i++) {
  const d = Math.abs(refStream[i] - outStream[i]);
  if (d > audioMax) audioMax = d;
  if (d > 0) audioMism++;
}
console.log(`audio: drained=${outPos}/${refStream.length} maxDiff=${audioMax.toExponential(3)} mismatches=${audioMism}`);

// ---- 2. snapshot fidelity -------------------------------------------------
const liveEngine = makeRunning(ENGINE_8_CYL);
const liveSampler = new Sampler();
const liveSynth = new Synth();
const liveSS = new Float32Array(SYNTH_BUFFER_SIZE);
const packer = new SnapshotPacker(liveEngine.nodes.length, ENGINE_8_CYL.num_eplenums);

const dispEngine = buildEngine(ENGINE_8_CYL);
dispEngine.reset(); dispEngine.enableCfd(false); dispEngine.use_convolution = true;
const dispSampler = new Sampler();

let lastSnap: ReturnType<SnapshotPacker["pack"]> | null = null;
for (let b = 0; b < N; b++) {
  liveSynth.clear();
  liveEngine.run(makeEt(), liveSampler, liveSynth, 0, liveSS);
  if ((b & 1) === 0) {
    lastSnap = packer.pack(0, liveEngine, liveSampler, liveSS, waveTable,
      { fluidsMs: 0, kinematicsMs: 0, thermoMs: 0, synthMs: 0, waveMs: 0 }, prod.fill());
    // emulate structured clone (decouple from packer scratch) before applying
    const cloned = structuredClone(lastSnap);
    applySnapshot(cloned, dispEngine, dispSampler, waveTable);
  }
}
// Final sync: snapshots are periodic, so the display lags the live engine by up
// to SNAPSHOT_EVERY_BUFFERS. Take one more snapshot of the current live state and
// apply it, then the two must agree exactly.
lastSnap = packer.pack(0, liveEngine, liveSampler, liveSS, waveTable,
  { fluidsMs: 0, kinematicsMs: 0, thermoMs: 0, synthMs: 0, waveMs: 0 }, 0);
applySnapshot(structuredClone(lastSnap), dispEngine, dispSampler, waveTable);

// Compare renderable per-node fields.
let nodeErr = 0;
for (let i = 0; i < liveEngine.nodes.length; i++) {
  const a = liveEngine.nodes[i], d = dispEngine.nodes[i];
  if (Math.abs(a.chamber.nozzle_open_ratio - d.chamber.nozzle_open_ratio) > 1e-6) nodeErr++;
  if (a.chamber.flow_cycles !== d.chamber.flow_cycles) nodeErr++;
  if (a.chamber.should_panic !== d.chamber.should_panic) nodeErr++;
  if (a.is_selected !== d.is_selected) nodeErr++;
  if (a.is_next_selected !== d.is_next_selected) nodeErr++;
}
const omegaErr = Math.abs(liveEngine.crankshaft.angular_velocity_r_per_s - dispEngine.crankshaft.angular_velocity_r_per_s);
const thetaErr = Math.abs(liveEngine.crankshaft.theta_r - dispEngine.crankshaft.theta_r);

// Compare sampler size/channel_index and that downsampled values match render's own downsample.
const sizeErr = lastSnap ? (dispSampler.size !== lastSnap.size ? 1 : 0) : 1;
const ciErr = dispSampler.channel_index !== Math.min(liveSampler.channel_index, 8) ? 1 : 0;
let sampValErr = 0;
if (lastSnap) {
  const N2 = lastSnap.size;
  for (let ch = 0; ch < lastSnap.channelIndex; ch++) {
    for (let name = 0; name < SAMPLE_NAME_E_SIZE; name++) {
      const base = ((ch * SAMPLE_NAME_E_SIZE) + name) * MAX_SAMPLES;
      const sbase = ((ch * SAMPLE_NAME_E_SIZE) + name) * N2;
      for (let i = 0; i < N2; i++) {
        if (dispSampler.channel[base + i] !== lastSnap.channel[sbase + i]) sampValErr++;
      }
    }
  }
}

console.log(
  `snapshot: nodeFieldErrors=${nodeErr} omegaErr=${omegaErr.toExponential(2)} thetaErr=${thetaErr.toExponential(2)} ` +
  `sizeErr=${sizeErr} channelIdxErr=${ciErr} samplerValueErrors=${sampValErr}`,
);

const ok = audioMism === 0 && outPos === refStream.length && nodeErr === 0 && omegaErr < 1e-9 && sizeErr === 0 && ciErr === 0 && sampValErr === 0;
console.log(ok ? "INTEGRATION OK" : "INTEGRATION FAILED");
