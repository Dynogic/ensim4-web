// Lock-free single-producer/single-consumer audio ring in a SharedArrayBuffer.
//
// Producer: the simulation Web Worker (writes 800-sample buffers).
// Consumer: the AudioWorklet's process() (drains 128-sample blocks on the audio
//           thread). The worklet is a plain JS file that cannot import this
//           module, so it is handed RING_LAYOUT via processorOptions and mirrors
//           the same arithmetic -- keep the two in sync.
//
// Indices live in an Int32 header and are kept in [0, 2*CAP) so that "full"
// (fill == CAP) is distinguishable from "empty" (fill == 0); the byte position
// is index % CAP. Only the producer writes WRITE; only the consumer writes READ;
// each is published with Atomics so the other thread sees a coherent value.

export const RING_CAPACITY = 8192; // samples, ~170 ms @ 48 kHz
const HEADER_I32 = 8; // 32-byte header keeps the Float32 region 4-byte aligned
const WRITE = 0; // absolute samples written, in [0, 2*CAP)
const READ = 1; // absolute samples read, in [0, 2*CAP)
const MOD = 2 * RING_CAPACITY;

export const RING_LAYOUT = {
  capacity: RING_CAPACITY,
  headerI32: HEADER_I32,
  write: WRITE,
  read: READ,
  mod: MOD,
  dataByteOffset: HEADER_I32 * 4,
} as const;

export function createRingSAB(): SharedArrayBuffer {
  return new SharedArrayBuffer(HEADER_I32 * 4 + RING_CAPACITY * 4);
}

export class RingProducer {
  private hdr: Int32Array;
  private data: Float32Array;
  constructor(sab: SharedArrayBuffer) {
    this.hdr = new Int32Array(sab, 0, HEADER_I32);
    this.data = new Float32Array(sab, HEADER_I32 * 4, RING_CAPACITY);
  }
  fill(): number {
    return (Atomics.load(this.hdr, WRITE) - Atomics.load(this.hdr, READ) + MOD) % MOD;
  }
  free(): number {
    return RING_CAPACITY - this.fill();
  }
  // Write n samples from src[0..n). Returns false if there isn't room.
  write(src: Float32Array, n: number): boolean {
    if (this.free() < n) return false;
    const w = Atomics.load(this.hdr, WRITE);
    const data = this.data;
    const cap = RING_CAPACITY;
    let pos = w % cap;
    for (let i = 0; i < n; i++) {
      data[pos] = src[i];
      pos++;
      if (pos === cap) pos = 0;
    }
    Atomics.store(this.hdr, WRITE, (w + n) % MOD);
    return true;
  }
  // Block (off-main-thread only) until the consumer frees space or timeout ms
  // elapse. Returns the free sample count observed on exit.
  waitForSpace(minFree: number, timeoutMs: number): number {
    while (this.free() < minFree) {
      const r = Atomics.load(this.hdr, READ);
      const res = Atomics.wait(this.hdr, READ, r, timeoutMs);
      if (res === "timed-out") return this.free();
    }
    return this.free();
  }
}

// Consumer mirror used by the (Node) tests. The browser AudioWorklet inlines the
// equivalent logic from RING_LAYOUT.
export class RingConsumer {
  private hdr: Int32Array;
  private data: Float32Array;
  constructor(sab: SharedArrayBuffer) {
    this.hdr = new Int32Array(sab, 0, HEADER_I32);
    this.data = new Float32Array(sab, HEADER_I32 * 4, RING_CAPACITY);
  }
  fill(): number {
    return (Atomics.load(this.hdr, WRITE) - Atomics.load(this.hdr, READ) + MOD) % MOD;
  }
  // Read up to out.length samples into out, zero-filling on underrun. Returns
  // the number of real samples read.
  read(out: Float32Array): number {
    const n = out.length;
    const r = Atomics.load(this.hdr, READ);
    const avail = this.fill();
    const take = avail < n ? avail : n;
    const data = this.data;
    const cap = RING_CAPACITY;
    let pos = r % cap;
    for (let i = 0; i < take; i++) {
      out[i] = data[pos];
      pos++;
      if (pos === cap) pos = 0;
    }
    for (let i = take; i < n; i++) out[i] = 0;
    if (take > 0) {
      Atomics.store(this.hdr, READ, (r + take) % MOD);
      Atomics.notify(this.hdr, READ, 1);
    }
    return take;
  }
}
