// Engine blueprints + the two built-in engine configurations
// (ported from engine_blueprints.h, engine_3_cyl.h, engine_8_cyl.h).

import { FOUR_PI_R, TWO_PI_R, SIX_PI_R } from "./constants";
import { Engine } from "./engine";
import { Node, NodeType } from "./nodes";
import { makeChamber } from "./chamber";
import { Piston, Rotor, OpposedPiston, Quasiturbine, Stirling, Turbine, FuelCell, Sparkplug, Valve } from "./mechanical";

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
  // Optional: phase (after irunner engage) at which the intake port begins
  // closing. Piston engines leave this undefined (port stays open until the
  // 4π cycle wrap, the historical behavior). Wankel ports close mid-cycle.
  irunner_valve_close_r?: number;
  piston_valve_engage_r: number;
  piston_valve_ramp_r: number;
  // Optional: phase (after piston/exhaust engage) at which the exhaust port
  // begins closing.
  piston_valve_close_r?: number;
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
  // Rotor (Wankel) fields. When rotor_generating_radius_m is set, buildEngine
  // constructs Rotor power cells instead of slider-crank Pistons; the chamber
  // 4-stroke cycle then spans 6π of eccentric-shaft angle. Piston engines leave
  // these undefined.
  rotor_generating_radius_m?: number;
  rotor_eccentricity_m?: number;
  rotor_width_m?: number;
  rotor_compression_ratio?: number;
  rotor_mass_kg?: number;
  rotor_dynamic_friction_n_m_s_per_r?: number;
  rotor_static_friction_n_m_s_per_r?: number;
  // Compression-ignition (diesel): auto-ignites on temperature instead of a
  // sparkplug. Requires a high compression ratio (small head_clearance_height).
  diesel?: boolean;
  // Intake/exhaust use a sleeve-valve port profile (sine pulse) instead of the
  // poppet-valve bump. When set, the valves' duration_r is used.
  sleeve?: boolean;
  // Opposed-piston (two pistons per cylinder). Reuses piston_diameter_m /
  // piston_crank_throw_length_m / piston_connecting_rod_length_m /
  // piston_connecting_rod_mass_kg for both halves (symmetric).
  opposed?: boolean;
  opposed_offset_r?: number;     // phase between the two cranks
  opposed_clearance_m3?: number; // V_min (gap between pistons at TDC)
  // Quasiturbine (4-chamber direct-drive rotary). Reuses rotor_generating_radius_m
  // / rotor_width_m / rotor_compression_ratio / rotor_mass_kg for geometry.
  quasiturbine?: boolean;
  // Scuderi split-cycle: uses the custom buildScuderi crossover topology.
  scuderi?: boolean;
  // Stirling (external-combustion heat-exchange cycle). Reuses piston geometry.
  stirling?: boolean;
  stirling_T_hot_k?: number;
  stirling_T_cold_k?: number;
  // Steam engine: steam admission (external boiler) instead of combustion.
  // Reuses piston geometry; working fluid becomes H2O at the admission phase.
  steam?: boolean;
  // Gas turbine: continuous-combustion constant-volume combustor + turbine
  // wheel. Single cell (no P·dV); torque = P_gauge · torque_constant.
  turbine?: boolean;
  // Turbojet (jet engine): a turbine configured for thrust — very high-revving
  // spool + a restricted exhaust nozzle (jet roar). Sets is_jet for the thrust
  // gauge (thrust ∝ ω²).
  jet?: boolean;
  turbine_combustor_volume_m3?: number;
  turbine_torque_constant?: number;
  turbine_spool_mass_kg?: number;
  turbine_spool_radius_m?: number;
  // Fuel cell (electrochemical): constant-volume stack, H2 + O2 → H2O drives a
  // motor. Instant torque response (no spool); consumes O2, produces H2O.
  fuelcell?: boolean;
  fuelcell_stack_volume_m3?: number;
  fuelcell_torque_constant?: number;
  fuelcell_rotor_mass_kg?: number;
  fuelcell_rotor_radius_m?: number;
  // 4-stroke cycle length this engine's valves/spark are timed against.
  // Default 4π (4-stroke piston). A 2-stroke uses 2π; a Wankel chamber uses 6π
  // (auto-set when rotor fields are present).
  cycle_r?: number;
}

function chamber(volume: number, area: number, damping: number) {
  const c = makeChamber();
  c.volume_m3 = volume;
  c.nozzle_max_flow_area_m2 = area;
  c.gas_momentum_damping_time_constant_s = damping;
  return c;
}

