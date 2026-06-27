// Wave (pipe) Web Worker. One instance per exhaust pipe; each owns a persistent
// 1-D CFD solver and services solve requests from the sim worker over a shared
// channel, on its own thread. Recovers the native build's per-eplenum threading.

import { runWavePipe } from "./wave-pipe";

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m && m.type === "init") {
    runWavePipe(m.sab as SharedArrayBuffer); // never returns
  }
};
