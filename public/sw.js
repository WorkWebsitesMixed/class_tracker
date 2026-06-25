// Service worker: receives Web Push and deep-links to the reporting card.
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || "Registro de clases", {
      body: data.body || "",
      data: { url: data.url || "/" },
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: data.url, // collapse repeats for the same session
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      // Focus an existing tab if one is open, else open a new one.
      for (const w of wins) {
        if ("focus" in w) {
          w.navigate(url);
          return w.focus();
        }
      }
      return clients.openWindow(url);
    }),
  );
});
