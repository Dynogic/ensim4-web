// Engine orchestrator: the per-sample simulation step and per-frame run loop
// (ported from engine_s.h).

import {
  FOUR_PI_R,
  SYNTH_BUFFER_SIZE,
  SYNTH_BUFFER_MAX_SIZE,
  min,
  DIESEL_AUTOIGNITION_K,
  DIESEL_BURN_FRACTION,
} from "./constants";
import {
  type Node,
  NodeType,
  countNodeEdges,
  isReservoir,
  normalizeNode,
  selectNodes,
} from "./nodes";
import { Sampler } from "./sampler";
import { Synth } from "./synth";
import { Crankshaft, Flywheel, Starter, Limiter } from "./mechanical";
import { Turbine, FuelCell } from "./mechanical";
import { flow, mailGasMail } from "./nozzle";
import { combustC8H18, admitSteam, reactFuelCell } from "./chamber";
import { calcMolAirFuelRatio, IDEAL_MOL_AIR_FUEL_RATIO } from "./gas";
import { waveTable } from "./wave";

export interface EngineTime {
  getTicksMs: () => number;
  fluids_time_ms: number;
  kinematics_time_ms: number;
  thermo_time_ms: number;
  synth_time_ms: number;
  wave_time_ms: number;
}

// Reused across crank() calls so the per-sample step allocates nothing.
const canIgniteHolder = { value: false };

export class Engine {
  name = "";
  nodes: Node[] = [];
  crankshaft = new Crankshaft();
  flywheel = new Flywheel();
  starter = new Starter();
  limiter = new Limiter();
  throttle_open_ratio = 0;
  no_throttle = 0;
  low_throttle = 0;
  mid_throttle = 0;
  high_throttle = 0;
  radial_spacing = 0;
  volume = 0;
  use_cfd = false;
  use_convolution = false;
  can_ignite = false;
  use_plot_filter = false;
  is_diesel = false;
  is_steam = false;
  is_turbine = false;
  is_jet = false;
  is_fuelcell = false;
  power_w = 0;               // indicated (gas) power, cycle-averaged; patched from snapshot in SAB mode
  private gas_torque_n_m = 0; // indicated (gas-only) torque from the last calcTorque()
  private power_sum = 0;     // running ∑(gasTorque×ω) over the current 4π cycle
  private power_count = 0;