export function buildEngineFor(cfg: CylConfig): Engine {
  return cfg.scuderi ? buildScuderi(cfg) : buildEngine(cfg);
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

  const isRotor = cfg.rotor_generating_radius_m != null;
  const isOpposed = cfg.opposed ?? false;
  const isQuasiturbine = cfg.quasiturbine ?? false;
  const isStirling = cfg.stirling ?? false;
  const isTurbine = cfg.turbine ?? false;
  const isFuelCell = cfg.fuelcell ?? false;
  const isContinuous = isTurbine || isFuelCell;  // always-open valves (flow-through)
  const cellCycle = cfg.cycle_r ?? (isQuasiturbine ? TWO_PI_R : isRotor ? SIX_PI_R : FOUR_PI_R);

  for (let i = 0; i < N; i++) {
    const theta = cfg.piston_thetas_r[i];

    // irunner
    const ir = new Node(chamber(vIrunner, aIrunner, damp));
    ir.type = NodeType.irunner;
    ir.valve = new Valve();
    ir.valve.cycle_r = cellCycle;
    ir.valve.engage_r = theta + cfg.irunner_valve_engage_r;
    ir.valve.ramp_r = cfg.irunner_valve_ramp_r;
    if (cfg.irunner_valve_close_r != null) ir.valve.close_r = cfg.irunner_valve_close_r;
    if (cfg.sleeve) ir.valve.profile = "sleeve";
    if (isContinuous) ir.valve.close_r = cellCycle;   // continuous intake (always open)
    ir.next = [idx.pist(i)];
    nodes[idx.ir(i)] = ir;

    // injector
    const inj = new Node(chamber(vInjector, aInjector, damp));
    inj.type = NodeType.injector;
    inj.nozzleIndex = idx.ir(i);
    inj.next = [idx.pist(i)];
    nodes[idx.inj(i)] = inj;

    // power cell (piston or rotor)
    const pchamber = chamber(0, aPiston, damp);
    const pvalve = new Valve();
    pvalve.cycle_r = cellCycle;
    pvalve.engage_r = theta + cfg.piston_valve_engage_r;
    pvalve.ramp_r = cfg.piston_valve_ramp_r;
    if (cfg.piston_valve_close_r != null) pvalve.close_r = cfg.piston_valve_close_r;
    if (cfg.sleeve) pvalve.profile = "sleeve";
    if (isContinuous) pvalve.close_r = cellCycle;     // continuous outflow (always open)
    const pspark = new Sparkplug();
    pspark.cycle_r = cellCycle;
    pspark.engage_r = theta + cfg.sparkplug_engage_r;
    pspark.on_r = cfg.sparkplug_on_r;

    let cell: Piston | Rotor | OpposedPiston | Quasiturbine | Stirling | Turbine | FuelCell;
    if (isFuelCell) {
      const fc = new FuelCell(pchamber, pvalve, pspark);
      fc.stack_volume_m3 = cfg.fuelcell_stack_volume_m3!;
      fc.torque_constant = cfg.fuelcell_torque_constant!;
      fc.rotor_mass_kg = cfg.fuelcell_rotor_mass_kg!;
      fc.rotor_radius_m = cfg.fuelcell_rotor_radius_m!;
      fc.dynamic_friction_n_m_s_per_r = cfg.piston_dynamic_friction_n_m_s_per_r;
      fc.static_friction_n_m_s_per_r = cfg.piston_static_friction_n_m_s_per_r;
      cell = fc;
    } else if (isTurbine) {
      const tb = new Turbine(pchamber, pvalve, pspark);
      tb.combustor_volume_m3 = cfg.turbine_combustor_volume_m3!;
      tb.torque_constant = cfg.turbine_torque_constant!;
      tb.spool_mass_kg = cfg.turbine_spool_mass_kg!;
      tb.spool_radius_m = cfg.turbine_spool_radius_m!;
      tb.dynamic_friction_n_m_s_per_r = cfg.piston_dynamic_friction_n_m_s_per_r;
      tb.static_friction_n_m_s_per_r = cfg.piston_static_friction_n_m_s_per_r;
      cell = tb;
    } else if (isQuasiturbine) {
      const qt = new Quasiturbine(pchamber, pvalve, pspark);
      qt.generating_radius_m = cfg.rotor_generating_radius_m!;
      qt.rotor_width_m = cfg.rotor_width_m!;
      qt.compression_ratio = cfg.rotor_compression_ratio!;
      qt.rotor_mass_kg = cfg.rotor_mass_kg!;
      qt.dynamic_friction_n_m_s_per_r = cfg.rotor_dynamic_friction_n_m_s_per_r!;
      qt.static_friction_n_m_s_per_r = cfg.rotor_static_friction_n_m_s_per_r!;
      qt.theta_r = -theta;
      const R = qt.generating_radius_m;
      const b = qt.rotor_width_m;
      qt.swing_m3 = (Math.PI * R * R * b) / 4.0;   // per-chamber swing
      qt.clearance_m3 = qt.swing_m3 / (qt.compression_ratio - 1.0);
      cell = qt;
    } else if (isRotor) {
      const rotor = new Rotor(pchamber, pvalve, pspark);
      rotor.generating_radius_m = cfg.rotor_generating_radius_m!;
      rotor.eccentricity_m = cfg.rotor_eccentricity_m!;
      rotor.rotor_width_m = cfg.rotor_width_m!;
      rotor.compression_ratio = cfg.rotor_compression_ratio!;
      rotor.rotor_mass_kg = cfg.rotor_mass_kg!;
      rotor.dynamic_friction_n_m_s_per_r = cfg.rotor_dynamic_friction_n_m_s_per_r!;
      rotor.static_friction_n_m_s_per_r = cfg.rotor_static_friction_n_m_s_per_r!;
      rotor.theta_r = -theta;
      const e = rotor.eccentricity_m;
      const R = rotor.generating_radius_m;
      const b = rotor.rotor_width_m;
      rotor.swing_m3 = Math.sqrt(3.0) * e * R * b;
      rotor.clearance_m3 = rotor.swing_m3 / (rotor.compression_ratio - 1.0);
      cell = rotor;
    } else if (isOpposed) {
      const op = new OpposedPiston(pchamber, pvalve, pspark);
      op.diameter_m = cfg.piston_diameter_m;
      op.throw_a_m = cfg.piston_crank_throw_length_m;
      op.throw_b_m = cfg.piston_crank_throw_length_m;
      op.connecting_rod_a_m = cfg.piston_connecting_rod_length_m;
      op.connecting_rod_b_m = cfg.piston_connecting_rod_length_m;
      op.mass_a_kg = cfg.piston_connecting_rod_mass_kg;
      op.mass_b_kg = cfg.piston_connecting_rod_mass_kg;
      op.offset_r = cfg.opposed_offset_r ?? 0.0;
      op.clearance_m3 = cfg.opposed_clearance_m3 ?? 1.0e-5;
      op.dynamic_friction_n_m_s_per_r = cfg.piston_dynamic_friction_n_m_s_per_r;
      op.static_friction_n_m_s_per_r = cfg.piston_static_friction_n_m_s_per_r;
      op.theta_r = -theta;
      cell = op;
    } else {
      const piston = isStirling ? new Stirling(pchamber, pvalve, pspark) : new Piston(pchamber, pvalve, pspark);
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
      if (isStirling) {
        const st = piston as Stirling;
        st.T_hot_k = cfg.stirling_T_hot_k ?? 900.0;
        st.T_cold_k = cfg.stirling_T_cold_k ?? 350.0;
      }
      cell = piston;
    }

    const pnode = new Node(pchamber);
    pnode.type = NodeType.piston;
    pnode.piston = cell;
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
  engine.can_ignite = false;
  engine.is_diesel = cfg.diesel ?? false;
  engine.is_steam = cfg.steam ?? false;
  engine.is_turbine = cfg.turbine ?? false;
  engine.is_jet = cfg.jet ?? false;
  engine.is_fuelcell = cfg.fuelcell ?? false;
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
  ...baseCylConfig(),
  name: "Ford 1.0 L EcoBoost I3",
  sound_volume: 0.3,
  radial_spacing: 3.0,
  piston_diameter_m: 0.072,
  piston_crank_throw_length_m: 0.038,
  piston_dynamic_friction_n_m_s_per_r: 0.029,
  eplenum_wave_pipe_length_m: 1.1,
  mic_position_ratio: 0.1,
  velocity_low_pass_cutoff_frequency_hz: 7000.0,
  throttle_volume_mult: 0.1,
  irunner_volume_mult: 0.5,
  eplenum_volume_mult: 0.5,
  exhaust_volume_mult: 0.5,
  max_flow_area_m2: 2.4e-3,
  source_max_flow_mult: 0.3,
  throttle_max_flow_mult: 0.25,
  irunner_max_flow_mult: 0.6,
  piston_max_flow_mult: 0.5,
  erunner_max_flow_mult: 0.45,
  piston_thetas_r: pistonThetas(3),
  crankshaft_mass_kg: 1.3,
  crankshaft_radius_m: 0.07,
  flywheel_mass_kg: 6.15,
  flywheel_radius_m: 0.32,
  limiter_cutoff_r_per_s: 1300.0,
  limiter_relaxed_r_per_s: 100.0,
  eplenum_assignment: [0, 0, 0],
};

export const ENGINE_8_CYL: CylConfig = {
  ...baseCylConfig(),
  name: "Inline 8",
  sound_volume: 0.5,
  radial_spacing: 2.1,
  piston_diameter_m: 0.065,
  piston_crank_throw_length_m: 0.038,
  eplenum_wave_pipe_length_m: 0.8,
  mic_position_ratio: 0.05,
  throttle_volume_mult: 1.0,
  irunner_volume_mult: 1.5,
  eplenum_volume_mult: 0.75,
  exhaust_volume_mult: 0.75,
  max_flow_area_m2: 2.8e-3,
  source_max_flow_mult: 1.3,
  throttle_max_flow_mult: 1.25,
  irunner_max_flow_mult: 0.6,
  piston_max_flow_mult: 0.9,
  erunner_max_flow_mult: 0.45,
  piston_thetas_r: pistonThetas(8),
  crankshaft_mass_kg: 25.3,
  crankshaft_radius_m: 0.031,
  flywheel_mass_kg: 8.15,
  flywheel_radius_m: 0.18,
  limiter_cutoff_r_per_s: 1700.0,
  limiter_relaxed_r_per_s: 50.0,
  num_eplenums: 2,
  eplenum_assignment: [0, 1, 0, 1, 0, 1, 0, 1],
};

// Single-rotor Wankel (rotary). One triangular rotor = 3 chambers phased 2π
// apart on the eccentric shaft; each chamber fires once per shaft revolution
// (one power stroke per rev, like a 2-cyl 4-stroke but smoother). Geometry is
// Mazda-13B-ish per rotor (e=15mm, R=105mm, b=80mm, CR=9). The 3 chambers share
// one eplenum. Port timing (intake/exhaust) is set on the valve engages over
// the 6π chamber cycle; sparkplug at TDC (φ=0).
export const ENGINE_WANKEL_1R: CylConfig = {
  name: "Wankel 1-Rotor",
  sound_volume: 0.4,
  radial_spacing: 3.0,
  source_sink_volume_m3: 1.0e20,
  // Slider-crank piston geometry is unused by the rotor; keep benign values so
  // the shared CylConfig shape stays satisfied.
  piston_diameter_m: 0,
  piston_crank_throw_length_m: 0,
  piston_connecting_rod_length_m: 0,
  piston_connecting_rod_mass_kg: 0,
  piston_head_mass_density_kg_per_m3: 0,
  piston_head_compression_height_m: 0,
  piston_head_clearance_height_m: 0,
  piston_dynamic_friction_n_m_s_per_r: 0,
  piston_static_friction_n_m_s_per_r: 0,
  gas_momentum_damping_time_constant_s: 0.53e-3,
  eplenum_wave_pipe_length_m: 0.9,
  mic_position_ratio: 0.08,
  velocity_low_pass_cutoff_frequency_hz: 8000.0,
  chamber_volume_m3: 2.1e-4,
  throttle_volume_mult: 0.3,
  irunner_volume_mult: 0.6,
  injector_volume_mult: 0.02,
  erunner_volume_mult: 0.4,
  eplenum_volume_mult: 0.6,
  exhaust_volume_mult: 0.6,
  max_flow_area_m2: 2.6e-3,
  source_max_flow_mult: 0.5,
  throttle_max_flow_mult: 0.3,
  irunner_max_flow_mult: 0.7,
  injector_max_flow_mult: 0.005,
  piston_max_flow_mult: 0.6,
  erunner_max_flow_mult: 0.5,
  eplenum_max_flow_mult: 1.8,
  exhaust_max_flow_mult: 0.9,
  // 3 chambers, 2π apart on the eccentric shaft (120° in rotor angle).
  piston_thetas_r: [0, TWO_PI_R, 2.0 * TWO_PI_R],
  // Intake port opens ~2.8π after TDC (start of intake stroke), closes at 4.5π
  // (end of intake) so it's shut during compression. Exhaust port opens ~1.5π
  // after TDC (blowdown at end of power), closes at 3π (end of exhaust). Spark
  // at TDC (φ=0). Durances are phase-from-engage.
  irunner_valve_engage_r: 2.8 * Math.PI,
  irunner_valve_ramp_r: 0.3 * Math.PI,
  irunner_valve_close_r: 1.7 * Math.PI,
  piston_valve_engage_r: 1.5 * Math.PI,
  piston_valve_ramp_r: 0.3 * Math.PI,
  piston_valve_close_r: 1.5 * Math.PI,
  sparkplug_engage_r: 0.0,
  sparkplug_on_r: 0.1 * Math.PI,
  no_throttle: 0.0,
  low_throttle: 0.001,
  mid_throttle: 0.05,
  high_throttle: 1.0,
  crankshaft_mass_kg: 2.0,
  crankshaft_radius_m: 0.05,
  flywheel_mass_kg: 4.0,
  flywheel_radius_m: 0.2,
  limiter_cutoff_r_per_s: 1200.0,
  limiter_relaxed_r_per_s: 80.0,
  starter_rated_torque_n_m: 80.0,
  starter_no_load_r_per_s: 800.0,
  starter_radius_m: 0.015,
  eplenum_assignment: [0, 0, 0],
  num_eplenums: 1,
  // Rotor (Wankel) geometry.
  rotor_generating_radius_m: 0.105,
  rotor_eccentricity_m: 0.015,
  rotor_width_m: 0.080,
  rotor_compression_ratio: 9.0,
  rotor_mass_kg: 3.0,
  rotor_dynamic_friction_n_m_s_per_r: 0.02,
  rotor_static_friction_n_m_s_per_r: 0.6,
};

// ---------------------------------------------------------------------------
// Wave 1 engine configs.
//
// These reuse the generic node topology + slider-crank Piston (or the Rotor for
// the 2-rotor). They differ only in cylinder count, phasing, exhaust-manifold
// grouping (eplenum_assignment), geometry, and rev range — which is exactly
// what gives each its sound. baseCylConfig() supplies the shared plumbing
// defaults (volumes, flow areas, damping, throttle steps, starter); each engine
// overrides the bits that define its character.
// ---------------------------------------------------------------------------

function baseCylConfig(): CylConfig {
  return {
    name: "",
    sound_volume: 0.4,
    radial_spacing: 2.4,
    source_sink_volume_m3: 1.0e20,
    piston_diameter_m: 0.086,
    piston_crank_throw_length_m: 0.043,
    piston_connecting_rod_length_m: 0.1,
    piston_connecting_rod_mass_kg: 0.4,
    piston_head_mass_density_kg_per_m3: 7800.0,
    piston_head_compression_height_m: 0.018,
    piston_head_clearance_height_m: 0.007,
    piston_dynamic_friction_n_m_s_per_r: 0.03,
    piston_static_friction_n_m_s_per_r: 0.9,
    gas_momentum_damping_time_constant_s: 0.53e-3,
    eplenum_wave_pipe_length_m: 0.9,
    mic_position_ratio: 0.08,
    velocity_low_pass_cutoff_frequency_hz: 8000.0,
    chamber_volume_m3: 2.1e-4,
    throttle_volume_mult: 0.3,
    irunner_volume_mult: 0.6,
    injector_volume_mult: 0.02,
    erunner_volume_mult: 0.4,
    eplenum_volume_mult: 0.6,
    exhaust_volume_mult: 0.6,
    max_flow_area_m2: 2.6e-3,
    source_max_flow_mult: 0.5,
    throttle_max_flow_mult: 0.3,
    irunner_max_flow_mult: 0.7,
    injector_max_flow_mult: 0.005,
    piston_max_flow_mult: 0.6,
    erunner_max_flow_mult: 0.5,
    eplenum_max_flow_mult: 1.8,
    exhaust_max_flow_mult: 0.9,
    piston_thetas_r: [],
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
    crankshaft_mass_kg: 8.0,
    crankshaft_radius_m: 0.05,
    flywheel_mass_kg: 6.0,
    flywheel_radius_m: 0.25,
    limiter_cutoff_r_per_s: 1200.0,
    limiter_relaxed_r_per_s: 80.0,
    starter_rated_torque_n_m: 70.0,
    starter_no_load_r_per_s: 700.0,
    starter_radius_m: 0.015,
    eplenum_assignment: [],
    num_eplenums: 1,
  };
}

export const ENGINE_SINGLE_CYL: CylConfig = {
  ...baseCylConfig(),
  name: "Big Single 650",
  sound_volume: 0.45,
  radial_spacing: 3.0,
  piston_thetas_r: [0],
  eplenum_assignment: [0],
  num_eplenums: 1,
  crankshaft_mass_kg: 1.5,
  flywheel_mass_kg: 8.0,
  flywheel_radius_m: 0.30,
  limiter_cutoff_r_per_s: 900.0,
};

export const ENGINE_PARALLEL_TWIN: CylConfig = {
  ...baseCylConfig(),
  name: "Parallel Twin 650",
  sound_volume: 0.4,
  piston_thetas_r: pistonThetas(2),
  eplenum_assignment: [0, 0],
  num_eplenums: 1,
  crankshaft_mass_kg: 2.5,
  flywheel_mass_kg: 7.0,
  flywheel_radius_m: 0.28,
  limiter_cutoff_r_per_s: 1000.0,
};

export const ENGINE_I4: CylConfig = {
  ...baseCylConfig(),
  name: "Inline 4 2.0L",
  sound_volume: 0.4,
  piston_thetas_r: pistonThetas(4),
  eplenum_assignment: [0, 0, 0, 0],
  num_eplenums: 1,
  crankshaft_mass_kg: 6.0,
  flywheel_mass_kg: 6.0,
  flywheel_radius_m: 0.22,
  limiter_cutoff_r_per_s: 1300.0,
};

export const ENGINE_I6: CylConfig = {
  ...baseCylConfig(),
  name: "Inline 6 3.0L",
  sound_volume: 0.45,
  radial_spacing: 2.0,
  piston_thetas_r: pistonThetas(6),
  eplenum_assignment: [0, 0, 0, 0, 0, 0],
  num_eplenums: 1,
  crankshaft_mass_kg: 12.0,
  flywheel_mass_kg: 7.0,
  flywheel_radius_m: 0.22,
  limiter_cutoff_r_per_s: 1300.0,
};

export const ENGINE_V8: CylConfig = {
  ...baseCylConfig(),
  name: "V8 5.0L",
  sound_volume: 0.5,
  piston_diameter_m: 0.092,
  piston_crank_throw_length_m: 0.043,
  piston_thetas_r: pistonThetas(8),
  // Two banks of four (4-into-1 each) — the classic V8 dual-exhaust burble.
  eplenum_assignment: [0, 0, 0, 0, 1, 1, 1, 1],
  num_eplenums: 2,
  crankshaft_mass_kg: 22.0,
  flywheel_mass_kg: 8.0,
  flywheel_radius_m: 0.20,
  limiter_cutoff_r_per_s: 1100.0,
};

export const ENGINE_V12: CylConfig = {
  ...baseCylConfig(),
  name: "V12 6.0L",
  sound_volume: 0.5,
  radial_spacing: 1.8,
  piston_diameter_m: 0.084,
  piston_crank_throw_length_m: 0.045,
  piston_thetas_r: pistonThetas(12),
  eplenum_assignment: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1],
  num_eplenums: 2,
  crankshaft_mass_kg: 30.0,
  flywheel_mass_kg: 9.0,
  flywheel_radius_m: 0.20,
  limiter_cutoff_r_per_s: 1100.0,
};

