"use strict";
/**
 * 全部 API 路由，挂载在 /api 下。
 * 订单业务数据以 JSON 存在 orders.data 里，读出后形状与前端一致：
 *   { id, season, createdBy, createdAt, values, logs, subs, inspections, followIssues }
 * 所有写操作都在服务端做权限校验。
 */
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
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

/**
 * 从 xlsx（本质是个 zip 包）里把嵌入的图片(比如 WPS/Excel 表格里直接贴的款式图)抠出来，
 * 按图片锚定的行号(0-based，跟表头一起算，跟 sheet_to_json 的行下标对得上)配对。
 * 只处理"第一个工作表 + 它关联的 drawing"这个最常见的场景；解析失败/找不到就静默返回空，
 * 不影响正常的表格文字数据导入——图片是锦上添花，不是必须的。
 */
function extractEmbeddedImages(buf) {
  const images = {}; // 0-based 行号 -> { data: Buffer, ext: string }
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

/* ---------- 订单读写帮助 ---------- */
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
// 只接受本系统 /uploads/ 下的图片路径，最多 100 张，避免存入恶意 URL
function cleanPhotos(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(x => typeof x === "string" && /^\/uploads\/[\w.\-]+$/.test(x)).slice(0, 100);
}

function orderPublic(o) {
  return { id: o.id, season: o.season, createdBy: o.created_by, createdAt: o.created_at,
    values: o.data.values || {}, logs: o.data.logs || {}, mainLog: o.data.mainLog || [],
    subs: o.data.subs || [], inspections: o.data.inspections || [], followIssues: o.data.followIssues || [] };
}
function allOrdersPublic() {
  return db.prepare("SELECT * FROM orders").all().map(r => { r.data = JSON.parse(r.data); return orderPublic(r); });
}
// 订单列表可见范围：业务员只看自己创建/负责的，下厂员只看自己被指派的；主管/管理员不受限。
// (导出/员工历史打卡这两处要看全部订单的场景，仍然直接用上面的 allOrdersPublic，不经过这层过滤)
function visibleOrdersPublic(u) {
  const rows = db.prepare("SELECT * FROM orders").all().map(r => { r.data = JSON.parse(r.data); return r; });
  return rows.filter(r => A.canViewOrder(u, r)).map(orderPublic);
}
function logFields() {
  const f = getSetting("fields", { order: [], production: [] });
  return [...f.order, ...f.production].filter(x => x.type === "log");
}
function sectionOfKey(key) {
  if (key === "mainLog" || key.startsWith("sub:")) return "production";
  const f = getSetting("fields", { order: [], production: [] });
  return f.order.some(x => x.k === key) ? "order" : "production";
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
function emptyOrderData(values) {
  const logs = {};
  logFields().forEach(f => logs[f.k] = []);
  return { values: values || {}, logs, mainLog: [], subs: [], inspections: [], followIssues: [] };
}

/* ---------- 应用内通知 ----------
 * 订单被别人动过之后，给这张单的"相关人员"各生成一条通知：
 *   本单业务员(values.sales) / 下厂员(values.follower) / 创建人(created_by) + 所有主管/管理员。
 * 不通知操作者本人（自己改的自己知道）。颗粒度只到"谁在哪张单做了什么"，不做逐字段 diff。
 * 通知只是提醒，写失败不能连累主流程（订单本身已经保存成功了），所以整段包在 try 里。
 */
function orderLabel(o) {
  const v = (o.data && o.data.values) || {};
  return v.styleNo || v.styleName || o.id;
}
function fieldLabelOf(key) {
  const f = getSetting("fields", { order: [], production: [] });
  const hit = [...f.order, ...f.production].find(x => x.k === key);
  return hit ? hit.label : key;
}
// "season" 是订单上单独的一列，不在自定义字段列表里，通知文案里要单独给它一个说得清的名字
function changeLabelOf(key) { return key === "season" ? "订单季节" : fieldLabelOf(key); }
function fieldTypeOf(key) {
  if (key === "season") return "season";
  const f = getSetting("fields", { order: [], production: [] });
  const hit = [...f.order, ...f.production].find(x => x.k === key);
  return hit ? hit.type : null;
}
// 日期字符串 2026-08-15 -> 2026年8月15日，跟前端 fmtDate 保持一致的展示格式
function fmtDateVal(v) {
  const m = String(v).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  return m ? `${m[1]}年${+m[2]}月${+m[3]}日` : String(v);
}
// 通知里"改成了 XX"这个新值该怎么显示：
// 图片/打卡类字段不适合把值塞进一句话通知里，返回 null 表示只报字段名、不带值；
// 业务员/下厂员存的是用户 id，要查回姓名；文字类值太长会截断，避免通知被撑得很长
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
// 打卡的"环节"名字：本厂 / 加工点名字 / 进度字段名
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
    // 同一批人再发一次系统推送，App 没打开也能看到。标题放订单号，一眼知道是哪张单；
    // tag 用订单 id，同一张单连续改动只覆盖不堆叠，免得刷屏
    P.sendToUsers([...ids], { title: label, body: `${actor.name} ${what}`, url: `/?order=${o.id}`, tag: `order-${o.id}` });
  } catch (e) { console.error("[notify] 生成通知失败", e); }
}

