"use strict";
// 前端单页应用：数据都来自服务端；权限以服务端为准，这里只隐藏没权限的入口

// ================= 状态 =================
let state = {
  token: localStorage.getItem("daka_token") || null,
  me: null, users: [], fields: { order: [], production: [] },
  factories: { emb: [], prod: [], proc: [] }, orders: [], roles: [], seasons: [],
  chat: { contacts: [], activeId: null, contact: null, messages: [], draft: "", att: null },
  unread: { total: 0, byUser: {} },
  // list 为 null 表示还没加载；open 是桌面端铃铛下拉
  notifs: { list: null, unread: 0, open: false },
  myLogs: null
};
let route = { v: "orders", id: null };
let editingBasic = false, editingFollower = false, importPreview = null, importRaw = "";
let showWelcome = false;  // 登录后短暂展示的欢迎界面
const expandedLogGroups = new Set();  // 打卡记录里展开全部的订单
// ship/recent 来自桌面端概览卡片
let filt = { season: "", sales: "", follower: "", kw: "", factoryKw: "", ship: "", recent: false };
let adminUserFilt = { kw: "", page: 1 };
let adminTab = "people";
const ADMIN_USERS_PAGE_SIZE = 10;
let modalState = null;
let deferredInstall = null;  // 安卓/桌面 Chrome 的安装事件
// 手机/平板才提示「安装到手机」
const isMobileDevice = () => /iPhone|iPad|iPod|Android|Mobile|HarmonyOS/i.test(navigator.userAgent || "")
  || (navigator.maxTouchPoints > 1 && window.matchMedia && window.matchMedia("(pointer:coarse)").matches);
