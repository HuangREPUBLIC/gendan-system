"use strict";
// API 路由(/api)。订单业务数据以 JSON 存在 orders.data，所有写操作在服务端校验权限
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const zlib = require("zlib");
const { promisify } = require("util");
const { pipeline } = require("stream/promises");
const XLSX = require("xlsx");
const AdmZip = require("adm-zip");
const { db, uid, getSetting, setSetting, UPLOAD_DIR } = require("./db");
const A = require("./auth");
const P = require("./push");

const router = express.Router();
const deflateRaw = promisify(zlib.deflateRaw);

// 从 xlsx 抠出嵌入图片，按锚定行号(0-based，含表头)配对；只看第一个工作表，失败返回空
function extractEmbeddedImages(buf) {
  const images = {};
  let zip;
  try { zip = new AdmZip(buf); } catch (e) { return images; }
  const entries = {}; zip.getEntries().forEach(e => { entries[e.entryName] = e; });

  const sheetRels = entries["xl/worksheets/_rels/sheet1.xml.rels"];
  if (!sheetRels) return images;
  const sheetRelsXml = sheetRels.getData().toString("utf8");
  const drawingRefM = sheetRelsXml.match(/Target="[^"]*?(drawing\d*\.xml)"/);
  if (!drawingRefM) return images;
  const drawingEntry = entries["xl/drawings/" + drawingRefM[1]];
  if (!drawingEntry) return images;
  const drawingXml = drawingEntry.getData().toString("utf8");

  const drawingRelsEntry = entries["xl/drawings/_rels/" + drawingRefM[1] + ".rels"];
  const rIdToMedia = {};
  if (drawingRelsEntry) {
    const relsXml = drawingRelsEntry.getData().toString("utf8");
    const re = /<Relationship[^>]*Id="(rId\d+)"[^>]*Target="[^"]*?(media\/[^"]+)"/g;
    let m;
    while ((m = re.exec(relsXml))) rIdToMedia[m[1]] = "xl/" + m[2];
  }

  const anchorRe = /<xdr:(?:twoCellAnchor|oneCellAnchor)[\s\S]*?<\/xdr:(?:twoCellAnchor|oneCellAnchor)>/g;
  let am;
  while ((am = anchorRe.exec(drawingXml))) {
    const block = am[0];
    const rowM = block.match(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/);
    const embedM = block.match(/r:embed="(rId\d+)"/);
    if (!rowM || !embedM) continue;
    const mediaPath = rIdToMedia[embedM[1]];
    const mediaEntry = mediaPath && entries[mediaPath];
    if (!mediaEntry) continue;
    const row = parseInt(rowM[1], 10);
    images[row] = { data: mediaEntry.getData(), ext: (path.extname(mediaPath) || ".png").toLowerCase() };
  }
  return images;
}

const getFields = () => getSetting("fields", { order: [], production: [] });
const allFields = () => { const f = getFields(); return [...f.order, ...f.production]; };
const fieldOf = key => allFields().find(x => x.k === key);
const getFactories = () => getSetting("factories", { emb: [], prod: [], proc: [] });
const activeUser = id => db.prepare("SELECT * FROM users WHERE id = ? AND deleted = 0").get(id);
const activeUsers = () => db.prepare("SELECT * FROM users WHERE deleted = 0").all();

// ---------- 订单读写 ----------
function loadOrder(id) {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!row) return null;
  row.data = JSON.parse(row.data);
  return row;
}
function saveOrder(o) {
  db.prepare("UPDATE orders SET season=?, updated_at=?, data=? WHERE id=?")
    .run(o.season, Date.now(), JSON.stringify(o.data), o.id);
}
// 只收本系统 /uploads/ 下的图片路径，最多 100 张
function cleanPhotos(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(x => typeof x === "string" && /^\/uploads\/[\w.\-]+$/.test(x)).slice(0, 100);
}

function cleanOrderValues(v) {
  v = (v && typeof v === "object") ? v : {};
  if (v.img !== undefined) v.img = cleanPhotos(Array.isArray(v.img) ? v.img : v.img ? [v.img] : []);
  return v;
}

function orderPublic(o) {
  return { id: o.id, season: o.season, createdBy: o.created_by, createdAt: o.created_at,
    values: o.data.values || {}, logs: o.data.logs || {}, mainLog: o.data.mainLog || [],
    subs: o.data.subs || [], inspections: o.data.inspections || [], followIssues: o.data.followIssues || [] };
}
const loadAllOrders = () => db.prepare("SELECT * FROM orders").all().map(r => { r.data = JSON.parse(r.data); return r; });
const allOrdersPublic = () => loadAllOrders().map(orderPublic);
// 按权限过滤后的订单列表
const visibleOrdersPublic = u => loadAllOrders().filter(r => A.canViewOrder(u, r)).map(orderPublic);
const logFields = () => allFields().filter(x => x.type === "log");
function sectionOfKey(key) {
  if (key === "mainLog" || key.startsWith("sub:")) return "production";
  return getFields().order.some(x => x.k === key) ? "order" : "production";
}
function listForKey(o, key) {
  if (key === "mainLog") {
    if (!o.data.mainLog) o.data.mainLog = [];
    return o.data.mainLog;
  }
  if (key.startsWith("sub:")) {
    const sub = (o.data.subs || []).find(x => x.id === key.slice(4));
    return sub ? sub.log : null;
  }
  o.data.logs = o.data.logs || {};
  if (!o.data.logs[key]) o.data.logs[key] = [];
  return o.data.logs[key];
}
function withOrder(req, res, next) {
  req.order = loadOrder(req.params.id);
  if (!req.order) return res.status(404).json({ error: "订单不存在" });
  next();
}
function inspItemOf(o, instId, itemId) {
  const batch = o.data.inspections.find(x => x.id === instId);
  return batch && batch.items.find(x => x.id === itemId);
}
function logEntryOf(o, key, entryId) {
  const list = listForKey(o, key);
  const e = list && list.find(x => x.id === entryId);
  return e ? { list, e } : {};
}
function emptyOrderData(values) {
  const logs = {};
  logFields().forEach(f => logs[f.k] = []);
  return { values: values || {}, logs, mainLog: [], subs: [], inspections: [], followIssues: [] };
}

/* ---------- 应用内通知 ----------
 * 订单被别人改动时通知本单业务员/下厂员/创建人和所有主管、管理员(不含操作者)；失败不影响主流程 */
