// One-dimensional (pipe) CFD solver core (ported from wave_s.h). A local
// Lax-Friedrichs (Rusanov) flux on the Euler equations with subsonic boundaries.
//
// Extracted from wave.ts so a dedicated wave worker can run a pipe's solve on its
// own thread (mirroring the native build, which runs each eplenum's solver on a
// separate C thread). solvePipeInto() advances one 800-sample buffer.

import { AUDIO_SAMPLE_RATE_HZ, SYNTH_BUFFER_SIZE } from "./constants";
import { AMBIENT_STATIC_DENSITY_KG_PER_M3, AMBIENT_STATIC_PRESSURE_PA } from "./gas";
import { LowpassFilter3 } from "./filters";

export const WAVE_CELLS = 128;
export const WAVE_SIGNAL_CELL_INDEX = 0;
export const WAVE_LAST_INTERIOR_CELL_INDEX = WAVE_CELLS - 2; // 126
export const WAVE_AMBIENT_CELL_INDEX = WAVE_CELLS - 1; // 127
export const WAVE_SUBSTEPS = 8;
export const FLUX_CELLS = WAVE_CELLS + 1; // 129
export const WAVE_MAX_WAVES = 4;
export const WAVE_SAMPLE_RATE_HZ = AUDIO_SAMPLE_RATE_HZ * WAVE_SUBSTEPS;
export const WAVE_GAMMA = 1.31;
export const WAVE_DT_S = 1.0 / WAVE_SAMPLE_RATE_HZ;

const G1 = WAVE_GAMMA - 1.0; // gamma - 1
const AMBIENT_R = AMBIENT_STATIC_DENSITY_KG_PER_M3;
const AMBIENT_P = AMBIENT_STATIC_PRESSURE_PA;

export class WaveSolver {
  primR = new Float64Array(WAVE_CELLS);
  primU = new Float64Array(WAVE_CELLS);
  primP = new Float64Array(WAVE_CELLS);
  consR = new Float64Array(WAVE_CELLS);
  consM = new Float64Array(WAVE_CELLS);
  consE = new Float64Array(WAVE_CELLS);
  fluxR = new Float64Array(FLUX_CELLS);
  fluxM = new Float64Array(FLUX_CELLS);
  fluxE = new Float64Array(FLUX_CELLS);
  uFilter = new LowpassFilter3();
  velocityLowPassCutoffFrequencyHz = 0;
  gradientSPerM = 0;
  micPositionRatio = 0;
  maxWaveSpeedMPerS = 0;
  pipeLengthM = 0;

  setCell(i: number, r: number, u: number, p: number): void {
    this.primR[i] = r;
    this.primU[i] = u;
    this.primP[i] = p;
    this.consR[i] = r;
    this.consM[i] = r * u;
    this.consE[i] = p / G1 + 0.5 * r * u * u;
  }

  // Reset to ambient still air.
  reset(): void {
    for (let i = 0; i < WAVE_CELLS; i++) this.setCell(i, AMBIENT_R, 0, AMBIENT_P);
    this.uFilter = new LowpassFilter3();
  }
}

function computeFlux(s: WaveSolver): void {
  const { primR: pR, primU: pU, primP: pP } = s;
  setFlux(s, 0, pR[0], pU[0], pP[0], pR[0], pU[0], pP[0]);
  const z = WAVE_AMBIENT_CELL_INDEX;
  setFlux(s, WAVE_CELLS, pR[z], pU[z], pP[z], pR[z], pU[z], pP[z]);
  for (let i = 1; i < WAVE_CELLS; i++) {
    setFlux(s, i, pR[i - 1], pU[i - 1], pP[i - 1], pR[i], pU[i], pP[i]);
  }
}

