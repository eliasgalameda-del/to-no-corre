const ACTION_URL = "https://myuwytzbkckemcyfvhkx.supabase.co/functions/v1/inbox-action";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
const abs = (p) => (p ? new URL(p, self.registration.scope).href : undefined);
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data.json(); } catch (e) { d = { title: "Tô no Corre", body: event.data ? event.data.text() : "" }; }
  const opts = {
    body: d.body || "",
    icon: abs("icon-192.png"),
    badge: abs("badge.png"),
    image: abs(d.image),
    tag: d.tag || d.id || "tnc",
    renotify: true,
    timestamp: Date.now(),
    vibrate: [120, 60, 120],
    data: { id: d.id, token: d.token, url: d.url },
    actions: d.id ? [{ action: "accept", title: "Confirmar" }, { action: "dismiss", title: "Descartar" }] : [],
  };
  event.waitUntil(self.registration.showNotification(d.title || "Tô no Corre", opts));
});
self.addEventListener("notificationclick", (event) => {
  const n = event.notification;
  const a = event.action;
  n.close();
  if (a === "accept" || a === "dismiss") {
    event.waitUntil(fetch(ACTION_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: n.data.id, token: n.data.token, action: a }) })
      .then((r) => r.json())
      .then((j) => self.registration.showNotification(j.ok ? (a === "accept" ? "Compromisso confirmado" : "Compromisso descartado") : "Esse item já foi resolvido", { icon: abs("icon-192.png"), badge: abs("badge.png"), tag: "tnc-done", silent: true }))
      .then(() => new Promise((r) => setTimeout(r, 2500)))
      .then(() => self.registration.getNotifications({ tag: "tnc-done" }).then((l) => l.forEach((x) => x.close())))
      .catch(() => self.registration.showNotification("Não consegui resolver agora. Abra o app.", { icon: abs("icon-192.png"), badge: abs("badge.png") })));
    return;
  }
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ("focus" in c) return c.focus(); }
    return self.clients.openWindow((n.data && n.data.url) || "./");
  }));
});