function orderLabel(o) {
  const v = (o.data && o.data.values) || {};
  return v.styleNo || v.styleName || o.id;
}
const fieldLabelOf = key => (fieldOf(key) || {}).label || key;
function changeLabelOf(key) { return key === "season" ? "订单季节" : fieldLabelOf(key); }
const fieldTypeOf = key => key === "season" ? "season" : ((fieldOf(key) || {}).type || null);
// 2026-08-15 -> 2026年8月15日
function fmtDateVal(v) {
  const m = String(v).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  return m ? `${m[1]}年${+m[2]}月${+m[3]}日` : String(v);
}
// 通知里新值的显示文字；图片/打卡类返回 null(只报字段名)，人员 id 转姓名，过长截断
function fieldValueText(key, value) {
  if (value === undefined || value === null || String(value).trim() === "") return "（清空）";
  const type = fieldTypeOf(key);
  if (type === "image" || type === "log") return null;
  let s;
  if (type === "user-sales" || type === "user-follower") {
    const u = db.prepare("SELECT name FROM users WHERE id = ?").get(value);
    s = u ? u.name : String(value);
  } else if (type === "date") {
    s = fmtDateVal(value);
  } else {
    s = String(value);
  }
  return s.length > 20 ? s.slice(0, 20) + "…" : s;
}
// 打卡环节名：本厂 / 加工点名 / 进度字段名
function logLabelOf(o, key) {
  if (key === "mainLog") return "本厂";
  if (String(key).startsWith("sub:")) {
    const sub = (o.data.subs || []).find(x => x.id === String(key).slice(4));
    return sub ? sub.name : "加工点";
  }
  return fieldLabelOf(key);
}
function notifyOrder(actor, o, what) {
  try {
    const v = (o.data && o.data.values) || {};
    const ids = new Set([v.sales, v.follower, o.created_by].filter(Boolean));
    db.prepare("SELECT id, role FROM users WHERE deleted = 0").all().forEach(u => {
      if (u.role === "admin" || A.roleTemplate(u.role) === "supervisor") ids.add(u.id);
    });
    ids.delete(actor.id);
    if (!ids.size) return;
    const label = orderLabel(o);
    const text = `${actor.name} 在 ${label} ${what}`;
    const now = Date.now();
    const stmt = db.prepare("INSERT INTO notifications(id,user_id,order_id,text,created_at,read_at,actor_name,order_label,what) VALUES(?,?,?,?,?,NULL,?,?,?)");
    ids.forEach(uid2 => stmt.run(uid(), uid2, o.id, text, now, actor.name, label, what));
    // 同时发系统推送；tag 用订单 id，同一张单只留最新一条
    P.sendToUsers([...ids], { title: label, body: `${actor.name} ${what}`, url: `/?order=${o.id}`, tag: `order-${o.id}` });
  } catch (e) { console.error("[notify] 生成通知失败", e); }
}

// ---------- 认证 ----------
router.post("/login", (req, res) => {
  const { phone, password } = req.body || {};
  const u = db.prepare("SELECT * FROM users WHERE phone = ? AND deleted = 0").get(String(phone || "").trim());
  if (!u || !A.verifyPassword(password || "", u.password_hash))
    return res.status(400).json({ error: "手机号或密码不正确" });
  res.json({ token: A.signToken(u), user: A.userPublic(u) });
});


// 导出的一次性下载链接：浏览器直接打开带不了登录头，凭票据放行(见 /export/ticket)
router.get("/export/file", (req, res, next) => {
  const tk = takeExportTicket(req.query.t);
  const u = tk && activeUser(tk.userId);
  if (!u || u.role !== "admin") {
    return res.status(410).type("text/plain; charset=utf-8").send("下载链接已失效，请回到系统里重新点「导出」");
  }
  sendExport(u, tk.season, res, next);
});

router.use(A.authRequired);

router.get("/bootstrap", (req, res) => {
  res.json({
    me: A.userPublic(req.user),
    users: activeUsers().map(A.userPublic),
    fields: getFields(),
    factories: getFactories(),
    roles: getSetting("roles", []),
    seasons: getSetting("seasons", []),
    orders: visibleOrdersPublic(req.user)
  });
});

router.post("/password/change", (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: "新密码至少 4 位" });
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(A.hashPassword(newPassword), req.user.id);
  res.json({ ok: true });
});

// ---------- 员工账号（管理员） ----------
router.get("/users", A.adminRequired, (req, res) => {
  res.json(activeUsers().map(A.userPublic));
});

router.post("/users", A.adminRequired, (req, res) => {
  const { name, phone, role, password } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: "请填写姓名和手机号" });
  if (!getSetting("roles", []).some(r => r.k === role)) return res.status(400).json({ error: "职位不存在" });
  const exists = db.prepare("SELECT id FROM users WHERE phone = ? AND deleted = 0").get(String(phone).trim());
  if (exists) return res.status(400).json({ error: "该手机号已存在" });
  const id = uid();
  db.prepare("INSERT INTO users(id,name,phone,password_hash,role,deleted,created_at) VALUES(?,?,?,?,?,0,?)")
    .run(id, String(name).trim(), String(phone).trim(), A.hashPassword(password || "123456"), role, Date.now());
  res.json(A.userPublic(activeUser(id)));
});

router.patch("/users/:id", A.adminRequired, (req, res) => {
  const u = activeUser(req.params.id);
  if (!u) return res.status(404).json({ error: "员工不存在" });
  const { name, phone, role } = req.body || {};
  if (role !== undefined) {
    if (u.id === req.user.id) return res.status(400).json({ error: "不能修改自己的职位" });
    if (u.role === "admin") return res.status(400).json({ error: "不能修改管理员的职位" });
    if (!getSetting("roles", []).some(r => r.k === role)) return res.status(400).json({ error: "职位不存在" });
    db.prepare("UPDATE users SET role=? WHERE id=?").run(role, u.id);
  }
  if (name !== undefined && String(name).trim()) db.prepare("UPDATE users SET name=? WHERE id=?").run(String(name).trim(), u.id);
  if (phone !== undefined && String(phone).trim()) {
    const dup = db.prepare("SELECT id FROM users WHERE phone=? AND id<>? AND deleted=0").get(String(phone).trim(), u.id);
    if (dup) return res.status(400).json({ error: "该手机号已被占用" });
    db.prepare("UPDATE users SET phone=? WHERE id=?").run(String(phone).trim(), u.id);
  }
  res.json(A.userPublic(activeUser(u.id)));
});

router.post("/users/:id/reset-password", A.adminRequired, (req, res) => {
  const u = activeUser(req.params.id);
  if (!u) return res.status(404).json({ error: "员工不存在" });
  const { password } = req.body || {};
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(A.hashPassword(password || "123456"), u.id);
  res.json({ ok: true });
});

router.delete("/users/:id", A.adminRequired, (req, res) => {
  const u = activeUser(req.params.id);
  if (!u) return res.status(404).json({ error: "员工不存在" });
  if (u.id === req.user.id) return res.status(400).json({ error: "不能删除自己的账号" });
  if (u.role === "admin") return res.status(400).json({ error: "不能删除管理员账号" });
  db.prepare("UPDATE users SET deleted=1 WHERE id=?").run(u.id);
  res.json({ ok: true });
});

// ---------- 自定义字段 / 工厂下拉（管理员） ----------
router.post("/fields", A.adminRequired, (req, res) => {
  const { section, label, type, options } = req.body || {};
  if (!["order", "production"].includes(section)) return res.status(400).json({ error: "板块不对" });
  const lb = String(label || "").trim();
  if (!lb) return res.status(400).json({ error: "请填写字段名称" });
  const fields = getFields();
  if (fields[section].some(x => x.label === lb)) return res.status(400).json({ error: `「${lb}」字段已存在，不能重复添加` });
  const f = { k: "f" + Date.now(), label: lb, type: type || "text" };
  if (type === "select") f.options = (options || []).map(s => String(s).trim()).filter(Boolean);
  fields[section].push(f);
  setSetting("fields", fields);
  if (type === "log") {  // 已有订单补上该进度字段
    db.prepare("SELECT id, data FROM orders").all().forEach(r => {
      const d = JSON.parse(r.data); d.logs = d.logs || {}; if (!d.logs[f.k]) d.logs[f.k] = [];
      db.prepare("UPDATE orders SET data=? WHERE id=?").run(JSON.stringify(d), r.id);
    });
  }
  res.json(fields);
});

router.delete("/fields/:section/:key", A.adminRequired, (req, res) => {
  const { section, key } = req.params;
  const fields = getFields();
  if (!fields[section]) return res.status(400).json({ error: "板块不对" });
  const f = fields[section].find(x => x.k === key);
  if (!f) return res.status(404).json({ error: "字段不存在" });
  if (f.core) return res.status(400).json({ error: "核心字段不可删除" });
  fields[section] = fields[section].filter(x => x.k !== key);
  setSetting("fields", fields);
  res.json(fields);
});

