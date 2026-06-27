// UI widget state (ported from sdl_scroll_s.h, sdl_slide_buffer_t.h,
// sdl_panel_s.h, sdl_progress_bar_s.h, sdl_time_panel_s.h, sdl_widgets.h).

import { MAX_SAMPLES } from "../sim/sampler";
import {
  type Normalized,
  calcNormalizedZeroOffsetRatio,
  normalizeSamples,
} from "../sim/normalized";
import { type Engine, type EngineTime } from "../sim/engine";
import { type Sampler } from "../sim/sampler";
import { CONVO_IMPULSE } from "../sim/filters";
import { waveTable } from "../sim/wave";

export type Color = [number, number, number];

export const CHANNEL_COLORS: Color[] = [
  [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.5, 1.0], [1.0, 1.0, 0.0],
  [1.0, 0.0, 1.0], [0.0, 1.0, 1.0], [1.0, 0.65, 0.0], [0.6, 0.0, 1.0],
  [0.0, 1.0, 0.6], [1.0, 0.4, 0.7], [0.3, 0.8, 1.0], [0.6, 1.0, 0.2],
  [1.0, 0.85, 0.0], [0.85, 0.0, 0.85], [0.0, 0.75, 1.0], [1.0, 0.3, 0.3],
];
export const channelColor = (i: number): Color => CHANNEL_COLORS[i % CHANNEL_COLORS.length];

export const PANIC_COLOR: Color = [1.0, 0.0, 0.0];
export const BLACK_COLOR: Color = [0.0, 0.0, 0.0];
export const DARK_LINE_COLOR: Color = [0.15, 0.15, 0.15];
export const LINE_COLOR: Color = [0.28, 0.28, 0.28];
export const CONTAINER_COLOR: Color = [0.5, 0.5, 0.5];
export const TEXT_COLOR: Color = [1.0, 1.0, 1.0];