const isStandalone = () => (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
  || window.navigator.standalone === true;
const isIOSDevice = () => /iPhone|iPad|iPod/i.test(navigator.userAgent || "")
  || (/Mac/i.test(navigator.userAgent || "") && navigator.maxTouchPoints > 1);
// 系统推送状态；微信内置浏览器、未添加到主屏的 iOS 不支持
let pushState = { supported: false, permission: "default", on: false, devices: 0, checked: false };
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
// base64url 公钥 -> Uint8Array
function urlB64ToUint8Array(base64) {
  const pad = "=".repeat((4 - base64.length % 4) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
async function refreshPushState(rerender) {
  pushState.checked = true;
  pushState.supported = pushSupported();
  if (!pushState.supported) { if (rerender) render(); return; }
  pushState.permission = Notification.permission;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    pushState.on = !!sub && Notification.permission === "granted";
  } catch (e) { pushState.on = false; }
  if (rerender) render();
}

// ================= 工具 =================
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// 今年省略年份：7月20日 17:51
function fmtT(t) {
  const d = new Date(t), p = n => String(n).padStart(2, "0");
  const y = d.getFullYear() === new Date().getFullYear() ? "" : d.getFullYear() + "年";
  return `${y}${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 本地时区的今天(toISOString 是 UTC)
function todayStr() {
  const d = new Date(), p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// 导入的各种日期写法统一成 2026-08-15；认不出返回 null
function normalizeImportDate(s) {
  s = String(s || "").trim();
  if (!s) return "";
  const iso = (y, m, d) => {
    y = +y; m = +m; d = +d; if (y < 100) y += 2000;
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
      ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
  };
  let m;
  if ((m = s.match(/^(\d{4})[\/\-年.](\d{1,2})[\/\-月.](\d{1,2})日?(\s|T|$)/))) return iso(m[1], m[2], m[3]);  // 2026-8-15、2026/8/15、2026年8月15日、2026.8.15
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return iso(m[1], m[2], m[3]);
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/))) return iso(m[3], m[1], m[2]);  // Excel 英文格式 8/15/26
  if ((m = s.match(/^(\d{1,2})月(\d{1,2})日?$/))) return iso(new Date().getFullYear(), m[1], m[2]);  // 按今年
  if (/^\d{5}$/.test(s) && +s > 30000 && +s < 80000) {  // Excel 日期序号
    const dt = new Date(Date.UTC(1899, 11, 30) + (+s) * 86400000);
    return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  return null;
}
// 表头比对前清洗：去空格/星号/冒号和末尾括号备注，不分大小写
function normHeader(h) {
  return String(h == null ? "" : h).replace(/^\uFEFF/, "").replace(/[\s*＊:：]/g, "").replace(/[（(][^（()）]*[）)]$/, "").toLowerCase();
}
let importUnknownCols = [];  // 没认出的列，预览时提示
// 2026-08-15 -> 2026年8月15日
function fmtDate(v) {
  if (!v) return "";
  const m = String(v).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return v;
  return `${m[1]}年${+m[2]}月${+m[3]}日`;
}
function fmtSize(n) {
  if (!n && n !== 0) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}
// App 内置浏览器大多不支持下载文件
function inAppBrowser() { return /MicroMessenger|wxwork|DingTalk|\bQQ\/|Lark|Feishu|AlipayClient|Weibo/i.test(navigator.userAgent || ""); }
const isIosStandalone = () => isIOSDevice() && isStandalone();
const canOfferInstall = () => isMobileDevice() && !isStandalone();
// clipboard 接口要求 https，否则退回 execCommand
async function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch (e) { }
  const ta = document.createElement("textarea");
  ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
  document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
  let ok = false; try { ok = document.execCommand("copy"); } catch (e) { }
  ta.remove(); return ok;
}
function toast(s, sticky) {
  const m = $("msg"); m.textContent = s; m.classList.add("show");
  clearTimeout(toast._t);
  if (!sticky) toast._t = setTimeout(() => m.classList.remove("show"), 2400);
}
const userById = id => state.users.find(u => u.id === id);
const uname = id => (userById(id) || {}).name || "";
const me = () => state.me;
const isAdmin = () => me() && me().template === "admin";
const canCreateOrder = () => !!me();
const roleLabelOf = u => (u ? (u.roleLabel || (u.role === "admin" ? "管理员" : u.role)) : "");
const labelForRoleKey = k => k === "admin" ? "管理员" : ((state.roles.find(r => r.k === k) || {}).label || k);
const COMPANY_NAME = "天津锦利国际贸易有限公司";
const APP_NAME = "跟单系统";
const APP_LOGO = `
  <svg viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect width="512" height="512" rx="116" fill="#2F5FA8"/>
    <rect x="128" y="87" width="256" height="338" rx="42" fill="#FFFFFF"/>
    <path d="M200 174 V338" stroke="#2F5FA8" stroke-width="16"/>
    <circle cx="200" cy="174" r="26" fill="#2F5FA8"/>
    <circle cx="200" cy="256" r="26" fill="#2F5FA8"/>
    <circle cx="200" cy="338" r="22" fill="#FFFFFF" stroke="#2F5FA8" stroke-width="15"/>
    <path d="M262 174 H334 M262 256 H334 M262 338 H296" stroke="#2F5FA8" stroke-width="26" stroke-linecap="round"/>
  </svg>`;

// ================= API =================
async function api(method, path, body) {
  const headers = {};
  if (state.token) headers.Authorization = "Bearer " + state.token;
  const opts = { method, headers };
  if (body !== undefined) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const r = await fetch("/api" + path, opts);
  if (r.status === 401 && state.token) { A.forceLogout(); throw { error: "登录已失效，请重新登录" }; }
  let j = null; try { j = await r.json(); } catch (e) { }
  if (!r.ok) throw (j || { error: "请求失败" });
  return j;
}
async function refresh() {
  const b = await api("GET", "/bootstrap");
  state.me = b.me; state.users = b.users; state.fields = b.fields;
  state.factories = b.factories; state.orders = b.orders; state.roles = b.roles || [];
  state.seasons = b.seasons || [];
  saveStateCache();
}
// 本地缓存上次的数据，打开时先显示再后台刷新；跟 token 绑定
const STATE_CACHE_KEY = "daka_cache_v1";
function saveStateCache() {
  try {
    localStorage.setItem(STATE_CACHE_KEY, JSON.stringify({
      token: state.token, me: state.me, users: state.users, fields: state.fields,
      factories: state.factories, orders: state.orders, roles: state.roles, seasons: state.seasons
    }));
  } catch (e) { /* 存储满了/不可用就算了，不影响功能 */ }
}
function loadStateCache() {
  try {
    const c = JSON.parse(localStorage.getItem(STATE_CACHE_KEY) || "null");
    if (!c || c.token !== state.token) return;
    state.me = c.me; state.users = c.users; state.fields = c.fields;
    state.factories = c.factories; state.orders = c.orders; state.roles = c.roles; state.seasons = c.seasons;
  } catch (e) { /* 缓存损坏就忽略，走正常的网络加载 */ }
}
function rerenderKeepFocus(inputId, redraw) {
  clearTimeout(rerenderKeepFocus.t);
  rerenderKeepFocus.t = setTimeout(() => {
    (redraw || render)();
    const inp = $(inputId);
    if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  }, 300);
}
function confirmDanger(title, body, onOk, okText) {
  modal({ title, body, danger: true, okText: okText || "确认删除", onOk });
}
function askText(opts, onText) {
  modal(Object.assign({ input: "text" }, opts, { onOk: v => { const t = (v || "").trim(); if (t) onText(t); } }));
}
async function run(fn, okMsg) {
  try { await fn(); await refresh(); render(); if (okMsg) toast(okMsg); }
  catch (e) { toast((e && e.error) || "操作失败"); }
}

// ================= 权限（只控制显示，规则同服务端 auth.js） =================
function isSupervisor() { const u = me(); return !!u && u.template === "supervisor"; }
function shipLocked(o) { return !!(o && o.values && o.values.shipDate); }
const TEMPLATE_PERMS = {
  sales:      { scope: "own", editOrder: true,  editProd: false, logOrder: true,  logProd: false, createOrder: true, inspect: true },
  follower:   { scope: "own", editOrder: false, editProd: true,  logOrder: false, logProd: true,  createOrder: true, inspect: true },
  supervisor: { scope: "all", editOrder: true,  editProd: true,  logOrder: true,  logProd: true,  createOrder: true, inspect: true }
};
const PERM_KEYS = ["editOrder", "editProd", "logOrder", "logProd", "createOrder", "inspect"];
function mergePerms(template, saved) {
  const base = TEMPLATE_PERMS[template] || TEMPLATE_PERMS.follower;
  if (!saved) return base;
  const out = Object.assign({}, base);
  if (saved.scope === "all" || saved.scope === "own") out.scope = saved.scope;
  PERM_KEYS.forEach(k => { if (typeof saved[k] === "boolean") out[k] = saved[k]; });
  return out;
}
function myPerms() {
  const u = me(); if (!u) return null;
  if (isAdmin()) return TEMPLATE_PERMS.supervisor;
  return mergePerms(u.template, (state.roles.find(r => r.k === u.role) || {}).perms);
}
const permsOfRole = r => mergePerms(r.template, r.perms);
function isRelated(o) {
  const u = me(); if (!u || !o) return false;
  if (myPerms().scope === "all") return true;
  if (u.template === "sales") return o.values.sales === u.id || o.createdBy === u.id;
  if (u.template === "follower") return o.values.follower === u.id;
  return false;
}
function sectionPerm(o, section, orderKey, prodKey) {
  if (!isRelated(o)) return false;
  const p = myPerms();
  if (section === "order") return !!p[orderKey];
  if (section === "production") return !!p[prodKey];
  return !!(p[orderKey] || p[prodKey]);
}
const canEditSection = (o, section) => sectionPerm(o, section, "editOrder", "editProd");
const canEditBasic = o => canEditSection(o);
const canAddLog = (o, section) => sectionPerm(o, section, "logOrder", "logProd");
function canTouchEntry(o, e, section) {
  const u = me(); if (!u) return false;
  if (isAdmin()) return true;
  if (isSupervisor()) return true;
  if (e && e.by === u.id) return true;
  return canEditSection(o, section);
}
// 发货日期填写后只有管理员/主管能改
function canEditShipDate(o) {
  if (isAdmin() || isSupervisor()) return true;
  if (shipLocked(o)) return false;
  return canEditBasic(o);
}
const canWriteInspProblem = o => isRelated(o) && !!myPerms().inspect;
const canWriteInspFix = canWriteInspProblem;

// ================= 字段与下拉 =================
function optionsFor(f) {
  if (f.type === "user-sales") return state.users.filter(u => u.template === "sales").map(u => [u.id, u.name]);
  if (f.type === "user-follower") return state.users.filter(u => u.template === "follower").map(u => [u.id, u.name]);
  if (f.type === "factory-fabric") return state.factories.fabric.map(x => [x, x]);
  if (f.type === "factory-emb") return state.factories.emb.map(x => [x, x]);
  if (f.type === "factory-prod") return state.factories.prod.map(x => [x, x]);
  if (f.type === "select") return (f.options || []).map(x => [x, x]);
  return null;
}
function displayVal(o, f) {
  const v = (o.values || {})[f.k];
  if (v == null || v === "") return "";
  if (Array.isArray(v)) return v.length ? v.join("、") : "";
  if (f.type === "user-sales" || f.type === "user-follower") return uname(v) || v;
  if (f.type === "date") return fmtDate(v);
  return v;
}
const isMultiFactory = f => f.type === "factory-fabric" || f.type === "factory-emb";
const allFieldDefs = () => [...state.fields.order, ...state.fields.production];
const scalarFields = s => state.fields[s].filter(f => f.type !== "log");
function fieldInput(f, val, prefix) {
  prefix = prefix || "nf-";
  const id = prefix + f.k;
  if (isMultiFactory(f)) return factoryMultiHtml(f, val, id);
  const opts = optionsFor(f);
  if (opts) {
    // 值不在下拉列表里(如导入的)也保留显示
    const isFactory = f.type === "factory-prod";
    const extra = (isFactory && val && !opts.some(([v]) => v === val)) ? [[val, val]] : [];
    return `<select class="in" id="${id}"><option value="">请选择</option>${[...extra, ...opts].map(([v, t]) =>
      `<option value="${esc(v)}" ${v === val ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
  }
  if (f.type === "textarea") return `<textarea class="in" id="${id}">${esc(val || "")}</textarea>`;
  if (f.type === "date") return dateFieldHtml(id, val);
  if (f.type === "number") return `<input class="in" type="number" inputmode="decimal" id="${id}" value="${esc(val || "")}">`;
  if (f.type === "image") return photoPicker("img");
  // 数量弹数字键盘；货号关掉自动大写和联想
  const kb = f.k === "qty" ? ` inputmode="numeric" pattern="[0-9,]*"`
    : f.k === "styleNo" ? ` autocapitalize="characters" autocorrect="off" spellcheck="false"` : "";
  return `<input class="in" id="${id}" value="${esc(val || "")}" autocomplete="off"${kb}>`;
}
const fieldRow = (f, val, prefix) => `<label class="field"><span>${esc(f.label)}</span>${fieldInput(f, val, prefix)}</label>`;

// 面料/绣花/印花工厂可挂多个供应商
function factoryMultiHtml(f, val, id) {
  const opts = optionsFor(f) || [];
  const arr = Array.isArray(val) ? val.slice() : (val ? [val] : []);
  const remaining = opts.filter(([v]) => !arr.includes(v));
  return `<div class="multifactory" data-id="${id}">
    <div class="multifactory-chips">${arr.length ? arr.map(v => chipHtml(v, `A.removeFactoryChip('${id}','${encodeURIComponent(v)}')`)).join("")
      : `<span class="row-sub">未选择</span>`}</div>
    ${remaining.length ? `<div style="display:flex;gap:8px;margin-top:8px">
      <select class="in" id="${id}--add"><option value="">选择要添加的工厂</option>${remaining.map(([v, t]) =>
        `<option value="${esc(v)}">${esc(t)}</option>`).join("")}</select>
      <button type="button" class="btn mini ghost" onclick="A.addFactoryChip('${id}')">添加</button></div>` : ""}
    <input type="hidden" id="${id}" value='${esc(JSON.stringify(arr))}'></div>`;
}

// 原生日期框透明盖在中文按钮上直接接收点击(部分手机不支持 showPicker)
function dateFieldHtml(id, val, extraOnChange) {
  return `<div class="datefield">
    <button type="button" class="in date-btn ${val ? "" : "empty"}" id="${id}--label" tabindex="-1"
      >${val ? esc(fmtDate(val)) : "选择日期"}</button>
    <input type="date" id="${id}" class="date-native" value="${esc(val || "")}" autocomplete="off"
      onchange="${extraOnChange ? extraOnChange + ";" : ""}A.syncDateLabel('${id}')" onclick="A.openDate(this)" onfocus="A.openDate(this)"></div>`;
}

// 订单里用到但已被删掉的季节仍要显示
function seasonOptions(cur) {
  const list = (state.seasons || []).slice();
  state.orders.forEach(o => { if (o.season && !list.includes(o.season)) list.unshift(o.season); });
  if (cur && !list.includes(cur)) list.unshift(cur);
  return list;
}
// 季节四色轮换：按后台季节顺序取色；已删的季节按名字算固定颜色
function seasonTone(s) {
  let i = (state.seasons || []).indexOf(s);
  if (i < 0) i = [...String(s || "")].reduce((h, c) => h + c.charCodeAt(0), 0);
  return "s" + (i % 4);
}
function seasonTag(s, style) {
  return `<span class="tag season ${seasonTone(s)}"${style ? ` style="${style}"` : ""}>${esc(s)}</span>`;
}
function seasonSelectHtml(cur, prefix) {
  return `<select class="in" id="${(prefix || "nf-")}season"><option value="">请选择季节</option>${
    seasonOptions(cur).map(s => `<option ${s === cur ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>`;
}

// ================= 弹窗 =================
function modal(opts) { modalState = opts; renderModal(); }
function renderModal() {
  const mask = $("mask");
  if (!modalState) { mask.classList.remove("show"); mask.innerHTML = ""; return; }
  const o = modalState;
  mask.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
    <div class="m-title">${esc(o.title)}</div>
    ${o.body ? `<div class="m-body">${esc(o.body)}</div>` : ""}
    ${o.html ? `<div style="margin-top:14px">${o.html}</div>` : ""}
    ${o.input === "textarea" ? `<textarea class="in" id="m-input" style="margin-top:14px;min-height:110px"></textarea>`
      : o.input ? `<input class="in" id="m-input" style="margin-top:14px" ${o.password ? 'type="password"' : ""}>` : ""}
    <div class="m-actions">
      <button class="btn ghost" onclick="A.modalCancel()">取消</button>
      <button class="btn ${o.danger ? "danger" : ""}" onclick="A.modalOk()">${esc(o.okText || "确定")}</button>
    </div></div>`;
  if (o.input) { const i = $("m-input"); i.value = o.value || ""; i.focus(); }
  mask.classList.add("show");
}

// ================= 照片 =================
let photoDraft = {};  // { ctx: [url] } 表单里正在编辑的照片
let lightbox = null;

function normalizePhotos(v) {
  if (Array.isArray(v)) return v.filter(x => typeof x === "string" && x);
  if (typeof v === "string" && v) return [v];
  return [];
}
const PHOTO_MAX_EDGE = 2000;
const PHOTO_MAX_BYTES = 8 * 1024 * 1024;  // 同服务端单张上限
const PHOTO_MAX_PER_PICKER = 30;
function isHeic(file) { return /hei[cf]/i.test(file.type || "") || /\.hei[cf]$/i.test(file.name || ""); }
// 部分安卓选出的文件 type 为空，再看扩展名
function looksLikeImage(file) {
  return !!file && (/^image\//.test(file.type || "") || /\.(jpe?g|png|gif|webp|hei[cf]|bmp)$/i.test(file.name || ""));
}
// 优先 createImageBitmap(按 EXIF 摆正)，不支持再用 <img>；不读成 base64，避免低端机内存爆
async function decodeImage(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) { /* 走下面的兜底 */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = url; });
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
}
// 压缩成 JPEG：顺带去掉 GPS 等 EXIF；透明 PNG 铺白底；用完清空画布(iOS 画布内存有上限)。GIF 保留原图
async function compressImage(file) {
  if (!looksLikeImage(file)) throw { error: "只能上传图片", noRetry: true };
  if (/gif$/i.test(file.type || "")) {
    if (file.size > PHOTO_MAX_BYTES) throw { error: "GIF 动图不能超过 8MB", noRetry: true };
    return file;
  }
  let src;
  try { src = await decodeImage(file); }
  catch (e) {
    throw { noRetry: true, error: isHeic(file)
      ? "这张是 HEIC 格式照片，当前浏览器打不开。请把相机的照片格式改成「兼容性最佳 / JPG」，或截图后再传"
      : "这张图片打不开，可能已损坏或格式不支持" };
  }
  const w0 = src.width, h0 = src.height;
  const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, w, h);
  if (src.close) src.close();
  const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.85));
  c.width = c.height = 0;
  if (blob) return blob;
  if (file.size <= PHOTO_MAX_BYTES && !isHeic(file)) return file;  // 个别浏览器 toBlob 失败时原图直传
  throw { error: "图片处理失败，请换一张试试", noRetry: true };
}
function xhrUpload(url, fd, { timeout, onProgress, holder } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (holder) holder.xhr = xhr;
    xhr.open("POST", url);
    xhr.setRequestHeader("Authorization", "Bearer " + state.token);
    if (timeout) xhr.timeout = timeout;
    if (xhr.upload && onProgress) xhr.upload.onprogress = e => onProgress(e.lengthComputable && e.total ? e.loaded / e.total : null);
    xhr.onload = () => {
      let j = null; try { j = JSON.parse(xhr.responseText); } catch (e) { }
      if (xhr.status >= 200 && xhr.status < 300 && j) return resolve(j);
      reject({ error: (j && j.error) || `上传失败(${xhr.status})`, fatal: xhr.status >= 400 && xhr.status < 500 });
    };
    xhr.onerror = () => reject({ error: "网络出错，上传失败" });
    xhr.ontimeout = () => reject({ error: "上传超时，网络太慢" });
    xhr.onabort = () => reject({ error: "已取消", aborted: true });
    xhr.send(fd);
  });
}
async function uploadBlob(blob, onProgress, holder) {
  const ext = blob.type === "image/gif" ? "gif" : blob.type === "image/png" ? "png" : "jpg";
  const fd = new FormData(); fd.append("image", blob, "photo." + ext);
  const j = await xhrUpload("/api/upload", fd, { timeout: 20000 + Math.ceil(blob.size / 102400) * 2000,
    onProgress: onProgress && (p => { if (p != null) onProgress(p); }), holder });
  if (!j.url) throw { error: "上传失败" };
  return j.url;
}
// 网络错误自动重试一次
async function uploadWithRetry(blob, onProgress, holder) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    if (holder && holder.removed) throw { error: "已取消", aborted: true };
    try { return await uploadBlob(blob, onProgress, holder); }
    catch (e) { lastErr = e; if (e.fatal || e.aborted) break; }
  }
  throw lastErr;
}
async function uploadOnePhoto(file) { return uploadWithRetry(await compressImage(file)); }

/* ---------- 上传队列 ----------
 * 选完先出本地预览和进度条，失败的格子可重试；
 * 压缩串行(低端机内存)，上传并发 3 张；按选择顺序落位 */
let photoPending = {};
const photoPreviewOf = {};  // 刚传完的照片用本地预览显示，不再下载
let photoSeq = 0, compressChain = Promise.resolve();
let upActive = 0; const upWaiters = [];
async function upSlot() { if (upActive < 3) { upActive++; return; } await new Promise(r => upWaiters.push(r)); }
function upRelease() { const next = upWaiters.shift(); if (next) next(); else upActive--; }
const clearImportPhotoDrafts = () => Object.keys(photoDraft).forEach(k => { if (/^imp\d+-img$/.test(k)) delete photoDraft[k]; });
function repaintPicker(ctx) { const el = $("pe-" + ctx); if (el) el.innerHTML = pickerInner(ctx); }
function flushPending(ctx) {
  const pend = photoPending[ctx] || [];
  photoDraft[ctx] = photoDraft[ctx] || [];
  while (pend.length && pend[0].status === "done") {
    const it = pend.shift();
    if (it.preview) photoPreviewOf[it.url] = it.preview;
    photoDraft[ctx].push(it.url);
  }
  if (!pend.length) delete photoPending[ctx];
  repaintPicker(ctx);
}
async function processPhoto(ctx, it) {
  try {
    it.status = "work"; repaintPicker(ctx);
    if (!it.blob) {
      const job = compressChain.then(() => it.removed ? null : compressImage(it.file));
      compressChain = job.catch(() => { });
      it.blob = await job;
      if (it.removed || !it.blob) return;
      it.file = null;
      it.preview = URL.createObjectURL(it.blob);
      repaintPicker(ctx);
    }
    await upSlot();
    try {
      if (it.removed) return;
      it.status = "up"; it.pct = 0; repaintPicker(ctx);
      it.url = await uploadWithRetry(it.blob, p => {
        it.pct = p;
        const bar = document.querySelector(`#pp-${it.id} .ph-bar i`);
        if (bar) bar.style.width = Math.round(p * 100) + "%";
      }, it);
    } finally { upRelease(); }
    it.status = "done";
  } catch (e) {
    if (it.removed) return;
    it.status = "err"; it.err = (e && e.error) || "上传失败"; it.noRetry = !!(e && e.noRetry);
    toast(it.err);
  }
  if (!it.removed) flushPending(ctx);
}
// 照片没传完或有失败时不许保存
function photosBusyMsg(test) {
  const match = k => typeof test === "string" ? k === test : test.test(k);
  const items = Object.keys(photoPending).filter(match).flatMap(k => photoPending[k]);
  if (items.some(it => it.status === "err")) return "有照片上传失败，请点「重试」或删掉后再保存";
  if (items.length) return "照片还在上传，请稍等几秒再保存";
  return "";
}
const photosBlocked = test => { const m = photosBusyMsg(test); if (m) toast(m); return !!m; };
function resetPhotoPending() {
  Object.values(photoPending).flat().forEach(it => { it.removed = true; if (it.xhr) it.xhr.abort(); });
  photoPending = {};
}
async function ensureXlsx(msg) {
  if (!window.XLSX) { toast(msg, true); await loadScriptOnce("/xlsx.mini.min.js"); }
}
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src; s.onload = () => resolve(); s.onerror = () => reject(new Error("组件加载失败"));
    document.head.appendChild(s);
  });
}
// 浏览器本地读 zip 里的指定文件，只支持 STORED/DEFLATE，不支持的跳过
async function zipReadEntries(buf, wantNames) {
  const dv = new DataView(buf), bytes = new Uint8Array(buf);
  let eocd = -1;
  const back = Math.min(bytes.length, 65557);  // EOCD 22 字节 + 最长 65535 字节注释
  for (let i = bytes.length - 22; i >= bytes.length - back && i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 zip/xlsx 文件");
  const cdOffset = dv.getUint32(eocd + 16, true);
  const cdEntryCount = dv.getUint16(eocd + 10, true);
  const wantSet = new Set(wantNames);
  const found = {};
  let p = cdOffset;
  for (let i = 0; i < cdEntryCount && Object.keys(found).length < wantSet.size; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = new TextDecoder("utf-8").decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (wantSet.has(name)) found[name] = { method, compressedSize, localOffset };
    p += 46 + nameLen + extraLen + commentLen;
  }
  const result = {};
  for (const name of Object.keys(found)) {
    const { method, compressedSize, localOffset } = found[name];
    const lNameLen = dv.getUint16(localOffset + 26, true);
    const lExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) { result[name] = compressed; continue; }
    if (method === 8) {
      if (!window.DecompressionStream) continue;
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      result[name] = new Uint8Array(await new Response(stream).arrayBuffer());
      continue;
    }
  }
  return result;
}
// 从 xlsx 抠出贴在表格里的图片，按锚定行号配对(同服务端 extractEmbeddedImages)，失败返回已抠到的
async function extractEmbeddedImagesClient(buf) {
  const images = {};
  try {
    const step1 = await zipReadEntries(buf, ["xl/worksheets/_rels/sheet1.xml.rels"]);
    const relsBytes = step1["xl/worksheets/_rels/sheet1.xml.rels"];
    if (!relsBytes) return images;
    const drawingRefM = new TextDecoder("utf-8").decode(relsBytes).match(/Target="[^"]*?(drawing\d*\.xml)"/);
    if (!drawingRefM) return images;
    const drawingName = drawingRefM[1];
    const step2 = await zipReadEntries(buf, ["xl/drawings/" + drawingName, "xl/drawings/_rels/" + drawingName + ".rels"]);
    const drawingBytes = step2["xl/drawings/" + drawingName];
    if (!drawingBytes) return images;
    const drawingXml = new TextDecoder("utf-8").decode(drawingBytes);
    const rIdToMedia = {};
    const drawingRelsBytes = step2["xl/drawings/_rels/" + drawingName + ".rels"];
    if (drawingRelsBytes) {
      const relsText = new TextDecoder("utf-8").decode(drawingRelsBytes);
      const re = /<Relationship[^>]*Id="(rId\d+)"[^>]*Target="[^"]*?(media\/[^"]+)"/g;
      let m; while ((m = re.exec(relsText))) rIdToMedia[m[1]] = "xl/" + m[2];
    }
    const anchorRe = /<xdr:(?:twoCellAnchor|oneCellAnchor)[\s\S]*?<\/xdr:(?:twoCellAnchor|oneCellAnchor)>/g;
    const rowToMedia = {};
    let am;
    while ((am = anchorRe.exec(drawingXml))) {
      const block = am[0];
      const rowM = block.match(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/);
      const embedM = block.match(/r:embed="(rId\d+)"/);
      if (!rowM || !embedM) continue;
      const mediaPath = rIdToMedia[embedM[1]];
      if (mediaPath) rowToMedia[parseInt(rowM[1], 10)] = mediaPath;
    }
    const mediaNames = [...new Set(Object.values(rowToMedia))];
    if (!mediaNames.length) return images;
    const step3 = await zipReadEntries(buf, mediaNames);
    Object.keys(rowToMedia).forEach(row => {
      const data = step3[rowToMedia[row]];
      if (!data) return;
      images[row] = { data, ext: (rowToMedia[row].split(".").pop() || "png").toLowerCase() };
    });
  } catch (e) { /* 抠图失败就返回已抠到的部分(可能是空)，不影响正常的表格文字导入 */ }
  return images;
}
// 缩略图；可编辑时带删除叉，款式图第一张标「封面」
function photoThumbs(urls, editable, ctx) {
  const gallery = esc(JSON.stringify(urls));
  const cover = editable && urls.length > 1 && /(^|-)img$/.test(ctx || "");
  return urls.map((u, i) => `<div class="ph-thumb">
    <img src="${esc(photoPreviewOf[u] || u)}" alt="照片 ${i + 1}" loading="lazy" decoding="async"
      data-gallery="${gallery}" data-i="${i}" onclick="A.lightboxFromEl(this)">
    ${cover && i === 0 ? `<span class="ph-cover">封面</span>` : ""}
    ${editable ? `<button type="button" class="ph-x" aria-label="删除第 ${i + 1} 张照片" onclick="A.removeDraftPhoto('${ctx}',${i})">✕</button>` : ""}</div>`).join("");
}
function pendingTile(ctx, it) {
  const err = it.status === "err";
  return `<div class="ph-thumb ph-pending${err ? " is-err" : ""}" id="pp-${it.id}">
    ${it.preview ? `<img src="${it.preview}" alt="">` : `<span class="ph-skel"></span>`}
    ${err ? (it.noRetry ? `<span class="ph-errmsg" title="${esc(it.err)}">无法上传</span>`
          : `<button type="button" class="ph-retry" title="${esc(it.err)}" onclick="A.retryPhoto('${ctx}',${it.id})">${PHOTO_ICONS.retry}<span>重试</span></button>`)
      : `<span class="ph-bar" aria-label="上传中"><i style="width:${Math.round((it.pct || 0) * 100)}%"></i></span>`}
    <button type="button" class="ph-x" aria-label="取消这张照片" onclick="A.cancelPhoto('${ctx}',${it.id})">✕</button></div>`;
}
const PHOTO_ICONS = {
  camera: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.2-1.8A1.5 1.5 0 0 1 10 4.5h4a1.5 1.5 0 0 1 1.3.7L16.5 7h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.5" r="3.3"/></svg>`,
  album: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 15.5 16 11l-7.5 8.5"/></svg>`,
  retry: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>`,
  save: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>`
};
// 拍照和相册分成两个入口：部分手机(华为)在 multiple 时会隐藏拍照；图标用 SVG，emoji 在安卓上不统一
function pickerInner(ctx) {
  const list = photoDraft[ctx] || [], pend = photoPending[ctx] || [];
  const full = list.length + pend.length >= PHOTO_MAX_PER_PICKER;
  return photoThumbs(list, true, ctx) + pend.map(it => pendingTile(ctx, it)).join("") + (full ? "" :
    `<label class="ph-add"><input type="file" accept="image/*" capture="environment" hidden onchange="A.addDraftPhotos('${ctx}',this)">
      <span class="ph-ic">${PHOTO_ICONS.camera}</span><span>拍照</span></label>` +
    `<label class="ph-add"><input type="file" accept="image/*" multiple hidden onchange="A.addDraftPhotos('${ctx}',this)">
      <span class="ph-ic">${PHOTO_ICONS.album}</span><span>相册</span></label>`);
}
function photoPicker(ctx) { return `<div class="photos-grid" id="pe-${ctx}" data-ctx="${ctx}">${pickerInner(ctx)}</div>`; }
function coverImgHtml(photos, cls) {
  if (!photos.length) return "";
  return `<img src="${esc(photoPreviewOf[photos[0]] || photos[0])}" alt="款式图"${cls ? ` class="${cls}"` : ""} loading="lazy" decoding="async"
    data-gallery="${esc(JSON.stringify(photos))}" data-i="0" onclick="event.stopPropagation();A.lightboxFromEl(this)">`;
}
function photoGallery(urls) {
  urls = normalizePhotos(urls);
  if (!urls.length) return "";
  return `<div class="photos-grid ro">${photoThumbs(urls, false)}</div>`;
}

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

// ================= 路由 =================
function go(v, id) {
  route = { v, id: id || null }; editingBasic = false; editingFollower = false;
  photoDraft = {}; resetPhotoPending(); state.notifs.open = false;
  if (lightbox) closeLightboxNow(0, 0, false);
  if (v !== "chat") { state.chat.activeId = null; state.chat.messages = []; state.chat.draft = ""; state.chat.att = null; }
  render(); window.scrollTo(0, 0);
  if (v === "account") { A.loadMyLogs(state.me.id); refreshPushState(true); }
  if (v === "staffLogs" && id) A.loadMyLogs(id);
  if (v === "chat") { A.loadContacts(); A.refreshUnread(); }
  if (v === "notifs") A.loadNotifs();
}

// 各页标题栏；crumb 给桌面端面包屑用
function pageMeta() {
  const back = (label, fn) => `<button class="nav-btn" onclick="${fn}">‹ ${esc(label)}</button>`;
  const crumb = (label, fn) => ({ label, fn });
  switch (route.v) {
    case "orders": return { title: "订单",
      right: canCreateOrder() ? `<button class="nav-btn plus" title="新建订单" onclick="go('new')">＋</button>` : "" };
    case "new": return { title: "新建订单", left: back("订单", "go('orders')"), crumb: crumb("订单", "go('orders')") };
    case "detail": return { title: "订单详情", left: back("订单", "go('orders')"), crumb: crumb("订单", "go('orders')") };
    case "chat": return state.chat.activeId
      ? { title: (state.chat.contact && state.chat.contact.name) || "聊天", left: back("聊天", "A.closeChat()"), crumb: crumb("聊天", "A.closeChat()") }
      : { title: "聊天" };
    case "admin": return { title: "管理后台" };
    case "account": return { title: "我的" };
    case "notifs": return { title: "消息通知", left: back("我的", "go('account')"), crumb: crumb("我的", "go('account')"),
      right: state.notifs.unread ? `<button class="nav-btn" onclick="A.markAllNotifsRead()">全部已读</button>` : "" };
    case "staffLogs": {
      const u = userById(route.id);
      return { title: (u ? u.name : "") + "的打卡", left: back("管理", "go('admin')"), crumb: crumb("管理", "go('admin')") };
    }
    default: return { title: "订单" };
  }
}
const ICONS = {
  shirt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4 4.5 6.5 3 11l3 1.2V20h12v-7.8l3-1.2-1.5-4.5L15 4c-.6 1.3-1.7 2-3 2s-2.4-.7-3-2z"/></svg>`,
  orders: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8a2 2 0 0 1 2 2v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6a2 2 0 0 1 2-2z"/><path d="M9 3h6v3H9z"/><path d="M9.5 11h5M9.5 15h5"/></svg>`,
  chat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a7.5 7.5 0 0 1-7.5 7.5c-1.2 0-2.3-.25-3.3-.7L4.5 20l1.3-4.2A7.4 7.4 0 0 1 5 12a7.5 7.5 0 0 1 15 0z"/></svg>`,
  admin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 14a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V20a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H4a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H10a1.6 1.6 0 0 0 1-1.5V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V10a1.6 1.6 0 0 0 1.5 1H20a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg>`,
  account: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M12 8.5v7M8.5 12h7"/></svg>`,
  bell: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15.5V10a6 6 0 1 0-12 0v5.5L4.5 18h15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.2"/><path d="M12 7.4V12l3.1 1.9"/></svg>`,
  truck: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5h10v9H3z"/><path d="M13 11h4l3 3v2.5h-7z"/><circle cx="7" cy="17.5" r="1.7"/><circle cx="16.5" cy="17.5" r="1.7"/></svg>`,
  pulse: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12.5h3.6l2.3-5.6 3.4 10.2 2.5-6.1 1.6 1.5H21"/></svg>`
};
const badgeHtml = n => n ? `<span class="badge">${n > 99 ? "99+" : n}</span>` : "";
const chipHtml = (label, onDel) => `<span class="tag role">${esc(label)}${
  onDel ? ` <a href="javascript:void(0)" onclick="${onDel}" style="margin-left:4px">✕</a>` : ""}</span>`;
// 聊天用聊天未读，「我的」用通知未读
function tabBadgeOf(v) {
  if (v === "chat") return state.unread.total;
  if (v === "account" || v === "notifs") return state.notifs.unread;
  return 0;
}
function tabbarHtml() {
  const m = me();
  const tabs = [["orders", "订单", ICONS.orders], ["chat", "聊天", ICONS.chat]];
  if (m.template === "admin") tabs.push(["admin", "管理", ICONS.admin]);
  tabs.push(["account", "我的", ICONS.account]);
  const activeTab = route.v === "new" || route.v === "detail" ? "orders"
    : route.v === "staffLogs" ? "admin" : route.v === "notifs" ? "account" : route.v;
  return `<nav class="tabbar">${tabs.map(([v, label, icon]) => `
    <button class="tab ${activeTab === v ? "on" : ""}" data-tab="${v}" onclick="go('${v}')">
      <span class="ti">${icon}${badgeHtml(tabBadgeOf(v))}</span>
      <span>${label}</span></button>`).join("")}</nav>`;
}

// ---------- 桌面端侧边栏 + 顶部条（窄屏隐藏） ----------
function sidebarHtml() {
  const m = me();
  const groups = [
    ["总览", [["orders", "订单列表", ICONS.orders]]],
    ["业务", [["new", "新建订单", ICONS.plus], ["chat", "聊天", ICONS.chat]]],
    ["系统", [
      ...(m.template === "admin" ? [["admin", "管理后台", ICONS.admin]] : []),
      ["notifs", "消息通知", ICONS.bell],
      ["account", "我的", ICONS.account]
    ]]
  ];
  const active = route.v === "detail" ? "orders" : route.v === "staffLogs" ? "admin" : route.v;
  return `<aside class="dsidebar">
    <div class="ds-brand">
      <div class="ds-logo">${APP_LOGO}</div>
      <div class="ds-brand-txt"><div class="ds-co">${esc(COMPANY_NAME)}</div><div class="ds-app">${esc(APP_NAME)}</div></div>
    </div>
    <nav class="ds-nav">${groups.map(([title, items]) => `
      <div class="ds-group"><div class="ds-group-title">${esc(title)}</div>
        ${items.map(([v, label, icon]) => `<button class="ds-item ${active === v ? "on" : ""}" data-nav="${v}" onclick="go('${v}')">
          <span class="ds-ic">${icon}</span><span class="ds-label">${esc(label)}</span>${badgeHtml(tabBadgeOf(v))}</button>`).join("")}
      </div>`).join("")}</nav>
    <div class="ds-foot">
      ${avatarHtml(m.name, "sm")}
      <div class="ds-me"><div class="ds-me-name">${esc(m.name)}</div><div class="ds-me-role">${esc(roleLabelOf(m))}</div></div>
    </div></aside>`;
}
// 老通知没有 actorName 等字段，退回纯文本
function notifItemsHtml() {
  const list = state.notifs.list;
  if (!list) return `<div class="empty">加载中…</div>`;
  if (!list.length) return `<div class="empty">暂无通知</div>`;
  return list.map(n => {
    const rich = !!(n.actorName && n.orderLabel && n.what);
    return `<div class="notif${rich ? " rich" : ""}${n.read ? "" : " un"}" role="button" tabindex="0"
      onclick="A.openNotif('${n.id}','${esc(n.orderId || "")}')">
      ${rich ? avatarHtml(n.actorName, "sm") : `<span class="n-dot"></span>`}
      <div class="n-main">${rich ? `
        <div class="n-top"><span class="n-actor">${esc(n.actorName)}</span>
          <span class="tag order num">${esc(n.orderLabel)}</span>
          <span class="n-time num">${fmtT(n.createdAt)}</span></div>
        <div class="n-what">${esc(n.what)}</div>` : `
        <div class="n-text">${esc(n.text)}</div>
        <div class="n-time num">${fmtT(n.createdAt)}</div>`}
      </div><button type="button" class="n-del" title="删除这条通知" aria-label="删除这条通知"
        onclick="event.stopPropagation();A.deleteNotif('${n.id}')">✕</button></div>`;
  }).join("");
}
function deskHeaderHtml() {
  const n = state.notifs;
  return `<div class="dheader">
    <label class="dh-search"><span class="dh-sic">${ICONS.search}</span>
      <input class="dh-input" id="dh-kw" placeholder="搜索货号 / 款式名" value="${esc(filt.kw)}"
        oninput="A.setDeskKw(this.value)"></label>
    <div class="dh-actions">
      <button class="dh-icon" title="消息通知" onclick="A.toggleNotifPanel()">${ICONS.bell}${badgeHtml(n.unread)}</button>
      <div class="dh-user">${avatarHtml(me().name, "sm")}<span class="dh-uname">${esc(me().name)}</span></div>
    </div>
    ${n.open ? `<div class="notif-back" onclick="A.closeNotifPanel()"></div>
      <div class="notif-panel"><div class="np-head"><span>消息通知</span>
        <span class="np-acts">${(n.list || []).some(x => x.read) ? `<button class="btn plain" onclick="event.stopPropagation();A.clearReadNotifs()">清空已读</button>` : ""}
        <button class="btn plain" onclick="event.stopPropagation();A.markAllNotifsRead()">全部已读</button></span></div>
      <div class="np-list">${notifItemsHtml()}</div>
      <div class="np-foot"><button class="btn plain block" onclick="A.closeNotifPanel();go('notifs')">查看全部通知</button></div></div>` : ""}
  </div>`;
}

function render() {
  const app = $("app");
  if (showWelcome) { app.innerHTML = vWelcome(); return; }
  if (!me()) { app.innerHTML = vLogin(); return; }
  const meta = pageMeta();
  const views = { orders: vOrders, new: vNew, detail: vDetail, chat: vChat,
    admin: vAdmin, account: vAccount, staffLogs: vStaffLogs, notifs: vNotifs };
  app.innerHTML = `
    ${sidebarHtml()}${deskHeaderHtml()}
    ${route.v === "orders" ? `<div class="home-brand"><div class="co">${esc(COMPANY_NAME)}</div><div class="app">${esc(APP_NAME)}</div></div>` : ""}
    ${meta.crumb ? `<nav class="dbreadcrumb"><button class="dbc-link" onclick="${meta.crumb.fn}">${esc(meta.crumb.label)}</button><span class="dbc-sep">›</span><span class="dbc-current">${esc(meta.title)}</span></nav>` : ""}
    <header class="navbar"><div class="navbar-in">
      <div class="nav-slot">${meta.left || ""}</div>
      <h1 class="nav-title">${esc(meta.title)}</h1>
      <div class="nav-slot right">${meta.right || ""}</div>
    </div></header>
    ${tabbarHtml()}
    <main class="page${route.v === "chat" && state.chat.activeId ? " chat-full" : ""}" data-view="${route.v}">${
      (views[route.v] || vOrders)()}</main>`;
}

// ---------- 登录 ----------
const brandHtml = () => `<div class="login-brand">
      <div class="login-logo">${APP_LOGO}</div>
      <p class="login-company">${esc(COMPANY_NAME)}</p>
      <h1 class="login-title">${esc(APP_NAME)}</h1>
    </div>`;
function vLogin() {
  return `<div class="login-page"><div class="login-inner">
    ${brandHtml()}
    <div class="login-card">
      <label class="lg-field"><span>手机号</span>
        <input id="lg-phone" inputmode="tel" autocomplete="username" placeholder="请输入手机号"></label>
      <label class="lg-field"><span>密码</span>
        <input id="lg-pass" type="password" autocomplete="current-password" placeholder="请输入密码"
          onkeydown="if(event.key==='Enter')A.login()"></label>
    </div>
    <button class="btn block login-btn" onclick="A.login()">登 录</button>
    ${canOfferInstall() ? `<button class="btn ghost block install-cta" onclick="A.install()">📲 安装到手机（像 App 一样用）</button>` : ""}
  </div></div>`;
}

function vWelcome() {
  return `<div class="login-page" onclick="A.dismissWelcome()"><div class="login-inner">${brandHtml()}</div></div>`;
}

// ---------- 订单列表 ----------
function latestLog(o) {
  let best = null;
  for (const f of allFieldDefs().filter(f => f.type === "log")) for (const e of (o.logs[f.k] || [])) if (!best || e.t > best.t) best = { ...e, fieldLabel: f.label };
  for (const s of (o.subs || [])) for (const e of s.log) if (!best || e.t > best.t) best = { ...e, fieldLabel: s.name };
  return best;
}
const isRecent = l => !!l && (Date.now() - l.t) <= 7 * 24 * 60 * 60 * 1000;
// 概览卡片筛选条件显示成可取消的标签
function statFilterChip() {
  const label = filt.ship === "pending" ? "进行中（未填发货日期）"
    : filt.ship === "shipped" ? "已发货" : filt.recent ? "近7天有更新" : "";
  if (!label) return "";
  return ` <span class="tag filter-chip">${esc(label)}
    <a href="javascript:void(0)" onclick="A.setStatFilter('all')" title="取消筛选">✕</a></span>`;
}
function vOrders() {
  const factoriesOf = o => [o.values.factory, o.values.fabricFactory1, o.values.fabricFactory2, o.values.embFactory, o.values.printFactory].flat().filter(Boolean);
  // 概览卡片的数字跟随其它筛选条件
  const baseFiltered = state.orders.filter(o =>
    (!filt.season || o.season === filt.season) &&
    (!filt.sales || o.values.sales === filt.sales) &&
    (!filt.follower || o.values.follower === filt.follower) &&
    (!filt.kw || [o.values.styleNo, o.values.styleName, o.values.style]
      .join(" ").toLowerCase().includes(filt.kw.toLowerCase())) &&
    (!filt.factoryKw || factoriesOf(o).includes(filt.factoryKw))
  );
  const list = baseFiltered.filter(o =>
    (!filt.ship || (filt.ship === "shipped" ? !!o.values.shipDate : !o.values.shipDate)) &&
    (!filt.recent || isRecent(latestLog(o)))
  ).slice().sort((a, b) => b.createdAt - a.createdAt);
  const opt = (arr, cur) => arr.map(([v, t]) =>
    `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(t)}</option>`).join("");
  const allFactories = [...new Set([...state.factories.prod, ...state.factories.fabric, ...state.factories.emb])];
  // 业务员/下厂员看不到对应的人员筛选
  const myTemplate = (me() || {}).template;
  const all = baseFiltered;
  const shipped = all.filter(o => o.values.shipDate).length;
  const recent = all.filter(o => isRecent(latestLog(o))).length;
  const pct = n => all.length ? Math.round(n / all.length * 100) + "%" : "—";
  // state.orders 已按权限过滤，合计的是自己能看到的
  const qtySum = arr => arr.reduce((t, o) => t + (parseFloat(String(o.values.qty || "").replace(/[,，\s]/g, "")) || 0), 0)
    .toLocaleString("zh-CN");
  // 点卡片按条件筛选，再点取消
  const statActive = k => k === "all" ? (!filt.ship && !filt.recent)
    : k === "recent" ? !!filt.recent : filt.ship === k;
  const statCard = (key, label, value, sub, icon, tone) => `<button type="button"
    class="dstat${statActive(key) ? " on" : ""}" onclick="A.setStatFilter('${key}')"
    aria-pressed="${statActive(key)}" title="点击筛选出这些订单">
    <span class="dstat-ic ${tone || ""}">${icon}</span>
    <div class="dstat-main"><div class="dstat-label">${esc(label)}</div>
      <div class="dstat-num num">${esc(String(value))}</div>
      <div class="dstat-sub">${esc(sub)}</div></div></button>`;
  return `<section class="group dstats-wrap"><div class="dstats">
      ${statCard("all", "订单总数", all.length, "合计数量 " + qtySum(all) + " 件", ICONS.orders)}
      ${statCard("pending", "进行中", all.length - shipped, "尚未填写发货日期", ICONS.clock, "warn")}
      ${statCard("shipped", "已发货", shipped, "占 " + pct(shipped), ICONS.truck, "ok")}
      ${statCard("recent", "近7天有更新", recent, "占 " + pct(recent), ICONS.pulse, "sky")}
    </div></section>
  <section class="group">
    <div class="card"><div class="filters">
      <input class="in f-kw" id="flt-kw" type="search" enterkeyhint="search" autocomplete="off" placeholder="搜货号 / 款式名" value="${esc(filt.kw)}" oninput="A.setFKw(this.value)">
      <div class="f-chips">
      <select class="in${filt.season ? " on" : ""}" aria-label="按季节筛选" onchange="A.setF('season',this.value)"><option value="">全部季节</option>${opt(seasonOptions("").map(s => [s, s]), filt.season)}</select>
      ${myTemplate === "sales" ? "" : `<select class="in${filt.sales ? " on" : ""}" aria-label="按业务员筛选" onchange="A.setF('sales',this.value)"><option value="">全部业务员</option>${opt(state.users.filter(u => u.template === "sales").map(u => [u.id, u.name]), filt.sales)}</select>`}
      ${myTemplate === "follower" ? "" : `<select class="in${filt.follower ? " on" : ""}" aria-label="按下厂员筛选" onchange="A.setF('follower',this.value)"><option value="">全部下厂员</option>${opt(state.users.filter(u => u.template === "follower").map(u => [u.id, u.name]), filt.follower)}</select>`}
      <select class="in${filt.factoryKw ? " on" : ""}" aria-label="按工厂筛选" onchange="A.setF('factoryKw',this.value)"><option value="">全部工厂</option>${opt(allFactories.map(x => [x, x]), filt.factoryKw)}</select>
      </div>
    </div></div></section>
  <section class="group">
    <div class="group-title">订单列表 · 共 ${list.length} 单 · ${qtySum(list)} 件${statFilterChip()}</div>
    <div class="card olist">${list.map(o => {
      const latest = latestLog(o);
      return `<div class="ocard" onclick="go('detail','${o.id}')" role="button" tabindex="0" onkeydown="if(event.key==='Enter')go('detail','${o.id}')">
        <div class="thumb">${coverImgHtml(normalizePhotos(o.values.img)) || `<span class="thumb-ph" aria-label="暂无款式图">${ICONS.shirt}</span>`}</div>
        <div class="o-main">
          <div class="o-title">${seasonTag(o.season)}${esc(o.values.styleNo || "")} ${esc([o.values.styleName, o.values.style].filter(Boolean).join(" "))}</div>
          <div class="o-meta"><span>业务员 ${esc(uname(o.values.sales)) || "—"}</span><span>下厂员 ${esc(uname(o.values.follower)) || "未指定"}</span>
            <span class="num">数量 ${esc(o.values.qty || "-")}</span><span>交期 ${esc(fmtDate(o.values.deadline)) || "-"}</span></div>
          ${isRecent(latest)
            ? `<div class="o-latest">最新：${esc(latest.fieldLabel)} · ${esc(latest.text)} <span class="num">(${fmtT(latest.t)})</span></div>` : ""}
        </div><span class="chev">›</span></div>`;
    }).join("") || `<div class="empty">${state.orders.length ? "没有符合条件的订单" : "还没有订单，点右上角 ＋ 新建"}</div>`}</div>
  </section>`;
}

// ---------- 新建订单 / 批量导入 ----------
function vNew() {
  const scalars = scalarFields;
  if (!photoDraft.img) photoDraft.img = [];
  // 日期默认今天，但发货日期不能默认(填了就锁单)
  const defVal = f => (f.type === "date" && f.k !== "shipDate") ? todayStr()
    : (f.k === "sales" && me().template === "sales" ? me().id : "");
  return `<section class="group">
    <div class="group-title">订单明细</div>
    <div class="card">
      <label class="field"><span>订单季节</span>${seasonSelectHtml("")}</label>
      <div class="grid2">${scalars("order").map(f => fieldRow(f, defVal(f))).join("")}</div>
    </div></section>
  <section class="group">
    <div class="group-title">生产安排（指定负责打卡的下厂员）</div>
    <div class="card"><div class="grid2">${scalars("production").map(f => f.k !== "shipDate" ? fieldRow(f, defVal(f))
      : `<label class="field"><span>${esc(f.label)}</span>${fieldInput(f, defVal(f))}
          <div style="margin-top:6px;font-size:12px;color:var(--bad);display:flex;align-items:center;gap:4px">
            <span>⚠️</span><span>一旦选择，不可以再次修改</span></div></label>`).join("")}</div></div>
    <div class="btn-row" style="padding-left:0;padding-right:0">
      <button class="btn block" onclick="A.createOrder()">保存订单</button></div>
  </section>
  <section class="group">
    <div class="group-title">表格批量导入<button type="button" class="btn plain right" onclick="A.downloadImportTemplate()">下载导入模板</button></div>
    <div class="card"><div class="card-pad">
      <div class="imp-drop" data-drop="import">
        <input type="file" id="imp-file" class="file-native" accept=".xlsx,.xls,.csv,.txt" onchange="A.importFile(this)">
        <button type="button" class="imp-drop-btn" onclick="document.getElementById('imp-file').click()">
          <span class="imp-drop-ic">${ICONS.orders}</span>
          <span class="imp-drop-main" id="imp-file--name">选择 Excel / CSV 文件</span>
          <span class="imp-drop-sub">支持 .xlsx .xls .csv<span class="imp-drop-desk">，也可以把文件拖到这里</span></span>
        </button>
      </div>
      <p class="imp-help">按第一行的列名识别（货号、款式名、数量、交期、业务员、下厂员、季节…），表格里贴的款式图会自动带上。识别后先预览，<b>确认后才会导入</b>。</p>
      <details class="imp-paste"${importRaw ? " open" : ""}><summary>或者直接粘贴表格内容</summary>
        <textarea class="in" id="imp-text" placeholder="在 Excel / WPS 里选中要导入的区域(含表头)，复制后粘贴到这里">${esc(importRaw)}</textarea>
        <div style="margin-top:10px"><button class="btn ghost" onclick="A.importText()">识别粘贴的内容</button></div>
      </details>
    </div>${importPreview ? importPreviewHtml() : ""}</div>
  </section>`;
}
const importScalars = () => [...scalarFields("order").filter(f => f.type !== "image"), ...scalarFields("production")];
function importPreviewHtml() {
  const orderScalars = scalarFields("order").filter(f => f.type !== "image"), prodScalars = scalarFields("production");
  const n = importPreview.length, warnRows = importPreview.filter(r => r.warn && r.warn.length).length;
  // 少于 4 单全部展开，否则只展开有问题的
  const openAll = n <= 3;
  return `<div class="imp-summary${warnRows ? " warn" : ""}">
      <div class="imp-sum-main">识别到 <b class="num">${n}</b> 单，尚未保存${warnRows ? `，其中 <b class="num">${warnRows}</b> 单需要确认` : "，没发现问题"}</div>
      <div class="imp-sum-sub">可以直接修改下面任意字段，确认无误后点底部「确认导入」。</div>
      ${importUnknownCols.length ? `<div class="imp-sum-sub">这些列没认出来，不会导入：${importUnknownCols.map(esc).join("、")}</div>` : ""}
    </div>
    ${importPreview.map((r, i) => {
      const w = r.warn || [];
      return `<details class="imp-block${w.length ? " has-warn" : ""}"${openAll || w.length ? " open" : ""}>
      <summary class="imp-head"><span class="imp-no num">${i + 1}</span>
        <span class="imp-title">${esc(r.values.styleNo || "")} ${esc(r.values.styleName || "")}</span>
        ${w.length ? `<span class="tag warn">${w.length} 处待确认</span>` : ""}
        ${n > 1 ? `<button type="button" class="act-btn danger" onclick="event.preventDefault();A.removeImportRow(${i})">移除</button>` : ""}</summary>
      ${w.length ? `<ul class="imp-warns">${w.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      <label class="field"><span>订单季节</span>${seasonSelectHtml(r.season, "imp" + i + "-")}</label>
      <label class="field"><span>款式图</span>${photoPicker("imp" + i + "-img")}</label>
      <div class="grid2">${orderScalars.map(f => fieldRow(f, r.values[f.k] || "", "imp" + i + "-")).join("")}</div>
      <div class="grid2">${prodScalars.map(f => fieldRow(f, r.values[f.k] || "", "imp" + i + "-")).join("")}</div>
    </details>`;
    }).join("")}
    <div class="btn-row imp-actions">
      <button class="btn" onclick="A.confirmImport()">确认导入 ${n} 单</button>
      <button class="btn ghost" onclick="A.cancelImport()">取消</button></div>`;
}

// ---------- 订单详情 ----------
function logEntriesHtml(list, o, key, section) {
  const entries = (list || []).slice().sort((a, b) => b.t - a.t);
  if (!entries.length) return `<div class="empty" style="padding:8px 0">暂无打卡记录</div>`;
  const isMainSub = key === "mainLog" || key.startsWith("sub:");
  return `<ul class="log">${entries.map(e => `<li>
    <div class="meta"><b>${esc(e.byName)}</b><span class="num">${fmtT(e.t)}</span>
      <span class="act-row">${canTouchEntry(o, e, section) ? `<button type="button" class="act-btn" onclick="A.editLog('${o.id}','${key}','${e.id}')">改</button>` : ""}
      ${canTouchEntry(o, e, section) ? `<button type="button" class="act-btn danger" onclick="A.delLog('${o.id}','${key}','${e.id}')">删</button>` : ""}</span></div>
    ${isMainSub && e.process ? `<div style="font-size:13px;color:var(--ink-2);margin-top:2px">
      生产工序：${esc(e.process)} · 车工人数：${esc(e.workers)} · 预计下车：${esc(fmtDate(e.estDone))}</div>` : ""}
    ${e.text ? `<div class="txt">${esc(e.text)}</div>` : ""}${photoGallery(e.photos)}</li>`).join("")}</ul>`;
}
// 本厂/加工点打卡必填工序、人数、预计下车时间
function mainSubAddBoxHtml(oid, key, placeholder) {
  return `<div class="addbox" id="add-${key}">
    <label class="field"><span>生产工序</span><input class="in" id="proc-${key}" placeholder="例：车缝、锁边"></label>
    <label class="field"><span>车工人数</span><input class="in" type="number" id="workers-${key}" placeholder="例：12"></label>
    <label class="field"><span>预计下车时间</span>${dateFieldHtml("est-" + key, "")}</label>
    <textarea class="in" id="txt-${key}" placeholder="${esc(placeholder)}" style="margin-top:8px"></textarea>
    ${photoPicker("log:" + key)}
    <div style="margin-top:8px"><button class="btn mini" onclick="A.addLog('${oid}','${key}')">提交打卡</button></div></div>`;
}
function logFieldHtml(o, f, list, addKey, canAdd, section) {
  return `<div class="logfield">
    <div class="lf-head"><span><span class="lf-dot"></span>${esc(f.label)}</span><span class="cnt">${(list || []).length} 条</span>
      ${canAdd ? `<button class="btn mini right" onclick="A.toggleAdd('${addKey}')">＋ 打卡</button>` : ""}</div>
    ${canAdd ? `<div class="addbox" id="add-${addKey}">
      <textarea class="in" id="txt-${addKey}" placeholder="填写当前进度情况，可详细描述…"></textarea>
      ${photoPicker("log:" + addKey)}
      <div style="margin-top:8px"><button class="btn mini" onclick="A.addLog('${o.id}','${addKey}')">提交打卡</button></div></div>` : ""}
    ${logEntriesHtml(list, o, addKey, section)}</div>`;
}
function subCardHtml(o, s, canProdLog) {
  const key = "sub:" + s.id;
  return `<div style="margin-top:10px;border-top:.5px solid var(--line);padding-top:10px">
    <div class="lf-head fac-head">
      <span class="fac-kind">加工点</span><span class="tag hl">${esc(s.name)}</span>
      ${canProdLog || isAdmin() ? `<span class="act-row">${canProdLog ? `<button type="button" class="act-btn" onclick="A.renameSub('${o.id}','${s.id}')">改名</button>` : ""}${
        isAdmin() ? `<button type="button" class="act-btn danger" onclick="A.delSub('${o.id}','${s.id}')">删除</button>` : ""}</span>` : ""}
      ${canProdLog ? `<button class="btn mini right" onclick="A.toggleAdd('${key}')">＋ 打卡</button>` : ""}
    </div>
    ${canProdLog ? mainSubAddBoxHtml(o.id, key, "该加工点的进度情况（补充说明，选填）…") : ""}
    ${logEntriesHtml(s.log, o, key, "production")}</div>`;
}
function inspItemHtml(o, g, it, canInsp, canFix) {
  // 没权限填整改时写明该谁填
  const fixHint = o.values.follower ? `由 ${esc(uname(o.values.follower))} 或管理员填写` : "尚未指定下厂员，需管理员先在「生产明细」指定负责人";
  return `<div class="insp-item">
    <div><span class="lbl p">发现问题</span>${esc(it.problem)}
      ${canInsp ? `<button type="button" class="act-btn" style="margin-left:6px" onclick="A.editInspProblem('${o.id}','${g.id}','${it.id}')">改</button>` : ""}</div>
    <div style="margin-top:4px"><span class="lbl f2">整改情况</span>${it.fix ? esc(it.fix)
        : `<span style="color:var(--ink-2)">待整改${canFix ? "" : `（${fixHint}）`}</span>`}
      ${canFix ? `<button type="button" class="act-btn" style="margin-left:6px" onclick="A.editInspFix('${o.id}','${g.id}','${it.id}')">${it.fix ? "改" : "填写"}</button>` : ""}</div>
    ${(it.notes || []).length ? it.notes.map(n => `<div style="margin-top:4px;font-size:12.5px;color:var(--ink-2)">补充说明（${esc(n.byName)} · ${fmtT(n.t)}）：${esc(n.text)}</div>`).join("") : ""}
    ${(canInsp || canFix) ? `<button type="button" class="act-btn ghost" style="margin-top:6px" onclick="A.addInspNote('${o.id}','${g.id}','${it.id}')">＋ 补充说明</button>` : ""}
  </div>`;
}
function inspBatchHtml(o, g, canInsp, canFix) {
  return `<div class="insp-day">
    <div class="lf-head"><span style="font-weight:400;color:var(--ink-2);font-size:12.5px">${esc(g.byName)} · <span class="num">${fmtT(g.t)}</span></span>
      ${canTouchEntry(o, g) ? `<button type="button" class="act-btn danger right" onclick="A.delInsp('${o.id}','${g.id}')">删除</button>` : ""}</div>
    ${g.items.map(it => inspItemHtml(o, g, it, canInsp, canFix)).join("")}${photoGallery(g.photos)}</div>`;
}
function vDetail() {
  const o = state.orders.find(x => x.id === route.id);
  if (!o) return `<div class="card"><div class="empty">订单不存在</div></div>`;
  const scalars = scalarFields;
  const logsOf = s => state.fields[s].filter(f => f.type === "log");
  const canEditOrd = canEditSection(o, "order");
  const canOrdLog = canAddLog(o, "order"), canProdLog = canAddLog(o, "production");
  const canInsp = canWriteInspProblem(o), canFix = canWriteInspFix(o);
  // 订单交期/发货日期可在详情页直接选
  const isQuickDateField = f => f.k === "deadline" || f.k === "shipDate";
  const kv = (fs, canEditThis) => fs.map(f => {
    const isShipDateRow = f.k === "shipDate";
    const rowStyle = isShipDateRow ? ` style="border-bottom:0"` : "";
    // 发货日期已锁定且有权改时显示「清空」
    const showClearBtn = isShipDateRow && canEditThis && shipLocked(o);
    const clearBtn = showClearBtn ? `<button class="btn mini ghost" onclick="A.clearShipDate('${o.id}')">清空</button>` : "";
    const row = isQuickDateField(f) && canEditThis
      ? `<div class="row-item"${rowStyle}><div class="row-main"><div class="row-label">${esc(f.label)}</div></div>
          <div class="row-value" style="display:flex;align-items:center;gap:10px">${dateFieldHtml("qd-" + o.id + "-" + f.k, o.values[f.k], `A.quickSetDate('${o.id}','${f.k}',this.value)`)}${clearBtn}</div></div>`
      : `<div class="row-item"${rowStyle}><div class="row-main"><div class="row-label">${esc(f.label)}</div></div>
          <div class="row-value">${esc(displayVal(o, f)) || "—"}</div></div>`;
    const warn = isShipDateRow ? `<div style="margin:0 16px 12px;padding:10px 14px;border-radius:var(--radius);background:var(--bad-soft);color:var(--bad);font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px">
        <span>⚠️</span><span>发货日期一旦选择，不可以再次修改</span></div>` : "";
    return row + warn;
  }).join("");
  const editForm = s => `<div class="grid2">${scalars(s).filter(f => !isQuickDateField(f)).map(f => fieldRow(f, o.values[f.k] || "")).join("")}</div>`;
  const photos = normalizePhotos(o.values.img);
  const headerThumb = coverImgHtml(photos, "header-thumb");
  const dateFieldsProd = scalars("production").filter(isQuickDateField);
  const topProdScalars = scalars("production").filter(f => !isQuickDateField(f));
  const orderKvFields = scalars("order").filter(f => f.type !== "image" && !isQuickDateField(f));
  const dateFieldsOrder = scalars("order").filter(isQuickDateField);

  return `<section class="group g-head">
    <div class="card"><div class="card-pad" style="display:flex;align-items:center;gap:14px">
      ${seasonTag(o.season, "flex:none;font-size:14px;padding:5px 12px")}
      <div style="flex:1;min-width:0">
        <div style="font-size:20px;font-weight:700;letter-spacing:-.02em">${esc(o.values.styleNo || "")}</div>
        <div style="color:var(--ink-2);margin-top:2px">${esc([o.values.styleName, o.values.style].filter(Boolean).join(" "))}</div>
      </div>
      ${headerThumb}
    </div></div></section>

  <section class="group g-order">
    <div class="group-title"><span class="cat-title">一、订单明细</span>${canEditOrd ? `<button class="btn mini ghost right" onclick="A.toggleBasic()">${editingBasic ? "取消" : "编辑"}</button>` : ""}</div>
    <div class="card">${editingBasic && canEditOrd
      ? `<label class="field"><span>订单季节</span>${seasonSelectHtml(o.season)}</label>${editForm("order")}
         <div class="btn-row"><button class="btn" onclick="A.saveBasic('${o.id}')">保存修改</button></div>`
      : kv(orderKvFields, canEditOrd)}</div>
    ${dateFieldsOrder.length ? `<div class="card" style="margin-top:14px">${kv(dateFieldsOrder, canEditOrd)}</div>` : ""}
    <div class="card" style="margin-top:14px">${logsOf("order").map(f => logFieldHtml(o, f, o.logs[f.k] || [], f.k, canOrdLog, "order")).join("")}</div>
  </section>

  <section class="group g-prod">
    <div class="group-title"><span class="cat-title">二、生产明细</span>${canEditOrd ? `<button class="btn mini ghost right" onclick="A.toggleFollower()">${editingFollower ? "取消" : "编辑"}</button>` : ""}
      <span style="margin-left:8px;font-size:12.5px;color:var(--ink-2)">${o.values.follower ? `负责人 ${esc(uname(o.values.follower))}` : "未指定下厂员"}</span></div>
    <div class="card">${editingFollower && canEditOrd
      ? `${editForm("production")}<div class="btn-row"><button class="btn" onclick="A.saveBasic('${o.id}')">保存修改</button></div>`
      : kv(topProdScalars, false)}</div>
    <div class="card" style="margin-top:14px">
      ${logsOf("production").filter(f => f.k === "cutting").map(f => logFieldHtml(o, f, o.logs[f.k] || [], f.k, canProdLog, "production")).join("")}
      <div class="prodgroup-title"><span><span class="lf-dot"></span>生产进度</span></div>
      <div class="logfield" style="padding-top:0">
        <div style="margin-top:10px;border-top:.5px solid var(--line);padding-top:10px">
          <div class="lf-head fac-head"><span class="fac-kind">本厂</span>
            <span class="tag hl">${esc(o.values.factory) || "未指定"}</span>
            ${canProdLog ? `<button class="btn mini right" onclick="A.toggleAdd('mainLog')">＋ 打卡</button>` : ""}</div>
          ${canProdLog ? mainSubAddBoxHtml(o.id, "mainLog", "本厂生产进度（补充说明，选填）…") : ""}
          ${logEntriesHtml(o.mainLog, o, "mainLog", "production")}</div>
        ${(o.subs || []).map(s => subCardHtml(o, s, canProdLog)).join("")}
        ${canProdLog ? `<div style="margin-top:10px;border-top:.5px solid var(--line);padding-top:10px">
          <button class="btn mini ghost" onclick="A.addSubPrompt('${o.id}')">＋ 添加加工点</button></div>` : ""}
      </div>
      ${logsOf("production").filter(f => f.k !== "cutting").map(f => logFieldHtml(o, f, o.logs[f.k] || [], f.k, canProdLog, "production")).join("")}
    </div>
    ${dateFieldsProd.length ? `<div class="card" style="margin-top:14px">${kv(dateFieldsProd, canEditShipDate(o))}</div>` : ""}
  </section>

  <section class="group g-insp">
    <div class="group-title"><span class="cat-title">三、验货问题</span>${canInsp ? `<button class="btn mini ghost right" onclick="A.toggleAdd('insp')">＋ 新增</button>` : ""}</div>
    <div class="card">
      ${canInsp ? `<div class="addbox" id="add-insp">
        <div id="insp-items"><label class="field"><span>发现问题</span><textarea class="in insp-p" style="min-height:62px"></textarea></label></div>
        <div class="field" style="border:0"><span>照片</span>${photoPicker("insp")}</div>
        <div class="btn-row"><button class="btn mini ghost" onclick="A.inspAddRow()">＋ 再加一条</button>
          <button class="btn mini" onclick="A.saveInsp('${o.id}')">保存验货记录</button></div></div>` : ""}
      ${o.inspections.length ? o.inspections.slice().sort((a, b) => b.t - a.t).map(g => inspBatchHtml(o, g, canInsp, canFix)).join("")
        : `<div class="empty">暂无验货记录</div>`}</div>
  </section>

  <section class="group g-follow">
    <div class="group-title"><span class="cat-title">四、跟单小结</span><button class="btn mini ghost right" onclick="A.toggleAdd('follow')">＋ 添加</button></div>
    <div class="card">
      <div class="addbox" id="add-follow" style="padding:12px 16px">
        <textarea class="in" id="txt-follow" placeholder="填写跟单过程中的问题、沟通事项…"></textarea>
        ${photoPicker("follow")}
        <div style="margin-top:8px"><button class="btn mini" onclick="A.addFollow('${o.id}')">提交</button></div></div>
      ${o.followIssues.length ? `<ul class="log" style="padding:4px 16px 12px">${o.followIssues.slice().sort((a, b) => b.t - a.t).map(e => `<li>
        <div class="meta"><b>${esc(e.byName)}</b><span class="num">${fmtT(e.t)}</span>${canTouchEntry(o, e) ?
          `<button type="button" class="act-btn danger" onclick="A.delFollow('${o.id}','${e.id}')">删</button>` : ""}</div>
        ${e.text ? `<div class="txt">${esc(e.text)}</div>` : ""}${photoGallery(e.photos)}</li>`).join("")}</ul>` : `<div class="empty">暂无记录</div>`}</div>
  </section>
  ${isAdmin() ? `<section class="group g-del"><div class="btn-row" style="padding-left:0;padding-right:0">
    <button class="btn danger ghost block" onclick="A.delOrder('${o.id}')">删除此订单</button></div></section>` : ""}`;
}

// ---------- 打卡记录（按订单分组） ----------
const LOG_GROUP_PREVIEW = 5;  // 每组默认显示的条数
function logListHtml(rows) {
  if (!rows) return `<div class="card"><div class="empty">加载中…</div></div>`;
  if (!rows.length) return `<div class="card"><div class="empty">还没有打卡记录</div></div>`;
  const groups = [];
  const byOrder = new Map();
  rows.forEach(r => {
    let g = byOrder.get(r.orderId);
    if (!g) { g = { orderId: r.orderId, styleNo: r.styleNo, styleName: r.styleName, items: [] }; byOrder.set(r.orderId, g); groups.push(g); }
    g.items.push(r);
  });
  groups.forEach(g => g.items.sort((a, b) => b.t - a.t));
  groups.sort((a, b) => b.items[0].t - a.items[0].t);
  return groups.map(g => {
    const expanded = expandedLogGroups.has(g.orderId);
    const visible = expanded ? g.items : g.items.slice(0, LOG_GROUP_PREVIEW);
    const hidden = g.items.length - visible.length;
    return `<div class="card log-group">
    <div class="lf-head" style="padding:11px 16px 0">
      <a href="javascript:void(0)" onclick="go('detail','${g.orderId}')">${esc(g.styleNo || "")} ${esc(g.styleName || "")}</a>
      <span class="cnt right">共 ${g.items.length} 条</span></div>
    <div class="loglist">${visible.map(r => `<div class="logrow">
      <div class="lr-top"><span>${esc(r.label)}</span><span class="num right">${fmtT(r.t)}</span></div>
      <div class="lr-text">${esc(r.text)}</div></div>`).join("")}</div>
    ${hidden > 0 ? `<button class="btn plain block" onclick="A.toggleLogGroup('${g.orderId}')">展开剩余 ${hidden} 条</button>`
      : (expanded && g.items.length > LOG_GROUP_PREVIEW ? `<button class="btn plain block" onclick="A.toggleLogGroup('${g.orderId}')">收起</button>` : "")}
    </div>`;
  }).join("");
}

// ---------- 聊天 ----------
const avatarHtml = (name, cls) => `<span class="avatar ${cls || ""}">${esc((name || "?").slice(0, 1))}</span>`;
function contactsHtml() {
  const list = state.chat.contacts;
  if (!list.length) return `<div class="empty">还没有其他同事，先到「管理后台」创建员工账号</div>`;
  return list.map(c => `<div class="contact" onclick="A.openChat('${c.id}')">
    ${avatarHtml(c.name)}
    <div class="c-main">
      <div class="c-top"><b>${esc(c.name)}</b>
        ${c.last ? `<span class="c-time num">${fmtT(c.last.t)}</span>` : ""}</div>
      <div class="c-last">${c.last ? (c.last.fromMe ? "我：" : "") + esc(c.last.text) : "打个招呼吧"}</div>
    </div>
    ${badgeHtml(c.unread) || `<span class="chev">›</span>`}
  </div>`).join("");
}
function attachmentHtml(a, mine) {
  if (!a) return "";
  if (a.isImage) return `<img class="b-img" src="${esc(a.url)}" alt="${esc(a.name)}"
    data-gallery='${JSON.stringify([a.url])}' data-i="0" onclick="A.lightboxFromEl(this)">`;
  return `<a class="b-file" href="${esc(a.url)}" target="_blank" rel="noopener" download="${esc(a.name)}"
    style="${mine ? "color:#fff" : ""}"><span class="fi">📄</span>
    <span><span class="fn">${esc(a.name)}</span><br><span class="fs num">${fmtSize(a.size)}</span></span></a>`;
}
// 间隔超过 5 分钟才显示时间
function chatTimeLabel(t) {
  const d = new Date(t), n = new Date(), p = x => String(x).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.toDateString() === n.toDateString()) return hm;
  const y = d.getFullYear() === n.getFullYear() ? "" : d.getFullYear() + "年";
  return `${y}${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}
