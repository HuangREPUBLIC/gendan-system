"use strict";
// 当前用户与权限判断（只控制显示，规则同服务端 auth.js）

const userById = id => state.users.find(u => u.id === id);
const uname = id => (userById(id) || {}).name || "";
const me = () => state.me;
const isAdmin = () => me() && me().template === "admin";
const canCreateOrder = () => !!me();
const roleLabelOf = u => (u ? (u.roleLabel || (u.role === "admin" ? "管理员" : u.role)) : "");
const labelForRoleKey = k => k === "admin" ? "管理员" : ((state.roles.find(r => r.k === k) || {}).label || k);

function isSupervisor() { const u = me(); return !!u && u.template === "supervisor"; }
function shipLocked(o) { return !!(o && o.values && o.values.shipDate); }
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
  return mergePerms(u.template, (state.roles.find(r => r.k === u.role) || {}).perms);
}
const permsOfRole = r => mergePerms(r.template, r.perms);
function isRelated(o) {
  const u = me(); if (!u || !o) return false;
  if (myPerms().scope === "all") return true;
  if (u.template === "sales") return o.values.sales === u.id || o.createdBy === u.id;
  if (u.template === "follower") return o.values.follower === u.id;
  return false;
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
// 发货日期填写后只有管理员/主管能改
function canEditShipDate(o) {
  if (isAdmin() || isSupervisor()) return true;
  if (shipLocked(o)) return false;
  return canEditBasic(o);
}
const canWriteInspProblem = o => isRelated(o) && !!myPerms().inspect;
const canWriteInspFix = canWriteInspProblem;
