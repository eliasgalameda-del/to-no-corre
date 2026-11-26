const ACTION_URL = "https://myuwytzbkckemcyfvhkx.supabase.co/functions/v1/inbox-action";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data.json(); } catch (e) { d = { title: "Tô no Corre", body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(d.title || "Tô no Corre", {
    body: d.body || "",
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: d.id || "tnc",
    data: { id: d.id, token: d.token },
    actions: d.id ? [{ action: "accept", title: "✅ Confirmar" }, { action: "dismiss", title: "❌ Descartar" }] : [],
  }));
});
self.addEventListener("notificationclick", (event) => {
  const n = event.notification;
  const a = event.action;
  n.close();
  if (a === "accept" || a === "dismiss") {
    event.waitUntil(fetch(ACTION_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: n.data.id, token: n.data.token, action: a }) })
      .then((r) => r.json())
      .then((j) => self.registration.showNotification(j.ok ? (a === "accept" ? "✅ Compromisso confirmado" : "❌ Compromisso descartado") : "Esse item já foi resolvido", { icon: "icon-192.png", tag: "tnc-done", silent: true }))
      .then(() => new Promise((r) => setTimeout(r, 3000)))
      .then(() => self.registration.getNotifications({ tag: "tnc-done" }).then((l) => l.forEach((x) => x.close())))
      .catch(() => self.registration.showNotification("Não consegui resolver agora. Abra o app.", { icon: "icon-192.png" })));
    return;
  }
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ("focus" in c) return c.focus(); }
    return self.clients.openWindow("./");
  }));
});