/* =========================================================
 *  认证相关（无需登录）
 * ========================================================= */
router.post("/login", (req, res) => {
  const { phone, password } = req.body || {};
  const u = db.prepare("SELECT * FROM users WHERE phone = ? AND deleted = 0").get(String(phone || "").trim());
  if (!u || !A.verifyPassword(password || "", u.password_hash))
    return res.status(400).json({ error: "手机号或密码不正确" });
  res.json({ token: A.signToken(u), user: A.userPublic(u) });
});

// 已移除"凭手机号自助改密"（公网下会被拿来盗号）。
// 改密码：登录后在「我的」自行修改；忘记密码找管理员在后台重置。

/* 以下全部需要登录 */
router.use(A.authRequired);

router.get("/bootstrap", (req, res) => {
  res.json({
    me: A.userPublic(req.user),
    users: db.prepare("SELECT * FROM users WHERE deleted = 0").all().map(A.userPublic),
    fields: getSetting("fields", { order: [], production: [] }),
    factories: getSetting("factories", { emb: [], prod: [], proc: [] }),
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

/* =========================================================
 *  员工账号管理（管理员）
 * ========================================================= */
router.get("/users", A.adminRequired, (req, res) => {
  res.json(db.prepare("SELECT * FROM users WHERE deleted = 0").all().map(A.userPublic));
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
  res.json(A.userPublic(db.prepare("SELECT * FROM users WHERE id=?").get(id)));
});

// 修改员工：姓名 / 手机号 / 角色（角色可下拉改任何人，但不含自己）
router.patch("/users/:id", A.adminRequired, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!u || u.deleted) return res.status(404).json({ error: "员工不存在" });
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
  res.json(A.userPublic(db.prepare("SELECT * FROM users WHERE id=?").get(u.id)));
});

router.post("/users/:id/reset-password", A.adminRequired, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!u || u.deleted) return res.status(404).json({ error: "员工不存在" });
  const { password } = req.body || {};
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(A.hashPassword(password || "123456"), u.id);
  res.json({ ok: true });
});

router.delete("/users/:id", A.adminRequired, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!u || u.deleted) return res.status(404).json({ error: "员工不存在" });
  if (u.id === req.user.id) return res.status(400).json({ error: "不能删除自己的账号" });
  if (u.role === "admin") return res.status(400).json({ error: "不能删除管理员账号" });
  db.prepare("UPDATE users SET deleted=1 WHERE id=?").run(u.id);
  res.json({ ok: true });
});

/* =========================================================
 *  自定义字段 / 工厂下拉（管理员）
 * ========================================================= */
router.post("/fields", A.adminRequired, (req, res) => {
  const { section, label, type, options } = req.body || {};
  if (!["order", "production"].includes(section)) return res.status(400).json({ error: "板块不对" });
  const lb = String(label || "").trim();
  if (!lb) return res.status(400).json({ error: "请填写字段名称" });
  const fields = getSetting("fields", { order: [], production: [] });
  if (fields[section].some(x => x.label === lb)) return res.status(400).json({ error: `「${lb}」字段已存在，不能重复添加` });
  const f = { k: "f" + Date.now(), label: lb, type: type || "text" };
  if (type === "select") f.options = (options || []).map(s => String(s).trim()).filter(Boolean);
  fields[section].push(f);
  setSetting("fields", fields);
  if (type === "log") { // 给已有订单补上这个进度字段的空数组
    db.prepare("SELECT id, data FROM orders").all().forEach(r => {
      const d = JSON.parse(r.data); d.logs = d.logs || {}; if (!d.logs[f.k]) d.logs[f.k] = [];
      db.prepare("UPDATE orders SET data=? WHERE id=?").run(JSON.stringify(d), r.id);
    });
  }
  res.json(fields);
});

router.delete("/fields/:section/:key", A.adminRequired, (req, res) => {
  const { section, key } = req.params;
  const fields = getSetting("fields", { order: [], production: [] });
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
  const factories = getSetting("factories", { emb: [], prod: [], proc: [] });
  if (!factories[kind]) return res.status(400).json({ error: "类型不对" });
  const v = String(name || "").trim();
  if (v && !factories[kind].includes(v)) factories[kind].push(v);
  setSetting("factories", factories);
  res.json(factories);
});

router.delete("/factories/:kind/:name", A.adminRequired, (req, res) => {
  const { kind, name } = req.params;
  const factories = getSetting("factories", { emb: [], prod: [], proc: [] });
  if (!factories[kind]) return res.status(400).json({ error: "类型不对" });
  factories[kind] = factories[kind].filter(x => x !== decodeURIComponent(name));
  setSetting("factories", factories);
  res.json(factories);
});

/* ---------- 季节管理（管理员：新建订单可选的季节列表） ---------- */
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

/* =========================================================
 *  订单
 * ========================================================= */
// 建单/导入权限现在是职位上可配置的开关（见 auth.js 的 permsOf），三个模板默认都开着，行为不变
const canCreateOrder = (u) => A.canCreateOrder(u);

