// Service worker mínim perquè l'app es pugui instal·lar.
// No desa res: totes les peticions van a la xarxa com sempre, així mai no es veuen dades velles.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