function messagesHtml() {
  const ms = state.chat.messages;
  if (!ms.length) return `<div class="empty" style="padding:30px 0">还没有聊天记录，发第一条消息吧</div>`;
  let lastT = 0;
  return ms.map(m => {
    let sep = "";
    if (m.t - lastT > 5 * 60 * 1000) sep = `<div class="day-sep">${chatTimeLabel(m.t)}</div>`;
    lastT = m.t;
    return sep + `<div class="bubble-row ${m.fromMe ? "mine" : ""}">
      ${m.fromMe ? "" : avatarHtml(state.chat.contact && state.chat.contact.name, "sm")}
      <div class="bubble" title="${esc(fmtT(m.t))}">${attachmentHtml(m.attachment, m.fromMe)}${m.text ? esc(m.text) : ""}</div></div>`;
  }).join("");
}
function vChat() {
  if (!state.chat.activeId) {
    return `<section class="group" style="margin-top:4px">
      <div class="card" id="chat-contacts">${contactsHtml()}</div></section>`;
  }
  const a = state.chat.att;
  return `<div class="chat-card">
    <div class="chat-msgs" id="chat-msgs">${messagesHtml()}</div>
    ${a ? `<div class="att-bar">${a.isImage ? "🖼" : "📄"} ${esc(a.name)} <span class="num" style="color:var(--ink-2)">${fmtSize(a.size)}</span>
      <span class="x" onclick="A.clearAtt()">✕</span></div>` : ""}
    <div class="chat-input">
      <input type="file" id="chat-file" style="display:none"
        accept=".jpg,.jpeg,.png,.gif,.webp,.heic,.pdf,.xlsx,.xls,.csv,.doc,.docx,.ppt,.pptx,.txt,.zip"
        onchange="A.pickAtt(this)">
      <button class="icon-btn" title="发送图片或文件" onclick="document.getElementById('chat-file').click()">＋</button>
      <textarea class="in" id="chat-text" rows="1" placeholder="输入消息…"
        oninput="A.onDraft(this.value)"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();A.sendMsg();}">${esc(state.chat.draft)}</textarea>
      <button class="btn chat-send" onclick="A.sendMsg()">发送</button>
    </div></div>`;
}

