"use strict";
// 当前用户与权限判断（只控制显示，规则同服务端 auth.js）

const userById = id => state.users.find(u => u.id === id);
// 离职员工不在 users 里，但老订单上还存着他的 id，姓名照样能查到
const formerUserById = id => state.formerUsers.find(u => u.id === id);
const uname = id => (userById(id) || formerUserById(id) || {}).name || "";
const me = () => state.me;
const isAdmin = () => me() && me().template === "admin";
const canCreateOrder = () => !!me() && !!myPerms().createOrder;
const roleLabelOf = u => (u ? (u.roleLabel || (u.role === "admin" ? "管理员" : u.role)) : "");
const labelForRoleKey = k => k === "admin" ? "管理员" : ((state.roles.find(r => r.k === k) || {}).label || k);

function isSupervisor() { const u = me(); return !!u && u.template === "supervisor"; }
const TEMPLATE_PERMS = {
  sales:      { scope: "own", editOrder: true,  editProd: false, logOrder: true,  logProd: false, createOrder: true, inspect: true },
  follower:   { scope: "own", editOrder: false, editProd: true,  logOrder: false, logProd: true,  createOrder: true, inspect: true },
  supervisor: { scope: "all", editOrder: true,  editProd: true,  logOrder: true,  logProd: true,  createOrder: true, inspect: true }
};
const PERM_KEYS = ["editOrder", "editProd", "logOrder", "logProd", "createOrder", "inspect"];
// 看订单范围：own 只看自己相关 / all 全部 / factory 指定工厂的单加自己相关(只能按人设)
const SCOPES = ["own", "all", "factory"];
// 订单上的工厂：服装/面料/绣花/印花(同服务端 auth.js，「按工厂筛选」也用它)
const ORDER_FACTORY_KEYS = ["factory", "fabricFactory1", "fabricFactory2", "embFactory", "printFactory"];
const orderFactories = o => ORDER_FACTORY_KEYS.flatMap(k => [].concat(o.values[k] || [])).filter(Boolean);
function mergePerms(template, saved) {
  const base = TEMPLATE_PERMS[template] || TEMPLATE_PERMS.follower;
  if (!saved) return base;
  const out = Object.assign({}, base);
  if (SCOPES.includes(saved.scope)) out.scope = saved.scope;
  PERM_KEYS.forEach(k => { if (typeof saved[k] === "boolean") out[k] = saved[k]; });
  return out;
}
function myPerms() {
  const u = me(); if (!u) return null;
  if (isAdmin()) return TEMPLATE_PERMS.supervisor;
  // 个人单独设置的看订单范围优先于职位(同服务端 permsOf)
  const rolePerms = (state.roles.find(r => r.k === u.role) || {}).perms;
  return mergePerms(u.template, SCOPES.includes(u.scope) ? Object.assign({}, rolePerms, { scope: u.scope }) : rolePerms);
}
const permsOfRole = r => mergePerms(r.template, r.perms);
function isRelated(o) {
  const u = me(); if (!u || !o) return false;
  const scope = myPerms().scope;
  if (scope === "all") return true;
  if (scope === "factory" && orderFactories(o).some(f => (u.scopeFactories || []).includes(String(f).trim()))) return true;
  if (u.template === "sales") return o.values.sales === u.id || o.createdBy === u.id;
  if (u.template === "follower") return o.values.follower === u.id;
  return o.values.sales === u.id || o.values.follower === u.id || o.createdBy === u.id;
}
function sectionPerm(o, section, orderKey, prodKey) {
  if (!isRelated(o)) return false;
  const p = myPerms();
  if (section === "order") return !!p[orderKey];
  if (section === "production") return !!p[prodKey];
  return !!(p[orderKey] || p[prodKey]);
}
const canEditSection = (o, section) => sectionPerm(o, section, "editOrder", "editProd");
const canEditBasic = o => canEditSection(o);
const canAddLog = (o, section) => sectionPerm(o, section, "logOrder", "logProd");
// 改/删记录：看得到这单才行；自己写的可以(职位权限全关掉的只读账号除外)，别人写的要有该板块的编辑权
function canTouchEntry(o, e, section) {
  const u = me(); if (!u || !isRelated(o)) return false;
  const p = myPerms();
  if (e && e.by === u.id && PERM_KEYS.some(k => p[k])) return true;
  return canEditSection(o, section);
}
const hasValue = v => v != null && v !== "" && !(Array.isArray(v) && !v.length);
// 单独一栏的字段在详情页直接改；填后锁定的(发货日期等)本单有编辑权就能填，填了只有管理员/主管能改
function canEditQuick(o, f, section) {
  if (!f.lock) return canEditSection(o, section);
  if (!canEditBasic(o)) return false;
  return isAdmin() || isSupervisor() || !hasValue(o.values[f.k]);
}
const canWriteInspProblem = o => isRelated(o) && !!myPerms().inspect;
const canWriteInspFix = canWriteInspProblem;
