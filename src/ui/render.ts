// Canvas renderer (ported from sdl.h). Renders at a 1920x1080 logical
// resolution; the caller scales the context to fit the canvas.

import { PI_R } from "../sim/constants";
import {
  MAX_SAMPLES, SAMPLE_NAME_E_SIZE, type SampleName,
  SAMPLE_NAME_STRING, type Sampler, skipSampleNamespace,
} from "../sim/sampler";
import { type Node, NodeType, NODE_NAME_STRING, countNodeEdges } from "../sim/nodes";
import { type Engine } from "../sim/engine";
import { type Piston, type PowerCell } from "../sim/mechanical";
import { LowpassFilter } from "../sim/filters";
import { panicMessage } from "../sim/chamber";
import { waveTable } from "../sim/wave";
import {
  type Color, type Pt, type Rect, type UIState,
  type TimePanel, type ProgressBar, type Panel,
  BLACK_COLOR, CONTAINER_COLOR, DARK_LINE_COLOR, LINE_COLOR,
  PANIC_COLOR, TEXT_COLOR, channelColor, mixColors,
} from "./widgets";

export const XRES = 1920;
export const YRES = 1080;
export const MID_X = XRES / 2;
export const MID_Y = YRES / 2;
const NODE_W = 32;
const NODE_HALF_W = 16;
const PLOT_LOWPASS_FILTER_HZ = 1000.0;
const PISTON_SCALE_P_PER_M = 400.0;
const PISTON_SPACE = 4.0;
const ROTOR_CELL_W = 48;
const ROTOR_HALF_W = ROTOR_CELL_W / 2;
const ZERO_LINE_MIX = 0.66;
const FLOW_CYCLE_SPINNER_DIVISOR = 2048;
const MAX_DISPLAY_SAMPLES = MAX_SAMPLES / 16;
const SPINNER = [124, 47, 45, 92, 124, 47, 45, 92].map((c) => String.fromCharCode(c));

const FONT = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
const CHAR_SIZE = 8;
const LINE_SPACING = 1.5 * CHAR_SIZE;
const HALF_CHAR = CHAR_SIZE / 2;

function css(c: Color, a = 1): string {
  return `rgba(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0},${a})`;
}

export class Renderer {
  ctx: CanvasRenderingContext2D;
  constructor(ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
  }
  private stroke(c: Color): void { this.ctx.strokeStyle = css(c); }
  private fill(c: Color): void { this.ctx.fillStyle = css(c); }
  clear(c: Color): void { this.fill(c); this.ctx.fillRect(0, 0, XRES, YRES); }
  rect(r: Rect, c: Color): void { this.stroke(c); this.ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h); }
  fillRect(r: Rect, c: Color): void { this.fill(c); this.ctx.fillRect(r.x, r.y, r.w, r.h); }
  fillOutlineRect(r: Rect, inner: Color, outer: Color): void { this.fillRect(r, inner); this.rect(r, outer); }
  line(a: Pt, b: Pt, c: Color): void {
    this.stroke(c); this.ctx.beginPath(); this.ctx.moveTo(a.x, a.y); this.ctx.lineTo(b.x, b.y); this.ctx.stroke();
  }
  lines(pts: Pt[], c: Color): void {
    if (pts.length < 2) return;
    this.stroke(c); this.ctx.beginPath(); this.ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) this.ctx.lineTo(pts[i].x, pts[i].y);
    this.ctx.stroke();
  }
  points(pts: Pt[], c: Color): void {
    this.fill(c);
    for (let i = 0; i < pts.length; i++) this.ctx.fillRect(pts[i].x, pts[i].y, 1.4, 1.4);
  }
  text(x: number, y: number, s: string, c: Color): void {
    this.fill(c); this.ctx.font = FONT; this.ctx.textAlign = "left"; this.ctx.textBaseline = "top";
    this.ctx.fillText(s, x, y);
  }
}

function pointInRect(r: Rect, px: number, py: number): boolean {
  return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
}

