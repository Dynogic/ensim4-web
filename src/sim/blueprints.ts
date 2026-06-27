// Engine blueprints + the two built-in engine configurations
// (ported from engine_blueprints.h, engine_3_cyl.h, engine_8_cyl.h).

import { FOUR_PI_R } from "./constants";
import { Engine } from "./engine";
import { Node, NodeType } from "./nodes";
import { makeChamber } from "./chamber";
import { Piston, Sparkplug, Valve } from "./mechanical";

export interface CylConfig {
  name: string;
  sound_volume: number;
  radial_spacing: number;
  source_sink_volume_m3: number;
  piston_diameter_m: number;
  piston_crank_throw_length_m: number;
  piston_connecting_rod_length_m: number;
  piston_connecting_rod_mass_kg: number;
  piston_head_mass_density_kg_per_m3: number;
  piston_head_compression_height_m: number;
  piston_head_clearance_height_m: number;
  piston_dynamic_friction_n_m_s_per_r: number;
  piston_static_friction_n_m_s_per_r: number;
  gas_momentum_damping_time_constant_s: number;
  eplenum_wave_pipe_length_m: number;
  mic_position_ratio: number;
  velocity_low_pass_cutoff_frequency_hz: number;
  chamber_volume_m3: number;
  throttle_volume_mult: number;
  irunner_volume_mult: number;
  injector_volume_mult: number;
  erunner_volume_mult: number;
  eplenum_volume_mult: number;
  exhaust_volume_mult: number;
  max_flow_area_m2: number;
  source_max_flow_mult: number;
  throttle_max_flow_mult: number;
  irunner_max_flow_mult: number;
  injector_max_flow_mult: number;
  piston_max_flow_mult: number;
  erunner_max_flow_mult: number;
  eplenum_max_flow_mult: number;
  exhaust_max_flow_mult: number;
  piston_thetas_r: number[];
  irunner_valve_engage_r: number;
  irunner_valve_ramp_r: number;
  piston_valve_engage_r: number;
  piston_valve_ramp_r: number;
  sparkplug_engage_r: number;
  sparkplug_on_r: number;
  no_throttle: number;
  low_throttle: number;
  mid_throttle: number;
  high_throttle: number;
  crankshaft_mass_kg: number;
  crankshaft_radius_m: number;
  flywheel_mass_kg: number;
  flywheel_radius_m: number;
  limiter_cutoff_r_per_s: number;
  limiter_relaxed_r_per_s: number;
  starter_rated_torque_n_m: number;
  starter_no_load_r_per_s: number;
  starter_radius_m: number;
  eplenum_assignment: number[];
  num_eplenums: number;
}

function chamber(volume: number, area: number, damping: number) {
  const c = makeChamber();
  c.volume_m3 = volume;
  c.nozzle_max_flow_area_m2 = area;
  c.gas_momentum_damping_time_constant_s = damping;
  return c;
}