export const ENGINE_FLAT6: CylConfig = {
  ...baseCylConfig(),
  name: "Flat 6 3.0L",
  sound_volume: 0.45,
  piston_diameter_m: 0.091,
  piston_crank_throw_length_m: 0.038,
  piston_thetas_r: pistonThetas(6),
  // Boxer: two banks of three, opposed.
  eplenum_assignment: [0, 0, 0, 1, 1, 1],
  num_eplenums: 2,
  crankshaft_mass_kg: 10.0,
  flywheel_mass_kg: 7.0,
  flywheel_radius_m: 0.22,
  limiter_cutoff_r_per_s: 1200.0,
};

export const ENGINE_RADIAL9: CylConfig = {
  ...baseCylConfig(),
  name: "Radial 9-cyl",
  sound_volume: 0.55,
  radial_spacing: 2.8,
  piston_diameter_m: 0.120,
  piston_crank_throw_length_m: 0.060,
  piston_connecting_rod_length_m: 0.14,
  // Single master throw for all 9 (radial): evenly spaced over the 4π cycle.
  piston_thetas_r: pistonThetas(9),
  eplenum_assignment: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  num_eplenums: 1,
  crankshaft_mass_kg: 18.0,
  crankshaft_radius_m: 0.07,
  flywheel_mass_kg: 12.0,
  flywheel_radius_m: 0.30,
  limiter_cutoff_r_per_s: 500.0,
};

