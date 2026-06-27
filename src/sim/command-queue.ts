// Lock-free SPSC command queue (main thread -> sim worker) in a SharedArrayBuffer.
//
// The worker runs a dedicated Atomics.wait-paced loop and never returns to its
// event loop, so it cannot receive runtime input via onmessage. Instead the main
// thread pushes small (op, arg) commands here and the worker drains them each
// iteration. Commands are rare (key presses / clicks) so a tiny ring suffices.

export const OP = {
  STARTER: 1,     // arg: 0|1
  IGNITE: 2,      // toggle
  THROTTLE: 3,    // arg: 0=no 1=low 2=mid 3=high
  CFD: 4,         // toggle
  CONVO: 5,       // toggle
  PLOTFILTER: 6,  // toggle
  SELECT: 7,      // arg: 0=pistons 1=intakes 2=exhausts 3=clear 4=next
  TOGGLE_NODE: 8, // arg: node index
  SWITCH: 9,      // arg: 0=8cyl 1=3cyl
} as const;

const HEAD = 0;
const TAIL = 1;
const HDR = 2;
const CAP = 64;

export function createCommandSAB(): SharedArrayBuffer {
  return new SharedArrayBuffer((HDR + CAP * 2) * 4);
}

export class CommandWriter {
  private i32: Int32Array;
  constructor(sab: SharedArrayBuffer) {
    this.i32 = new Int32Array(sab);
  }
  push(op: number, arg = 0): void {
    const t = Atomics.load(this.i32, TAIL);
    const head = Atomics.load(this.i32, HEAD);
    if (t - head >= CAP) return; // queue full: drop (commands are idempotent-ish)
    const slot = HDR + (t % CAP) * 2;
    this.i32[slot] = op;
    this.i32[slot + 1] = arg;
    Atomics.store(this.i32, TAIL, t + 1);
  }
}

export class CommandReader {
  private i32: Int32Array;
  constructor(sab: SharedArrayBuffer) {
    this.i32 = new Int32Array(sab);
  }
  drain(apply: (op: number, arg: number) => void): void {
    let h = Atomics.load(this.i32, HEAD);
    const t = Atomics.load(this.i32, TAIL);
    while (h !== t) {
      const slot = HDR + (h % CAP) * 2;
      apply(this.i32[slot], this.i32[slot + 1]);
      h++;
    }
    Atomics.store(this.i32, HEAD, h);
  }
}
