// 版本号变了就会丢弃旧缓存。改动前端后 bump 这个数字。
const CACHE = "daka-v4";
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
