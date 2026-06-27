// DSP filters (ported from lowpass_filter_s.h, highpass_filter_s.h,
// convo_filter_s.h).

import { DT_S, PI_R } from "./constants";
import impulseRaw from "./convo-impulse.json";

export const CONVO_IMPULSE: Float64Array = Float64Array.from(impulseRaw as number[]);

// First-order RC low-pass.
export class LowpassFilter {
  last = 0;
  process(cutoffHz: number, sample: number): number {
    const rc = 1.0 / (2.0 * PI_R * cutoffHz);
    const alpha = DT_S / (rc + DT_S);
    const out = alpha * sample + (1.0 - alpha) * this.last;
    this.last = out;
    return out;
  }
}

// Cascaded 3x low-pass (used by the wave solver velocity filter).
export class LowpassFilter3 {
  a = new LowpassFilter();
  b = new LowpassFilter();
  c = new LowpassFilter();
  process(cutoffHz: number, sample: number): number {
    let s = this.a.process(cutoffHz, sample);
    s = this.b.process(cutoffHz, s);
    s = this.c.process(cutoffHz, s);
    return s;
  }
}

// First-order RC high-pass (also used as the synth DC blocker).
export class HighpassFilter {
  prevInput = 0;
  prevOutput = 0;
  process(cutoffHz: number, sample: number): number {
    const rc = 1.0 / (2.0 * PI_R * cutoffHz);
    const alpha = rc / (rc + DT_S);
    const out = alpha * (this.prevOutput + sample - this.prevInput);
    this.prevInput = sample;
    this.prevOutput = out;
    return out;
  }
}

// Direct-form FIR convolution with a circular buffer.
export class ConvoFilter {
  buffer: Float64Array;
  index = 0;
  constructor(impulse: Float64Array) {
    this.buffer = new Float64Array(impulse.length);
  }
  process(sample: number, impulse: Float64Array = CONVO_IMPULSE): number {
    const buf = this.buffer;
    const imp = impulse;
    const y = imp.length;
    buf[this.index] = sample;
    let result = 0;
    const x = y - this.index;
    for (let i = 0; i < x; i++) result += imp[i] * buf[i + this.index];
    for (let i = x; i < y; i++) result += imp[i] * buf[i - x];
    this.index = (this.index - 1 + y) % y;
    return result;
  }
}