router.post("/factories", A.adminRequired, (req, res) => {
  const { kind, name } = req.body || {};
  const factories = getFactories();
  if (!factories[kind]) return res.status(400).json({ error: "类型不对" });
  const v = String(name || "").trim();
  if (v && !factories[kind].includes(v)) factories[kind].push(v);
  setSetting("factories", factories);
  res.json(factories);
});

router.delete("/factories/:kind/:name", A.adminRequired, (req, res) => {
  const { kind, name } = req.params;
  const factories = getFactories();
  if (!factories[kind]) return res.status(400).json({ error: "类型不对" });
  factories[kind] = factories[kind].filter(x => x !== decodeURIComponent(name));
  setSetting("factories", factories);
  res.json(factories);
});

// ---------- 季节（管理员） ----------
router.post("/seasons", A.adminRequired, (req, res) => {
  const name = String((req.body || {}).name || "").trim();
  if (!name) return res.status(400).json({ error: "请填写季节名称" });
  const seasons = getSetting("seasons", []);
  if (seasons.includes(name)) return res.status(400).json({ error: "已有同名季节" });
  seasons.push(name);
  setSetting("seasons", seasons);
  res.json(seasons);
});

router.delete("/seasons/:name", A.adminRequired, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const seasons = getSetting("seasons", []);
  if (!seasons.includes(name)) return res.status(404).json({ error: "季节不存在" });
  const used = db.prepare("SELECT COUNT(*) c FROM orders WHERE season = ?").get(name).c;
  if (used) return res.status(400).json({ error: `还有 ${used} 个订单是「${name}」季节，请先修改这些订单的季节` });
  const next = seasons.filter(x => x !== name);
  setSetting("seasons", next);
  res.json(next);
});

// ---------- 订单 ----------
router.get("/orders", (req, res) => res.json(visibleOrdersPublic(req.user)));
router.get("/orders/:id", withOrder, (req, res) => {
  const o = req.order;
  if (!A.canViewOrder(req.user, o)) return res.status(403).json({ error: "无权查看此订单" });
  res.json(orderPublic(o));
});

router.post("/orders", (req, res) => {
  if (!A.canCreateOrder(req.user)) return res.status(403).json({ error: "只有业务员或管理员可以新建订单" });
  const { season, values } = req.body || {};
  const v = cleanOrderValues(values);
  if (!v.styleNo && !v.styleName) return res.status(400).json({ error: "请至少填写货号或款式名" });
  if (req.user.role === "sales" && !v.sales) v.sales = req.user.id;
  const id = uid(), now = Date.now();
  db.prepare("INSERT INTO orders(id,season,created_by,created_at,updated_at,data) VALUES(?,?,?,?,?,?)")
    .run(id, season || "未分季", req.user.id, now, now, JSON.stringify(emptyOrderData(v)));
  res.json(orderPublic(loadOrder(id)));
});

const IMPORT_MAX_ROWS = 500;
router.post("/orders/import", (req, res) => {
  if (!A.canCreateOrder(req.user)) return res.status(403).json({ error: "只有业务员或管理员可以导入" });
  const rows = Array.isArray(req.body && req.body.orders) ? req.body.orders : [];
  if (rows.length > IMPORT_MAX_ROWS) return res.status(400).json({ error: `一次最多导入 ${IMPORT_MAX_ROWS} 单，请分批导入` });
  const now = Date.now();
  const ins = db.prepare("INSERT INTO orders(id,season,created_by,created_at,updated_at,data) VALUES(?,?,?,?,?,?)");
  // 整批一个事务：要么全进要么全不进
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const v = cleanOrderValues(r && r.values);
      if (!v.styleNo && !v.styleName) continue;
      if (req.user.role === "sales" && !v.sales) v.sales = req.user.id;
      ins.run(uid(), String((r && r.season) || "").trim() || "未分季", req.user.id, now, now, JSON.stringify(emptyOrderData(v)));
      n++;
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  if (!n) return res.status(400).json({ error: "没有可导入的订单（每单至少要有货号或款式名）" });
  res.json({ imported: n });
});

router.patch("/orders/:id", withOrder, (req, res) => {
  const o = req.order;
  if (!A.canEditBasic(req.user, o)) return res.status(403).json({ error: "无权修改此订单的基本信息" });
  const { season, values } = req.body || {};
  // 季节算「一、订单明细」；其余字段按所属板块分别校验
  if (season !== undefined && String(season).trim()) {
    if (!A.canEditSection(req.user, o, "order")) return res.status(403).json({ error: "无权修改「一、订单明细」的内容" });
    o.season = String(season).trim();
  }
  if (values && typeof values === "object") {
    for (const key of Object.keys(values)) {
      if (key === "shipDate") {
        // 发货日期填写后只有管理员/主管能改
        if (A.shipLocked(o) && !A.isAdmin(req.user) && !A.isSupervisor(req.user)) {
          return res.status(403).json({ error: "发货日期一经填写，只有管理员或主管能再修改" });
        }
        if (!A.canEditBasic(req.user, o)) {
          return res.status(403).json({ error: "无权修改发货日期" });
        }
        continue;
      }
      // 改派下厂员算「一、订单明细」的权限
      if (key === "follower") {
        if (!A.canEditSection(req.user, o, "order")) {
          return res.status(403).json({ error: "无权指定下厂员" });
        }
        continue;
      }
      const section = sectionOfKey(key);
      if (!A.canEditSection(req.user, o, section)) {
        return res.status(403).json({ error: `无权修改「${section === "order" ? "一、订单明细" : "二、生产明细"}」的内容` });
      }
    }
    o.data.values = Object.assign({}, o.data.values, cleanOrderValues(values));
  }
  saveOrder(o);
  // 通知：改一个字段写明新值，改多个列出字段名
  const changedKeys = (values && typeof values === "object") ? Object.keys(values) : [];
  if (season !== undefined) changedKeys.unshift("season");
  if (changedKeys.length) {
    let what;
    if (changedKeys.length === 1) {
      const key = changedKeys[0];
      const val = key === "season" ? o.season : values[key];
      const valText = fieldValueText(key, val);
      what = valText ? `把「${changeLabelOf(key)}」改成了${valText}` : `修改了「${changeLabelOf(key)}」`;
    } else {
      const labels = changedKeys.map(changeLabelOf);
      what = labels.length > 3
        ? `修改了「${labels.slice(0, 3).join("、")}」等${labels.length}项`
        : `修改了「${labels.join("、")}」`;
    }
    notifyOrder(req.user, o, what);
  }
  res.json(orderPublic(o));
});

router.delete("/orders/:id", A.adminRequired, withOrder, (req, res) => {
  const o = req.order;
  db.prepare("DELETE FROM orders WHERE id=?").run(o.id);
  res.json({ ok: true });
});

// ---------- 打卡记录 ----------
router.post("/orders/:id/logs", withOrder, (req, res) => {
  const o = req.order;
  const { key, text, process, workers, estDone } = req.body || {};
  const section = sectionOfKey(key);
  if (!A.canAddLog(req.user, o, section)) return res.status(403).json({ error: "你没有权限在此订单打卡" });
  const list = listForKey(o, key);
  if (!list) return res.status(400).json({ error: "字段不存在" });
  const t = String(text || "").trim();
  const photos = cleanPhotos((req.body || {}).photos);
  const entry = { id: uid(), by: req.user.id, byName: req.user.name, t: Date.now(), text: t, photos };
  // 本厂/加工点打卡必填工序、人数、预计下车时间
  if (key === "mainLog" || String(key).startsWith("sub:")) {
    const proc = String(process || "").trim(), wk = String(workers || "").trim(), est = String(estDone || "").trim();
    if (!proc || !wk || !est) return res.status(400).json({ error: "请填写生产工序、车工人数、预计下车时间" });
    Object.assign(entry, { process: proc, workers: wk, estDone: est });
  } else if (!t && !photos.length) return res.status(400).json({ error: "请填写打卡内容或添加照片" });
  list.push(entry);
  saveOrder(o);
  notifyOrder(req.user, o, `更新了「${logLabelOf(o, key)}」`);
  res.json(orderPublic(o));
});

