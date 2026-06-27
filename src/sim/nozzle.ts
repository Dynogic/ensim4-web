// Nozzle flow (isentropic, convergent/choked) and gas mail transfer
// (ported from nozzle_flow_s.h and gas_mail_s.h). The flow() hot path computes
// each chamber's gas-derived quantities exactly once (the C relies on -O3 to
// CSE these; we inline them explicitly).
//
// PERFORMANCE: flow() is the single hottest function in the simulator -- it is
// called once per graph edge per sample (~45 edges x 48000 samples/s for the
// inline-8). The C returns everything by value on the stack with zero heap
// traffic; a naive TS port that allocated the result objects produced ~14M
// short-lived objects/second and spent most of its time in GC. We instead reuse
// module-level scratch objects: flow()'s result is always consumed synchronously
// by the caller (sampled, mailed, staged) before the next flow() call, so a
// single shared instance is safe and keeps the per-sample loop allocation-free.

import { DT_S, clamp } from "./constants";
import { type Chamber, makeChamber, mixInGas, removeGas } from "./chamber";
import {
  type Gas, makeGas, clampMomentum,
  MOLAR_MASS_N2, MOLAR_MASS_O2, MOLAR_MASS_AR,
  MOLAR_MASS_C8H18, MOLAR_MASS_CO2, MOLAR_MASS_H2O,
} from "./gas";
import { cpN2At, cpO2At, cpArAt, cpC8h18At, cpCo2At, cpH2oAt } from "./gamma";

const R = 8.3144598;

export interface GasMail {
  gas: Gas;
  x: Chamber;
  y: Chamber;
  is_from_reservoir: boolean;
}

export interface NozzleFlowField {
  mach: number;
  velocity_m_per_s: number;
  mass_flow_rate_kg_per_s: number;
  speed_of_sound_m_per_s: number;
  static_density_kg_per_m3: number;
  static_pressure_pa: number;
}

export interface NozzleFlow {
  area_m2: number;
  flow_field: NozzleFlowField;
  gas_mail: GasMail;
  is_success: boolean;
}

interface ChamberState {
  gamma: number; Rs: number; Tt: number; Pt: number; Ps: number; m: number; V: number;
}

function makeChamberState(): ChamberState {
  return { gamma: 0, Rs: 0, Tt: 0, Pt: 0, Ps: 0, m: 0, V: 0 };
}

// Scratch state for the two chambers of the current edge (no per-call alloc).
const stateA = makeChamberState();
const stateB = makeChamberState();

// Single reused result. gas_mail.gas is its own reused Gas; x/y are rebound to
// the real chambers each call.
const scratchFlow: NozzleFlow = {
  area_m2: 0,
  flow_field: {
    mach: 0, velocity_m_per_s: 0, mass_flow_rate_kg_per_s: 0,
    speed_of_sound_m_per_s: 0, static_density_kg_per_m3: 0, static_pressure_pa: 0,
  },
  gas_mail: { gas: makeGas(), x: makeChamber(), y: makeChamber(), is_from_reservoir: false },
  is_success: false,
};

function chamberStateInto(c: Chamber, out: ChamberState): void {
  const g = c.gas;
  const mm =
    g.mol_ratio_n2 * MOLAR_MASS_N2 +
    g.mol_ratio_o2 * MOLAR_MASS_O2 +
    g.mol_ratio_ar * MOLAR_MASS_AR +
    g.mol_ratio_c8h18 * MOLAR_MASS_C8H18 +
    g.mol_ratio_co2 * MOLAR_MASS_CO2 +
    g.mol_ratio_h2o * MOLAR_MASS_H2O;
  const Rs = R / mm;
  const T = g.static_temperature_k;
  const cp =
    g.mol_ratio_n2 * cpN2At(T) +
    g.mol_ratio_o2 * cpO2At(T) +
    g.mol_ratio_ar * cpArAt(T) +
    g.mol_ratio_c8h18 * cpC8h18At(T) +
    g.mol_ratio_co2 * cpCo2At(T) +
    g.mol_ratio_h2o * cpH2oAt(T);
  const gamma = cp / (cp - R);
  const m = g.mass_kg;
  const V = c.volume_m3;
  const Ps = (m * Rs * T) / V;
  const u = g.momentum_kg_m_per_s / m;
  const a = Math.sqrt(gamma * Rs * T);
  const M = u / a;
  const vm2 = 1.0 + ((gamma - 1.0) / 2.0) * M * M;
  out.gamma = gamma;
  out.Rs = Rs;
  out.Tt = T * vm2;
  out.Pt = Ps * Math.pow(vm2, gamma / (gamma - 1.0));
  out.Ps = Ps;
  out.m = m;
  out.V = V;
}

