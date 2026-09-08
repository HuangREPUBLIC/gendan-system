// 版本号变了就会丢弃旧缓存。改动前端后 bump 这个数字。
const CACHE = "daka-v5";
const SHELL = ["/", "/index.html", "/app.js", "/styles.css",
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
  // 只处理本站的 GET；API、上传、导出一律走网络，不缓存
  if (req.method !== "GET" || url.origin !== location.origin ||
      url.pathname.startsWith("/api") || url.pathname.startsWith("/uploads")) return;
  // 静态资源：优先网络（拿到最新），失败（离线）再用缓存
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match("/index.html")))
  );
});

/* ---------- 系统推送：App 没打开时也能弹手机通知 ---------- */
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) {}
  const title = d.title || "跟单系统";
  const opts = {
    body: d.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    // tag 相同的通知会互相覆盖：同一张单连续改动只留最新一条，不会刷一屏
    tag: d.tag || "daka",
    data: { url: d.url || "/" }
  };
  e.waitUntil(
    // App 正开着且在前台时不弹系统通知——页面里的红点已经在提示了，
    // 再弹一条系统横幅就是重复打扰（正常 App 也是这个行为）
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      if (cs.some((c) => c.visibilityState === "visible" && c.focused)) return;
      return self.registration.showNotification(title, opts);
    })
  );
});

// 点通知：已经开着就把那个窗口叫到前面并跳转，没开着就新开一个
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
