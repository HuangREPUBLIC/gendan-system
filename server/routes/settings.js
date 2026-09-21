"use strict";
// 表单配置：自定义字段、工厂下拉、季节、职位（管理员）
const express = require("express");
const { db, getSetting, setSetting } = require("../db");
const A = require("../auth");
const { getFields, getFactories, activeUsers, FIELD_TYPES, USER_FIELD_TYPES, MULTI_FIELD_TYPES } = require("./helpers");

const router = express.Router();

const hasOptions = type => type === "select" || type === "multiselect";
// 把字段放到 after 这个字段后面；after 为 "" 放最前，undefined 不动。找不到返回 false
function placeField(list, f, after) {
  if (after === undefined) return true;
  if (after !== "" && (after === f.k || !list.some(x => x.k === after))) return false;
  const i = list.indexOf(f); if (i >= 0) list.splice(i, 1);
  list.splice(after === "" ? 0 : list.findIndex(x => x.k === after) + 1, 0, f);
  return true;
}
const cleanOptions = options => [...new Set((Array.isArray(options) ? options : []).map(s => String(s).trim()).filter(Boolean))];

router.post("/fields", A.adminRequired, (req, res) => {
  const { section, label, options, after } = req.body || {};
  const type = (req.body || {}).type || "text";
  if (!["order", "production"].includes(section)) return res.status(400).json({ error: "板块不对" });
  if (!FIELD_TYPES.includes(type)) return res.status(400).json({ error: "字段类型不对" });
  const lb = String(label || "").trim();
  if (!lb) return res.status(400).json({ error: "请填写字段名称" });
  const fields = getFields();
  if (fields[section].some(x => x.label === lb)) return res.status(400).json({ error: `「${lb}」字段已存在，不能重复添加` });
  const f = { k: "f" + Date.now(), label: lb, type };
  if (hasOptions(type)) {
    f.options = cleanOptions(options);
    if (!f.options.length) return res.status(400).json({ error: "请填写下拉选项" });
  }
  fields[section].push(f);
  if (!placeField(fields[section], f, after)) return res.status(400).json({ error: "要放在后面的字段不存在" });
  setSetting("fields", fields);
  if (type === "log") {  // 已有订单补上该进度字段
    db.prepare("SELECT id, data FROM orders").all().forEach(r => {
      const d = JSON.parse(r.data); d.logs = d.logs || {}; if (!d.logs[f.k]) d.logs[f.k] = [];
      db.prepare("UPDATE orders SET data=? WHERE id=?").run(JSON.stringify(d), r.id);
    });
  }
  res.json(fields);
});

// 已有订单里的值换成新类型的格式：单值/多选互转，人员字段把姓名换成 id
function convertFieldValues(key, fromType, toType) {
  const toUser = USER_FIELD_TYPES.includes(toType) && !USER_FIELD_TYPES.includes(fromType);
  const fromUser = USER_FIELD_TYPES.includes(fromType) && !USER_FIELD_TYPES.includes(toType);
  const toMulti = MULTI_FIELD_TYPES.includes(toType), fromMulti = MULTI_FIELD_TYPES.includes(fromType);
  if (!toUser && !fromUser && toMulti === fromMulti) return;
  const users = activeUsers();
  const idByName = new Map(users.map(u => [u.name, u.id])), nameById = new Map(users.map(u => [u.id, u.name]));
  const update = db.prepare("UPDATE orders SET data=? WHERE id=?");
  db.prepare("SELECT id, data FROM orders").all().forEach(r => {
    const d = JSON.parse(r.data), v = (d.values || {})[key];
    if (v == null || v === "") return;
    let nv = v;
    if (fromUser) nv = nameById.get(nv) || nv;
    if (toMulti && !fromMulti) nv = String(nv).split(/[,，、\/;；]/).map(x => x.trim()).filter(Boolean);
    if (fromMulti && !toMulti) nv = Array.isArray(nv) ? nv.join("、") : nv;
    if (toUser) nv = idByName.get(String(nv).trim()) || nv;
    if (JSON.stringify(nv) === JSON.stringify(v)) return;
    d.values[key] = nv;
    update.run(JSON.stringify(d), r.id);
  });
}

// 改字段名称、类型、下拉选项、位置；打卡字段和其它类型的数据结构不同，不能互转
router.patch("/fields/:section/:key", A.adminRequired, (req, res) => {
  const { section, key } = req.params;
  const fields = getFields();
  if (!fields[section]) return res.status(400).json({ error: "板块不对" });
  const f = fields[section].find(x => x.k === key);
  if (!f) return res.status(404).json({ error: "字段不存在" });
  if (f.core) return res.status(400).json({ error: "核心字段不可修改" });
  const body = req.body || {};
  const lb = body.label === undefined ? f.label : String(body.label).trim();
  const type = body.type || f.type;
  if (!lb) return res.status(400).json({ error: "请填写字段名称" });
  if (fields[section].some(x => x !== f && x.label === lb)) return res.status(400).json({ error: `「${lb}」字段已存在` });
  if (!FIELD_TYPES.includes(type)) return res.status(400).json({ error: "字段类型不对" });
  if ((type === "log") !== (f.type === "log")) return res.status(400).json({ error: "进度打卡字段不能和其它类型互相转换" });
  const options = hasOptions(type) ? cleanOptions(body.options === undefined ? f.options : body.options) : undefined;
  if (options && !options.length) return res.status(400).json({ error: "请填写下拉选项" });
  if (!placeField(fields[section], f, body.after)) return res.status(400).json({ error: "要放在后面的字段不存在" });
  f.label = lb;
  const fromType = f.type; f.type = type;
  if (options) f.options = options; else delete f.options;
  // 字段配置和订单数据一起改，要么全改要么全不改
  db.exec("BEGIN");
  try {
    convertFieldValues(key, fromType, type);
    setSetting("fields", fields);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
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

module.exports = router;