router.patch("/orders/:id/logs/:key/:entryId", withOrder, (req, res) => {
  const o = req.order;
  const { e } = logEntryOf(o, req.params.key, req.params.entryId);
  if (!e) return res.status(404).json({ error: "记录不存在" });
  if (!A.canTouchEntry(req.user, o, e, sectionOfKey(req.params.key))) return res.status(403).json({ error: "无权修改这条打卡记录" });
  const t = String((req.body || {}).text || "").trim();
  const photos = Array.isArray((req.body || {}).photos) ? cleanPhotos((req.body || {}).photos) : (e.photos || []);
  if (!t && !photos.length) return res.status(400).json({ error: "内容和照片不能都为空" });
  e.text = t; e.photos = photos; saveOrder(o);
  res.json(orderPublic(o));
});

router.delete("/orders/:id/logs/:key/:entryId", withOrder, (req, res) => {
  const o = req.order;
  const { list, e } = logEntryOf(o, req.params.key, req.params.entryId);
  if (!e) return res.status(404).json({ error: "记录不存在" });
  if (!A.canTouchEntry(req.user, o, e, sectionOfKey(req.params.key))) return res.status(403).json({ error: "无权删除这条打卡记录" });
  list.splice(list.indexOf(e), 1); saveOrder(o);
  res.json(orderPublic(o));
});

router.post("/orders/:id/subs", withOrder, (req, res) => {
  const o = req.order;
  // 加工点属于生产明细结构，看编辑权而不是打卡权
  if (!A.canEditSection(req.user, o, "production")) return res.status(403).json({ error: "无权添加加工点" });
  const name = String((req.body || {}).name || "").trim();
  if (!name) return res.status(400).json({ error: "请填写加工点名称" });
  o.data.subs = o.data.subs || [];
  o.data.subs.push({ id: uid(), name, log: [] });
  saveOrder(o);
  res.json(orderPublic(o));
});

router.patch("/orders/:id/subs/:subId", withOrder, (req, res) => {
  const o = req.order;
  if (!A.canEditSection(req.user, o, "production")) return res.status(403).json({ error: "无权修改" });
  const sub = (o.data.subs || []).find(x => x.id === req.params.subId);
  if (!sub) return res.status(404).json({ error: "加工点不存在" });
  const name = String((req.body || {}).name || "").trim();
  if (!name) return res.status(400).json({ error: "名称不能为空" });
  sub.name = name; saveOrder(o);
  res.json(orderPublic(o));
});

router.delete("/orders/:id/subs/:subId", A.adminRequired, withOrder, (req, res) => {
  const o = req.order;
  const before = (o.data.subs || []).length;
  o.data.subs = (o.data.subs || []).filter(x => x.id !== req.params.subId);
  if (o.data.subs.length === before) return res.status(404).json({ error: "加工点不存在" });
  saveOrder(o);
  res.json(orderPublic(o));
});

/* ---------- 验货问题 ----------
 * 一次验货可记多条问题，下厂员逐条填整改情况 */
router.post("/orders/:id/inspections", withOrder, (req, res) => {
  const o = req.order;
  if (!A.canWriteInspProblem(req.user, o)) return res.status(403).json({ error: "无权在此订单记录验货发现的问题" });
  const problems = ((req.body || {}).problems || []).map(x => String(x || "").trim()).filter(Boolean);
  const inspPhotos = cleanPhotos((req.body || {}).photos);
  if (!problems.length && !inspPhotos.length) return res.status(400).json({ error: "请至少填写一条发现的问题或添加照片" });
  const now = Date.now();
  const items = problems.map(p => ({
    id: uid(), problem: p, problemBy: req.user.id, problemByName: req.user.name, problemAt: now,
    fix: "", fixBy: null, fixByName: "", fixAt: null, notes: []
  }));
  o.data.inspections.push({ id: uid(), t: now, by: req.user.id, byName: req.user.name, photos: inspPhotos, items });
  saveOrder(o);
  notifyOrder(req.user, o, "新增了验货问题");
  res.json(orderPublic(o));
});

// 改「发现问题」或「整改情况」，两项分别校验权限
router.patch("/orders/:id/inspections/:instId/items/:itemId", withOrder, (req, res) => {
  const o = req.order;
  const item = inspItemOf(o, req.params.instId, req.params.itemId);
  if (!item) return res.status(404).json({ error: "记录不存在" });
  const body = req.body || {};
  let touched = false;
  const whats = [];
  if (body.problem !== undefined) {
    if (!A.canWriteInspProblem(req.user, o)) return res.status(403).json({ error: "无权修改发现的问题" });
    const v = String(body.problem).trim();
    if (!v) return res.status(400).json({ error: "发现的问题不能为空" });
    item.problem = v; item.problemBy = req.user.id; item.problemByName = req.user.name; item.problemAt = Date.now();
    touched = true; whats.push("修改了验货问题");
  }
  if (body.fix !== undefined) {
    if (!A.canWriteInspFix(req.user, o)) return res.status(403).json({ error: "只有本单负责下厂员或管理员可以填写整改情况" });
    item.fix = String(body.fix).trim(); item.fixBy = req.user.id; item.fixByName = req.user.name; item.fixAt = Date.now();
    touched = true; whats.push("填写了验货整改情况");
  }
  if (!touched) return res.status(400).json({ error: "没有可修改的内容" });
  saveOrder(o);
  notifyOrder(req.user, o, whats.join("、"));
  res.json(orderPublic(o));
});

// 补充说明：双方都能追加，不覆盖原内容
router.post("/orders/:id/inspections/:instId/items/:itemId/notes", withOrder, (req, res) => {
  const o = req.order;
  const item = inspItemOf(o, req.params.instId, req.params.itemId);
  if (!item) return res.status(404).json({ error: "记录不存在" });
  if (!A.canWriteInspProblem(req.user, o) && !A.canWriteInspFix(req.user, o)) return res.status(403).json({ error: "无权添加补充说明" });
  const text = String((req.body || {}).text || "").trim();
  if (!text) return res.status(400).json({ error: "请填写补充说明" });
  item.notes = item.notes || [];
  item.notes.push({ id: uid(), by: req.user.id, byName: req.user.name, t: Date.now(), text });
  saveOrder(o);
  res.json(orderPublic(o));
});

router.delete("/orders/:id/inspections/:inspId", withOrder, (req, res) => {
  const o = req.order;
  const g = o.data.inspections.find(x => x.id === req.params.inspId);
  if (!g) return res.status(404).json({ error: "记录不存在" });
  if (!A.canTouchEntry(req.user, o, g)) return res.status(403).json({ error: "无权删除这条验货记录" });
  o.data.inspections = o.data.inspections.filter(x => x.id !== g.id); saveOrder(o);
  res.json(orderPublic(o));
});

// ---------- 跟单小结 ----------
router.post("/orders/:id/follow", withOrder, (req, res) => {
  const o = req.order;
  if (!A.canAddLog(req.user, o)) return res.status(403).json({ error: "无权在此订单添加跟单小结" });
  const t = String((req.body || {}).text || "").trim();
  const photos = cleanPhotos((req.body || {}).photos);
  if (!t && !photos.length) return res.status(400).json({ error: "请填写内容或添加照片" });
  o.data.followIssues.push({ id: uid(), by: req.user.id, byName: req.user.name, t: Date.now(), text: t, photos });
  saveOrder(o);
  notifyOrder(req.user, o, "新增了跟单小结");
  res.json(orderPublic(o));
});

