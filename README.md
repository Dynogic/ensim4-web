# ensim4 (web)

**▶ Play with it live: <https://dynogic.github.io/ensim4-web/>**

A browser port of [glouw/ensim4](https://github.com/glouw/ensim4) — "the (fourth)
internal combustion engine simulator": a real-time inline engine test-bed that
uses isentropic nozzle flow, chamber thermodynamics, C8H18 combustion,
crank/piston kinematics, a one-dimensional Euler CFD exhaust-pipe solver, and an
8192-tap convolution reverb to synthesize engine audio at 48 kHz.

This is a **from-scratch TypeScript port** of the C, not a compilation. Every
algorithm is transcribed line-for-line from the C headers — isentropic nozzle
flow, NASA-Glenn cp polynomials, C8H18 combustion, crank/piston kinematics, the
1-D Euler CFD solver, the convolution, the filters. The two built-in engines
(Ford 1.0 L EcoBoost I3, Inline-8) are reproduced exactly, with the same 48 kHz /
800-sample / 60 Hz cadence, the same controls, and the same radial-graph +
scope-plot visualizer layout.

The engineering work here is the **platform adaptation** — making a 48 kHz
real-time CFD sim run smoothly in a browser despite JS being ~10–20× slower per
scalar op than `clang -O3 -ffast-math -march=native` C, and despite having no GPU
audio callback or free threads.

---

## Status / results (inline-8)

- **CFD on (default)** — sustains ~**1.16× real-time**; usable, matches the native
  build's CFD-on default.
- **CFD off** — comfortable headroom.
- **Audio** runs on its own thread (sim worker → `SharedArrayBuffer` ring →
  AudioWorklet), so it's immune to render/GC jank and **keeps running when the tab
  is backgrounded** (paced by `Atomics.wait`, not `rAF`).
- The Node harness verifies the sim is deterministic and that the parallel CFD
  path is **bit-for-bit identical** to the serial path; the SPSC ring is lossless;
  snapshots reproduce every rendered field.

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
| **Engine choice** | Compile-time (`make ENGINE=…`, `#ifdef`) | Both built in, switchable at runtime via button |
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
npm run dev      # Vite serves at http://localhost:5173 (or the next free port)
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

A production host must send the same two headers. **Without them the app
automatically falls back** to a single-thread path (sim on main thread, audio via
`postMessage` to the worklet) — it still runs, just without the worker speedup.

### Controls

Click the page once first (browsers block audio until a user gesture), then:

| Key / button | Action |
|---|---|
| **Space** (hold) / **Starter** | Engage the starter motor |
| **D** / **Ignition** | Toggle spark-plug ignition (hold Starter + D to start) |
| **H J K L** / throttle buttons | Off / low / mid / high throttle |
| **Y** | Toggle 1-D CFD exhaust solver (on by default) |
| **T** | Toggle 8192-tap convolution reverb |
| **U** | Toggle scope plot low-pass filter |
| **P / I / E / C / N** | Select pistons / intakes / exhausts / clear / next |
| click a node | Inspect that node on the scope plots |
| **Ford I3 / Inline 8** buttons | Switch engine at runtime |

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

### Smaller changes
- **`sim_speed` readout** — live, color-coded real-time-headroom stat
  (`render.ts`, `widgets.ts`, `main.ts`).
- **CFD on by default** to match the C build.
- **Bug fix**: per-buffer `synth.clear()` (a catch-up loop could re-post a stale
  buffer).
- Graceful fallback to the single-thread path when not cross-origin isolated.

---

## Dev / verification harness

Node scripts at the repo root (browser automation couldn't reach `localhost`):

| File | Purpose |
|---|---|
| `correctness.ts` | Determinism + sanity: identical inputs → identical audio across runs; no NaN; bounds + combustion checks; CFD off and on |
| `bench.ts` | Per-frame timing (RT multiple) across configs |
| `test-cfd.ts` | Parallel CFD == serial CFD, bit-identical |
| `test-ring.ts` | SPSC ring lossless over 5 M samples |
| `integration.ts` | Snapshot reproduces every rendered field |
| `bench-loader.mjs` / `bench-register.mjs` | ESM loader so the `.ts` harness can import extensionless + JSON |

Run with the custom loader (handles extensionless + JSON imports):

```bash
node --import ./bench-register.mjs correctness.ts
node --import ./bench-register.mjs bench.ts
```

---

## Project layout

```
src/
  main.ts                 orchestration, rAF render loop, mode selection
  audio.ts                AudioContext + AudioWorklet setup (SAB / legacy)
  sim/
    constants.ts  gamma.ts  gas.ts  chamber.ts  nozzle.ts  normalized.ts        physics core
    mechanical.ts  valve  crankshaft/flywheel/starter/limiter/sparkplug/piston
    wave.ts  wave-solver.ts  wave-pipe.ts  wave-worker.ts                      1-D CFD
    filters.ts  synth.ts  sampler.ts                                       audio synth + scope capture
    nodes.ts  engine.ts  blueprints.ts                                     engine graph + I3/inline-8
    sim-worker.ts  audio-ring.ts  command-queue.ts  protocol.ts             threading
  ui/
    render.ts  widgets.ts  controls.ts                                      canvas visualizer + input
public/ensim-worklet.js                                                     audio thread SAB drain
```

---

## Attribution

Engine-sim inspiration and impulse convolution: [Ange Yaghi](https://github.com/ange-yaghi/engine-sim).
Original simulator: [glouw/ensim4](https://github.com/glouw/ensim4). Licensed under the MIT License,
matching the upstream project.
