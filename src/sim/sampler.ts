// Per-cycle sample capture for the scope plots (ported from sampler_s.h).

import { FOUR_PI_R, AUDIO_SAMPLE_RATE_HZ } from "./constants";
import {
  calcMolAirFuelRatio,
  calcMolCombustedRatio,
  calcMixedGamma,
} from "./gas";
import {
  calcStaticPressurePa,
  calcTotalPressurePa,
} from "./chamber";
import { type Node, NodeType } from "./nodes";
import { type NozzleFlow } from "./nozzle";
import { type Crankshaft } from "./mechanical";

export const MAX_CHANNELS = 8;
export const MAX_SAMPLES = 16384;
export const MIN_ANGULAR_VELOCITY_R_PER_S =
  (FOUR_PI_R * AUDIO_SAMPLE_RATE_HZ) / MAX_SAMPLES;

// Order must match the SAMPLES X-macro in sampler_s.h.
export const SampleName = {
  volume_m3: 0,
  sparkplug_voltage_v: 1,
  nozzle_area_m2: 2,
  nozzle_mach: 3,
  nozzle_static_density_kg_per_m3: 4,
  nozzle_velocity_m_per_s: 5,
  nozzle_static_pressure_pa: 6,
  nozzle_mass_flow_rate_kg_per_s: 7,
  nozzle_speed_of_sound_m_per_s: 8,
  piston_gas_torque_n_m: 9,
  piston_inertia_torque_n_m: 10,
  static_pressure_pa: 11,
  total_pressure_pa: 12,
  static_temperature_k: 13,
  molar_air_fuel_ratio: 14,
  molar_fuel_ratio_c8h18: 15,
  molar_combusted_ratio_co2_h2o: 16,
  momentum_kg_m_per_s: 17,
  gamma: 18,
} as const;
export type SampleName = (typeof SampleName)[keyof typeof SampleName];
export const SAMPLE_NAME_E_SIZE = 19;

export const SAMPLE_NAME_STRING: string[] = [
  "g_sample_volume_m3",
  "g_sample_sparkplug_voltage_v",
  "g_sample_nozzle_area_m2",
  "g_sample_nozzle_mach",
  "g_sample_nozzle_static_density_kg_per_m3",
  "g_sample_nozzle_velocity_m_per_s",
  "g_sample_nozzle_static_pressure_pa",
  "g_sample_nozzle_mass_flow_rate_kg_per_s",
  "g_sample_nozzle_speed_of_sound_m_per_s",
  "g_sample_piston_gas_torque_n_m",
  "g_sample_piston_inertia_torque_n_m",
  "g_sample_static_pressure_pa",
  "g_sample_total_pressure_pa",
  "g_sample_static_temperature_k",
  "g_sample_molar_air_fuel_ratio",
  "g_sample_molar_fuel_ratio_c8h18",
  "g_sample_molar_combusted_ratio_co2_h2o",
  "g_sample_momentum_kg_m_per_s",
  "g_sample_gamma",
];

const STRIDE = MAX_CHANNELS * SAMPLE_NAME_E_SIZE * MAX_SAMPLES;

export class Sampler {
  channel = new Float64Array(STRIDE);
  starter = new Float64Array(MAX_SAMPLES);
  index = 0;
  channel_index = 0;
  size = 0;

  sampleStarter(starterAngVel: number): void {
    this.starter[this.index] = starterAngVel;
  }
  sampleValue(name: SampleName, value: number): void {
    this.channel[
      ((this.channel_index * SAMPLE_NAME_E_SIZE) + name) * MAX_SAMPLES + this.index
    ] = value;
  }
  sampleChannel(node: Node, nozzleFlow: NozzleFlow, crank: Crankshaft): void {
    if (this.channel_index >= MAX_CHANNELS) return;
    const c = node.chamber;
    const ff = nozzleFlow.flow_field;
    this.sampleValue(SampleName.static_pressure_pa, calcStaticPressurePa(c));
    this.sampleValue(SampleName.total_pressure_pa, calcTotalPressurePa(c));
    this.sampleValue(SampleName.static_temperature_k, c.gas.static_temperature_k);
    this.sampleValue(SampleName.volume_m3, c.volume_m3);
    this.sampleValue(SampleName.molar_air_fuel_ratio, calcMolAirFuelRatio(c.gas));
    this.sampleValue(SampleName.molar_fuel_ratio_c8h18, c.gas.mol_ratio_c8h18);
    this.sampleValue(SampleName.molar_combusted_ratio_co2_h2o, calcMolCombustedRatio(c.gas));
    if (node.type === NodeType.piston && node.piston) {
      const p = node.piston;
      this.sampleValue(SampleName.sparkplug_voltage_v, p.sparkplug.voltage(crank));
      this.sampleValue(SampleName.piston_gas_torque_n_m, p.gasTorque(crank));
      this.sampleValue(SampleName.piston_inertia_torque_n_m, p.inertiaTorque(crank));
    } else {
      this.sampleValue(SampleName.sparkplug_voltage_v, 0);
      this.sampleValue(SampleName.piston_gas_torque_n_m, 0);
      this.sampleValue(SampleName.piston_inertia_torque_n_m, 0);
    }
    this.sampleValue(SampleName.nozzle_area_m2, nozzleFlow.area_m2);
    this.sampleValue(SampleName.nozzle_mach, ff.mach);
    this.sampleValue(SampleName.nozzle_static_density_kg_per_m3, ff.static_density_kg_per_m3);
    this.sampleValue(SampleName.nozzle_velocity_m_per_s, ff.velocity_m_per_s);
    this.sampleValue(SampleName.nozzle_static_pressure_pa, ff.static_pressure_pa);
    this.sampleValue(SampleName.nozzle_mass_flow_rate_kg_per_s, ff.mass_flow_rate_kg_per_s);
    this.sampleValue(SampleName.nozzle_speed_of_sound_m_per_s, ff.speed_of_sound_m_per_s);
    this.sampleValue(SampleName.gamma, calcMixedGamma(c.gas));
    this.sampleValue(SampleName.momentum_kg_m_per_s, c.gas.momentum_kg_m_per_s);
    this.channel_index++;
  }
  clearChannel(): void {
    this.channel.fill(0);
  }
  resetChannel(): void {
    this.channel_index = 0;
  }
  getChannel(ch: number, name: SampleName): Float64Array {
    // Returns a view of the samples for channel/name (length MAX_SAMPLES).
    const start = ((ch * SAMPLE_NAME_E_SIZE) + name) * MAX_SAMPLES;
    return this.channel.subarray(start, start + MAX_SAMPLES);
  }
}

// Display helper: strip the "g_sample_<group>_" namespace prefix
// (skip_sample_namespace = till_underscore(till_underscore(s))).
function tillUnderscore(s: string): string {
  return s.slice(s.indexOf("_") + 1);
}
export function skipSampleNamespace(s: string): string {
  return tillUnderscore(tillUnderscore(s));
}