router.delete("/orders/:id/follow/:entryId", withOrder, (req, res) => {
  const o = req.order;
  const e = o.data.followIssues.find(x => x.id === req.params.entryId);
  if (!e) return res.status(404).json({ error: "记录不存在" });
  if (!A.canTouchEntry(req.user, o, e)) return res.status(403).json({ error: "无权删除这条记录" });
  o.data.followIssues = o.data.followIssues.filter(x => x.id !== e.id); saveOrder(o);
  res.json(orderPublic(o));
});

// ---------- 职位（管理员） ----------
router.get("/roles", (req, res) => res.json(getSetting("roles", [])));

router.post("/roles", A.adminRequired, (req, res) => {
  const { label, template } = req.body || {};
  const name = String(label || "").trim();
  if (!name) return res.status(400).json({ error: "请填写职位名称" });
  if (!["sales", "follower", "supervisor"].includes(template))
    return res.status(400).json({ error: "请选择权限模板（业务员权限 / 下厂员权限 / 主管权限）" });
  const roles = getSetting("roles", []);
  if (roles.some(r => r.label === name)) return res.status(400).json({ error: "已有同名职位" });
  roles.push({ k: "r" + Date.now(), label: name, template });
  setSetting("roles", roles);
  res.json(roles);
});

router.delete("/roles/:k", A.adminRequired, (req, res) => {
  const roles = getSetting("roles", []);
  const r = roles.find(x => x.k === req.params.k);
  if (!r) return res.status(404).json({ error: "职位不存在" });
  if (r.core) return res.status(400).json({ error: "内置职位不可删除" });
  const used = db.prepare("SELECT COUNT(*) c FROM users WHERE role = ? AND deleted = 0").get(r.k).c;
  if (used) return res.status(400).json({ error: `还有 ${used} 位员工是「${r.label}」，请先把他们改成其它职位` });
  setSetting("roles", roles.filter(x => x.k !== r.k));
  res.json(roles.filter(x => x.k !== r.k));
});

// 配置职位权限；perms:null 恢复模板默认。管理员职位永远全权，不在此配置
router.patch("/roles/:k/perms", A.adminRequired, (req, res) => {
  const roles = getSetting("roles", []);
  const r = roles.find(x => x.k === req.params.k);
  if (!r) return res.status(404).json({ error: "职位不存在" });
  const body = (req.body || {}).perms;
  if (body === null) { delete r.perms; setSetting("roles", roles); return res.json(roles); }
  if (!body || typeof body !== "object") return res.status(400).json({ error: "权限配置格式不对" });
  // 只收已知键
  const clean = {};
  if (body.scope === "all" || body.scope === "own") clean.scope = body.scope;
  A.PERM_KEYS.forEach(k => { if (typeof body[k] === "boolean") clean[k] = body[k]; });
  r.perms = clean;
  setSetting("roles", roles);
  res.json(roles);
});

// ---------- 私人聊天 ----------
// 联系人：在职同事 + 最后一条消息 + 未读数；有记录的按时间排前
router.get("/chat/contacts", (req, res) => {
  const meId = req.user.id;
  const others = db.prepare("SELECT * FROM users WHERE deleted = 0 AND id <> ?").all(meId);
  const lastStmt = db.prepare(`SELECT * FROM messages
      WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
      ORDER BY created_at DESC LIMIT 1`);
  const unreadStmt = db.prepare("SELECT COUNT(*) c FROM messages WHERE from_user = ? AND to_user = ? AND read_at IS NULL");
  const list = others.map(u => {
    const last = lastStmt.get(meId, u.id, u.id, meId);
    return Object.assign(A.userPublic(u), {
      unread: unreadStmt.get(u.id, meId).c,
      last: last ? { text: last.text || (last.attachment ? "[附件]" : ""), t: last.created_at,
        fromMe: last.from_user === meId } : null
    });
  });
  list.sort((a, b) => {
    if (a.last && b.last) return b.last.t - a.last.t;
    if (a.last) return -1;
    if (b.last) return 1;
    return a.name.localeCompare(b.name, "zh");
  });
  res.json(list);
});

router.get("/chat/unread", (req, res) => {
  const rows = db.prepare("SELECT from_user, COUNT(*) c FROM messages WHERE to_user = ? AND read_at IS NULL GROUP BY from_user")
    .all(req.user.id);
  const byUser = {};
  let total = 0;
  rows.forEach(r => { byUser[r.from_user] = r.c; total += r.c; });
  res.json({ total, byUser });
});

// 打开对话即把对方消息标为已读
router.get("/chat/with/:userId", (req, res) => {
  const meId = req.user.id, otherId = req.params.userId;
  const other = activeUser(otherId);
  if (!other) return res.status(404).json({ error: "该同事不存在或已离职" });
  db.prepare("UPDATE messages SET read_at = ? WHERE from_user = ? AND to_user = ? AND read_at IS NULL")
    .run(Date.now(), otherId, meId);
  const msgs = db.prepare(`SELECT * FROM messages
      WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
      ORDER BY created_at ASC`).all(meId, otherId, otherId, meId);
  res.json({
    contact: A.userPublic(other),
    messages: msgs.map(m => ({ id: m.id, text: m.text, t: m.created_at, fromMe: m.from_user === meId,
      attachment: m.attachment ? JSON.parse(m.attachment) : null }))
  });
});

router.post("/chat/with/:userId", (req, res) => {
  const meId = req.user.id, otherId = req.params.userId;
  if (otherId === meId) return res.status(400).json({ error: "不能给自己发消息" });
  const other = activeUser(otherId);
  if (!other) return res.status(404).json({ error: "该同事不存在或已离职" });
  const text = String((req.body || {}).text || "").trim();
  const att = (req.body || {}).attachment || null;
  if (!text && !att) return res.status(400).json({ error: "消息不能为空" });
  if (text.length > 2000) return res.status(400).json({ error: "消息太长了" });
  db.prepare("INSERT INTO messages(id,from_user,to_user,text,attachment,created_at,read_at) VALUES(?,?,?,?,?,?,NULL)")
    .run(uid(), meId, otherId, text, att ? JSON.stringify(att) : null, Date.now());
  // tag 用发信人 id，连发只留最新一条通知
  P.sendToUsers([otherId], {
    title: req.user.name,
    body: text ? text.slice(0, 60) : "[图片]",
    url: `/?chat=${meId}`, tag: `chat-${meId}`
  });
  res.json({ ok: true });
});

// ---------- 应用内通知 ----------
const NOTIF_LIMIT = 50;

router.get("/notifications", (req, res) => {
  const rows = db.prepare(`SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ${NOTIF_LIMIT}`)
    .all(req.user.id);
  // actorName/orderLabel/what 老通知为 NULL，前端退回纯文本
  res.json(rows.map(r => ({
    id: r.id, orderId: r.order_id, text: r.text, createdAt: r.created_at, read: !!r.read_at,
    actorName: r.actor_name, orderLabel: r.order_label, what: r.what
  })));
});

router.get("/notifications/unread-count", (req, res) => {
  const c = db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND read_at IS NULL").get(req.user.id).c;
  res.json({ total: c });
});

router.post("/notifications/read-all", (req, res) => {
  db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(Date.now(), req.user.id);
  res.json({ ok: true });
});

function ownNotif(req, res) {
  const row = db.prepare("SELECT * FROM notifications WHERE id = ?").get(req.params.id);
  if (!row) res.status(404).json({ error: "通知不存在" });
  else if (row.user_id !== req.user.id) res.status(403).json({ error: "无权操作这条通知" });
  else return row;
}
router.post("/notifications/:id/read", (req, res) => {
  const row = ownNotif(req, res); if (!row) return;
  if (!row.read_at) db.prepare("UPDATE notifications SET read_at = ? WHERE id = ?").run(Date.now(), row.id);
  res.json({ ok: true });
});