export function flow(x: Chamber, y: Chamber): NozzleFlow {
  const out = scratchFlow;
  const ff = out.flow_field;
  const area = x.nozzle_max_flow_area_m2 * x.nozzle_open_ratio;
  if (area > 0.0) {
    chamberStateInto(x, stateA);
    chamberStateInto(y, stateB);
    let src: ChamberState;
    let dst: ChamberState;
    let sx: Chamber;
    let sy: Chamber;
    let direction: number;
    if (stateA.Pt >= stateB.Pt) {
      src = stateA; dst = stateB; sx = x; sy = y; direction = 1.0;
    } else {
      src = stateB; dst = stateA; sx = y; sy = x; direction = -1.0;
    }

    const gamma = src.gamma;
    const Rs = src.Rs;
    const Pt = src.Pt;
    const Tt = src.Tt;
    const Psd = dst.Ps;

    let nMach = Math.sqrt((2.0 / (gamma - 1.0)) * (Math.pow(Pt / Psd, (gamma - 1.0) / gamma) - 1.0));
    nMach = clamp(nMach, 0.0, 1.0);

    if (nMach > 0.0) {
      const half = (gamma - 1.0) / 2.0;
      const vm2 = 1.0 + half * nMach * nMach;
      const vel = nMach * Math.sqrt((gamma * Rs * Tt) / vm2);
      const mfr = ((area * Pt) / Math.sqrt(Tt)) * Math.sqrt(gamma / Rs) * (nMach / Math.pow(vm2, (gamma + 1.0) / (2.0 * (gamma - 1.0))));
      const sos = vel / nMach;
      const dens = mfr / (area * vel);
      const sp = Pt * Math.pow(vm2, -gamma / (gamma - 1.0));
      const massFlowed = mfr * DT_S;
      const momentum = massFlowed * vel;
      const g = sx.gas;
      const mail = out.gas_mail.gas;
      mail.mol_ratio_c8h18 = g.mol_ratio_c8h18;
      mail.mol_ratio_o2 = g.mol_ratio_o2;
      mail.mol_ratio_n2 = g.mol_ratio_n2;
      mail.mol_ratio_ar = g.mol_ratio_ar;
      mail.mol_ratio_co2 = g.mol_ratio_co2;
      mail.mol_ratio_h2o = g.mol_ratio_h2o;
      mail.static_temperature_k = g.static_temperature_k;
      mail.mass_kg = massFlowed;
      mail.momentum_kg_m_per_s = momentum;

      out.area_m2 = area;
      ff.mach = direction * nMach;
      ff.velocity_m_per_s = direction * vel;
      ff.mass_flow_rate_kg_per_s = direction * mfr;
      ff.speed_of_sound_m_per_s = sos;
      ff.static_density_kg_per_m3 = dens;
      ff.static_pressure_pa = sp;
      out.gas_mail.x = sx;
      out.gas_mail.y = sy;
      out.gas_mail.is_from_reservoir = false;
      out.is_success = true;
      return out;
    }
    // Choked-but-no-flow: signal uses src static state.
    out.area_m2 = 0;
    ff.mach = 0; ff.velocity_m_per_s = 0; ff.mass_flow_rate_kg_per_s = 0; ff.speed_of_sound_m_per_s = 0;
    ff.static_density_kg_per_m3 = src.m / src.V;
    ff.static_pressure_pa = src.Ps;
    out.gas_mail.x = sx;
    out.gas_mail.y = sy;
    out.gas_mail.is_from_reservoir = false;
    out.is_success = false;
    return out;
  }
  // Nozzle closed: signal uses x's static state.
  chamberStateInto(x, stateA);
  out.area_m2 = 0;
  ff.mach = 0; ff.velocity_m_per_s = 0; ff.mass_flow_rate_kg_per_s = 0; ff.speed_of_sound_m_per_s = 0;
  ff.static_density_kg_per_m3 = stateA.m / stateA.V;
  ff.static_pressure_pa = stateA.Ps;
  out.gas_mail.x = x;
  out.gas_mail.y = y;
  out.gas_mail.is_from_reservoir = false;
  out.is_success = false;
  return out;
}

export function mailGasMail(mail: GasMail): void {
  if (!mail.is_from_reservoir) {
    removeGas(mail.x, mail.gas);
    clampMomentum(mail.x.gas);
  }
  mixInGas(mail.y, mail.gas);
  clampMomentum(mail.y.gas);
  mail.x.flow_cycles++;
}
