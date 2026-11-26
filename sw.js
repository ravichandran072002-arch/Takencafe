const CACHE = "ravi-pos-v7";
const ASSETS = ["./", "./index.html", "./manifest.json", "./ui.css", "./ravi-fixes.js", "./ravi-cloud.js",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png", "./icons/apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith("ravi-pos-") && key !== CACHE).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const request = e.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin) return;

  // Only cache the app shell. Same-origin sync requests must stay on the network.
  const isAsset = ASSETS.some(path => new URL(path, self.registration.scope).href === url.href);
  if (!isAsset && request.mode !== "navigate") return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    let response;
    try {
      response = await fetch(request);
    } catch (error) {
      const cached = await cache.match(request);
      if (cached) return cached;
      if (request.mode === "navigate") {
        const shell = await cache.match("./index.html");
        if (shell) return shell;
      }
      throw error;
    }
    if (isAsset && response.ok) {
      try {
        await cache.put(request, response.clone());
      } catch (error) {
        console.warn("Could not update offline app cache", error);
      }
    }
    return response;
  })());
});
