// Input: keyboard bindings and on-screen buttons (ported from handle_input in
// sdl.h). Input is routed through a Controller so the same wiring drives either
// the in-worker engine (SAB mode, via the command queue) or a local engine
// (legacy fallback). Node hit-testing is geometry-only and stays on the main
// thread against the display engine.

// Throttle slider state — kept here so the render loop can sync the slider to
// the engine's actual throttle (set by h/j/k/l) without fighting the pointer.
let throttleSlider: HTMLInputElement | null = null;
let throttlePct: HTMLElement | null = null;
let throttleDragging = false;

/** Mirror the engine's throttle (0..1) into the slider + % readout, unless dragging. */
export function syncThrottleSlider(v: number): void {
  const c = v < 0 ? 0 : v > 1 ? 1 : v;
  if (throttleSlider && !throttleDragging) {
    const s = String(c);
    if (throttleSlider.value !== s) throttleSlider.value = s;
  }
  if (throttlePct) throttlePct.textContent = Math.round(c * 100) + "%";
}

export type SelectMode = "pistons" | "intakes" | "exhausts" | "clear" | "next";

export interface Controller {
  starter(on: boolean): void;
  ignite(): void;
  throttle(level: 0 | 1 | 2 | 3): void;
  throttleSet(v: number): void;   // continuous 0..1
  cfd(): void;
  convo(): void;
  plotFilter(): void;
  select(mode: SelectMode): void;
  toggleNode(i: number): void;
  switchEngine(id: number): void;
}

export interface EngineGroup {
  label: string;
  engines: { name: string; id: number }[];
}

export function setupControls(controller: Controller, engineGroups: EngineGroup[], onGesture: () => void): void {
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    switch (k) {
      case " ": e.preventDefault(); controller.starter(true); onGesture(); break;
      case "d": controller.ignite(); break;
      case "h": controller.throttle(0); break;
      case "j": controller.throttle(1); break;
      case "k": controller.throttle(2); break;
      case "l": controller.throttle(3); break;
      case "y": controller.cfd(); break;
      case "u": controller.plotFilter(); break;
      case "t": controller.convo(); break;
    }
  });

  window.addEventListener("keyup", (e) => {
    const k = e.key.toLowerCase();
    switch (k) {
      case " ": controller.starter(false); break;
      case "p": controller.select("pistons"); break;
      case "i": controller.select("intakes"); break;
      case "e": controller.select("exhausts"); break;
      case "c": controller.select("clear"); break;
      case "n": controller.select("next"); break;
    }
  });

  const ctrl = document.getElementById("controls");
  if (!ctrl) return;

  const group = (): HTMLElement => {
    const g = document.createElement("div");
    g.className = "grp";
    ctrl.appendChild(g);
    return g;
  };
  const divider = (): void => {
    const d = document.createElement("div");
    d.className = "div";
    ctrl.appendChild(d);
  };

  const mk = (parent: HTMLElement, label: string, fn: () => void, hold = false): void => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (hold) {
      b.addEventListener("pointerdown", (ev) => { ev.preventDefault(); fn(); onGesture(); });
      const off = () => { controller.starter(false); };
      b.addEventListener("pointerup", off);
      b.addEventListener("pointerleave", off);
      b.addEventListener("pointercancel", off);
    } else {
      b.addEventListener("click", () => { fn(); onGesture(); });
    }
    parent.appendChild(b);
  };

  // Run: starter + ignition
  const gRun = group();
  mk(gRun, "Starter [space]", () => { controller.starter(true); }, true);
  mk(gRun, "Ignition [d]", () => controller.ignite());

  divider();

  // Throttle: presets + continuous slider with a live % readout
  const gThr = group();
  mk(gThr, "0 [h]", () => controller.throttle(0));
  mk(gThr, "low [j]", () => controller.throttle(1));
  mk(gThr, "mid [k]", () => controller.throttle(2));
  mk(gThr, "high [l]", () => controller.throttle(3));
  const thr = document.createElement("div");
  thr.className = "thr";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "1";
  slider.step = "0.001";
  slider.value = "0";
  slider.title = "Throttle (continuous)";
  slider.addEventListener("input", () => {
    controller.throttleSet(parseFloat(slider.value));
    onGesture();
  });
  // Suppress external sync while the user is dragging (else the snapshot's
  // ~30 Hz update would fight the pointer).
  slider.addEventListener("pointerdown", () => { throttleDragging = true; });
  const release = () => { throttleDragging = false; };
  slider.addEventListener("pointerup", release);
  slider.addEventListener("pointerleave", release);
  slider.addEventListener("pointercancel", release);
  throttleSlider = slider;
  throttlePct = document.createElement("span");
  throttlePct.className = "pct";
  throttlePct.textContent = "0%";
  thr.appendChild(slider);
  thr.appendChild(throttlePct);
  gThr.appendChild(thr);

  divider();

  // View / node selection
  const gView = group();
  mk(gView, "CFD [y]", () => controller.cfd());
  mk(gView, "Convolution [t]", () => controller.convo());
  mk(gView, "Plot filter [u]", () => controller.plotFilter());
  mk(gView, "Pistons [p]", () => controller.select("pistons"));
  mk(gView, "Intakes [i]", () => controller.select("intakes"));
  mk(gView, "Exhausts [e]", () => controller.select("exhausts"));
  mk(gView, "Clear [c]", () => controller.select("clear"));
  mk(gView, "Next [n]", () => controller.select("next"));

  divider();

  // Engine picker — a grouped <select> (one <optgroup> per family). Option
  // value = engine id (index into ALL_ENGINES).
  const gEng = group();
  const sel = document.createElement("select");
  sel.className = "eng";
  sel.title = "Engine";
  for (const grp of engineGroups) {
    const og = document.createElement("optgroup");
    og.label = grp.label;
    for (const eng of grp.engines) {
      const opt = document.createElement("option");
      opt.value = String(eng.id);
      opt.textContent = eng.name;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  sel.value = "0";
  sel.addEventListener("change", () => {
    controller.switchEngine(parseInt(sel.value, 10));
    onGesture();
    // Drop focus so the <select> stops capturing keyboard (Space would reopen
    // the dropdown; letter keys would jump-select options).
    sel.blur();
  });
  gEng.appendChild(sel);
}