router.get("/orders", (req, res) => res.json(visibleOrdersPublic(req.user)));
router.get("/orders/:id", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  if (!A.canViewOrder(req.user, o)) return res.status(403).json({ error: "无权查看此订单" });
  res.json(orderPublic(o));
});

router.post("/orders", (req, res) => {
  if (!canCreateOrder(req.user)) return res.status(403).json({ error: "只有业务员或管理员可以新建订单" });
  const { season, values } = req.body || {};
  const v = values || {};
  if (!v.styleNo && !v.styleName) return res.status(400).json({ error: "请至少填写货号或款式名" });
  if (req.user.role === "sales" && !v.sales) v.sales = req.user.id;
  const id = uid(), now = Date.now();
  db.prepare("INSERT INTO orders(id,season,created_by,created_at,updated_at,data) VALUES(?,?,?,?,?,?)")
    .run(id, season || "未分季", req.user.id, now, now, JSON.stringify(emptyOrderData(v)));
  res.json(orderPublic(loadOrder(id)));
});

router.post("/orders/import", (req, res) => {
  if (!canCreateOrder(req.user)) return res.status(403).json({ error: "只有业务员或管理员可以导入" });
  const rows = (req.body && req.body.orders) || [];
  let n = 0; const now = Date.now();
  for (const r of rows) {
    const v = r.values || {};
    if (!v.styleNo && !v.styleName) continue;
    if (req.user.role === "sales" && !v.sales) v.sales = req.user.id;
    db.prepare("INSERT INTO orders(id,season,created_by,created_at,updated_at,data) VALUES(?,?,?,?,?,?)")
      .run(uid(), r.season || "未分季", req.user.id, now, now, JSON.stringify(emptyOrderData(v)));
    n++;
  }
  if (!n) return res.status(400).json({ error: "没有可导入的订单（每单至少要有货号或款式名）" });
  res.json({ imported: n });
});

router.patch("/orders/:id", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  if (!A.canEditBasic(req.user, o)) return res.status(403).json({ error: "无权修改此订单的基本信息" });
  const { season, values } = req.body || {};
  // 季节算"一、订单明细"的内容；values 里每个字段按它所属的板块(order/production)分别校验——
  // 业务员只能改"一、订单明细"，下厂员只能改"二、生产明细"，主管/管理员不受限
  if (season !== undefined && String(season).trim()) {
    if (!A.canEditSection(req.user, o, "order")) return res.status(403).json({ error: "无权修改「一、订单明细」的内容" });
    o.season = String(season).trim();
  }
  if (values && typeof values === "object") {
    for (const key of Object.keys(values)) {
      // 发货日期一旦填写，只有管理员能再改这一个字段；没填写时本单相关人员(业务员/下厂员/主管/
      // 管理员，不分一二板块)都能设置；不影响订单其它内容的正常编辑
      if (key === "shipDate") {
        // 发货日期一旦填写就锁定，只有管理员和主管能再改(含清空撤销误填)；业务员/下厂员不行
        if (A.shipLocked(o) && !A.isAdmin(req.user) && !A.isSupervisor(req.user)) {
          return res.status(403).json({ error: "发货日期一经填写，只有管理员或主管能再修改" });
        }
        if (!A.canEditBasic(req.user, o)) {
          return res.status(403).json({ error: "无权修改发货日期" });
        }
        continue;
      }
      // 指定下厂员是谁算业务员能管的事(建单时随便指定不受此限)：业务员(自己的单)/主管/管理员能改，下厂员不能自己改派
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
    o.data.values = Object.assign({}, o.data.values, values);
  }
  saveOrder(o);
  // 通知相关人员：只改了一个字段就说清楚改成了什么值；改了好几个字段就把字段名都列出来，
  // 而不是笼统一句"修改了订单信息"——不然收到通知的人根本不知道要去看哪里
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
  res.json(orderPublic(loadOrder(o.id)));
});

router.delete("/orders/:id", A.adminRequired, (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  db.prepare("DELETE FROM orders WHERE id=?").run(o.id);
  res.json({ ok: true });
});

/* ---------- 打卡记录 ---------- */
router.post("/orders/:id/logs", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  const { key, text, process, workers, estDone } = req.body || {};
  const section = sectionOfKey(key);
  if (!A.canAddLog(req.user, o, section)) return res.status(403).json({ error: "你没有权限在此订单打卡" });
  const list = listForKey(o, key);
  if (!list) return res.status(400).json({ error: "字段不存在" });
  const t = String(text || "").trim();
  const photos = cleanPhotos((req.body || {}).photos);
  const entry = { id: uid(), by: req.user.id, byName: req.user.name, t: Date.now(), text: t, photos };
  // 主厂/加工点打卡：生产工序/车工人数/预计下车时间是必填项，其它进度字段(面料进度/裁剪进度等)仍是纯文字打卡
  if (key === "mainLog" || String(key).startsWith("sub:")) {
    const proc = String(process || "").trim(), wk = String(workers || "").trim(), est = String(estDone || "").trim();
    if (!proc || !wk || !est) return res.status(400).json({ error: "请填写生产工序、车工人数、预计下车时间" });
    Object.assign(entry, { process: proc, workers: wk, estDone: est });
  } else if (!t && !photos.length) return res.status(400).json({ error: "请填写打卡内容或添加照片" });
  list.push(entry);
  saveOrder(o);
  notifyOrder(req.user, o, `更新了「${logLabelOf(o, key)}」`);
  res.json(orderPublic(loadOrder(o.id)));
});

