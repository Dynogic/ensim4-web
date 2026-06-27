// Verifies the parallel (worker-per-pipe) CFD path against the serial path:
//   1. bit-for-bit identical audio with CFD ON
//   2. wall-clock speedup
// Exercises the real SAB handshake + runWavePipe on Node worker_threads. The
// driver runs in a worker because Atomics.wait is illegal on Node's main thread.

import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";

import { buildEngine, ENGINE_8_CYL } from "./src/sim/blueprints.ts";
import { precomputeCp } from "./src/sim/gamma.ts";
import { Sampler } from "./src/sim/sampler.ts";
import { Synth } from "./src/sim/synth.ts";
import { type EngineTime } from "./src/sim/engine.ts";
import { SYNTH_BUFFER_SIZE } from "./src/sim/constants.ts";
import { waveTable } from "./src/sim/wave.ts";
import { createWavePipeSAB, WavePipeClient, runWavePipe } from "./src/sim/wave-pipe.ts";

const registerPath = fileURLToPath(new URL("./bench-register.mjs", import.meta.url));
const thisFile = fileURLToPath(import.meta.url);
const EXECARGV = ["--experimental-strip-types", "--import", registerPath];
const now = () => Number(process.hrtime.bigint()) / 1e6;

function makeEt(): EngineTime {
  return { getTicksMs: now, fluids_time_ms: 0, kinematics_time_ms: 0, thermo_time_ms: 0, synth_time_ms: 0, wave_time_ms: 0 };
}
function makeRunning() {
  const e = buildEngine(ENGINE_8_CYL);
  e.reset();
  e.enableCfd(true);          // CFD ON for this test
  e.use_convolution = true;
  e.starter.is_on = true;
  e.can_ignite = true;
  e.throttle_open_ratio = 1.0;
  return e;
}
function runN(e: ReturnType<typeof makeRunning>, sampler: Sampler, synth: Synth, ss: Float32Array, n: number, out?: Float32Array) {
  for (let b = 0; b < n; b++) {
    synth.clear();
    e.run(makeEt(), sampler, synth, 0, ss);
    if (out) out.set(synth.value, b * SYNTH_BUFFER_SIZE);
  }
}

if (!isMainThread && workerData?.role === "pipe") {
  // Pipe worker: service solves forever.
  runWavePipe(workerData.sab as SharedArrayBuffer);
} else if (!isMainThread && workerData?.role === "driver") {
  precomputeCp();
  const N = 250;
  const WARM = 60;
  const numEpl = ENGINE_8_CYL.num_eplenums;

  // --- serial reference (no clients attached) ---
  const eS = makeRunning();
  const serial = new Float32Array(N * SYNTH_BUFFER_SIZE);
  runN(eS, new Sampler(), new Synth(), new Float32Array(SYNTH_BUFFER_SIZE), WARM);
  // fresh run from reset for the captured reference
  const eS2 = makeRunning();
  const tS0 = now();
  runN(eS2, new Sampler(), new Synth(), new Float32Array(SYNTH_BUFFER_SIZE), N, serial);
  const serialMs = now() - tS0;

  // --- attach pipe workers and run the parallel path ---
  const sabs = Array.from({ length: numEpl }, () => createWavePipeSAB());
  const pipes = sabs.map((sab) => new Worker(thisFile, { workerData: { role: "pipe", sab }, execArgv: EXECARGV }));
  for (let k = 0; k < numEpl; k++) waveTable.attachParallel(k, new WavePipeClient(sabs[k]));

  const eP = makeRunning(); // reset() -> waveTable.resetAll() -> requestReset on clients
  const parallel = new Float32Array(N * SYNTH_BUFFER_SIZE);
  runN(eP, new Sampler(), new Synth(), new Float32Array(SYNTH_BUFFER_SIZE), WARM);
  const eP2 = makeRunning();
  const tP0 = now();
  runN(eP2, new Sampler(), new Synth(), new Float32Array(SYNTH_BUFFER_SIZE), N, parallel);
  const parallelMs = now() - tP0;

  for (const p of pipes) await p.terminate();

  let maxDiff = 0, mism = 0;
  for (let i = 0; i < serial.length; i++) {
    const d = Math.abs(serial[i] - parallel[i]);
    if (d > maxDiff) maxDiff = d;
    if (d !== 0) mism++;
  }
  const bufMs = (SYNTH_BUFFER_SIZE / 48000) * 1000;
  parentPort!.postMessage({
    maxDiff, mism,
    serialRT: (N * bufMs) / serialMs,
    parallelRT: (N * bufMs) / parallelMs,
    speedup: serialMs / parallelMs,
    ok: maxDiff === 0,
  });
} else if (isMainThread) {
  const driver = new Worker(thisFile, { workerData: { role: "driver" }, execArgv: EXECARGV });
  driver.on("message", (m: any) => {
    console.log(`CFD parallel-vs-serial: maxDiff=${m.maxDiff} mismatches=${m.mism}`);
    console.log(`  serial   CFD-on: ${m.serialRT.toFixed(2)}x realtime`);
    console.log(`  parallel CFD-on: ${m.parallelRT.toFixed(2)}x realtime   (speedup ${m.speedup.toFixed(2)}x)`);
    console.log(m.ok ? "CFD PARALLEL OK (bit-identical)" : "CFD PARALLEL FAILED");
    driver.terminate();
    process.exit(m.ok ? 0 : 1);
  });
  driver.on("error", (e) => { console.error(e); process.exit(1); });
}
