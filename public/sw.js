// 改动前端后升级版本号，旧缓存会被清掉
const CACHE = "daka-v12";
const SHELL = ["/", "/index.html", "/styles.css",
  "/js/state.js", "/js/utils.js", "/js/perms.js", "/js/api.js", "/js/modal.js", "/js/fields.js",
  "/js/layout.js", "/js/photos.js", "/js/lightbox.js", "/js/auth.js", "/js/order-list.js", "/js/order-new.js",
  "/js/order-detail.js", "/js/inspection.js", "/js/punch-logs.js", "/js/chat.js", "/js/notifications.js",
  "/js/admin.js", "/js/import-xlsx.js", "/js/import.js", "/js/account.js", "/js/pwa.js", "/js/pull-refresh.js",
  "/js/drop-paste.js", "/js/main.js",
  "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // 只处理本站 GET；API、上传一律走网络
  if (req.method !== "GET" || url.origin !== location.origin ||
      url.pathname.startsWith("/api") || url.pathname.startsWith("/uploads")) return;
  // 网络优先，离线时用缓存
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match("/index.html")))
  );
});

// 系统推送
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) {}
  const title = d.title || "跟单系统";
  const opts = {
    body: d.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    // 同 tag 互相覆盖，同一张单只留最新一条
    tag: d.tag || "daka",
    data: { url: d.url || "/" }
  };
  e.waitUntil(
    // App 在前台时不弹系统通知，页面红点已提示
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      if (cs.some((c) => c.visibilityState === "visible" && c.focused)) return;
      return self.registration.showNotification(title, opts);
    })
  );
});

// 点通知：已开着就切过去并跳转，否则新开窗口
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      for (const c of cs) {
        if ("focus" in c) { c.navigate(url).catch(() => {}); return c.focus(); }
      }
      return self.clients.openWindow(url);
    })
  );
});