function calcRadialRadius(engine: Engine): number {
  return (engine.radial_spacing * (engine.nodes.length * NODE_W)) / (2.0 * PI_R);
}
function calcRadialDiameter(engine: Engine): number { return 2.0 * calcRadialRadius(engine); }
function calcPlotColumnWidth(engine: Engine): number {
  return (XRES - calcRadialDiameter(engine)) / 2.0 - 1.4 * 192;
}

function centerText(ctx: CanvasRenderingContext2D, p: Pt, text: string): Pt {
  return { x: p.x + NODE_HALF_W - ctx.measureText(text).width / 2, y: p.y + NODE_HALF_W - HALF_CHAR };
}

function calcRadials(engine: Engine, pts: Pt[]): void {
  const radius = calcRadialRadius(engine);
  const size = engine.nodes.length;
  for (let i = 0; i < size; i++) {
    const theta = (2.0 * PI_R * i) / size;
    pts[i] = { x: MID_X + radius * Math.cos(theta) - NODE_HALF_W, y: MID_Y + radius * Math.sin(theta) - NODE_HALF_W };
  }
}

// --- Radial node graph --------------------------------------------------

function drawNodeAt(r: Renderer, node: Node, p: Pt, color: Color): void {
  const rect: Rect = { x: p.x, y: p.y, w: NODE_W, h: NODE_W };
  const inner = node.chamber.should_panic ? color : BLACK_COLOR;
  r.fillOutlineRect(rect, inner, color);
  const cycle = (node.chamber.flow_cycles / FLOW_CYCLE_SPINNER_DIVISOR) | 0;
  const spinner = SPINNER[cycle % SPINNER.length];
  const mid = centerText(r.ctx, p, spinner);
  r.text(mid.x, mid.y, spinner, TEXT_COLOR);
}

function drawRadialLines(r: Renderer, engine: Engine, pts: Pt[]): void {
  const nodes = engine.nodes;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    for (const next of node.next) {
      const from: Pt = { x: pts[i].x + NODE_HALF_W, y: pts[i].y + NODE_HALF_W };
      const to: Pt = { x: pts[next].x + NODE_HALF_W, y: pts[next].y + NODE_HALF_W };
      const openColor = mixColors(DARK_LINE_COLOR, LINE_COLOR, node.chamber.nozzle_open_ratio);
      r.line(from, to, node.is_next_selected ? channelColor(6) : openColor);
    }
  }
}

function drawRadialNodes(r: Renderer, engine: Engine, pts: Pt[]): void {
  let colorIndex = 0;
  const nodes = engine.nodes;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.is_selected) {
      drawNodeAt(r, node, pts[i], channelColor(colorIndex));
      colorIndex += countNodeEdges(node);
    } else {
      drawNodeAt(r, node, pts[i], CONTAINER_COLOR);
    }
  }
}

function drawRadialNames(r: Renderer, engine: Engine, pts: Pt[]): void {
  const nodes = engine.nodes;
  for (let i = 0; i < nodes.length; i++) {
    const name = NODE_NAME_STRING[nodes[i].type];
    const c = centerText(r.ctx, pts[i], name);
    r.text(c.x, c.y - LINE_SPACING - NODE_HALF_W, name, TEXT_COLOR);
  }
}

function drawRadialChambers(r: Renderer, engine: Engine): void {
  const pts: Pt[] = new Array(engine.nodes.length);
  calcRadials(engine, pts);
  drawRadialLines(r, engine, pts);
  drawRadialNodes(r, engine, pts);
  drawRadialNames(r, engine, pts);
}

// --- Scope plots -------------------------------------------------------

const plotSamples = new Float64Array(MAX_SAMPLES);
const plotPoints: Pt[] = new Array(MAX_DISPLAY_SAMPLES * SAMPLE_NAME_E_SIZE);
for (let i = 0; i < plotPoints.length; i++) plotPoints[i] = { x: 0, y: 0 };

function downSample(samples: Float64Array, size: number, cap: number): number {
  if (size > cap) {
    const step = ((size + cap - 1) / cap) | 0;
    let j = 0;
    for (let i = 0; i < size; i += step) samples[j++] = samples[i];
    return j;
  }
  return size;
}