router.patch("/orders/:id/logs/:key/:entryId", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  const list = listForKey(o, req.params.key);
  const e = list && list.find(x => x.id === req.params.entryId);
  if (!e) return res.status(404).json({ error: "记录不存在" });
  if (!A.canTouchEntry(req.user, o, e, sectionOfKey(req.params.key))) return res.status(403).json({ error: "无权修改这条打卡记录" });
  const t = String((req.body || {}).text || "").trim();
  const photos = Array.isArray((req.body || {}).photos) ? cleanPhotos((req.body || {}).photos) : (e.photos || []);
  if (!t && !photos.length) return res.status(400).json({ error: "内容和照片不能都为空" });
  e.text = t; e.photos = photos; saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

router.delete("/orders/:id/logs/:key/:entryId", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  const list = listForKey(o, req.params.key);
  const e = list && list.find(x => x.id === req.params.entryId);
  if (!e) return res.status(404).json({ error: "记录不存在" });
  if (!A.canTouchEntry(req.user, o, e, sectionOfKey(req.params.key))) return res.status(403).json({ error: "无权删除这条打卡记录" });
  list.splice(list.indexOf(e), 1); saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

// 加工点：下厂员自己决定要不要加、加几个、叫什么名字，不用管理员预先配置下拉
router.post("/orders/:id/subs", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  // 加工点是改生产明细的结构(不是打卡)，所以看编辑权限而不是打卡权限
  if (!A.canEditSection(req.user, o, "production")) return res.status(403).json({ error: "无权添加加工点" });
  const name = String((req.body || {}).name || "").trim();
  if (!name) return res.status(400).json({ error: "请填写加工点名称" });
  o.data.subs = o.data.subs || [];
  o.data.subs.push({ id: uid(), name, log: [] });
  saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

router.patch("/orders/:id/subs/:subId", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  if (!A.canEditSection(req.user, o, "production")) return res.status(403).json({ error: "无权修改" });
  const sub = (o.data.subs || []).find(x => x.id === req.params.subId);
  if (!sub) return res.status(404).json({ error: "加工点不存在" });
  const name = String((req.body || {}).name || "").trim();
  if (!name) return res.status(400).json({ error: "名称不能为空" });
  sub.name = name; saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

router.delete("/orders/:id/subs/:subId", A.adminRequired, (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  const before = (o.data.subs || []).length;
  o.data.subs = (o.data.subs || []).filter(x => x.id !== req.params.subId);
  if (o.data.subs.length === before) return res.status(404).json({ error: "加工点不存在" });
  saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

/* ---------- 验货问题 ----------
 * 「发现问题」只能业务员/管理员写；「整改情况」只能本单负责下厂员/管理员写。
 * 业务员验货时一次可以记录当次发现的所有问题（每条一个 item，fix 先留空）；
 * 下厂员随后逐条填整改情况。不再要求手动选日期，用提交时的服务器时间。
 */
router.post("/orders/:id/inspections", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
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
  res.json(orderPublic(loadOrder(o.id)));
});

// 改某一条的「发现问题」或「整改情况」——两个字段各自独立校验权限，传哪个改哪个
router.patch("/orders/:id/inspections/:instId/items/:itemId", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  const batch = o.data.inspections.find(x => x.id === req.params.instId);
  const item = batch && batch.items.find(x => x.id === req.params.itemId);
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
  res.json(orderPublic(loadOrder(o.id)));
});

// 补充说明：漏填/需要补充时，双方（发现问题方或整改方）都能加一条，不覆盖原内容
router.post("/orders/:id/inspections/:instId/items/:itemId/notes", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  const batch = o.data.inspections.find(x => x.id === req.params.instId);
  const item = batch && batch.items.find(x => x.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: "记录不存在" });
  if (!A.canWriteInspProblem(req.user, o) && !A.canWriteInspFix(req.user, o)) return res.status(403).json({ error: "无权添加补充说明" });
  const text = String((req.body || {}).text || "").trim();
  if (!text) return res.status(400).json({ error: "请填写补充说明" });
  item.notes = item.notes || [];
  item.notes.push({ id: uid(), by: req.user.id, byName: req.user.name, t: Date.now(), text });
  saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

router.delete("/orders/:id/inspections/:inspId", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  const g = o.data.inspections.find(x => x.id === req.params.inspId);
  if (!g) return res.status(404).json({ error: "记录不存在" });
  if (!A.canTouchEntry(req.user, o, g)) return res.status(403).json({ error: "无权删除这条验货记录" });
  o.data.inspections = o.data.inspections.filter(x => x.id !== g.id); saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

/* ---------- 跟单问题 ---------- */
router.post("/orders/:id/follow", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  if (!A.canAddLog(req.user, o)) return res.status(403).json({ error: "无权在此订单添加跟单小结" });
  const t = String((req.body || {}).text || "").trim();
  const photos = cleanPhotos((req.body || {}).photos);
  if (!t && !photos.length) return res.status(400).json({ error: "请填写内容或添加照片" });
  o.data.followIssues.push({ id: uid(), by: req.user.id, byName: req.user.name, t: Date.now(), text: t, photos });
  saveOrder(o);
  notifyOrder(req.user, o, "新增了跟单小结");
  res.json(orderPublic(loadOrder(o.id)));
});

router.delete("/orders/:id/follow/:entryId", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  const e = o.data.followIssues.find(x => x.id === req.params.entryId);
  if (!e) return res.status(404).json({ error: "记录不存在" });
  if (!A.canTouchEntry(req.user, o, e)) return res.status(403).json({ error: "无权删除这条记录" });
  o.data.followIssues = o.data.followIssues.filter(x => x.id !== e.id); saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

/* =========================================================
 *  职位管理（管理员）：名称自由，权限从两套模板里选
 * ========================================================= */
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

// 配置某个职位能干什么（管理 → 权限）。传 perms:null 表示恢复成该模板的默认权限。
// 管理员职位不在这里配置——它永远全权，能改的话容易把自己锁在门外。
router.patch("/roles/:k/perms", A.adminRequired, (req, res) => {
  const roles = getSetting("roles", []);
  const r = roles.find(x => x.k === req.params.k);
  if (!r) return res.status(404).json({ error: "职位不存在" });
  const body = (req.body || {}).perms;
  if (body === null) { delete r.perms; setSetting("roles", roles); return res.json(roles); }
  if (!body || typeof body !== "object") return res.status(400).json({ error: "权限配置格式不对" });
  // 只收认识的键，别的一律丢掉，避免前端传脏数据把权限撑大
  const clean = {};
  if (body.scope === "all" || body.scope === "own") clean.scope = body.scope;
  A.PERM_KEYS.forEach(k => { if (typeof body[k] === "boolean") clean[k] = body[k]; });
  r.perms = clean;
  setSetting("roles", roles);
  res.json(roles);
});

/* =========================================================
 *  私人聊天（所有人可用，一对一）
 * ========================================================= */
// 联系人列表：除自己外的所有在职同事 + 最后一条消息 + 未读数
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
  // 有聊天记录的按最后消息时间排前面，其余按姓名
  list.sort((a, b) => {
    if (a.last && b.last) return b.last.t - a.last.t;
    if (a.last) return -1;
    if (b.last) return 1;
    return a.name.localeCompare(b.name, "zh");
  });
  res.json(list);
});

// 未读总数（用于导航红点轮询）
router.get("/chat/unread", (req, res) => {
  const rows = db.prepare("SELECT from_user, COUNT(*) c FROM messages WHERE to_user = ? AND read_at IS NULL GROUP BY from_user")
    .all(req.user.id);
  const byUser = {};
  let total = 0;
  rows.forEach(r => { byUser[r.from_user] = r.c; total += r.c; });
  res.json({ total, byUser });
});

// 与某人的对话（打开即把对方发来的消息标记为已读）
router.get("/chat/with/:userId", (req, res) => {
  const meId = req.user.id, otherId = req.params.userId;
  const other = db.prepare("SELECT * FROM users WHERE id = ? AND deleted = 0").get(otherId);
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
  const other = db.prepare("SELECT id FROM users WHERE id = ? AND deleted = 0").get(otherId);
  if (!other) return res.status(404).json({ error: "该同事不存在或已离职" });
  const text = String((req.body || {}).text || "").trim();
  const att = (req.body || {}).attachment || null;
  if (!text && !att) return res.status(400).json({ error: "消息不能为空" });
  if (text.length > 2000) return res.status(400).json({ error: "消息太长了" });
  db.prepare("INSERT INTO messages(id,from_user,to_user,text,attachment,created_at,read_at) VALUES(?,?,?,?,?,?,NULL)")
    .run(uid(), meId, otherId, text, att ? JSON.stringify(att) : null, Date.now());
  // 推给收信人。tag 用发信人 id，同一个人连发几条只保留最新一条通知，不会刷一屏
  P.sendToUsers([otherId], {
    title: req.user.name,
    body: text ? text.slice(0, 60) : "[图片]",
    url: `/?chat=${meId}`, tag: `chat-${meId}`
  });
  res.json({ ok: true });
});

/* =========================================================
 *  应用内通知：订单被别人改动时收到提醒，点开跳到对应订单
 * ========================================================= */
const NOTIF_LIMIT = 50;   // 只给最近 50 条，够用又不会让列表无限长

router.get("/notifications", (req, res) => {
  const rows = db.prepare(`SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ${NOTIF_LIMIT}`)
    .all(req.user.id);
  // actorName/orderLabel/what 是给更精致的通知卡片用的结构化字段；老通知这几列可能是 NULL，
  // 前端遇到 NULL 时会退回纯文本 text 展示，所以这里原样传 null，不用兜底成空字符串
  res.json(rows.map(r => ({
    id: r.id, orderId: r.order_id, text: r.text, createdAt: r.created_at, read: !!r.read_at,
    actorName: r.actor_name, orderLabel: r.order_label, what: r.what
  })));
});

// 未读总数（给红点轮询用，跟 /chat/unread 一个套路）
router.get("/notifications/unread-count", (req, res) => {
  const c = db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND read_at IS NULL").get(req.user.id).c;
  res.json({ total: c });
});

router.post("/notifications/read-all", (req, res) => {
  db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(Date.now(), req.user.id);
  res.json({ ok: true });
});

router.post("/notifications/:id/read", (req, res) => {
  const row = db.prepare("SELECT * FROM notifications WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "通知不存在" });
  if (row.user_id !== req.user.id) return res.status(403).json({ error: "无权操作这条通知" });
  if (!row.read_at) db.prepare("UPDATE notifications SET read_at = ? WHERE id = ?").run(Date.now(), row.id);
  res.json({ ok: true });
});

/* =========================================================
 *  系统推送订阅：App 没打开时也能收到手机通知（详见 push.js）
 * ========================================================= */
// 公钥给前端订阅用。这个是公开的，不敏感（私钥只在服务端）
router.get("/push/key", (req, res) => res.json({ publicKey: P.publicKey() }));

// 开启通知：前端拿到浏览器给的订阅信息后上报
router.post("/push/subscribe", (req, res) => {
  const ok = P.saveSubscription(req.user.id, (req.body || {}).subscription, req.headers["user-agent"]);
  if (!ok) return res.status(400).json({ error: "订阅信息不完整" });
  res.json({ ok: true, devices: P.countOf(req.user.id) });
});

// 关闭通知：只删自己的订阅。endpoint 本身就是随机不可猜的，再加一道 user_id 校验防手误删别人的
router.post("/push/unsubscribe", (req, res) => {
  const endpoint = String((req.body || {}).endpoint || "");
  const row = db.prepare("SELECT user_id FROM push_subscriptions WHERE endpoint = ?").get(endpoint);
  if (row && row.user_id !== req.user.id) return res.status(403).json({ error: "无权操作这个订阅" });
  P.removeSubscription(endpoint);
  res.json({ ok: true, devices: P.countOf(req.user.id) });
});

// 发一条测试通知给自己。安卓机型/浏览器差异大，员工开完通知能自己点一下验证收不收得到
router.post("/push/test", async (req, res) => {
  if (!P.countOf(req.user.id)) return res.status(400).json({ error: "这台设备还没开启通知" });
  await P.sendToUsers([req.user.id],
    { title: "跟单系统", body: "测试通知：能看到这条就说明通知正常了", url: "/", tag: "test" });
  res.json({ ok: true });
});

/* ---------- 某员工的历史打卡（本人或管理员可看） ---------- */
router.get("/users/:id/logs", (req, res) => {
  const targetId = req.params.id;
  if (targetId !== req.user.id && req.user.role !== "admin")
    return res.status(403).json({ error: "只能查看自己的打卡记录" });
  const fields = getSetting("fields", { order: [], production: [] });
  const logFs = [...fields.order, ...fields.production].filter(f => f.type === "log");
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

/* ---------- 款式图上传 ---------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, uid() + (path.extname(file.originalname || "").toLowerCase() || ".jpg"))
});
const upload = multer({
  storage, limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype))
});
router.post("/upload", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "请选择图片文件" });
  res.json({ url: "/uploads/" + req.file.filename });
});

/* ---------- 聊天附件：图片和常见办公文件 ---------- */
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

/* ---------- 导入：解析上传的 Excel / CSV ----------
 * 直接支持 .xlsx/.xls，不用再另存为 CSV；
 * CSV 先按 UTF-8 解，出现乱码字符时自动改用 GBK
 *（Windows 版 Excel「另存为 CSV」默认就是 GBK，不处理会中文全乱码）。
 */
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
      if (text.includes("\uFFFD")) {                       // 有乱码字符 -> 多半是 GBK
        try { text = new TextDecoder("gbk").decode(req.file.buffer); encoding = "GBK"; } catch (e) { }
      }
      wb = XLSX.read(text, { type: "string", cellDates: true, dateNF: "yyyy-mm-dd" });
    }
  } catch (e) {
    return res.status(400).json({ error: "文件解析失败，请确认是有效的 Excel 或 CSV" });
  }

  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return res.status(400).json({ error: "表格里没有内容" });
  // WPS 导出的表格经常把 !ref(声明的数据范围) 留得比实际数据大很多(比如曾经格式化过一大片区域后又删掉内容，
  // 范围没跟着缩回去)，最坏情况能到 100 多万行；如果照着声明的范围去读，哪怕实际只有两三行数据，
  // 也要在内存里遍历上百万个空单元格，实测能卡住服务器 20+ 秒(而且是同步阻塞，卡住的是所有人，不只是这一个请求)。
  // 这里改成先找出真正有数据的单元格，收紧成实际范围再读，不再迷信文件自己声明的 !ref。
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
  // 过滤掉空行的同时，记一下"原始行号 -> 过滤后行号"的对应关系，
  // 好让嵌入图片(按原始行号锚定)能对上过滤后、真正发给前端的那份 rows 的下标
  const rows = []; const origToFiltered = {};
  rawRows.forEach((r, origIdx) => { if (r.some(c => c !== "")) { origToFiltered[origIdx] = rows.length; rows.push(r); } });
  if (rows.length < 2) return res.status(400).json({ error: "至少需要表头和一行数据" });

  // WPS/Excel 表格里直接贴的图片(比如款式图)：尝试抠出来，按行号配对，失败也不影响文字数据导入
  const rowImages = {};
  if (ext === ".xlsx") {
    try {
      const found = extractEmbeddedImages(req.file.buffer);
      Object.keys(found).forEach(origRow => {
        const filteredIdx = origToFiltered[origRow];
        if (filteredIdx === undefined) return;
        const img = found[origRow];
        if (img.data.length > 8 * 1024 * 1024) return; // 跟 /api/upload 的单张图片大小上限保持一致
        const fname = uid() + (img.ext || ".png");
        fs.writeFileSync(path.join(UPLOAD_DIR, fname), img.data);
        rowImages[filteredIdx] = "/uploads/" + fname;
      });
    } catch (e) { /* 图片抠取失败就算了，不影响正常的表格文字导入 */ }
  }
  res.json({ rows, sheet: wb.SheetNames[0], encoding, rowImages });
});

/* ---------- 导出 Excel（管理员）：订单基本信息 + 生产进度 + 验货问题 + 跟单小结，可按季节筛选 ----------
 * 直接拼出 xlsx 里的 XML、边生成边发给浏览器，不再"SheetJS 生成 → 解压改 XML 塞图 → 整份重新打包"绕一圈。
 * 照片一张张异步读、读完就发出去，内存里同一时间只有一张：照片再多也不会把服务器内存撑爆，也不会卡住别人的请求。
 */
const XML_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const THUMB_EMU = 60 * 9525, THUMB_STEP_EMU = 64 * 9525; // 缩略图 60px，同一格多张图纵向堆叠、间隔 4px
// 主题/样式沿用 SheetJS 生成的那两份（字体、样式跟以前导出的完全一致），启动时取一次
const XLSX_THEME_STYLES = (() => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[""]]), "S");
  const zip = new AdmZip(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  return [["xl/theme/theme1.xml", zip.readFile("xl/theme/theme1.xml")], ["xl/styles.xml", zip.readFile("xl/styles.xml")]];
})();
const XML_ENT = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
// 转义规则跟 SheetJS 一致：XML 特殊字符转实体，XML 里不允许出现的控制字符写成 _xHHHH_
const xmlEsc = s => String(s).replace(/[&<>"']/g, c => XML_ENT[c])
  .replace(/[\u0000-\u0008\u000b-\u001f\ufffe\uffff]/g, c => "_x" + c.charCodeAt(0).toString(16).padStart(4, "0") + "_");
const colName = i => (i >= 26 ? colName(Math.floor(i / 26) - 1) : "") + String.fromCharCode(65 + i % 26);
const photoList = p => (Array.isArray(p) ? p : [p]).filter(Boolean);
// 能嵌进 xlsx 的图片格式（类型写法同 SheetJS）；其它扩展名（上传时文件名可以随便起）一律当 jpg，免得写坏 [Content_Types].xml
const IMAGE_TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", bmp: "image/bmp",
  tif: "image/tiff", tiff: "image/tiff", webp: "image/webp", emf: "image/x-emf", wmf: "image/x-wmf" };
const relsXml = rels => XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  rels.map(([id, type, target]) => `<Relationship Id="${id}" Type="${NS_REL}/${type}" Target="${target}"/>`).join("") + `</Relationships>`;

// 跟 SheetJS 一样：标签里的内容带换行或首尾空白时标上 xml:space="preserve"（单元格、行都这样），Excel 才不会吞掉这些空白
const keepSpace = x => /(^\s|\s$|\n)/.test(x) ? ` xml:space="preserve"` : "";
function cellXml(v, ref) {
  if (v == null) return "";
  if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
  if (typeof v === "boolean") return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
  const x = xmlEsc(v), inner = `<v${keepSpace(x)}>${x}</v>`;
  return `<c r="${ref}" t="str"${keepSpace(inner)}>${inner}</c>`;
}

// 一张表 -> 它在 zip 里的全部文件：sheet XML；有照片时再加 drawing 和两份 rels
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

/**
 * 极简 zip 打包：逐个文件产出字节块，交给 pipeline 边生成边发。
 * files: [文件名, 内容(字符串/Buffer，或返回 Promise<Buffer> 的函数——轮到它时才去读), 是否原样存]
 * 照片本身就是压缩格式，原样存(STORED)；XML 用 DEFLATE 压（在线程池里压，不占主线程）。
 */
async function* zipChunks(files) {
  const central = [];
  let offset = 0;
  for (const [name, content, stored] of files) {
    const raw = typeof content === "function" ? await content() : Buffer.from(content);
    const data = stored ? raw : await deflateRaw(raw);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); // 0x800：文件名是 UTF-8
    local.writeUInt16LE(stored ? 0 : 8, 8); local.writeUInt16LE(0x21, 12); // 日期 1980-01-01
    local.writeUInt32LE(zlib.crc32(raw), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    // 中央目录项的字段跟本地头一一对应，只是前面多了"创建版本"、末尾多了本地头的偏移量
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

const exportingUsers = new Set(); // 同一个人上一份还没导完又点了导出，直接挡回去，不叠着跑
router.get("/export", A.adminRequired, async (req, res, next) => {
  if (exportingUsers.has(req.user.id)) return res.status(429).json({ error: "上一份导出还没完成，请稍候" });
  exportingUsers.add(req.user.id);
  res.on("close", () => exportingUsers.delete(req.user.id));
  res.setTimeout(120000, () => res.destroy()); // 手机切网络等导致连接僵死时，2 分钟没动静就断开，不会一直挡着这个人
  try {
    const fields = getSetting("fields", { order: [], production: [] });
    const allFields = [...fields.order, ...fields.production];
    const userNames = new Map(db.prepare("SELECT id,name FROM users").all().map(u => [u.id, u.name]));
    const nameOf = id => userNames.get(id) || id || "";
    const seasonFilter = String(req.query.season || "").trim();
    const orders = allOrdersPublic().filter(o => !seasonFilter || o.season === seasonFilter);
    const styleOf = o => o.values.styleNo || o.values.styleName || o.id;
    const timeText = t => t ? new Date(t).toLocaleString("zh-CN") : "";

    // 每张表 = 表头 + 行；行上的 photos 嵌进这张表的照片列（没写 photoCol 就是最后一列）
    // 表一：订单基本信息，打卡字段取最新一条摘要。货号已是固定的第二列(带款式名/id兜底)，字段里排除掉免得表头出现两次
    const cols = allFields.filter(f => f.k !== "styleNo");
    const imgCol = cols.findIndex(f => f.k === "img");
    const sheet1 = { name: "订单基本信息", header: ["季节", "货号", ...cols.map(f => f.label)], photoCol: 2 + imgCol,
      rows: orders.map(o => ({ photos: imgCol >= 0 ? o.values.img : null, cells: [o.season, styleOf(o), ...cols.map(f => {
        if (f.type === "log") {
          const l = (o.logs[f.k] || []).slice().sort((a, b) => b.t - a.t)[0];
          return l ? `${l.text}（${l.byName} ${timeText(l.t)}）` : "";
        }
        if (f.type === "image") return ""; // 款式图是真的嵌进表格里，这一格文字留空
        if (f.type === "user-sales" || f.type === "user-follower") return nameOf(o.values[f.k]);
        const v = o.values[f.k];
        return Array.isArray(v) ? v.join("、") : (v || "");
      })] })) };

    // 表二：生产进度（主厂 + 每个加工点 + 面料/绣印/产前样/裁剪/整烫/包装 的每一条打卡）
    const sheet2 = { name: "生产进度", header: ["季节", "货号", "环节", "生产工序", "车工人数", "预计下车时间", "内容", "记录人", "时间", "照片"], rows: [] };
    orders.forEach(o => {
      const add = (stage, e, p) => sheet2.rows.push({ photos: e.photos,
        cells: [o.season, styleOf(o), stage, p.process || "", p.workers || "", p.estDone || "", e.text || "", e.byName, timeText(e.t), ""] });
      (o.mainLog || []).forEach(e => add("主厂", e, e));
      (o.subs || []).forEach(s => (s.log || []).forEach(e => add(s.name, e, e)));
      allFields.filter(f => f.type === "log").forEach(f => (o.logs[f.k] || []).forEach(e => add(f.label, e, {})));
    });

    // 表三：验货问题（发现问题/整改情况/补充说明 各自独立一行方便查看）
    const sheet3 = { name: "验货问题", header: ["季节", "货号", "发现问题", "发现人", "发现时间", "整改情况", "整改人", "整改时间", "补充说明", "照片"],
      rows: orders.flatMap(o => (o.inspections || []).flatMap(g => (g.items || []).map(it => ({ photos: g.photos, cells: [
        o.season, styleOf(o), it.problem || "", it.problemByName || "", timeText(it.problemAt),
        it.fix || "（待整改）", it.fixByName || "", timeText(it.fixAt),
        (it.notes || []).map(n => `${n.byName}：${n.text}`).join("；"), ""] })))) };

    // 表四：跟单小结
    const sheet4 = { name: "跟单小结", header: ["季节", "货号", "记录人", "时间", "内容", "照片"],
      rows: orders.flatMap(o => (o.followIssues || []).map(e => ({ photos: e.photos, cells: [o.season, styleOf(o), e.byName, timeText(e.t), e.text || "", ""] }))) };
    const sheets = [sheet1, sheet2, sheet3, sheet4];

    // 先查哪些照片文件还在（找不到的直接跳过）；同一张图全表只存一份，按首次出现的顺序编号
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
      // 万一导出途中照片被删了，就放一张空图占位，别让整份下载断掉
      ...[...media.values()].map(m => [`xl/media/${m.name}`, () => fs.promises.readFile(m.file).catch(() => Buffer.alloc(0)), true])
    ];

    const fname = `订单导出-${seasonFilter || "全部季节"}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
    await pipeline(zipChunks(files), res);
  } catch (e) {
    if (!res.headersSent) next(e); // 文件已经开始发了才出错(多半是浏览器那边断开)，pipeline 会自己关掉连接
  }
});

module.exports = router;
