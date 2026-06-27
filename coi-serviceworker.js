/*! coi-serviceworker — enables cross-origin isolation (COOP/COEP) on hosts that
 *  can't send those headers themselves (e.g. GitHub Pages), so that
 *  SharedArrayBuffer becomes available. Single file: it runs as a normal
 *  script in the document to register itself, and as a service worker to
 *  rewrite response headers. Based on the coi-serviceworker technique
 *  (gzambetti), MIT-licensed.
 */
(() => {
  if (typeof window === "undefined") {
    // ---- Service worker scope ----
    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
    self.addEventListener("fetch", (event) => {
      if (event.request.cache === "only-if-cached" && event.request.mode !== "same-origin") return;
      event.respondWith(
        fetch(event.request)
          .then((response) => {
            if (!response || response.status === 0 || response.type === "opaque") return response;
            const headers = new Headers(response.headers);
            headers.set("Cross-Origin-Opener-Policy", "same-origin");
            headers.set("Cross-Origin-Embedder-Policy", "require-corp");
            headers.set("Cross-Origin-Resource-Policy", "cross-origin");
            return new Response(response.body, {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
          })
          .catch(() => fetch(event.request)),
      );
    });
    return;
  }

  // ---- Document scope ----
  const KEY = "coi-reloaded";
  const tried = sessionStorage.getItem(KEY) === "1";
  if (window.crossOriginIsolated || tried) {
    if (tried) sessionStorage.removeItem(KEY);
    return;
  }
  if (!("serviceWorker" in navigator)) return;
  // Register this same file as the service worker (relative to the document so
  // it works under a GitHub Pages project subpath).
  const swUrl = new URL("coi-serviceworker.js", location.href).href;
  navigator.serviceWorker
    .register(swUrl)
    .then((reg) => {
      sessionStorage.setItem(KEY, "1");
      if (reg.active && !navigator.serviceWorker.controller) {
        // First activation: reload so the SW controls the navigation.
        location.reload();
      }
    })
    .catch(() => sessionStorage.removeItem(KEY));
})();