function calcPointInRect(value: number, rect: Rect, index: number, size: number): Pt {
  const border = 1.0;
  const x = rect.x + border, y = rect.y + border;
  const w = rect.w - border * 2.0, h = rect.h - border * 2.0;
  return { x: x + (w * index) / (size - 1), y: y + h * (1.0 - value) };
}

function drawPlotChannel(r: Renderer, rects: Rect[], channel: number, sampler: Sampler, usePlotFilter: boolean): void {
  let buffered = 0;
  const color = channelColor(channel);
  const samplerSize = sampler.size;
  const isLast = channel === sampler.channel_index - 1;
  for (let name = 0; name < SAMPLE_NAME_E_SIZE; name++) {
    const src = sampler.getChannel(channel, name as SampleName);
    for (let i = 0; i < samplerSize; i++) plotSamples[i] = src[i];
    const size = downSample(plotSamples, samplerSize, MAX_DISPLAY_SAMPLES);
    let maxV = -Number.MAX_VALUE, minV = Number.MAX_VALUE;
    for (let i = 0; i < size; i++) { if (plotSamples[i] > maxV) maxV = plotSamples[i]; if (plotSamples[i] < minV) minV = plotSamples[i]; }
    const range = maxV - minV;
    const rect = rects[name];
    if (isLast) {
      let yy = rect.y + 2 * LINE_SPACING;
      r.text(rect.x + LINE_SPACING, yy, `max: ${fmtExp(maxV)}`, color); yy += LINE_SPACING;
      r.text(rect.x + LINE_SPACING, yy, `min: ${fmtExp(minV)}`, color); yy += LINE_SPACING;
      r.text(rect.x + LINE_SPACING, yy, `div: ${(maxV / (minV || 1)).toFixed(3)}`, color);
    }
    if (range >= 1e-9) {
      const dataRectYOffset = 3 * (LINE_SPACING + CHAR_SIZE);
      const dataRect: Rect = { x: rect.x, y: rect.y + dataRectYOffset, w: rect.w, h: rect.h - dataRectYOffset };
      const zy = dataRect.y + (maxV / (maxV - minV)) * dataRect.h;
      if (zy > dataRect.y && zy < dataRect.y + dataRect.h) {
        r.line({ x: dataRect.x, y: zy }, { x: dataRect.x + dataRect.w, y: zy }, mixColors(color, BLACK_COLOR, ZERO_LINE_MIX));
      }
      if (usePlotFilter) {
        const lf = new LowpassFilter();
        lf.last = plotSamples[0];
        for (let i = 0; i < size; i++) plotSamples[i] = lf.process(PLOT_LOWPASS_FILTER_HZ, plotSamples[i]);
      }
      for (let i = 0; i < size; i++) {
        plotPoints[buffered++] = calcPointInRect((plotSamples[i] - minV) / range, dataRect, i, size);
      }
    }
  }
  r.points(plotPoints.slice(0, buffered), color);
}

function drawPlots(r: Renderer, engine: Engine, sampler: Sampler): void {
  const rects: Rect[] = new Array(SAMPLE_NAME_E_SIZE);
  let name = 0;
  const w = calcPlotColumnWidth(engine);
  const leftSamples = Math.floor(SAMPLE_NAME_E_SIZE / 2.0);
  const rightSamples = Math.ceil(SAMPLE_NAME_E_SIZE / 2.0);
  const leftH = YRES / leftSamples;
  const rightH = YRES / rightSamples;
  let y = 0;
  while (y < YRES) { rects[name++] = { x: 0, y, w, h: leftH }; y += leftH; }
  y = 0;
  while (y < YRES) { rects[name++] = { x: XRES - w, y, w, h: rightH }; y += rightH; }
  for (let ch = 0; ch < sampler.channel_index; ch++) drawPlotChannel(r, rects, ch, sampler, engine.use_plot_filter);
  for (let n = 0; n < SAMPLE_NAME_E_SIZE; n++) {
    r.rect(rects[n], CONTAINER_COLOR);
    r.text(rects[n].x + LINE_SPACING, rects[n].y + LINE_SPACING, skipSampleNamespace(SAMPLE_NAME_STRING[n]), TEXT_COLOR);
  }
}

// --- Piston row -------------------------------------------------------

