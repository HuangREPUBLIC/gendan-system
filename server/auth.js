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
 * 按职位的权限模板来，一共三档：
 *  - 管理员(admin)：什么都能做
 *  - 主管(supervisor，比如技术主管/业务主管)：能管理所有订单，等同管理员的业务权限
 *    (但没有"管理"标签页那些系统设置权限，那部分仍只留给 admin)
 *  - 业务员(sales)：只能管自己创建的、或自己是业务员的订单
 *  - 下厂员(follower)：只能管自己是负责下厂员的订单
 * 发货日期一旦填写，只锁定这个字段本身——除了管理员，任何人都不能再改发货日期；
 * 订单其它内容(订单明细/生产明细/打卡记录等)仍按各自板块的权限正常编辑，不受影响。
 * 删除整单/删除加工点这两个不可逆操作仍然只留给管理员(见 routes.js 里对应路由的 adminRequired)。
 */
const isAdmin = (u) => u && u.role === "admin";
const isSupervisor = (u) => u && templateOf(u) === "supervisor";
// 发货日期一旦填写，这个字段就锁死了(管理员除外)；只影响这一个字段，不影响订单其它内容
function shipLocked(order) {
  return !!((order && order.data && order.data.values) || {}).shipDate;
}
// 是否是这单的负责业务员/创建人(业务员模板用这个判断)
function isOwnBySales(u, order) {
  if (!u || !order) return false;
  const v = (order.data && order.data.values) || {};
  return v.sales === u.id || order.created_by === u.id;
}
// 是否是这单负责的下厂员(下厂员模板用这个判断)
function isOwnByFollower(u, order) {
  if (!u || !order) return false;
  const v = (order.data && order.data.values) || {};
  return v.follower === u.id;
}
/* ---------- 职位能力（管理员可在后台逐项开关） ----------
 * 这里把两件事拆开了，之前它们挤在 template 一个字段里，所以想调权限只能改代码：
 *   template（身份）：你在流程里是谁 —— 决定"自己的单"怎么算
 *                     （业务员看 values.sales，下厂员看 values.follower）
 *   perms（能力）    ：你能干什么 —— 下面这些开关，管理员在「管理 → 权限」里改
 * 注意"改字段"和"打卡"是两个独立开关：可以让业务员能在生产明细打卡、但不能改生产明细的字段。
 * 职位没有显式 perms 时按模板推导，行为跟以前完全一样，老数据不用迁移。
 */
const TEMPLATE_PERMS = {
  sales:      { scope: "own", editOrder: true,  editProd: false, logOrder: true,  logProd: false, createOrder: true, inspect: true },
  follower:   { scope: "own", editOrder: false, editProd: true,  logOrder: false, logProd: true,  createOrder: true, inspect: true },
  supervisor: { scope: "all", editOrder: true,  editProd: true,  logOrder: true,  logProd: true,  createOrder: true, inspect: true }
};
const PERM_KEYS = ["editOrder", "editProd", "logOrder", "logProd", "createOrder", "inspect"];
// 取某个职位的能力表：管理员永远全权（不可配置，免得把自己锁在门外）
function permsOf(u) {
  if (isAdmin(u)) return { scope: "all", editOrder: true, editProd: true, logOrder: true, logProd: true, createOrder: true, inspect: true };
  const t = templateOf(u);
  const base = TEMPLATE_PERMS[t] || TEMPLATE_PERMS.follower;
  const r = getSetting("roles", []).find(x => x.k === (u && u.role));
  const saved = r && r.perms;
  if (!saved) return base;
  // 显式配置只覆盖认识的键，脏数据不会把人的权限放大
  const out = Object.assign({}, base);
  if (saved.scope === "all" || saved.scope === "own") out.scope = saved.scope;
  PERM_KEYS.forEach(k => { if (typeof saved[k] === "boolean") out[k] = saved[k]; });
  return out;
}
// 是不是"这单的相关人员"：scope=all 的职位对所有单都算相关；
// scope=own 的按 template 决定归属关系（业务员认 sales，下厂员认 follower）
function isRelated(u, order) {
  if (!u || !order) return false;
  if (permsOf(u).scope === "all") return true;
  const t = templateOf(u);
  if (t === "sales") return isOwnBySales(u, order);
  if (t === "follower") return isOwnByFollower(u, order);
  return false;
}
// 能否看到这单(订单列表/详情读取用)。跟编辑不同的是不受发货锁定影响——
// 已发货的单本人仍要看得到，只是不能再改。
function canViewOrder(u, order) {
  if (!u) return false;
  if (isAdmin(u)) return true;
  return isRelated(u, order);
}
// 能否编辑订单某个板块。section 传 undefined 表示"不分板块"，有任一板块的编辑权即可
function canEditSection(u, order, section) {
  if (!u) return false;
  if (isAdmin(u)) return true;
  if (!isRelated(u, order)) return false;
  const p = permsOf(u);
  if (section === "order") return !!p.editOrder;
  if (section === "production") return !!p.editProd;
  return !!(p.editOrder || p.editProd);
}
// 能否编辑订单基本信息(不分板块，粗粒度判断"有没有编辑入口")
function canEditBasic(u, order) {
  return canEditSection(u, order, "order") || canEditSection(u, order, "production");
}
// 能否在某板块打卡。跟"改字段"是独立开关：可以只给打卡权、不给改字段权
function canAddLog(u, order, section) {
  if (!u) return false;
  if (isAdmin(u)) return true;
  if (!isRelated(u, order)) return false;
  const p = permsOf(u);
  if (section === "order") return !!p.logOrder;
  if (section === "production") return !!p.logProd;
  return !!(p.logOrder || p.logProd);
}
// 能否新建/导入订单
function canCreateOrder(u) {
  if (!u) return false;
  return isAdmin(u) || !!permsOf(u).createOrder;
}
// 能否修改/删除某条记录：管理员；自己创建的记录(不分板块)；或者对该板块有编辑权。
// 改别人写的记录比"自己打个卡"重一档，所以看的是编辑权而不是打卡权。
function canTouchEntry(u, order, entry, section) {
  if (!u) return false;
  if (isAdmin(u)) return true;
  if (entry && entry.by === u.id) return true;
  return canEditSection(u, order, section);
}

// 验货「发现问题」「整改情况」：单独一个开关，不跟着某个板块走
const canWriteInspProblem = (u, order) => {
  if (!u) return false;
  if (isAdmin(u)) return true;
  return isRelated(u, order) && !!permsOf(u).inspect;
};
const canWriteInspFix = canWriteInspProblem;

module.exports = {
  hashPassword, verifyPassword, signToken, userPublic, userById,
  authRequired, adminRequired, isAdmin, isSupervisor, shipLocked,
  canEditBasic, canEditSection, canAddLog, canTouchEntry, canViewOrder,
  roleTemplate, templateOf, roleLabel, canWriteInspProblem, canWriteInspFix,
  permsOf, isRelated, canCreateOrder, TEMPLATE_PERMS, PERM_KEYS
};
