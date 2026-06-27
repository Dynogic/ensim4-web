import { defineConfig } from "vite";

// SharedArrayBuffer (used for the lock-free audio ring + command queue between
// the sim worker and the AudioWorklet) requires the page to be cross-origin
// isolated. These headers enable that in dev and `vite preview`; a production
// host must send the same two headers. Without them the app falls back to the
// legacy main-thread audio path automatically.
const crossOriginIsolation = {
  name: "cross-origin-isolation",
  configureServer(server: { middlewares: { use: (fn: (req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void } }) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      next();
    });
  },
};

export default defineConfig({
  // Relative base so the static build deploys under any subpath (e.g. a GitHub
  // Pages project site at https://<user>.github.io/<repo>/).
  base: "./",
  plugins: [crossOriginIsolation],
  server: {
    allowedHosts: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