function drawRotorCell(r: Renderer, engine: Engine, p: PowerCell, x: number, y: number): void {
  const cx = x + ROTOR_HALF_W;
  const cy = y + ROTOR_HALF_W + 8;
  r.rect({ x, y: cy - ROTOR_HALF_W, w: ROTOR_CELL_W, h: ROTOR_CELL_W }, CONTAINER_COLOR);
  // The rotor spins at 1/3 eccentric-shaft speed; all chambers share one rotor
  // so they rotate in unison.
  const a = engine.crankshaft.theta_r / 3.0;
  const pts: Pt[] = [];
  for (let k = 0; k < 3; k++) {
    const ang = a + (2.0 * PI_R * k) / 3.0;
    pts.push({ x: cx + ROTOR_HALF_W * 0.82 * Math.cos(ang), y: cy + ROTOR_HALF_W * 0.82 * Math.sin(ang) });
  }
  pts.push(pts[0]);
  const color = p.sparkplug.isEnabled(engine.crankshaft) ? channelColor(3) : LINE_COLOR;
  r.lines(pts, color);
}

// N-sided rotor (quasiturbine = 4), spinning at `gear` × shaft speed.
function drawPolyRotorCell(r: Renderer, engine: Engine, p: PowerCell, x: number, y: number, sides: number, gear: number): void {
  const cx = x + ROTOR_HALF_W;
  const cy = y + ROTOR_HALF_W + 8;
  r.rect({ x, y: cy - ROTOR_HALF_W, w: ROTOR_CELL_W, h: ROTOR_CELL_W }, CONTAINER_COLOR);
  const a = gear * engine.crankshaft.theta_r;
  const pts: Pt[] = [];
  for (let k = 0; k < sides; k++) {
    const ang = a + (2.0 * PI_R * k) / sides;
    pts.push({ x: cx + ROTOR_HALF_W * 0.82 * Math.cos(ang), y: cy + ROTOR_HALF_W * 0.82 * Math.sin(ang) });
  }
  pts.push(pts[0]);
  const color = p.sparkplug.isEnabled(engine.crankshaft) ? channelColor(3) : LINE_COLOR;
  r.lines(pts, color);
}

// Opposed-piston: two boxes meeting in the middle (combustion in the centre).
function drawOpposedCell(r: Renderer, engine: Engine, p: PowerCell, x: number, y: number): void {
  const w = PISTON_SCALE_P_PER_M * 0.040;
  const h = PISTON_SCALE_P_PER_M * 0.020;
  const gap = 6;
  const spark = p.sparkplug.isEnabled(engine.crankshaft);
  const col = spark ? channelColor(3) : CONTAINER_COLOR;
  // Crank angle drives the two opposed pistons; both retreat from centre away
  // from TDC. Approximate the reciprocation with a cosine.
  const theta = p.theta(engine.crankshaft);
  const off = Math.cos(theta) * h * 0.5;
  const top: Rect = { x, y: y + 16 - h - off, w, h };
  const bot: Rect = { x, y: y + 16 + gap + off, w, h };
  r.line({ x, y: y + 16 }, { x: x + w, y: y + 16 }, CONTAINER_COLOR);
  r.fillOutlineRect(top, col, CONTAINER_COLOR);
  r.fillOutlineRect(bot, col, CONTAINER_COLOR);
}

// Gas turbine: a spool — housing circle with spinning fan blades (front view of
// a turbine wheel). Spins at shaft speed; glows when the combustor is
// pressurized (gauge pressure > 0 = running).
function drawTurbineCell(r: Renderer, engine: Engine, _p: PowerCell, x: number, y: number): void {
  const cx = x + ROTOR_HALF_W;
  const cy = y + ROTOR_HALF_W + 8;
  const w = ROTOR_CELL_W;
  // Housing.
  r.rect({ x, y: cy - ROTOR_HALF_W, w, h: w }, CONTAINER_COLOR);
  // Spinning fan: 8 blades at shaft speed.
  const a = engine.crankshaft.theta_r;
  const blades = 8;
  const bladeColor = channelColor(6);
  for (let k = 0; k < blades; k++) {
    const ang = a + (2.0 * PI_R * k) / blades;
    r.line(
      { x: cx, y: cy },
      { x: cx + ROTOR_HALF_W * 0.9 * Math.cos(ang), y: cy + ROTOR_HALF_W * 0.9 * Math.sin(ang) },
      bladeColor,
    );
  }
  // Hub dot — glows when the combustor is running (ignition on).
  r.fillRect({ x: cx - 2, y: cy - 2, w: 4, h: 4 }, engine.can_ignite ? channelColor(3) : LINE_COLOR);
}