// ?read=1 清空自己的已读通知
router.delete("/notifications", (req, res) => {
  if (req.query.read !== "1") return res.status(400).json({ error: "只支持清空已读通知" });
  const r = db.prepare("DELETE FROM notifications WHERE user_id = ? AND read_at IS NOT NULL").run(req.user.id);
  res.json({ ok: true, deleted: r.changes });
});

router.delete("/notifications/:id", (req, res) => {
  const row = ownNotif(req, res); if (!row) return;
  db.prepare("DELETE FROM notifications WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

// ---------- 系统推送订阅（见 push.js） ----------
router.get("/push/key", (req, res) => res.json({ publicKey: P.publicKey() }));

router.post("/push/subscribe", (req, res) => {
  const ok = P.saveSubscription(req.user.id, (req.body || {}).subscription, req.headers["user-agent"]);
  if (!ok) return res.status(400).json({ error: "订阅信息不完整" });
  res.json({ ok: true, devices: P.countOf(req.user.id) });
});

// 只能退订自己的设备
router.post("/push/unsubscribe", (req, res) => {
  const endpoint = String((req.body || {}).endpoint || "");
  const row = db.prepare("SELECT user_id FROM push_subscriptions WHERE endpoint = ?").get(endpoint);
  if (row && row.user_id !== req.user.id) return res.status(403).json({ error: "无权操作这个订阅" });
  P.removeSubscription(endpoint);
  res.json({ ok: true, devices: P.countOf(req.user.id) });
});

// ---------- 员工历史打卡（本人或管理员） ----------
router.get("/users/:id/logs", (req, res) => {
  const targetId = req.params.id;
  if (targetId !== req.user.id && req.user.role !== "admin")
    return res.status(403).json({ error: "只能查看自己的打卡记录" });
  const logFs = logFields();
  const rows = [];
  allOrdersPublic().forEach(o => {
    const tag = { styleNo: o.values.styleNo || "", styleName: o.values.styleName || "", orderId: o.id };
    logFs.forEach(f => (o.logs[f.k] || []).forEach(e => {
      if (e.by === targetId) rows.push(Object.assign({ label: f.label, text: e.text, t: e.t }, tag));
    }));
    (o.mainLog || []).forEach(e => {
      if (e.by === targetId) rows.push(Object.assign({ label: "主厂", text: e.text, t: e.t }, tag));
    });
    (o.subs || []).forEach(sub => sub.log.forEach(e => {
      if (e.by === targetId) rows.push(Object.assign({ label: "生产进度·" + sub.name, text: e.text, t: e.t }, tag));
    }));
    o.followIssues.forEach(e => {
      if (e.by === targetId) rows.push(Object.assign({ label: "跟单小结", text: e.text, t: e.t }, tag));
    });
    o.inspections.forEach(g => (g.items || []).forEach(it => {
      if (it.problemBy === targetId) rows.push(Object.assign({ label: "验货·发现问题", text: it.problem, t: it.problemAt }, tag));
      if (it.fixBy === targetId) rows.push(Object.assign({ label: "验货·整改情况", text: it.fix, t: it.fixAt }, tag));
      (it.notes || []).forEach(n => {
        if (n.by === targetId) rows.push(Object.assign({ label: "验货·补充说明", text: n.text, t: n.t }, tag));
      });
    }));
  });
  rows.sort((a, b) => b.t - a.t);
  res.json(rows);
});

// ---------- 照片上传 ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, uid() + (path.extname(file.originalname || "").toLowerCase() || ".jpg"))
});
// 扩展名按类型白名单决定，不信客户端文件名(防止存成 .html 被同域打开)
const PHOTO_EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp" };
const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, uid() + PHOTO_EXT[file.mimetype])
});
const upload = multer({
  storage: photoStorage, limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, !!PHOTO_EXT[file.mimetype])
});
router.post("/upload", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "只支持 JPG / PNG / GIF / WebP 格式的图片" });
  res.json({ url: "/uploads/" + req.file.filename });
});

// ---------- 聊天附件 ----------
const OK_EXT = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic",
  ".pdf", ".xlsx", ".xls", ".csv", ".doc", ".docx", ".ppt", ".pptx", ".txt", ".zip"];
const chatUpload = multer({
  storage, limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, OK_EXT.includes(path.extname(file.originalname || "").toLowerCase()))
});
router.post("/chat/upload", chatUpload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "不支持的文件类型，或文件超过 20MB" });
  const name = Buffer.from(req.file.originalname || "文件", "latin1").toString("utf8");
  res.json({
    url: "/uploads/" + req.file.filename,
    name, size: req.file.size,
    isImage: /^image\//.test(req.file.mimetype)
  });
});

/* ---------- 导入：解析 Excel / CSV ----------
 * CSV 先按 UTF-8 解，出现乱码再按 GBK(Windows Excel 另存 CSV 默认 GBK) */
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const IMPORT_EXT = [".xlsx", ".xls", ".csv", ".txt"];

router.post("/import/parse", (req, res, next) => {
  memUpload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "文件太大（超过 50MB），请压缩图片后再导入" : "文件上传失败" });
    next();
  });
}, (req, res) => {
  if (!req.file) return res.status(400).json({ error: "请选择文件" });
  const ext = path.extname(req.file.originalname || "").toLowerCase();
  if (!IMPORT_EXT.includes(ext))
    return res.status(400).json({ error: "只支持 Excel(.xlsx/.xls) 和 CSV(.csv/.txt) 文件" });

  let wb, encoding = "UTF-8";
  try {
    if (ext === ".xlsx" || ext === ".xls") {
      wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true, dateNF: "yyyy-mm-dd" });
      encoding = "Excel";
    } else {
      let text = new TextDecoder("utf-8").decode(req.file.buffer);
      if (text.includes("\uFFFD")) {
        try { text = new TextDecoder("gbk").decode(req.file.buffer); encoding = "GBK"; } catch (e) { }
      }
      wb = XLSX.read(text, { type: "string", cellDates: true, dateNF: "yyyy-mm-dd" });
    }
  } catch (e) {
    return res.status(400).json({ error: "文件解析失败，请确认是有效的 Excel 或 CSV" });
  }

  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return res.status(400).json({ error: "表格里没有内容" });
  // WPS 表格声明的 !ref 常远大于实际数据(可达上百万行)，按实际有值的单元格收紧范围，免得同步阻塞整个服务
  const usedRange = (() => {
    let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
    Object.keys(ws).forEach(addr => {
      if (addr[0] === "!") return;
      const c = XLSX.utils.decode_cell(addr);
      if (c.r < minR) minR = c.r; if (c.r > maxR) maxR = c.r;
      if (c.c < minC) minC = c.c; if (c.c > maxC) maxC = c.c;
    });
    return minR === Infinity ? null : { s: { r: minR, c: minC }, e: { r: maxR, c: maxC } };
  })();
  const rawRows = usedRange
    ? XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "", range: usedRange })
        .map(r => r.map(c => (c == null ? "" : String(c).trim())))
    : [];
  // 过滤空行，并记下原始行号 -> 过滤后下标，给嵌入图片配对
  const rows = []; const origToFiltered = {};
  rawRows.forEach((r, origIdx) => { if (r.some(c => c !== "")) { origToFiltered[origIdx] = rows.length; rows.push(r); } });
  if (rows.length < 2) return res.status(400).json({ error: "至少需要表头和一行数据" });

  // 表格里贴的款式图：抠出来按行配对，失败不影响文字导入
  const rowImages = {};
  if (ext === ".xlsx") {
    try {
      const found = extractEmbeddedImages(req.file.buffer);
      Object.keys(found).forEach(origRow => {
        const filteredIdx = origToFiltered[origRow];
        if (filteredIdx === undefined) return;
        const img = found[origRow];
        if (img.data.length > 8 * 1024 * 1024) return;
        // 扩展名来自表格内部路径，同样只认白名单
        const fname = uid() + ([...Object.values(PHOTO_EXT), ".jpeg"].includes(img.ext) ? img.ext : ".png");
        fs.writeFileSync(path.join(UPLOAD_DIR, fname), img.data);
        rowImages[filteredIdx] = "/uploads/" + fname;
      });
    } catch (e) { /* 图片抠取失败就算了，不影响正常的表格文字导入 */ }
  }
  res.json({ rows, sheet: wb.SheetNames[0], encoding, rowImages });
});

