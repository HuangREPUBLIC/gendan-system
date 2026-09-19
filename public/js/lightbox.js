"use strict";
// 大图查看器

let lightbox = null;

/* ================= 大图查看器 =================
 * 手势参照微信/iOS 相册：滑动翻页、双指缩放、双击放大、下拉关闭、单击关闭；
 * 电脑上滚轮缩放、方向键翻页、Esc 关闭；安卓返回键先关查看器。动画用可打断的临界阻尼弹簧 */
const LB = { el: null, s: 1, tx: 0, ty: 0, trackX: 0, dy: 0, fade: 1, v: {}, raf: 0, pushed: false, ignorePop: false };
const lbRaf = window.requestAnimationFrame ? f => window.requestAnimationFrame(f) : f => setTimeout(() => f(Date.now()), 16);
const lbCaf = window.cancelAnimationFrame ? id => window.cancelAnimationFrame(id) : id => clearTimeout(id);
const lbNow = () => (window.performance && performance.now) ? performance.now() : Date.now();
function reducedMotion() { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); }
function lbCurImg() { return LB.el && LB.el.querySelector('.lb-slide[data-k="0"] img'); }
function lbSize() { return { w: LB.el ? LB.el.clientWidth || 1 : 1, h: LB.el ? LB.el.clientHeight || 1 : 1 }; }
// 放大后可拖动的范围
function lbBounds(s) {
  const img = lbCurImg(), { w, h } = lbSize();
  if (!img) return { x: 0, y: 0 };
  return { x: Math.max(0, (img.offsetWidth * s - w) / 2), y: Math.max(0, (img.offsetHeight * s - h) / 2) };
}
const clampN = (v, a, b) => Math.min(b, Math.max(a, v));
// 越界橡皮筋阻力
function rubber(over, dim) { const c = 0.55; return (over * dim * c) / (dim + c * Math.abs(over)); }
function rubberClamp(v, lim, dim) { return v > lim ? lim + rubber(v - lim, dim) : v < -lim ? -lim - rubber(-lim - v, dim) : v; }
// 按松手速度推算落点，px/s
function lbProject(v, d) { d = d || 0.995; return (v / 1000) * d / (1 - d); }
function lbPaint() {
  const el = LB.el; if (!el) return;
  const track = el.querySelector(".lb-track");
  if (track) track.style.transform = `translate3d(${LB.trackX}px,0,0)`;
  const img = lbCurImg();
  const shrink = 1 - Math.min(Math.abs(LB.dy) / 1400, 0.3);
  if (img) img.style.transform = `translate3d(${LB.tx}px,${LB.ty + LB.dy}px,0) scale(${LB.s * shrink})`;
  const fade = LB.fade * (1 - Math.min(Math.abs(LB.dy) / 420, 0.9));
  el.style.setProperty("--lb-bg", fade.toFixed(3));
  el.classList.toggle("lb-zoomed", LB.s > 1.01);
}
function lbAnimate(targets, opts, done) {
  lbCaf(LB.raf); LB.raf = 0;
  const keys = Object.keys(targets);
  if (reducedMotion()) { keys.forEach(k => { LB[k] = targets[k]; LB.v[k] = 0; }); lbPaint(); if (done) done(); return; }
  const w = 2 * Math.PI / ((opts && opts.response) || 0.38), t0 = lbNow();
  const tr = keys.map(k => ({ k, T: targets[k], x0: LB[k] - targets[k], v0: LB.v[k] || 0, eps: (k === "s" || k === "fade") ? 0.001 : 0.35 }));
  const step = () => {
    const t = (lbNow() - t0) / 1000; let moving = false;
    tr.forEach(a => {
      const B = a.v0 + w * a.x0, e = Math.exp(-w * t);
      const x = (a.x0 + B * t) * e, v = (a.v0 - w * B * t) * e;
      LB[a.k] = a.T + x; LB.v[a.k] = v;
      if (Math.abs(x) > a.eps || Math.abs(v) > a.eps * 40) moving = true;
    });
    if (!moving) tr.forEach(a => { LB[a.k] = a.T; LB.v[a.k] = 0; });
    lbPaint();
    if (moving && LB.el) LB.raf = lbRaf(step); else { LB.raf = 0; if (done) done(); }
  };
  LB.raf = lbRaf(step);
}
function lbSlideHtml(k) {
  const { photos, i } = lightbox, j = i + k;
  if (j < 0 || j >= photos.length) return "";
  return `<div class="lb-slide" data-k="${k}" style="left:${k * 100}%"><span class="lb-spin"></span>
    <img src="${esc(photos[j])}" alt="第 ${j + 1} 张照片" draggable="false"
      onload="this.parentNode.classList.add('ok')" onerror="this.parentNode.classList.add('bad')">
    <span class="lb-fail">图片加载失败</span></div>`;
}
function lbChrome() {
  const el = LB.el; if (!el || !lightbox) return;
  const { photos, i } = lightbox;
  el.querySelector(".lb-count").textContent = photos.length > 1 ? `${i + 1} / ${photos.length}` : "";
  // 保存按钮只对本系统图片地址开放
  const save = el.querySelector(".lb-save"), safe = /^(\/uploads\/|blob:)/.test(photos[i]);
  save.hidden = !safe;
  if (safe) { save.href = photos[i]; save.setAttribute("download", "照片" + (i + 1) + "." + ((photos[i].split(".").pop() || "jpg").slice(0, 4))); }
  else save.removeAttribute("href");
  el.querySelector(".lb-nav.prev").hidden = i <= 0;
  el.querySelector(".lb-nav.next").hidden = i >= photos.length - 1;
}
function lbRenderSlides() {
  LB.el.querySelector(".lb-track").innerHTML = lbSlideHtml(-1) + lbSlideHtml(0) + lbSlideHtml(1);
  // 缓存里的图可能先触发 onload
  LB.el.querySelectorAll(".lb-slide img").forEach(im => { if (im.complete && im.naturalWidth) im.parentNode.classList.add("ok"); });
  LB.s = 1; LB.tx = LB.ty = LB.trackX = LB.dy = 0; LB.v = {};
  lbChrome(); lbPaint();
}
// 翻页后挪 DOM 而不是重画，相邻图已加载不会闪
function lbShift(dir) {
  const track = LB.el.querySelector(".lb-track");
  lightbox.i += dir;
  const gone = track.querySelector(`.lb-slide[data-k="${-dir}"]`); if (gone) gone.remove();
  const cur = track.querySelector('.lb-slide[data-k="0"]'); if (cur) { cur.dataset.k = -dir; cur.style.left = (-dir * 100) + "%"; const im = cur.querySelector("img"); if (im) im.style.transform = ""; }
  const nxt = track.querySelector(`.lb-slide[data-k="${dir}"]`); if (nxt) { nxt.dataset.k = 0; nxt.style.left = "0%"; }
  const html = lbSlideHtml(dir);
  if (html) track.insertAdjacentHTML(dir > 0 ? "beforeend" : "afterbegin", html);
  LB.s = 1; LB.tx = LB.ty = LB.trackX = LB.dy = 0; LB.v = {};
  lbChrome(); lbPaint();
}
function lbGo(dir) {
  if (!lightbox) return;
  const j = lightbox.i + dir;
  if (j < 0 || j >= lightbox.photos.length) {  // 到头了弹一下
    LB.v.trackX = -dir * 900; lbAnimate({ trackX: 0 }, { response: 0.3 });
    return;
  }
  if (!LB.el.clientWidth || reducedMotion()) return lbShift(dir);
  const { w } = lbSize();
  lbAnimate({ trackX: -dir * w }, { response: 0.32 }, () => lbShift(dir));
}
// 以屏幕某点为中心缩放
function lbZoomAt(px, py, s1, animate) {
  const { w, h } = lbSize();
  const cx = w / 2, cy = h / 2;
  const ix = (px - cx - LB.tx) / LB.s, iy = (py - cy - LB.ty) / LB.s;
  const b = lbBounds(s1);
  const tx = s1 <= 1 ? 0 : clampN(px - cx - s1 * ix, -b.x, b.x), ty = s1 <= 1 ? 0 : clampN(py - cy - s1 * iy, -b.y, b.y);
  if (animate) lbAnimate({ s: s1, tx, ty }, { response: 0.34 });
  else { LB.s = s1; LB.tx = tx; LB.ty = ty; lbPaint(); }
}
function lbSettle() {  // 松手后缩放拉回 1~5 倍、位置拉回边界
  const s = clampN(LB.s, 1, 5), b = lbBounds(s);
  lbAnimate({ s, tx: s <= 1 ? 0 : clampN(LB.tx, -b.x, b.x), ty: s <= 1 ? 0 : clampN(LB.ty, -b.y, b.y) }, { response: 0.36 });
}
function lbVelocity(samples) {  // 最近 100ms 的松手速度，px/s
  const now = lbNow(), rec = samples.filter(p => now - p.t < 100);
  if (rec.length < 2) return { vx: 0, vy: 0 };
  const a = rec[0], b = rec[rec.length - 1], dt = Math.max(1, b.t - a.t) / 1000;
  return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
}
function lbBindGestures(el) {
  const pts = new Map();
  let g = null, lastTap = null, tapTimer = 0;
  const mid = () => { const a = [...pts.values()]; return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2, d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1 }; };
  const startPinch = () => {
    const m = mid(), { w, h } = lbSize();
    g = { type: "pinch", s0: LB.s, d0: m.d, ix: (m.x - w / 2 - LB.tx) / LB.s, iy: (m.y - h / 2 - LB.ty) / LB.s };
    if (LB.trackX || LB.dy) lbAnimate({ trackX: 0, dy: 0 }, { response: 0.3 });
  };
  const startOne = (p, pending) => { g = { type: pending ? "pending" : "pan", x0: p.x, y0: p.y, tx0: LB.tx, ty0: LB.ty, track0: LB.trackX, dy0: LB.dy, t0: lbNow(), samples: [{ x: p.x, y: p.y, t: lbNow() }] }; };
  el.addEventListener("pointerdown", e => {
    if (e.target.closest("button, a") || (e.pointerType === "mouse" && e.button !== 0)) return;
    try { el.setPointerCapture(e.pointerId); } catch (err) { }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    lbCaf(LB.raf); LB.raf = 0;  // 按下即接住正在进行的动画
    clearTimeout(tapTimer);  // 新的按下取消待定的单击关闭
    if (pts.size === 2) startPinch();
    else if (pts.size === 1) startOne({ x: e.clientX, y: e.clientY }, true);
  });
  el.addEventListener("pointermove", e => {
    if (!pts.has(e.pointerId) || !g) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    const { w, h } = lbSize();
    if (g.type === "pinch") {
      if (pts.size < 2) return;
      const m = mid();
      let s = g.s0 * m.d / g.d0;
      if (s > 5) s = 5 + (s - 5) * 0.25; else if (s < 1) s = Math.max(0.5, 1 - (1 - s) * 0.5);
      LB.s = s; LB.tx = m.x - w / 2 - s * g.ix; LB.ty = m.y - h / 2 - s * g.iy;
      lbPaint(); return;
    }
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    g.samples.push({ x: e.clientX, y: e.clientY, t: lbNow() }); if (g.samples.length > 8) g.samples.shift();
    if (g.type === "pending") {
      if (Math.hypot(dx, dy) < 8) return;
      g.type = LB.s > 1.01 ? "pan" : Math.abs(dx) > Math.abs(dy) ? "swipe" : "dismiss";
      if (g.type === "dismiss" && e.pointerType === "mouse") g.type = "swipe";
    }
    if (g.type === "pan") {
      const b = lbBounds(LB.s);
      LB.tx = rubberClamp(g.tx0 + dx, b.x, w); LB.ty = rubberClamp(g.ty0 + dy, b.y, h);
    } else if (g.type === "swipe") {
      const n = lightbox.photos.length, i = lightbox.i;
      let x = g.track0 + dx;
      if ((x > 0 && i === 0) || (x < 0 && i === n - 1)) x = rubber(x, w);
      LB.trackX = x;
    } else if (g.type === "dismiss") LB.dy = g.dy0 + dy;
    lbPaint();
  });
  const end = e => {
    if (!pts.has(e.pointerId)) return;
    const wasType = pts.get(e.pointerId).type;
    pts.delete(e.pointerId);
    if (!g) return;
    const cancelled = e.type === "pointercancel";
    if (g.type === "pinch") {
      if (pts.size === 1) { startOne([...pts.values()][0], false); return; }  // 松开一指，剩下那指接着拖
      if (!pts.size) { g = null; lbSettle(); }
      return;
    }
    if (pts.size) return;
    const { w } = lbSize();
    const v = lbVelocity(g.samples);
    const type = g.type; g = null;
    if (type === "pending") { if (!cancelled) lbTap(e.clientX, e.clientY, wasType, e.target); return; }
    if (type === "swipe") {
      const land = LB.trackX + lbProject(v.vx, 0.99);
      const n = lightbox.photos.length, i = lightbox.i;
      const dir = cancelled ? 0 : land < -w / 2 && i < n - 1 ? 1 : land > w / 2 && i > 0 ? -1 : 0;
      LB.v.trackX = v.vx;
      lbAnimate({ trackX: -dir * w }, { response: 0.32 }, () => { if (dir) lbShift(dir); });
    } else if (type === "dismiss") {
      const flick = Math.abs(v.vy) > 650 && Math.sign(v.vy) === Math.sign(LB.dy);
      if (!cancelled && (Math.abs(LB.dy) > 120 || flick)) A.closeLightbox(Math.sign(LB.dy || v.vy) || 1, v.vy);
      else { LB.v.dy = v.vy; lbAnimate({ dy: 0 }, { response: 0.3 }); }
    } else if (type === "pan") {
      const b = lbBounds(LB.s);
      LB.v.tx = v.vx; LB.v.ty = v.vy;
      lbAnimate({ tx: clampN(LB.tx + lbProject(v.vx), -b.x, b.x), ty: clampN(LB.ty + lbProject(v.vy), -b.y, b.y), s: clampN(LB.s, 1, 5) }, { response: 0.5 });
    }
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  // 触屏自己判断双击(鼠标用 dblclick)
  function lbTap(x, y, ptype, target) {
    const now = lbNow();
    if (ptype !== "mouse" && lastTap && now - lastTap.t < 280 && Math.hypot(x - lastTap.x, y - lastTap.y) < 40) {
      clearTimeout(tapTimer); lastTap = null;
      lbZoomAt(x, y, LB.s > 1.01 ? 1 : 2.5, true);
      return;
    }
    lastTap = { t: now, x, y };
    clearTimeout(tapTimer);
    if (ptype === "mouse") { if (!target.closest("img")) A.closeLightbox(); return; }
    tapTimer = setTimeout(() => { lastTap = null; if (lightbox) A.closeLightbox(); }, 280);
  }
  el.addEventListener("dblclick", e => { if (e.target.closest("img")) lbZoomAt(e.clientX, e.clientY, LB.s > 1.01 ? 1 : 2.5, true); });
  el.addEventListener("wheel", e => {
    e.preventDefault();
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));  // ctrlKey = 触控板捏合
    lbZoomAt(e.clientX, e.clientY, clampN(LB.s * f, 1, 5), false);
  }, { passive: false });
}
function lbKey(e) {
  if (!lightbox) return;
  if (e.key === "Escape") A.closeLightbox();
  else if (e.key === "ArrowLeft") lbGo(-1);
  else if (e.key === "ArrowRight") lbGo(1);
}
// 从缩略图位置放大出来
function lbOpenFrom(rect) {
  const img = lbCurImg();
  const run = () => {
    if (!LB.el || !rect || !img || !img.offsetWidth || reducedMotion()) { LB.fade = 1; lbPaint(); return; }
    const { w, h } = lbSize();
    LB.s = Math.max(0.05, Math.min(rect.width / img.offsetWidth, rect.height / img.offsetHeight));
    LB.tx = rect.left + rect.width / 2 - w / 2; LB.ty = rect.top + rect.height / 2 - h / 2; LB.fade = 0;
    lbPaint();
    lbAnimate({ s: 1, tx: 0, ty: 0, fade: 1 }, { response: 0.36 });
  };
  LB.fade = 0; lbPaint();
  if (img && img.complete && img.naturalWidth) run();
  else if (img) { img.addEventListener("load", run, { once: true }); img.addEventListener("error", run, { once: true }); setTimeout(() => { if (LB.fade === 0) run(); }, 400); }
  else run();
}
function openLightbox(photos, i, fromRect) {
  if (!photos || !photos.length) return;
  lightbox = { photos, i: clampN(i || 0, 0, photos.length - 1) };
  let el = document.getElementById("lightbox");
  if (!el) {
    el = document.createElement("div");
    el.id = "lightbox"; el.className = "lightbox";
    el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", "查看照片");
    el.innerHTML = `<div class="lb-track"></div>
      <div class="lb-bar"><span class="lb-count num"></span><span class="lb-acts">
        <a class="lb-btn lb-save" aria-label="保存照片" title="保存照片">${PHOTO_ICONS.save}</a>
        <button type="button" class="lb-btn lb-close" aria-label="关闭" onclick="A.closeLightbox()">✕</button></span></div>
      <button type="button" class="lb-nav prev" aria-label="上一张" onclick="A.lbStep(-1)">‹</button>
      <button type="button" class="lb-nav next" aria-label="下一张" onclick="A.lbStep(1)">›</button>`;
    document.body.appendChild(el);
    LB.el = el;
    lbBindGestures(el);
    document.addEventListener("keydown", lbKey);
    document.documentElement.classList.add("lb-open");
    // 压一条历史，安卓返回键先关查看器
    try { history.pushState({ lb: 1 }, ""); LB.pushed = true; } catch (e) { LB.pushed = false; }
  }
  LB.el = el; LB.fade = 1;
  lbRenderSlides();
  if (fromRect) lbOpenFrom(fromRect);
  const closeBtn = el.querySelector(".lb-close"); if (closeBtn && closeBtn.focus) closeBtn.focus({ preventScroll: true });
}
// 关闭：立刻摘掉 id，画面再淡出或顺着下拉方向滑走
function closeLightboxNow(dir, vy, fromPop) {
  const el = LB.el || document.getElementById("lightbox");
  lightbox = null;
  document.removeEventListener("keydown", lbKey);
  document.documentElement.classList.remove("lb-open");
  if (LB.pushed && !fromPop) { LB.pushed = false; LB.ignorePop = true; try { history.back(); } catch (e) { LB.ignorePop = false; } }
  LB.pushed = false;
  if (!el) return;
  el.id = ""; el.classList.add("lb-closing"); el.style.pointerEvents = "none";
  LB.el = el;
  const finish = () => { el.remove(); if (LB.el === el) LB.el = null; };
  if (reducedMotion() || !dir) { el.style.opacity = "0"; setTimeout(finish, 160); return; }
  LB.v.dy = vy || dir * 1200;
  lbAnimate({ dy: dir * lbSize().h, fade: 0 }, { response: 0.3 }, finish);
  setTimeout(finish, 600);
}
window.addEventListener("popstate", () => {
  if (LB.ignorePop) { LB.ignorePop = false; return; }
  if (lightbox) { LB.pushed = false; closeLightboxNow(0, 0, true); }
});

Object.assign(A, {
  lightboxFromEl(el) {
    let photos;
    try { photos = JSON.parse(el.getAttribute("data-gallery")); } catch (e) { return; }
    openLightbox(photos, +el.getAttribute("data-i") || 0, el.getBoundingClientRect ? el.getBoundingClientRect() : null);
  },
  lbStep(d) { lbGo(d); },
  closeLightbox(dir, vy) { closeLightboxNow(dir || 0, vy || 0, false); },
});
