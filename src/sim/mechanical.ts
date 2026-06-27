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

// A positive-displacement power cell: a chamber whose volume varies with the
// shaft angle, producing gas torque. Piston (slider-crank) and Rotor (Wankel
// epitrochoid) both implement this; the rest of the sim is engine-agnostic and
// drives any PowerCell through this surface.
export interface PowerCell {
  kind: "piston" | "rotor" | "opposed" | "quasiturbine" | "stirling" | "turbine";
  chamber: Chamber;
  valve: Valve;
  sparkplug: Sparkplug;
  theta(crank: Crankshaft): number;
  volumeM3(): number;
  gasTorque(crank: Crankshaft): number;
  inertiaTorque(crank: Crankshaft): number;
  frictionTorque(crank: Crankshaft): number;
  momentOfInertia(): number;
  rig(crank: Crankshaft): void;
  compress(crank: Crankshaft): void;
}

// Smoothstep open ramp 0->1 over x in [0,1] (the original valve polynomial).
// Used for both opening and (reversed) closing so ports are symmetric.
function valveOpenPoly(x: number): number {
  const x2 = x * x;
  const x3 = x2 * x;
  const x4 = x2 * x2;
  const x5 = x4 * x;
  const x6 = x4 * x2;
  const x7 = x4 * x3;
  return clamp(35.0 * x4 - 84.0 * x5 + 70.0 * x6 - 20.0 * x7, 0.0, 1.0);
}