export function buildEngine(cfg: CylConfig): Engine {
  const N = cfg.piston_thetas_r.length;
  const numEpl = cfg.num_eplenums;
  const total = 2 + 4 * N + 2 * numEpl + 1;
  const nodes: Node[] = new Array(total);

  const vChamber = cfg.chamber_volume_m3;
  const vThrottle = cfg.throttle_volume_mult * vChamber;
  const vIrunner = cfg.irunner_volume_mult * vChamber;
  const vInjector = cfg.injector_volume_mult * vChamber;
  const vErunner = cfg.erunner_volume_mult * vChamber;
  const vEplenum = cfg.eplenum_volume_mult * vChamber;
  const vExhaust = cfg.exhaust_volume_mult * vChamber;
  const vSourceSink = cfg.source_sink_volume_m3;

  const A = cfg.max_flow_area_m2;
  const aSource = cfg.source_max_flow_mult * A;
  const aThrottle = cfg.throttle_max_flow_mult * A;
  const aIrunner = cfg.irunner_max_flow_mult * A;
  const aInjector = cfg.injector_max_flow_mult * A;
  const aPiston = cfg.piston_max_flow_mult * A;
  const aErunner = cfg.erunner_max_flow_mult * A;
  const aEplenum = cfg.eplenum_max_flow_mult * A;
  const aExhaust = cfg.exhaust_max_flow_mult * A;
  const damp = cfg.gas_momentum_damping_time_constant_s;

  const idx = {
    source: 0,
    throttle: 1,
    ir: (i: number) => 2 + 4 * i,
    inj: (i: number) => 2 + 4 * i + 1,
    pist: (i: number) => 2 + 4 * i + 2,
    er: (i: number) => 2 + 4 * i + 3,
    eplenum: (k: number) => 2 + 4 * N + 2 * k,
    exhaust: (k: number) => 2 + 4 * N + 2 * k + 1,
    sink: 2 + 4 * N + 2 * numEpl,
  };

  // source
  const src = new Node(chamber(vSourceSink, aSource, damp));
  src.type = NodeType.source;
  src.next = [idx.throttle];
  nodes[idx.source] = src;

  // throttle
  const thr = new Node(chamber(vThrottle, aThrottle, damp));
  thr.type = NodeType.throttle;
  thr.next = [];
  for (let i = 0; i < N; i++) thr.next.push(idx.ir(i));
  nodes[idx.throttle] = thr;

  for (let i = 0; i < N; i++) {
    const theta = cfg.piston_thetas_r[i];

    // irunner
    const ir = new Node(chamber(vIrunner, aIrunner, damp));
    ir.type = NodeType.irunner;
    ir.valve = new Valve();
    ir.valve.engage_r = theta + cfg.irunner_valve_engage_r;
    ir.valve.ramp_r = cfg.irunner_valve_ramp_r;
    ir.next = [idx.pist(i)];
    nodes[idx.ir(i)] = ir;

    // injector
    const inj = new Node(chamber(vInjector, aInjector, damp));
    inj.type = NodeType.injector;
    inj.nozzleIndex = idx.ir(i);
    inj.next = [idx.pist(i)];
    nodes[idx.inj(i)] = inj;

    // piston
    const pchamber = chamber(0, aPiston, damp);
    const pvalve = new Valve();
    pvalve.engage_r = theta + cfg.piston_valve_engage_r;
    pvalve.ramp_r = cfg.piston_valve_ramp_r;
    const pspark = new Sparkplug();
    pspark.engage_r = theta + cfg.sparkplug_engage_r;
    pspark.on_r = cfg.sparkplug_on_r;
    const piston = new Piston(pchamber, pvalve, pspark);
    piston.diameter_m = cfg.piston_diameter_m;
    piston.theta_r = -theta;
    piston.crank_throw_length_m = cfg.piston_crank_throw_length_m;
    piston.connecting_rod_length_m = cfg.piston_connecting_rod_length_m;
    piston.connecting_rod_mass_kg = cfg.piston_connecting_rod_mass_kg;
    piston.head_mass_density_kg_per_m3 = cfg.piston_head_mass_density_kg_per_m3;
    piston.head_compression_height_m = cfg.piston_head_compression_height_m;
    piston.head_clearance_height_m = cfg.piston_head_clearance_height_m;
    piston.dynamic_friction_n_m_s_per_r = cfg.piston_dynamic_friction_n_m_s_per_r;
    piston.static_friction_n_m_s_per_r = cfg.piston_static_friction_n_m_s_per_r;
    const pnode = new Node(pchamber);
    pnode.type = NodeType.piston;
    pnode.piston = piston;
    pnode.next = [idx.er(i)];
    nodes[idx.pist(i)] = pnode;

    // erunner
    const er = new Node(chamber(vErunner, aErunner, damp));
    er.type = NodeType.erunner;
    er.next = [idx.eplenum(cfg.eplenum_assignment[i])];
    nodes[idx.er(i)] = er;
  }

  for (let k = 0; k < numEpl; k++) {
    const epl = new Node(chamber(vEplenum, aEplenum, damp));
    epl.type = NodeType.eplenum;
    epl.waveIndex = k;
    epl.useCfd = true;
    epl.pipeLengthM = cfg.eplenum_wave_pipe_length_m;
    epl.micPositionRatio = cfg.mic_position_ratio;
    epl.velocityLowPassCutoffFrequencyHz = cfg.velocity_low_pass_cutoff_frequency_hz;
    epl.next = [idx.exhaust(k)];
    nodes[idx.eplenum(k)] = epl;

    const ex = new Node(chamber(vExhaust, aExhaust, damp));
    ex.type = NodeType.exhaust;
    ex.next = [idx.sink];
    nodes[idx.exhaust(k)] = ex;
  }

  const sink = new Node(chamber(vSourceSink, 0, damp));
  sink.type = NodeType.sink;
  sink.next = [];
  nodes[idx.sink] = sink;

  const engine = new Engine();
  engine.name = cfg.name;
  engine.nodes = nodes;
  engine.crankshaft.mass_kg = cfg.crankshaft_mass_kg;
  engine.crankshaft.radius_m = cfg.crankshaft_radius_m;
  engine.flywheel.mass_kg = cfg.flywheel_mass_kg;
  engine.flywheel.radius_m = cfg.flywheel_radius_m;
  engine.limiter.cutoff_angular_velocity_r_per_s = cfg.limiter_cutoff_r_per_s;
  engine.limiter.relaxed_angular_velocity_r_per_s = cfg.limiter_relaxed_r_per_s;
  engine.starter.rated_torque_n_m = cfg.starter_rated_torque_n_m;
  engine.starter.no_load_angular_velocity_r_per_s = cfg.starter_no_load_r_per_s;
  engine.starter.radius_m = cfg.starter_radius_m;
  engine.volume = cfg.sound_volume;
  engine.no_throttle = cfg.no_throttle;
  engine.low_throttle = cfg.low_throttle;
  engine.mid_throttle = cfg.mid_throttle;
  engine.high_throttle = cfg.high_throttle;
  engine.radial_spacing = cfg.radial_spacing;
  return engine;
}

