// Exhaust pipe wave handling. Owns the per-pipe staging buffers and the wave
// "table" the engine drives each buffer (flip -> launch -> [sim steps] -> join ->
// sum). The actual 1-D CFD solve lives in wave-solver.ts; when wave-pipe clients
// are attached (SAB mode) each pipe's solve is dispatched to its own worker and
// overlaps the main sim loop, mirroring the native threaded build. Without
// clients (legacy main-thread path) it solves inline.

import { SYNTH_BUFFER_SIZE } from "./constants";
import {
  AMBIENT_STATIC_DENSITY_KG_PER_M3,
  AMBIENT_STATIC_PRESSURE_PA,
} from "./gas";
import {
  WaveSolver, solvePipeInto, WAVE_CELLS, WAVE_DT_S,
} from "./wave-solver";
import { type WavePipeClient } from "./wave-pipe";

export { WAVE_CELLS, WAVE_MAX_WAVES, WAVE_GAMMA, WAVE_SUBSTEPS } from "./wave-solver";

class Wave {
  data0 = new Float64Array(SYNTH_BUFFER_SIZE * 3); // r,u,p per sample (staged)
  data1: Float64Array = new Float64Array(SYNTH_BUFFER_SIZE * 3); // solve input (may be SAB-backed)
  index = 0;
  subBufferPa: Float64Array = new Float64Array(SYNTH_BUFFER_SIZE); // solve output (may be SAB-backed)
  solver = new WaveSolver(); // serial solve + holds display state (primP, scalars)
}

const AMBIENT_R = AMBIENT_STATIC_DENSITY_KG_PER_M3;
const AMBIENT_P = AMBIENT_STATIC_PRESSURE_PA;

export class WaveTable {
  waves: Wave[] = [new Wave(), new Wave(), new Wave(), new Wave()];
  waveBufferPa = new Float64Array(SYNTH_BUFFER_SIZE);
  private clients: (WavePipeClient | null)[] = [null, null, null, null];
  private dispatched: boolean[] = [false, false, false, false];

  // Attach a pipe worker to wave k. Its solve input/output become SAB-backed so
  // flip()/sum() read and write shared memory with zero extra copies.
  attachParallel(k: number, client: WavePipeClient): void {
    this.clients[k] = client;
    this.waves[k].data1 = client.inputView;
    this.waves[k].subBufferPa = client.subView;
  }

  resetAll(): void {
    for (const wave of this.waves) {
      for (let i = 0; i < SYNTH_BUFFER_SIZE; i++) {
        const o = i * 3;
        wave.data0[o] = AMBIENT_R;
        wave.data0[o + 1] = 0;
        wave.data0[o + 2] = AMBIENT_P;
      }
      wave.index = 0;
      wave.solver.reset();
    }
    for (const c of this.clients) if (c) c.requestReset();
  }

  stage(waveIndex: number, r: number, u: number, p: number): void {
    const w = this.waves[waveIndex];
    const o = w.index * 3;
    w.data0[o] = r;
    w.data0[o + 1] = u;
    w.data0[o + 2] = p;
    w.index++;
  }

  flip(waveIndex: number): void {
    const w = this.waves[waveIndex];
    w.data1.set(w.data0); // writes the worker's input SAB when attached
    w.index = 0;
  }

  batch(
    waveIndex: number,
    useCfd: boolean,
    pipeLengthM: number,
    micPositionRatio: number,
    velocityLowPassCutoffFrequencyHz: number,
  ): void {
    const w = this.waves[waveIndex];
    const client = this.clients[waveIndex];
    if (client && useCfd) {
      // Mirror the solver's display scalars so the visualizer stays correct, then
      // hand off; the worker solves while the engine runs its step loop.
      const dx = pipeLengthM / WAVE_CELLS;
      w.solver.maxWaveSpeedMPerS = dx / WAVE_DT_S;
      w.solver.pipeLengthM = pipeLengthM;
      w.solver.micPositionRatio = micPositionRatio;
      client.dispatch(useCfd, pipeLengthM, micPositionRatio, velocityLowPassCutoffFrequencyHz);
      this.dispatched[waveIndex] = true;
    } else {
      solvePipeInto(
        w.solver, w.data1, w.subBufferPa,
        useCfd, pipeLengthM, micPositionRatio, velocityLowPassCutoffFrequencyHz,
      );
      this.dispatched[waveIndex] = false;
    }
  }

  // Wait for a dispatched pipe worker and pull its viz state. No-op for inline
  // solves (already complete).
  join(waveIndex: number): void {
    if (!this.dispatched[waveIndex]) return;
    const client = this.clients[waveIndex]!;
    client.join();
    this.waves[waveIndex].solver.primP.set(client.primPView);
    this.dispatched[waveIndex] = false;
  }

  clearBuffer(): void {
    this.waveBufferPa.fill(0);
  }

  addToBuffer(waveIndex: number): void {
    const sub = this.waves[waveIndex].subBufferPa;
    const dst = this.waveBufferPa;
    for (let i = 0; i < SYNTH_BUFFER_SIZE; i++) {
      dst[i] += sub[i];
    }
  }

  maxWaveSpeedMPerS(i: number): number { return this.waves[i].solver.maxWaveSpeedMPerS; }
  pipeLengthM(i: number): number { return this.waves[i].solver.pipeLengthM; }
  micPositionRatio(i: number): number { return this.waves[i].solver.micPositionRatio; }
  primPView(i: number): Float64Array { return this.waves[i].solver.primP; }

  // Used by the main-thread display copy to mirror the worker's solver scalars
  // (the display WaveTable never runs the solver itself).
  setDisplayScalars(i: number, maxWaveSpeedMPerS: number, pipeLengthM: number, micPositionRatio: number): void {
    const s = this.waves[i].solver;
    s.maxWaveSpeedMPerS = maxWaveSpeedMPerS;
    s.pipeLengthM = pipeLengthM;
    s.micPositionRatio = micPositionRatio;
  }
}

export const waveTable = new WaveTable();