function drawPistons(r: Renderer, engine: Engine): void {
  let x = MID_X;
  let y = MID_Y - 32;
  r.text(x, y, engine.name, TEXT_COLOR);
  y += LINE_SPACING + CHAR_SIZE;
  for (const node of engine.nodes) {
    if (node.type === NodeType.piston && node.piston) {
      const p = node.piston;
      if (p.kind === "rotor") {
        drawRotorCell(r, engine, p, x, y);
        x += PISTON_SPACE + ROTOR_CELL_W;
        continue;
      }
      if (p.kind === "quasiturbine") {
        drawPolyRotorCell(r, engine, p, x, y, 4, 1.0);
        x += PISTON_SPACE + ROTOR_CELL_W;
        continue;
      }
      if (p.kind === "turbine") {
        drawTurbineCell(r, engine, p, x, y);
        x += PISTON_SPACE + ROTOR_CELL_W;
        continue;
      }
      if (p.kind === "opposed") {
        drawOpposedCell(r, engine, p, x, y);
        x += PISTON_SPACE + 2 * (PISTON_SCALE_P_PER_M * 0.040);
        continue;
      }
      const pp = p as Piston;
      const head: Rect = {
        x, y: PISTON_SCALE_P_PER_M * pp.chamberDepthM() + y,
        w: PISTON_SCALE_P_PER_M * pp.diameter_m,
        h: PISTON_SCALE_P_PER_M * pp.head_compression_height_m * 2.0,
      };
      r.line({ x, y }, { x: x + head.w, y }, CONTAINER_COLOR);
      const conrodW = head.w / 4.0;
      const conrod: Rect = { x: head.x + (head.w - conrodW) / 2.0, y: head.y + head.h, w: conrodW, h: PISTON_SCALE_P_PER_M * pp.connecting_rod_length_m };
      if (pp.sparkplug.isEnabled(engine.crankshaft)) r.fillOutlineRect(head, channelColor(3), CONTAINER_COLOR);
      r.rect(head, CONTAINER_COLOR);
      r.rect(conrod, CONTAINER_COLOR);
      x += PISTON_SPACE + head.w;
    }
  }
}

// --- Info panels ------------------------------------------------------

function drawTimePanel(r: Renderer, panel: TimePanel): void {
  for (let i = 0; i < panel.slide.length; i++) {
    if (!panel.labels[i]) continue;
    const buf = panel.slide[i].buf;
    const pts: Pt[] = [];
    const range = panel.max_value - panel.min_value;
    for (let k = 0; k < buf.length; k++) {
      pts.push(calcPointInRect((buf[k] - panel.min_value) / (range || 1), panel.rect, k, buf.length));
    }
    r.lines(pts, channelColor(i));
  }
  r.rect(panel.rect, CONTAINER_COLOR);
}

function drawProgressBar(r: Renderer, bar: ProgressBar): void {
  const pct = bar.max_value > 0 ? Math.max(0, Math.min(1, bar.value / bar.max_value)) : 0;
  r.fillRect({ x: bar.rect.x, y: bar.rect.y, w: bar.rect.w * pct, h: bar.rect.h }, channelColor(2));
  r.rect(bar.rect, CONTAINER_COLOR);
}

function drawPanel(r: Renderer, panel: Panel, color: Color): void {
  r.rect(panel.rect, panel.panic ? PANIC_COLOR : CONTAINER_COLOR);
  const size = panel.size;
  if (size > 0) {
    const pts: Pt[] = [];
    for (let i = 0; i < size; i++) pts.push(calcPointInRect(panel.sample[i], panel.rect, i, size));
    r.points(pts, color);
  }
}