// ---------- 员工打卡记录 ----------
function vStaffLogs() {
  const u = userById(route.id);
  return `<section class="group">
    <div class="group-title">${esc(u ? u.name : "")} 的打卡记录${state.myLogs ? ` · 共 ${state.myLogs.length} 条` : ""}</div>
    <div class="log-groups">${logListHtml(state.myLogs)}</div></section>`;
}

// ---------- 管理后台 ----------
const PERM_LABELS = [
  ["editOrder",   "改「一、订单明细」",      "货号、款式、数量、交期、工厂这些字段"],
  ["editProd",    "改「二、生产明细」",      "指定下厂员、加工点、发货日期"],
  ["logOrder",    "在「一、订单明细」打卡",  "面料进度、绣印进度、产前样进度"],
  ["logProd",     "在「二、生产明细」打卡",  "裁剪、整烫、包装、本厂和加工点"],
  ["createOrder", "新建 / 导入订单",         ""],
  ["inspect",     "验货问题与整改",          ""]
];
const TEMPLATE_LABEL = { sales: "业务员", follower: "下厂员", supervisor: "主管" };

function adminPeopleHtml() {
  const roleCell = u => u.role === "admin"
    ? `<span class="tag role">管理员</span>`
    : `<select class="in tbl-select" onchange="A.changeRole('${u.id}',this.value)">
        ${state.roles.map(r => `<option value="${esc(r.k)}" ${u.role === r.k ? "selected" : ""}>${esc(r.label)}</option>`).join("")}</select>`;
  const kw = adminUserFilt.kw.trim().toLowerCase();
  const allStaff = state.users.filter(u => u.role !== "admin");
  const matched = kw ? allStaff.filter(u => u.name.toLowerCase().includes(kw)) : allStaff;
  const totalPages = Math.max(1, Math.ceil(matched.length / ADMIN_USERS_PAGE_SIZE));
  if (adminUserFilt.page > totalPages) adminUserFilt.page = totalPages;
  if (adminUserFilt.page < 1) adminUserFilt.page = 1;
  const pageStart = (adminUserFilt.page - 1) * ADMIN_USERS_PAGE_SIZE;
  const pageStaff = matched.slice(pageStart, pageStart + ADMIN_USERS_PAGE_SIZE);
  return `<section class="group a-users">
    <div class="group-title">员工账号 · 共 ${allStaff.length} 人</div>
    <div class="card"><div class="card-pad" style="padding-bottom:0">
      <input class="in" id="admin-user-kw" placeholder="搜索姓名" value="${esc(adminUserFilt.kw)}" oninput="A.setAdminUserKw(this.value)">
    </div><div class="tbl-wrap"><table class="tbl stack">
      <tr><th>姓名</th><th>手机号</th><th>职位</th><th>操作</th></tr>
      ${pageStaff.map(u => `<tr>
        <td style="white-space:nowrap">${esc(u.name)}${u.id === me().id ? ` <span class="tag">我</span>` : ""}</td>
        <td class="num">${esc(u.phone)}</td><td>${roleCell(u)}</td>
        <td style="white-space:nowrap"><button class="btn mini ghost" onclick="A.viewStaffLogs('${u.id}')">查看打卡</button>${
          u.role === "admin" ? "" : ` <button class="btn mini ghost" onclick="A.resetUserPw('${u.id}')">重置密码</button>
          <button class="btn mini danger ghost" onclick="A.deleteUser('${u.id}')">删除</button>`}</td></tr>`).join("")
        || `<tr><td colspan="4"><div class="empty">没有符合条件的员工</div></td></tr>`}
    </table></div>
    ${totalPages > 1 ? `<div class="card-pad" style="display:flex;align-items:center;justify-content:center;gap:14px">
      <button class="btn mini ghost" ${adminUserFilt.page <= 1 ? "disabled" : ""} onclick="A.setAdminUserPage(${adminUserFilt.page - 1})">‹ 上一页</button>
      <span class="row-sub num">第 ${adminUserFilt.page} / ${totalPages} 页</span>
      <button class="btn mini ghost" ${adminUserFilt.page >= totalPages ? "disabled" : ""} onclick="A.setAdminUserPage(${adminUserFilt.page + 1})">下一页 ›</button>
    </div>` : ""}
    </div>
  </section>

  <section class="group a-newuser">
    <div class="group-title">新增员工</div>
    <div class="card">
      <label class="field"><span>姓名</span><input class="in" id="nu-name"></label>
      <label class="field"><span>手机号</span><input class="in" id="nu-phone" inputmode="tel"></label>
      <label class="field"><span>职位</span><select class="in" id="nu-role">${
        state.roles.map(r => `<option value="${esc(r.k)}">${esc(r.label)}</option>`).join("")}</select></label>
      <label class="field"><span>初始密码</span><input class="in" id="nu-pass" value="123456"></label>
      <div class="btn-row"><button class="btn" onclick="A.addUser()">创建账号</button></div></div>
  </section>`;
}

