"use strict";
// 订单：增删改查、批量导入、打卡记录、加工点、验货、跟单小结
const express = require("express");
const { db, uid } = require("../db");
const A = require("../auth");
const P = require("../push");
const { getFields, allFields, orderPublic, visibleOrdersPublic, logFields, USER_FIELD_TYPES } = require("./helpers");

const router = express.Router();

const fieldOf = key => allFields().find(x => x.k === key);

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

// 空值(undefined/null/""/[])都算没填；数组按内容比
function sameValue(a, b) {
  const norm = v => v == null || v === "" || (Array.isArray(v) && !v.length) ? "" : JSON.stringify(v);
  return norm(a) === norm(b);
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
  if (USER_FIELD_TYPES.includes(type)) {
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
// 同一人在同一单上的未读通知，这段时间内再有改动就合并成一条，不往下堆
const NOTIF_MERGE_MS = 30 * 60 * 1000;
// 系统推送：同一人这段时间里连着动了多张单，只推一条汇总(同 tag 覆盖)
const PUSH_BATCH_MS = 3 * 60 * 1000;
const pushBatchOf = new Map();  // actorId -> { last, orders:Set }
function pushPayload(actor, o, label, what) {
  const now = Date.now();
  let b = pushBatchOf.get(actor.id);
  if (!b || now - b.last > PUSH_BATCH_MS) b = { orders: new Set() };
  b.last = now; b.orders.add(o.id); pushBatchOf.set(actor.id, b);
  if (b.orders.size < 2) return { title: label, body: `${actor.name} ${what}`, url: `/?order=${o.id}`, tag: `order-${o.id}` };
  return { title: "订单动态", body: `${actor.name} 连续更新了 ${b.orders.size} 个订单，最近一单：${label}`,
    url: "/?notifs=1", tag: `batch-${actor.id}` };
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
    const findOpen = db.prepare(`SELECT id FROM notifications WHERE user_id = ? AND order_id = ? AND actor_id = ?
      AND read_at IS NULL AND created_at > ? ORDER BY created_at DESC LIMIT 1`);
    const merge = db.prepare("UPDATE notifications SET text=?, what=?, order_label=?, created_at=?, merged=merged+1 WHERE id=?");
    const insert = db.prepare(`INSERT INTO notifications(id,user_id,order_id,text,created_at,read_at,actor_name,order_label,what,actor_id,merged)
      VALUES(?,?,?,?,?,NULL,?,?,?,?,1)`);
    ids.forEach(uid2 => {
      const open = findOpen.get(uid2, o.id, actor.id, now - NOTIF_MERGE_MS);
      if (open) merge.run(text, what, label, now, open.id);
      else insert.run(uid(), uid2, o.id, text, now, actor.name, label, what, actor.id);
    });
    P.sendToUsers([...ids], pushPayload(actor, o, label, what));
  } catch (e) { console.error("[notify] 生成通知失败", e); }
}

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
  const before = { season: o.season, values: Object.assign({}, o.data.values) };
  // 季节算「一、订单明细」；其余字段按所属板块分别校验
  if (season !== undefined && String(season).trim()) {
    if (!A.canEditSection(req.user, o, "order")) return res.status(403).json({ error: "无权修改「一、订单明细」的内容" });
    o.season = String(season).trim();
  }
  if (values && typeof values === "object") {
    for (const key of Object.keys(values)) {
      const f = fieldOf(key);
      // 填后锁定的字段(发货日期等)：本单有编辑权就能填，填了只有管理员/主管能改
      if (f && f.lock) {
        if (!sameValue(o.data.values[key], "") && !A.isAdmin(req.user) && !A.isSupervisor(req.user)) {
          return res.status(403).json({ error: `「${f.label}」一经填写，只有管理员或主管能再修改` });
        }
        if (!A.canEditBasic(req.user, o)) {
          return res.status(403).json({ error: `无权填写「${f.label}」` });
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
  // 通知只报真正变了的字段(表单会把没改的也一起提交)；改一个写明新值，改多个列出字段名
  const changedKeys = Object.keys((values && typeof values === "object") ? values : {})
    .filter(k => !sameValue(before.values[k], o.data.values[k]));
  if (o.season !== before.season) changedKeys.unshift("season");
  if (changedKeys.length) {
    let what;
    if (changedKeys.length === 1) {
      const key = changedKeys[0];
      const val = key === "season" ? o.season : o.data.values[key];
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
  const body = req.body || {};
  const t = String(body.text || "").trim();
  const photos = Array.isArray(body.photos) ? cleanPhotos(body.photos) : (e.photos || []);
  // 本厂/加工点的工序、人数、预计下车时间：传了就改，改完仍必须齐全
  if (e.process !== undefined || body.process !== undefined) {
    const pick = (k, cur) => body[k] === undefined ? cur : String(body[k] || "").trim();
    const proc = pick("process", e.process), wk = pick("workers", e.workers), est = pick("estDone", e.estDone);
    if (!proc || !wk || !est) return res.status(400).json({ error: "请填写生产工序、车工人数、预计下车时间" });
    Object.assign(e, { process: proc, workers: wk, estDone: est });
  } else if (!t && !photos.length) return res.status(400).json({ error: "内容和照片不能都为空" });
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

// 改一组验货的照片；问题条目各自改
router.patch("/orders/:id/inspections/:inspId", withOrder, (req, res) => {
  const o = req.order;
  const g = o.data.inspections.find(x => x.id === req.params.inspId);
  if (!g) return res.status(404).json({ error: "记录不存在" });
  if (!A.canTouchEntry(req.user, o, g)) return res.status(403).json({ error: "无权修改这条验货记录" });
  const photos = cleanPhotos((req.body || {}).photos);
  if (!g.items.length && !photos.length) return res.status(400).json({ error: "没有问题条目时至少要留一张照片" });
  g.photos = photos; saveOrder(o);
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

router.patch("/orders/:id/follow/:entryId", withOrder, (req, res) => {
  const o = req.order;
  const e = o.data.followIssues.find(x => x.id === req.params.entryId);
  if (!e) return res.status(404).json({ error: "记录不存在" });
  if (!A.canTouchEntry(req.user, o, e)) return res.status(403).json({ error: "无权修改这条记录" });
  const body = req.body || {};
  const t = body.text === undefined ? e.text : String(body.text || "").trim();
  const photos = Array.isArray(body.photos) ? cleanPhotos(body.photos) : (e.photos || []);
  if (!t && !photos.length) return res.status(400).json({ error: "内容和照片不能都为空" });
  e.text = t; e.photos = photos; saveOrder(o);
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

module.exports = router;
