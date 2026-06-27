# ensim4 (web)

**▶ Play with it live: <https://dynogic.github.io/ensim4-web/>**

A browser port of [glouw/ensim4](https://github.com/glouw/ensim4) — "the (fourth)
internal combustion engine simulator": a real-time engine test-bed that uses
isentropic nozzle flow, chamber thermodynamics, C8H18 combustion, crank/piston
kinematics, a one-dimensional Euler CFD exhaust-pipe solver, and an 8192-tap
convolution reverb to synthesize engine audio at 48 kHz.

This is a **from-scratch TypeScript port** of the C, not a compilation. Every
algorithm is transcribed line-for-line from the C headers — isentropic nozzle
flow, NASA-Glenn cp polynomials, C8H18 combustion, crank/piston kinematics, the
1-D Euler CFD solver, the convolution, the filters. The two original engines
(Ford 1.0 L EcoBoost I3, Inline-8) are reproduced exactly, with the same 48 kHz /
800-sample / 60 Hz cadence and the same radial-graph + scope-plot visualizer.

On top of that faithful port, this version **extends the simulator to 29 engines
across six families** — piston, diesel, two-stroke, alternative-cycle, rotary,
and external/continuous-combustion — all driven by a polymorphic `PowerCell`
interface so the same physics core (nozzle flow, thermodynamics, CFD, audio)
runs every engine type.

The engineering work here is the **platform adaptation** — making a 48 kHz
real-time CFD sim run smoothly in a browser despite JS being ~10–20× slower per
scalar op than `clang -O3 -ffast-math -march=native` C, and despite having no GPU
audio callback or free threads.

---

## Status / results

- **CFD on (default)** — the inline-8 sustains ~**1.16× real-time**; usable, and
  matches the native build's CFD-on default. Lighter engines have comfortable
  headroom.
- **Audio** runs on its own thread (sim worker → `SharedArrayBuffer` ring →
  AudioWorklet), so it's immune to render/GC jank and **keeps running when the
  tab is backgrounded** (paced by `Atomics.wait`, not `rAF`).
- The Node harness verifies **all 29 engines** are deterministic (two identical
  runs produce bit-identical audio, `detMaxDiff = 0`), NaN-free, and
  self-sustaining off the starter. The parallel CFD path is bit-for-bit identical
  to the serial path; the SPSC ring is lossless; snapshots reproduce every
  rendered field.

---

## C app vs. web port

The physics is a faithful 1:1 port. What differs is everything *around* the math —
the platform:

| Concern | C app (`ensim4`) | Web port (this) |
|---|---|---|
| **Execution** | Native via `clang -O3 -ffast-math -march=native` — stack structs, SIMD, fast `pow`/`sqrt` | JS in V8 across **3+ threads** (main, sim worker, audio worklet, one CFD-pipe worker per exhaust). Allocation-free hot path; slower scalar transcendentals |
| **Rendering** | SDL3 (GPU, vsync-locked) | HTML5 Canvas 2D (software, thousands of `fillRect`) — main thread only |
| **Audio out** | SDL3 audio callback | Web Audio `AudioWorklet` draining a `SharedArrayBuffer` ring; gesture-gated (needs a click) |
| **CFD threading** | Each exhaust pipe solves on **its own thread** | **Same** — one Web Worker per pipe, dispatched in parallel and overlapped with the step loop |
| **CFD default** | **ON** | **ON** (sustains real-time with the pipe workers) |
| **Engine choice** | Compile-time (`make ENGINE=…`, `#ifdef`); 2 engines | **29 engines** switchable at runtime via a grouped dropdown (no recompile) |
| **Engine types** | Inline piston only | Piston, V/flat/radial, diesel (auto-ignite), 2-stroke, sleeve-valve, opposed-piston, Wankel rotary, quasiturbine, Stirling, steam, gas turbine, turbojet, Scuderi split-cycle |
| **Loop driver** | `for(;;)` gated by vsync, 1 buffer/frame | Sim worker paced by `Atomics.wait` (survives backgrounding); render on `requestAnimationFrame` |
| **Dev tooling** | `make perf` (perf-stat), `make visualize` (gnuplot) | Vite, `tsc`, npm + bench/correctness harness |

**The remaining native-vs-web gap is raw scalar JS math speed** — the per-sample
`flow()` and CFD inner loops do `pow`/`sqrt` that C vectorizes. That ceiling can
only be closed by compiling the physics to **WebAssembly/SIMD**; everything else
(threading, audio isolation, zero-allocation) is already recovered here.

---

## How to run

```bash
npm install
npm run dev      # Vite serves at http://localhost:5173 (add --host for LAN)
# production:
npm run build && npm run preview
```

### Cross-origin isolation (required for the fast path)

The lock-free `SharedArrayBuffer` audio ring + command queue + per-pipe CFD
channels need the page to be **cross-origin isolated**. `vite.config.ts` sends the
headers in dev and `vite preview`:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

A production host must send the same two headers; on static hosts like GitHub
Pages `coi-serviceworker.js` injects them via a service worker. **Without them the
app automatically falls back** to a single-thread path (sim on main thread, audio
via `postMessage` to the worklet) — it still runs, just without the worker speedup.

### Controls

Click the page once first (browsers block audio until a user gesture), then:

| Key / control | Action |
|---|---|
| **Space** (hold) / **Starter** | Engage the starter motor |
| **D** / **Ignition** | Toggle spark-plug ignition (hold Starter + D to start) |
| **H J K L** | Off / low / mid / high throttle |
| **Throttle slider** | Continuous 0–1 throttle (drag; live % readout, synced from the engine when you press H–L) |
| **Y** | Toggle 1-D CFD exhaust solver (on by default) |
| **T** | Toggle 8192-tap convolution reverb |
| **U** | Toggle scope plot low-pass filter |
| **P / I / E / C / N** | Select pistons / intakes / exhausts / clear / next node |
| click a node | Inspect that node on the scope plots |
| **Engine dropdown** | Switch engine at runtime, grouped by family |

The control bar is organized into four sections split by dividers:
**Run** · **Throttle** · **View** · **Engine**.

---

## Engines

29 engines across six families, all running on the same physics core. Pick one
from the **Engine** dropdown (grouped by family). Startup for most: hold **Space**
(starter) + press **D** (ignite) → release Space once it's firing → throttle up
with **K**/**L** or the slider. Exceptions are noted below.

### 4-Stroke Gasoline
| Engine | Notes |
|---|---|
| Big Single 650 | Single cylinder, heavy flywheel, thumpy |
| Parallel Twin 650 | Two pistons in phase |
| Flat-Twin Boxer | Pistons opposed 180° |
| V-Twin 45° | Harley-style narrow V |
| Ford 1.0 L EcoBoost I3 | *(original port, exact)* 3-cyl, even-firing |
| Inline 4 2.0L | Classic I4 |
| Inline 5 2.5L | 5-cyl, smooth |
| Inline 6 3.0L | Inherently balanced I6 |
| Flat 6 3.0L | Boxer-6 |
| V6 3.2L | 60° V6 |
| Inline 8 | *(original port, exact)* even-firing, smooth — distinct from the V8's 2-bank burble |
| V8 5.0L | Cross-plane V8 |
| V12 6.0L | Smoothest piston configuration |
| Radial 9-cyl | Single-row radial, master rod |

### Diesel
| Engine | Notes |
|---|---|
| Diesel I6 4.5L | Auto-ignites (no spark) — **needs mid+ throttle (K/L)** to sustain; too lean at low throttle |
| Diesel V8 6.5L | As above, V8 layout |

### 2-Stroke
| Engine | Notes |
|---|---|
| 2-Stroke 125 | Ported single, pipes on every downstroke |
| 2-Stroke Triple | Expansion-chamber triple |

### Alt-Cycle / Valve
| Engine | Notes |
|---|---|
| Sleeve-Valve I6 | Sleeve ports (sine pulse) instead of poppet valves |
| Opposed-Piston Twin | Two pistons per cylinder, 2-stroke ported, cranks offset |
| Scuderi Split-Cycle | Compressor piston → crossover plenum → power piston (custom topology) |

### Rotary
| Engine | Notes |
|---|---|
| Wankel 1-Rotor | Mazda-13B-ish; eccentric shaft, 1:3 rotor gearing, 6π cycle |
| Wankel 2-Rotor | |
| Wankel 3-Rotor | |
| Quasiturbine | 4-chamber direct-drive rotary, 2-stroke |

### External / Turbine
| Engine | Notes |
|---|---|
| Stirling Engine | External combustion; isothermal heat exchange (no spark) |
| Steam Engine | H2O working fluid, steam admission (no spark) |
| Gas Turbine | Continuous combustion; **D** ignites the burner, throttle to spool |
| Jet Engine (Turbojet) | Turbine + thrust gauge; Space → D → **L** full → spools to ~2800 r/s, thrust ~48 kN |

> Diesel auto-ignition is gated to the **expansion stroke** (gas torque > 0) at
> chamber temp > 600 K — so it can't fire while the valves are open. Turbines
> need `D` (the `can_ignite` gate) to light the continuous burner, like all
> engines. See `docs/wankel.md` for the rotary geometry derivation.

---

## Power, thrust & scope plots

- **Power gauge** (right panel) shows **indicated** power — cycle-averaged
  gas-torque × angular velocity — finalized on each 4π wrap. This is *not* net
  torque (which → 0 at steady RPM, since it's just d(KE)/dt), so the gauge reads a
  real, useful number both during acceleration (transient peak) and at the
  limiter. Steady inline-8 ≈ 710 kW indicated.
- **Thrust gauge** appears for the jet engine: thrust ∝ ω², displayed in kN.
- **Scope plots** sample the selected node group (`P` pistons / `I` intakes /
  `E` exhausts / click a node) across **21 per-node channels**: volume, static &
  total pressure, static temperature, air/fuel & fuel & combusted-product & H2O
  molar ratios, gamma, momentum, sparkplug voltage, gas & inertia torque, and the
  nozzle flow field (area / Mach / density / velocity / pressure / mass-flow /
  speed-of-sound), plus **turbine burn-rate** (the continuous-combustion power
  proxy, shown for turbine/jet/quasiturbine nodes) and **H2O molar ratio** (most
  visible on the steam engine). `C` clears the selection, `N` steps to the next
  downstream node.

---

## Architecture

```
  main thread              |   sim worker thread          |   audio thread        |   pipe worker(s)
                            |                              |                       |
  input (keys/clicks) -----> CommandWriter ---+--> CommandReader.drain()           |
  requestAnimationFrame    (SAB, lock-free)   |        |                              |
        |                                     |   produceBuffer():                |
    draw scene <----- applySnapshot() <-------+---- engine.run()                   |
    (render.ts,         (protocol.ts patches   |     flow() + step loop            |
     widgets.ts)         a "display" engine;    |        |                           |
     unchanged)          render stays as-is)    |   wave-pipe.dispatch() -----------+---> solvePipeInto()
                                                |        | (overlap step)          |   (one worker/pipe)
                                                |   wave-pipe.join() <-------------+--<  REQ/DONE handshake
                                                |   pushWaveBufferToSynth()         |
                                                |   prod.write(800 samples) --------+--> SAB audio ring
                                                |   (Atomics.wait when full)         |        |
                                                |   postSnapshot() ~30 Hz ----------|        v
                                                |                                    |  AudioWorklet.process()
                                                |                                    |  drains 128-sample blocks
```

### Design

**1. Allocation-free hot path** (`src/sim/nozzle.ts`, `src/sim/engine.ts`)
`flow()` is the single hottest function — called once per graph edge per sample
(~45 edges × 48 000 samples/s on the inline-8). The C returns everything by value
on the stack; a port that allocated the result objects would produce ~14 M
short-lived objects/sec and spend most of its time in GC. `flow()` and the
chamber-state computation instead reuse module-scratch objects (the result is
always consumed synchronously before the next call). `crank()` reuses a holder
instead of allocating per sample.

**2. Simulation moved off the main thread** — the robust fix for stutter. Audio no
longer competes with rendering or GC, and survives background-tab throttling.

- `src/sim/sim-worker.ts` — owns the authoritative engine; paced by `Atomics.wait`
  on the audio ring (real-time even when the tab is backgrounded); drains input;
  posts viz snapshots.
- `src/sim/audio-ring.ts` — lock-free SPSC `SharedArrayBuffer` ring (8192 samples
  ≈ 170 ms). Indices kept in `[0, 2·CAP)` so full ≠ empty; producer writes
  `WRITE`, consumer writes `READ`, each published with `Atomics`.
- `public/ensim-worklet.js` — drains the SAB ring on the audio thread doing
  near-zero work; legacy `postMessage` fallback when not isolated.
- `src/sim/protocol.ts` — compact worker→main viz snapshots (~30 Hz); main patches
  a structurally-identical "display" engine, so `render.ts` / `widgets.ts` stayed
  **unchanged**.
- `src/sim/command-queue.ts` — lock-free main→worker input SAB queue (the worker
  never returns to its event loop, so it can't use `onmessage`).
- `src/audio.ts`, `src/main.ts`, `src/ui/controls.ts` — mode selection,
  orchestration, `Controller` indirection for input.
- `vite.config.ts` — COOP/COEP headers.

**3. Parallel CFD pipe workers** — recovers the native per-pipe threading. The C
runs each exhaust pipe's solver on its own thread; this fans them out:

- `src/sim/wave-solver.ts` — extracted 1-D CFD core (`solvePipeInto`). Identical
  math whether run inline or on a worker.
- `src/sim/wave-pipe.ts` — per-pipe SAB channel + client + worker runner;
  race-free REQ/DONE monotonic-counter handshake, zero-copy SAB-backed I/O.
- `src/sim/wave-worker.ts` — one worker per pipe.
- `src/sim/wave.ts`, `src/sim/engine.ts` — dispatch pipes → run step loop → join
  → mix (pipes solve in parallel **and** overlap the step loop).

### The PowerCell architecture (how 29 engines share one core)

Every chamber attaches to a `PowerCell` (`src/sim/mechanical.ts`) — a polymorphic
interface with `theta()`, `volumeM3()`, `gasTorque()`, `inertiaTorque()`,
`rig()`, `compress()`, and a `kind` tag. Implementations:

- **`Piston`** — slider-crank (the original; bit-identical for the I3/I8).
- **`Rotor`** — Wankel: sinusoidal volume `V(φ) = Vc + (swing/2)(1−cos(2φ/3))`,
  6π cycle, gas torque `P·dV/dφ`, 1:3 rotor/shaft gearing.
- **`OpposedPiston`** — two slider-crank halves sharing one chamber, 2-stroke ported.
- **`Quasiturbine`** — 4-chamber direct-drive (1:1) rotary.
- **`Stirling`** — `extends Piston`, overrides `compress()` for isothermal
  heat exchange (hot on expansion, cold on compression), no combustion.
- **`Turbine`** — continuous combustion; torque `K · burn_rate · (0.15+0.85·throttle)`,
  `burn_rate` an EMA of fuel burn.

`engine.ts`, `sampler.ts`, and `protocol.ts` dispatch on `kind` so the same
stepping, sampling, and snapshot code drives every type. Engine configs are built
from a shared `baseCylConfig()` + overrides (`blueprints.ts`); `buildEngineFor()`
routes the Scuderi (custom crossover-plenum topology) vs. the generic
`buildEngine()`.

**Engine-type flags** on `Engine`: `is_diesel` (auto-ignite on the expansion
stroke when temp > 600 K), `is_steam` (H2O working fluid via `admitSteam()`),
`is_turbine` / `is_jet` (continuous combustion + thrust gauge). The `Valve` was
extended with a per-instance `cycle_r` (4π/6π/2π), `close_r` (windowed
open/hold/close vs. the original single bump — default keeps piston engines
bit-identical), and a `profile` (`"poppet"` | `"sleeve"` sine pulse).

### Smaller changes
- **`sim_speed` readout** — live, color-coded real-time-headroom stat.
- **CFD on by default** to match the C build.
- **Power gauge** (indicated power) and **thrust gauge** (jet).
- **Continuous throttle slider** with a live % readout, synced from the engine.
- **Grouped engine dropdown** — 29 engines in six `<optgroup>` families.
- **Bug fix**: per-buffer `synth.clear()` (a catch-up loop could re-post a stale
  buffer).
- Graceful fallback to the single-thread path when not cross-origin isolated.

---

## Dev / verification harness

Node scripts at the repo root (browser automation couldn't reach `localhost`):

| File | Purpose |
|---|---|
| `correctness.ts` | Determinism + sanity for **all 29 engines**: identical inputs → identical audio (`detMaxDiff=0`); no NaN; self-sustaining off the starter; CFD off and on. **Filterable**: `node ... correctness.ts Stirling Steam` runs only engines whose name contains a filter substring (OR) |
| `bench.ts` | Per-frame timing (RT multiple) across configs |
| `test-cfd.ts` | Parallel CFD == serial CFD, bit-identical |
| `test-ring.ts` | SPSC ring lossless over 5 M samples |
| `integration.ts` | Snapshot reproduces every rendered field |
| `bench-loader.mjs` / `bench-register.mjs` | ESM loader so the `.ts` harness can import extensionless + JSON |

Run with the custom loader (handles extensionless + JSON imports):

```bash
node --import ./bench-register.mjs correctness.ts            # all 29 engines
node --import ./bench-register.mjs correctness.ts Turbine Jet  # just the ones matching a filter
node --import ./bench-register.mjs bench.ts
```

> CFD-on traces in single-threaded Node are slow, so the full 29-engine suite
> takes a while; use the filter to run a subset.

---

## Project layout

```
src/
  main.ts                 orchestration, rAF render loop, mode selection
  audio.ts                AudioContext + AudioWorklet setup (SAB / legacy)
  sim/
    constants.ts  gamma.ts  gas.ts  chamber.ts  nozzle.ts  normalized.ts        physics core
    mechanical.ts  PowerCell interface + Piston/Rotor/OpposedPiston/Quasiturbine/
                   Stirling/Turbine, Valve (cycle_r/close_r/profile), Sparkplug
    wave.ts  wave-solver.ts  wave-pipe.ts  wave-worker.ts                      1-D CFD
    filters.ts  synth.ts  sampler.ts                                       audio synth + scope capture (21 channels)
    nodes.ts  engine.ts  blueprints.ts                                     engine graph + 29 engine configs (ALL_ENGINES / ENGINE_GROUPS)
    sim-worker.ts  audio-ring.ts  command-queue.ts  protocol.ts             threading
  ui/
    render.ts  widgets.ts  controls.ts                                      canvas visualizer + grouped control bar
public/ensim-worklet.js                                                     audio thread SAB drain
docs/wankel.md                                                              Wankel geometry derivation
```

---

## Attribution

Engine-sim inspiration and impulse convolution: [Ange Yaghi](https://github.com/ange-yaghi/engine-sim).
Original simulator: [glouw/ensim4](https://github.com/glouw/ensim4). Licensed under the MIT License,
matching the upstream project.
