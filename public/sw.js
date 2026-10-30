/* Minimal service worker: lets phones install the portal as an app.
   It does not cache pages, so students always see the latest version. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