// 2-rotor Wankel (13B-style): two rotors = 6 chambers, 2 eplenums (one per
// rotor). Same epitrochoid geometry as the 1-rotor; fires twice per shaft
// revolution (one per rotor).
export const ENGINE_WANKEL_2R: CylConfig = {
  ...ENGINE_WANKEL_1R,
  name: "Wankel 2-Rotor",
  sound_volume: 0.5,
  radial_spacing: 2.4,
  piston_thetas_r: [0, TWO_PI_R, 2.0 * TWO_PI_R, 0, TWO_PI_R, 2.0 * TWO_PI_R],
  eplenum_assignment: [0, 0, 0, 1, 1, 1],
  num_eplenums: 2,
  flywheel_mass_kg: 5.0,
  limiter_cutoff_r_per_s: 1200.0,
};

// 2-stroke single: the 4-stroke cycle is 2π here (one firing per rev). Both
// intake and exhaust are ports uncovered near BDC (around φ=π); spark at TDC.
// Port windows are short and overlap around BDC.
export const ENGINE_2STROKE_SINGLE: CylConfig = {
  ...baseCylConfig(),
  name: "2-Stroke 125",
  sound_volume: 0.45,
  radial_spacing: 3.0,
  piston_diameter_m: 0.054,
  piston_crank_throw_length_m: 0.027,
  piston_head_compression_height_m: 0.012,
  piston_head_clearance_height_m: 0.005,
  cycle_r: TWO_PI_R,
  piston_thetas_r: [0],
  eplenum_assignment: [0],
  num_eplenums: 1,
  // 2-stroke port timing (engage as phase-from-TDC over the 2π cycle).
  irunner_valve_engage_r: 0.9 * Math.PI,   // intake port opens before BDC
  irunner_valve_ramp_r: 0.15 * Math.PI,
  irunner_valve_close_r: 0.3 * Math.PI,     // closes shortly after BDC
  piston_valve_engage_r: 0.85 * Math.PI,   // exhaust port opens (blowdown)
  piston_valve_ramp_r: 0.15 * Math.PI,
  piston_valve_close_r: 0.35 * Math.PI,
  sparkplug_engage_r: 0.0,
  sparkplug_on_r: 0.08 * Math.PI,
  crankshaft_mass_kg: 1.0,
  flywheel_mass_kg: 4.0,
  flywheel_radius_m: 0.18,
  limiter_cutoff_r_per_s: 1400.0,
};

