// Headless benchmark for the simulation hot path. Mirrors the per-buffer work
// the browser does in frame(): engine.run() producing 800-sample buffers.
// Real-time requires 60 buffers/sec (48000 samples/sec).

import { buildEngine, ENGINE_8_CYL, ENGINE_3_CYL, type CylConfig } from "./src/sim/blueprints.ts";
import { precomputeCp } from "./src/sim/gamma.ts";
import { Sampler } from "./src/sim/sampler.ts";
import { Synth } from "./src/sim/synth.ts";
import { type EngineTime } from "./src/sim/engine.ts";
import { SYNTH_BUFFER_SIZE } from "./src/sim/constants.ts";

const now = () => Number(process.hrtime.bigint()) / 1e6;

function runBench(cfg: CylConfig, label: string, opts: { cfd: boolean; convo: boolean }, buffers: number) {
  precomputeCp();
  const engine = buildEngine(cfg);
  engine.reset();
  engine.enableCfd(opts.cfd);
  engine.use_convolution = opts.convo;
  // Simulate a running engine so combustion / flow are fully exercised.
  engine.starter.is_on = true;
  engine.can_ignite = true;
  engine.throttle_open_ratio = 1.0;

  const sampler = new Sampler();
  const synth = new Synth();
  const samplerSynth = new Float32Array(SYNTH_BUFFER_SIZE);
  const et: EngineTime = {
    getTicksMs: now,
    fluids_time_ms: 0, kinematics_time_ms: 0, thermo_time_ms: 0,
    synth_time_ms: 0, wave_time_ms: 0,
  };

  // Warm up (let JIT compile + engine spin up).
  for (let i = 0; i < 120; i++) {
    synth.clear();
    engine.run(et, sampler, synth, 0, samplerSynth);
  }

  et.fluids_time_ms = 0; et.kinematics_time_ms = 0; et.thermo_time_ms = 0;
  et.synth_time_ms = 0; et.wave_time_ms = 0;

  const t0 = now();
  for (let i = 0; i < buffers; i++) {
    synth.clear();
    engine.run(et, sampler, synth, 0, samplerSynth);
  }
  const t1 = now();

  const ms = t1 - t0;
  const bufPerSec = (buffers / ms) * 1000;
  const realtimeX = bufPerSec / 60;
  const usPerBuffer = (ms / buffers) * 1000;
  const rpm = (engine.crankshaft.angular_velocity_r_per_s * 60) / (2 * Math.PI);
  console.log(
    `${label.padEnd(34)} ${ms.toFixed(0).padStart(6)}ms  ` +
    `${usPerBuffer.toFixed(0).padStart(5)}us/buf  ` +
    `${bufPerSec.toFixed(0).padStart(5)} buf/s  ` +
    `${realtimeX.toFixed(2).padStart(6)}x RT   rpm=${rpm.toFixed(0)}`,
  );
  return { realtimeX, et: { ...et } };
}

const N = 1200; // 20 seconds of audio
console.log(`# ${N} buffers each (= ${(N / 60).toFixed(0)}s of audio). Need >=1.00x RT.\n`);
console.log("config                              time   per-buf   rate    realtime");
runBench(ENGINE_8_CYL, "8cyl  cfd=off convo=off", { cfd: false, convo: false }, N);
runBench(ENGINE_8_CYL, "8cyl  cfd=off convo=on ", { cfd: false, convo: true }, N);
runBench(ENGINE_8_CYL, "8cyl  cfd=on  convo=on ", { cfd: true, convo: true }, N);
console.log();
runBench(ENGINE_3_CYL, "3cyl  cfd=off convo=on ", { cfd: false, convo: true }, N);
runBench(ENGINE_3_CYL, "3cyl  cfd=on  convo=on ", { cfd: true, convo: true }, N);

// Attribute time across subsystems for the default web config (cfd off, convo on).
console.log("\n# subsystem breakdown (8cyl cfd=off convo=on, accumulated ms over run):");
const r = runBench(ENGINE_8_CYL, "8cyl  breakdown", { cfd: false, convo: true }, N);
const e = r.et;
console.log(
  `  fluids(flow)=${e.fluids_time_ms.toFixed(0)}ms  ` +
  `kinematics=${e.kinematics_time_ms.toFixed(0)}ms  ` +
  `thermo=${e.thermo_time_ms.toFixed(0)}ms  ` +
  `synth=${e.synth_time_ms.toFixed(0)}ms  ` +
  `wave(total)=${e.wave_time_ms.toFixed(0)}ms`,
);
