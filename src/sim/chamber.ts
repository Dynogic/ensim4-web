// Chamber thermodynamics (ported from chamber_s.h).

import { DT_S, calcMix, clamp } from "./constants";
import {
  AMBIENT_STATIC_PRESSURE_PA,
  calcBulkMach,
  calcBulkSpeedOfSound,
  calcMixedCv,
  calcMixedGamma,
  calcMoles,
  calcSpecificGasConstant,
  calcTotalCv,
  type Gas,
  makeGas,
  setAmbientAir,
  setAmbientAtomizedFuel,
} from "./gas";

const C8H18_HEAT_OF_COMBUSTION_J_PER_MOL = 5.47e6;

export interface Chamber {
  gas: Gas;
  volume_m3: number;
  nozzle_max_flow_area_m2: number;
  nozzle_open_ratio: number;
  gas_momentum_damping_time_constant_s: number;
  flow_cycles: number;
  should_panic: boolean;
}

export function makeChamber(): Chamber {
  return {
    gas: makeGas(),
    volume_m3: 0,
    nozzle_max_flow_area_m2: 0,
    nozzle_open_ratio: 0,
    gas_momentum_damping_time_constant_s: 0,
    flow_cycles: 0,
    should_panic: false,
  };
}

//      m * R * Ts
// Ps = ----------
//          V
export const calcStaticPressurePa = (c: Chamber): number => {
  const m = c.gas.mass_kg;
  const Rs = calcSpecificGasConstant(c.gas);
  const Ts = c.gas.static_temperature_k;
  const V = c.volume_m3;
  return (m * Rs * Ts) / V;
};

export const calcStaticGaugePressurePa = (c: Chamber): number =>
  calcStaticPressurePa(c) - AMBIENT_STATIC_PRESSURE_PA;

//     Ps * V
// m = -------
//     Rs * Ts
export const calcMassAtKg = (c: Chamber, staticPressurePa: number): number => {
  const V = c.volume_m3;
  const Rs = calcSpecificGasConstant(c.gas);
  const Ts = c.gas.static_temperature_k;
  return (staticPressurePa * V) / (Rs * Ts);
};

// Pt = Ps * (1 + (y-1)/2 * M^2) ^ (y/(y-1))
export const calcTotalPressurePa = (c: Chamber): number => {
  const y = calcMixedGamma(c.gas);
  const Ps = calcStaticPressurePa(c);
  const M = calcBulkMach(c.gas);
  return Ps * Math.pow(1.0 + ((y - 1.0) / 2.0) * M * M, y / (y - 1.0));
};

// Tt = Ts * (1 + (y-1)/2 * M^2)
export const calcTotalTemperatureK = (c: Chamber): number => {
  const y = calcMixedGamma(c.gas);
  const Ts = c.gas.static_temperature_k;
  const M = calcBulkMach(c.gas);
  return Ts * (1.0 + ((y - 1.0) / 2.0) * M * M);
};

export const calcBulkStaticDensity = (c: Chamber): number =>
  c.gas.mass_kg / c.volume_m3;

// Nozzle Mach (convergent, choked at 1).
export const calcNozzleMach = (x: Chamber, y: Chamber): number => {
  const Pt = calcTotalPressurePa(x);
  const y_gamma = calcMixedGamma(x.gas);
  const Ps = calcStaticPressurePa(y);
  const M = Math.sqrt(
    (2.0 / (y_gamma - 1.0)) *
      (Math.pow(Pt / Ps, (y_gamma - 1.0) / y_gamma) - 1.0),
  );
  return clamp(M, 0.0, 1.0);
};

export const calcNozzleMassFlowRate = (
  x: Chamber,
  nozzleFlowAreaM2: number,
  nozzleMach: number,
): number => {
  const y = calcMixedGamma(x.gas);
  const M = nozzleMach;
  const Rs = calcSpecificGasConstant(x.gas);
  const Tt = calcTotalTemperatureK(x);
  const Pt = calcTotalPressurePa(x);
  const A = nozzleFlowAreaM2;
  return (
    ((A * Pt) / Math.sqrt(Tt)) *
    Math.sqrt(y / Rs) *
    (M /
      Math.pow(
        1.0 + ((y - 1.0) / 2.0) * M * M,
        (y + 1.0) / (2.0 * (y - 1.0)),
      ))
  );
};

export const calcNozzleFlowVelocity = (
  x: Chamber,
  nozzleMach: number,
): number => {
  const y = calcMixedGamma(x.gas);
  const M = nozzleMach;
  const Rs = calcSpecificGasConstant(x.gas);
  const Tt = calcTotalTemperatureK(x);
  return (
    M *
    Math.sqrt((y * Rs * Tt) / (1.0 + ((y - 1.0) / 2.0) * M * M))
  );
};

export const calcNozzleSpeedOfSound = (
  x: Chamber,
  nozzleMach: number,
  nozzleFlowVelocity: number,
): number => {
  if (nozzleMach === 0.0) return calcBulkSpeedOfSound(x.gas);
  return nozzleFlowVelocity / nozzleMach;
};

export const calcNozzleFlowAreaM2 = (c: Chamber): number =>
  c.nozzle_max_flow_area_m2 * c.nozzle_open_ratio;

//          .m
// ps = -------
//      (A * u)
export const calcNozzleStaticDensity = (
  massFlowRate: number,
  nozzleFlowAreaM2: number,
  nozzleFlowVelocity: number,
): number => massFlowRate / (nozzleFlowAreaM2 * nozzleFlowVelocity);

