"use strict";
/**
 * 前端：单页应用，数据全部来自服务端（多人多设备看到同一份）。
 * 交互取向：移动优先，底部 Tab 栏 + 顶部标题栏；宽屏时 Tab 栏自动移到顶部。
 * 权限在服务端强制校验，这里只负责隐藏没权限的入口。
 */

/* ================= 状态 ================= */
let state = {
  token: localStorage.getItem("daka_token") || null,
  me: null, users: [], fields: { order: [], production: [] },
  factories: { emb: [], prod: [], proc: [] }, orders: [], roles: [], seasons: [],
  chat: { contacts: [], activeId: null, contact: null, messages: [], draft: "", att: null },
  unread: { total: 0, byUser: {} },
  myLogs: null, feedback: null, myFeedback: null
};
let route = { v: "orders", id: null };
let editingBasic = false, importPreview = null, importRaw = "";
let showWelcome = false;   // 登录成功后短暂展示的欢迎界面（logo/公司名称/跟单系统）
const expandedLogGroups = new Set();   // 打卡记录里手动点开"展开全部"的订单(orderId)
let filt = { season: "", sales: "", follower: "", kw: "", factoryKw: "" };
let modalState = null;
let deferredInstall = null;   // 安卓/桌面 Chrome 的原生安装事件
// 是否已经是「装到主屏后打开」的状态
// 是不是手机/平板（触屏移动设备）——电脑上不显示"安装到手机"
const isMobileDevice = () => /iPhone|iPad|iPod|Android|Mobile|HarmonyOS/i.test(navigator.userAgent || "")
  || (navigator.maxTouchPoints > 1 && window.matchMedia && window.matchMedia("(pointer:coarse)").matches);