function fmtExp(v: number): string {
  if (!isFinite(v)) return "0.000e+0";
  return v.toExponential(3);
}

function drawTimePanelInfo(r: Renderer, panel: TimePanel, x: number, y: number, fmt: (v: number) => string): number {
  r.text(x, y, panel.title, TEXT_COLOR); y += LINE_SPACING;
  for (let i = 0; i < panel.labels.length; i++) {
    const lab = panel.labels[i];
    if (lab) { r.text(x, y, `${lab.padStart(12)}: ${fmt(panel.slide[i].average())}`, channelColor(i)); y += LINE_SPACING; }
  }
  panel.rect = { x, y, w: 192, h: 96 }; y += 96 + LINE_SPACING;
  drawTimePanel(r, panel);
  return y;
}

function drawProgressBarInfo(r: Renderer, bar: ProgressBar, x: number, y: number, fmt: (v: number) => string): number {
  r.text(x, y, `${bar.title} ${fmt(bar.value)}`, TEXT_COLOR); y += LINE_SPACING;
  bar.rect = { x, y, w: 192, h: 16 }; y += 16 + LINE_SPACING;
  drawProgressBar(r, bar);
  return y;
}

function drawPanelInfo(r: Renderer, panel: Panel, x: number, y: number, color: Color, extra?: [string, number][]): number {
  r.text(x, y, panel.title, TEXT_COLOR); y += LINE_SPACING;
  r.text(x, y, `max ${panel.normalized.is_success ? panel.normalized.max_value.toFixed(3) : "0"}`, color); y += LINE_SPACING;
  r.text(x, y, `min ${panel.normalized.is_success ? panel.normalized.min_value.toFixed(3) : "0"}`, color); y += LINE_SPACING;
  panel.rect = { x, y, w: 192, h: panel.rect.h }; y += panel.rect.h + LINE_SPACING;
  drawPanel(r, panel, color);
  if (extra) for (const [s, v] of extra) { r.text(x, y, `${s} ${v.toFixed(2)}`, color); y += LINE_SPACING; }
  return y;
}

function drawLeftInfo(r: Renderer, engine: Engine, ui: UIState): void {
  const x = calcPlotColumnWidth(engine) + LINE_SPACING;
  let y = LINE_SPACING;
  const warn = channelColor(0);
  const active = (b: boolean) => (b ? warn : TEXT_COLOR);
  const lines: [string, Color][] = [
    ["ensim4", TEXT_COLOR],
    ["the inline engine simulator", TEXT_COLOR],
    ["    t: use_convolution", active(engine.use_convolution)],
    ["    y: use_cfd", active(engine.use_cfd)],
    ["    u: use_plot_filter", active(engine.use_plot_filter)],
    ["    d: ignition_on", active(engine.can_ignite)],
    ["space: starter_on", active(engine.starter.is_on)],
    ["------ nodes --------------", TEXT_COLOR],
    ["    c: clear", TEXT_COLOR],
    ["    n: next (from one)", TEXT_COLOR],
    ["    i: intakes", TEXT_COLOR],
    ["    e: exhausts", TEXT_COLOR],
    ["    p: pistons", TEXT_COLOR],
    ["", TEXT_COLOR],
  ];
  for (const [s, c] of lines) { r.text(x, y, s, c); y += LINE_SPACING; }

  // Sim compute headroom: how many times faster than real-time the simulation
  // produces audio (green >= 1.5x, yellow >= 1x, red below real-time).
  const rf = ui.realtimeFactor;
  const rfColor = rf >= 1.5 ? channelColor(1) : rf >= 1.0 ? channelColor(3) : channelColor(0);
  r.text(x, y, `sim_speed: ${rf.toFixed(2)}x realtime`, rfColor); y += LINE_SPACING + CHAR_SIZE;

  y = drawTimePanelInfo(r, ui.loopTimePanel, x, y, (v) => v.toFixed(3));
  y = drawTimePanelInfo(r, ui.engineTimePanel, x, y, (v) => v.toFixed(3));
  y = drawTimePanelInfo(r, ui.audioBufferPanel, x, y, (v) => v.toFixed(0));
  y = drawProgressBarInfo(r, ui.fpsBar, x, y, (v) => v.toFixed(2));

  const omega = engine.crankshaft.angular_velocity_r_per_s;
  const minRps = (4 * Math.PI * 48000) / MAX_SAMPLES;
  r.text(x, y, `trigger_min_r_per_s: ${minRps.toFixed(0)}`, omega < minRps ? warn : TEXT_COLOR); y += LINE_SPACING;
  r.text(x, y, `monitor_hz: 60`, TEXT_COLOR); y += LINE_SPACING;
  r.text(x, y, `g_engine_nodes: ${engine.nodes.length}`, TEXT_COLOR); y += LINE_SPACING;
  r.text(x, y, `supported_channels: 8`, TEXT_COLOR);
}

