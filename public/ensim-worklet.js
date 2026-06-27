// AudioWorklet processor. Two modes:
//
//  SAB mode (preferred): the sim Web Worker writes audio into a SharedArrayBuffer
//  ring; process() drains it on the audio thread doing almost no work, so audio
//  is immune to main-thread jank. Layout/constants come in via processorOptions
//  and must match src/sim/audio-ring.ts.
//
//  Legacy mode (fallback when the page isn't cross-origin isolated): the main
//  thread posts 800-sample buffers; we keep a local ring and drain it. This
//  mirrors the original behavior.

class EnsimProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    if (o.sab) {
      // SAB mode
      this.mode = "sab";
      this.cap = o.capacity;
      this.mod = o.mod;
      this.wIdx = o.write;
      this.rIdx = o.read;
      this.hdr = new Int32Array(o.sab, 0, o.headerI32);
      this.data = new Float32Array(o.sab, o.dataByteOffset, o.capacity);
    } else {
      // Legacy postMessage ring mode
      this.mode = "legacy";
      const RING_SIZE = 8192;
      this.ring = new Float32Array(RING_SIZE);
      this.size = RING_SIZE;
      this.write = 0;
      this.read = 0;
      this.fill = 0;
      this.port.onmessage = (e) => {
        const data = e.data;
        const n = data.length;
        for (let i = 0; i < n; i++) {
          this.ring[this.write] = data[i];
          this.write = (this.write + 1) % RING_SIZE;
          if (this.fill >= RING_SIZE) this.read = (this.read + 1) % RING_SIZE;
          else this.fill++;
        }
      };
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const n = out.length;

    if (this.mode === "sab") {
      const hdr = this.hdr, data = this.data, cap = this.cap, mod = this.mod;
      const r = Atomics.load(hdr, this.rIdx);
      const w = Atomics.load(hdr, this.wIdx);
      const avail = (w - r + mod) % mod;
      const take = avail < n ? avail : n;
      let pos = r % cap;
      let i = 0;
      for (; i < take; i++) { out[i] = data[pos]; pos++; if (pos === cap) pos = 0; }
      for (; i < n; i++) out[i] = 0;
      if (take > 0) {
        Atomics.store(hdr, this.rIdx, (r + take) % mod);
        Atomics.notify(hdr, this.rIdx, 1);
      }
      return true;
    }

    // legacy
    const ring = this.ring, size = this.size;
    let i = 0;
    while (i < n && this.fill > 0) {
      out[i++] = ring[this.read];
      this.read = (this.read + 1) % size;
      this.fill--;
    }
    while (i < n) out[i++] = 0;
    this.port.postMessage(this.fill);
    return true;
  }
}

registerProcessor("ensim-processor", EnsimProcessor);
