"use strict";
/**
 * 认证与权限：
 *  - 密码用 bcrypt 加盐哈希（不存明文）
 *  - 登录后签发 JWT，前端每次请求带 Authorization: Bearer <token>
 *  - 权限在服务端强制校验（前端只是隐藏按钮，真正的拦截在这里）
 */
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { db, getSetting, DATA_DIR } = require("./db");

// JWT 密钥：优先环境变量，否则在 data 目录生成并持久化（重启后 token 不失效）
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
// 不设过期时间：只要用户不主动退出，登录状态一直保持。
// 账号被管理员删除时 authRequired 会当场拦下，所以不会留下"删了还能用"的口子。
const signToken = (user) => jwt.sign({ id: user.id }, SECRET);

/**
 * 职位 -> 权限模板。管理员固定为 admin；其余职位（含管理员自定义的）
 * 由 settings.roles 里的 template 决定用「业务员」还是「下厂员」那套权限。
 * 查不到的职位一律按最小权限(follower)处理，避免权限真空。
 */
function roleTemplate(roleKey) {
  if (roleKey === "admin") return "admin";
  const r = getSetting("roles", []).find(x => x.k === roleKey);
  return r ? r.template : "follower";
}
const templateOf = u => (u ? roleTemplate(u.role) : null);
function roleLabel(roleKey) {
  if (roleKey === "admin") return "管理员";
  const r = getSetting("roles", []).find(x => x.k === roleKey);
  return r ? r.label : roleKey;
}

function userPublic(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, phone: u.phone, role: u.role,
    roleLabel: roleLabel(u.role), template: roleTemplate(u.role), deleted: !!u.deleted };
}
const userById = (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id);

// 中间件：要求已登录，把当前用户挂到 req.user
function authRequired(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "未登录" });
  try {
    const payload = jwt.verify(token, SECRET);
    const u = userById(payload.id);
    if (!u || u.deleted) return res.status(401).json({ error: "账号不存在或已被删除" });
    req.user = u;
    next();
  } catch (e) {
    return res.status(401).json({ error: "登录已失效，请重新登录" });
  }
}

// 中间件：要求管理员
function adminRequired(req, res, next) {
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ error: "仅管理员可操作" });
  next();
}

/* ---------- 权限判定（与前端保持一致，但以此处为准） ----------
 * 谁负责的内容谁有权限：本单的业务员/下厂员/创建人可以添加删除这单的内容。
 * 职位可以在「职位管理」里勾选"完全权限"，勾了的职位(以及管理员)不受负责人限制，
 * 能管理所有订单——这样以后要调整谁有全权限，管理员在设置里打勾就行，不用改代码。
 * 发货日期一旦填写，说明这单已经走完流程要发货了，除了管理员，任何人(包括完全权限的职位)
 * 都不能再改这单的任何内容，防止发货后数据被误改。
 * 删除整单/删除加工点这两个不可逆操作仍然只留给管理员(见 routes.js 里对应路由的 adminRequired)。
 */
const isAdmin = (u) => u && u.role === "admin";
// 完全权限：管理员固定拥有；其它职位由「职位管理」里的开关决定(settings.roles 里的 fullAccess)
function hasFullAccess(u) {
  if (!u) return false;
  if (u.role === "admin") return true;
  const r = getSetting("roles", []).find(x => x.k === u.role);
  return !!(r && r.fullAccess);
}
// 是否是这单的负责人：业务员、下厂员，或者创建人
function isResponsible(u, order) {
  if (!u || !order) return false;
  const v = (order.data && order.data.values) || {};
  return v.sales === u.id || v.follower === u.id || order.created_by === u.id;
}
// 发货日期一旦填写，这单就锁死了(管理员除外)
function shipLocked(order) {
  return !!((order && order.data && order.data.values) || {}).shipDate;
}
// 能否编辑订单基本信息
function canEditBasic(u, order) {
  if (!u) return false;
  if (isAdmin(u)) return true;
  if (shipLocked(order)) return false;
  return hasFullAccess(u) || isResponsible(u, order);
}
// 能否在某板块打卡/添加内容
function canAddLog(u, order, section) {
  if (!u) return false;
  if (isAdmin(u)) return true;
  if (shipLocked(order)) return false;
  return hasFullAccess(u) || isResponsible(u, order);
}
// 能否修改/删除某条记录：管理员；完全权限职位；这单的负责人；或者自己创建的记录
function canTouchEntry(u, order, entry) {
  if (!u) return false;
  if (isAdmin(u)) return true;
  if (shipLocked(order)) return false;
  return hasFullAccess(u) || isResponsible(u, order) || (entry && entry.by === u.id);
}

// 验货「发现问题」「整改情况」：跟其它内容一样，本单负责人/完全权限职位/管理员才能写
const canWriteInspProblem = (u, order) => canAddLog(u, order);
const canWriteInspFix = (u, order) => canAddLog(u, order);

module.exports = {
  hashPassword, verifyPassword, signToken, userPublic, userById,
  authRequired, adminRequired, isAdmin, hasFullAccess, isResponsible, shipLocked,
  canEditBasic, canAddLog, canTouchEntry,
  roleTemplate, templateOf, roleLabel, canWriteInspProblem, canWriteInspFix
};
