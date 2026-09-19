"use strict";
// 多个路由文件共用的辅助函数：订单 / 字段 / 用户查询、上传存储、xlsx 片段
const { db, getSetting } = require("../db");
const A = require("../auth");

const getFields = () => getSetting("fields", { order: [], production: [] });
const allFields = () => { const f = getFields(); return [...f.order, ...f.production]; };

const getFactories = () => getSetting("factories", { emb: [], prod: [], proc: [] });
const activeUser = id => db.prepare("SELECT * FROM users WHERE id = ? AND deleted = 0").get(id);
const activeUsers = () => db.prepare("SELECT * FROM users WHERE deleted = 0").all();

function orderPublic(o) {
  return { id: o.id, season: o.season, createdBy: o.created_by, createdAt: o.created_at,
    values: o.data.values || {}, logs: o.data.logs || {}, mainLog: o.data.mainLog || [],
    subs: o.data.subs || [], inspections: o.data.inspections || [], followIssues: o.data.followIssues || [] };
}
const loadAllOrders = () => db.prepare("SELECT * FROM orders").all().map(r => { r.data = JSON.parse(r.data); return r; });
const allOrdersPublic = () => loadAllOrders().map(orderPublic);
// 按权限过滤后的订单列表
const visibleOrdersPublic = u => loadAllOrders().filter(r => A.canViewOrder(u, r)).map(orderPublic);
const logFields = () => allFields().filter(x => x.type === "log");

// 扩展名按类型白名单决定，不信客户端文件名(防止存成 .html 被同域打开)
const PHOTO_EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp" };

/* ---------- 导出 Excel（管理员） ----------
 * 直接拼 xlsx 的 XML，边生成边发；照片逐张读取，内存里同时只有一张 */
const XML_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;

const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const relsXml = rels => XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  rels.map(([id, type, target]) => `<Relationship Id="${id}" Type="${NS_REL}/${type}" Target="${target}"/>`).join("") + `</Relationships>`;

module.exports = { getFields, allFields, getFactories, activeUser, activeUsers, orderPublic, loadAllOrders, allOrdersPublic, visibleOrdersPublic, logFields, PHOTO_EXT, XML_HEAD, NS_REL, relsXml };