// --- Wave 2 ----------------------------------------------------------------

// Compression-ignition inline-6 diesel. High compression ratio (tiny
// head_clearance → CR ~20) gives compression temps well past the auto-ignition
// threshold, so it fires without a sparkplug (engine.is_diesel). The sparkplug
// timing is kept for the ignition indicator only. Heavy, low-revving.
export const ENGINE_DIESEL_I6: CylConfig = {
  ...baseCylConfig(),
  name: "Diesel I6 4.5L",
  sound_volume: 0.5,
  radial_spacing: 2.0,
  piston_diameter_m: 0.098,
  piston_crank_throw_length_m: 0.061,
  piston_connecting_rod_length_m: 0.16,
  piston_head_compression_height_m: 0.020,
  piston_head_clearance_height_m: 0.0065,   // CR = (2·0.061+0.0065)/0.0065 ≈ 20
  diesel: true,
  piston_thetas_r: pistonThetas(6),
  eplenum_assignment: [0, 0, 0, 0, 0, 0],
  num_eplenums: 1,
  crankshaft_mass_kg: 25.0,
  flywheel_mass_kg: 14.0,
  flywheel_radius_m: 0.28,
  limiter_cutoff_r_per_s: 470.0,             // ~4500 rpm
  starter_rated_torque_n_m: 120.0,
};

// Sleeve-valve inline-6 (Knight/Bristol style): the intake/exhaust ports use a
// smooth sine pulse (wider, gentler than poppet events) instead of the bump.
// Same slider-crank pistons; only the port profile differs. The wide ramp_r is
// the sleeve window width.
export const ENGINE_SLEEVE_I6: CylConfig = {
  ...baseCylConfig(),
  name: "Sleeve-Valve I6",
  sound_volume: 0.45,
  radial_spacing: 2.0,
  piston_diameter_m: 0.090,
  piston_crank_throw_length_m: 0.045,
  sleeve: true,
  piston_thetas_r: pistonThetas(6),
  eplenum_assignment: [0, 0, 0, 0, 0, 0],
  num_eplenums: 1,
  // Sleeve port windows (ramp_r = sine window width). Narrow enough to close
  // before compression (else the charge leaks back), wider than a poppet bump.
  irunner_valve_engage_r: -0.1 * Math.PI,
  irunner_valve_ramp_r: 1.2 * Math.PI,
  piston_valve_engage_r: 3.0 * Math.PI,     // exhaust opens at BDC (not mid-power)
  piston_valve_ramp_r: 1.3 * Math.PI,
  crankshaft_mass_kg: 12.0,
  flywheel_mass_kg: 8.0,
  flywheel_radius_m: 0.24,
  limiter_cutoff_r_per_s: 1000.0,
};

// Opposed-piston 2-stroke twin (Junkers Jumo style): two pistons per cylinder
// facing each other, no head, ported. Ported 2-stroke timing (cycle 2π); the
// exhaust crank leads the intake crank by opposed_offset_r.
export const ENGINE_OPPOSED_TWIN: CylConfig = {
  ...baseCylConfig(),
  name: "Opposed-Piston Twin",
  sound_volume: 0.5,
  radial_spacing: 2.8,
  piston_diameter_m: 0.086,
  piston_crank_throw_length_m: 0.040,
  piston_connecting_rod_length_m: 0.12,
  piston_connecting_rod_mass_kg: 0.5,
  opposed: true,
  opposed_offset_r: 0.15 * Math.PI,
  opposed_clearance_m3: 8.0e-5,             // V_max≈9.4e-4 → CR ≈ 12
  cycle_r: TWO_PI_R,                        // 2-stroke
  piston_thetas_r: pistonThetas(2),
  eplenum_assignment: [0, 0],
  num_eplenums: 1,
  // 2-stroke port timing.
  irunner_valve_engage_r: 0.9 * Math.PI,
  irunner_valve_ramp_r: 0.15 * Math.PI,
  irunner_valve_close_r: 0.3 * Math.PI,
  piston_valve_engage_r: 0.85 * Math.PI,
  piston_valve_ramp_r: 0.15 * Math.PI,
  piston_valve_close_r: 0.35 * Math.PI,
  sparkplug_engage_r: 0.0,
  sparkplug_on_r: 0.08 * Math.PI,
  crankshaft_mass_kg: 4.0,
  flywheel_mass_kg: 7.0,
  flywheel_radius_m: 0.24,
  limiter_cutoff_r_per_s: 900.0,
};

// --- More engine configs ----------------------------------------------------

// 45° V-twin (Harley style): single crank pin, uneven firing (315°/405° gaps)
// → the lumpy "potato-potato" idle. Both cylinders share one exhaust.
export const ENGINE_V_TWIN: CylConfig = {
  ...baseCylConfig(),
  name: "V-Twin 45°",
  sound_volume: 0.5,
  radial_spacing: 3.2,
  piston_diameter_m: 0.098,
  piston_crank_throw_length_m: 0.060,
  piston_connecting_rod_length_m: 0.13,
  piston_thetas_r: [0.0, 1.75 * Math.PI],   // uneven (315° then 405°)
  eplenum_assignment: [0, 0],
  num_eplenums: 1,
  crankshaft_mass_kg: 3.0,
  flywheel_mass_kg: 9.0,
  flywheel_radius_m: 0.30,
  limiter_cutoff_r_per_s: 700.0,
};

// 60° V6: two banks of three, even firing (120°).
export const ENGINE_V6: CylConfig = {
  ...baseCylConfig(),
  name: "V6 3.2L",
  sound_volume: 0.45,
  piston_diameter_m: 0.084,
  piston_crank_throw_length_m: 0.042,
  piston_thetas_r: pistonThetas(6),
  eplenum_assignment: [0, 0, 0, 1, 1, 1],
  num_eplenums: 2,
  crankshaft_mass_kg: 11.0,
  flywheel_mass_kg: 7.0,
  flywheel_radius_m: 0.22,
  limiter_cutoff_r_per_s: 1200.0,
};

// Flat-twin (boxer, BMW style): opposed pistons, 180° crank, one exhaust per
// side (two eplenums) for the boxer burble.
export const ENGINE_FLAT_TWIN: CylConfig = {
  ...baseCylConfig(),
  name: "Flat-Twin Boxer",
  sound_volume: 0.45,
  radial_spacing: 3.2,
  piston_diameter_m: 0.092,
  piston_crank_throw_length_m: 0.038,
  piston_thetas_r: [0.0, Math.PI],          // 180° opposed
  eplenum_assignment: [0, 1],
  num_eplenums: 2,
  crankshaft_mass_kg: 3.0,
  flywheel_mass_kg: 8.0,
  flywheel_radius_m: 0.26,
  limiter_cutoff_r_per_s: 900.0,
};