export class Valve {
  // 4-stroke cycle length this valve is timed against. Piston engines use 4π
  // (the historical default); a Wankel chamber's 4-stroke cycle spans 6π of
  // eccentric-shaft angle, so its ports/spark use 6π.
  cycle_r = FOUR_PI_R;
  // "poppet" = the original smoothstep bump (default, bit-identical). "sleeve"
  // = a sleeve-valve port: a sine half-wave 0->1->0 over [engage, engage+ramp]
  // (uses ramp_r as the window width), giving a wider, smoother port event.
  profile: "poppet" | "sleeve" = "poppet";
  engage_r = 0;
  ramp_r = 0;
  // Phase (after engage) at which the port begins closing. Default Infinity =
  // the original "bump" behavior: the valve opens over [engage, engage+ramp]
  // (peaking at 1 at the end of the ramp) and is closed everywhere else in the
  // cycle, i.e. a single pulse of width ~ramp. This keeps piston engines
  // bit-identical. Wankel ports set a finite close_r to get a proper open/hold/
  // close window (hold from end-of-open-ramp to close_r, then close over
  // close_r..close_r+ramp).
  close_r = Number.POSITIVE_INFINITY;
  nozzleOpenRatio(crank: Crankshaft): number {
    const cycle = this.cycle_r;
    let ottoTheta = crank.theta_r % cycle;
    let ottoEngage = this.engage_r % cycle;
    if (ottoEngage < 0.0) ottoEngage += cycle;
    if (ottoTheta < ottoEngage) ottoTheta += cycle;
    const phase = ottoTheta - ottoEngage; // [0, cycle)
    if (this.profile === "sleeve") {
      // Sleeve port: smooth sine pulse over [0, ramp_r], closed elsewhere.
      if (this.ramp_r <= 0.0 || phase >= this.ramp_r) return 0.0;
      return Math.sin(Math.PI * phase / this.ramp_r);
    }
    if (!Number.isFinite(this.close_r)) {
      // Original bump: smoothstep 0->1 over [0, ramp], clamped 0 elsewhere.
      return valveOpenPoly(phase / this.ramp_r);
    }
    // Windowed port: open ramp, hold at 1, close ramp, then 0.
    if (phase < this.ramp_r) {
      return valveOpenPoly(phase / this.ramp_r);
    }
    if (phase < this.close_r) return 1.0;
    if (phase < this.close_r + this.ramp_r) {
      return 1.0 - valveOpenPoly((phase - this.close_r) / this.ramp_r);
    }
    return 0.0;
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
  cycle_r = FOUR_PI_R;
  engage_r = 0;
  on_r = 0;
  isEnabled(crank: Crankshaft): boolean {
    const cycle = this.cycle_r;
    const current = crank.theta_r % cycle;
    let engage = this.engage_r % cycle;
    if (engage < 0.0) engage += cycle;
    const end = engage + this.on_r;
    if (end > cycle) {
      return (
        (current >= engage && current < cycle) ||
        (current >= 0.0 && current < end - cycle)
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
export class Piston implements PowerCell {
  kind: "piston" | "stirling" = "piston";
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

// Wankel rotary power cell. A triangular rotor in a 2-lobed epitrochoid housing
// on an eccentric shaft. Unlike the slider-crank Piston, the chamber is one of
// the three volumes trapped between a rotor flank and the housing; its volume
// varies with the eccentric-shaft angle. The rotor orbits at shaft speed and
// spins at shaft/3 (2:3 internal gearing).
//
// Volume model: over one rotor revolution (= 6π of eccentric-shaft angle) each
// chamber completes a 4-stroke cycle, sweeping volume TWICE (intake+compression
// use one swing, power+exhaust the other). So V(φ) oscillates with period 3π:
//
//   V(φ) = V_clearance + (swing/2)·(1 − cos(2φ/3))
//
// where φ is the chamber's effective shaft angle (crank − its phase), and the
// per-chamber-per-swing swept volume swing = √3·e·R·b (e=eccentricity,
// R=generating radius, b=rotor width). This gives a correct compression ratio
// (V_max/V_min = (swing+V_c)/V_c) and matches the standard Wankel displacement
// formula (3·swing = 3√3·e·R·b per rotor per revolution).
//
// Gas torque is P_gauge·dV/dφ — thermodynamically exact (shaft work = ∫P dV),
// and identical in spirit to how Piston.gasTorque = P_gauge·dV/dθ.
export class Rotor implements PowerCell {
  kind = "rotor" as const;
  chamber: Chamber;
  valve: Valve;       // exhaust port timing
  sparkplug: Sparkplug;
  generating_radius_m = 0;        // R
  eccentricity_m = 0;             // e
  rotor_width_m = 0;              // b
  compression_ratio = 0;
  rotor_mass_kg = 0;
  dynamic_friction_n_m_s_per_r = 0;
  static_friction_n_m_s_per_r = 0;
  theta_r = 0;                    // phase offset; theta(crank) = crank.theta_r + theta_r
  // Derived once at build time:
  swing_m3 = 0;                   // per-chamber volume swing (V_max − V_min) per oscillation
  clearance_m3 = 0;               // V_min (combustion-chamber clearance)
  private vol_m3 = 0;             // cached volume from the last rig()

  constructor(chamber: Chamber, valve: Valve, sparkplug: Sparkplug) {
    this.chamber = chamber;
    this.valve = valve;
    this.sparkplug = sparkplug;
  }

  theta(crank: Crankshaft): number {
    return crank.theta_r + this.theta_r;
  }

  private volumeAtM3(effAngle: number): number {
    return this.clearance_m3 + 0.5 * this.swing_m3 * (1.0 - Math.cos((2.0 * effAngle) / 3.0));
  }
  volumeM3(): number {
    return this.vol_m3;
  }
  gasTorque(crank: Crankshaft): number {
    // dV/dφ = (swing/3)·sin(2φ/3)
    const eff = this.theta(crank);
    const dVdPhi = (this.swing_m3 / 3.0) * Math.sin((2.0 * eff) / 3.0);
    return calcStaticGaugePressurePa(this.chamber) * dVdPhi;
  }
  momentOfInertia(): number {
    // Orbital inertia (rotor center orbits at eccentricity e, shaft speed):
    // m·e². Plus the rotor's spin about its own center (shaft/3) reflected
    // through the 1:3 gearing: I_spin·(1/3)², with I_spin ≈ ½·m·R².
    const m = this.rotor_mass_kg;
    const e = this.eccentricity_m;
    const R = this.generating_radius_m;
    return m * e * e + (0.5 * m * R * R) / 9.0;
  }
  inertiaTorque(_crank: Crankshaft): number {
    // The rotor's orbital and spin motion are steady at constant ω (no
    // reciprocating mass), so — unlike a piston — there is no 2nd-order
    // inertia torque. Its inertia is a constant flywheel-like contribution
    // accounted for in momentOfInertia().
    return 0.0;
  }
  frictionTorque(crank: Crankshaft): number {
    const isStatic = Math.abs(crank.angular_velocity_r_per_s) < STATIC_FRICTION_UPPER_ANGULAR_VELOCITY;
    const fric = isStatic ? this.static_friction_n_m_s_per_r : this.dynamic_friction_n_m_s_per_r;
    return -1.0 * crank.angular_velocity_r_per_s * fric;
  }
  rig(crank: Crankshaft): void {
    this.vol_m3 = this.volumeAtM3(this.theta(crank));
    this.chamber.volume_m3 = this.vol_m3;
  }
  compress(crank: Crankshaft): void {
    const oldVolume = this.vol_m3;
    this.rig(crank);
    this.chamber.gas.static_temperature_k =
      calcNewAdiabaticStaticTemperatureFromVolumeDelta(this.chamber, oldVolume);
  }
}

// Quasiturbine power cell: a 4-sided (rhombus) rotor in an oval housing,
// directly on the output shaft (1:1 — unlike the Wankel's 1:3 gearing). Four
// chambers cycle per rotor; modelled here as a 2-stroke rotary, one volume
// swing per 2π (one firing per shaft revolution per chamber). Four chambers
// phased π/2 apart → four firings per revolution (very smooth, high power
// density). Gas torque = P_gauge·dV/dφ as with the other rotaries.
export class Quasiturbine implements PowerCell {
  kind = "quasiturbine" as const;
  chamber: Chamber;
  valve: Valve;
  sparkplug: Sparkplug;
  generating_radius_m = 0;   // R (rotor "radius")
  rotor_width_m = 0;         // b
  compression_ratio = 0;
  rotor_mass_kg = 0;
  dynamic_friction_n_m_s_per_r = 0;
  static_friction_n_m_s_per_r = 0;
  theta_r = 0;
  swing_m3 = 0;              // per-chamber volume swing (V_max − V_min)
  clearance_m3 = 0;          // V_min
  private vol_m3 = 0;

  constructor(chamber: Chamber, valve: Valve, sparkplug: Sparkplug) {
    this.chamber = chamber;
    this.valve = valve;
    this.sparkplug = sparkplug;
  }

  theta(crank: Crankshaft): number {
    return crank.theta_r + this.theta_r;
  }
  // V(φ) = V_c + (swing/2)(1 − cos φ): one swing per 2π.
  private volumeAtM3(effAngle: number): number {
    return this.clearance_m3 + 0.5 * this.swing_m3 * (1.0 - Math.cos(effAngle));
  }
  volumeM3(): number {
    return this.vol_m3;
  }
  gasTorque(crank: Crankshaft): number {
    // dV/dφ = (swing/2)·sin φ
    const eff = this.theta(crank);
    return calcStaticGaugePressurePa(this.chamber) * (0.5 * this.swing_m3 * Math.sin(eff));
  }
  momentOfInertia(): number {
    // Rotor spins at shaft speed (1:1) about its centre: ½·m·R².
    return 0.5 * this.rotor_mass_kg * this.generating_radius_m * this.generating_radius_m;
  }
  inertiaTorque(_crank: Crankshaft): number {
    return 0.0;  // balanced rotary
  }
  frictionTorque(crank: Crankshaft): number {
    const isStatic = Math.abs(crank.angular_velocity_r_per_s) < STATIC_FRICTION_UPPER_ANGULAR_VELOCITY;
    const fric = isStatic ? this.static_friction_n_m_s_per_r : this.dynamic_friction_n_m_s_per_r;
    return -1.0 * crank.angular_velocity_r_per_s * fric;
  }
  rig(crank: Crankshaft): void {
    this.vol_m3 = this.volumeAtM3(this.theta(crank));
    this.chamber.volume_m3 = this.vol_m3;
  }
  compress(crank: Crankshaft): void {
    const oldVolume = this.vol_m3;
    this.rig(crank);
    this.chamber.gas.static_temperature_k =
      calcNewAdiabaticStaticTemperatureFromVolumeDelta(this.chamber, oldVolume);
  }
}
// one cylinder, combusting in the middle, no cylinder head. Both pistons reach
// TDC (meeting) together; the chamber volume is the sum of their displacements
// from TDC. Typically ported 2-stroke (intake/exhaust ports uncovered by each
// piston near its BDC). Two crankshafts phased by `offset_r` (the exhaust crank
// usually leads) give asymmetric port timing.
//
// As with the rotor, gas torque = P_gauge · dV/dθ — the sum of both pistons'
// slider-crank volume derivatives — and inertia torque is the sum of both
// pistons' reciprocating inertia torques.
export class OpposedPiston implements PowerCell {
  kind = "opposed" as const;
  chamber: Chamber;
  valve: Valve;
  sparkplug: Sparkplug;
  diameter_m = 0;
  throw_a_m = 0; connecting_rod_a_m = 0; mass_a_kg = 0;
  throw_b_m = 0; connecting_rod_b_m = 0; mass_b_kg = 0;
  offset_r = 0;            // phase offset between the two cranks
  clearance_m3 = 0;        // V_min (gap between the two pistons at TDC)
  dynamic_friction_n_m_s_per_r = 0;
  static_friction_n_m_s_per_r = 0;
  theta_r = 0;
  private vol_m3 = 0;

  constructor(chamber: Chamber, valve: Valve, sparkplug: Sparkplug) {
    this.chamber = chamber;
    this.valve = valve;
    this.sparkplug = sparkplug;
  }

  theta(crank: Crankshaft): number {
    return crank.theta_r + this.theta_r;
  }
  private pinY(throwM: number, rodM: number, theta: number): number {
    const s = throwM * Math.sin(theta);
    return Math.sqrt(rodM * rodM - s * s) + throwM * Math.cos(theta);
  }
  // dV/dθ contribution of one slider-crank half: A·throw·sinθ·(1+(throw/rod)cosθ)
  private static dDispDTheta(throwM: number, rodM: number, theta: number): number {
    return throwM * Math.sin(theta) * (1.0 + (throwM / rodM) * Math.cos(theta));
  }
  private static sliderInertiaTorque(
    throwM: number, rodM: number, massKg: number, omega: number, theta: number,
  ): number {
    const I = massKg * throwM * throwM;
    const ratio = throwM / rodM;
    const term1 = 0.25 * Math.sin(theta) * ratio;
    const term2 = 0.5 * Math.sin(2.0 * theta);
    const term3 = 0.75 * Math.sin(3.0 * theta) * ratio;
    return I * omega * omega * (term1 - term2 - term3);
  }
  volumeM3(): number {
    return this.vol_m3;
  }
  gasTorque(crank: Crankshaft): number {
    const theta = this.theta(crank);
    const area = calcCircleAreaM2(this.diameter_m);
    const dV = area * (
      OpposedPiston.dDispDTheta(this.throw_a_m, this.connecting_rod_a_m, theta) +
      OpposedPiston.dDispDTheta(this.throw_b_m, this.connecting_rod_b_m, theta - this.offset_r)
    );
    return calcStaticGaugePressurePa(this.chamber) * dV;
  }
  momentOfInertia(): number {
    return this.mass_a_kg * this.throw_a_m * this.throw_a_m +
           this.mass_b_kg * this.throw_b_m * this.throw_b_m;
  }
  inertiaTorque(crank: Crankshaft): number {
    const theta = this.theta(crank);
    const omega = crank.angular_velocity_r_per_s;
    return OpposedPiston.sliderInertiaTorque(this.throw_a_m, this.connecting_rod_a_m, this.mass_a_kg, omega, theta) +
           OpposedPiston.sliderInertiaTorque(this.throw_b_m, this.connecting_rod_b_m, this.mass_b_kg, omega, theta - this.offset_r);
  }
  frictionTorque(crank: Crankshaft): number {
    const isStatic = Math.abs(crank.angular_velocity_r_per_s) < STATIC_FRICTION_UPPER_ANGULAR_VELOCITY;
    const fric = isStatic ? this.static_friction_n_m_s_per_r : this.dynamic_friction_n_m_s_per_r;
    return -1.0 * crank.angular_velocity_r_per_s * fric;
  }
  rig(crank: Crankshaft): void {
    const theta = this.theta(crank);
    const area = calcCircleAreaM2(this.diameter_m);
    const dispA = (this.connecting_rod_a_m + this.throw_a_m) - this.pinY(this.throw_a_m, this.connecting_rod_a_m, theta);
    const dispB = (this.connecting_rod_b_m + this.throw_b_m) - this.pinY(this.throw_b_m, this.connecting_rod_b_m, theta - this.offset_r);
    this.vol_m3 = this.clearance_m3 + area * (dispA + dispB);
    this.chamber.volume_m3 = this.vol_m3;
  }
  compress(crank: Crankshaft): void {
    const oldVolume = this.vol_m3;
    this.rig(crank);
    this.chamber.gas.static_temperature_k =
      calcNewAdiabaticStaticTemperatureFromVolumeDelta(this.chamber, oldVolume);
  }
}

// Stirling power cell: an external-combustion (closed-cycle) engine. Reuses the
// slider-crank chamber geometry, but replaces the adiabatic compression with
// isothermal-ish heat exchange — the charge is heated toward T_hot during the
// expansion stroke and cooled toward T_cold during compression (a simplified
// Stirling cycle with the regenerator folded into a fast isothermalization).
// No sparkplug/combustion; the heat source is external. The gas breathes
// slightly through the standard ports so the eplenum still gets pressure pulses
// for audio, but the heat exchange dominates the character.
export class Stirling extends Piston {
  kind = "stirling" as const;
  T_hot_k = 900.0;
  T_cold_k = 350.0;
  heat_rate = 0.4;  // fraction of the way toward the target temp per sample
  compress(crank: Crankshaft): void {
    this.rig(crank);  // set volume only — skip the adiabatic heating
    // Expansion (sin θ > 0) absorbs heat at T_hot; compression rejects at T_cold.
    const eff = this.theta(crank);
    const target = Math.sin(eff) > 0.0 ? this.T_hot_k : this.T_cold_k;
    this.chamber.gas.static_temperature_k +=
      this.heat_rate * (target - this.chamber.gas.static_temperature_k);
  }
}

// Gas-turbine power cell (simplified Brayton / turbo-shaft): a constant-volume
// combustor with continuous combustion and a turbine wheel. There is no
// positive-displacement P·dV — the chamber volume is fixed, fuel burns
// continuously (handled in Engine.combustPistonChambers when is_turbine), and
// the gas torque is the steady shaft work extracted from the pressure drop
// across the turbine: τ = P_gauge · K_turbine. The result is a smooth,
// high-revving spool (no per-cycle pulses).
export class Turbine implements PowerCell {
  kind = "turbine" as const;
  chamber: Chamber;
  valve: Valve;
  sparkplug: Sparkplug;
  combustor_volume_m3 = 0;       // constant chamber volume
  torque_constant = 0;           // K_turbine: shaft torque per Pa of gauge pressure
  spool_mass_kg = 0;             // turbine + compressor wheel mass (for MoI)
  spool_radius_m = 0;
  dynamic_friction_n_m_s_per_r = 0;
  static_friction_n_m_s_per_r = 0;
  theta_r = 0;
  burn_rate = 0;               // EMA of recent fuel-burn (mol/step); drives torque
  throttle_open = 1;           // mirrors engine throttle (air flow → power)
  constructor(chamber: Chamber, valve: Valve, sparkplug: Sparkplug) {
    this.chamber = chamber;
    this.valve = valve;
    this.sparkplug = sparkplug;
  }
  theta(crank: Crankshaft): number {
    return crank.theta_r;  // phaseless (continuous flow)
  }
  volumeM3(): number {
    return this.combustor_volume_m3;
  }
  gasTorque(_crank: Crankshaft): number {
    // Turbine shaft torque scales with the fuel burn rate (combustion) AND the
    // air flow (throttle) — a real turbine's power = mass_flow × specific work,
    // and mass_flow is set by the throttle. The 0.15 floor gives a small idle.
    return this.torque_constant * this.burn_rate * (0.15 + 0.85 * this.throttle_open);
  }
  momentOfInertia(): number {
    return 0.5 * this.spool_mass_kg * this.spool_radius_m * this.spool_radius_m;
  }
  inertiaTorque(_crank: Crankshaft): number {
    return 0.0;
  }
  frictionTorque(crank: Crankshaft): number {
    const isStatic = Math.abs(crank.angular_velocity_r_per_s) < STATIC_FRICTION_UPPER_ANGULAR_VELOCITY;
    const fric = isStatic ? this.static_friction_n_m_s_per_r : this.dynamic_friction_n_m_s_per_r;
    return -1.0 * crank.angular_velocity_r_per_s * fric;
  }
  rig(_crank: Crankshaft): void {
    // Constant volume — no kinematic sweep.
    this.chamber.volume_m3 = this.combustor_volume_m3;
  }
  compress(_crank: Crankshaft): void {
    this.chamber.volume_m3 = this.combustor_volume_m3;  // no adiabatic (no volume change)
    // Decay the burn-rate EMA so torque falls off when combustion stops
    // (e.g. limiter cuts ignition). compress() runs every step (rig() does not
    // for the turbine), so the decay must live here.
    this.burn_rate *= 0.9;
  }
}
