"use strict";
// 当前用户与权限判断（只控制显示，规则同服务端 auth.js）

const userById = id => state.users.find(u => u.id === id);
// 离职员工不在 users 里，但老订单上还存着他的 id，姓名照样能查到
const formerUserById = id => state.formerUsers.find(u => u.id === id);
const uname = id => (userById(id) || formerUserById(id) || {}).name || "";
const me = () => state.me;
const isAdmin = () => me() && me().template === "admin";
const canCreateOrder = () => !!me();
const roleLabelOf = u => (u ? (u.roleLabel || (u.role === "admin" ? "管理员" : u.role)) : "");
const labelForRoleKey = k => k === "admin" ? "管理员" : ((state.roles.find(r => r.k === k) || {}).label || k);

function isSupervisor() { const u = me(); return !!u && u.template === "supervisor"; }
const TEMPLATE_PERMS = {
  sales:      { scope: "own", editOrder: true,  editProd: false, logOrder: true,  logProd: false, createOrder: true, inspect: true },
  follower:   { scope: "own", editOrder: false, editProd: true,  logOrder: false, logProd: true,  createOrder: true, inspect: true },
  supervisor: { scope: "all", editOrder: true,  editProd: true,  logOrder: true,  logProd: true,  createOrder: true, inspect: true }
};
const PERM_KEYS = ["editOrder", "editProd", "logOrder", "logProd", "createOrder", "inspect"];
function mergePerms(template, saved) {
  const base = TEMPLATE_PERMS[template] || TEMPLATE_PERMS.follower;
  if (!saved) return base;
  const out = Object.assign({}, base);
  if (saved.scope === "all" || saved.scope === "own") out.scope = saved.scope;
  PERM_KEYS.forEach(k => { if (typeof saved[k] === "boolean") out[k] = saved[k]; });
  return out;
}
function myPerms() {
  const u = me(); if (!u) return null;
  if (isAdmin()) return TEMPLATE_PERMS.supervisor;
  // 个人单独设置的看订单范围优先于职位(同服务端 permsOf)
  const rolePerms = (state.roles.find(r => r.k === u.role) || {}).perms;
  return mergePerms(u.template, u.scope === "own" || u.scope === "all" ? Object.assign({}, rolePerms, { scope: u.scope }) : rolePerms);
}
const permsOfRole = r => mergePerms(r.template, r.perms);
function isRelated(o) {
  const u = me(); if (!u || !o) return false;
  if (myPerms().scope === "all") return true;
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
function canTouchEntry(o, e, section) {
  const u = me(); if (!u) return false;
  if (isAdmin()) return true;
  if (isSupervisor()) return true;
  if (e && e.by === u.id) return true;
  return canEditSection(o, section);
}
const hasValue = v => v != null && v !== "" && !(Array.isArray(v) && !v.length);
// 单独一栏的字段在详情页直接改；填后锁定的(发货日期等)本单有编辑权就能填，填了只有管理员/主管能改
function canEditQuick(o, f, section) {
  if (!f.lock) return canEditSection(o, section);
  if (isAdmin() || isSupervisor()) return true;
  return !hasValue(o.values[f.k]) && canEditBasic(o);
}
const canWriteInspProblem = o => isRelated(o) && !!myPerms().inspect;
const canWriteInspFix = canWriteInspProblem;