const isStandalone = () => (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
  || window.navigator.standalone === true;

/* ================= 工具 ================= */
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// 时间：今年省略年份 ——「7月20日 17:51」；跨年「2025年7月20日 17:51」
function fmtT(t) {
  const d = new Date(t), p = n => String(n).padStart(2, "0");
  const y = d.getFullYear() === new Date().getFullYear() ? "" : d.getFullYear() + "年";
  return `${y}${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 今天，按本地时区取（toISOString 是 UTC，中国上午 8 点前会算成前一天）
function todayStr() {
  const d = new Date(), p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// 导入表格里的日期五花八门(2026/8/15、2026年8月15日…)，统一成 input[type=date] 认得的 yyyy-mm-dd，
// 不然日期字段的值会在导入预览里显示成空白，确认导入时又被当作"没填"悄悄丢掉
function normalizeImportDate(s) {
  s = String(s || "").trim();
  if (!s || /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{4})[\/\-年.](\d{1,2})[\/\-月.](\d{1,2})日?$/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
  return s;
}
// 日期字符串 2026-08-15 -> 2026年8月15日
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
    <defs>
      <linearGradient id="lg-bg" x1="60" y1="30" x2="440" y2="490" gradientUnits="userSpaceOnUse">
        <stop stop-color="#4C97DC"/><stop offset=".55" stop-color="#1E63AE"/><stop offset="1" stop-color="#10386C"/>
      </linearGradient>
      <linearGradient id="lg-gloss" x1="90" y1="60" x2="300" y2="300" gradientUnits="userSpaceOnUse">
        <stop stop-color="#FFFFFF" stop-opacity=".26"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect width="512" height="512" rx="116" fill="url(#lg-bg)"/>
    <path d="M116 0h280a116 116 0 0 1 116 116v70C420 96 300 40 176 40 152 40 128 42 106 46A116 116 0 0 1 116 0Z" fill="url(#lg-gloss)"/>
    <path d="M108 274 L206 372 L344 150" stroke="#FFFFFF" stroke-width="42" stroke-linecap="round"
          stroke-linejoin="round" stroke-dasharray="66 46" opacity=".97"/>
    <path d="M336 164 L424 76" stroke="#FFFFFF" stroke-width="24" stroke-linecap="round"/>
    <ellipse cx="434" cy="66" rx="27" ry="17" transform="rotate(-45 434 66)" fill="none" stroke="#FFFFFF" stroke-width="15"/>
  </svg>`;

/* ================= API ================= */
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
// 本地缓存上一次的订单/用户/字段等数据：下次打开先用它瞬间显示，不用干等网络，
// 后台悄悄刷新到最新——跟账号 token 绑定，换账号/退出登录就失效，不会串到别人的数据
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
async function run(fn, okMsg) {
  try { await fn(); await refresh(); render(); if (okMsg) toast(okMsg); }
  catch (e) { toast((e && e.error) || "操作失败"); }
}

/* ================= 权限（仅用于显示控制） ================= */
// 按职位的权限模板：管理员什么都能做；主管(技术主管/业务主管等)能管所有订单；
// 业务员只能管自己创建/负责的订单；下厂员只能管自己被指派负责的订单。
// 发货日期一旦填写，除管理员外任何人(包括主管)都不能再改这单任何内容。
function isSupervisor() { const u = me(); return !!u && u.template === "supervisor"; }
function isOwnBySales(o) {
  const u = me(); if (!u || !o) return false;
  return o.values.sales === u.id || o.createdBy === u.id;
}
function isOwnByFollower(o) {
  const u = me(); if (!u || !o) return false;
  return o.values.follower === u.id;
}
function shipLocked(o) { return !!(o && o.values && o.values.shipDate); }
function canEditBasic(o) {
  const u = me(); if (!u) return false;
  if (isAdmin()) return true;
  if (shipLocked(o)) return false;
  if (isSupervisor()) return true;
  if (u.template === "sales") return isOwnBySales(o);
  if (u.template === "follower") return isOwnByFollower(o);
  return false;
}
function canAddLog(o, section) {
  const u = me(); if (!u) return false;
  if (isAdmin()) return true;
  if (shipLocked(o)) return false;
  if (isSupervisor()) return true;
  if (u.template === "sales") return isOwnBySales(o);
  if (u.template === "follower") return isOwnByFollower(o);
  return false;
}
const canTouchEntry = (o, e) => {
  const u = me(); if (!u) return false;
  if (isAdmin()) return true;
  if (shipLocked(o)) return false;
  if (isSupervisor()) return true;
  if (e && e.by === u.id) return true;
  if (u.template === "sales") return isOwnBySales(o);
  if (u.template === "follower") return isOwnByFollower(o);
  return false;
};
const canWriteInspProblem = (o) => canAddLog(o);
const canWriteInspFix = (o) => canAddLog(o);

/* ================= 字段与下拉 ================= */
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
function fieldInput(f, val, prefix) {
  prefix = prefix || "nf-";
  const id = prefix + f.k;
  if (isMultiFactory(f)) return factoryMultiHtml(f, val, id);
  const opts = optionsFor(f);
  if (opts) {
    // 工厂类下拉：就算这个值不在管理员定义的列表里(比如导入进来的)，也要保留显示出来，不能悄悄丢掉
    const isFactory = f.type === "factory-prod";
    const extra = (isFactory && val && !opts.some(([v]) => v === val)) ? [[val, val]] : [];
    return `<select class="in" id="${id}"><option value="">请选择</option>${[...extra, ...opts].map(([v, t]) =>
      `<option value="${esc(v)}" ${v === val ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
  }
  if (f.type === "textarea") return `<textarea class="in" id="${id}">${esc(val || "")}</textarea>`;
  if (f.type === "date") return dateFieldHtml(id, val);
  if (f.type === "number") return `<input class="in" type="number" id="${id}" value="${esc(val || "")}">`;
  if (f.type === "image") return photoPicker("img");
  return `<input class="in" id="${id}" value="${esc(val || "")}">`;
}
const fieldRow = (f, val, prefix) => `<label class="field"><span>${esc(f.label)}</span>${fieldInput(f, val, prefix)}</label>`;

// 面料工厂/绣印工厂：同一款可能要挂多个供应商，用标签+下拉添加，而不是单选
function factoryMultiHtml(f, val, id) {
  const opts = optionsFor(f) || [];
  // 值不在管理员定义的列表里(比如老数据、导入进来的)也保留，不悄悄丢掉
  const arr = Array.isArray(val) ? val.slice() : (val ? [val] : []);
  const remaining = opts.filter(([v]) => !arr.includes(v));
  return `<div class="multifactory" data-id="${id}">
    <div class="multifactory-chips">${arr.length ? arr.map(v => `<span class="tag role">${esc(v)}
      <a href="javascript:void(0)" onclick="A.removeFactoryChip('${id}','${encodeURIComponent(v)}')" style="margin-left:4px">✕</a></span>`).join("")
      : `<span class="row-sub">未选择</span>`}</div>
    ${remaining.length ? `<div style="display:flex;gap:8px;margin-top:8px">
      <select class="in" id="${id}--add"><option value="">选择要添加的工厂</option>${remaining.map(([v, t]) =>
        `<option value="${esc(v)}">${esc(t)}</option>`).join("")}</select>
      <button type="button" class="btn mini ghost" onclick="A.addFactoryChip('${id}')">添加</button></div>` : ""}
    <input type="hidden" id="${id}" value='${esc(JSON.stringify(arr))}'></div>`;
}

// 日期：真正的 input[type=date] 透明地盖满整个按钮区域直接接收点击/触摸(不靠 JS 模拟点击，
// 部分手机浏览器不支持 showPicker() 会导致点了没反应)，下面露出显示「2026年8月15日」的中文按钮
function dateFieldHtml(id, val, extraOnChange) {
  return `<div class="datefield">
    <button type="button" class="in date-btn ${val ? "" : "empty"}" id="${id}--label" tabindex="-1"
      >${val ? esc(fmtDate(val)) : "选择日期"}</button>
    <input type="date" id="${id}" class="date-native" value="${esc(val || "")}"
      onchange="${extraOnChange ? extraOnChange + ";" : ""}A.syncDateLabel('${id}')" onclick="A.openDate(this)" onfocus="A.openDate(this)"></div>`;
}
// 文件选择：隐藏原生控件（它显示英文 Choose File），用中文按钮代替
function fileFieldHtml(id, accept, onchange, pickText) {
  return `<div class="filefield">
    <input type="file" id="${id}" class="file-native" accept="${accept}" onchange="${onchange}">
    <button type="button" class="in file-btn" onclick="document.getElementById('${id}').click()">
      <span class="file-name" id="${id}--name">未选择文件</span>
      <span class="file-pick">${esc(pickText || "选择文件")}</span></button></div>`;
}

// 季节列表由管理员在后台维护(state.seasons)；订单里实际用到、但已被管理员删掉的季节仍要能显示，不能让老订单"消失"
function seasonOptions(cur) {
  const list = (state.seasons || []).slice();
  state.orders.forEach(o => { if (o.season && !list.includes(o.season)) list.unshift(o.season); });
  if (cur && !list.includes(cur)) list.unshift(cur);
  return list;
}
function seasonSelectHtml(cur, prefix) {
  return `<select class="in" id="${(prefix || "nf-")}season"><option value="">请选择季节</option>${
    seasonOptions(cur).map(s => `<option ${s === cur ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>`;
}

/* ================= 弹窗 ================= */
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

/* ================= 照片：压缩 / 多图上传 / 选择器 / 大图查看 ================= */
let photoDraft = {};          // { 上下文key: [url,...] } 表单里正在编辑的照片
let lightbox = null;          // 大图查看器状态

function normalizePhotos(v) {
  if (Array.isArray(v)) return v.filter(x => typeof x === "string" && x);
  if (typeof v === "string" && v) return [v];
  return [];
}
// 上传前压缩：长边 ≤1600，JPEG 0.82，把手机几 MB 的照片压到几百 KB
function compressImage(file) {
  return new Promise((resolve) => {
    if (!file || !/^image\//.test(file.type)) return resolve(null);
    const rd = new FileReader();
    rd.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 2000, scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        c.toBlob(b => resolve(b || file), "image/jpeg", 0.85);
      };
      img.onerror = () => resolve(file);
      img.src = rd.result;
    };
    rd.onerror = () => resolve(file);
    rd.readAsDataURL(file);
  });
}
async function uploadOnePhoto(file) {
  const blob = await compressImage(file);
  if (!blob) return null;
  const fd = new FormData(); fd.append("image", blob, "photo.jpg");
  // fetch 本身不会超时，网络卡住时一次请求可能挂很久——加个15秒上限，
  // 这样失败重试的时候不会跟着挂两倍的时间，网络正常时完全不影响(照常很快成功)
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  let r;
  try {
    r = await fetch("/api/upload", { method: "POST", headers: { Authorization: "Bearer " + state.token }, body: fd, signal: ac.signal });
  } catch (e) {
    if (e && e.name === "AbortError") throw { error: "上传超时，网络太慢" };
    throw e;
  } finally { clearTimeout(timer); }
  const j = await r.json(); if (!r.ok) throw j;
  return j.url;
}
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src; s.onload = () => resolve(); s.onerror = () => reject(new Error("组件加载失败"));
    document.head.appendChild(s);
  });
}
// 浏览器本地读 zip 包里的几个指定文件(只读，不装额外的库)：
// 只支持 STORED(不压缩)和 DEFLATE(用浏览器原生 DecompressionStream 解压)，
// 遇到不支持的情况直接跳过该文件，让调用方决定要不要退回服务端解析，绝不会让用户没感知地拿到错误结果
async function zipReadEntries(buf, wantNames) {
  const dv = new DataView(buf), bytes = new Uint8Array(buf);
  let eocd = -1;
  const back = Math.min(bytes.length, 65557); // EOCD固定22字节 + 最长65535字节注释
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
    // 其它压缩方式(极少见)不支持，跳过这个文件
  }
  return result;
}
// 从 xlsx 里抠出直接贴的图片(比如款式图)，按锚定的行号(0-based，跟表头一起算)配对——
// 浏览器本地版，逻辑跟服务端 extractEmbeddedImages 完全对应，解析失败就返回已抠到的部分，不影响正常的表格文字导入
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
// 缩略图（editable 时带删除叉）
function photoThumbs(urls, editable, ctx) {
  return urls.map((u, i) => `<div class="ph-thumb">
    <img src="${esc(u)}" data-gallery='${JSON.stringify(urls)}' data-i="${i}" onclick="A.lightboxFromEl(this)">
    ${editable ? `<span class="ph-x" onclick="A.removeDraftPhoto('${ctx}',${i})">✕</span>` : ""}</div>`).join("");
}
// 拍照和相册拆成两个独立入口：部分手机(尤其华为)系统选择器在 <input multiple> 上会隐藏"拍照"选项
// (一次拍照只能出一张图，跟多选语义冲突)，只拆开两个按钮才能保证两条路都能用
function pickerInner(ctx) {
  const list = photoDraft[ctx] || [];
  return photoThumbs(list, true, ctx) +
    `<label class="ph-add"><input type="file" accept="image/*" capture="environment" style="display:none" onchange="A.addDraftPhotos('${ctx}',this)">
      <span class="ph-plus">📷</span><span>拍照</span></label>` +
    `<label class="ph-add"><input type="file" accept="image/*" multiple style="display:none" onchange="A.addDraftPhotos('${ctx}',this)">
      <span class="ph-plus">＋</span><span>相册</span></label>`;
}
function photoPicker(ctx) { return `<div class="photos-grid" id="pe-${ctx}">${pickerInner(ctx)}</div>`; }
function photoGallery(urls) {
  urls = normalizePhotos(urls);
  if (!urls.length) return "";
  return `<div class="photos-grid ro">${photoThumbs(urls, false)}</div>`;
}
// 给大图加双指缩放 + 拖动 + 双击（页面本身仍锁定缩放，这里单独放开）
function attachLightboxGestures(img) {
  let scale = 1, tx = 0, ty = 0, mode = null;
  let startDist = 0, startScale = 1, startX = 0, startY = 0, startTx = 0, startTy = 0, lastTap = 0;
  const apply = () => { img.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; };
  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  img.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) {
      mode = "pinch"; startDist = dist(e.touches); startScale = scale; startTx = tx; startTy = ty; e.preventDefault();
    } else if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTap < 300) {              // 双击：放大 / 还原
        if (scale > 1) { scale = 1; tx = 0; ty = 0; } else { scale = 2.5; }
        apply(); e.preventDefault();
      } else if (scale > 1) {                 // 放大后单指拖动
        mode = "pan"; startX = e.touches[0].clientX; startY = e.touches[0].clientY; startTx = tx; startTy = ty;
      }
      lastTap = now;
    }
  }, { passive: false });
  img.addEventListener("touchmove", (e) => {
    if (mode === "pinch" && e.touches.length === 2) {
      scale = Math.min(5, Math.max(1, startScale * dist(e.touches) / startDist)); apply(); e.preventDefault();
    } else if (mode === "pan" && e.touches.length === 1 && scale > 1) {
      tx = startTx + (e.touches[0].clientX - startX); ty = startTy + (e.touches[0].clientY - startY); apply(); e.preventDefault();
    }
  }, { passive: false });
  img.addEventListener("touchend", () => { if (scale <= 1) { scale = 1; tx = 0; ty = 0; apply(); } mode = null; });
}
function renderLightbox() {
  let el = document.getElementById("lightbox");
  if (!lightbox) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement("div"); el.id = "lightbox"; el.className = "lightbox"; document.body.appendChild(el); }
  const { photos, i } = lightbox;
  el.innerHTML = `<div class="lb-bar"><span class="lb-count num">${i + 1} / ${photos.length}</span>
      <button class="lb-close" onclick="A.closeLightbox()">✕</button></div>
    <img class="lb-img" src="${esc(photos[i])}" alt="照片">
    ${photos.length > 1 ? `<button class="lb-nav prev" onclick="event.stopPropagation();A.lbStep(-1)">‹</button>
      <button class="lb-nav next" onclick="event.stopPropagation();A.lbStep(1)">›</button>` : ""}`;
  // 只有点黑色背景才关闭；点图片是为了缩放，不关
  el.onclick = (e) => { if (e.target === el) A.closeLightbox(); };
  const img = el.querySelector(".lb-img");
  if (img) attachLightboxGestures(img);
}

/* ================= 路由 ================= */
function go(v, id) {
  route = { v, id: id || null }; editingBasic = false;
  photoDraft = {}; lightbox = null;
  if (v !== "chat") { state.chat.activeId = null; state.chat.messages = []; state.chat.draft = ""; state.chat.att = null; }
  render(); window.scrollTo(0, 0);
  if (v === "account") { A.loadMyLogs(state.me.id); A.loadMyFeedback(); }
  if (v === "staffLogs" && id) A.loadMyLogs(id);
  if (v === "admin") A.loadFeedback();
  if (v === "chat") { A.loadContacts(); A.refreshUnread(); }
}

/* 每个页面的标题栏配置 */
function pageMeta() {
  const back = (label, fn) => `<button class="nav-btn" onclick="${fn}">‹ ${esc(label)}</button>`;
  switch (route.v) {
    case "orders": return { title: "订单",
      right: canCreateOrder() ? `<button class="nav-btn plus" title="新建订单" onclick="go('new')">＋</button>` : "" };
    case "new": return { title: "新建订单", left: back("订单", "go('orders')") };
    case "detail": return { title: "订单详情", left: back("订单", "go('orders')") };
    case "chat": return state.chat.activeId
      ? { title: (state.chat.contact && state.chat.contact.name) || "聊天", left: back("聊天", "A.closeChat()") }
      : { title: "聊天" };
    case "admin": return { title: "管理后台" };
    case "account": return { title: "我的" };
    case "staffLogs": {
      const u = userById(route.id);
      return { title: (u ? u.name : "") + "的打卡", left: back("管理", "go('admin')") };
    }
    default: return { title: "订单" };
  }
}
const ICONS = {
  orders: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8a2 2 0 0 1 2 2v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6a2 2 0 0 1 2-2z"/><path d="M9 3h6v3H9z"/><path d="M9.5 11h5M9.5 15h5"/></svg>`,
  chat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a7.5 7.5 0 0 1-7.5 7.5c-1.2 0-2.3-.25-3.3-.7L4.5 20l1.3-4.2A7.4 7.4 0 0 1 5 12a7.5 7.5 0 0 1 15 0z"/></svg>`,
  admin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 14a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V20a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H4a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H10a1.6 1.6 0 0 0 1-1.5V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V10a1.6 1.6 0 0 0 1.5 1H20a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg>`,
  account: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/></svg>`
};
function tabbarHtml() {
  const m = me();
  const tabs = [["orders", "订单", ICONS.orders], ["chat", "聊天", ICONS.chat]];
  if (m.template === "admin") tabs.push(["admin", "管理", ICONS.admin]);
  tabs.push(["account", "我的", ICONS.account]);
  const activeTab = route.v === "new" || route.v === "detail" ? "orders"
    : route.v === "staffLogs" ? "admin" : route.v;
  return `<nav class="tabbar">${tabs.map(([v, label, icon]) => `
    <button class="tab ${activeTab === v ? "on" : ""}" data-tab="${v}" onclick="go('${v}')">
      <span class="ti">${icon}${v === "chat" && state.unread.total
        ? `<span class="badge">${state.unread.total > 99 ? "99+" : state.unread.total}</span>` : ""}</span>
      <span>${label}</span></button>`).join("")}</nav>`;
}

function render() {
  const app = $("app");
  // 欢迎界面不依赖 me() 是否已加载完成，这样能在接口返回前就先顶上，不留空白
  if (showWelcome) { app.innerHTML = vWelcome(); return; }
  if (!me()) { app.innerHTML = vLogin(); return; }
  const meta = pageMeta();
  const views = { orders: vOrders, new: vNew, detail: vDetail, chat: vChat,
    admin: vAdmin, account: vAccount, staffLogs: vStaffLogs };
  app.innerHTML = `
    ${route.v === "orders" ? `<div class="home-brand"><div class="co">${esc(COMPANY_NAME)}</div><div class="app">${esc(APP_NAME)}</div></div>` : ""}
    <header class="navbar"><div class="navbar-in">
      <div class="nav-slot">${meta.left || ""}</div>
      <h1 class="nav-title">${esc(meta.title)}</h1>
      <div class="nav-slot right">${meta.right || ""}</div>
    </div></header>
    ${tabbarHtml()}
    <main class="page${route.v === "chat" && state.chat.activeId ? " chat-full" : ""}" data-view="${route.v}">${
      (views[route.v] || vOrders)()}</main>`;
}

/* ---------- 登录 ---------- */
function vLogin() {
  return `<div class="login-page"><div class="login-inner">
    <div class="login-brand">
      <div class="login-logo">${APP_LOGO}</div>
      <p class="login-company">${esc(COMPANY_NAME)}</p>
      <h1 class="login-title">${esc(APP_NAME)}</h1>
    </div>
    <div class="login-card">
      <label class="lg-field"><span>手机号</span>
        <input id="lg-phone" inputmode="tel" autocomplete="username" placeholder="请输入手机号"></label>
      <label class="lg-field"><span>密码</span>
        <input id="lg-pass" type="password" autocomplete="current-password" placeholder="请输入密码"
          onkeydown="if(event.key==='Enter')A.login()"></label>
    </div>
    <button class="btn block login-btn" onclick="A.login()">登 录</button>
    ${(isStandalone() || !isMobileDevice()) ? "" : `<button class="btn ghost block install-cta" onclick="A.install()">📲 安装到手机（像 App 一样用）</button>`}
  </div></div>`;
}

/* ---------- 登录成功后的欢迎界面：logo / 公司名称 / 跟单系统 ---------- */
function vWelcome() {
  return `<div class="login-page" onclick="A.dismissWelcome()">
    <div class="login-inner">
      <div class="login-brand">
        <div class="login-logo">${APP_LOGO}</div>
        <p class="login-company">${esc(COMPANY_NAME)}</p>
        <h1 class="login-title">${esc(APP_NAME)}</h1>
      </div>
    </div></div>`;
}

/* ---------- 订单列表 ---------- */
function latestLog(o) {
  let best = null;
  const all = [...state.fields.order, ...state.fields.production].filter(f => f.type === "log");
  for (const f of all) for (const e of (o.logs[f.k] || [])) if (!best || e.t > best.t) best = { ...e, fieldLabel: f.label };
  for (const s of (o.subs || [])) for (const e of s.log) if (!best || e.t > best.t) best = { ...e, fieldLabel: s.name };
  return best;
}
function vOrders() {
  const factoriesOf = o => [o.values.factory, o.values.fabricFactory1, o.values.fabricFactory2, o.values.embFactory, o.values.printFactory].flat().filter(Boolean);
  const list = state.orders.filter(o =>
    (!filt.season || o.season === filt.season) &&
    (!filt.sales || o.values.sales === filt.sales) &&
    (!filt.follower || o.values.follower === filt.follower) &&
    (!filt.kw || [o.values.styleNo, o.values.styleName, o.values.style]
      .join(" ").toLowerCase().includes(filt.kw.toLowerCase())) &&
    (!filt.factoryKw || factoriesOf(o).includes(filt.factoryKw))
  ).slice().sort((a, b) => b.createdAt - a.createdAt);
  const opt = (arr, cur) => arr.map(([v, t]) =>
    `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(t)}</option>`).join("");
  const allFactories = [...new Set([...state.factories.prod, ...state.factories.fabric, ...state.factories.emb])];
  return `<section class="group">
    <div class="card"><div class="filters">
      <select class="in" onchange="A.setF('season',this.value)"><option value="">全部季节</option>${opt(seasonOptions("").map(s => [s, s]), filt.season)}</select>
      <select class="in" onchange="A.setF('sales',this.value)"><option value="">全部业务员</option>${opt(state.users.filter(u => u.template === "sales").map(u => [u.id, u.name]), filt.sales)}</select>
      <select class="in" onchange="A.setF('follower',this.value)"><option value="">全部下厂员</option>${opt(state.users.filter(u => u.template === "follower").map(u => [u.id, u.name]), filt.follower)}</select>
      <input class="in" id="flt-kw" placeholder="搜货号 / 款式名" value="${esc(filt.kw)}" oninput="A.setFKw(this.value)">
      <select class="in" onchange="A.setF('factoryKw',this.value)"><option value="">全部工厂</option>${opt(allFactories.map(x => [x, x]), filt.factoryKw)}</select>
    </div></div></section>
  <section class="group">
    <div class="group-title">订单列表 · 共 ${list.length} 单</div>
    <div class="card">${list.map(o => {
      const latest = latestLog(o);
      return `<div class="ocard" onclick="go('detail','${o.id}')" role="button" tabindex="0" onkeydown="if(event.key==='Enter')go('detail','${o.id}')">
        <div class="thumb">${(function(){const c=normalizePhotos(o.values.img)[0];return c?`<img src="${esc(c)}" alt="款式图">`:"款式图";})()}</div>
        <div class="o-main">
          <div class="o-title"><span class="tag season">${esc(o.season)}</span>${esc(o.values.styleNo || "")} ${esc([o.values.styleName, o.values.style].filter(Boolean).join(" "))}</div>
          <div class="o-meta"><span>业务员 ${esc(uname(o.values.sales)) || "—"}</span><span>下厂员 ${esc(uname(o.values.follower)) || "未指定"}</span>
            <span class="num">数量 ${esc(o.values.qty || "-")}</span><span>交期 ${esc(fmtDate(o.values.deadline)) || "-"}</span></div>
          ${latest && (Date.now() - latest.t) <= 7 * 24 * 60 * 60 * 1000
            ? `<div class="o-latest">最新：${esc(latest.fieldLabel)} · ${esc(latest.text)} <span class="num">(${fmtT(latest.t)})</span></div>` : ""}
        </div><span class="chev">›</span></div>`;
    }).join("") || `<div class="empty">${state.orders.length ? "没有符合条件的订单" : "还没有订单，点右上角 ＋ 新建"}</div>`}</div>
  </section>`;
}

/* ---------- 新建订单 / 批量导入 ---------- */
function vNew() {
  const scalars = s => state.fields[s].filter(f => f.type !== "log");
  if (!photoDraft.img) photoDraft.img = [];
  // 新建时日期默认当天，业务员默认自己
  const defVal = f => f.type === "date" ? todayStr()
    : (f.k === "sales" && me().template === "sales" ? me().id : "");
  return `<section class="group">
    <div class="group-title">订单明细</div>
    <div class="card">
      <label class="field"><span>订单季节</span>${seasonSelectHtml("")}</label>
      <div class="grid2">${scalars("order").map(f => fieldRow(f, defVal(f))).join("")}</div>
    </div></section>
  <section class="group">
    <div class="group-title">生产安排（指定负责打卡的下厂员）</div>
    <div class="card"><div class="grid2">${scalars("production").map(f => fieldRow(f, defVal(f))).join("")}</div></div>
    <div class="btn-row" style="padding-left:0;padding-right:0">
      <button class="btn block" onclick="A.createOrder()">保存订单</button></div>
  </section>
  <section class="group">
    <div class="group-title">表格批量导入</div>
    <div class="card"><div class="card-pad">
      <p style="font-size:13.5px;color:var(--ink-2);margin:0 0 12px">支持 <b>Excel(.xlsx/.xls)</b> 和 <b>CSV(.csv/.txt)</b>，也可以把表格内容直接复制粘贴到下面。第一行为表头，按“货号、款式名、款式、数量、款式描述、订单交期、面料、业务员、下厂员、季节”等列名识别。识别后会<b>填入下方表单</b>，可逐项修改，确认后再导入。</p>
      <div style="margin-bottom:10px">${fileFieldHtml("imp-file", ".xlsx,.xls,.csv,.txt", "A.importFile(this)", "选择表格文件")}</div>
      <textarea class="in" id="imp-text" placeholder="或将 Excel 中选中的区域直接粘贴到这里（含表头）">${esc(importRaw)}</textarea>
      <div style="margin-top:10px"><button class="btn ghost" onclick="A.importText()">识别数据</button></div>
    </div>${importPreview ? importPreviewHtml() : ""}</div>
  </section>`;
}
function importScalars() {
  return [...state.fields.order.filter(f => f.type !== "log" && f.type !== "image"),
          ...state.fields.production.filter(f => f.type !== "log")];
}
function importPreviewHtml() {
  const orderScalars = state.fields.order.filter(f => f.type !== "log" && f.type !== "image");
  const prodScalars = state.fields.production.filter(f => f.type !== "log");
  return `<div style="padding:0 16px 4px;font-size:13.5px;color:var(--ink-2)">
      <b>识别结果</b>：共 ${importPreview.length} 单，<b>尚未保存</b>。可直接修改任意字段，确认后再导入。系统里查不到的姓名会显示“请选择”，请手动选。</div>
    ${importPreview.map((r, i) => `<div class="imp-block">
      <div class="imp-head">第 ${i + 1} 单${importPreview.length > 1 ?
        `<button class="btn plain right" style="color:var(--bad)" onclick="A.removeImportRow(${i})">移除</button>` : ""}</div>
      <label class="field"><span>订单季节</span>${seasonSelectHtml(r.season, "imp" + i + "-")}</label>
      <label class="field"><span>款式图</span>${photoPicker("imp" + i + "-img")}</label>
      <div class="grid2">${orderScalars.map(f => fieldRow(f, r.values[f.k] || "", "imp" + i + "-")).join("")}</div>
      <div class="grid2">${prodScalars.map(f => fieldRow(f, r.values[f.k] || "", "imp" + i + "-")).join("")}</div>
    </div>`).join("")}
    <div class="btn-row">
      <button class="btn" onclick="A.confirmImport()">确认导入 ${importPreview.length} 单</button>
      <button class="btn ghost" onclick="A.cancelImport()">取消</button></div>`;
}

/* ---------- 订单详情 ---------- */
// 一条打卡记录的展示（改/删链接 + 文字 + 照片），主厂/加工点/普通进度字段共用
function logEntriesHtml(list, o, key) {
  const entries = (list || []).slice().sort((a, b) => b.t - a.t);
  if (!entries.length) return `<div class="empty" style="padding:8px 0">暂无打卡记录</div>`;
  const isMainSub = key === "mainLog" || key.startsWith("sub:");
  return `<ul class="log">${entries.map(e => `<li>
    <div class="meta"><b>${esc(e.byName)}</b><span class="num">${fmtT(e.t)}</span>
      <span class="act-row">${canTouchEntry(o, e) ? `<button type="button" class="act-btn" onclick="A.editLog('${o.id}','${key}','${e.id}')">改</button>` : ""}
      ${canTouchEntry(o, e) ? `<button type="button" class="act-btn danger" onclick="A.delLog('${o.id}','${key}','${e.id}')">删</button>` : ""}</span></div>
    ${isMainSub && e.process ? `<div style="font-size:13px;color:var(--ink-2);margin-top:2px">
      生产工序：${esc(e.process)} · 车工人数：${esc(e.workers)} · 预计下车：${esc(fmtDate(e.estDone))}</div>` : ""}
    ${e.text ? `<div class="txt">${esc(e.text)}</div>` : ""}${photoGallery(e.photos)}</li>`).join("")}</ul>`;
}
// 主厂/加工点打卡：生产工序/车工人数/预计下车时间是必填项（其它进度字段仍是纯文字打卡）
function mainSubAddBoxHtml(oid, key, placeholder) {
  return `<div class="addbox" id="add-${key}">
    <label class="field"><span>生产工序</span><input class="in" id="proc-${key}" placeholder="例：车缝、锁边"></label>
    <label class="field"><span>车工人数</span><input class="in" type="number" id="workers-${key}" placeholder="例：12"></label>
    <label class="field"><span>预计下车时间</span>${dateFieldHtml("est-" + key, "")}</label>
    <textarea class="in" id="txt-${key}" placeholder="${esc(placeholder)}" style="margin-top:8px"></textarea>
    ${photoPicker("log:" + key)}
    <div style="margin-top:8px"><button class="btn mini" onclick="A.addLog('${oid}','${key}')">提交打卡</button></div></div>`;
}
function logFieldHtml(o, f, list, addKey, canAdd) {
  return `<div class="logfield">
    <div class="lf-head"><span><span class="lf-dot"></span>${esc(f.label)}</span><span class="cnt">${(list || []).length} 条</span>
      ${canAdd ? `<button class="btn mini right" onclick="A.toggleAdd('${addKey}')">＋ 打卡</button>` : ""}</div>
    ${canAdd ? `<div class="addbox" id="add-${addKey}">
      <textarea class="in" id="txt-${addKey}" placeholder="填写当前进度情况，可详细描述…"></textarea>
      ${photoPicker("log:" + addKey)}
      <div style="margin-top:8px"><button class="btn mini" onclick="A.addLog('${o.id}','${addKey}')">提交打卡</button></div></div>` : ""}
    ${logEntriesHtml(list, o, addKey)}</div>`;
}
// 一个动态"加工点"卡片：可编辑(名称+工序/人数/预计下车时间)、可打卡、管理员可删除
function subCardHtml(o, s, canProdLog) {
  const key = "sub:" + s.id;
  return `<div style="margin-top:10px;border-top:.5px solid var(--line);padding-top:10px">
    <div class="lf-head" style="font-size:14.5px">
      <span>加工点</span> <span class="tag hl">${esc(s.name)}</span>
      ${canProdLog ? `<button type="button" class="act-btn" onclick="A.renameSub('${o.id}','${s.id}')">改名</button>` : ""}
      ${isAdmin() ? `<button type="button" class="act-btn danger" onclick="A.delSub('${o.id}','${s.id}')">删除</button>` : ""}
      ${canProdLog ? `<button class="btn mini right" onclick="A.toggleAdd('${key}')">＋ 打卡</button>` : ""}
    </div>
    ${canProdLog ? mainSubAddBoxHtml(o.id, key, "该加工点的进度情况（补充说明，选填）…") : ""}
    ${logEntriesHtml(s.log, o, key)}</div>`;
}
// 验货：一条"发现问题/整改情况"的展示（两个字段各自独立可编辑）
function inspItemHtml(o, g, it, canInsp, canFix) {
  // 没权限填整改时，说清楚是谁该填，而不是只留一个空白的"待整改"（否则看着像坏了）
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
  const scalars = s => state.fields[s].filter(f => f.type !== "log");
  const logsOf = s => state.fields[s].filter(f => f.type === "log");
  const canB = canEditBasic(o), canOrdLog = canAddLog(o, "order"), canProdLog = canAddLog(o, "production");
  const canInsp = canWriteInspProblem(o), canFix = canWriteInspFix(o);
  // 订单交期/发货日期这两个字段单独摘出来，有编辑权限时直接在详情页点选就改，不用进编辑页；
  // 其它日期类字段(比如预计下车时间)是普通字段，跟着所属的分组(服装工厂旁边)走正常编辑流程
  const isQuickDateField = f => f.k === "deadline" || f.k === "shipDate";
  const kv = fs => fs.map(f => (isQuickDateField(f) && canB
    ? `<div class="row-item"><div class="row-main"><div class="row-label">${esc(f.label)}</div></div>
        <div class="row-value">${dateFieldHtml("qd-" + o.id + "-" + f.k, o.values[f.k], `A.quickSetDate('${o.id}','${f.k}',this.value)`)}</div></div>`
    : `<div class="row-item"><div class="row-main"><div class="row-label">${esc(f.label)}</div></div>
        <div class="row-value">${esc(displayVal(o, f)) || "—"}</div></div>`) +
    (f.k === "shipDate" && shipLocked(o) ? `<div style="margin:0 16px 12px;padding:10px 14px;border-radius:var(--radius);background:var(--bad-soft);color:var(--bad);font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px">
        <span>⚠️</span><span>发货日期一经勾选，所有内容无法更改！！！</span></div>` : "")
  ).join("");
  // 订单交期/发货日期已经能在详情页直接点选修改，编辑表单里不再重复出现
  const editForm = s => `<div class="grid2">${scalars(s).filter(f => !isQuickDateField(f)).map(f => fieldRow(f, o.values[f.k] || "")).join("")}</div>`;
  const photos = normalizePhotos(o.values.img);
  const headerThumb = photos.length ? `<img src="${esc(photos[0])}" alt="款式图" class="header-thumb"
    data-gallery='${JSON.stringify(photos)}' data-i="0" onclick="A.lightboxFromEl(this)">` : "";
  const dateFieldsProd = scalars("production").filter(isQuickDateField);
  const topProdScalars = scalars("production").filter(f => !isQuickDateField(f));
  const orderKvFields = scalars("order").filter(f => f.type !== "image" && !isQuickDateField(f));
  const dateFieldsOrder = scalars("order").filter(isQuickDateField);

  return `<section class="group">
    <div class="card"><div class="card-pad" style="display:flex;align-items:center;gap:14px">
      <span class="tag season" style="flex:none;font-size:14px;padding:5px 12px">${esc(o.season)}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:20px;font-weight:700;letter-spacing:-.02em">${esc(o.values.styleNo || "")}</div>
        <div style="color:var(--ink-2);margin-top:2px">${esc([o.values.styleName, o.values.style].filter(Boolean).join(" "))}</div>
      </div>
      ${headerThumb}
    </div></div></section>

  <section class="group">
    <div class="group-title"><span class="cat-title">一、订单明细</span>${canB ? `<button class="btn mini ghost right" onclick="A.toggleBasic()">${editingBasic ? "取消" : "编辑"}</button>` : ""}</div>
    <div class="card">${editingBasic && canB
      ? `<label class="field"><span>订单季节</span>${seasonSelectHtml(o.season)}</label>${editForm("order")}
         <div class="group-title" style="padding-top:12px">生产安排字段</div>${editForm("production")}
         <div class="btn-row"><button class="btn" onclick="A.saveBasic('${o.id}')">保存修改</button></div>`
      : kv(orderKvFields)}</div>
    ${dateFieldsOrder.length ? `<div class="card" style="margin-top:14px">${kv(dateFieldsOrder)}</div>` : ""}
    <div class="card" style="margin-top:14px">${logsOf("order").map(f => logFieldHtml(o, f, o.logs[f.k] || [], f.k, canOrdLog)).join("")}</div>
  </section>

  <section class="group">
    <div class="group-title"><span class="cat-title">二、生产明细</span>
      <span style="margin-left:8px;font-size:12.5px;color:var(--ink-2)">${o.values.follower ? `负责人 ${esc(uname(o.values.follower))}` : "未指定下厂员"}</span></div>
    <div class="card">${kv(topProdScalars)}</div>
    <div class="card" style="margin-top:14px">
      ${logsOf("production").filter(f => ["preSample", "cutting"].includes(f.k)).map(f => logFieldHtml(o, f, o.logs[f.k] || [], f.k, canProdLog)).join("")}
      <div class="prodgroup-title"><span><span class="lf-dot"></span>生产进度</span></div>
      <div class="logfield" style="padding-top:0">
        <div style="margin-top:10px;border-top:.5px solid var(--line);padding-top:10px">
          <div class="lf-head" style="font-size:14.5px"><span>本厂</span>
            <span class="tag hl">${esc(o.values.factory) || "未指定"}</span>
            ${canProdLog ? `<button class="btn mini right" onclick="A.toggleAdd('mainLog')">＋ 打卡</button>` : ""}</div>
          ${canProdLog ? mainSubAddBoxHtml(o.id, "mainLog", "本厂生产进度（补充说明，选填）…") : ""}
          ${logEntriesHtml(o.mainLog, o, "mainLog")}</div>
        ${(o.subs || []).map(s => subCardHtml(o, s, canProdLog)).join("")}
        ${canProdLog ? `<div style="margin-top:10px;border-top:.5px solid var(--line);padding-top:10px">
          <button class="btn mini ghost" onclick="A.addSubPrompt('${o.id}')">＋ 添加加工点</button></div>` : ""}
      </div>
      ${logsOf("production").filter(f => !["preSample", "cutting"].includes(f.k)).map(f => logFieldHtml(o, f, o.logs[f.k] || [], f.k, canProdLog)).join("")}
    </div>
    ${dateFieldsProd.length ? `<div class="card" style="margin-top:14px">${kv(dateFieldsProd)}</div>` : ""}
  </section>

  <section class="group">
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

  <section class="group">
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
  ${isAdmin() ? `<section class="group"><div class="btn-row" style="padding-left:0;padding-right:0">
    <button class="btn danger ghost block" onclick="A.delOrder('${o.id}')">删除此订单</button></div></section>` : ""}`;
}

/* ---------- 打卡记录（按订单分组，组内按时间倒序） ---------- */
const LOG_GROUP_PREVIEW = 5;   // 每个订单默认只显示最近几条，记录多了不用一直往下滚
function logListHtml(rows) {
  if (!rows) return `<div class="empty">加载中…</div>`;
  if (!rows.length) return `<div class="empty">还没有打卡记录</div>`;
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
    return `<div class="card" style="margin-bottom:14px">
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

/* ---------- 聊天 ---------- */
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
    ${c.unread ? `<span class="badge">${c.unread > 99 ? "99+" : c.unread}</span>` : `<span class="chev">›</span>`}
  </div>`).join("");
}
function attachmentHtml(a, mine) {
  if (!a) return "";
  // 跟订单里的照片用同一个大图查看器，也一样支持双指缩放/双击还原
  if (a.isImage) return `<img class="b-img" src="${esc(a.url)}" alt="${esc(a.name)}"
    data-gallery='${JSON.stringify([a.url])}' data-i="0" onclick="A.lightboxFromEl(this)">`;
  return `<a class="b-file" href="${esc(a.url)}" target="_blank" rel="noopener" download="${esc(a.name)}"
    style="${mine ? "color:#fff" : ""}"><span class="fi">📄</span>
    <span><span class="fn">${esc(a.name)}</span><br><span class="fs num">${fmtSize(a.size)}</span></span></a>`;
}
// 时间只在间隔超过 5 分钟时单独显示一行，不再每条气泡都挂时间
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

/* ---------- 管理员查看某员工打卡 ---------- */
function vStaffLogs() {
  const u = userById(route.id);
  return `<section class="group">
    <div class="group-title">${esc(u ? u.name : "")} 的打卡记录${state.myLogs ? ` · 共 ${state.myLogs.length} 条` : ""}</div>
    <div class="card">${logListHtml(state.myLogs)}</div></section>`;
}

/* ---------- 管理后台 ---------- */
function vAdmin() {
  if (!isAdmin()) return `<div class="card"><div class="empty">仅管理员可访问</div></div>`;
  const roleCell = u => u.role === "admin"
    ? `<span class="tag role">管理员</span>`
    : `<select class="in" style="width:auto;min-height:34px;padding:4px 30px 4px 10px;font-size:14px" onchange="A.changeRole('${u.id}',this.value)">
        ${state.roles.map(r => `<option value="${esc(r.k)}" ${u.role === r.k ? "selected" : ""}>${esc(r.label)}</option>`).join("")}</select>`;
  return `<section class="group">
    <div class="group-title">员工账号</div>
    <div class="card"><div class="tbl-wrap"><table class="tbl">
      <tr><th>姓名</th><th>手机号</th><th>职位</th><th>操作</th></tr>
      ${state.users.map(u => `<tr>
        <td>${esc(u.name)}${u.id === me().id ? ` <span class="tag">我</span>` : ""}</td>
        <td class="num">${esc(u.phone)}</td><td>${roleCell(u)}</td>
        <td style="white-space:nowrap"><button class="btn mini ghost" onclick="A.viewStaffLogs('${u.id}')">查看打卡</button>${
          u.role === "admin" ? "" : ` <button class="btn mini ghost" onclick="A.resetUserPw('${u.id}')">重置密码</button>
          <button class="btn mini danger ghost" onclick="A.deleteUser('${u.id}')">删除</button>`}</td></tr>`).join("")}
    </table></div></div>
  </section>

  <section class="group">
    <div class="group-title">新增员工</div>
    <div class="card">
      <label class="field"><span>姓名</span><input class="in" id="nu-name"></label>
      <label class="field"><span>手机号</span><input class="in" id="nu-phone" inputmode="tel"></label>
      <label class="field"><span>职位</span><select class="in" id="nu-role">${
        state.roles.map(r => `<option value="${esc(r.k)}">${esc(r.label)}</option>`).join("")}</select></label>
      <label class="field"><span>初始密码</span><input class="in" id="nu-pass" value="123456"></label>
      <div class="btn-row"><button class="btn" onclick="A.addUser()">创建账号</button></div></div>
  </section>

  <section class="group">
    <div class="group-title">数据导出</div>
    <div class="card"><div class="card-pad">
      <p style="font-size:13.5px;color:var(--ink-2);margin:0 0 12px">导出订单全部内容（订单基本信息、生产进度、验货问题、跟单小结）为 Excel(.xlsx) 文件，照片以链接形式列出</p>
      <label class="field" style="padding-left:0;padding-right:0;border:0"><span>按季节筛选（可选）</span>
        <select class="in" id="exp-season"><option value="">全部季节</option>${
          state.seasons.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}</select></label>
      <button class="btn" onclick="A.exportData()">导出订单数据</button></div></div>
  </section>

  <section class="group">
    <div class="group-title">职位管理</div>
    <div class="card"><div class="card-pad">
      <div style="display:flex;gap:8px;flex-wrap:wrap">${state.roles.map(r => `<span class="tag role">${esc(r.label)}
        · ${r.template === "sales" ? "业务员权限" : r.template === "supervisor" ? "主管权限" : "下厂员权限"}${r.core ? "" :
          ` <a href="javascript:void(0)" onclick="A.delRole('${r.k}')" style="margin-left:4px">✕</a>`}</span>`).join("")}</div></div>
      <label class="field"><span>新职位名称</span><input class="in" id="nr-label" placeholder="例：跟单主管"></label>
      <label class="field"><span>权限模板</span><select class="in" id="nr-template">
        <option value="sales">业务员权限（可建单、改自己录入的订单）</option>
        <option value="follower">下厂员权限（只能给自己负责的订单打卡）</option>
        <option value="supervisor">主管权限（能管理所有订单）</option></select></label>
      <div class="btn-row"><button class="btn" onclick="A.addRole()">添加职位</button></div></div>
  </section>

  <section class="group">
    <div class="group-title">季节管理</div>
    <div class="card"><div class="card-pad">
      <div style="display:flex;gap:8px;flex-wrap:wrap">${state.seasons.map(s => `<span class="tag role">${esc(s)}
        <a href="javascript:void(0)" onclick="A.delSeason('${encodeURIComponent(s)}')" style="margin-left:4px">✕</a></span>`).join("")}</div></div>
      <label class="field"><span>新季节名称</span><input class="in" id="ns-name" placeholder="例：SS2029"></label>
      <div class="btn-row"><button class="btn" onclick="A.addSeason()">添加季节</button></div></div>
  </section>

  <section class="group">
    <div class="group-title">自定义字段</div>
    <div class="card">
      ${["order", "production"].map(s => `<div class="card-pad" style="padding-bottom:6px">
        <div class="row-sub" style="margin-bottom:6px">${s === "order" ? "一、订单明细" : "二、生产明细"}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${state.fields[s].map(f => `<span class="tag role">${esc(f.label)}${
          f.core ? "" : ` <a href="javascript:void(0)" onclick="A.delField('${s}','${f.k}')" style="margin-left:4px">✕</a>`}</span>`).join("")}</div></div>`).join("")}
      <label class="field"><span>添加到板块</span><select class="in" id="cf-sec"><option value="order">一、订单明细</option><option value="production">二、生产明细</option></select></label>
      <label class="field"><span>字段名称</span><input class="in" id="cf-label" placeholder="例：吊牌进度"></label>
      <label class="field"><span>字段类型</span><select class="in" id="cf-type" onchange="document.getElementById('cf-opts-wrap').style.display=this.value==='select'?'':'none'">
        <option value="text">文本</option><option value="log">进度打卡（保留历史）</option><option value="date">日期</option>
        <option value="number">数字</option><option value="select">下拉菜单</option></select></label>
      <label class="field" id="cf-opts-wrap" style="display:none"><span>下拉选项（逗号分隔）</span><input class="in" id="cf-opts" placeholder="例：选项A,选项B"></label>
      <div class="btn-row"><button class="btn" onclick="A.addField()">添加字段</button></div></div>
  </section>

  <section class="group">
    <div class="group-title">工厂下拉选项</div>
    <div class="card">${[["fabric", "面料工厂"], ["emb", "绣花/印花工厂"], ["prod", "服装工厂"]].map(([k, t]) => `
      <div class="card-pad" style="padding-bottom:10px">
        <div class="row-sub" style="margin-bottom:6px">${t}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${state.factories[k].map(x =>
          `<span class="tag role">${esc(x)} <a href="javascript:void(0)" onclick="A.delFactory('${k}','${encodeURIComponent(x)}')" style="margin-left:4px">✕</a></span>`).join("")}</div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <input class="in" id="fac-${k}" placeholder="新工厂名"><button class="btn mini ghost" onclick="A.addFactory('${k}')">添加</button></div></div>`).join("")}</div>
  </section>

  <section class="group">
    <div class="group-title">意见反馈${state.feedback ? ` · 共 ${state.feedback.length} 条` : ""}</div>
    <div class="card">${state.feedback && state.feedback.length
      ? `<ul class="log" style="padding:4px 16px">${state.feedback.map(f => `<li>
          <div class="meta"><b>${esc(f.byName)}</b><span class="num">${fmtT(f.createdAt)}</span>
            ${f.handled ? `<span class="tag ok">已处理</span>` : ""}
            <button type="button" class="act-btn${f.handled ? " ghost" : ""} right" onclick="A.toggleFeedbackHandled('${f.id}',${!f.handled})">
              ${f.handled ? "标记未处理" : "标记已处理"}</button></div>
          <div class="txt">${esc(f.text)}</div></li>`).join("")}</ul>`
      : `<div class="empty">${state.feedback ? "还没有反馈" : "加载中…"}</div>`}</div>
  </section>`;
}

/* ---------- 我的 ---------- */
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
    <div class="group-title">修改密码</div>
    <div class="card">
      <label class="field"><span>新密码</span><input class="in" type="password" id="my-p1"></label>
      <label class="field"><span>确认新密码</span><input class="in" type="password" id="my-p2"></label>
      <div class="btn-row"><button class="btn" onclick="A.changeMyPw()">确认修改</button></div></div>
  </section>

  <section class="group">
    <div class="group-title">我的打卡记录${state.myLogs ? ` · 共 ${state.myLogs.length} 条` : ""}</div>
    <div class="card">${logListHtml(state.myLogs)}</div>
  </section>

  <section class="group">
    <div class="group-title">意见反馈</div>
    <div class="card"><div class="card-pad">
      <p style="font-size:13.5px;color:var(--ink-2);margin:0 0 12px">对系统有什么建议或发现什么问题，都可以写在这里，管理员会看到</p>
      <button class="btn ghost" onclick="A.submitFeedback()">提交反馈</button></div>
      ${state.myFeedback && state.myFeedback.length ? `<ul class="log" style="padding:4px 16px 12px">${state.myFeedback.map(f => `<li>
        <div class="meta"><span class="num">${fmtT(f.createdAt)}</span>
          ${f.handled ? `<span class="tag ok">已处理</span>` : `<span class="tag role">待处理</span>`}</div>
        <div class="txt">${esc(f.text)}</div></li>`).join("")}</ul>` : ""}</div>
  </section>

  <section class="group">
    <div class="btn-row" style="padding-left:0;padding-right:0">
      ${(isStandalone() || !isMobileDevice()) ? "" : `<button class="btn ghost block" style="margin-bottom:10px" onclick="A.install()">📲 安装到手机</button>`}
      <button class="btn danger ghost block" onclick="A.logout()">退出登录</button></div>
  </section>`;
}

/* ================= 动作 ================= */
const A = {
  modalOk() {
    const st = modalState; if (!st) return;
    const v = st.input ? ($("m-input") ? $("m-input").value : "") : null;
    if (st.keepOpenOnOk) { if (st.onOk) st.onOk(v); return; }
    modalState = null; renderModal();
    if (st.onOk) st.onOk(v);
  },
  modalCancel() { modalState = null; renderModal(); },

  /* ---- 照片 ---- */
  async addDraftPhotos(ctx, input) {
    const files = [...(input.files || [])]; input.value = "";
    if (!files.length) return;
    photoDraft[ctx] = photoDraft[ctx] || [];
    let okCount = 0, failCount = 0;
    for (let k = 0; k < files.length; k++) {
      toast(`上传照片 ${k + 1}/${files.length}…`, true);
      // 手机网络不稳时经常传一半就断，失败了自动重试一次，别一断网就直接算失败
      let url = null, lastErr = null;
      for (let attempt = 0; attempt < 2 && !url; attempt++) {
        try { url = await uploadOnePhoto(files[k]); } catch (e) { lastErr = e; }
      }
      if (url) { okCount++; photoDraft[ctx].push(url); const el = $("pe-" + ctx); if (el) el.innerHTML = pickerInner(ctx); }
      else failCount++;
      if (!url && lastErr) console.error("照片上传失败", lastErr);
    }
    // 之前不管成功失败最后都提示"照片已添加"，网络不好导致全部失败时也会显示成功，用户会误以为传上去了。
    // 现在按实际结果给准确提示，一张都没成功时不再假装成功。
    if (okCount && !failCount) toast("照片已添加");
    else if (okCount && failCount) toast(`已添加${okCount}张，${failCount}张上传失败(请检查网络后重试)`);
    else toast("照片上传失败，请检查网络后重试");
  },
  removeDraftPhoto(ctx, i) {
    if (photoDraft[ctx]) { photoDraft[ctx].splice(i, 1); const el = $("pe-" + ctx); if (el) el.innerHTML = pickerInner(ctx); }
  },
  lightboxFromEl(el) {
    try { lightbox = { photos: JSON.parse(el.getAttribute("data-gallery")), i: +el.getAttribute("data-i") || 0 }; renderLightbox(); }
    catch (e) {}
  },
  lbStep(d) {
    if (!lightbox) return;
    const n = lightbox.photos.length;
    lightbox.i = (lightbox.i + d + n) % n; renderLightbox();
  },
  closeLightbox() { lightbox = null; renderLightbox(); },

  async login() {
    const phone = $("lg-phone").value.trim(), password = $("lg-pass").value;
    try {
      const r = await api("POST", "/login", { phone, password });
      state.token = r.token; localStorage.setItem("daka_token", r.token);
      showWelcome = true; render();   // 密码验证通过就先顶上欢迎界面，不用等 bootstrap 接口回来
      await Promise.all([refresh(), new Promise(res => setTimeout(res, 1500))]);
      go("orders");
      A.dismissWelcome();
    } catch (e) {
      // 只有「密码对了但 bootstrap 接口失败」才需要把已经顶上的欢迎界面收回去；
      // 单纯密码错误时 showWelcome 还是 false，不用重渲染，否则会把用户刚输入的手机号也清空
      if (showWelcome) { showWelcome = false; render(); }
      toast((e && e.error) || "登录失败");
    }
  },
  dismissWelcome() {
    if (!showWelcome) return;
    showWelcome = false; render();
  },
  async install() {
    if (isStandalone()) return toast("已经是从主屏打开的了");
    if (deferredInstall) {                      // 安卓 / 桌面 Chrome：直接弹系统安装框
      deferredInstall.prompt();
      try { await deferredInstall.userChoice; } catch (e) {}
      deferredInstall = null;
      return;
    }
    A.installGuide();                           // iOS 等：给图文步骤
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
    modal({ title: "退出登录？", body: "下次需要重新输入手机号和密码。", danger: true, okText: "退出",
      onOk: () => A.forceLogout() });
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
    // 原生日期框只有点在日历图标那一小块才会自动弹选择器，点日期数字部分只是把光标定位过去，
    // 不会弹出来——不管点在控件哪里都强制弹一次，避免用户以为点了没反应
    try { if (el.showPicker) el.showPicker(); } catch (e) { }
  },
  syncDateLabel(id) {
    const el = $(id), lab = $(id + "--label"); if (!el || !lab) return;
    lab.textContent = el.value ? fmtDate(el.value) : "选择日期";
    lab.classList.toggle("empty", !el.value);
  },
  // 订单交期/发货日期等日期字段：不用进编辑页，详情页里直接点选就改，PATCH 是合并语义(只传这一个字段)
  async quickSetDate(oid, key, val) {
    await run(() => api("PATCH", "/orders/" + oid, { values: { [key]: val } }), "已更新");
  },
  syncFileName(id, name) {
    const el = $(id + "--name"); if (el) el.textContent = name || "未选择文件";
  },

  setF(k, v) { filt[k] = v; render(); },
  setFKw(v) {
    filt.kw = v; clearTimeout(A._kwT);
    A._kwT = setTimeout(() => {
      render();
      const inp = $("flt-kw");
      if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    }, 300);
  },
  collectScalars(section, into) {
    for (const f of state.fields[section].filter(f => f.type !== "log")) {
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
    const f = [...state.fields.order, ...state.fields.production].find(x => x.k === fKey);
    if (!f) return;
    container.outerHTML = factoryMultiHtml(f, arr, id);
  },
  async createOrder() {
    const season = ($("nf-season").value || "").trim();
    if (!season) return toast("请选择订单季节");
    const values = {}; A.collectScalars("order", values); A.collectScalars("production", values);
    if (!values.styleNo && !values.styleName) return toast("请至少填写货号或款式名");
    try { await api("POST", "/orders", { season, values }); photoDraft = {}; await refresh(); go("orders"); toast("订单已创建"); }
    catch (e) { toast((e && e.error) || "创建失败"); }
  },
  toggleBasic() {
    editingBasic = !editingBasic;
    if (editingBasic) { const o = state.orders.find(x => x.id === route.id); photoDraft = { img: normalizePhotos(o && o.values.img) }; }
    else photoDraft = {};
    render();
  },
  async saveBasic(oid) {
    const season = ($("nf-season") || {}).value || "";
    const values = {}; A.collectScalars("order", values); A.collectScalars("production", values);
    await run(() => api("PATCH", "/orders/" + oid, { season, values }).then(() => { editingBasic = false; photoDraft = {}; }), "已保存修改");
  },
  delOrder(oid) {
    modal({ title: "删除此订单？", body: "删除后不可恢复，订单下的全部打卡记录一并删除。", danger: true, okText: "确认删除",
      onOk: () => run(() => api("DELETE", "/orders/" + oid).then(() => go("orders")), "订单已删除") });
  },

  toggleAdd(key) { const b = $("add-" + key); if (b) b.classList.toggle("show"); },
  async addLog(oid, key) {
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
    modal({ title: "修改打卡内容", input: "textarea", value: e.text, okText: "保存",
      onOk: v => { if (v && v.trim()) run(() => api("PATCH", `/orders/${oid}/logs/${key}/${eid}`, { text: v.trim() }), "已修改"); } });
  },
  delLog(oid, key, eid) {
    modal({ title: "删除这条打卡记录？", danger: true, okText: "确认删除",
      onOk: () => run(() => api("DELETE", `/orders/${oid}/logs/${key}/${eid}`), "已删除") });
  },

  /* ---- 生产进度：动态加工点 ---- */
  addSubPrompt(oid) {
    modal({ title: "添加加工点", body: "给这个加工点起个名字，比如「绣花外发点」「二次印花点」。", input: "text", okText: "添加",
      onOk: v => { const name = (v || "").trim(); if (name) run(() => api("POST", `/orders/${oid}/subs`, { name }), "已添加加工点：" + name); } });
  },
  renameSub(oid, subId) {
    const o = state.orders.find(x => x.id === oid);
    const sub = o && o.subs.find(x => x.id === subId);
    if (!sub) return;
    modal({ title: "修改加工点名称", input: "text", value: sub.name, okText: "保存",
      onOk: v => { const name = (v || "").trim(); if (name) run(() => api("PATCH", `/orders/${oid}/subs/${subId}`, { name }), "已修改"); } });
  },
  delSub(oid, subId) {
    modal({ title: "删除这个加工点？", body: "删除后该加工点下的打卡记录一并删除，且不可恢复。", danger: true, okText: "确认删除",
      onOk: () => run(() => api("DELETE", `/orders/${oid}/subs/${subId}`), "已删除") });
  },

  /* ---- 验货：发现问题(业务员) / 整改情况(下厂员) 各自独立 ---- */
  inspAddRow() {
    const d = document.createElement("label"); d.className = "field";
    d.innerHTML = `<span>发现问题</span><textarea class="in insp-p" style="min-height:62px"></textarea>`;
    $("insp-items").appendChild(d);
  },
  async saveInsp(oid) {
    const problems = [...document.querySelectorAll(".insp-p")].map(t => t.value.trim()).filter(Boolean);
    const photos = photoDraft.insp || [];
    if (!problems.length && !photos.length) return toast("请至少填写一条发现的问题或加照片");
    await run(() => api("POST", `/orders/${oid}/inspections`, { problems, photos }).then(() => { delete photoDraft.insp; }), "验货记录已保存");
  },
  delInsp(oid, gid) {
    modal({ title: "删除这组验货记录？", danger: true, okText: "确认删除",
      onOk: () => run(() => api("DELETE", `/orders/${oid}/inspections/${gid}`), "已删除") });
  },
  editInspProblem(oid, gid, itemId) {
    const o = state.orders.find(x => x.id === oid);
    const g = o && o.inspections.find(x => x.id === gid);
    const it = g && g.items.find(x => x.id === itemId);
    if (!it) return;
    modal({ title: "修改发现的问题", input: "textarea", value: it.problem, okText: "保存",
      onOk: v => { if (v && v.trim()) run(() => api("PATCH", `/orders/${oid}/inspections/${gid}/items/${itemId}`, { problem: v.trim() }), "已修改"); } });
  },
  editInspFix(oid, gid, itemId) {
    const o = state.orders.find(x => x.id === oid);
    const g = o && o.inspections.find(x => x.id === gid);
    const it = g && g.items.find(x => x.id === itemId);
    if (!it) return;
    modal({ title: "填写整改情况", input: "textarea", value: it.fix || "", okText: "保存",
      onOk: v => run(() => api("PATCH", `/orders/${oid}/inspections/${gid}/items/${itemId}`, { fix: (v || "").trim() }), "已保存") });
  },
  addInspNote(oid, gid, itemId) {
    modal({ title: "添加补充说明", input: "textarea", okText: "添加",
      onOk: v => { if (v && v.trim()) run(() => api("POST", `/orders/${oid}/inspections/${gid}/items/${itemId}/notes`, { text: v.trim() }), "已添加"); } });
  },
  async addFollow(oid) {
    const text = ($("txt-follow").value || "").trim();
    const photos = photoDraft.follow || [];
    if (!text && !photos.length) return toast("请填写内容或加照片");
    await run(() => api("POST", `/orders/${oid}/follow`, { text, photos }).then(() => { delete photoDraft.follow; }), "已添加");
  },
  delFollow(oid, eid) {
    modal({ title: "删除这条记录？", danger: true, okText: "确认删除",
      onOk: () => run(() => api("DELETE", `/orders/${oid}/follow/${eid}`), "已删除") });
  },

  /* ---- 管理后台 ---- */
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
    modal({ title: `删除员工「${u.name}」？`, body: "删除后该账号无法登录；历史打卡记录仍会保留。此操作不可恢复。",
      danger: true, okText: "确认删除", onOk: () => run(() => api("DELETE", "/users/" + id), "已删除员工：" + u.name) });
  },
  resetUserPw(id) {
    const u = userById(id); if (!u) return;
    modal({ title: `为 ${u.name} 设置新密码`, input: "text", value: "123456", okText: "重置",
      onOk: v => { if (v && v.trim()) run(() => api("POST", `/users/${id}/reset-password`, { password: v.trim() }), "密码已重置"); } });
  },
  async addRole() {
    const label = $("nr-label").value.trim(), template = $("nr-template").value;
    if (!label) return toast("请填写职位名称");
    await run(() => api("POST", "/roles", { label, template }), "职位已添加：" + label);
  },
  delRole(k) {
    const r = state.roles.find(x => x.k === k); if (!r) return;
    modal({ title: `删除职位「${r.label}」？`, body: "只有没人担任该职位时才能删除。", danger: true, okText: "确认删除",
      onOk: () => run(() => api("DELETE", "/roles/" + k), "职位已删除") });
  },
  async addSeason() {
    const name = $("ns-name").value.trim();
    if (!name) return toast("请填写季节名称");
    await run(() => api("POST", "/seasons", { name }), "季节已添加：" + name);
  },
  delSeason(encName) {
    const name = decodeURIComponent(encName);
    modal({ title: `删除季节「${name}」？`, body: "只有没有订单使用该季节时才能删除。", danger: true, okText: "确认删除",
      onOk: () => run(() => api("DELETE", "/seasons/" + encName), "季节已删除") });
  },
  async addField() {
    const section = $("cf-sec").value, label = $("cf-label").value.trim(), type = $("cf-type").value;
    if (!label) return toast("请填写字段名称");
    const options = type === "select" ? $("cf-opts").value.split(/[,，]/).map(s => s.trim()).filter(Boolean) : undefined;
    await run(() => api("POST", "/fields", { section, label, type, options }), "字段已添加：" + label);
  },
  delField(section, key) {
    const f = state.fields[section].find(x => x.k === key); if (!f) return;
    modal({ title: `删除字段「${f.label}」？`, body: "已填写的数据将不再显示。", danger: true, okText: "确认删除",
      onOk: () => run(() => api("DELETE", `/fields/${section}/${key}`), "字段已删除") });
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
  submitFeedback() {
    modal({ title: "意见反馈", input: "textarea", okText: "提交",
      onOk: v => { if (v && v.trim()) run(() => api("POST", "/feedback", { text: v.trim() }).then(() => A.loadMyFeedback()), "感谢反馈，已提交给管理员"); } });
  },
  async loadFeedback() {
    if (!isAdmin()) return;
    state.feedback = null;
    try { state.feedback = await api("GET", "/feedback"); }
    catch (e) { state.feedback = []; }
    render();
  },
  async toggleFeedbackHandled(id, handled) {
    await run(() => api("PATCH", `/feedback/${id}`, { handled }).then(() => A.loadFeedback()),
      handled ? "已标记为已处理" : "已标记为未处理");
  },
  async loadMyFeedback() {
    try { state.myFeedback = await api("GET", "/feedback/mine"); }
    catch (e) { state.myFeedback = []; }
    render();
  },
  viewStaffLogs(id) { go("staffLogs", id); },

  /* ---- 聊天 ---- */
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
      const r = await fetch("/api/chat/upload", { method: "POST", headers: { Authorization: "Bearer " + state.token }, body: fd });
      const j = await r.json(); if (!r.ok) throw j;
      state.chat.att = j; input.value = ""; render();
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

  async exportData() {
    if (!isAdmin()) return toast("仅管理员可导出");
    try {
      const season = ($("exp-season") || {}).value || "";
      const qs = season ? "?season=" + encodeURIComponent(season) : "";
      const r = await fetch("/api/export" + qs, { headers: { Authorization: "Bearer " + state.token } });
      if (!r.ok) throw await r.json().catch(() => ({ error: "导出失败" }));
      const blob = await r.blob(), url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `订单导出-${season || "全部季节"}-${todayStr()}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      toast("已开始下载");
    } catch (e) { toast((e && e.error) || "导出失败"); }
  },

  /* ---- 批量导入 ---- */
  async importFile(input) {
    const f = input.files && input.files[0]; if (!f) return;
    A.syncFileName(input.id, f.name);
    const btn = input.nextElementSibling;
    input.disabled = true; if (btn) btn.disabled = true;
    try {
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      // .xlsx 直接在浏览器本地把文字解析出来，不用把整份文件（哪怕表格里贴了很多没压缩的原图，
      // 几十MB）传去服务器——反正只要文字，不处理里面的图片，本地解析完全不用等上传
      if (ext === "xlsx") {
        try {
          if (!window.XLSX) { toast("正在准备中，请稍候…", true); await loadScriptOnce("/xlsx.mini.min.js"); }
          await A.importFileClientSide(f);
          return;
        } catch (e) { console.error("本地解析失败，退回服务器解析：", e); }
      }
      await A.importFileServerFallback(f);
    } finally { input.disabled = false; if (btn) btn.disabled = false; }
  },
  // 本地解析：表格文字在本地直接解出来(不用上传原始文件)；表格里贴的图片也在本地抠出来，
  // 抠到的图片先在本地压缩(跟平时拍照上传一样)再各自上传，不用把整份大文件传去服务器
  async importFileClientSide(f) {
    toast("正在本地解析文件…", true);
    const buf = await f.arrayBuffer();
    // XLSX.read 的 type:"array" 要求传字节数组(Uint8Array)，直接传原始 ArrayBuffer 会静默解析出空结果
    const wb = XLSX.read(new Uint8Array(buf), { type: "array", cellDates: true, dateNF: "yyyy-mm-dd" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error("表格里没有内容");
    // WPS 导出的表格声明的数据范围经常比实际数据大很多，收紧成实际有数据的范围再读
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
    // 图片一张张排队上传太慢(压缩+上传的时间会累加)，改成同时传几张(并发3张)，网络等待的时间能重叠起来
    const entries = Object.keys(found)
      .map(origRow => ({ filteredIdx: origToFiltered[origRow], img: found[origRow] }))
      .filter(e => e.filteredIdx !== undefined && e.img.data.length <= 8 * 1024 * 1024); // 跟平时拍照上传的单张图片大小上限保持一致
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
  // 服务器解析：本地不支持(比如很老的机型加载不了解析组件)或本地解析出问题时的兜底
  async importFileServerFallback(f) {
    // 用 XHR 而不是 fetch，是因为要拿到真实上传进度、并能设超时——
    // 不然网络卡住时界面只会一直显示"请稍候"，用户分不清是真在传还是已经死了
    try {
      const j = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/import/parse");
        xhr.setRequestHeader("Authorization", "Bearer " + state.token);
        xhr.timeout = 180000; // 3分钟，超过多半是网络问题，不能让用户无限期干等
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && e.total) {
            const pct = Math.round(e.loaded / e.total * 100);
            toast(pct < 100 ? `正在上传文件… ${pct}%` : "上传完成，正在解析…", true);
          } else toast("正在上传文件，请稍候…", true);
        };
        xhr.onload = () => {
          let j2 = null; try { j2 = JSON.parse(xhr.responseText); } catch (e) {}
          if (xhr.status >= 200 && xhr.status < 300 && j2) resolve(j2);
          else reject((j2 && j2.error) ? j2 : { error: "文件解析失败(状态码 " + xhr.status + ")" });
        };
        xhr.onerror = () => reject({ error: "网络出错，上传失败，请检查网络后重试" });
        xhr.ontimeout = () => reject({ error: "上传超过3分钟没有完成，可能是网络太慢或文件太大，请检查网络后重试" });
        const fd = new FormData(); fd.append("file", f);
        xhr.send(fd);
      });
      importRaw = "";
      const gotImages = j.rowImages && Object.keys(j.rowImages).length;
      toast("解析完成");
      A.showPreview(A.rowsToPreview(j.rows, j.rowImages), (j.encoding === "GBK" ? "（已按 GBK 编码读取）" : "") + (gotImages ? "，已自动识别表格里的款式图" : ""));
    } catch (e) { toast((e && e.error) || "文件解析失败"); }
  },
  // 表头列名 -> 字段
  importMap() {
    return { "货号": "styleNo", "款式名": "styleName", "款式": "style", "数量": "qty", "款式描述": "desc",
      "订单交期": "deadline", "交期": "deadline", "发货日期": "shipDate", "业务员": "sales", "下厂员": "follower",
      "季节": "_season", "订单季节": "_season",
      "服装工厂": "factory", "生产厂": "factory", // 生产厂 是旧表头，兼容老导入模板
      "面料工厂1": "fabricFactory1", "面料工厂2": "fabricFactory2", "面料工厂": "fabricFactory1", // 面料工厂 是旧表头，导入进面料工厂1
      "绣花工厂": "embFactory", "印花工厂": "printFactory", "绣印工厂": "embFactory" }; // 绣印工厂 是旧表头，兼容老导入模板
  },
  // 二维数组（首行表头）-> 待确认的订单列表
  rowsToPreview(grid, rowImages) {
    const MAP = A.importMap();
    // 找表头行：前 10 行里第一行"含已知列名"的行（容忍标题行/空行在上面）
    let hi = 0;
    for (let i = 0; i < Math.min(grid.length, 10); i++) {
      const cs = (grid[i] || []).map(c => String(c == null ? "" : c).trim());
      if (cs.some(c => MAP[c])) { hi = i; break; }
    }
    const heads = (grid[hi] || []).map(h => String(h == null ? "" : h).trim().replace(/^\uFEFF/, ""));
    const out = [];
    for (let i = hi + 1; i < grid.length; i++) {
      const cells = grid[i] || [];
      if (!cells.some(c => String(c == null ? "" : c).trim())) continue;
      const values = {}; let season = "";
      heads.forEach((h, j) => {
        const key = MAP[h], v = String(cells[j] == null ? "" : cells[j]).trim();
        if (!v || !key) return;
        if (key === "_season") season = v;
        else if (key === "sales" || key === "follower") {
          const u = state.users.find(x => x.name === v);
          if (u) values[key] = u.id;
        } else {
          const f = [...state.fields.order, ...state.fields.production].find(x => x.k === key);
          if (f && f.type === "date") values[key] = normalizeImportDate(v);
          else if (f && isMultiFactory(f)) values[key] = v.split(/[,，、\/]/).map(s => s.trim()).filter(Boolean);
          else values[key] = v;
        }
      });
      if (!values.styleNo && !values.styleName) continue;
      if (me().template === "sales" && !values.sales) values.sales = me().id;
      if (rowImages && rowImages[i]) values.img = [rowImages[i]]; // WPS/Excel 表格里嵌入的款式图，按行号配对带出来
      out.push({ season: season || "", values });
    }
    return out;
  },
  showPreview(rows, extra) {
    if (!rows.length) return toast("未识别到有效数据，请检查表头列名");
    importPreview = rows; A.resyncImportPhotoDrafts(); render();
    toast(`识别到 ${rows.length} 单${extra || ""}，已填入下方表单，可修改后确认导入`);
  },
  // 导入预览里每行的款式图草稿：按 importPreview 当前的下标重建，避免"移除某一行"后下标错位串图
  resyncImportPhotoDrafts() {
    Object.keys(photoDraft).forEach(k => { if (/^imp\d+-img$/.test(k)) delete photoDraft[k]; });
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
    A.syncImportInputs(); if (!importPreview) return;
    importPreview.splice(i, 1); if (!importPreview.length) importPreview = null;
    A.resyncImportPhotoDrafts();
    render();
  },
  cancelImport() {
    importPreview = null;
    Object.keys(photoDraft).forEach(k => { if (/^imp\d+-img$/.test(k)) delete photoDraft[k]; });
    render(); toast("已取消，未导入任何数据");
  },
  async confirmImport() {
    if (!importPreview || !importPreview.length) return;
    A.syncImportInputs();
    const built = importPreview.filter(r => r.values.styleNo || r.values.styleName)
      .map(r => ({ season: r.season || "未分季", values: r.values }));
    if (!built.length) return toast("每一单请至少填写货号或款式名");
    try {
      const r = await api("POST", "/orders/import", { orders: built });
      importPreview = null; importRaw = "";
      Object.keys(photoDraft).forEach(k => { if (/^imp\d+-img$/.test(k)) delete photoDraft[k]; });
      await refresh(); go("orders"); toast(`成功导入 ${r.imported} 个订单`);
    } catch (e) { toast((e && e.error) || "导入失败"); }
  }
};

