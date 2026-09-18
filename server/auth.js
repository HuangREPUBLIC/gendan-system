"use strict";
// 认证与权限：bcrypt 存密码，JWT 登录态；权限以这里为准，前端只负责隐藏按钮
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { db, getSetting, DATA_DIR } = require("./db");

// JWT 密钥：优先环境变量，否则生成后存在 data 目录，重启不失效
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const p = path.join(DATA_DIR, ".jwt_secret");
  try { return fs.readFileSync(p, "utf8"); }
  catch (e) {
    const s = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(p, s, { mode: 0o600 });
    return s;
  }
}
const SECRET = loadSecret();

const hashPassword = (pw) => bcrypt.hashSync(String(pw), 10);
const verifyPassword = (pw, hash) => bcrypt.compareSync(String(pw), hash);
// 不设过期；账号被删后 authRequired 会拦下
const signToken = (user) => jwt.sign({ id: user.id }, SECRET);

const findRole = (k) => getSetting("roles", []).find(x => x.k === k);
// 职位 -> 权限模板；查不到的职位按最小权限(follower)
function roleTemplate(roleKey) {
  if (roleKey === "admin") return "admin";
  const r = findRole(roleKey);
  return r ? r.template : "follower";
}
const templateOf = u => (u ? roleTemplate(u.role) : null);
function roleLabel(roleKey) {
  if (roleKey === "admin") return "管理员";
  const r = findRole(roleKey);
  return r ? r.label : roleKey;
}

function userPublic(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, phone: u.phone, role: u.role,
    roleLabel: roleLabel(u.role), template: roleTemplate(u.role), deleted: !!u.deleted };
}
const userById = (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id);

function authRequired(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "未登录" });
  try {
    const u = userById(jwt.verify(token, SECRET).id);
    if (!u || u.deleted) return res.status(401).json({ error: "账号不存在或已被删除" });
    req.user = u;
    next();
  } catch (e) {
    return res.status(401).json({ error: "登录已失效，请重新登录" });
  }
}

function adminRequired(req, res, next) {
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ error: "仅管理员可操作" });
  next();
}

/* 权限：template 决定"自己的单"怎么算(业务员看 sales，下厂员看 follower)，
 * perms 决定能做什么(管理员在「管理 → 权限」里逐项开关，未配置时按模板默认) */
const isAdmin = (u) => u && u.role === "admin";
const isSupervisor = (u) => u && templateOf(u) === "supervisor";
// 发货日期填写后只锁这一个字段
const shipLocked = (order) => !!((order && order.data && order.data.values) || {}).shipDate;

const TEMPLATE_PERMS = {
  sales:      { scope: "own", editOrder: true,  editProd: false, logOrder: true,  logProd: false, createOrder: true, inspect: true },
  follower:   { scope: "own", editOrder: false, editProd: true,  logOrder: false, logProd: true,  createOrder: true, inspect: true },
  supervisor: { scope: "all", editOrder: true,  editProd: true,  logOrder: true,  logProd: true,  createOrder: true, inspect: true }
};
const PERM_KEYS = ["editOrder", "editProd", "logOrder", "logProd", "createOrder", "inspect"];
function permsOf(u) {
  if (isAdmin(u)) return TEMPLATE_PERMS.supervisor;   // 管理员永远全权，不可配置
  const base = TEMPLATE_PERMS[templateOf(u)] || TEMPLATE_PERMS.follower;
  const saved = (findRole(u && u.role) || {}).perms;
  if (!saved) return base;
  // 只认已知键，脏数据不会放大权限
  const out = Object.assign({}, base);
  if (saved.scope === "all" || saved.scope === "own") out.scope = saved.scope;
  PERM_KEYS.forEach(k => { if (typeof saved[k] === "boolean") out[k] = saved[k]; });
  return out;
}
// 是否本单相关人员：scope=all 全部相关，否则按模板认归属
function isRelated(u, order) {
  if (!u || !order) return false;
  if (permsOf(u).scope === "all") return true;
  const v = (order.data && order.data.values) || {};
  const t = templateOf(u);
  if (t === "sales") return v.sales === u.id || order.created_by === u.id;
  if (t === "follower") return v.follower === u.id;
  return false;
}
const canViewOrder = isRelated;
// section 为 "order"/"production"；不传表示任一板块有权即可
function sectionPerm(u, order, section, orderKey, prodKey) {
  if (!isRelated(u, order)) return false;
  const p = permsOf(u);
  if (section === "order") return !!p[orderKey];
  if (section === "production") return !!p[prodKey];
  return !!(p[orderKey] || p[prodKey]);
}
const canEditSection = (u, order, section) => sectionPerm(u, order, section, "editOrder", "editProd");
const canEditBasic = (u, order) => canEditSection(u, order);
// 打卡与改字段是独立开关
const canAddLog = (u, order, section) => sectionPerm(u, order, section, "logOrder", "logProd");
const canCreateOrder = (u) => !!u && !!permsOf(u).createOrder;
// 改/删记录：自己写的可以，别人写的要有该板块的编辑权
function canTouchEntry(u, order, entry, section) {
  if (!u) return false;
  if (entry && entry.by === u.id) return true;
  return canEditSection(u, order, section);
}
// 验货「发现问题」「整改情况」共用一个开关
const canWriteInspProblem = (u, order) => isRelated(u, order) && !!permsOf(u).inspect;
const canWriteInspFix = canWriteInspProblem;

module.exports = {
  hashPassword, verifyPassword, signToken, userPublic,
  authRequired, adminRequired, isAdmin, isSupervisor, shipLocked,
  canEditBasic, canEditSection, canAddLog, canTouchEntry, canViewOrder,
  roleTemplate, canWriteInspProblem, canWriteInspFix,
  canCreateOrder, PERM_KEYS
};
