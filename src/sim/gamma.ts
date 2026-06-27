// NASA Glenn polynomial cp(T) lookup tables and gamma (ported from gamma.h).
// cp = R * [a0*T^-2 + a1*T^-1 + a2 + a3*T + a4*T^2 + a5*T^3 + a6*T^4]
// cv = cp - R ; gamma = cp / cv

import { clamp } from "./constants";

const R_UNIVERSAL_J_PER_MOL_K = 8.3144598;
const CP_BUF_SIZE = 8192;

// iso-octane 2,2,4-trimethylpentane (of gasoline), [1, p. 103]
const W_LOWER_C8H18 = [
  -1.688758565e5, +3.126903227e3, -2.123502828e1, +1.489151508e-1, -1.151180135e-4,
  +4.47321617e-8, -5.55488207e-12,
];
const W_UPPER_C8H18 = [
  +1.352765032e7, -4.66337034e4, +7.79531318e1, +1.423729984e-2, -5.07359391e-6,
  +7.24823297e-10, -3.81919011e-14,
];
// oxygen (of air) [1, p. 166]
const W_LOWER_O2 = [
  -3.42556342e4, +4.84700097e2, +1.119010961, +4.29388924e-3, -6.83630052e-7,
  -2.0233727e-9, +1.039040018e-12,
];
const W_UPPER_O2 = [
  -1.037939022e6, +2.344830282e3, +1.819732036, +1.267847582e-3, -2.188067988e-7,
  +2.053719572e-11, -8.19346705e-16,
];
// nitrogen (of air) [1, p. 156]
const W_LOWER_N2 = [
  +2.210371497e4, -3.81846182e2, +6.08273836, -8.53091441e-3, +1.384646189e-5,
  -9.62579362e-9, +2.519705809e-12,
];
const W_UPPER_N2 = [
  +5.87712406e5, -2.239249073e3, +6.06694922, -6.1396855e-4, +1.491806679e-7,
  -1.923105485e-11, +1.061954386e-15,
];
// argon (of air) [1, p. 55]
const W_LOWER_AR = [0, 0, 2.5, 0, 0, 0, 0];
const W_UPPER_AR = [
  +2.010538475e1, -5.99266107e-2, +2.500069401, -3.99214116e-8, +1.20527214e-11,
  -1.819015576e-15, +1.078576636e-19,
];
// carbon-dioxide (of combustion) [1, p. 85]
const W_LOWER_CO2 = [
  +4.94365054e4, -6.26411601e2, +5.30172524, +2.503813816e-3, -2.127308728e-7,
  -7.68998878e-10, +2.849677801e-13,
];
const W_UPPER_CO2 = [
  +1.176962419e5, -1.788791477e3, +8.29152319, -9.22315678e-5, +4.86367688e-9,
  -1.891053312e-12, +6.33003659e-16,
];
// water (of combustion) [1, p. 131]
const W_LOWER_H2O = [
  -3.94796083e4, +5.75573102e2, +9.31782653e-1, +7.22271286e-3, -7.34255737e-6,
  +4.95504349e-9, -1.336933246e-12,
];
const W_UPPER_H2O = [
  +1.034972096e6, -2.412698562e3, +4.64611078, +2.291998307e-3, -6.83683048e-7,
  +9.42646893e-11, -4.82238053e-15,
];

function calcCpJPerMolK(T: number, lower: number[], upper: number[]): number {
  const T1 = clamp(T, 200.0, 6000.0);
  const a = T1 < 1000.0 ? lower : upper;
  const T2 = T1 * T1;
  const T3 = T2 * T1;
  const T4 = T3 * T1;
  const invT1 = 1.0 / T1;
  const invT2 = invT1 * invT1;
  return (
    (a[0] * invT2 +
      a[1] * invT1 +
      a[2] +
      a[3] * T1 +
      a[4] * T2 +
      a[5] * T3 +
      a[6] * T4) *
    R_UNIVERSAL_J_PER_MOL_K
  );
}

const cpN2 = new Float64Array(CP_BUF_SIZE);
const cpO2 = new Float64Array(CP_BUF_SIZE);
const cpAr = new Float64Array(CP_BUF_SIZE);
const cpC8h18 = new Float64Array(CP_BUF_SIZE);
const cpCo2 = new Float64Array(CP_BUF_SIZE);
const cpH2o = new Float64Array(CP_BUF_SIZE);

export function precomputeCp(): void {
  for (let i = 0; i < CP_BUF_SIZE; i++) {
    cpN2[i] = calcCpJPerMolK(i, W_LOWER_N2, W_UPPER_N2);
    cpO2[i] = calcCpJPerMolK(i, W_LOWER_O2, W_UPPER_O2);
    cpAr[i] = calcCpJPerMolK(i, W_LOWER_AR, W_UPPER_AR);
    cpC8h18[i] = calcCpJPerMolK(i, W_LOWER_C8H18, W_UPPER_C8H18);
    cpCo2[i] = calcCpJPerMolK(i, W_LOWER_CO2, W_UPPER_CO2);
    cpH2o[i] = calcCpJPerMolK(i, W_LOWER_H2O, W_UPPER_H2O);
  }
}

function lookupCp(buf: Float64Array, T: number): number {
  let idx = Math.floor(T);
  if (idx < 0) idx = 0;
  else if (idx >= CP_BUF_SIZE) idx = CP_BUF_SIZE - 1;
  return buf[idx];
}

export const calcCvJPerMolK = (cpJPerMolK: number): number =>
  cpJPerMolK - R_UNIVERSAL_J_PER_MOL_K;

export const lookupGamma = (cpJPerMolK: number): number =>
  cpJPerMolK / calcCvJPerMolK(cpJPerMolK);

export const cpN2At = (T: number): number => lookupCp(cpN2, T);
export const cpO2At = (T: number): number => lookupCp(cpO2, T);
export const cpArAt = (T: number): number => lookupCp(cpAr, T);
export const cpC8h18At = (T: number): number => lookupCp(cpC8h18, T);
export const cpCo2At = (T: number): number => lookupCp(cpCo2, T);
export const cpH2oAt = (T: number): number => lookupCp(cpH2o, T);

// [1] B. Mcbride, M. Zehe, and S. Gordon,
//     "NASA Glenn Coefficients for Calculating Thermodynamic Properties of
//      Individual Species", 2002.
