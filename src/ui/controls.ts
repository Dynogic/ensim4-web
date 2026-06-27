// Input: keyboard bindings and on-screen buttons (ported from handle_input in
// sdl.h). Input is routed through a Controller so the same wiring drives either
// the in-worker engine (SAB mode, via the command queue) or a local engine
// (legacy fallback). Node hit-testing is geometry-only and stays on the main
// thread against the display engine.

export type SelectMode = "pistons" | "intakes" | "exhausts" | "clear" | "next";

export interface Controller {
  starter(on: boolean): void;
  ignite(): void;
  throttle(level: 0 | 1 | 2 | 3): void;
  cfd(): void;
  convo(): void;
  plotFilter(): void;
  select(mode: SelectMode): void;
  toggleNode(i: number): void;
  switchEngine(which: "8cyl" | "3cyl"): void;
}

export function setupControls(controller: Controller, onGesture: () => void): void {
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

  const mk = (label: string, fn: () => void, hold = false): void => {
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
    ctrl.appendChild(b);
  };

  mk("Starter [space]", () => { controller.starter(true); }, true);
  mk("Ignition [d]", () => controller.ignite());
  mk("Throttle 0 [h]", () => controller.throttle(0));
  mk("Throttle low [j]", () => controller.throttle(1));
  mk("Throttle mid [k]", () => controller.throttle(2));
  mk("Throttle high [l]", () => controller.throttle(3));
  mk("CFD [y]", () => controller.cfd());
  mk("Convolution [t]", () => controller.convo());
  mk("Plot filter [u]", () => controller.plotFilter());
  mk("Pistons [p]", () => controller.select("pistons"));
  mk("Intakes [i]", () => controller.select("intakes"));
  mk("Exhausts [e]", () => controller.select("exhausts"));
  mk("Clear [c]", () => controller.select("clear"));
  mk("Next [n]", () => controller.select("next"));
  mk("Ford I3 engine", () => controller.switchEngine("3cyl"));
  mk("Inline 8 engine", () => controller.switchEngine("8cyl"));
}