// Inline 5: odd count, even firing (144°), distinctive offbeat note.
export const ENGINE_I5: CylConfig = {
  ...baseCylConfig(),
  name: "Inline 5 2.5L",
  sound_volume: 0.45,
  radial_spacing: 2.2,
  piston_thetas_r: pistonThetas(5),
  eplenum_assignment: [0, 0, 0, 0, 0],
  num_eplenums: 1,
  crankshaft_mass_kg: 9.0,
  flywheel_mass_kg: 7.0,
  flywheel_radius_m: 0.22,
  limiter_cutoff_r_per_s: 1250.0,
};

// 3-rotor Wankel (Mazda 20B style): three rotors = 9 chambers, one eplenum
// per rotor. Fires three times per shaft revolution.
export const ENGINE_WANKEL_3R: CylConfig = {
  ...ENGINE_WANKEL_1R,
  name: "Wankel 3-Rotor",
  sound_volume: 0.55,
  radial_spacing: 2.0,
  piston_thetas_r: [0, TWO_PI_R, 2.0 * TWO_PI_R, 0, TWO_PI_R, 2.0 * TWO_PI_R, 0, TWO_PI_R, 2.0 * TWO_PI_R],
  eplenum_assignment: [0, 0, 0, 1, 1, 1, 2, 2, 2],
  num_eplenums: 3,
  flywheel_mass_kg: 6.0,
  limiter_cutoff_r_per_s: 1200.0,
};

// Diesel V8: compression-ignition, two banks of four, heavy and low-revving.
export const ENGINE_DIESEL_V8: CylConfig = {
  ...ENGINE_DIESEL_I6,
  name: "Diesel V8 6.5L",
  sound_volume: 0.55,
  piston_diameter_m: 0.098,
  piston_crank_throw_length_m: 0.061,
  piston_thetas_r: pistonThetas(8),
  eplenum_assignment: [0, 0, 0, 0, 1, 1, 1, 1],
  num_eplenums: 2,
  crankshaft_mass_kg: 32.0,
  flywheel_mass_kg: 16.0,
  limiter_cutoff_r_per_s: 470.0,
};

// 2-stroke triple: three cylinders, ported, fires every 120° (three times per
// rev). Loud and raspy.
export const ENGINE_2STROKE_TRIPLE: CylConfig = {
  ...ENGINE_2STROKE_SINGLE,
  name: "2-Stroke Triple",
  sound_volume: 0.5,
  radial_spacing: 2.6,
  cycle_r: TWO_PI_R,
  piston_thetas_r: [0.0, TWO_PI_R / 3.0, (2.0 * TWO_PI_R) / 3.0],
  eplenum_assignment: [0, 0, 0],
  num_eplenums: 1,
  crankshaft_mass_kg: 2.0,
  flywheel_mass_kg: 5.0,
  flywheel_radius_m: 0.20,
  limiter_cutoff_r_per_s: 1300.0,
};

// --- Wave 3 (1/N): quasiturbine ------------------------------------------------
// 4-chamber direct-drive rotary, 2-stroke. The rotor is on the shaft (1:1, no
// Wankel gearing); four chambers phased π/2 apart → four firings per shaft
// revolution (very smooth). Ported 2-stroke timing.
export const ENGINE_QUASITURBINE: CylConfig = {
  ...baseCylConfig(),
  name: "Quasiturbine",
  sound_volume: 0.5,
  radial_spacing: 2.6,
  quasiturbine: true,
  cycle_r: TWO_PI_R,                        // 2-stroke
  rotor_generating_radius_m: 0.080,
  rotor_width_m: 0.060,
  rotor_compression_ratio: 8.0,
  rotor_mass_kg: 2.0,
  rotor_dynamic_friction_n_m_s_per_r: 0.02,
  rotor_static_friction_n_m_s_per_r: 0.5,
  // 4 chambers phased π/2 apart on the shaft.
  piston_thetas_r: [0.0, 0.5 * Math.PI, Math.PI, 1.5 * Math.PI],
  eplenum_assignment: [0, 0, 0, 0],
  num_eplenums: 1,
  irunner_valve_engage_r: 0.9 * Math.PI,
  irunner_valve_ramp_r: 0.15 * Math.PI,
  irunner_valve_close_r: 0.3 * Math.PI,
  piston_valve_engage_r: 0.85 * Math.PI,
  piston_valve_ramp_r: 0.15 * Math.PI,
  piston_valve_close_r: 0.35 * Math.PI,
  sparkplug_engage_r: 0.0,
  sparkplug_on_r: 0.08 * Math.PI,
  crankshaft_mass_kg: 3.0,
  flywheel_mass_kg: 5.0,
  flywheel_radius_m: 0.20,
  limiter_cutoff_r_per_s: 1300.0,
};

// --- Wave 3 (2-4/N): Stirling, Steam, Gas turbine ---------------------------

// Stirling (external-combustion, heat-exchange cycle). No sparkplug/combustion
// (sparkplug_on_r = 0); the StirlingPowerCell heats the charge toward T_hot on
// expansion and cools toward T_cold on compression. Single cylinder, low-rev.
export const ENGINE_STIRLING: CylConfig = {
  ...baseCylConfig(),
  name: "Stirling Engine",
  sound_volume: 0.4,
  radial_spacing: 3.2,
  piston_diameter_m: 0.090,
  piston_crank_throw_length_m: 0.045,
  stirling: true,
  stirling_T_hot_k: 900.0,
  stirling_T_cold_k: 350.0,
  piston_thetas_r: [0],
  eplenum_assignment: [0],
  num_eplenums: 1,
  sparkplug_on_r: 0.0,                      // no internal combustion
  crankshaft_mass_kg: 2.0,
  flywheel_mass_kg: 10.0,
  flywheel_radius_m: 0.30,
  limiter_cutoff_r_per_s: 400.0,
};

// Steam reciprocating engine: external boiler, steam admission instead of
// combustion. The sparkplug window is reused as the steam-admission window.
export const ENGINE_STEAM: CylConfig = {
  ...baseCylConfig(),
  name: "Steam Engine",
  sound_volume: 0.45,
  radial_spacing: 3.2,
  piston_diameter_m: 0.090,
  piston_crank_throw_length_m: 0.045,
  piston_head_clearance_height_m: 0.010,   // low CR (steam doesn't compress)
  steam: true,
  piston_thetas_r: [0],
  eplenum_assignment: [0],
  num_eplenums: 1,
  sparkplug_engage_r: 0.0,                  // admission at TDC
  sparkplug_on_r: 0.15 * Math.PI,
  crankshaft_mass_kg: 3.0,
  flywheel_mass_kg: 12.0,
  flywheel_radius_m: 0.32,
  limiter_cutoff_r_per_s: 350.0,
};

// Gas turbine (simplified Brayton / turbo-shaft): constant-volume combustor,
// continuous combustion, turbine-wheel torque = P_gauge · K. High-revving spool.
export const ENGINE_TURBINE: CylConfig = {
  ...baseCylConfig(),
  name: "Gas Turbine",
  sound_volume: 0.45,
  radial_spacing: 3.2,
  turbine: true,
  turbine_combustor_volume_m3: 5.0e-4,
  turbine_torque_constant: 1.2e4,            // torque = K · burn_rate · (0.15+0.85·throttle)
  turbine_spool_mass_kg: 2.0,
  turbine_spool_radius_m: 0.08,
  piston_dynamic_friction_n_m_s_per_r: 0.008,
  piston_static_friction_n_m_s_per_r: 0.2,
  piston_thetas_r: [0],
  eplenum_assignment: [0],
  num_eplenums: 1,
  sparkplug_on_r: 0.0,                      // continuous, no spark
  crankshaft_mass_kg: 1.5,
  flywheel_mass_kg: 0.0,
  flywheel_radius_m: 0.08,                  // sane starter gear ratio → starter cuts ~130 r/s, then combustion takes over
  limiter_cutoff_r_per_s: 4000.0,
};

