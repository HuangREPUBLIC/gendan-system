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

// 只认字符串数组：库里是脏数据时按没有名单算(只看自己相关)，不会放大权限
function scopeFactoriesOf(u) {
  try { const a = JSON.parse((u && u.scope_factories) || "[]"); return Array.isArray(a) ? a.filter(x => typeof x === "string" && x) : []; }
  catch (e) { return []; }
}
function userPublic(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, phone: u.phone, role: u.role,
    roleLabel: roleLabel(u.role), template: roleTemplate(u.role), deleted: !!u.deleted, scope: u.scope || "",
    scopeFactories: scopeFactoriesOf(u) };
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
 * perms 决定能做什么(管理员在「管理 → 权限」里逐项开关，未配置时按模板默认)；
 * 看订单范围(scope)还能在「管理 → 人员」里按人单独设置，优先于职位 */
const isAdmin = (u) => u && u.role === "admin";
const isSupervisor = (u) => u && templateOf(u) === "supervisor";

const TEMPLATE_PERMS = {
  sales:      { scope: "own", editOrder: true,  editProd: false, logOrder: true,  logProd: false, createOrder: true, inspect: true },
  follower:   { scope: "own", editOrder: false, editProd: true,  logOrder: false, logProd: true,  createOrder: true, inspect: true },
  supervisor: { scope: "all", editOrder: true,  editProd: true,  logOrder: true,  logProd: true,  createOrder: true, inspect: true }
};
const PERM_KEYS = ["editOrder", "editProd", "logOrder", "logProd", "createOrder", "inspect"];
// 看订单范围：own 只看自己相关 / all 全部 / factory 指定工厂的单加自己相关(只能按人设)
const SCOPES = ["own", "all", "factory"];
// 订单上的工厂：服装/面料/绣花/印花，同前端「按工厂筛选」
const ORDER_FACTORY_KEYS = ["factory", "fabricFactory1", "fabricFactory2", "embFactory", "printFactory"];
function permsOf(u) {
  if (isAdmin(u)) return TEMPLATE_PERMS.supervisor;   // 管理员永远全权，不可配置
  const base = TEMPLATE_PERMS[templateOf(u)] || TEMPLATE_PERMS.follower;
  const rolePerms = (findRole(u && u.role) || {}).perms;
  const saved = u && SCOPES.includes(u.scope) ? Object.assign({}, rolePerms, { scope: u.scope }) : rolePerms;
  if (!saved) return base;
  // 只认已知键，脏数据不会放大权限
  const out = Object.assign({}, base);
  if (SCOPES.includes(saved.scope)) out.scope = saved.scope;
  PERM_KEYS.forEach(k => { if (typeof saved[k] === "boolean") out[k] = saved[k]; });
  return out;
}
// 是否本单相关人员：scope=all 全部相关，否则按模板认归属
function isRelated(u, order) {
  if (!u || !order) return false;
  const scope = permsOf(u).scope;
  if (scope === "all") return true;
  const v = (order.data && order.data.values) || {};
  // 只看指定工厂：订单上任一工厂在他的名单里就算；自己相关的单照样按下面算
  if (scope === "factory") {
    const mine = scopeFactoriesOf(u);
    if (ORDER_FACTORY_KEYS.some(k => [].concat(v[k] || []).some(f => mine.includes(String(f).trim())))) return true;
  }
  const t = templateOf(u);
  if (t === "sales") return v.sales === u.id || order.created_by === u.id;
  if (t === "follower") return v.follower === u.id;
  // 主管设成只看自己时：自己建的、当业务员或下厂员的单
  return v.sales === u.id || v.follower === u.id || order.created_by === u.id;
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
// 改/删记录：看得到这单才行；自己写的可以(职位权限全关掉的只读账号除外)，别人写的要有该板块的编辑权
function canTouchEntry(u, order, entry, section) {
  if (!u || !isRelated(u, order)) return false;
  const p = permsOf(u);
  if (entry && entry.by === u.id && PERM_KEYS.some(k => p[k])) return true;
  return canEditSection(u, order, section);
}
// 验货「发现问题」「整改情况」共用一个开关
const canWriteInspProblem = (u, order) => isRelated(u, order) && !!permsOf(u).inspect;
const canWriteInspFix = canWriteInspProblem;

module.exports = {
  hashPassword, verifyPassword, signToken, userPublic,
  authRequired, adminRequired, isAdmin, isSupervisor,
  canEditBasic, canEditSection, canAddLog, canTouchEntry, canViewOrder,
  roleTemplate, canWriteInspProblem, canWriteInspFix,
  canCreateOrder, PERM_KEYS
};