function adminPermsHtml() {
  return `<section class="group a-roles">
    <div class="group-title">职位</div>
    <div class="card"><div class="card-pad">
      <div class="chip-wall">${state.roles.map(r => chipHtml(`${r.label} · ${TEMPLATE_LABEL[r.template] || "下厂员"}权限`,
        r.core ? "" : `A.delRole('${r.k}')`)).join("")}</div></div>
      <label class="field"><span>新职位名称</span><input class="in" id="nr-label" placeholder="例：跟单主管"></label>
      <label class="field"><span>权限模板</span><select class="in" id="nr-template">
        <option value="sales">业务员权限（管自己创建/负责的订单）</option>
        <option value="follower">下厂员权限（管自己被指派的订单）</option>
        <option value="supervisor">主管权限（管所有订单）</option></select></label>
      <div class="btn-row"><button class="btn" onclick="A.addRole()">添加职位</button></div></div>
  </section>

  <section class="group a-perms">
    <div class="group-title">权限配置</div>
    ${state.roles.map(r => {
      const p = permsOfRole(r);
      return `<div class="card" style="margin-top:12px">
        <div class="row-item" style="background:var(--bg)">
          <div class="row-main"><div class="row-label">${esc(r.label)}</div>
            <div class="row-sub">${TEMPLATE_LABEL[r.template] || "下厂员"}模板${r.perms ? " · 已自定义" : " · 默认权限"}</div></div>
          ${r.perms ? `<button class="btn mini ghost" onclick="A.resetRolePerms('${r.k}')">恢复默认</button>` : ""}
        </div>
        <label class="field"><span>看订单范围</span>
          <select class="in" onchange="A.setRolePerm('${r.k}','scope',this.value)">
            <option value="own" ${p.scope === "own" ? "selected" : ""}>只看自己相关的订单</option>
            <option value="all" ${p.scope === "all" ? "selected" : ""}>看全部订单</option></select></label>
        ${PERM_LABELS.map(([k, name, sub]) => `<label class="perm-row">
          <input type="checkbox" ${p[k] ? "checked" : ""} onchange="A.setRolePerm('${r.k}','${k}',this.checked)">
          <span class="perm-main"><span class="perm-name">${name}</span>${
            sub ? `<div class="perm-sub">${sub}</div>` : ""}</span></label>`).join("")}
      </div>`;
    }).join("")}
  </section>`;
}

function adminFormHtml() {
  return `<section class="group a-fields">
    <div class="group-title">自定义字段</div>
    <div class="card cf-split">
      <div class="cf-lists">${["order", "production"].map(s => `<div class="card-pad" style="padding-bottom:6px">
        <div class="row-sub" style="margin-bottom:6px">${s === "order" ? "一、订单明细" : "二、生产明细"}</div>
        <div class="chip-wall">${state.fields[s].map(f => chipHtml(f.label, f.core ? "" : `A.delField('${s}','${f.k}')`)).join("")}</div></div>`).join("")}</div>
      <div class="cf-form">
      <label class="field"><span>添加到板块</span><select class="in" id="cf-sec"><option value="order">一、订单明细</option><option value="production">二、生产明细</option></select></label>
      <label class="field"><span>字段名称</span><input class="in" id="cf-label" placeholder="例：吊牌进度"></label>
      <label class="field"><span>字段类型</span><select class="in" id="cf-type" onchange="document.getElementById('cf-opts-wrap').style.display=this.value==='select'?'':'none'">
        <option value="text">文本</option><option value="log">进度打卡（保留历史）</option><option value="date">日期</option>
        <option value="number">数字</option><option value="select">下拉菜单</option></select></label>
      <label class="field" id="cf-opts-wrap" style="display:none"><span>下拉选项（逗号分隔）</span><input class="in" id="cf-opts" placeholder="例：选项A,选项B"></label>
      <div class="btn-row"><button class="btn" onclick="A.addField()">添加字段</button></div></div></div>
  </section>

  <section class="group a-factories">
    <div class="group-title">工厂下拉选项</div>
    <div class="card">${[["fabric", "面料工厂"], ["emb", "绣花/印花工厂"], ["prod", "服装工厂"]].map(([k, t]) => `
      <div class="card-pad" style="padding-bottom:10px">
        <div class="row-sub" style="margin-bottom:6px">${t}</div>
        <div class="chip-wall">${state.factories[k].map(x => chipHtml(x, `A.delFactory('${k}','${encodeURIComponent(x)}')`)).join("")}</div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <input class="in" id="fac-${k}" placeholder="新工厂名"><button class="btn mini ghost" onclick="A.addFactory('${k}')">添加</button></div></div>`).join("")}</div>
  </section>

  <section class="group a-seasons">
    <div class="group-title">季节</div>
    <div class="card"><div class="card-pad">
      <div class="chip-wall">${state.seasons.map(s => chipHtml(s, `A.delSeason('${encodeURIComponent(s)}')`)).join("")}</div></div>
      <label class="field"><span>新季节名称</span><input class="in" id="ns-name" placeholder="例：SS2029"></label>
      <div class="btn-row"><button class="btn" onclick="A.addSeason()">添加季节</button></div></div>
  </section>`;
}

function adminDataHtml() {
  return `<section class="group a-export">
    <div class="group-title">数据导出</div>
    <div class="card"><div class="card-pad">
      <p class="row-sub" style="margin:0 0 12px">导出订单全部内容（订单基本信息、生产进度、验货问题、跟单小结）为 Excel(.xlsx) 文件，照片直接嵌在表格里</p>
      <label class="field" style="padding-left:0;padding-right:0;border:0"><span>按季节筛选（可选）</span>
        <select class="in" id="exp-season"><option value="">全部季节</option>${
          seasonOptions("").map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}</select></label>
      <button class="btn" id="exp-btn" onclick="A.exportData()"><span class="btn-spin" aria-hidden="true"></span><span>导出订单数据</span></button>
      <p class="row-sub" style="margin:10px 0 0">文件会交给浏览器下载；在微信里打开本系统时无法下载，请先用浏览器打开</p></div></div>
  </section>`;
}

