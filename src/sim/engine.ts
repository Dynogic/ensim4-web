// Engine orchestrator: the per-sample simulation step and per-frame run loop
// (ported from engine_s.h).

import {
  FOUR_PI_R,
  SYNTH_BUFFER_SIZE,
  SYNTH_BUFFER_MAX_SIZE,
  min,
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
import { flow, mailGasMail } from "./nozzle";
import { combustC8H18 } from "./chamber";
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
    for (const n of this.nodes) {
      if (n.type === NodeType.piston && n.piston) {
        torque += n.piston.gasTorque(this.crankshaft);
        torque += n.piston.inertiaTorque(this.crankshaft);
        torque += n.piston.frictionTorque(this.crankshaft);
      }
    }
    torque += this.starter.torqueOnFlywheel(this.flywheel, this.crankshaft);
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
        if (n.piston.sparkplug.voltage(this.crankshaft) > 0) {
          combustC8H18(n.piston.chamber, 1.0);
        }
      }
    }
  }

  compressPistons(): void {
    for (const n of this.nodes) {
      if (n.type === NodeType.piston && n.piston) n.piston.compress(this.crankshaft);
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
    if (this.can_ignite) this.combustPistonChambers();
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
  }
}
