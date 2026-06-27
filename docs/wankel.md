# Wankel (rotary) engine — build notes & math

This documents the Wankel engine added to ensim4-web. Unlike the inline
engines (which are just `CylConfig`s fed to the generic piston builder), the
Wankel is a genuinely new kinematic primitive — a `Rotor` power cell — sharing
the engine graph, gas thermodynamics, audio, CFD, and visualizer with the
piston engines but replacing the slider-crank chamber geometry with epitrochoid
(rotor) geometry.

```
source → throttle → irunner(intake port) → injector → [rotor chamber] → erunner(exhaust port) → eplenum → exhaust → sink
                                                     ↑ one of these chains per chamber (3 per rotor)
```

---

## 1. Why it isn't "just a config"

A reciprocating engine's chamber volume comes from slider-crank kinematics —
a piston pin driven by a crank through a connecting rod. A Wankel has none of
that: its chamber is one of the three volumes trapped between a triangular
rotor's flank and a 2-lobed epitrochoid housing, swept by the rotor orbiting
on an eccentric shaft. The volume-vs-angle curve, the torque, and the inertia
are all different functions.

So the Wankel needs a **new power-cell type**. To add it without touching every
call site, the shared surface between `Piston` and `Rotor` was extracted into a
`PowerCell` interface (`src/sim/mechanical.ts`):

```ts
interface PowerCell {
  kind: "piston" | "rotor";
  chamber: Chamber; valve: Valve; sparkplug: Sparkplug;
  theta(crank): number; volumeM3(): number;
  gasTorque(crank): number; inertiaTorque(crank): number;
  frictionTorque(crank): number; momentOfInertia(): number;
  rig(crank): void; compress(crank): void;
}
```

`Node.piston` is now typed `PowerCell | null`. Every per-node loop in
`engine.ts` / `sampler.ts` / `protocol.ts` (`rigPistons`, `calcTorque`,
`calcMomentOfInertia`, `combustPistonChambers`, `compressPistons`,
`updateNozzleOpenRatios`, sampling, snapshot re-rig) drives any `PowerCell`
unchanged. The node type stays `NodeType.piston` so selection, the injector
edge check, and the "pistons" select mode all work for rotors too.

---

## 2. Geometry and chamber volume

### Parameters

| symbol | meaning                 | 13B-ish value |
|--------|-------------------------|---------------|
| `e`    | eccentricity            | 15 mm         |
| `R`    | generating radius       | 105 mm        |
| `b`    | rotor width             | 80 mm         |
| `CR`   | compression ratio       | 9             |

