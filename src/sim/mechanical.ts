// Rotational and kinematic components (ported from crankshaft_s.h,
// flywheel_s.h, starter_s.h, limiter_s.h, sparkplug_s.h, valve_s.h,
// piston_s.h).

import {
  DT_S,
  FOUR_PI_R,
  calcCircleAreaM2,
  calcCylinderVolumeM3,
  clamp,
} from "./constants";
import {
  type Chamber,
  calcNewAdiabaticStaticTemperatureFromVolumeDelta,
  calcStaticGaugePressurePa,
} from "./chamber";

const SPARKPLUG_VOLTAGE_V = 3e4;
export const STATIC_FRICTION_UPPER_ANGULAR_VELOCITY = FOUR_PI_R;

export class Valve {
  engage_r = 0;
  ramp_r = 0;
  nozzleOpenRatio(crank: Crankshaft): number {
    let ottoTheta = crank.theta_r % FOUR_PI_R;
    let ottoEngage = this.engage_r % FOUR_PI_R;
    if (ottoEngage < 0.0) ottoEngage += FOUR_PI_R;
    if (ottoTheta < ottoEngage) ottoTheta += FOUR_PI_R;
    const open = ottoTheta - ottoEngage;
    const x = open / this.ramp_r;
    const x2 = x * x;
    const x3 = x2 * x;
    const x4 = x2 * x2;
    const x5 = x4 * x;
    const x6 = x4 * x2;
    const x7 = x4 * x3;
    const term1 = 35.0 * x4;
    const term2 = 84.0 * x5;
    const term3 = 70.0 * x6;
    const term4 = 20.0 * x7;
    return clamp(term1 - term2 + term3 - term4, 0.0, 1.0);
  }
}


export class Crankshaft {
  theta_r = 0;
  angular_velocity_r_per_s = 0;
  mass_kg = 0;
  radius_m = 0;
  accelerate(angAccel: number): void {
    this.angular_velocity_r_per_s += angAccel * DT_S;
  }
  turn(): void {
    this.theta_r += this.angular_velocity_r_per_s * DT_S;
  }
  momentOfInertia(): number {
    return 0.5 * this.mass_kg * this.radius_m * this.radius_m;
  }
}

export class Flywheel {
  mass_kg = 0;
  radius_m = 0;
  momentOfInertia(): number {
    return 0.5 * this.mass_kg * this.radius_m * this.radius_m;
  }
}

export class Starter {
  rated_torque_n_m = 0;
  no_load_angular_velocity_r_per_s = 0;
  radius_m = 0;
  is_on = false;
  gearRatio(flywheel: Flywheel): number {
    return flywheel.radius_m / this.radius_m;
  }
  angularVelocity(flywheel: Flywheel, crank: Crankshaft): number {
    if (!this.is_on) return 0.0;
    const gr = this.gearRatio(flywheel);
    return Math.max(crank.angular_velocity_r_per_s * gr, 0.0);
  }
  torqueOnFlywheel(flywheel: Flywheel, crank: Crankshaft): number {
    if (!this.is_on) return 0.0;
    const sa = this.angularVelocity(flywheel, crank);
    if (sa >= this.no_load_angular_velocity_r_per_s) return 0.0;
    const ratio = sa / this.no_load_angular_velocity_r_per_s;
    const starterTorque = this.rated_torque_n_m * (1.0 - ratio);
    return starterTorque * this.gearRatio(flywheel);
  }
}

export class Limiter {
  cutoff_angular_velocity_r_per_s = 0;
  relaxed_angular_velocity_r_per_s = 0;
  is_limiting = false;
  maybeLimit(crank: Crankshaft, canIgnite: { value: boolean }): void {
    const delta = this.cutoff_angular_velocity_r_per_s - crank.angular_velocity_r_per_s;
    if (delta < 0.0) {
      this.is_limiting = true;
      canIgnite.value = false;
    }
    if (this.is_limiting && delta > this.relaxed_angular_velocity_r_per_s) {
      this.is_limiting = false;
      canIgnite.value = true;
    }
  }
}

export class Sparkplug {
  engage_r = 0;
  on_r = 0;
  isEnabled(crank: Crankshaft): boolean {
    const current = crank.theta_r % FOUR_PI_R;
    let engage = this.engage_r % FOUR_PI_R;
    if (engage < 0.0) engage += FOUR_PI_R;
    const end = engage + this.on_r;
    if (end > FOUR_PI_R) {
      return (
        (current >= engage && current < FOUR_PI_R) ||
        (current >= 0.0 && current < end - FOUR_PI_R)
      );
    }
    return current >= engage && current < end;
  }
  voltage(crank: Crankshaft): number {
    return SPARKPLUG_VOLTAGE_V && this.isEnabled(crank) ? SPARKPLUG_VOLTAGE_V : 0;
  }
}