const ADMIN_TABS = [["people", "人员"], ["perms", "权限"], ["form", "表单配置"], ["data", "数据"]];
function vAdmin() {
  if (!isAdmin()) return `<div class="card"><div class="empty">仅管理员可访问</div></div>`;
  const body = adminTab === "perms" ? adminPermsHtml()
    : adminTab === "form" ? adminFormHtml()
    : adminTab === "data" ? adminDataHtml()
    : adminPeopleHtml();
  return `<nav class="subnav">${ADMIN_TABS.map(([k, label]) =>
    `<button class="${adminTab === k ? "on" : ""}" onclick="A.setAdminTab('${k}')">${label}</button>`).join("")}</nav>
  ${body}`;
}

// ---------- 消息通知 ----------
function vNotifs() {
  const list = state.notifs.list;
  return `<section class="group">
    <div class="group-title">订单动态${list ? ` · 共 ${list.length} 条` : ""}</div>
    <div class="card notif-list">${notifItemsHtml()}</div>
    ${(list || []).some(x => x.read) ? `<div class="btn-row"><button class="btn plain block" onclick="A.clearReadNotifs()">清空已读通知</button></div>` : ""}
  </section>`;
}

// ---------- 我的 ----------
function vAccount() {
  const m = me();
  return `<section class="group">
    <div class="card">
      <div class="card-pad" style="display:flex;align-items:center;gap:14px">
        ${avatarHtml(m.name)}
        <div><div style="font-size:19px;font-weight:600">${esc(m.name)}</div>
          <div class="row-sub">${esc(roleLabelOf(m))} · <span class="num">${esc(m.phone)}</span></div></div></div>
    </div></section>

  <section class="group">
    <div class="card"><div class="row-item tap" onclick="go('notifs')" role="button" tabindex="0">
      <div class="row-main"><div class="row-label">消息通知</div>
        <div class="row-sub">订单被同事更新时在这里提醒你</div></div>
      ${badgeHtml(state.notifs.unread)}<span class="chev">›</span></div></div>
  </section>

  <section class="group">
    <div class="group-title">修改密码</div>
    <div class="card">
      <label class="field"><span>新密码</span><input class="in" type="password" id="my-p1" autocomplete="new-password"></label>
      <label class="field"><span>确认新密码</span><input class="in" type="password" id="my-p2" autocomplete="new-password"></label>
      <div class="btn-row"><button class="btn" onclick="A.changeMyPw()">确认修改</button></div></div>
  </section>

  <section class="group">
    <div class="group-title">我的打卡记录${state.myLogs ? ` · 共 ${state.myLogs.length} 条` : ""}</div>
    <div class="log-groups">${logListHtml(state.myLogs)}</div>
  </section>

  ${pushSectionHtml()}

  <section class="group">
    <div class="btn-row" style="padding-left:0;padding-right:0">
      ${canOfferInstall() ? `<button class="btn ghost block" style="margin-bottom:10px" onclick="A.install()">📲 安装到手机</button>` : ""}
      <button class="btn danger ghost block" onclick="A.logout()">退出登录</button></div>
  </section>`;
}

function pushSectionHtml() {
  const iosNeedsInstall = isIOSDevice() && !isStandalone();
  let body;
  if (iosNeedsInstall) {
    // iOS 只有从主屏图标打开才能收通知
    body = `<div class="row-item"><div class="row-main">
        <div class="row-label">需要先安装到手机</div>
        <div class="row-sub">iPhone 上只有从主屏幕图标打开，才能收到系统通知</div></div></div>
      <div class="btn-row"><button class="btn ghost block" onclick="A.install()">📲 安装到手机</button></div>`;
  } else if (!pushState.supported) {
    body = `<div class="row-item"><div class="row-main">
        <div class="row-label">当前浏览器不支持系统通知</div>
        <div class="row-sub">微信里打开的收不到通知，请用系统浏览器打开，或先安装到手机</div></div></div>`;
  } else if (pushState.permission === "denied") {
    body = `<div class="row-item"><div class="row-main">
        <div class="row-label">通知权限已被拒绝</div>
        <div class="row-sub">要到手机的「设置 → 通知」里，把本应用的通知重新打开</div></div></div>`;
  } else if (pushState.on) {
    body = `<div class="row-item"><div class="row-main">
        <div class="row-label">已开启</div>
        <div class="row-sub">订单更新、同事发消息，App 没打开也会提醒你</div></div>
        <span class="tag ok">开启中</span></div>
      <div class="btn-row"><button class="btn danger ghost" onclick="A.disablePush()">关闭通知</button></div>`;
  } else {
    body = `<div class="row-item"><div class="row-main">
        <div class="row-label">未开启</div>
        <div class="row-sub">开启后，订单更新和同事消息会像普通 App 一样提醒你</div></div></div>
      <div class="btn-row"><button class="btn block" onclick="A.enablePush()">开启消息通知</button></div>`;
  }
  return `<section class="group"><div class="group-title">消息通知</div>
    <div class="card">${body}</div></section>`;
}

function inspItemOf(oid, gid, itemId) {
  const o = state.orders.find(x => x.id === oid);
  const g = o && o.inspections.find(x => x.id === gid);
  return g && g.items.find(x => x.id === itemId);
}