// Turbojet (jet engine): a turbine configured for thrust — a very high-revving
// spool with a restricted exhaust nozzle (convergent jet nozzle) that builds
// pressure for a jet roar, distinct from the steady turbine whine. The thrust
// gauge (thrust ∝ ω²) is shown in the UI when is_jet.
export const ENGINE_JET: CylConfig = {
  ...ENGINE_TURBINE,
  name: "Jet Engine (Turbojet)",
  sound_volume: 0.55,
  jet: true,
  turbine_torque_constant: 2.4e4,           // higher → higher-revving spool
  limiter_cutoff_r_per_s: 3000.0,           // ~28k rpm spool
};

// Fuel cell (PEM): electrochemical H2 + O2 → H2O drives an electric motor.
// Constant-volume stack (no P·dV); torque = K × reaction_rate (instant, no
// spool). Consumes O2 from the air charge, produces H2O, runs far cooler than a
// combustor. Silent, instant-response power — press D to enable the reaction.
export const ENGINE_FUELCELL: CylConfig = {
  ...baseCylConfig(),
  name: "Fuel Cell (PEM)",
  sound_volume: 0.3,
  radial_spacing: 3.0,
  fuelcell: true,
  fuelcell_stack_volume_m3: 5.0e-4,
  fuelcell_torque_constant: 220,           // torque = K × reaction_rate (0..1)
  fuelcell_rotor_mass_kg: 1.2,
  fuelcell_rotor_radius_m: 0.06,
  piston_dynamic_friction_n_m_s_per_r: 0.01,
  piston_static_friction_n_m_s_per_r: 0.2,
  piston_thetas_r: [0],
  eplenum_assignment: [0],
  num_eplenums: 1,
  sparkplug_on_r: 0.0,                    // no spark — electrochemical
  crankshaft_mass_kg: 1.0,
  flywheel_mass_kg: 1.5,
  flywheel_radius_m: 0.06,
  limiter_cutoff_r_per_s: 2000.0,
};

// --- Scuderi split-cycle (custom crossover topology) ------------------------

// One Scuderi split-pair: a compressor piston A (no spark) pumps charge
// through a crossover plenum into a power piston B (spark). A and B are 180°
// apart (A compresses while B is at BDC receiving). The crossover plenum stores
// the compressed charge between them.
export function buildScuderi(cfg: CylConfig): Engine {
  const numEpl = cfg.num_eplenums;
  const total = 2 + 4 + 1 + 4 + 2 * numEpl + 1;
  const nodes: Node[] = new Array(total);
  const vChamber = cfg.chamber_volume_m3;
  const damp = cfg.gas_momentum_damping_time_constant_s;
  const A = cfg.max_flow_area_m2;
  const vPlenum = vChamber * 0.8;

  const idx = {
    source: 0, throttle: 1,
    irA: 2, injA: 3, pistA: 4, erA: 5,
    xover: 6,
    irB: 7, injB: 8, pistB: 9, erB: 10,
    eplenum: (k: number) => 11 + 2 * k,
    exhaust: (k: number) => 11 + 2 * k + 1,
    sink: 11 + 2 * numEpl,
  };
  const mkNode = (type: NodeType, vol: number, area: number, next: number[]): Node => {
    const n = new Node(chamber(vol, area, damp));
    n.type = type; n.next = next;
    return n;
  };

  nodes[idx.source] = mkNode(NodeType.source, cfg.source_sink_volume_m3, cfg.source_max_flow_mult * A, [idx.throttle]);
  nodes[idx.throttle] = mkNode(NodeType.throttle, vChamber * cfg.throttle_volume_mult, cfg.throttle_max_flow_mult * A, [idx.irA]);

  // --- Cylinder A (compressor) ---
  const thetaA = cfg.piston_thetas_r[0] ?? 0;
  const irA = new Node(chamber(vChamber * cfg.irunner_volume_mult, cfg.irunner_max_flow_mult * A, damp));
  irA.type = NodeType.irunner; irA.valve = new Valve();
  irA.valve.engage_r = thetaA + cfg.irunner_valve_engage_r; irA.valve.ramp_r = cfg.irunner_valve_ramp_r;
  irA.next = [idx.pistA]; nodes[idx.irA] = irA;
  const injA = new Node(chamber(vChamber * cfg.injector_volume_mult, cfg.injector_max_flow_mult * A, damp));
  injA.type = NodeType.injector; injA.nozzleIndex = idx.irA; injA.next = [idx.pistA]; nodes[idx.injA] = injA;
  const pchA = chamber(0, cfg.piston_max_flow_mult * A, damp);
  const pvA = new Valve(); pvA.engage_r = thetaA + cfg.piston_valve_engage_r; pvA.ramp_r = cfg.piston_valve_ramp_r;
  const spA = new Sparkplug(); spA.engage_r = thetaA + cfg.sparkplug_engage_r; spA.on_r = 0.0;  // A never fires
  const pistA = new Piston(pchA, pvA, spA);
  pistA.diameter_m = cfg.piston_diameter_m; pistA.theta_r = -thetaA;
  pistA.crank_throw_length_m = cfg.piston_crank_throw_length_m;
  pistA.connecting_rod_length_m = cfg.piston_connecting_rod_length_m;
  pistA.connecting_rod_mass_kg = cfg.piston_connecting_rod_mass_kg;
  pistA.head_mass_density_kg_per_m3 = cfg.piston_head_mass_density_kg_per_m3;
  pistA.head_compression_height_m = cfg.piston_head_compression_height_m;
  pistA.head_clearance_height_m = cfg.piston_head_clearance_height_m;
  pistA.dynamic_friction_n_m_s_per_r = cfg.piston_dynamic_friction_n_m_s_per_r;
  pistA.static_friction_n_m_s_per_r = cfg.piston_static_friction_n_m_s_per_r;
  const nodeA = new Node(pchA); nodeA.type = NodeType.piston; nodeA.piston = pistA;
  nodeA.next = [idx.erA]; nodes[idx.pistA] = nodeA;
  nodes[idx.erA] = mkNode(NodeType.erunner, vChamber * cfg.erunner_volume_mult, cfg.erunner_max_flow_mult * A, [idx.xover]);

  // Crossover plenum (stores A's compressed charge for B).
  nodes[idx.xover] = mkNode(NodeType.iplenum, vPlenum, cfg.eplenum_max_flow_mult * A, [idx.irB]);

  // --- Cylinder B (power) ---
  const thetaB = cfg.piston_thetas_r[1] ?? Math.PI;   // 180° from A
  const irB = new Node(chamber(vChamber * cfg.irunner_volume_mult, cfg.irunner_max_flow_mult * A, damp));
  irB.type = NodeType.irunner; irB.valve = new Valve();
  irB.valve.engage_r = thetaB + cfg.irunner_valve_engage_r; irB.valve.ramp_r = cfg.irunner_valve_ramp_r;
  irB.next = [idx.pistB]; nodes[idx.irB] = irB;
  const injB = new Node(chamber(vChamber * cfg.injector_volume_mult, cfg.injector_max_flow_mult * A, damp));
  injB.type = NodeType.injector; injB.nozzleIndex = idx.irB; injB.next = [idx.pistB]; nodes[idx.injB] = injB;
  const pchB = chamber(0, cfg.piston_max_flow_mult * A, damp);
  const pvB = new Valve(); pvB.engage_r = thetaB + cfg.piston_valve_engage_r; pvB.ramp_r = cfg.piston_valve_ramp_r;
  const spB = new Sparkplug(); spB.engage_r = thetaB + cfg.sparkplug_engage_r; spB.on_r = cfg.sparkplug_on_r;
  const pistB = new Piston(pchB, pvB, spB);
  pistB.diameter_m = cfg.piston_diameter_m; pistB.theta_r = -thetaB;
  pistB.crank_throw_length_m = cfg.piston_crank_throw_length_m;
  pistB.connecting_rod_length_m = cfg.piston_connecting_rod_length_m;
  pistB.connecting_rod_mass_kg = cfg.piston_connecting_rod_mass_kg;
  pistB.head_mass_density_kg_per_m3 = cfg.piston_head_mass_density_kg_per_m3;
  pistB.head_compression_height_m = cfg.piston_head_compression_height_m;
  pistB.head_clearance_height_m = cfg.piston_head_clearance_height_m;
  pistB.dynamic_friction_n_m_s_per_r = cfg.piston_dynamic_friction_n_m_s_per_r;
  pistB.static_friction_n_m_s_per_r = cfg.piston_static_friction_n_m_s_per_r;
  const nodeB = new Node(pchB); nodeB.type = NodeType.piston; nodeB.piston = pistB;
  nodeB.next = [idx.erB]; nodes[idx.pistB] = nodeB;
  nodes[idx.erB] = mkNode(NodeType.erunner, vChamber * cfg.erunner_volume_mult, cfg.erunner_max_flow_mult * A, [idx.eplenum(0)]);

  for (let k = 0; k < numEpl; k++) {
    const epl = new Node(chamber(vChamber * cfg.eplenum_volume_mult, cfg.eplenum_max_flow_mult * A, damp));
    epl.type = NodeType.eplenum; epl.waveIndex = k; epl.useCfd = true;
    epl.pipeLengthM = cfg.eplenum_wave_pipe_length_m;
    epl.micPositionRatio = cfg.mic_position_ratio;
    epl.velocityLowPassCutoffFrequencyHz = cfg.velocity_low_pass_cutoff_frequency_hz;
    epl.next = [idx.exhaust(k)]; nodes[idx.eplenum(k)] = epl;
    nodes[idx.exhaust(k)] = mkNode(NodeType.exhaust, vChamber * cfg.exhaust_volume_mult, cfg.exhaust_max_flow_mult * A, [idx.sink]);
  }
  nodes[idx.sink] = mkNode(NodeType.sink, cfg.source_sink_volume_m3, 0, []);

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
  engine.can_ignite = false;
  engine.is_diesel = cfg.diesel ?? false;
  engine.is_steam = cfg.steam ?? false;
  engine.is_turbine = cfg.turbine ?? false;
  engine.is_jet = cfg.jet ?? false;
  engine.is_fuelcell = cfg.fuelcell ?? false;
  engine.volume = cfg.sound_volume;
  engine.no_throttle = cfg.no_throttle;
  engine.low_throttle = cfg.low_throttle;
  engine.mid_throttle = cfg.mid_throttle;
  engine.high_throttle = cfg.high_throttle;
  engine.radial_spacing = cfg.radial_spacing;
  return engine;
}