/* ================= 下拉刷新 ================= */
// 在页面顶部往下拉可以强制刷新一次数据，不用退出重进；不额外画指示器，
// 刷新完成后用跟其它操作一样的 toast 提示一下就行。聊天单聊里、大图查看器打开时、
// 弹窗打开时不生效，避免跟那些地方自己的手势/滚动冲突
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

/* ================= 启动 ================= */
window.go = go; window.A = A;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); deferredInstall = e;      // 存起来，等用户点「安装到手机」再弹
  if (state.me || !$("app").innerHTML) { /* 下次渲染时按钮自然出现 */ }
});
window.addEventListener("appinstalled", () => { deferredInstall = null; toast("已添加到手机主屏"); });

(async function boot() {
  // 每次打开App、只要本来是登录状态，都要过一遍欢迎界面（logo/公司名称/跟单系统）。
  // index.html 里已经有一份静态的欢迎界面兜底，JS 跑起来之前手机屏幕就不会是空的；
  // 这里只需要在数据没回来之前维持住同一份内容，不要提前露出正在加载的空页面。
  if (state.token) {
    loadStateCache();   // 先用上次缓存的数据把订单/用户列表填上，不用干等网络才有内容
    showWelcome = true; render();
    const refreshP = refresh().catch(e => { state.token = null; localStorage.removeItem("daka_token"); showWelcome = false; });
    // 欢迎界面至少展示1.5秒；网络数据这期间基本已经回来了，两者谁慢等谁，不再叠加着算
    await Promise.all([refreshP, new Promise(r => setTimeout(r, 1500))]);
  }
  render();
  if (showWelcome) A.dismissWelcome();
  if (state.me) { A.refreshUnread(); A.loadContacts(true); }
  setInterval(() => { if (state.me) A.refreshUnread(); }, 10000);
  setInterval(() => {
    if (!state.me) return;
    if (route.v === "chat") { if (state.chat.activeId) A.loadConversation(); else A.loadContacts(); }
  }, 4000);
})();