  analyze(): void {
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      if (node.type === NodeType.eplenum && countNodeEdges(node) !== 1) {
        throw new Error(`eplenum[${i}] requires exactly one next[] edge`);
      }
      if (node.type === NodeType.injector) {
        if (countNodeEdges(node) !== 1) {
          throw new Error(`injector[${i}] requires exactly one next[] edge`);
        }
        const next = this.nodes[node.next[0]];
        if (next.type !== NodeType.piston) {
          throw new Error(`injector[${i}] must connect directly to a piston`);
        }
      }
    }
  }

  normalizeAll(): void {
    for (const n of this.nodes) normalizeNode(n);
  }

  rigPistons(): void {
    for (const n of this.nodes) {
      if (n.type === NodeType.piston && n.piston) n.piston.rig(this.crankshaft);
    }
  }

  flow(sampler: Sampler): void {
    const nodes = this.nodes;
    const crank = this.crankshaft;
    for (let i = 0; i < nodes.length; i++) {
      const x = nodes[i];
      const edges = x.next;
      const xchamber = x.chamber;
      for (let j = 0; j < edges.length; j++) {
        const y = nodes[edges[j]];
        const nf = flow(xchamber, y.chamber);
        if (x.is_selected) sampler.sampleChannel(x, nf, crank);
        if (isReservoir(x)) nf.gas_mail.is_from_reservoir = true;
        if (nf.is_success) mailGasMail(nf.gas_mail);
        if (x.type === NodeType.eplenum) {
          const ff = nf.flow_field;
          waveTable.stage(x.waveIndex, ff.static_density_kg_per_m3, ff.velocity_m_per_s, ff.static_pressure_pa);
        }
      }
    }
  }

  calcTorque(): number {
    let torque = 0;
    let gas = 0;
    for (const n of this.nodes) {
      if (n.type === NodeType.piston && n.piston) {
        const gt = n.piston.gasTorque(this.crankshaft);
        gas += gt;
        torque += gt;
        torque += n.piston.inertiaTorque(this.crankshaft);
        torque += n.piston.frictionTorque(this.crankshaft);
      }
    }
    torque += this.starter.torqueOnFlywheel(this.flywheel, this.crankshaft);
    // Stash the gas-only (indicated) torque for the power gauge. Net `torque`
    // drives the dynamics; gas torque is what combustion develops on the piston.
    this.gas_torque_n_m = gas;
    return torque;
  }

  calcMomentOfInertia(): number {
    let moi = 0;
    for (const n of this.nodes) {
      if (n.type === NodeType.piston && n.piston) moi += n.piston.momentOfInertia();
    }
    moi += this.crankshaft.momentOfInertia();
    moi += this.flywheel.momentOfInertia();
    return moi;
  }

  crank(sampler: Sampler): void {
    const torque = this.calcTorque();
    // Accumulate INDICATED power (gas torque × ω) over a 4π cycle, finalized on
    // the cycle wrap below. Use gas torque, NOT net torque: at steady-state RPM
    // the net torque averages to ~0 (the crank no longer accelerates), so net×ω
    // reads ~0 and flips sign cycle-to-cycle. Gas-only is the power combustion
    // actually develops on the piston, which stays positive while firing.
    const omega = this.crankshaft.angular_velocity_r_per_s;
    this.power_sum += this.gas_torque_n_m * omega;
    this.power_count++;
    const moi = this.calcMomentOfInertia();
    const alpha = torque / moi;
    this.crankshaft.accelerate(alpha);
    const t0 = this.crankshaft.theta_r;
    this.crankshaft.turn();
    const t1 = this.crankshaft.theta_r;
    if (t0 !== t1) {
      const tx = t0 % FOUR_PI_R;
      const ty = t1 % FOUR_PI_R;
      if (ty < tx) {
        // Crossed the 4π cycle boundary → finalize the cycle-average power.
        if (this.power_count > 0) this.power_w = this.power_sum / this.power_count;
        this.power_sum = 0;
        this.power_count = 0;
        sampler.size = sampler.index;
        sampler.index = 0;
      } else {
        sampler.index += 1;
        sampler.index = min(sampler.index, 16384 - 1);
      }
    }
    canIgniteHolder.value = this.can_ignite;
    this.limiter.maybeLimit(this.crankshaft, canIgniteHolder);
    this.can_ignite = canIgniteHolder.value;
  }

  combustPistonChambers(): void {
    for (const n of this.nodes) {
      if (n.type === NodeType.piston && n.piston) {
        const c = n.piston.chamber;
        if (this.is_turbine) {
          const t = n.piston as Turbine;
          t.throttle_open = this.throttle_open_ratio;
          // Continuous combustion: burn a fraction of whatever fuel is present
          // every step (no spark gating). Track the burn rate for torque.
          const before = c.gas.mol_ratio_c8h18;
          if (before > 0.0) {
            combustC8H18(c, 0.05);
            t.burn_rate += (before - c.gas.mol_ratio_c8h18);
          }
        } else if (this.is_steam) {
          // Steam admission: at the admission window (reusing the sparkplug
          // timing as the admission phase), charge the chamber with high-
          // pressure steam instead of combusting fuel.
          if (n.piston.sparkplug.voltage(this.crankshaft) > 0) {
            admitSteam(c);
          }
        } else if (this.is_diesel) {
          // Compression ignition: auto-ignite when the charge is hot enough,
          // but only on the expansion stroke (gasTorque > 0 = dV/dθ > 0 with
          // positive gauge pressure). Firing during compression would produce
          // negative torque; this confines the burn to just-after-TDC, like a
          // real diesel's delayed direct-injection burn.
          if (
            c.gas.mol_ratio_c8h18 > 0.0 &&
            c.gas.static_temperature_k > DIESEL_AUTOIGNITION_K &&
            n.piston.gasTorque(this.crankshaft) > 0.0
          ) {
            combustC8H18(c, DIESEL_BURN_FRACTION);
          }
        } else if (n.piston.sparkplug.voltage(this.crankshaft) > 0) {
          combustC8H18(c, 1.0);
        }
      }
    }
  }

  compressPistons(): void {
    for (const n of this.nodes) {
      if (n.type === NodeType.piston && n.piston) n.piston.compress(this.crankshaft);
    }
  }

  // Fuel-cell electrochemical reaction (NOT combustion): H2 + O2 → H2O. The H2
  // fuel is admitted internally (not a tracked gas species, no injector); the
  // reaction consumes O2 from the air charge and produces H2O + electricity.
  // Torque tracks throttle × O2-availability INSTANTLY (no spool lag). This is
  // kept separate from combustPistonChambers() — a fuel cell does not combust.
  reactFuelCellChambers(): void {
    for (const n of this.nodes) {
      if (n.type === NodeType.piston && n.piston) {
        const fc = n.piston as FuelCell;
        const c = fc.chamber;
        fc.throttle_open = this.throttle_open_ratio;
        // reaction_rate is throttle-driven (not O2-limited): a real fuel-cell
        // controller modulates H2 flow to match available air, so the electrical
        // output tracks demand. O2 is consumed at a tiny rate just for gas-
        // composition tracking (the scope shows O2 depleting / H2O rising).
        fc.reaction_rate = 0.15 + 0.85 * fc.throttle_open;
        if (c.gas.mol_ratio_o2 > 0.001) {
          reactFuelCell(c, 0.002);
        }
      }
    }
  }

  updateNozzleOpenRatios(): void {
    const nodes = this.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      switch (node.type) {
        case NodeType.piston: {
          const p = node.piston!;
          p.chamber.nozzle_open_ratio = p.valve.nozzleOpenRatio(this.crankshaft);
          break;
        }
        case NodeType.irunner: {
          node.chamber.nozzle_open_ratio = node.valve!.nozzleOpenRatio(this.crankshaft);
          break;
        }
        case NodeType.injector: {
          // Fuel cells admit H2 internally (electrochemical, not combustion) —
          // no gasoline (C8H18) injection. All other engines inject fuel when
          // the charge is lean.
          if (this.is_fuelcell) {
            node.chamber.nozzle_open_ratio = 0.0;
            break;
          }
          const chamber = nodes[node.nozzleIndex].chamber;
          if (chamber.nozzle_open_ratio > 0) {
            const piston = nodes[node.next[0]].piston!;
            node.chamber.nozzle_open_ratio =
              calcMolAirFuelRatio(piston.chamber.gas) > IDEAL_MOL_AIR_FUEL_RATIO ? 1.0 : 0.0;
          } else {
            node.chamber.nozzle_open_ratio = 0.0;
          }
          break;
        }
        case NodeType.throttle: {
          node.chamber.nozzle_open_ratio = this.throttle_open_ratio;
          break;
        }
        default: {
          node.chamber.nozzle_open_ratio = 1.0;
          break;
        }
      }
    }
  }

  enableCfd(useCfd: boolean): void {
    this.use_cfd = useCfd;
    for (const n of this.nodes) {
      if (n.type === NodeType.eplenum) n.useCfd = useCfd;
    }
  }

  reset(): void {
    this.analyze();
    this.enableCfd(true);
    this.use_convolution = true;
    this.use_plot_filter = true;
    this.starter.is_on = false;
    this.throttle_open_ratio = 0.01;
    waveTable.resetAll();
    this.rigPistons();
    this.normalizeAll();
    selectNodes(this.nodes, NodeType.piston);
  }

  flipWaves(): void {
    for (const n of this.nodes) {
      if (n.type === NodeType.eplenum) waveTable.flip(n.waveIndex);
    }
  }
  launchWaves(): void {
    for (const n of this.nodes) {
      if (n.type === NodeType.eplenum) {
        waveTable.batch(n.waveIndex, n.useCfd, n.pipeLengthM, n.micPositionRatio, n.velocityLowPassCutoffFrequencyHz);
      }
    }
  }
  joinWaves(): void {
    for (const n of this.nodes) {
      if (n.type === NodeType.eplenum) waveTable.join(n.waveIndex);
    }
  }
  sumWaves(): void {
    waveTable.clearBuffer();
    for (const n of this.nodes) {
      if (n.type === NodeType.eplenum) waveTable.addToBuffer(n.waveIndex);
    }
  }
  pushWaveBufferToSynth(synth: Synth, samplerSynth: Float32Array): void {
    this.sumWaves();
    const buf = waveTable.waveBufferPa;
    const crank = this.crankshaft;
    const useConv = this.use_convolution;
    const vol = this.volume;
    for (let i = 0; i < SYNTH_BUFFER_SIZE; i++) {
      samplerSynth[i] = synth.push(crank, buf[i], useConv, vol);
    }
  }

  step(et: EngineTime, sampler: Sampler): void {
    sampler.resetChannel();
    const t0 = et.getTicksMs();
    this.flow(sampler);
    const t1 = et.getTicksMs();
    this.crank(sampler);
    this.compressPistons();
    this.updateNozzleOpenRatios();
    const starterAngVel = this.starter.angularVelocity(this.flywheel, this.crankshaft);
    sampler.sampleStarter(starterAngVel);
    const t2 = et.getTicksMs();
    if (this.can_ignite) {
      if (this.is_fuelcell) this.reactFuelCellChambers();
      else this.combustPistonChambers();
    }
    const t3 = et.getTicksMs();
    et.fluids_time_ms += t1 - t0;
    et.kinematics_time_ms += t2 - t1;
    et.thermo_time_ms += t3 - t2;
  }

  runWithWaves(et: EngineTime, sampler: Sampler, synth: Synth, audioBufferSize: number, samplerSynth: Float32Array): boolean {
    if (audioBufferSize < SYNTH_BUFFER_MAX_SIZE) {
      this.flipWaves();
      this.launchWaves(); // dispatches CFD pipes to their workers (SAB mode)
      for (let i = 0; i < SYNTH_BUFFER_SIZE; i++) this.step(et, sampler);
      this.joinWaves(); // wait for the pipe workers before mixing
      const t1 = et.getTicksMs();
      this.pushWaveBufferToSynth(synth, samplerSynth);
      const t2 = et.getTicksMs();
      et.synth_time_ms = t2 - t1;
      return true;
    }
    return false;
  }

  run(et: EngineTime, sampler: Sampler, synth: Synth, audioBufferSize: number, samplerSynth: Float32Array): boolean {
    const t0 = et.getTicksMs();
    const produced = this.runWithWaves(et, sampler, synth, audioBufferSize, samplerSynth);
    const t3 = et.getTicksMs();
    et.wave_time_ms += t3 - t0;
    return produced;
  }

  // Replace this engine's contents with another's (used when switching engines
  // so existing references/closures stay valid).
  copyFrom(o: Engine): void {
    this.name = o.name;
    this.nodes = o.nodes;
    this.crankshaft = o.crankshaft;
    this.flywheel = o.flywheel;
    this.starter = o.starter;
    this.limiter = o.limiter;
    this.throttle_open_ratio = o.throttle_open_ratio;
    this.no_throttle = o.no_throttle;
    this.low_throttle = o.low_throttle;
    this.mid_throttle = o.mid_throttle;
    this.high_throttle = o.high_throttle;
    this.radial_spacing = o.radial_spacing;
    this.volume = o.volume;
    this.use_cfd = o.use_cfd;
    this.use_convolution = o.use_convolution;
    this.can_ignite = o.can_ignite;
    this.use_plot_filter = o.use_plot_filter;
    this.is_diesel = o.is_diesel;
    this.is_steam = o.is_steam;
    this.is_turbine = o.is_turbine;
    this.is_jet = o.is_jet;
    this.is_fuelcell = o.is_fuelcell;
    this.power_w = o.power_w;
  }
}
