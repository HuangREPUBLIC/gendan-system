"use strict";
// 员工账号（管理员）、员工历史打卡
const express = require("express");
const { db, uid, getSetting } = require("../db");
const A = require("../auth");
const { activeUser, activeUsers, allOrdersPublic, logFields } = require("./helpers");

const router = express.Router();

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

module.exports = router;
