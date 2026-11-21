// Raccolta Dati Evento: works offline. Change VERSION when you upload a new index.html.
const VERSION = "rde-v17";
const FILES = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "firebase-app-compat.js", "firebase-auth-compat.js", "firebase-firestore-compat.js", "jspdf.umd.min.js", "jspdf.plugin.autotable.min.js", "jszip.min.js", "pdf-lib.min.js"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin && (req.mode === "navigate" || url.pathname.endsWith("/index.html"))) {
    // page: network first, so a new upload shows up; cached copy when offline
    // InVettura (cartella invettura/) ha la sua pagina: va in cache col suo indirizzo, non al posto della scheda
    const key = url.pathname.includes("/invettura/") ? new URL("invettura/index.html", self.registration.scope).href : "index.html";
    e.respondWith(fetch(req).then((r) => { const cp = r.clone(); caches.open(VERSION).then((c) => c.put(key, cp)); return r; }).catch(() => caches.match(key)));
    return;
  }
  if (url.origin === location.origin || url.hostname.endsWith("fonts.googleapis.com") || url.hostname.endsWith("fonts.gstatic.com")) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => { if (r.ok || r.type === "opaque") { const cp = r.clone(); caches.open(VERSION).then((c) => c.put(req, cp)); } return r; })));
  }
  // anything else (address lookup for the GPS button) goes straight to the network
});