//       + block_deck_surface_m
//       | head_clearance_height_m
// ----- +
// | o | + pin_x_m, pin_y_m        head_compression_height_m
// |---|
//   | |   connecting_rod_length_m
//   o     bearing_x_m, bearing_y_m  crank_throw_length_m
export class Piston {
  chamber: Chamber;
  valve: Valve;
  sparkplug: Sparkplug;
  diameter_m = 0;
  pin_x_m = 0;
  pin_y_m = 0;
  bearing_x_m = 0;
  bearing_y_m = 0;
  theta_r = 0;
  crank_throw_length_m = 0;
  connecting_rod_length_m = 0;
  connecting_rod_mass_kg = 0;
  head_mass_density_kg_per_m3 = 0;
  head_compression_height_m = 0;
  head_clearance_height_m = 0;
  dynamic_friction_n_m_s_per_r = 0;
  static_friction_n_m_s_per_r = 0;

  constructor(chamber: Chamber, valve: Valve, sparkplug: Sparkplug) {
    this.chamber = chamber;
    this.valve = valve;
    this.sparkplug = sparkplug;
  }

  theta(crank: Crankshaft): number {
    return crank.theta_r + this.theta_r;
  }
  topDeadCenterM(): number {
    return this.connecting_rod_length_m + this.crank_throw_length_m + this.head_compression_height_m;
  }
  blockDeckSurfaceM(): number {
    return this.topDeadCenterM() + this.head_clearance_height_m;
  }
  chamberDepthAtM(yM: number): number {
    return this.blockDeckSurfaceM() - (yM + this.head_compression_height_m);
  }
  chamberDepthM(): number {
    return this.chamberDepthAtM(this.pin_y_m);
  }
  gasTorque(crank: Crankshaft): number {
    const theta = this.theta(crank);
    const term1 =
      calcStaticGaugePressurePa(this.chamber) *
      calcCircleAreaM2(this.diameter_m) *
      this.crank_throw_length_m *
      Math.sin(theta);
    const term2 =
      1.0 + (this.crank_throw_length_m / this.connecting_rod_length_m) * Math.cos(theta);
    return term1 * term2;
  }
  headMassKg(): number {
    return this.head_mass_density_kg_per_m3 *
      calcCylinderVolumeM3(this.diameter_m, 2.0 * this.head_compression_height_m);
  }
  volumeM3(): number {
    return calcCylinderVolumeM3(this.diameter_m, this.chamberDepthM());
  }
  momentOfInertia(): number {
    const recip = this.headMassKg() + 0.5 * this.connecting_rod_mass_kg;
    return recip * this.crank_throw_length_m * this.crank_throw_length_m;
  }
  inertiaTorque(crank: Crankshaft): number {
    const theta = this.theta(crank);
    const ratio = this.crank_throw_length_m / this.connecting_rod_length_m;
    const term1 = 0.25 * Math.sin(theta) * ratio;
    const term2 = 0.5 * Math.sin(2.0 * theta);
    const term3 = 0.75 * Math.sin(3.0 * theta) * ratio;
    return (
      this.momentOfInertia() *
      crank.angular_velocity_r_per_s * crank.angular_velocity_r_per_s *
      (term1 - term2 - term3)
    );
  }
  frictionTorque(crank: Crankshaft): number {
    const isStatic = Math.abs(crank.angular_velocity_r_per_s) < STATIC_FRICTION_UPPER_ANGULAR_VELOCITY;
    const fric = isStatic ? this.static_friction_n_m_s_per_r : this.dynamic_friction_n_m_s_per_r;
    return -1.0 * crank.angular_velocity_r_per_s * fric;
  }
  private updateBearing(theta: number): void {
    this.bearing_x_m = this.crank_throw_length_m * Math.sin(theta);
    this.bearing_y_m = this.crank_throw_length_m * Math.cos(theta);
  }
  private updatePin(theta: number): void {
    this.pin_x_m = 0.0;
    const s = this.crank_throw_length_m * Math.sin(theta);
    const term1 = Math.sqrt(this.connecting_rod_length_m * this.connecting_rod_length_m - s * s);
    const term2 = this.crank_throw_length_m * Math.cos(theta);
    this.pin_y_m = term1 + term2;
  }
  rig(crank: Crankshaft): void {
    const theta = this.theta(crank);
    this.updateBearing(theta);
    this.updatePin(theta);
    this.chamber.volume_m3 = this.volumeM3();
  }
  compress(crank: Crankshaft): void {
    const oldVolume = this.volumeM3();
    this.rig(crank);
    this.chamber.gas.static_temperature_k =
      calcNewAdiabaticStaticTemperatureFromVolumeDelta(this.chamber, oldVolume);
  }
}