/* ---------- 导出 Excel（管理员） ----------
 * 直接拼 xlsx 的 XML，边生成边发；照片逐张读取，内存里同时只有一张 */
const XML_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const THUMB_EMU = 60 * 9525, THUMB_STEP_EMU = 64 * 9525;  // 缩略图 60px，同格多图纵向排、间隔 4px
// 主题/样式取 SheetJS 默认的两份，启动时生成一次
const XLSX_THEME_STYLES = (() => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[""]]), "S");
  const zip = new AdmZip(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  return [["xl/theme/theme1.xml", zip.readFile("xl/theme/theme1.xml")], ["xl/styles.xml", zip.readFile("xl/styles.xml")]];
})();
const XML_ENT = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
// XML 转义规则同 SheetJS：特殊字符转实体，非法控制字符写成 _xHHHH_
const xmlEsc = s => String(s).replace(/[&<>"']/g, c => XML_ENT[c])
  .replace(/[\u0000-\u0008\u000b-\u001f\ufffe\uffff]/g, c => "_x" + c.charCodeAt(0).toString(16).padStart(4, "0") + "_");
const colName = i => (i >= 26 ? colName(Math.floor(i / 26) - 1) : "") + String.fromCharCode(65 + i % 26);
const photoList = p => (Array.isArray(p) ? p : [p]).filter(Boolean);
// 可嵌入的图片类型；其它扩展名按 jpg 处理
const IMAGE_TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", bmp: "image/bmp",
  tif: "image/tiff", tiff: "image/tiff", webp: "image/webp", emf: "image/x-emf", wmf: "image/x-wmf" };
const relsXml = rels => XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  rels.map(([id, type, target]) => `<Relationship Id="${id}" Type="${NS_REL}/${type}" Target="${target}"/>`).join("") + `</Relationships>`;

// 内容带换行或首尾空白时加 xml:space="preserve"，否则 Excel 会吞掉
const keepSpace = x => /(^\s|\s$|\n)/.test(x) ? ` xml:space="preserve"` : "";
function cellXml(v, ref) {
  if (v == null) return "";
  if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
  if (typeof v === "boolean") return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
  const x = xmlEsc(v), inner = `<v${keepSpace(x)}>${x}</v>`;
  return `<c r="${ref}" t="str"${keepSpace(inner)}>${inner}</c>`;
}

// 一张表 -> zip 里的文件：sheet XML，有照片时加 drawing 和两份 rels
function sheetFiles(n, sheet, media) {
  const photoCol = sheet.photoCol ?? sheet.header.length - 1;
  const anchors = [];
  const rows = [{ cells: sheet.header }, ...sheet.rows].map((row, r) => {
    const pics = photoList(row.photos).map(u => media.get(String(u))).filter(Boolean);
    pics.forEach((m, i) => anchors.push({ row: r, off: i * THUMB_STEP_EMU, m }));
    const ht = pics.length ? ` ht="${Math.max(20, pics.length * 64 * 0.75 + 3).toFixed(2)}" customHeight="1"` : "";
    const cells = row.cells.map((v, c) => cellXml(v, colName(c) + (r + 1))).join("");
    return `<row r="${r + 1}"${keepSpace(cells)}${ht}>${cells}</row>`;
  });
  const ref = `A1:${colName(sheet.header.length - 1)}${rows.length}`;
  const sheetXml = XML_HEAD + `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><dimension ref="${ref}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>` +
    (anchors.length ? `<cols><col min="${photoCol + 1}" max="${photoCol + 1}" width="11" customWidth="1"/></cols>` : "") +
    `<sheetData>${rows.join("")}</sheetData><ignoredErrors><ignoredError numberStoredAsText="1" sqref="${ref}"/></ignoredErrors>` +
    (anchors.length ? `<drawing r:id="rId1"/>` : "") + `</worksheet>`;
  if (!anchors.length) return [[`xl/worksheets/sheet${n}.xml`, sheetXml]];

  const drawingXml = XML_HEAD + `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS_REL}">` +
    anchors.map((a, i) => `<xdr:oneCellAnchor>` +
      `<xdr:from><xdr:col>${photoCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.row}</xdr:row><xdr:rowOff>${a.off}</xdr:rowOff></xdr:from>` +
      `<xdr:ext cx="${THUMB_EMU}" cy="${THUMB_EMU}"/><xdr:pic>` +
      `<xdr:nvPicPr><xdr:cNvPr id="${i + 1}" name="img${i + 1}"/><xdr:cNvPicPr/></xdr:nvPicPr>` +
      `<xdr:blipFill><a:blip r:embed="rId${i + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
      `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${THUMB_EMU}" cy="${THUMB_EMU}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>` +
      `</xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`).join("") + `</xdr:wsDr>`;
  return [
    [`xl/worksheets/sheet${n}.xml`, sheetXml],
    [`xl/worksheets/_rels/sheet${n}.xml.rels`, relsXml([["rId1", "drawing", `../drawings/drawing${n}.xml`]])],
    [`xl/drawings/drawing${n}.xml`, drawingXml],
    [`xl/drawings/_rels/drawing${n}.xml.rels`, relsXml(anchors.map((a, i) => [`rId${i + 1}`, "image", `../media/${a.m.name}`]))]
  ];
}

/* 极简 zip 流式打包。files: [文件名, 内容(字符串/Buffer/返回 Promise<Buffer> 的函数), 是否原样存]
 * 照片原样存(STORED)，XML 用 DEFLATE */
async function* zipChunks(files) {
  const central = [];
  let offset = 0;
  for (const [name, content, stored] of files) {
    const raw = typeof content === "function" ? await content() : Buffer.from(content);
    const data = stored ? raw : await deflateRaw(raw);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);  // 0x800：文件名 UTF-8
    local.writeUInt16LE(stored ? 0 : 8, 8); local.writeUInt16LE(0x21, 12);  // 日期 1980-01-01
    local.writeUInt32LE(zlib.crc32(raw), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    // 中央目录项 = 本地头字段 + 本地头偏移
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); local.copy(entry, 6, 4, 30); entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    yield Buffer.concat([local, nameBuf]);
    yield data;
    offset += local.length + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  yield dir;
  yield end;
}

const exportingUsers = new Set();  // 同一人同时只跑一份导出
router.get("/export", A.adminRequired, (req, res, next) => sendExport(req.user, req.query.season, res, next));

// 一次性下载链接：5 分钟有效、只能用一次，交给浏览器自带下载管理器下载；链接不含登录凭证
const exportTickets = new Map();
const EXPORT_TICKET_TTL = 5 * 60 * 1000;
router.post("/export/ticket", A.adminRequired, (req, res) => {
  if (exportingUsers.has(req.user.id)) return res.status(429).json({ error: "上一份导出还没完成，请稍候" });
  const now = Date.now();
  for (const [k, t] of exportTickets) if (t.exp < now) exportTickets.delete(k);
  const season = String((req.body || {}).season || "").trim();
  const count = season ? db.prepare("SELECT COUNT(*) c FROM orders WHERE season = ?").get(season).c
    : db.prepare("SELECT COUNT(*) c FROM orders").get().c;
  const ticket = crypto.randomBytes(24).toString("hex");
  exportTickets.set(ticket, { userId: req.user.id, season, exp: now + EXPORT_TICKET_TTL });
  res.json({ url: "/api/export/file?t=" + ticket, filename: exportFileName(season), count });
});
function takeExportTicket(t) {
  const tk = exportTickets.get(String(t || ""));
  if (!tk) return null;
  exportTickets.delete(String(t));
  return tk.exp >= Date.now() ? tk : null;
}
const today = () => new Date().toISOString().slice(0, 10);
const exportFileName = season => `订单导出-${season || "全部季节"}-${today()}.xlsx`;

async function sendExport(user, season, res, next) {
  if (exportingUsers.has(user.id)) return res.status(429).json({ error: "上一份导出还没完成，请稍候" });
  exportingUsers.add(user.id);
  res.on("close", () => exportingUsers.delete(user.id));
  res.setTimeout(120000, () => res.destroy());  // 连接僵死 2 分钟后断开
  try {
    const fieldList = allFields();
    const userNames = new Map(db.prepare("SELECT id,name FROM users").all().map(u => [u.id, u.name]));
    const nameOf = id => userNames.get(id) || id || "";
    const seasonFilter = String(season || "").trim();
    const orders = allOrdersPublic().filter(o => !seasonFilter || o.season === seasonFilter);
    const styleOf = o => o.values.styleNo || o.values.styleName || o.id;
    const timeText = t => t ? new Date(t).toLocaleString("zh-CN") : "";

    // 表一：订单基本信息，打卡字段取最新一条；货号固定在第二列
    const cols = fieldList.filter(f => f.k !== "styleNo");
    const imgCol = cols.findIndex(f => f.k === "img");
    const sheet1 = { name: "订单基本信息", header: ["季节", "货号", ...cols.map(f => f.label)], photoCol: 2 + imgCol,
      rows: orders.map(o => ({ photos: imgCol >= 0 ? o.values.img : null, cells: [o.season, styleOf(o), ...cols.map(f => {
        if (f.type === "log") {
          const l = (o.logs[f.k] || []).slice().sort((a, b) => b.t - a.t)[0];
          return l ? `${l.text}（${l.byName} ${timeText(l.t)}）` : "";
        }
        if (f.type === "image") return "";  // 款式图嵌在表格里，文字留空
        if (f.type === "user-sales" || f.type === "user-follower") return nameOf(o.values[f.k]);
        const v = o.values[f.k];
        return Array.isArray(v) ? v.join("、") : (v || "");
      })] })) };

    // 表二：生产进度，每条打卡一行
    const sheet2 = { name: "生产进度", header: ["季节", "货号", "环节", "生产工序", "车工人数", "预计下车时间", "内容", "记录人", "时间", "照片"], rows: [] };
    orders.forEach(o => {
      const add = (stage, e, p) => sheet2.rows.push({ photos: e.photos,
        cells: [o.season, styleOf(o), stage, p.process || "", p.workers || "", p.estDone || "", e.text || "", e.byName, timeText(e.t), ""] });
      (o.mainLog || []).forEach(e => add("主厂", e, e));
      (o.subs || []).forEach(s => (s.log || []).forEach(e => add(s.name, e, e)));
      fieldList.filter(f => f.type === "log").forEach(f => (o.logs[f.k] || []).forEach(e => add(f.label, e, {})));
    });

    // 表三：验货问题
    const sheet3 = { name: "验货问题", header: ["季节", "货号", "发现问题", "发现人", "发现时间", "整改情况", "整改人", "整改时间", "补充说明", "照片"],
      rows: orders.flatMap(o => (o.inspections || []).flatMap(g => (g.items || []).map(it => ({ photos: g.photos, cells: [
        o.season, styleOf(o), it.problem || "", it.problemByName || "", timeText(it.problemAt),
        it.fix || "（待整改）", it.fixByName || "", timeText(it.fixAt),
        (it.notes || []).map(n => `${n.byName}：${n.text}`).join("；"), ""] })))) };

    // 表四：跟单小结
    const sheet4 = { name: "跟单小结", header: ["季节", "货号", "记录人", "时间", "内容", "照片"],
      rows: orders.flatMap(o => (o.followIssues || []).map(e => ({ photos: e.photos, cells: [o.season, styleOf(o), e.byName, timeText(e.t), e.text || "", ""] }))) };
    const sheets = [sheet1, sheet2, sheet3, sheet4];

    // 只嵌存在的照片；同一张图只存一份
    const urls = [...new Set(sheets.flatMap(s => s.rows.flatMap(r => photoList(r.photos).map(String))))];
    const found = await Promise.all(urls.map(async u => {
      const rel = u.replace(/^\/+/, "");
      if (!rel.startsWith("uploads/")) return null;
      const file = path.join(UPLOAD_DIR, path.basename(rel));
      return (await fs.promises.stat(file).catch(() => null))?.isFile() ? file : null;
    }));
    const media = new Map();
    urls.forEach((u, i) => {
      const ext = path.extname(found[i] || "").slice(1).toLowerCase();
      if (found[i]) media.set(u, { file: found[i], name: `image${media.size + 1}.${IMAGE_TYPES[ext] ? ext : "jpg"}` });
    });
    const imageExts = [...new Set([...media.values()].map(m => m.name.split(".").pop()))];

    const parts = sheets.map((s, i) => sheetFiles(i + 1, s, media));
    const CT = "application/vnd.openxmlformats-officedocument.";
    const files = [
      ["[Content_Types].xml", XML_HEAD + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        imageExts.map(e => `<Default Extension="${e}" ContentType="${IMAGE_TYPES[e]}"/>`).join("") +
        `<Override PartName="/xl/workbook.xml" ContentType="${CT}spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="${CT}spreadsheetml.styles+xml"/>` +
        `<Override PartName="/xl/theme/theme1.xml" ContentType="${CT}theme+xml"/>` +
        parts.map((p, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${CT}spreadsheetml.worksheet+xml"/>` +
          (p.length > 1 ? `<Override PartName="/xl/drawings/drawing${i + 1}.xml" ContentType="${CT}drawing+xml"/>` : "")).join("") +
        `</Types>`],
      ["_rels/.rels", relsXml([["rId1", "officeDocument", "xl/workbook.xml"]])],
      ["xl/workbook.xml", XML_HEAD + `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>` +
        sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") + `</sheets></workbook>`],
      ["xl/_rels/workbook.xml.rels", relsXml([...sheets.map((s, i) => [`rId${i + 1}`, "worksheet", `worksheets/sheet${i + 1}.xml`]),
        ["rId5", "theme", "theme/theme1.xml"], ["rId6", "styles", "styles.xml"]])],
      ...XLSX_THEME_STYLES,
      ...parts.flat(),
      // 导出途中照片被删时放空图占位，不中断下载
      ...[...media.values()].map(m => [`xl/media/${m.name}`, () => fs.promises.readFile(m.file).catch(() => Buffer.alloc(0)), true])
    ];

    const fname = exportFileName(seasonFilter);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    // filename 是给老浏览器的英文名，新浏览器用 filename* 的中文名
    const asciiName = `orders-${seasonFilter.replace(/[^\w.-]/g, "") || "all"}-${today()}.xlsx`;
    res.setHeader("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    await pipeline(zipChunks(files), res);
  } catch (e) {
    if (!res.headersSent) next(e);  // 已开始发送后出错(多半是浏览器断开)，pipeline 会自行关闭连接
  }
}

module.exports = router;
