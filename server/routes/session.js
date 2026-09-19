"use strict";
// 登录（不需要登录）、启动数据、修改自己的密码
const express = require("express");
const { db, getSetting } = require("../db");
const A = require("../auth");
const { getFields, getFactories, activeUsers, visibleOrdersPublic } = require("./helpers");

const router = express.Router();
const pub = express.Router();  // 不需要登录的路由

pub.post("/login", (req, res) => {
  const { phone, password } = req.body || {};
  const u = db.prepare("SELECT * FROM users WHERE phone = ? AND deleted = 0").get(String(phone || "").trim());
  if (!u || !A.verifyPassword(password || "", u.password_hash))
    return res.status(400).json({ error: "手机号或密码不正确" });
  res.json({ token: A.signToken(u), user: A.userPublic(u) });
});

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

module.exports = { pub, router };
