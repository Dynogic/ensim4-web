// Gas mixture model (ported from gas_s.h).

import { clamp } from "./constants";
import {
  cpArAt,
  cpC8h18At,
  cpCo2At,
  cpH2oAt,
  cpN2At,
  cpO2At,
  calcCvJPerMolK,
  lookupGamma,
} from "./gamma";

export const MOLAR_MASS_C8H18 = 0.11422852;
export const MOLAR_MASS_O2 = 0.0319988;
export const MOLAR_MASS_N2 = 0.0280134;
export const MOLAR_MASS_AR = 0.039948;
export const MOLAR_MASS_CO2 = 0.0440095;
export const MOLAR_MASS_H2O = 0.01801528;
export const IDEAL_MOL_AIR_FUEL_RATIO = 59.5;
export const AMBIENT_STATIC_TEMPERATURE_K = 300.0;
export const AMBIENT_STATIC_PRESSURE_PA = 101325.0;
export const AMBIENT_STATIC_DENSITY_KG_PER_M3 = 1.225;

export interface Gas {
  mol_ratio_n2: number;
  mol_ratio_o2: number;
  mol_ratio_ar: number;
  mol_ratio_c8h18: number;
  mol_ratio_co2: number;
  mol_ratio_h2o: number;
  static_temperature_k: number;
  mass_kg: number;
  momentum_kg_m_per_s: number;
}

export function makeGas(): Gas {
  return {
    mol_ratio_n2: 0,
    mol_ratio_o2: 0,
    mol_ratio_ar: 0,
    mol_ratio_c8h18: 0,
    mol_ratio_co2: 0,
    mol_ratio_h2o: 0,
    static_temperature_k: 0,
    mass_kg: 0,
    momentum_kg_m_per_s: 0,
  };
}

export function copyGas(dst: Gas, src: Gas): void {
  dst.mol_ratio_n2 = src.mol_ratio_n2;
  dst.mol_ratio_o2 = src.mol_ratio_o2;
  dst.mol_ratio_ar = src.mol_ratio_ar;
  dst.mol_ratio_c8h18 = src.mol_ratio_c8h18;
  dst.mol_ratio_co2 = src.mol_ratio_co2;
  dst.mol_ratio_h2o = src.mol_ratio_h2o;
  dst.static_temperature_k = src.static_temperature_k;
  dst.mass_kg = src.mass_kg;
  dst.momentum_kg_m_per_s = src.momentum_kg_m_per_s;
}

export function setAmbientAir(g: Gas): void {
  g.mol_ratio_n2 = 0.78;
  g.mol_ratio_o2 = 0.21;
  g.mol_ratio_ar = 0.01;
  g.mol_ratio_c8h18 = 0;
  g.mol_ratio_co2 = 0;
  g.mol_ratio_h2o = 0;
  g.static_temperature_k = AMBIENT_STATIC_TEMPERATURE_K;
}

// Pure steam (water vapour) — the working fluid of a steam engine.
export function setAmbientSteam(g: Gas): void {
  g.mol_ratio_n2 = 0;
  g.mol_ratio_o2 = 0;
  g.mol_ratio_ar = 0;
  g.mol_ratio_c8h18 = 0;
  g.mol_ratio_co2 = 0;
  g.mol_ratio_h2o = 1.0;
  g.static_temperature_k = AMBIENT_STATIC_TEMPERATURE_K;
}

export function setAmbientAtomizedFuel(g: Gas): void {
  g.mol_ratio_n2 = 0;  g.mol_ratio_o2 = 0;
  g.mol_ratio_ar = 0;
  g.mol_ratio_c8h18 = 1.0;
  g.mol_ratio_co2 = 0;
  g.mol_ratio_h2o = 0;
  g.static_temperature_k = AMBIENT_STATIC_TEMPERATURE_K;
}

export const calcMolAirRatio = (g: Gas): number =>
  g.mol_ratio_n2 + g.mol_ratio_o2 + g.mol_ratio_ar;

export const calcMolCombustedRatio = (g: Gas): number =>
  g.mol_ratio_co2 + g.mol_ratio_h2o;

export const calcMolAirFuelRatio = (g: Gas): number =>
  calcMolAirRatio(g) / g.mol_ratio_c8h18;

export const calcMixedMolarMass = (g: Gas): number =>
  g.mol_ratio_n2 * MOLAR_MASS_N2 +
  g.mol_ratio_o2 * MOLAR_MASS_O2 +
  g.mol_ratio_ar * MOLAR_MASS_AR +
  g.mol_ratio_c8h18 * MOLAR_MASS_C8H18 +
  g.mol_ratio_co2 * MOLAR_MASS_CO2 +
  g.mol_ratio_h2o * MOLAR_MASS_H2O;

export const calcMixedCp = (g: Gas): number =>
  g.mol_ratio_n2 * cpN2At(g.static_temperature_k) +
  g.mol_ratio_o2 * cpO2At(g.static_temperature_k) +
  g.mol_ratio_ar * cpArAt(g.static_temperature_k) +
  g.mol_ratio_c8h18 * cpC8h18At(g.static_temperature_k) +
  g.mol_ratio_co2 * cpCo2At(g.static_temperature_k) +
  g.mol_ratio_h2o * cpH2oAt(g.static_temperature_k);

export const calcMixedCv = (g: Gas): number => calcCvJPerMolK(calcMixedCp(g));
export const calcMixedGamma = (g: Gas): number => lookupGamma(calcMixedCp(g));

//      m
// n = ---
//      M
export const calcMoles = (g: Gas): number => g.mass_kg / calcMixedMolarMass(g);

export const calcTotalCp = (g: Gas): number =>
  calcMoles(g) * calcMixedCp(g);
export const calcTotalCv = (g: Gas): number =>
  calcMoles(g) * calcMixedCv(g);

//       R
// Rs = ---
//       M
export const calcSpecificGasConstant = (g: Gas): number =>
  8.3144598 / calcMixedMolarMass(g);

//      u = p / m
export const calcBulkFlowVelocity = (g: Gas): number =>
  g.momentum_kg_m_per_s / g.mass_kg;

// a = sqrt(y * Rs * Ts)
export const calcBulkSpeedOfSound = (g: Gas): number => {
  const y = calcMixedGamma(g);
  const Rs = calcSpecificGasConstant(g);
  const Ts = g.static_temperature_k;
  return Math.sqrt(y * Rs * Ts);
};

// M = u / a
export const calcBulkMach = (g: Gas): number =>
  calcBulkFlowVelocity(g) / calcBulkSpeedOfSound(g);

export const calcMaxBulkMomentum = (g: Gas): number =>
  g.mass_kg * calcBulkSpeedOfSound(g);

export function clampMomentum(g: Gas): void {
  const maxMom = calcMaxBulkMomentum(g);
  g.momentum_kg_m_per_s = clamp(
    g.momentum_kg_m_per_s,
    -maxMom,
    maxMom,
  );
}