function setFlux(
  s: WaveSolver,
  out: number,
  qlR: number, qlU: number, qlP: number,
  qrR: number, qrU: number, qrP: number,
): void {
  const ulM = qlR * qlU;
  const ulE = qlP / G1 + 0.5 * qlR * qlU * qlU;
  const urM = qrR * qrU;
  const urE = qrP / G1 + 0.5 * qrR * qrU * qrU;
  const cl = Math.sqrt((WAVE_GAMMA * qlP) / qlR);
  const cr = Math.sqrt((WAVE_GAMMA * qrP) / qrR);
  const a = Math.max(Math.abs(qlU) + cl, Math.abs(qrU) + cr);
  s.fluxR[out] = 0.5 * (ulM + urM) - 0.5 * a * (qrR - qlR);
  s.fluxM[out] = 0.5 * (ulM * qlU + qlP + urM * qrU + qrP) - 0.5 * a * (urM - ulM);
  s.fluxE[out] = 0.5 * ((ulE + qlP) * qlU + (urE + qrP) * qrU) - 0.5 * a * (urE - ulE);
}

function updateState(s: WaveSolver): void {
  const g = s.gradientSPerM;
  const { consR: cR, consM: cM, consE: cE, primR: pR, primU: pU, primP: pP, fluxR: fR, fluxM: fM, fluxE: fE } = s;
  for (let i = 1; i < WAVE_AMBIENT_CELL_INDEX; i++) {
    const dr = g * (fR[i + 1] - fR[i]);
    const dm = g * (fM[i + 1] - fM[i]);
    const de = g * (fE[i + 1] - fE[i]);
    const r = cR[i] - dr;
    const m = cM[i] - dm;
    cR[i] = r;
    cM[i] = m;
    cE[i] = cE[i] - de;
    const u = m / r;
    pR[i] = r;
    pU[i] = u;
    pP[i] = (cE[i] - 0.5 * m * u) * G1;
  }
}

function calcSignalCell(s: WaveSolver, sr: number, su: number, sp: number): void {
  s.setCell(
    WAVE_SIGNAL_CELL_INDEX,
    sr,
    s.uFilter.process(s.velocityLowPassCutoffFrequencyHz, su),
    sp,
  );
}

function calcAmbientCell(s: WaveSolver): void {
  const li = WAVE_LAST_INTERIOR_CELL_INDEX;
  const r = s.primR[li];
  const p = s.primP[li];
  s.setCell(
    WAVE_AMBIENT_CELL_INDEX,
    r * Math.pow(AMBIENT_P / p, 1.0 / WAVE_GAMMA),
    s.primU[li],
    AMBIENT_P,
  );
}

function stepSolver(s: WaveSolver, sr: number, su: number, sp: number): void {
  for (let i = 0; i < WAVE_SUBSTEPS; i++) {
    calcSignalCell(s, sr, su, sp);
    calcAmbientCell(s);
    computeFlux(s);
    updateState(s);
  }
}

function sampleSolver(s: WaveSolver): number {
  const idx = Math.floor(WAVE_AMBIENT_CELL_INDEX * s.micPositionRatio);
  return s.primP[idx];
}

// Advance one 800-sample buffer. `d1` holds the staged (r,u,p) triple per sample;
// `sub` receives the sampled pipe pressure per sample. Identical math whether run
// inline (wave.ts) or on a wave worker.
export function solvePipeInto(
  s: WaveSolver,
  d1: Float64Array,
  sub: Float64Array,
  useCfd: boolean,
  pipeLengthM: number,
  micPositionRatio: number,
  velocityLowPassCutoffFrequencyHz: number,
): void {
  const dx = pipeLengthM / WAVE_CELLS;
  s.maxWaveSpeedMPerS = dx / WAVE_DT_S;
  s.gradientSPerM = WAVE_DT_S / dx;
  s.pipeLengthM = pipeLengthM;
  s.micPositionRatio = micPositionRatio;
  s.velocityLowPassCutoffFrequencyHz = velocityLowPassCutoffFrequencyHz;
  if (useCfd) {
    for (let i = 0; i < SYNTH_BUFFER_SIZE; i++) {
      const o = i * 3;
      stepSolver(s, d1[o], d1[o + 1], d1[o + 2]);
      sub[i] = sampleSolver(s);
    }
  } else {
    for (let i = 0; i < SYNTH_BUFFER_SIZE; i++) {
      sub[i] = d1[i * 3 + 2];
    }
  }
}
