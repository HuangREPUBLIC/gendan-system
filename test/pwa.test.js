/** PWA 静态资源检查：manifest / service worker / 图标 / iOS meta */
const BASE = (process.env.BASE_URL || "http://localhost:3000");
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n); } };
(async () => {
  const html = await (await fetch(BASE + "/")).text();
  ok(/rel="manifest"/.test(html), "首页引用 manifest");
  ok(/apple-mobile-web-app-capable"\s+content="yes"/.test(html), "iOS 全屏 meta");
  ok(/rel="apple-touch-icon"/.test(html), "iOS 主屏图标");
  ok(/theme-color"\s+content="#1C4E9D"/.test(html), "状态栏主题色");
  ok(/user-scalable=no/.test(html) && /maximum-scale=1/.test(html), "手机端锁定缩放（禁止双指放大页面）");
  ok(/serviceWorker.*register\("\/sw\.js"\)/s.test(html), "注册 Service Worker");

  const mr = await fetch(BASE + "/manifest.webmanifest");
  ok((mr.headers.get("content-type") || "").includes("manifest"), "manifest MIME 正确");
  ok((mr.headers.get("cache-control") || "").includes("no-cache"), "manifest 不缓存");
  const m = await mr.json();
  ok(m.display === "standalone", "display=standalone");
  ok(m.name === "跟单系统" && m.short_name, "名称/简称完整");
  ok(m.icons.length >= 3 && m.icons.some(i => i.purpose === "maskable"), "含 maskable 图标");
  ok(m.start_url === "/" && m.scope === "/", "start_url/scope 正确");

  const sw = await fetch(BASE + "/sw.js");
  ok(sw.status === 200 && (sw.headers.get("cache-control") || "").includes("no-cache"), "sw.js 可取且不缓存");
  const swText = await sw.text();
  ok(/url\.pathname\.startsWith\("\/api"\)/.test(swText), "SW 不缓存 API（数据始终走网络）");

  for (const ic of ["/icon-192.png", "/icon-512.png", "/icon-maskable.png", "/apple-touch-icon.png"]) {
    const r = await fetch(BASE + ic);
    ok(r.status === 200 && r.headers.get("content-type") === "image/png", "图标可取 " + ic);
  }
  console.log(`\n结果：PASS ${pass}, FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})();