// ================= 动作 =================
const A = {
  modalOk() {
    const st = modalState; if (!st) return;
    const v = st.input ? ($("m-input") ? $("m-input").value : "") : null;
    if (st.keepOpenOnOk) { if (st.onOk) st.onOk(v); return; }
    modalState = null; renderModal();
    if (st.onOk) st.onOk(v);
  },
  modalCancel() { modalState = null; renderModal(); },

  // ---------- 照片 ----------
  addDraftPhotos(ctx, input) {
    const files = [...(input.files || [])]; input.value = "";
    A.queuePhotos(ctx, files);
  },
  queuePhotos(ctx, files) {
    if (!files.length) return;
    photoDraft[ctx] = photoDraft[ctx] || [];
    const pend = photoPending[ctx] = photoPending[ctx] || [];
    const imgs = files.filter(looksLikeImage);
    const room = Math.max(0, PHOTO_MAX_PER_PICKER - photoDraft[ctx].length - pend.length);
    if (imgs.length < files.length) toast("已跳过不是图片的文件");
    else if (imgs.length > room) toast(`每处最多 ${PHOTO_MAX_PER_PICKER} 张，多出的 ${imgs.length - room} 张没有添加`);
    imgs.slice(0, room).forEach(file => {
      const it = { id: ++photoSeq, status: "wait", pct: 0, file };
      pend.push(it); processPhoto(ctx, it);
    });
    if (!pend.length) delete photoPending[ctx];
    repaintPicker(ctx);
  },
  retryPhoto(ctx, id) {
    const it = (photoPending[ctx] || []).find(x => x.id === id);
    if (!it || it.status !== "err") return;
    it.status = "wait"; it.err = ""; processPhoto(ctx, it);
  },
  cancelPhoto(ctx, id) {
    const pend = photoPending[ctx] || [], k = pend.findIndex(x => x.id === id);
    if (k < 0) return;
    const it = pend[k]; it.removed = true;
    if (it.xhr) it.xhr.abort();
    if (it.preview) URL.revokeObjectURL(it.preview);
    pend.splice(k, 1);
    flushPending(ctx);  // 前面卡住的删掉后，后面传完的可以落位
  },
  removeDraftPhoto(ctx, i) {
    if (photoDraft[ctx]) { photoDraft[ctx].splice(i, 1); repaintPicker(ctx); }
  },
  lightboxFromEl(el) {
    let photos;
    try { photos = JSON.parse(el.getAttribute("data-gallery")); } catch (e) { return; }
    openLightbox(photos, +el.getAttribute("data-i") || 0, el.getBoundingClientRect ? el.getBoundingClientRect() : null);
  },
  lbStep(d) { lbGo(d); },
  closeLightbox(dir, vy) { closeLightboxNow(dir || 0, vy || 0, false); },

  async login() {
    const phone = $("lg-phone").value.trim(), password = $("lg-pass").value;
    try {
      const r = await api("POST", "/login", { phone, password });
      state.token = r.token; localStorage.setItem("daka_token", r.token);
      showWelcome = true; render();  // 先顶上欢迎界面，不等 bootstrap
      await Promise.all([refresh(), new Promise(res => setTimeout(res, 1500))]);
      go("orders");
      A.dismissWelcome();
      A.refreshUnread(); A.refreshNotifUnread();
    } catch (e) {
      // 只有 bootstrap 失败才收回欢迎界面；密码错误不重画，免得清空输入
      if (showWelcome) { showWelcome = false; render(); }
      toast((e && e.error) || "登录失败");
    }
  },
  dismissWelcome() {
    if (!showWelcome) return;
    showWelcome = false; render();
  },
  // ---------- 系统推送 ----------
  async enablePush() {
    try {
      const perm = await Notification.requestPermission();
      pushState.permission = perm;
      if (perm !== "granted") { render(); return toast(perm === "denied" ? "已拒绝通知权限" : "没有开启通知"); }
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await api("GET", "/push/key");
      const sub = (await reg.pushManager.getSubscription())
        || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(publicKey) });
      const r = await api("POST", "/push/subscribe", { subscription: sub.toJSON() });
      pushState.on = true; pushState.devices = r.devices || 1;
      render();
      toast("已开启通知");
    } catch (e) {
      console.error(e);
      toast((e && e.error) || "开启失败，请换个浏览器或稍后再试");
    }
  },
  async disablePush() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api("POST", "/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe().catch(() => {});
      }
      pushState.on = false; render();
      toast("已关闭通知");
    } catch (e) { toast("关闭失败"); }
  },

  setAdminTab(t) { adminTab = t; render(); window.scrollTo(0, 0); },
  // 权限开关即改即存
  async setRolePerm(roleKey, key, value) {
    const r = state.roles.find(x => x.k === roleKey); if (!r) return;
    const perms = Object.assign({}, permsOfRole(r), r.perms || {});
    perms[key] = value;
    await run(() => api("PATCH", `/roles/${roleKey}/perms`, { perms }), "已保存");
  },
  async resetRolePerms(roleKey) {
    confirmDanger("恢复默认权限", "这个职位的权限将恢复成所属模板的默认配置。",
      () => run(() => api("PATCH", `/roles/${roleKey}/perms`, { perms: null }), "已恢复默认"), "恢复");
  },

  async install() {
    if (isStandalone()) return toast("已经是从主屏打开的了");
    if (deferredInstall) {
      deferredInstall.prompt();
      try { await deferredInstall.userChoice; } catch (e) {}
      deferredInstall = null;
      return;
    }
    A.installGuide();  // iOS 等给图文步骤
  },
  installGuide() {
    const ua = navigator.userAgent || "";
    const isIOS = /iPhone|iPad|iPod/i.test(ua);
    const isWeixin = /MicroMessenger/i.test(ua);
    let steps;
    if (isWeixin) {
      steps = `<div class="guide-step"><b>1.</b> 点右上角 <b>···</b> 菜单</div>
        <div class="guide-step"><b>2.</b> 选「在浏览器打开」（Safari 或 Chrome）</div>
        <div class="guide-step"><b>3.</b> 再按下面的步骤添加到主屏</div>
        <div class="guide-note">微信内置浏览器不能直接装，要先用系统浏览器打开</div>`;
    } else if (isIOS) {
      steps = `<div class="guide-step"><b>1.</b> 点底部中间的 <span class="ios-share"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 12v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-7"/></svg></span> 分享按钮
          （方框加向上箭头）</div>
        <div class="guide-step"><b>2.</b> 在菜单里找到 <b>「添加到主屏幕」</b></div>
        <div class="guide-step"><b>3.</b> 右上角点「添加」，桌面就出现图标了</div>`;
    } else {
      steps = `<div class="guide-step"><b>1.</b> 点浏览器右上角 <b>⋮</b> 菜单</div>
        <div class="guide-step"><b>2.</b> 选 <b>「安装应用」</b> 或「添加到主屏幕」</div>
        <div class="guide-step"><b>3.</b> 确认，桌面就出现图标了</div>`;
    }
    modal({ title: "装到手机主屏", html: `<div class="guide">${steps}</div>`,
      okText: "知道了", onOk: () => A.modalCancel() });
  },
  logout() {
    confirmDanger("退出登录？", "下次需要重新输入手机号和密码。", () => A.forceLogout(), "退出");
  },
  forceLogout() {
    state.token = null; state.me = null; localStorage.removeItem("daka_token"); localStorage.removeItem(STATE_CACHE_KEY);
    route = { v: "orders", id: null }; render();
  },
  async changeMyPw() {
    const p1 = $("my-p1").value, p2 = $("my-p2").value;
    if (!p1 || p1 !== p2) return toast("两次输入的新密码不一致");
    try { await api("POST", "/password/change", { newPassword: p1 }); $("my-p1").value = ""; $("my-p2").value = ""; toast("密码修改成功"); }
    catch (e) { toast((e && e.error) || "修改失败"); }
  },

  openDate(el) {
    // 点在日期数字上也强制弹选择器
    try { if (el.showPicker) el.showPicker(); } catch (e) { }
  },
  syncDateLabel(id) {
    const el = $(id), lab = $(id + "--label"); if (!el || !lab) return;
    lab.textContent = el.value ? fmtDate(el.value) : "选择日期";
    lab.classList.toggle("empty", !el.value);
  },
  async quickSetDate(oid, key, val) {
    await run(() => api("PATCH", "/orders/" + oid, { values: { [key]: val } }), "已更新");
  },
  clearShipDate(oid) {
    confirmDanger("清空发货日期？", "清空后这个字段会解锁，可以重新选择发货日期。",
      () => run(() => api("PATCH", "/orders/" + oid, { values: { shipDate: "" } }), "发货日期已清空"), "确认清空");
  },
  syncFileName(id, name) {
    const el = $(id + "--name"); if (el) el.textContent = name || "未选择文件";
  },

  setF(k, v) { filt[k] = v; render(); },
  // 不在订单页时先跳回订单页
  setStatFilter(kind) {
    const already = kind === "recent" ? filt.recent : filt.ship === kind;
    if (kind === "all" || already) { filt.ship = ""; filt.recent = false; }
    else if (kind === "recent") { filt.ship = ""; filt.recent = true; }
    else { filt.ship = kind; filt.recent = false; }
    if (route.v !== "orders") go("orders"); else { render(); window.scrollTo(0, 0); }
  },
  // 桌面顶部搜索与列表共用 filt.kw
  setDeskKw(v) { filt.kw = v; rerenderKeepFocus("dh-kw", () => { if (route.v !== "orders") go("orders"); else render(); }); },
  setAdminUserKw(v) { adminUserFilt.kw = v; adminUserFilt.page = 1; rerenderKeepFocus("admin-user-kw"); },
  setAdminUserPage(p) { adminUserFilt.page = p; render(); },
  setFKw(v) { filt.kw = v; rerenderKeepFocus("flt-kw"); },
  collectScalars(section, into) {
    for (const f of scalarFields(section)) {
      if (f.type === "image") { into[f.k] = photoDraft.img || []; continue; }
      const el = $("nf-" + f.k); if (!el) continue;
      if (isMultiFactory(f)) { try { into[f.k] = JSON.parse(el.value || "[]"); } catch (e) { into[f.k] = []; } continue; }
      into[f.k] = el.value.trim();
    }
  },
  addFactoryChip(id) {
    const sel = $(id + "--add"); if (!sel || !sel.value) return;
    const hidden = $(id); let arr = []; try { arr = JSON.parse(hidden.value || "[]"); } catch (e) { }
    if (!arr.includes(sel.value)) arr.push(sel.value);
    A.rerenderFactoryField(id, arr);
  },
  removeFactoryChip(id, encVal) {
    const hidden = $(id); let arr = []; try { arr = JSON.parse(hidden.value || "[]"); } catch (e) { }
    arr = arr.filter(v => v !== decodeURIComponent(encVal));
    A.rerenderFactoryField(id, arr);
  },
  rerenderFactoryField(id, arr) {
    const container = document.querySelector(`.multifactory[data-id="${CSS.escape(id)}"]`); if (!container) return;
    const fKey = id.replace(/^(nf-|imp\d+-)/, "");
    const f = allFieldDefs().find(x => x.k === fKey);
    if (!f) return;
    container.outerHTML = factoryMultiHtml(f, arr, id);
  },
  async createOrder() {
    if (photosBlocked("img")) return;
    const season = ($("nf-season").value || "").trim();
    if (!season) return toast("请选择订单季节");
    const values = {}; A.collectScalars("order", values); A.collectScalars("production", values);
    if (!values.styleNo && !values.styleName) return toast("请至少填写货号或款式名");
    try { await api("POST", "/orders", { season, values }); photoDraft = {}; await refresh(); go("orders"); toast("订单已创建"); }
    catch (e) { toast((e && e.error) || "创建失败"); }
  },
  toggleBasic() {
    editingBasic = !editingBasic;
    resetPhotoPending();
    if (editingBasic) { const o = state.orders.find(x => x.id === route.id); photoDraft = { img: normalizePhotos(o && o.values.img) }; }
    else photoDraft = {};
    render();
  },
  toggleFollower() {
    editingFollower = !editingFollower;
    render();
  },
  async saveBasic(oid) {
    if (photosBlocked("img")) return;
    const season = ($("nf-season") || {}).value || "";
    const values = {}; A.collectScalars("order", values); A.collectScalars("production", values);
    await run(() => api("PATCH", "/orders/" + oid, { season, values }).then(() => { editingBasic = false; editingFollower = false; photoDraft = {}; }), "已保存修改");
  },
  delOrder(oid) {
    confirmDanger("删除此订单？", "删除后不可恢复，订单下的全部打卡记录一并删除。",
      () => run(() => api("DELETE", "/orders/" + oid).then(() => go("orders")), "订单已删除"));
  },

  toggleAdd(key) { const b = $("add-" + key); if (b) b.classList.toggle("show"); },
  async addLog(oid, key) {
    if (photosBlocked("log:" + key)) return;
    const el = $("txt-" + key), text = ((el && el.value) || "").trim();
    const photos = photoDraft["log:" + key] || [];
    const body = { key, text, photos };
    const isMainSub = key === "mainLog" || key.startsWith("sub:");
    if (isMainSub) {
      const process = ($("proc-" + key) || {}).value || "", workers = ($("workers-" + key) || {}).value || "";
      const estDone = ($("est-" + key) || {}).value || "";
      if (!process.trim() || !workers.trim() || !estDone) return toast("请填写生产工序、车工人数、预计下车时间");
      Object.assign(body, { process: process.trim(), workers: workers.trim(), estDone });
    } else if (!text && !photos.length) return toast("请填写打卡内容或加照片");
    await run(() => api("POST", `/orders/${oid}/logs`, body).then(() => { delete photoDraft["log:" + key]; }), "打卡成功");
  },
  editLog(oid, key, eid) {
    const o = state.orders.find(x => x.id === oid);
    const list = key === "mainLog" ? o.mainLog
      : key.startsWith("sub:") ? ((o.subs.find(s => s.id === key.slice(4)) || {}).log || [])
      : (o.logs[key] || []);
    const e = list.find(x => x.id === eid); if (!e) return;
    askText({ title: "修改打卡内容", input: "textarea", value: e.text, okText: "保存" },
      t => run(() => api("PATCH", `/orders/${oid}/logs/${key}/${eid}`, { text: t }), "已修改"));
  },
  delLog(oid, key, eid) {
    confirmDanger("删除这条打卡记录？", "", () => run(() => api("DELETE", `/orders/${oid}/logs/${key}/${eid}`), "已删除"));
  },

  // ---------- 加工点 ----------
  addSubPrompt(oid) {
    askText({ title: "添加加工点", body: "给这个加工点起个名字，比如「绣花外发点」「二次印花点」。", okText: "添加" },
      name => run(() => api("POST", `/orders/${oid}/subs`, { name }), "已添加加工点：" + name));
  },
  renameSub(oid, subId) {
    const o = state.orders.find(x => x.id === oid);
    const sub = o && o.subs.find(x => x.id === subId);
    if (!sub) return;
    askText({ title: "修改加工点名称", value: sub.name, okText: "保存" },
      name => run(() => api("PATCH", `/orders/${oid}/subs/${subId}`, { name }), "已修改"));
  },
  delSub(oid, subId) {
    confirmDanger("删除这个加工点？", "删除后该加工点下的打卡记录一并删除，且不可恢复。",
      () => run(() => api("DELETE", `/orders/${oid}/subs/${subId}`), "已删除"));
  },

  // ---------- 验货 ----------
  inspAddRow() {
    const d = document.createElement("label"); d.className = "field";
    d.innerHTML = `<span>发现问题</span><textarea class="in insp-p" style="min-height:62px"></textarea>`;
    $("insp-items").appendChild(d);
  },
  async saveInsp(oid) {
    if (photosBlocked("insp")) return;
    const problems = [...document.querySelectorAll(".insp-p")].map(t => t.value.trim()).filter(Boolean);
    const photos = photoDraft.insp || [];
    if (!problems.length && !photos.length) return toast("请至少填写一条发现的问题或加照片");
    await run(() => api("POST", `/orders/${oid}/inspections`, { problems, photos }).then(() => { delete photoDraft.insp; }), "验货记录已保存");
  },
  delInsp(oid, gid) {
    confirmDanger("删除这组验货记录？", "", () => run(() => api("DELETE", `/orders/${oid}/inspections/${gid}`), "已删除"));
  },
  editInspProblem(oid, gid, itemId) {
    const it = inspItemOf(oid, gid, itemId); if (!it) return;
    askText({ title: "修改发现的问题", input: "textarea", value: it.problem, okText: "保存" },
      t => run(() => api("PATCH", `/orders/${oid}/inspections/${gid}/items/${itemId}`, { problem: t }), "已修改"));
  },
  editInspFix(oid, gid, itemId) {
    const it = inspItemOf(oid, gid, itemId); if (!it) return;
    modal({ title: "填写整改情况", input: "textarea", value: it.fix || "", okText: "保存",
      onOk: v => run(() => api("PATCH", `/orders/${oid}/inspections/${gid}/items/${itemId}`, { fix: (v || "").trim() }), "已保存") });
  },
  addInspNote(oid, gid, itemId) {
    askText({ title: "添加补充说明", input: "textarea", okText: "添加" },
      text => run(() => api("POST", `/orders/${oid}/inspections/${gid}/items/${itemId}/notes`, { text }), "已添加"));
  },
  async addFollow(oid) {
    if (photosBlocked("follow")) return;
    const text = ($("txt-follow").value || "").trim();
    const photos = photoDraft.follow || [];
    if (!text && !photos.length) return toast("请填写内容或加照片");
    await run(() => api("POST", `/orders/${oid}/follow`, { text, photos }).then(() => { delete photoDraft.follow; }), "已添加");
  },
  delFollow(oid, eid) {
    confirmDanger("删除这条记录？", "", () => run(() => api("DELETE", `/orders/${oid}/follow/${eid}`), "已删除"));
  },

  // ---------- 管理后台 ----------
  async addUser() {
    const name = $("nu-name").value.trim(), phone = $("nu-phone").value.trim(),
      role = $("nu-role").value, password = $("nu-pass").value || "123456";
    if (!name || !phone) return toast("请填写姓名和手机号");
    await run(() => api("POST", "/users", { name, phone, role, password }), "账号已创建：" + name);
  },
  async changeRole(id, role) {
    const u = userById(id);
    await run(() => api("PATCH", "/users/" + id, { role }), `已把 ${u ? u.name : ""} 的职位改为${labelForRoleKey(role)}`);
  },
  deleteUser(id) {
    const u = userById(id); if (!u) return;
    confirmDanger(`删除员工「${u.name}」？`, "删除后该账号无法登录；历史打卡记录仍会保留。此操作不可恢复。",
      () => run(() => api("DELETE", "/users/" + id), "已删除员工：" + u.name));
  },
  resetUserPw(id) {
    const u = userById(id); if (!u) return;
    askText({ title: `为 ${u.name} 设置新密码`, value: "123456", okText: "重置" },
      password => run(() => api("POST", `/users/${id}/reset-password`, { password }), "密码已重置"));
  },
  async addRole() {
    const label = $("nr-label").value.trim(), template = $("nr-template").value;
    if (!label) return toast("请填写职位名称");
    await run(() => api("POST", "/roles", { label, template }), "职位已添加：" + label);
  },
  delRole(k) {
    const r = state.roles.find(x => x.k === k); if (!r) return;
    confirmDanger(`删除职位「${r.label}」？`, "只有没人担任该职位时才能删除。", () => run(() => api("DELETE", "/roles/" + k), "职位已删除"));
  },
  async addSeason() {
    const name = $("ns-name").value.trim();
    if (!name) return toast("请填写季节名称");
    await run(() => api("POST", "/seasons", { name }), "季节已添加：" + name);
  },
  delSeason(encName) {
    const name = decodeURIComponent(encName);
    confirmDanger(`删除季节「${name}」？`, "只有没有订单使用该季节时才能删除。", () => run(() => api("DELETE", "/seasons/" + encName), "季节已删除"));
  },
  async addField() {
    const section = $("cf-sec").value, label = $("cf-label").value.trim(), type = $("cf-type").value;
    if (!label) return toast("请填写字段名称");
    const options = type === "select" ? $("cf-opts").value.split(/[,，]/).map(s => s.trim()).filter(Boolean) : undefined;
    await run(() => api("POST", "/fields", { section, label, type, options }), "字段已添加：" + label);
  },
  delField(section, key) {
    const f = state.fields[section].find(x => x.k === key); if (!f) return;
    confirmDanger(`删除字段「${f.label}」？`, "已填写的数据将不再显示。", () => run(() => api("DELETE", `/fields/${section}/${key}`), "字段已删除"));
  },
  async addFactory(kind) {
    const name = $("fac-" + kind).value.trim(); if (!name) return;
    await run(() => api("POST", "/factories", { kind, name }), "已添加");
  },
  async delFactory(kind, encName) { await run(() => api("DELETE", `/factories/${kind}/${encName}`), "已删除"); },

  async loadMyLogs(userId) {
    state.myLogs = null; expandedLogGroups.clear();
    try { state.myLogs = await api("GET", `/users/${userId}/logs`); }
    catch (e) { state.myLogs = []; toast((e && e.error) || "读取失败"); }
    render();
  },
  toggleLogGroup(orderId) {
    if (expandedLogGroups.has(orderId)) expandedLogGroups.delete(orderId); else expandedLogGroups.add(orderId);
    render();
  },
  viewStaffLogs(id) { go("staffLogs", id); },

  // ---------- 聊天 ----------
  async loadContacts(silent) {
    try {
      const list = await api("GET", "/chat/contacts");
      const changed = JSON.stringify(list) !== JSON.stringify(state.chat.contacts);
      state.chat.contacts = list;
      if (changed && !silent && route.v === "chat" && !state.chat.activeId) {
        const box = $("chat-contacts"); if (box) box.innerHTML = contactsHtml(); else render();
      }
    } catch (e) { }
  },
  async openChat(userId) {
    state.chat.activeId = userId; state.chat.messages = []; state.chat.contact = userById(userId) || null;
    state.chat.draft = ""; state.chat.att = null;
    render();
    await A.loadConversation();
    await A.refreshUnread();
  },
  closeChat() {
    state.chat.activeId = null; state.chat.messages = []; state.chat.contact = null;
    state.chat.draft = ""; state.chat.att = null;
    render(); A.loadContacts(true).then(render);
  },
  onDraft(v) { state.chat.draft = v; },
  async pickAtt(input) {
    const file = input.files && input.files[0]; if (!file) return;
    const fd = new FormData(); fd.append("file", file);
    toast("正在上传…");
    try {
      state.chat.att = await xhrUpload("/api/chat/upload", fd); input.value = ""; render();
      const box = $("chat-msgs"); if (box) box.scrollTop = box.scrollHeight;
      toast("附件已就绪，点发送");
    } catch (e) { toast((e && e.error) || "上传失败"); }
  },
  clearAtt() { state.chat.att = null; render(); },
  async loadConversation() {
    if (!state.chat.activeId) return;
    try {
      const r = await api("GET", "/chat/with/" + state.chat.activeId);
      const changed = JSON.stringify(r.messages) !== JSON.stringify(state.chat.messages);
      state.chat.contact = r.contact; state.chat.messages = r.messages;
      if (changed) {
        const box = $("chat-msgs");
        if (box) { box.innerHTML = messagesHtml(); box.scrollTop = box.scrollHeight; }
        else render();
      }
    } catch (e) { }
  },
  async sendMsg() {
    const el = $("chat-text"); if (!el) return;
    const text = (el.value || "").trim(), att = state.chat.att;
    if (!text && !att) return;
    el.value = ""; state.chat.draft = ""; state.chat.att = null;
    if (att) render();
    try {
      await api("POST", "/chat/with/" + state.chat.activeId, { text, attachment: att });
      await A.loadConversation();
      A.loadContacts(true);
    } catch (e) {
      const back = $("chat-text"); if (back) back.value = text;
      state.chat.draft = text; state.chat.att = att;
      toast((e && e.error) || "发送失败"); render();
    }
  },
  async refreshUnread() {
    try {
      const u = await api("GET", "/chat/unread");
      const changed = u.total !== state.unread.total;
      state.unread = u;
      if (changed && document.querySelector(".tabbar")) render();
    } catch (e) { }
  },

  // ---------- 应用内通知 ----------
  async refreshNotifUnread() {
    try {
      const r = await api("GET", "/notifications/unread-count");
      const changed = r.total !== state.notifs.unread;
      state.notifs.unread = r.total;
      if (changed && document.querySelector(".tabbar")) render();
    } catch (e) { }
  },
  async loadNotifs() {
    try { state.notifs.list = await api("GET", "/notifications"); }
    catch (e) { state.notifs.list = []; }
    render();
  },
  toggleNotifPanel() {
    state.notifs.open = !state.notifs.open;
    render();
    if (state.notifs.open) A.loadNotifs();
  },
  closeNotifPanel() { state.notifs.open = false; render(); },
  // 标记已读并跳到订单（订单已删则留在原页）
  async openNotif(id, orderId) {
    state.notifs.open = false;
    const n = (state.notifs.list || []).find(x => x.id === id);
    if (n && !n.read) {
      n.read = true;
      state.notifs.unread = Math.max(0, state.notifs.unread - 1);
      try { await api("POST", `/notifications/${id}/read`); } catch (e) { }
    }
    if (orderId && state.orders.some(o => o.id === orderId)) go("detail", orderId);
    else { render(); if (orderId) toast("这张订单已经不在了"); }
  },
  async deleteNotif(id) {
    try {
      await api("DELETE", `/notifications/${id}`);
      const n = (state.notifs.list || []).find(x => x.id === id);
      if (n && !n.read) state.notifs.unread = Math.max(0, state.notifs.unread - 1);
      state.notifs.list = (state.notifs.list || []).filter(x => x.id !== id);
      render();
    } catch (e) { toast((e && e.error) || "删除失败"); }
  },
  clearReadNotifs() {
    confirmDanger("清空已读通知？", "只删除你自己已读过的通知，未读的会保留。", async () => {
      try {
        await api("DELETE", "/notifications?read=1");
        state.notifs.list = (state.notifs.list || []).filter(x => !x.read);
        render(); toast("已清空已读通知");
      } catch (e) { toast((e && e.error) || "操作失败"); }
    }, "清空");
  },
  async markAllNotifsRead() {
    try {
      await api("POST", "/notifications/read-all");
      state.notifs.unread = 0;
      (state.notifs.list || []).forEach(n => n.read = true);
      render(); toast("已全部标为已读");
    } catch (e) { toast((e && e.error) || "操作失败"); }
  },

  // 导出：先取一次性下载链接，交给浏览器下载。
  // 微信等内置浏览器给指引和可复制链接；iPhone 主屏 App 交给 Safari；其它直接下载
  async exportData() {
    if (!isAdmin()) return toast("仅管理员可导出");
    if (A.exportData.busy) return;
    const btn = $("exp-btn");
    A.exportData.busy = true;
    if (btn) { btn.disabled = true; btn.classList.add("is-busy"); }
    try {
      const season = ($("exp-season") || {}).value || "";
      const t = await api("POST", "/export/ticket", { season });
      if (!t.count) return toast(season ? `「${season}」下没有订单` : "还没有订单可导出");
      const url = new URL(t.url, location.href).href;
      if (inAppBrowser()) {
        modal({ title: "请在浏览器里下载", okText: "复制下载链接",
          body: "微信等 App 里打不开下载。可以点右上角「···」选「在浏览器打开」后重新导出；或者复制下面的链接，粘贴到手机浏览器里打开（5 分钟内有效，只能用一次）。",
          onOk: () => copyText(url).then(ok => toast(ok ? "链接已复制，去浏览器里粘贴打开" : "复制失败，请用浏览器打开本系统后再导出")) });
      } else if (isIosStandalone()) {
        modal({ title: `导出 ${t.count} 单已准备好`, okText: "用 Safari 下载",
          body: "点下面的按钮会打开 Safari 下载文件，下载好后在「文件」App 的「下载」里能找到。",
          onOk: () => window.open(url, "_blank") });
      } else {
        const a = document.createElement("a");
        a.href = url; a.download = t.filename; a.rel = "noopener";
        document.body.appendChild(a); a.click(); a.remove();
        toast(`开始下载 ${t.count} 单，照片多时文件较大，请留意浏览器的下载提示`);
      }
    } catch (e) { toast((e && e.error) || "导出失败"); }
    finally {
      A.exportData.busy = false;
      const b2 = $("exp-btn"); if (b2) { b2.disabled = false; b2.classList.remove("is-busy"); }
    }
  },

  // ---------- 批量导入 ----------
  async importFile(input) {
    const f = input.files && input.files[0]; input.value = "";  // 清空后同一文件可再次选择
    if (f) await A.importFileObj(f);
  },
  async importFileObj(f) {
    if (A.importFileObj.busy) return toast("正在识别上一个文件，请稍候");
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    if (!["xlsx", "xls", "csv", "txt"].includes(ext)) return toast("只支持 Excel(.xlsx/.xls) 或 CSV(.csv/.txt) 文件");
    A.syncFileName("imp-file", f.name);
    A.importFileObj.busy = true;
    const btn = document.querySelector(".imp-drop-btn"); if (btn) btn.disabled = true;
    try {
      // xlsx 在本地解析，不用上传整份文件
      if (ext === "xlsx") {
        try {
          await ensureXlsx("正在准备中，请稍候…");
          await A.importFileClientSide(f);
          return;
        } catch (e) { console.error("本地解析失败，退回服务器解析：", e); }
      }
      await A.importFileServerFallback(f);
    } finally { A.importFileObj.busy = false; const b2 = document.querySelector(".imp-drop-btn"); if (b2) b2.disabled = false; }
  },
  // 模板表头用当前字段名；第二张表写说明、示例和现有季节/员工
  async downloadImportTemplate() {
    if (inAppBrowser()) return toast("微信等 App 里无法下载文件，请用浏览器打开本系统后再下载模板");
    try {
      await ensureXlsx("正在生成模板…");
      const cols = importScalars();
      const head = ["季节", ...cols.map(f => f.label)];
      const names = tpl => state.users.filter(u => u.template === tpl).map(u => u.name);
      const later = new Date(Date.now() + 30 * 86400000), pad = x => String(x).padStart(2, "0");
      const sampleOf = f => f.k === "styleNo" ? "SS27-T001" : f.k === "styleName" ? "女装印花短袖T恤" : f.k === "qty" ? "1200"
        : f.type === "date" ? (f.k === "shipDate" ? "" : `${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())}`)
        : f.type === "user-sales" ? (names("sales")[0] || "") : f.type === "user-follower" ? (names("follower")[0] || "")
        : isMultiFactory(f) ? "工厂A、工厂B" : "";
      const help = [
        ["填写说明"],
        ["1. 在「订单」表里从第二行开始，一行一单；列的顺序可以随便调，用不到的列可以删掉。"],
        ["2. 货号和款式名至少填一个，其余都可以空着，导入后再补。"],
        ["3. 日期写成 2026-08-15 或 2026/8/15。发货日期一旦填写就会锁定，没发货前请留空。"],
        ["4. 业务员、下厂员填员工姓名，要跟下面名单里的字完全一样。"],
        ["5. 面料/绣花等可以有多个工厂的，用顿号「、」隔开。"],
        ["6. 款式图可以直接贴(插入图片)到对应那一行里，导入时会自动带上。"],
        [], ["示例："], head, [state.seasons[0] || "SS2027", ...cols.map(sampleOf)],
        [], ["现有季节", ...state.seasons], ["业务员", ...names("sales")], ["下厂员", ...names("follower")]
      ];
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([head]);
      ws["!cols"] = head.map(h => ({ wch: Math.max(10, String(h).length * 2 + 4) }));
      XLSX.utils.book_append_sheet(wb, ws, "订单");
      const hs = XLSX.utils.aoa_to_sheet(help); hs["!cols"] = [{ wch: 14 }, ...head.slice(1).map(() => ({ wch: 14 }))];
      XLSX.utils.book_append_sheet(wb, hs, "填写说明");
      XLSX.writeFile(wb, "订单导入模板.xlsx");
      toast("模板已开始下载");
    } catch (e) { toast("模板生成失败，请稍后再试"); }
  },
  // 本地解析文字，并抠出表格图片压缩后上传
  async importFileClientSide(f) {
    toast("正在本地解析文件…", true);
    const buf = await f.arrayBuffer();
    // type:"array" 必须传 Uint8Array
    const wb = XLSX.read(new Uint8Array(buf), { type: "array", cellDates: true, dateNF: "yyyy-mm-dd" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error("表格里没有内容");
    // WPS 声明的范围常比实际大，按实际数据收紧
    let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
    Object.keys(ws).forEach(addr => {
      if (addr[0] === "!") return;
      const c = XLSX.utils.decode_cell(addr);
      if (c.r < minR) minR = c.r; if (c.r > maxR) maxR = c.r;
      if (c.c < minC) minC = c.c; if (c.c > maxC) maxC = c.c;
    });
    const rawRows = minR === Infinity ? [] :
      XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "", range: { s: { r: minR, c: minC }, e: { r: maxR, c: maxC } } })
        .map(r => r.map(c => (c == null ? "" : String(c).trim())));
    const rows = []; const origToFiltered = {};
    rawRows.forEach((r, origIdx) => { if (r.some(c => c !== "")) { origToFiltered[origIdx] = rows.length; rows.push(r); } });
    if (rows.length < 2) throw new Error("至少需要表头和一行数据");

    toast("正在识别表格里的图片…", true);
    const found = await extractEmbeddedImagesClient(buf);
    const rowImages = {};
    // 图片并发 3 张上传
    const entries = Object.keys(found)
      .map(origRow => ({ filteredIdx: origToFiltered[origRow], img: found[origRow] }))
      .filter(e => e.filteredIdx !== undefined && e.img.data.length <= 8 * 1024 * 1024);
    if (entries.length) {
      let done = 0;
      toast(`正在上传图片…（0/${entries.length}）`, true);
      let next = 0;
      const worker = async () => {
        while (next < entries.length) {
          const { filteredIdx, img } = entries[next++];
          try {
            const mime = img.ext === "png" ? "image/png" : img.ext === "gif" ? "image/gif" : "image/jpeg";
            const url = await uploadOnePhoto(new Blob([img.data], { type: mime }));
            if (url) rowImages[filteredIdx] = url;
          } catch (e) { /* 单张图片传失败就跳过，不影响其它行的数据 */ }
          done++;
          toast(`正在上传图片…（${done}/${entries.length}）`, true);
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, entries.length) }, worker));
    }
    importRaw = "";
    toast("解析完成");
    A.showPreview(A.rowsToPreview(rows, rowImages), Object.keys(rowImages).length ? "，已自动识别表格里的款式图" : "");
  },
  // 本地解析失败时交给服务器
  async importFileServerFallback(f) {
    try {
      const fd = new FormData(); fd.append("file", f);
      const j = await xhrUpload("/api/import/parse", fd, { timeout: 180000, onProgress: p =>
        toast(p == null ? "正在上传文件，请稍候…" : p < 1 ? `正在上传文件… ${Math.round(p * 100)}%` : "上传完成，正在解析…", true) });
      importRaw = "";
      const gotImages = j.rowImages && Object.keys(j.rowImages).length;
      toast("解析完成");
      A.showPreview(A.rowsToPreview(j.rows, j.rowImages), (j.encoding === "GBK" ? "（已按 GBK 编码读取）" : "") + (gotImages ? "，已自动识别表格里的款式图" : ""));
    } catch (e) { toast((e && e.error) || "文件解析失败"); }
  },
  // 表头 -> 字段：认系统字段名和常见别名/旧表头
  importMap() {
    const m = {}, known = new Set(importScalars().map(f => f.k));
    importScalars().forEach(f => { m[normHeader(f.label)] = f.k; });
    const alias = {
      "货号": "styleNo", "款号": "styleNo", "款式编号": "styleNo", "款式名": "styleName", "款名": "styleName", "品名": "styleName",
      "款式": "style", "数量": "qty", "件数": "qty", "订单数量": "qty", "下单数量": "qty", "款式描述": "desc", "描述": "desc",
      "订单交期": "deadline", "交期": "deadline", "交货期": "deadline", "交货日期": "deadline", "货期": "deadline",
      "发货日期": "shipDate", "出货日期": "shipDate", "业务员": "sales", "业务": "sales", "下厂员": "follower", "跟单员": "follower",
      "季节": "_season", "订单季节": "_season", "季度": "_season",
      "服装工厂": "factory", "生产厂": "factory", "加工厂": "factory",  // 旧表头
      "面料工厂1": "fabricFactory1", "面料工厂2": "fabricFactory2", "面料工厂": "fabricFactory1", "面料厂": "fabricFactory1",
      "绣花工厂": "embFactory", "绣花厂": "embFactory", "印花工厂": "printFactory", "印花厂": "printFactory", "绣印工厂": "embFactory"
    };
    Object.keys(alias).forEach(h => {
      const k = normHeader(h);
      if (!m[k] && (alias[h] === "_season" || known.has(alias[h]))) m[k] = alias[h];
    });
    return m;
  },
  // 二维数组(首行表头) -> 待确认订单，warn 为需要用户确认的问题
  rowsToPreview(grid, rowImages) {
    const MAP = A.importMap();
    // 表头行：前 10 行里第一行含已知列名的
    let hi = 0;
    for (let i = 0; i < Math.min(grid.length, 10); i++) {
      if ((grid[i] || []).some(c => MAP[normHeader(c)])) { hi = i; break; }
    }
    const rawHeads = (grid[hi] || []).map(h => String(h == null ? "" : h).trim().replace(/^\uFEFF/, ""));
    const keys = rawHeads.map(h => MAP[normHeader(h)] || null);
    importUnknownCols = rawHeads.filter((h, j) => h && !keys[j]);
    const fieldOf = {}; importScalars().forEach(f => { fieldOf[f.k] = f; });
    const out = [];
    for (let i = hi + 1; i < grid.length; i++) {
      const cells = grid[i] || [];
      if (!cells.some(c => String(c == null ? "" : c).trim())) continue;
      const values = {}, warn = []; let season = "";
      keys.forEach((key, j) => {
        const v = String(cells[j] == null ? "" : cells[j]).trim();
        if (!v || !key) return;
        if (key === "_season") {
          season = v;
          if (!(state.seasons || []).includes(v)) warn.push(`季节「${v}」不在后台的季节列表里`);
          return;
        }
        const f = fieldOf[key];
        if (key === "sales" || key === "follower") {
          const u = state.users.find(x => x.name === v && x.template === key) || state.users.find(x => x.name === v);
          if (u) values[key] = u.id;
          else warn.push(`${f ? f.label : key}「${v}」不在员工名单里，请在下面手动选择`);
          return;
        }
        if (f && f.type === "date") {
          const d = normalizeImportDate(v);
          if (d) values[key] = d; else warn.push(`${f.label}「${v}」不是能识别的日期，请在下面手动选择`);
        } else if (f && isMultiFactory(f)) values[key] = v.split(/[,，、\/;；]/).map(x => x.trim()).filter(Boolean);
        else values[key] = v;
      });
      if (!values.styleNo && !values.styleName) continue;
      if (values.qty && !/^\d+(\.\d+)?$/.test(String(values.qty).replace(/[,，\s]/g, ""))) warn.push(`数量「${values.qty}」不是纯数字，合计数量时不会算进去`);
      if (!season) warn.push("没有填季节，请在下面选择（不选会归到「未分季」）");
      if (me().template === "sales" && !values.sales) values.sales = me().id;
      if (rowImages && rowImages[i]) values.img = [rowImages[i]];  // 表格里嵌的款式图
      out.push({ season, values, warn });
    }
    // 重复检查：表格内重复，或系统里已有同货号(季节都有时要相同)；只能比对自己看得到的订单
    const keyOf = r => String(r.values.styleNo || "").trim().toUpperCase();
    const cnt = {}; out.forEach(r => { const k = keyOf(r); if (k) cnt[k] = (cnt[k] || 0) + 1; });
    out.forEach(r => {
      const k = keyOf(r); if (!k) return;
      if (cnt[k] > 1) r.warn.push(`货号 ${r.values.styleNo} 在表格里出现了 ${cnt[k]} 次`);
      const ex = state.orders.find(o => String(o.values.styleNo || "").trim().toUpperCase() === k && (!r.season || !o.season || o.season === r.season));
      if (ex) r.warn.push(`系统里已经有货号 ${r.values.styleNo} 的订单${ex.season ? `（${ex.season}）` : ""}，可能是重复导入`);
    });
    return out;
  },
  showPreview(rows, extra) {
    if (!rows.length) return toast("未识别到有效数据，请检查表头列名");
    importPreview = rows; A.resyncImportPhotoDrafts(); render();
    const w = rows.filter(r => r.warn && r.warn.length).length;
    toast(`识别到 ${rows.length} 单${extra || ""}${w ? `，其中 ${w} 单需要确认` : ""}，请在下方核对后导入`);
    const first = document.querySelector(".imp-summary"); if (first && first.scrollIntoView) first.scrollIntoView({ behavior: "smooth", block: "start" });
  },
  // 按当前行号重建每行的款式图草稿
  resyncImportPhotoDrafts() {
    clearImportPhotoDrafts();
    (importPreview || []).forEach((r, i) => { photoDraft["imp" + i + "-img"] = normalizePhotos(r.values.img); });
  },
  importText() {
    const raw = ($("imp-text").value || "").trim();
    importRaw = raw;
    if (!raw) return toast("请先粘贴表格内容或选择文件");
    const lines = raw.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return toast("至少需要表头和一行数据");
    const sep = lines[0].includes("\t") ? "\t" : ",";
    const split = l => {
      if (sep === "\t") return l.split("\t");
      const out = []; let cur = "", q = false;
      for (let i = 0; i < l.length; i++) {
        const c = l[i];
        if (q) { if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
        else if (c === '"') q = true;
        else if (c === ",") { out.push(cur); cur = ""; }
        else cur += c;
      }
      out.push(cur); return out;
    };
    A.showPreview(A.rowsToPreview(lines.map(split)));
  },
  syncImportInputs() {
    if (!importPreview) return;
    const scal = importScalars();
    importPreview.forEach((r, i) => {
      const se = $("imp" + i + "-season"); if (se) r.season = se.value || "";
      const img = photoDraft["imp" + i + "-img"];
      if (img && img.length) r.values.img = img.slice(); else delete r.values.img;
      scal.forEach(f => {
        const el = $("imp" + i + "-" + f.k); if (!el) return;
        if (isMultiFactory(f)) {
          let arr = []; try { arr = JSON.parse(el.value || "[]"); } catch (e) { }
          if (arr.length) r.values[f.k] = arr; else delete r.values[f.k];
          return;
        }
        const v = (el.value || "").trim(); if (v) r.values[f.k] = v; else delete r.values[f.k];
      });
    });
  },
  removeImportRow(i) {
    // 照片没传完不能删行，否则行号错位串图
    if (photosBlocked(/^imp\d+-img$/)) return;
    A.syncImportInputs(); if (!importPreview) return;
    importPreview.splice(i, 1); if (!importPreview.length) importPreview = null;
    A.resyncImportPhotoDrafts();
    render();
  },
  cancelImport() {
    importPreview = null;
    clearImportPhotoDrafts();
    render(); toast("已取消，未导入任何数据");
  },
  async confirmImport() {
    if (!importPreview || !importPreview.length) return;
    if (photosBlocked(/^imp\d+-img$/)) return;
    A.syncImportInputs();
    const built = importPreview.filter(r => r.values.styleNo || r.values.styleName)
      .map(r => ({ season: r.season || "未分季", values: r.values }));
    if (!built.length) return toast("每一单请至少填写货号或款式名");
    if (built.length > 500) return toast("一次最多导入 500 单，请把表格拆开分批导入");
    // 按修改后的值再查一次重复，有重复先确认
    const dup = built.filter(r => r.values.styleNo && state.orders.some(o =>
      String(o.values.styleNo || "").trim().toUpperCase() === String(r.values.styleNo).trim().toUpperCase() && o.season === r.season)).length;
    if (dup && !A.confirmImport.forced) {
      return modal({ title: `有 ${dup} 单可能重复`, okText: "仍然全部导入",
        body: `这 ${dup} 单的货号和季节跟系统里已有的订单一样，可能是同一份表导入了两次。可以先取消、在预览里把重复的移除。`,
        onOk: () => { A.confirmImport.forced = true; A.confirmImport().finally(() => { A.confirmImport.forced = false; }); } });
    }
    try {
      const r = await api("POST", "/orders/import", { orders: built });
      importPreview = null; importRaw = "";
      clearImportPhotoDrafts();
      await refresh(); go("orders"); toast(`成功导入 ${r.imported} 个订单`);
    } catch (e) { toast((e && e.error) || "导入失败"); }
  }
};

