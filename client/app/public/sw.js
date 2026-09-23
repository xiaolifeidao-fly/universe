const CACHE_NAME = "delivery-mobile-shell-v2";
const APP_SHELL = ["/", "/offline", "/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("delivery-mobile-") && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && (request.mode === "navigate" || ["script", "style", "image", "font"].includes(request.destination))) {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === "navigate") return (await caches.match("/offline")) || Response.error();
        return Response.error();
      }),
  );
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }
  const data = payload && typeof payload.data === "object" && payload.data ? payload.data : {};
  const title = typeof payload.title === "string" && payload.title ? payload.title : "交付台更新";
  const body = typeof payload.body === "string" ? payload.body : "";
  const tag = typeof payload.tag === "string" ? payload.tag : "delivery-update";
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag,
    data,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data && typeof event.notification.data.url === "string" ? event.notification.data.url : "/commands";
  let destination = "/commands";
  try {
    const url = new URL(target, self.location.origin);
    if (url.origin === self.location.origin && url.pathname.startsWith("/")) destination = `${url.pathname}${url.search}`;
  } catch {
    // A malformed push payload must not navigate outside the PWA origin.
  }
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    const current = windows.find((client) => "focus" in client);
    if (current) return current.navigate(destination).then(() => current.focus());
    return clients.openWindow(destination);
  }));
});
