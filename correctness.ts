// Self-contained determinism + sanity check for the simulator.
//
// The physics is deterministic, so two runs with identical inputs must produce
// bit-identical audio. This also catches NaN/Inf blow-ups and confirms the
// engine actually accelerates under combustion. Run with the bench loader:
//
//   node --import ./bench-register.mjs correctness.ts

import {
  buildEngineFor, ALL_ENGINES, type CylConfig,
} from "./src/sim/blueprints.ts";
import { precomputeCp } from "./src/sim/gamma.ts";
import { Sampler } from "./src/sim/sampler.ts";
import { Synth } from "./src/sim/synth.ts";
import { SYNTH_BUFFER_SIZE } from "./src/sim/constants.ts";
import type { EngineTime } from "./src/sim/engine.ts";

const now = () => 0;
const makeEt = (): EngineTime => ({
  getTicksMs: now,
  fluids_time_ms: 0, kinematics_time_ms: 0, thermo_time_ms: 0,
  synth_time_ms: 0, wave_time_ms: 0,
});

function run(cfg: CylConfig, cfd: boolean, buffers: number) {
  const e = buildEngineFor(cfg);
  e.reset();
  e.enableCfd(cfd);
  e.use_convolution = true;
  e.starter.is_on = true;
  e.can_ignite = true;
  e.throttle_open_ratio = 1.0;
  const sampler = new Sampler();
  const synth = new Synth();
  const ss = new Float32Array(SYNTH_BUFFER_SIZE);
  const out = new Float32Array(buffers * SYNTH_BUFFER_SIZE);
  for (let b = 0; b < buffers; b++) {
    synth.clear();
    e.run(makeEt(), sampler, synth, 0, ss);
    out.set(synth.value, b * SYNTH_BUFFER_SIZE);
  }
  return { out, omega: e.crankshaft.angular_velocity_r_per_s };
}

precomputeCp();
let allOk = true;

// Optional CLI filter: `node ... correctness.ts Stirling` runs only engines
// whose name contains "Stirling". Multiple substrings = OR. No args = all.
const filters = process.argv.slice(2).map((s) => s.toLowerCase());
const matches = (name: string) =>
  filters.length === 0 || filters.some((f) => name.toLowerCase().includes(f));

const ALL_CFGS = ALL_ENGINES;

for (const cfg of ALL_CFGS) {
  if (!matches(cfg.name)) continue;
  for (const cfd of [false, true]) {
    const B = cfd ? 20 : 40; // CFD on is heavier; fewer buffers
    const a = run(cfg, cfd, B);
    const b = run(cfg, cfd, B);
    let maxDiff = 0;
    let nan = false;
    let peak = 0;
    for (let i = 0; i < a.out.length; i++) {
      const d = Math.abs(a.out[i] - b.out[i]);
      if (d > maxDiff) maxDiff = d;
      if (Number.isNaN(a.out[i]) || Number.isNaN(b.out[i])) nan = true;
      const p = Math.abs(a.out[i]);
      if (p > peak) peak = p;
    }
    const ok = !nan && maxDiff === 0 && a.omega > 1.0;
    allOk = allOk && ok;
    console.log(
      `${cfg.name.padEnd(22)} cfd=${cfd ? "on " : "off"}  detMaxDiff=${maxDiff}  ` +
      `nan=${nan}  peak=${peak.toFixed(3)}  omega=${a.omega.toFixed(1)}  ${ok ? "OK" : "FAIL"}`,
    );
  }
}

console.log(allOk ? "\nALL OK" : "\nFAILURES DETECTED");
if (!allOk) process.exit(1);