export function mixColors(a: Color, b: Color, t: number): Color {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export interface Rect { x: number; y: number; w: number; h: number; }
export interface Pt { x: number; y: number; }

export const SLIDE_BUFFER_SIZE = 128;

export class SlideBuffer {
  buf = new Float64Array(SLIDE_BUFFER_SIZE);
  push(v: number): void {
    for (let i = 0; i < SLIDE_BUFFER_SIZE - 1; i++) this.buf[i] = this.buf[i + 1];
    this.buf[SLIDE_BUFFER_SIZE - 1] = v;
  }
  average(): number {
    let s = 0;
    for (let i = 0; i < SLIDE_BUFFER_SIZE; i++) s += this.buf[i];
    return s / SLIDE_BUFFER_SIZE;
  }
}

export const TIME_PANEL_SIZE = 8;

export class TimePanel {
  title: string;
  labels: (string | null)[];
  rect: Rect;
  min_value: number;
  max_value: number;
  slide: SlideBuffer[];
  constructor(title: string, labels: (string | null)[], min: number, max: number, w: number, h: number) {
    this.title = title;
    this.labels = labels;
    this.min_value = min;
    this.max_value = max;
    this.rect = { x: 0, y: 0, w, h };
    this.slide = [];
    for (let i = 0; i < TIME_PANEL_SIZE; i++) this.slide.push(new SlideBuffer());
  }
  push(sample: number[]): void {
    for (let i = 0; i < TIME_PANEL_SIZE; i++) {
      if (this.labels[i] != null) this.slide[i].push(sample[i]);
    }
  }
}

export class ProgressBar {
  title: string;
  rect: Rect;
  value = 0;
  max_value: number;
  constructor(title: string, max: number, w: number, h: number) {
    this.title = title;
    this.max_value = max;
    this.rect = { x: 0, y: 0, w, h };
  }
}

export class Panel {
  title: string;
  rect: Rect;
  sample = new Float64Array(MAX_SAMPLES);
  size = 0;
  normalized: Normalized = { max_value: 0, avg_value: 0, min_value: 0, div_value: 0, is_success: false };
  panic = false;
  constructor(title: string, w: number, h: number) {
    this.title = title;
    this.rect = { x: 0, y: 0, w, h };
  }
  pushFrom(values: ArrayLike<number>, size: number): void {
    for (let i = 0; i < size; i++) this.sample[i] = values[i];
    this.size = size;
    this.normalized = normalizeSamples(this.sample, size);
  }
  pushPrim(prim: Float64Array, size: number): void {
    for (let i = 0; i < size; i++) this.sample[i] = prim[i];
    this.size = size;
    this.normalized = normalizeSamples(this.sample, size);
    this.panic = !this.normalized.is_success;
  }
  clear(): void {
    this.sample.fill(0);
    this.size = 0;
  }
}

export const SUPPORTED_WIDGET_W = 192;

export interface WidgetTime {
  n_a_time_ms: number;
  engine_time_ms: number;
  draw_time_ms: number;
  vsync_time_ms: number;
}

export class UIState {
  // Smoothed sim compute headroom: (audio time per buffer) / (compute time per
  // buffer). >1 means the simulation runs faster than real-time.
  realtimeFactor = 0;
  loopTimePanel = new TimePanel("loop_time_ms", ["n/a", "engine", "draw", "vsync"], 0, 20, SUPPORTED_WIDGET_W, 96);
  engineTimePanel = new TimePanel("engine_time_ms", ["fluids", "kinematics", "thermo", "synth", "waves"], 0, 15, SUPPORTED_WIDGET_W, 96);
  audioBufferPanel = new TimePanel("audio_buffer_size", ["buffer_size", "min_size", null, null], 0, 4 * 800, SUPPORTED_WIDGET_W, 96);
  rPerSBar = new ProgressBar("crank_r_per_s", 2000, SUPPORTED_WIDGET_W, 16);
  fpsBar = new ProgressBar("frames_per_sec", 100, SUPPORTED_WIDGET_W, 16);
  throttleBar = new ProgressBar("throttle", 1, SUPPORTED_WIDGET_W, 16);
  starterPanel = new Panel("starter_r_per_s", SUPPORTED_WIDGET_W, 64);
  convoPanel = new Panel("impulse x[n]", SUPPORTED_WIDGET_W, 64);
  wavePanels: Panel[] = [
    new Panel("wave_0_pa", SUPPORTED_WIDGET_W, 48),
    new Panel("wave_1_pa", SUPPORTED_WIDGET_W, 48),
    new Panel("wave_2_pa", SUPPORTED_WIDGET_W, 48),
    new Panel("wave_3_pa", SUPPORTED_WIDGET_W, 48),
  ];
  synthPanel = new Panel("synth_samples", SUPPORTED_WIDGET_W, 64);
}

export function pushWidgets(
  ui: UIState,
  engine: Engine,
  engineTime: EngineTime,
  sampler: Sampler,
  samplerSynth: Float32Array,
  audioBufferSize: number,
  widgetTime: WidgetTime,
): void {
  ui.loopTimePanel.push([widgetTime.n_a_time_ms, widgetTime.engine_time_ms, widgetTime.draw_time_ms, widgetTime.vsync_time_ms]);
  ui.engineTimePanel.push([engineTime.fluids_time_ms, engineTime.kinematics_time_ms, engineTime.thermo_time_ms, engineTime.synth_time_ms, engineTime.wave_time_ms]);
  ui.audioBufferPanel.push([audioBufferSize, 800, 0, 0]);
  ui.rPerSBar.value = engine.crankshaft.angular_velocity_r_per_s;
  ui.throttleBar.value = engine.throttle_open_ratio;
  ui.fpsBar.value = widgetTime.vsync_time_ms > 0 ? 1000.0 / widgetTime.vsync_time_ms : 0;
  ui.starterPanel.pushFrom(sampler.starter, sampler.size);
  if (engine.use_convolution) {
    ui.convoPanel.pushFrom(CONVO_IMPULSE, CONVO_IMPULSE.length);
  } else {
    ui.convoPanel.clear();
  }
  ui.synthPanel.pushFrom(samplerSynth, samplerSynth.length);
}

export { calcNormalizedZeroOffsetRatio, waveTable };
