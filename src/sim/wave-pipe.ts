// SharedArrayBuffer channel between the sim worker and one wave (pipe) worker.
//
// Per audio buffer the sim worker stages the pipe's input (the r,u,p triple per
// sample), hands it off, runs the rest of the simulation, then joins. The wave
// worker solves the 1-D CFD for that pipe on its own thread in the meantime --
// mirroring the native build, which runs each eplenum's solver on a C thread.
//
// Handshake uses monotonic counters (REQ written only by the sim worker, DONE
// only by the wave worker) so it is race-free with one buffer outstanding.

import { SYNTH_BUFFER_SIZE } from "./constants";
import { WaveSolver, solvePipeInto, WAVE_CELLS } from "./wave-solver";

const CTRL_I32 = 8;          // 32-byte header keeps the Float64 regions aligned
const REQ = 0;
const DONE = 1;

const PARAMS_F64 = 8;        // [pipeLen, micPos, cutoff, useCfd, reset, ...]
const INPUT_F64 = SYNTH_BUFFER_SIZE * 3;
const SUB_F64 = SYNTH_BUFFER_SIZE;
const PRIMP_F64 = WAVE_CELLS;

const PARAMS_OFF = CTRL_I32 * 4;
const INPUT_OFF = PARAMS_OFF + PARAMS_F64 * 8;
const SUB_OFF = INPUT_OFF + INPUT_F64 * 8;
const PRIMP_OFF = SUB_OFF + SUB_F64 * 8;
const TOTAL_BYTES = PRIMP_OFF + PRIMP_F64 * 8;

const P_PIPELEN = 0;
const P_MICPOS = 1;
const P_CUTOFF = 2;
const P_USECFD = 3;
const P_RESET = 4;

export function createWavePipeSAB(): SharedArrayBuffer {
  return new SharedArrayBuffer(TOTAL_BYTES);
}

// Sim-worker side handle for one pipe.
export class WavePipeClient {
  private ctrl: Int32Array;
  private params: Float64Array;
  readonly inputView: Float64Array;  // staged (r,u,p) per sample; flip() writes here
  readonly subView: Float64Array;    // sampled pipe pressure per sample
  readonly primPView: Float64Array;  // pipe pressure cells, for the visualizer
  private lastReq = 0;
  private pendingReset = true;

  constructor(sab: SharedArrayBuffer) {
    this.ctrl = new Int32Array(sab, 0, CTRL_I32);
    this.params = new Float64Array(sab, PARAMS_OFF, PARAMS_F64);
    this.inputView = new Float64Array(sab, INPUT_OFF, INPUT_F64);
    this.subView = new Float64Array(sab, SUB_OFF, SUB_F64);
    this.primPView = new Float64Array(sab, PRIMP_OFF, PRIMP_F64);
  }

  requestReset(): void {
    this.pendingReset = true;
  }

  // Hand the already-staged inputView to the worker and return immediately.
  dispatch(useCfd: boolean, pipeLengthM: number, micPositionRatio: number, cutoffHz: number): void {
    this.params[P_PIPELEN] = pipeLengthM;
    this.params[P_MICPOS] = micPositionRatio;
    this.params[P_CUTOFF] = cutoffHz;
    this.params[P_USECFD] = useCfd ? 1 : 0;
    this.params[P_RESET] = this.pendingReset ? 1 : 0;
    this.pendingReset = false;
    this.lastReq++;
    Atomics.store(this.ctrl, REQ, this.lastReq);
    Atomics.notify(this.ctrl, REQ, 1);
  }

  // Block until the worker has finished the dispatched buffer.
  join(): void {
    for (;;) {
      const d = Atomics.load(this.ctrl, DONE);
      if (d >= this.lastReq) return;
      Atomics.wait(this.ctrl, DONE, d);
    }
  }
}

// Wave-worker entry: owns a persistent solver and services solve requests until
// the worker is terminated. Never returns.
export function runWavePipe(sab: SharedArrayBuffer): void {
  const ctrl = new Int32Array(sab, 0, CTRL_I32);
  const params = new Float64Array(sab, PARAMS_OFF, PARAMS_F64);
  const input = new Float64Array(sab, INPUT_OFF, INPUT_F64);
  const sub = new Float64Array(sab, SUB_OFF, SUB_F64);
  const primP = new Float64Array(sab, PRIMP_OFF, PRIMP_F64);
  const solver = new WaveSolver();
  solver.reset();
  let localReq = 0;

  for (;;) {
    Atomics.wait(ctrl, REQ, localReq);
    const req = Atomics.load(ctrl, REQ);
    while (localReq < req) {
      if (params[P_RESET] !== 0) solver.reset();
      solvePipeInto(
        solver, input, sub,
        params[P_USECFD] !== 0, params[P_PIPELEN], params[P_MICPOS], params[P_CUTOFF],
      );
      primP.set(solver.primP);
      localReq++;
      Atomics.store(ctrl, DONE, localReq);
      Atomics.notify(ctrl, DONE, 1);
    }
  }
}
