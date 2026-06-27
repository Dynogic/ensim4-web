// Core constants and small math helpers (ported from std.h).

export const AUDIO_SAMPLE_RATE_HZ = 48000;
export const MONITOR_REFRESH_RATE_HZ = 60;
export const DT_S = 1.0 / AUDIO_SAMPLE_RATE_HZ;
export const PI_R = 3.141592653589793;
export const FOUR_PI_R = 4.0 * PI_R;

export const SYNTH_BUFFER_SIZE = AUDIO_SAMPLE_RATE_HZ / MONITOR_REFRESH_RATE_HZ; // 800
export const SYNTH_BUFFER_MIN_SIZE = 1 * SYNTH_BUFFER_SIZE;
export const SYNTH_BUFFER_MAX_SIZE = 4 * SYNTH_BUFFER_SIZE;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function min(x: number, y: number): number {
  return x < y ? x : y;
}
export function max(x: number, y: number): number {
  return x > y ? x : y;
}
export function calcCircleAreaM2(diameterM: number): number {
  return PI_R * Math.pow(diameterM / 2.0, 2.0);
}
export function calcCylinderVolumeM3(diameterM: number, depthM: number): number {
  return calcCircleAreaM2(diameterM) * depthM;
}
//       w1 * x1 + w2 * x2
// mix = -----------------
//            w1 + w2
export function calcMix(v1: number, w1: number, v2: number, w2: number): number {
  return (v1 * w1 + v2 * w2) / (w1 + w2);
}
