// Web Audio output. Prefers SAB mode: the AudioWorklet drains a SharedArrayBuffer
// ring written directly by the sim Web Worker, so the main thread is entirely out
// of the audio path. Falls back to legacy mode (main thread posts 800-sample
// buffers) when the page isn't cross-origin isolated (no SharedArrayBuffer).

import { RING_LAYOUT } from "./sim/audio-ring";

type AnyAudioContextCtor = typeof AudioContext;

export class AudioOut {
  ctx: AudioContext | null = null;
  node: AudioWorkletNode | ScriptProcessorNode | null = null;
  fill = 0;
  ready = false;
  mode: "sab" | "legacy" = "legacy";
  ringSab: SharedArrayBuffer | null = null;

  // legacy main-thread ring (ScriptProcessor fallback only)
  private ring = new Float32Array(8192);
  private write = 0;
  private read = 0;
  private useWorklet = false;

  // Pass the shared ring (created by main and also handed to the sim worker) to
  // enable SAB mode; pass null for the legacy main-thread-fed path.
  async init(ringSab: SharedArrayBuffer | null): Promise<void> {
    const w = window as unknown as {
      AudioContext?: AnyAudioContextCtor;
      webkitAudioContext?: AnyAudioContextCtor;
    };
    const Ctor = w.AudioContext || w.webkitAudioContext;
    if (!Ctor) throw new Error("AudioContext not supported");

    try {
      this.ctx = new Ctor({ sampleRate: 48000 });
    } catch {
      this.ctx = new Ctor();
    }

    const aw = (this.ctx as unknown as { audioWorklet?: { addModule?: (u: string) => Promise<void> } }).audioWorklet;
    if (aw && typeof aw.addModule === "function") {
      try {
        const url = import.meta.env.BASE_URL + "ensim-worklet.js";
        await aw.addModule(url);

        if (ringSab) {
          this.ringSab = ringSab;
          this.node = new AudioWorkletNode(this.ctx, "ensim-processor", {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: {
              sab: this.ringSab,
              capacity: RING_LAYOUT.capacity,
              headerI32: RING_LAYOUT.headerI32,
              write: RING_LAYOUT.write,
              read: RING_LAYOUT.read,
              mod: RING_LAYOUT.mod,
              dataByteOffset: RING_LAYOUT.dataByteOffset,
            },
          });
          this.node.connect(this.ctx.destination);
          this.useWorklet = true;
          this.mode = "sab";
          this.ready = true;
          console.info("[ensim4] audio: AudioWorklet + SAB @", this.ctx.sampleRate, "Hz");
          return;
        }

        // Legacy AudioWorklet: main thread posts buffers, worklet reports fill.
        this.node = new AudioWorkletNode(this.ctx, "ensim-processor", {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        this.node.port.onmessage = (e: MessageEvent<number>) => {
          this.fill = e.data;
        };
        this.node.connect(this.ctx.destination);
        this.useWorklet = true;
        this.mode = "legacy";
        this.ready = true;
        console.info("[ensim4] audio: AudioWorklet (legacy, no SAB) @", this.ctx.sampleRate, "Hz");
        return;
      } catch (err) {
        console.warn("[ensim4] AudioWorklet init failed, falling back:", err);
      }
    }

    // Fallback: ScriptProcessorNode draining a main-thread ring (legacy only).
    const sp = this.ctx.createScriptProcessor(2048, 0, 1);
    sp.onaudioprocess = (e: AudioProcessingEvent) => {
      const out = e.outputBuffer.getChannelData(0);
      const n = out.length;
      const ring = this.ring;
      const len = ring.length;
      let i = 0;
      while (i < n && this.fill > 0) {
        out[i++] = ring[this.read];
        this.read = (this.read + 1) % len;
        this.fill--;
      }
      while (i < n) out[i++] = 0;
    };
    sp.connect(this.ctx.destination);
    this.node = sp;
    this.mode = "legacy";
    this.ready = true;
    console.info("[ensim4] audio: ScriptProcessor fallback @", this.ctx.sampleRate, "Hz");
  }

  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state !== "running") {
      try {
        await this.ctx.resume();
      } catch {
        /* ignore */
      }
    }
  }

  // Legacy-mode buffer push (no-op in SAB mode; the worker writes the ring).
  post(samples: Float32Array): void {
    if (!this.node || this.mode === "sab") return;
    if (this.useWorklet) {
      (this.node as AudioWorkletNode).port.postMessage(samples);
      return;
    }
    const ring = this.ring;
    const len = ring.length;
    for (let i = 0; i < samples.length; i++) {
      ring[this.write] = samples[i];
      this.write = (this.write + 1) % len;
      if (this.fill >= len) this.read = (this.read + 1) % len;
      else this.fill++;
    }
  }
}