export const ENGINE_SCUDERI: CylConfig = {
  ...baseCylConfig(),
  name: "Scuderi Split-Cycle",
  sound_volume: 0.5,
  radial_spacing: 2.8,
  scuderi: true,
  piston_diameter_m: 0.086,
  piston_crank_throw_length_m: 0.043,
  piston_thetas_r: [0.0, Math.PI],          // A (compressor) + B (power) 180° apart
  eplenum_assignment: [0],
  num_eplenums: 1,
  crankshaft_mass_kg: 8.0,
  flywheel_mass_kg: 8.0,
  flywheel_radius_m: 0.24,
  limiter_cutoff_r_per_s: 1000.0,
};

// Single source of truth for the engine roster. ALL_ENGINES is the flat,
// id-stable list (index = engine id used by OP.SWITCH); ENGINE_GROUPS is the
// same engines presented by family for the UI dropdown (configs are refs into
// ALL_ENGINES, so ids are looked up, not hardcoded).
export const ALL_ENGINES: CylConfig[] = [
  ENGINE_8_CYL, ENGINE_3_CYL, ENGINE_WANKEL_1R,
  ENGINE_SINGLE_CYL, ENGINE_PARALLEL_TWIN, ENGINE_I4, ENGINE_I6,
  ENGINE_V8, ENGINE_V12, ENGINE_FLAT6, ENGINE_RADIAL9,
  ENGINE_WANKEL_2R, ENGINE_2STROKE_SINGLE,
  ENGINE_DIESEL_I6, ENGINE_SLEEVE_I6, ENGINE_OPPOSED_TWIN,
  ENGINE_V_TWIN, ENGINE_V6, ENGINE_FLAT_TWIN, ENGINE_I5, ENGINE_WANKEL_3R,
  ENGINE_DIESEL_V8, ENGINE_2STROKE_TRIPLE, ENGINE_QUASITURBINE,
  ENGINE_STIRLING, ENGINE_STEAM, ENGINE_TURBINE, ENGINE_SCUDERI,
  ENGINE_JET, ENGINE_FUELCELL,
];

export const ENGINE_GROUPS: { label: string; configs: CylConfig[] }[] = [
  { label: "4-Stroke Gasoline", configs: [
    ENGINE_SINGLE_CYL, ENGINE_PARALLEL_TWIN, ENGINE_FLAT_TWIN, ENGINE_V_TWIN,
    ENGINE_3_CYL, ENGINE_I4, ENGINE_I5, ENGINE_I6, ENGINE_FLAT6, ENGINE_V6,
    ENGINE_8_CYL, ENGINE_V8, ENGINE_V12, ENGINE_RADIAL9,
  ] },
  { label: "Diesel", configs: [ENGINE_DIESEL_I6, ENGINE_DIESEL_V8] },
  { label: "2-Stroke", configs: [ENGINE_2STROKE_SINGLE, ENGINE_2STROKE_TRIPLE] },
  { label: "Alt-Cycle / Valve", configs: [ENGINE_SLEEVE_I6, ENGINE_OPPOSED_TWIN, ENGINE_SCUDERI] },
  { label: "Rotary", configs: [ENGINE_WANKEL_1R, ENGINE_WANKEL_2R, ENGINE_WANKEL_3R, ENGINE_QUASITURBINE] },
  { label: "External / Turbine", configs: [ENGINE_STIRLING, ENGINE_STEAM, ENGINE_TURBINE, ENGINE_JET, ENGINE_FUELCELL] },
];