function drawRightInfo(r: Renderer, engine: Engine, ui: UIState): void {
  const x = XRES - calcPlotColumnWidth(engine) - LINE_SPACING - 192;
  let y = LINE_SPACING;
  y = drawPanelInfo(r, ui.starterPanel, x, y, channelColor(6));
  y = drawPanelInfo(r, ui.convoPanel, x, y, channelColor(6));
  y = drawProgressBarInfo(r, ui.rPerSBar, x, y, (v) => v.toFixed(0));
  let waveIdx = 0;
  for (const node of engine.nodes) {
    if (node.type !== NodeType.eplenum || waveIdx >= ui.wavePanels.length) continue;
    const panel = ui.wavePanels[waveIdx];
    panel.pushPrim(waveTable.primPView(node.waveIndex), 128);
    y = drawPanelInfo(r, panel, x, y, channelColor(6), [
      ["max_m_per_s", waveTable.maxWaveSpeedMPerS(node.waveIndex)],
      ["pipe_len_m", waveTable.pipeLengthM(node.waveIndex)],
      ["mic_pos_ratio", waveTable.micPositionRatio(node.waveIndex)],
    ]);
    waveIdx++;
  }
  y = drawPanelInfo(r, ui.synthPanel, x, y, channelColor(6));
  y = drawProgressBarInfo(r, ui.throttleBar, x, y, (v) => v.toFixed(2));
  // Indicated power gauge (all engines): cycle-averaged gas torque × ω.
  const powerKW = engine.power_w / 1000.0;
  r.text(x, y, `power: ${powerKW.toFixed(1)} kW`, channelColor(2));
  // Jet thrust gauge: thrust ∝ ω² (mass flow × velocity both scale with spool
  // speed). Shown only for jet engines, below the throttle bar.
  if (engine.is_jet) {
    const omega = engine.crankshaft.angular_velocity_r_per_s;
    const thrustKN = (omega * omega * 6.0e-3) / 1000.0;  // kN
    r.text(x, y + LINE_SPACING, `thrust: ${thrustKN.toFixed(1)} kN`, channelColor(1));
  }
}

function drawPanicMessage(r: Renderer): void {
  const msg = panicMessage;
  if (!msg) return;
  const p = centerText(r.ctx, { x: MID_X, y: 0 }, msg);
  r.text(p.x, MID_Y + LINE_SPACING, msg, PANIC_COLOR);
}

// --- Top-level scene --------------------------------------------------

export function drawScene(r: Renderer, engine: Engine, sampler: Sampler, ui: UIState, _samplerSynth: Float32Array): void {
  r.clear(BLACK_COLOR);
  drawPlots(r, engine, sampler);
  drawRadialChambers(r, engine);
  drawLeftInfo(r, engine, ui);
  drawRightInfo(r, engine, ui);
  drawPistons(r, engine);
  drawPanicMessage(r);
}

// --- Hit testing (for mouse node selection) ---------------------------

export function radialNodeAt(engine: Engine, px: number, py: number): number {
  const pts: Pt[] = new Array(engine.nodes.length);
  calcRadials(engine, pts);
  for (let i = 0; i < engine.nodes.length; i++) {
    if (pointInRect({ x: pts[i].x, y: pts[i].y, w: NODE_W, h: NODE_W }, px, py)) return i;
  }
  return -1;
}
