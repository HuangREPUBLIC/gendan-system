"use strict";
// 表单配置：自定义字段、工厂下拉、季节、职位（管理员）
const express = require("express");
const { db, getSetting, setSetting } = require("../db");
const A = require("../auth");
const { getFields, getFactories } = require("./helpers");

const router = express.Router();

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