The eccentric shaft (the output) is the "crankshaft" of the sim. The rotor
orbits at shaft speed and **spins at one-third shaft speed** (2:3 internal
gearing: the rotor's internal gear has 24 teeth, the fixed housing gear 36).

### The 6π chamber cycle

One rotor revolution = 3 eccentric-shaft revolutions = **6π of shaft angle**.
Over those 6π each chamber completes one 4-stroke cycle (intake → compress →
power → exhaust).

A 4-stroke cycle requires **two** volume swings (intake = expand, compress =
contract, power = expand, exhaust = contract). So the chamber volume
oscillates with period **3π** — two swings per 6π:

$$V(\varphi) \;=\; V_c \;+\; \frac{S}{2}\bigl(1-\cos\tfrac{2\varphi}{3}\bigr)$$

where `φ` is the chamber's effective shaft angle (`crank.theta_r − phase`)
and `S` is the per-chamber-per-swing volume swing. This gives:

- minima (TDC) at `φ = 0, 3π, 6π` → two per cycle (`φ=0` is compression-TDC
  where the spark fires; `φ=3π` is exhaust-TDC),
- maxima (BDC) at `φ = 1.5π, 4.5π`.

### Displacement

The standard Wankel per-rotor displacement formula is `3√3·e·R·b`. Setting the
**per-chamber-per-swing** swing to

$$S \;=\; \sqrt{3}\,e\,R\,b$$

makes three chambers × one power swing each = `3·S = 3√3·e·R·b` — the rated
per-rotor displacement (654 cc for the 13B-per-rotor numbers above, since
`3√3·0.015·0.105·0.080 = 6.55×10⁻⁴ m³`).

Clearance follows from the compression ratio `CR = V_max/V_min = (V_c+S)/V_c`:

$$V_c \;=\; \frac{S}{CR-1}$$

For the 13B numbers: `S = 218 cc`, `V_c = 27 cc`, `V_max = 245 cc`, `CR = 9.07`.

### Three chambers, phased

The three chambers are 120° apart in **rotor** angle = **2π apart in shaft
angle**. Chamber `k ∈ {0,1,2}` uses effective angle `φ_k = θ_shaft − 2π·k`.
Each fires (spark at `φ=0`) when `θ_shaft = 2π·k (mod 6π)`, i.e. at
`0, 2π, 4π, 6π, …` — **one firing per shaft revolution** (a 1-rotor Wankel
fires like a 2-cylinder 4-stroke, but smoother).

---

## 3. Gas torque

Shaft work is `W = ∫ P dV`, so the instantaneous gas torque on the shaft is

$$\tau_{gas} \;=\; P_{gauge}\,\frac{dV}{d\varphi}$$

This is thermodynamically exact, and it is the **same identity the piston
engine already uses** — `Piston.gasTorque` equals `P_gauge · dV/dθ` (the
slider-crank's `dV/dθ = A·r·sinθ·(1+(r/L)cosθ)` is just that piston's volume
derivative). For the rotor:

$$\frac{dV}{d\varphi} \;=\; \frac{S}{3}\,\sin\tfrac{2\varphi}{3}$$

so

$$\tau_{gas} \;=\; P_{gauge}\,\tfrac{S}{3}\,\sin\tfrac{2\varphi}{3}$$

- During power (`φ ∈ (0, 1.5π)`): `sin>0`, `P_gauge>0` → **positive** torque
  (combustion pushes the shaft).
- During compression (`φ ∈ (4.5π, 6π)`): `sin<0` → **negative** torque
  (compression absorbs work).

The `Rotor` evaluates this directly from the current chamber gauge pressure
(`calcStaticGaugePressurePa`) and the rotor phase — no separate torque
derivation or moment-arm geometry is needed.

---

## 4. Inertia

The rotor's centre of mass orbits the shaft at radius `e` (shaft speed), and
the rotor spins about its own centre at shaft/3. Reflected to the shaft:

$$I \;=\; \underbrace{m\,e^{2}}_{\text{orbital}} \;+\; \underbrace{\tfrac{1}{9}\,I_{spin}}_{\text{geared spin}}, \qquad I_{spin}\approx\tfrac{1}{2}mR^{2}$$

so `I = m·e² + (½·m·R²)/9`. This is a constant flywheel-like contribution.

**`inertiaTorque = 0`** deliberately. A piston has a 2nd-order inertia torque
from the varying pin velocity (the `inertiaTorque` term in `Piston`). A rotor's
orbital and spin motion are steady at constant `ω` — there is no reciprocating
mass — so there is no such term. Its inertia is fully accounted for in
`momentOfInertia()` above (it just adds to the crankshaft's effective inertia).

`frictionTorque` reuses the piston formula (`−ω · fric`, with the static/dynamic
threshold) — apex-seal and bearing drag are approximated the same way.

---

## 5. Port timing and the `Valve` extension

### 4-stroke phase map (φ from compression-TDC)

| φ range       | stroke      | volume   | port                 |
|---------------|-------------|----------|----------------------|
| `0`           | TDC (spark) | min      | spark fires          |
| `0 → 1.5π`    | power       | → max    | —                    |
| `1.5π → 3π`   | exhaust     | → min    | exhaust port open    |
| `3π → 4.5π`   | intake      | → max    | intake port open     |
| `4.5π → 6π`   | compression | → min    | —                    |

### Why the `Valve` had to change

The original `Valve.nozzleOpenRatio` is a single **bump pulse**:

$$\text{ratio}(x) = \mathrm{clamp}(35x^{4}-84x^{5}+70x^{6}-20x^{7},\ 0,\ 1), \quad x = \frac{\text{phase}}{\textit{ramp}}$$

It opens 0→1 over `[engage, engage+ramp]` and is **closed (0)** everywhere
else — a pulse of width `ramp`. That is fine for a piston (each valve is a
short event per 4π cycle), but a Wankel port needs a wide **open/hold/close
window** within the 6π cycle: hold open across a whole stroke (~1.5π), then
close before the next stroke begins (otherwise the intake stays open during
compression and the charge leaks back out — the first prototype exactly
exhibited this and plateaued at ~170 r/s).

### The fix (`src/sim/mechanical.ts`)

`Valve` gained a per-instance `close_r` (default `Infinity`):

```ts
if (!Number.isFinite(this.close_r))           // default: original bump
  return valveOpenPoly(phase / this.ramp_r);  //   bit-identical to the C port
// windowed port: open-ramp → hold → close-ramp → closed
if (phase < ramp_r)        return valveOpenPoly(phase / ramp_r);
if (phase < close_r)       return 1.0;
if (phase < close_r+ramp_r) return 1.0 - valveOpenPoly((phase-close_r)/ramp_r);
return 0.0;
```

`close_r = Infinity` reproduces the original bump arithmetic exactly, so the
i3/i8 are **bit-identical** (verified: `detMaxDiff=0`, same `omega`). Wankel
ports set a finite `close_r` for a proper window.

`Valve.cycle_r` / `Sparkplug.cycle_r` also became per-instance (default `4π`;
Wankel chambers use `6π`).

### Wankel port windows (engage as phase-from-TDC; close as phase-from-engage)

| port    | engage (after TDC) | close_r | ramp | open window (shaft) |
|---------|--------------------|---------|------|---------------------|
| exhaust | `1.5π`             | `1.5π`  | 0.3π | `1.5π → 3π`         |
| intake  | `2.8π`             | `1.7π`  | 0.3π | `2.8π → 4.5π`       |
| spark   | `0` (on `0.1π`)    | —       | —    | at TDC              |

The intake closes at `2.8π + 1.7π = 4.5π` (start of compression) and the
exhaust at `1.5π + 1.5π = 3π` (start of intake) — so neither port leaks charge
across the stroke it shouldn't.

---

## 6. Config and wiring

`ENGINE_WANKEL_1R` in `src/sim/blueprints.ts` reuses the same node topology as
the piston engines (`buildEngine` branches on `rotor_generating_radius_m !=
null` to construct a `Rotor` instead of a `Piston`, and sets the ports'
`cycle_r = 6π`). The 3 chambers use `piston_thetas_r = [0, 2π, 4π]`, a single
eplenum (`eplenum_assignment = [0,0,0]`), and a high-rev limiter (`1200 r/s`).
Piston-geometry fields are zeroed (unused by the rotor).

Engine selection:

- `CFGS` index `2` in `src/main.ts` and `src/sim/sim-worker.ts`
- `Controller.switchEngine("wankel")` in `src/ui/controls.ts` (+ "Wankel 1-rotor" button)
- `OP.SWITCH` arg `2` in `src/sim/command-queue.ts`
- `"wankel"` in the `Cmd` union in `src/sim/protocol.ts`

### Rendering (`src/ui/render.ts`)

`drawPistons` branches on `p.kind`: a rotor cell draws a square (housing) with
a triangle (the rotor) rotating at `θ_shaft / 3` (the 1:3 gearing), coloured
when its sparkplug fires. The three cells are the same physical rotor drawn
per-chamber, matching the per-cylinder convention of the piston row.

---

## 7. Verification (`correctness.ts`)

Determinism + NaN + acceleration check, added the Wankel to the loop:

```
Inline 8               cfd=off  detMaxDiff=0  nan=false  omega=1219.5  OK
Ford 1.0 L EcoBoost I3  cfd=off  detMaxDiff=0  nan=false  omega= 386.2  OK
Wankel 1-Rotor         cfd=off  detMaxDiff=0  nan=false  omega= 590.0  OK
Wankel 1-Rotor         cfd=on   detMaxDiff=0  nan=false  omega= 305.3  OK
```

- **Piston engines bit-identical** to before the change (`detMaxDiff=0`,
  identical `omega`).
- The Wankel is deterministic, NaN-free, and self-sustains off the starter
  (starter cuts at `ω·gearRatio ≥ no_load`, so anything above ~60 r/s is
  combustion). Over a longer run it sustains ~1150 r/s, bouncing off the
  1200 r/s limiter — the high-revving rotary character.

---

## 8. Tuning levers & extensions

- **Displacement / size**: `rotor_generating_radius_m`, `rotor_eccentricity_m`,
  `rotor_width_m` → `S = √3·e·R·b`.
- **Compression**: `rotor_compression_ratio` → `V_c = S/(CR−1)`.
- **Rev range**: `limiter_cutoff_r_per_s`, `flywheel_*` (rotaries are smooth →
  lighter flywheel), `rotor_*_friction`.
- **Port timing**: the engage / `close_r` / ramp fields above.
- **2-rotor (13B-style)**: a second `CylConfig` with 6 chambers,
  `piston_thetas_r = [0, 2π, 4π, 0, 2π, 4π]` (or a 6-phase spread),
  `num_eplenums = 2`, `eplenum_assignment = [0,0,0, 1,1,1]`. No new physics —
  pure config.

### Simplifications (documented honestly)

- The volume model is the **standard sinusoidal approximation** of the
  epitrochoid (correct displacement, correct compression ratio, correct
  phasing and two-swing 4-stroke structure). The exact Wankel chamber volume
  has additional high-order harmonics; this approximation is in the same
  spirit as the sim's other simplifications (adiabatic compression, lumped
  gas). It can be replaced by a numerically-integrated epitrochoid LUT later
  without touching anything but `Rotor.volumeAtM3`.
- Rotor imbalance (real Wankels have a small 1×-per-rev shake) is not modelled;
  `inertiaTorque` is zero (the rotor is treated as balanced).
- Port flow uses the same ΔP-gated convergent nozzle as pistons (no
  peripheral-vs-side-port distinction).
