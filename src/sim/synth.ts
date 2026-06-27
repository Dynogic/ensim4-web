// Audio synth: DC-blocked, optionally convolved, scaled engine pressure -> PCM
// (ported from synth_s.h).

import { SYNTH_BUFFER_SIZE, clamp } from "./constants";
import { ConvoFilter, CONVO_IMPULSE, HighpassFilter } from "./filters";
import type { Crankshaft } from "./mechanical";

const DC_FILTER_CUTOFF_HZ = 10.0;
const DEADZONE_ANGULAR_VELOCITY_R_PER_S = 1.0;
const CLAMP_AMP = 1.0;
const EXPECTED_PRESSURE_PA = 1e6;

export class Synth {
  dcFilter = new HighpassFilter();
  convoFilter = new ConvoFilter(CONVO_IMPULSE);
  value = new Float32Array(SYNTH_BUFFER_SIZE);
  index = 0;

  private sampleSynth(v: number): void {
    this.value[this.index++] += v;
  }
  clear(): void {
    this.index = 0;
    this.value.fill(0);
  }
  private clampSynth(v: number): number {
    return clamp(v, -CLAMP_AMP, CLAMP_AMP);
  }
  private setDeadzone(v: number, crank: Crankshaft): number {
    if (Math.abs(crank.angular_velocity_r_per_s) < DEADZONE_ANGULAR_VELOCITY_R_PER_S) {
      return 0.0;
    }
    return v;
  }
  push(crank: Crankshaft, value: number, useConvolution: boolean, volume: number): number {
    value = this.dcFilter.process(DC_FILTER_CUTOFF_HZ, value);
    if (useConvolution) value = this.convoFilter.process(value);
    value = (value * volume) / EXPECTED_PRESSURE_PA;
    value = this.setDeadzone(value, crank);
    value = this.clampSynth(value);
    this.sampleSynth(value);
    return value;
  }
}