const pistonThetas = (n: number): number[] => {
  const arr: number[] = [];
  for (let i = 0; i < n; i++) arr.push((i / n) * FOUR_PI_R);
  return arr;
};

export const ENGINE_3_CYL: CylConfig = {
  name: "Ford 1.0 L EcoBoost I3",
  sound_volume: 0.3,
  radial_spacing: 3.0,
  source_sink_volume_m3: 1.0e20,
  piston_diameter_m: 0.072,
  piston_crank_throw_length_m: 0.038,
  piston_connecting_rod_length_m: 0.1,
  piston_connecting_rod_mass_kg: 0.4,
  piston_head_mass_density_kg_per_m3: 7800.0,
  piston_head_compression_height_m: 0.018,
  piston_head_clearance_height_m: 0.007,
  piston_dynamic_friction_n_m_s_per_r: 0.029,
  piston_static_friction_n_m_s_per_r: 0.9,
  gas_momentum_damping_time_constant_s: 0.53e-3,
  eplenum_wave_pipe_length_m: 1.1,
  mic_position_ratio: 0.1,
  velocity_low_pass_cutoff_frequency_hz: 7000.0,
  chamber_volume_m3: 2.1e-4,
  throttle_volume_mult: 0.1,
  irunner_volume_mult: 0.5,
  injector_volume_mult: 0.02,
  erunner_volume_mult: 0.4,
  eplenum_volume_mult: 0.5,
  exhaust_volume_mult: 0.5,
  max_flow_area_m2: 2.4e-3,
  source_max_flow_mult: 0.3,
  throttle_max_flow_mult: 0.25,
  irunner_max_flow_mult: 0.6,
  injector_max_flow_mult: 0.005,
  piston_max_flow_mult: 0.5,
  erunner_max_flow_mult: 0.45,
  eplenum_max_flow_mult: 1.8,
  exhaust_max_flow_mult: 0.9,
  piston_thetas_r: pistonThetas(3),
  irunner_valve_engage_r: -0.25 * Math.PI,
  irunner_valve_ramp_r: 1.0 * Math.PI,
  piston_valve_engage_r: 2.7 * Math.PI,
  piston_valve_ramp_r: 0.95 * Math.PI,
  sparkplug_engage_r: 2.05 * Math.PI,
  sparkplug_on_r: 0.25 * Math.PI,
  no_throttle: 0.0,
  low_throttle: 0.001,
  mid_throttle: 0.05,
  high_throttle: 1.0,
  crankshaft_mass_kg: 1.3,
  crankshaft_radius_m: 0.07,
  flywheel_mass_kg: 6.15,
  flywheel_radius_m: 0.32,
  limiter_cutoff_r_per_s: 1300.0,
  limiter_relaxed_r_per_s: 100.0,
  starter_rated_torque_n_m: 70.0,
  starter_no_load_r_per_s: 700.0,
  starter_radius_m: 0.015,
  eplenum_assignment: [0, 0, 0],
  num_eplenums: 1,
};