export const calcNozzleStaticPressurePa = (
  x: Chamber,
  nozzleMach: number,
): number => {
  const y = calcMixedGamma(x.gas);
  const Pt = calcTotalPressurePa(x);
  const M = nozzleMach;
  return Pt * Math.pow(1.0 + 0.5 * (y - 1.0) * M * M, -y / (y - 1.0));
};

// Ts2 = Ts1 * (V1/V2)^(y-1)
export const calcNewAdiabaticStaticTemperatureFromVolumeDelta = (
  c: Chamber,
  oldVolumeM3: number,
): number => {
  const V1 = oldVolumeM3;
  const V2 = c.volume_m3;
  const y = calcMixedGamma(c.gas);
  return c.gas.static_temperature_k * Math.pow(V1 / V2, y - 1.0);
};

export function addMomentum(c: Chamber, momentum: number): void {
  c.gas.momentum_kg_m_per_s += momentum;
  const damping = Math.exp(-DT_S / c.gas_momentum_damping_time_constant_s);
  c.gas.momentum_kg_m_per_s *= damping;
}

export function removeGas(c: Chamber, mail: Gas): void {
  c.gas.mass_kg -= mail.mass_kg;
  if (c.gas.mass_kg < 0.0) {
    c.should_panic = true;
    panicMessage = "negative chamber mass detected";
  }
  addMomentum(c, -mail.momentum_kg_m_per_s);
}

export function normalizeChamber(c: Chamber): void {
  setAmbientAir(c.gas);
  c.gas.mass_kg = calcMassAtKg(c, AMBIENT_STATIC_PRESSURE_PA);
}

// Fuel chambers are treated as atomized gas; mass doubled, temp raised.
export function normalizeInjectionChamber(c: Chamber): void {
  setAmbientAtomizedFuel(c.gas);
  c.gas.mass_kg = calcMassAtKg(c, AMBIENT_STATIC_PRESSURE_PA);
  c.gas.mass_kg *= 2.0;
  c.gas.static_temperature_k += 30.0;
}

export const calcMolRatio = (c: Chamber): number =>
  c.gas.mol_ratio_n2 +
  c.gas.mol_ratio_o2 +
  c.gas.mol_ratio_ar +
  c.gas.mol_ratio_c8h18 +
  c.gas.mol_ratio_co2 +
  c.gas.mol_ratio_h2o;

// c8h18 + 12.5 o2 -> 8 co2 + 9 h2o
export function combustC8H18(c: Chamber, fraction: number): void {
  let molRatioC8h18 = c.gas.mol_ratio_c8h18 * fraction;
  let molRatioO2 = 12.5 * molRatioC8h18;
  if (molRatioO2 > c.gas.mol_ratio_o2) {
    molRatioC8h18 *= c.gas.mol_ratio_o2 / molRatioO2;
    molRatioO2 = 12.5 * molRatioC8h18;
  }
  c.gas.mol_ratio_c8h18 -= molRatioC8h18;
  c.gas.mol_ratio_o2 -= molRatioO2;
  c.gas.mol_ratio_co2 += 8.0 * molRatioC8h18;
  c.gas.mol_ratio_h2o += 9.0 * molRatioC8h18;
  const molRatio = calcMolRatio(c);
  c.gas.mol_ratio_n2 /= molRatio;
  c.gas.mol_ratio_o2 /= molRatio;
  c.gas.mol_ratio_ar /= molRatio;
  c.gas.mol_ratio_c8h18 /= molRatio;
  c.gas.mol_ratio_co2 /= molRatio;
  c.gas.mol_ratio_h2o /= molRatio;
  const energyJPerMol = molRatioC8h18 * C8H18_HEAT_OF_COMBUSTION_J_PER_MOL;
  c.gas.static_temperature_k += energyJPerMol / calcMixedCv(c.gas);
}

export function mixInGas(c: Chamber, mail: Gas): void {
  const selfMoles = calcMoles(c.gas);
  const mailMoles = calcMoles(mail);
  const selfTotalCv = calcTotalCv(c.gas);
  const mailTotalCv = calcTotalCv(mail);
  c.gas.mol_ratio_n2 = calcMix(
    c.gas.mol_ratio_n2,
    selfMoles,
    mail.mol_ratio_n2,
    mailMoles,
  );
  c.gas.mol_ratio_o2 = calcMix(
    c.gas.mol_ratio_o2,
    selfMoles,
    mail.mol_ratio_o2,
    mailMoles,
  );
  c.gas.mol_ratio_ar = calcMix(
    c.gas.mol_ratio_ar,
    selfMoles,
    mail.mol_ratio_ar,
    mailMoles,
  );
  c.gas.mol_ratio_c8h18 = calcMix(
    c.gas.mol_ratio_c8h18,
    selfMoles,
    mail.mol_ratio_c8h18,
    mailMoles,
  );
  c.gas.mol_ratio_co2 = calcMix(
    c.gas.mol_ratio_co2,
    selfMoles,
    mail.mol_ratio_co2,
    mailMoles,
  );
  c.gas.mol_ratio_h2o = calcMix(
    c.gas.mol_ratio_h2o,
    selfMoles,
    mail.mol_ratio_h2o,
    mailMoles,
  );
  c.gas.static_temperature_k = calcMix(
    c.gas.static_temperature_k,
    selfTotalCv,
    mail.static_temperature_k,
    mailTotalCv,
  );
  c.gas.mass_kg += mail.mass_kg;
  addMomentum(c, mail.momentum_kg_m_per_s);
}

// Global panic message (ported from panic.h). Mutated by simulation, read by
// the visualizer.
export let panicMessage: string | null = null;
export function setPanicMessage(msg: string | null): void {
  panicMessage = msg;
}