// ================= 下拉刷新 =================
// 页面顶部下拉刷新数据；单聊、大图、弹窗打开时不生效
(function setupPullRefresh() {
  const THRESHOLD = 62;
  let startY = null, dragging = false, dist = 0, refreshing = false;
  const canPull = () => !refreshing && me() && !modalState && !lightbox
    && !(route.v === "chat" && state.chat.activeId) && window.scrollY === 0;
  document.addEventListener("touchstart", (e) => {
    if (!canPull()) { startY = null; return; }
    startY = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (startY == null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || window.scrollY > 0) return;
    dragging = true; dist = dy;
  }, { passive: true });
  document.addEventListener("touchend", async () => {
    if (!dragging) { startY = null; return; }
    dragging = false; startY = null;
    if (dist < THRESHOLD) return;
    refreshing = true;
    try { await refresh(); render(); toast("已刷新"); } catch (e) { }
    refreshing = false;
  });
})();

// ================= 拖放 / 粘贴（电脑） =================
// 图片拖进或粘贴到照片框(粘贴进最近点过的那个)；表格文件拖到导入区
(function setupPhotoDropPaste() {
  let lastCtx = null;
  const gridOf = t => t && t.closest ? t.closest(".photos-grid[data-ctx]") : null;
  const impOf = t => t && t.closest ? t.closest('[data-drop="import"]') : null;
  document.addEventListener("pointerdown", e => { const g = gridOf(e.target); if (g) lastCtx = g.dataset.ctx; }, true);
  document.addEventListener("dragover", e => {
    e.preventDefault();  // 阻止浏览器直接打开拖进来的文件
    const g = gridOf(e.target) || impOf(e.target); if (g) g.classList.add("drop");
  });
  document.addEventListener("dragleave", e => { const g = gridOf(e.target) || impOf(e.target); if (g && !g.contains(e.relatedTarget)) g.classList.remove("drop"); });
  document.addEventListener("drop", e => {
    e.preventDefault();
    const g = gridOf(e.target), imp = impOf(e.target);
    document.querySelectorAll(".photos-grid.drop, .imp-drop.drop").forEach(x => x.classList.remove("drop"));
    const files = e.dataTransfer ? [...e.dataTransfer.files] : [];
    if (g) { lastCtx = g.dataset.ctx; A.queuePhotos(g.dataset.ctx, files); }
    else if (imp && files[0]) A.importFileObj(files[0]);
  });
  document.addEventListener("paste", e => {
    const files = [...((e.clipboardData && e.clipboardData.files) || [])].filter(looksLikeImage);
    if (!files.length) return;
    const grids = [...document.querySelectorAll(".photos-grid[data-ctx]")].filter(g => g.offsetParent);
    const g = grids.find(x => x.dataset.ctx === lastCtx) || (grids.length === 1 ? grids[0] : null);
    if (!g) return;
    e.preventDefault(); A.queuePhotos(g.dataset.ctx, files);
  });
})();

// ================= 启动 =================
window.go = go; window.A = A;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); deferredInstall = e;  // 等用户点「安装到手机」再弹
  if (state.me || !$("app").innerHTML) { /* 下次渲染时按钮自然出现 */ }
});
window.addEventListener("appinstalled", () => { deferredInstall = null; toast("已添加到手机主屏"); });

// 从系统通知进来(?order= / ?chat=)时直接跳转，并清掉参数
function openFromPush() {
  try {
    const q = new URLSearchParams(location.search);
    const order = q.get("order"), chat = q.get("chat");
    if (!order && !chat) return;
    history.replaceState(null, "", location.pathname);
    if (order) go("detail", order);
    else if (chat) { go("chat"); A.openChat(chat); }
  } catch (e) {}
}

(async function boot() {
  // 已登录时先展示欢迎界面(index.html 里有静态的一份)，数据回来前不露出空页面
  if (state.token) {
    loadStateCache();  // 先用缓存数据填上
    showWelcome = true; render();
    const refreshP = refresh().catch(e => { state.token = null; localStorage.removeItem("daka_token"); showWelcome = false; });
    // 欢迎界面至少 1.5 秒，跟网络请求并行
    await Promise.all([refreshP, new Promise(r => setTimeout(r, 1500))]);
  }
  render();
  if (showWelcome) A.dismissWelcome();
  if (state.me) { A.refreshUnread(); A.refreshNotifUnread(); A.loadContacts(true); openFromPush(); }
  setInterval(() => { if (state.me) { A.refreshUnread(); A.refreshNotifUnread(); } }, 10000);
  setInterval(() => {
    if (!state.me) return;
    if (route.v === "chat") { if (state.chat.activeId) A.loadConversation(); else A.loadContacts(); }
  }, 4000);
})();