export const ENGINE_8_CYL: CylConfig = {
  name: "Inline 8",
  sound_volume: 0.5,
  radial_spacing: 2.1,
  source_sink_volume_m3: 1.0e20,
  piston_diameter_m: 0.065,
  piston_crank_throw_length_m: 0.038,
  piston_connecting_rod_length_m: 0.1,
  piston_connecting_rod_mass_kg: 0.4,
  piston_head_mass_density_kg_per_m3: 7800.0,
  piston_head_compression_height_m: 0.018,
  piston_head_clearance_height_m: 0.007,
  piston_dynamic_friction_n_m_s_per_r: 0.03,
  piston_static_friction_n_m_s_per_r: 0.9,
  gas_momentum_damping_time_constant_s: 0.53e-3,
  eplenum_wave_pipe_length_m: 0.8,
  mic_position_ratio: 0.05,
  velocity_low_pass_cutoff_frequency_hz: 8000.0,
  chamber_volume_m3: 2.1e-4,
  throttle_volume_mult: 1.0,
  irunner_volume_mult: 1.5,
  injector_volume_mult: 0.02,
  erunner_volume_mult: 0.4,
  eplenum_volume_mult: 0.75,
  exhaust_volume_mult: 0.75,
  max_flow_area_m2: 2.8e-3,
  source_max_flow_mult: 1.3,
  throttle_max_flow_mult: 1.25,
  irunner_max_flow_mult: 0.6,
  injector_max_flow_mult: 0.005,
  piston_max_flow_mult: 0.9,
  erunner_max_flow_mult: 0.45,
  eplenum_max_flow_mult: 1.8,
  exhaust_max_flow_mult: 0.9,
  piston_thetas_r: pistonThetas(8),
  irunner_valve_engage_r: -0.25 * Math.PI,
  irunner_valve_ramp_r: 1.0 * Math.PI,
  piston_valve_engage_r: 2.7 * Math.PI,
  piston_valve_ramp_r: 0.95 * Math.PI,
  sparkplug_engage_r: 2.05 * Math.PI,
  sparkplug_on_r: 0.25 * Math.PI,
  no_throttle: 0.0,
  low_throttle: 0.001,
  mid_throttle: 0.05,
  high_throttle: 1.0,
  crankshaft_mass_kg: 25.3,
  crankshaft_radius_m: 0.031,
  flywheel_mass_kg: 8.15,
  flywheel_radius_m: 0.18,
  limiter_cutoff_r_per_s: 1700.0,
  limiter_relaxed_r_per_s: 50.0,
  starter_rated_torque_n_m: 70.0,
  starter_no_load_r_per_s: 700.0,
  starter_radius_m: 0.015,
  eplenum_assignment: [0, 1, 0, 1, 0, 1, 0, 1],
  num_eplenums: 2,
};
