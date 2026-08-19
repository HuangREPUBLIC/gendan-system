"use strict";
/**
 * 全部 API 路由，挂载在 /api 下。
 * 订单业务数据以 JSON 存在 orders.data 里，读出后形状与前端一致：
 *   { id, season, createdBy, createdAt, values, logs, subs, inspections, followIssues }
 * 所有写操作都在服务端做权限校验。
 */
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
const AdmZip = require("adm-zip");
const { db, uid, getSetting, setSetting, UPLOAD_DIR } = require("./db");
const A = require("./auth");

const router = express.Router();

/**
 * 从 xlsx（本质是个 zip 包）里把嵌入的图片(比如 WPS/Excel 表格里直接贴的款式图)抠出来，
 * 按图片锚定的行号(0-based，跟表头一起算，跟 sheet_to_json 的行下标对得上)配对。
 * 只处理"第一个工作表 + 它关联的 drawing"这个最常见的场景；解析失败/找不到就静默返回空，
 * 不影响正常的表格文字数据导入——图片是锦上添花，不是必须的。
 */
function extractEmbeddedImages(buf) {
  const images = {}; // 0-based 行号 -> { data: Buffer, ext: string }
  let zip;
  try { zip = new AdmZip(buf); } catch (e) { return images; }
  const entries = {}; zip.getEntries().forEach(e => { entries[e.entryName] = e; });

  const sheetRels = entries["xl/worksheets/_rels/sheet1.xml.rels"];
  if (!sheetRels) return images;
  const sheetRelsXml = sheetRels.getData().toString("utf8");
  const drawingRefM = sheetRelsXml.match(/Target="[^"]*?(drawing\d*\.xml)"/);
  if (!drawingRefM) return images;
  const drawingEntry = entries["xl/drawings/" + drawingRefM[1]];
  if (!drawingEntry) return images;
  const drawingXml = drawingEntry.getData().toString("utf8");

  const drawingRelsEntry = entries["xl/drawings/_rels/" + drawingRefM[1] + ".rels"];
  const rIdToMedia = {};
  if (drawingRelsEntry) {
    const relsXml = drawingRelsEntry.getData().toString("utf8");
    const re = /<Relationship[^>]*Id="(rId\d+)"[^>]*Target="[^"]*?(media\/[^"]+)"/g;
    let m;
    while ((m = re.exec(relsXml))) rIdToMedia[m[1]] = "xl/" + m[2];
  }

  const anchorRe = /<xdr:(?:twoCellAnchor|oneCellAnchor)[\s\S]*?<\/xdr:(?:twoCellAnchor|oneCellAnchor)>/g;
  let am;
  while ((am = anchorRe.exec(drawingXml))) {
    const block = am[0];
    const rowM = block.match(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/);
    const embedM = block.match(/r:embed="(rId\d+)"/);
    if (!rowM || !embedM) continue;
    const mediaPath = rIdToMedia[embedM[1]];
    const mediaEntry = mediaPath && entries[mediaPath];
    if (!mediaEntry) continue;
    const row = parseInt(rowM[1], 10);
    images[row] = { data: mediaEntry.getData(), ext: (path.extname(mediaPath) || ".png").toLowerCase() };
  }
  return images;
}

/**
 * 把真实图片写进导出的 xlsx，而不是"（有图）"文字或裸链接。
 * placements: [{ sheet: 1起(对应 sheetN.xml 的顺序), row: 0-based(含表头行), col: 0-based, urls: ["/uploads/xxx.jpg", ...] }]
 * 每个 (sheet,row) 目前只会对应一个照片列（各分表"照片"都是固定的最后一列，或订单基本信息里"款式图"独占一列），
 * 同一格里多张照片纵向堆叠展示（不会挤占右边其他列的数据），找不到的图片文件直接跳过、不影响其余导出内容。
 */
function embedImagesIntoXlsx(buf, placements) {
  if (!placements.length) return buf;
  const EMU = 9525, THUMB = 60, GAP = 4;
  let zip;
  try { zip = new AdmZip(buf); } catch (e) { return buf; }

  const bySheet = {};
  placements.forEach(p => { (bySheet[p.sheet] = bySheet[p.sheet] || []).push(p); });

  // 同一张图片可能在多处被引用（比如同一条打卡记录），全局只存一份，省文件体积
  const mediaCache = {};
  const mediaList = [];
  function mediaFor(url) {
    if (mediaCache[url]) return mediaCache[url];
    const rel = String(url || "").replace(/^\/+/, "");
    if (!rel.startsWith("uploads/")) return null;
    const filePath = path.join(UPLOAD_DIR, path.basename(rel));
    let data;
    try { data = fs.readFileSync(filePath); } catch (e) { return null; }
    const ext = ((path.extname(filePath) || ".jpg").toLowerCase().replace(".", "")) || "jpg";
    const item = { idx: mediaList.length + 1, ext };
    mediaList.push({ idx: item.idx, ext, data });
    mediaCache[url] = item;
    return item;
  }

  const drawingOverrides = [];

  Object.keys(bySheet).forEach(sheetNumStr => {
    const sheetNum = Number(sheetNumStr);
    const sheetPath = `xl/worksheets/sheet${sheetNum}.xml`;
    const sheetEntry = zip.getEntry(sheetPath);
    if (!sheetEntry) return;
    let sheetXml = sheetEntry.getData().toString("utf8");

    const anchors = [];
    const drawingRels = [];
    let relIdx = 1;

    bySheet[sheetNumStr].forEach(p => {
      const items = (p.urls || []).map(mediaFor).filter(Boolean);
      if (!items.length) return;
      items.forEach((item, i) => {
        const rId = "rId" + (relIdx++);
        drawingRels.push({ rId, target: `../media/image${item.idx}.${item.ext}` });
        anchors.push({ col: p.col, row: p.row, rowOff: i * (THUMB + GAP) * EMU, rId });
      });
      const htPt = Math.max(20, items.length * (THUMB + GAP) * 0.75 + 3);
      const excelRow = p.row + 1;
      const rowRe = new RegExp(`<row r="${excelRow}"([^>]*)>`);
      if (rowRe.test(sheetXml)) {
        sheetXml = sheetXml.replace(rowRe, (m, attrs) => {
          const cleaned = attrs.replace(/\s*ht="[^"]*"/g, "").replace(/\s*customHeight="[^"]*"/g, "");
          return `<row r="${excelRow}"${cleaned} ht="${htPt.toFixed(2)}" customHeight="1">`;
        });
      }
    });
    if (!anchors.length) return;

    // 照片列适当加宽，别让缩略图挤在窄格子里看不清
    const colNum = anchors[0].col + 1;
    const colsXml = `<cols><col min="${colNum}" max="${colNum}" width="11" customWidth="1"/></cols>`;
    if (!/<cols>/.test(sheetXml)) sheetXml = sheetXml.replace("<sheetData>", colsXml + "<sheetData>");

    const drawingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      anchors.map((a, i) => `<xdr:oneCellAnchor>` +
        `<xdr:from><xdr:col>${a.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.row}</xdr:row><xdr:rowOff>${a.rowOff}</xdr:rowOff></xdr:from>` +
        `<xdr:ext cx="${THUMB * EMU}" cy="${THUMB * EMU}"/>` +
        `<xdr:pic>` +
        `<xdr:nvPicPr><xdr:cNvPr id="${i + 1}" name="img${i + 1}"/><xdr:cNvPicPr/></xdr:nvPicPr>` +
        `<xdr:blipFill><a:blip r:embed="${a.rId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
        `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${THUMB * EMU}" cy="${THUMB * EMU}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>` +
        `</xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`).join("") +
      `</xdr:wsDr>`;
    const drawingRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      drawingRels.map(r => `<Relationship Id="${r.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${r.target}"/>`).join("") +
      `</Relationships>`;

    const drawingName = `drawing${sheetNum}.xml`;
    zip.addFile(`xl/drawings/${drawingName}`, Buffer.from(drawingXml, "utf8"));
    zip.addFile(`xl/drawings/_rels/${drawingName}.rels`, Buffer.from(drawingRelsXml, "utf8"));
    drawingOverrides.push(`<Override PartName="/xl/drawings/${drawingName}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);

    const wsRelsPath = `xl/worksheets/_rels/sheet${sheetNum}.xml.rels`;
    const existingWsRels = zip.getEntry(wsRelsPath);
    let wsRelsXml = existingWsRels
      ? existingWsRels.getData().toString("utf8")
      : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
    const usedIds = [...wsRelsXml.matchAll(/Id="rId(\d+)"/g)].map(m => Number(m[1]));
    const drawRId = "rId" + (usedIds.length ? Math.max(...usedIds) + 1 : 1);
    wsRelsXml = wsRelsXml.replace("</Relationships>",
      `<Relationship Id="${drawRId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/${drawingName}"/></Relationships>`);
    zip.addFile(wsRelsPath, Buffer.from(wsRelsXml, "utf8"));

    if (!/<drawing /.test(sheetXml)) sheetXml = sheetXml.replace("</worksheet>", `<drawing r:id="${drawRId}"/></worksheet>`);
    zip.updateFile(sheetEntry, Buffer.from(sheetXml, "utf8"));
  });

  // 图片(jpg/png等)本身已经是压缩过的格式，zip 再用 DEFLATE 压一遍基本没有效果、只是白白耗 CPU，
  // 尤其是照片一多，重新打包这一步会明显变慢；这里改成 STORED(不压缩)存，文件体积几乎不变但快很多
  mediaList.forEach(m => {
    const name = `xl/media/image${m.idx}.${m.ext}`;
    zip.addFile(name, m.data);
    zip.getEntry(name).header.method = 0;
  });
  if (drawingOverrides.length) {
    let ctXml = zip.getEntry("[Content_Types].xml").getData().toString("utf8");
    ctXml = ctXml.replace("</Types>", drawingOverrides.join("") + "</Types>");
    zip.updateFile("[Content_Types].xml", Buffer.from(ctXml, "utf8"));
  }
  return zip.toBuffer();
}

/* ---------- 订单读写帮助 ---------- */
function loadOrder(id) {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!row) return null;
  row.data = JSON.parse(row.data);
  return row;
}
function saveOrder(o) {
  db.prepare("UPDATE orders SET season=?, updated_at=?, data=? WHERE id=?")
    .run(o.season, Date.now(), JSON.stringify(o.data), o.id);
}
// 只接受本系统 /uploads/ 下的图片路径，最多 100 张，避免存入恶意 URL
function cleanPhotos(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(x => typeof x === "string" && /^\/uploads\/[\w.\-]+$/.test(x)).slice(0, 100);
}

function orderPublic(o) {
  return { id: o.id, season: o.season, createdBy: o.created_by, createdAt: o.created_at,
    values: o.data.values || {}, logs: o.data.logs || {}, mainLog: o.data.mainLog || [],
    subs: o.data.subs || [], inspections: o.data.inspections || [], followIssues: o.data.followIssues || [] };
}
function allOrdersPublic() {
  return db.prepare("SELECT * FROM orders").all().map(r => { r.data = JSON.parse(r.data); return orderPublic(r); });
}
// 订单列表可见范围：业务员只看自己创建/负责的，下厂员只看自己被指派的；主管/管理员不受限。
// (导出/员工历史打卡这两处要看全部订单的场景，仍然直接用上面的 allOrdersPublic，不经过这层过滤)
function visibleOrdersPublic(u) {
  const rows = db.prepare("SELECT * FROM orders").all().map(r => { r.data = JSON.parse(r.data); return r; });
  return rows.filter(r => A.canViewOrder(u, r)).map(orderPublic);
}
function logFields() {
  const f = getSetting("fields", { order: [], production: [] });
  return [...f.order, ...f.production].filter(x => x.type === "log");
}
function sectionOfKey(key) {
  if (key === "mainLog" || key.startsWith("sub:")) return "production";
  const f = getSetting("fields", { order: [], production: [] });
  return f.order.some(x => x.k === key) ? "order" : "production";
}
function listForKey(o, key) {
  if (key === "mainLog") {
    if (!o.data.mainLog) o.data.mainLog = [];
    return o.data.mainLog;
  }
  if (key.startsWith("sub:")) {
    const sub = (o.data.subs || []).find(x => x.id === key.slice(4));
    return sub ? sub.log : null;
  }
  o.data.logs = o.data.logs || {};
  if (!o.data.logs[key]) o.data.logs[key] = [];
  return o.data.logs[key];
}
function emptyOrderData(values) {
  const logs = {};
  logFields().forEach(f => logs[f.k] = []);
  return { values: values || {}, logs, mainLog: [], subs: [], inspections: [], followIssues: [] };
}

/* =========================================================
 *  认证相关（无需登录）
 * ========================================================= */
router.post("/login", (req, res) => {
  const { phone, password } = req.body || {};
  const u = db.prepare("SELECT * FROM users WHERE phone = ? AND deleted = 0").get(String(phone || "").trim());
  if (!u || !A.verifyPassword(password || "", u.password_hash))
    return res.status(400).json({ error: "手机号或密码不正确" });
  res.json({ token: A.signToken(u), user: A.userPublic(u) });
});

// 已移除"凭手机号自助改密"（公网下会被拿来盗号）。
// 改密码：登录后在「我的」自行修改；忘记密码找管理员在后台重置。

/* 以下全部需要登录 */
router.use(A.authRequired);

router.get("/bootstrap", (req, res) => {
  res.json({
    me: A.userPublic(req.user),
    users: db.prepare("SELECT * FROM users WHERE deleted = 0").all().map(A.userPublic),
    fields: getSetting("fields", { order: [], production: [] }),
    factories: getSetting("factories", { emb: [], prod: [], proc: [] }),
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

/* =========================================================
 *  意见反馈：任何登录用户可提交/查看自己的；管理员能看全部、标记已处理
 * ========================================================= */
router.post("/feedback", (req, res) => {
  const text = String((req.body || {}).text || "").trim();
  if (!text) return res.status(400).json({ error: "请填写反馈内容" });
  db.prepare("INSERT INTO feedback(id,by_user,text,created_at) VALUES(?,?,?,?)")
    .run(uid(), req.user.id, text, Date.now());
  res.json({ ok: true });
});

router.get("/feedback", A.adminRequired, (req, res) => {
  const users = db.prepare("SELECT id,name FROM users").all();
  const nameOf = id => (users.find(u => u.id === id) || {}).name || id || "";
  const rows = db.prepare("SELECT * FROM feedback ORDER BY created_at DESC").all()
    .map(r => ({ id: r.id, text: r.text, createdAt: r.created_at, byName: nameOf(r.by_user),
      handled: !!r.handled, handledAt: r.handled_at }));
  res.json(rows);
});

// 提交人查看自己提交过的反馈，能看到管理员是否已处理
router.get("/feedback/mine", (req, res) => {
  const rows = db.prepare("SELECT * FROM feedback WHERE by_user = ? ORDER BY created_at DESC").all(req.user.id)
    .map(r => ({ id: r.id, text: r.text, createdAt: r.created_at, handled: !!r.handled, handledAt: r.handled_at }));
  res.json(rows);
});

router.patch("/feedback/:id", A.adminRequired, (req, res) => {
  const row = db.prepare("SELECT * FROM feedback WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "反馈不存在" });
  const handled = !!(req.body || {}).handled;
  db.prepare("UPDATE feedback SET handled = ?, handled_at = ? WHERE id = ?")
    .run(handled ? 1 : 0, handled ? Date.now() : null, req.params.id);
  res.json({ ok: true, handled });
});

/* =========================================================
 *  员工账号管理（管理员）
 * ========================================================= */
router.get("/users", A.adminRequired, (req, res) => {
  res.json(db.prepare("SELECT * FROM users WHERE deleted = 0").all().map(A.userPublic));
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
  res.json(A.userPublic(db.prepare("SELECT * FROM users WHERE id=?").get(id)));
});

// 修改员工：姓名 / 手机号 / 角色（角色可下拉改任何人，但不含自己）
router.patch("/users/:id", A.adminRequired, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!u || u.deleted) return res.status(404).json({ error: "员工不存在" });
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
  res.json(A.userPublic(db.prepare("SELECT * FROM users WHERE id=?").get(u.id)));
});

router.post("/users/:id/reset-password", A.adminRequired, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!u || u.deleted) return res.status(404).json({ error: "员工不存在" });
  const { password } = req.body || {};
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(A.hashPassword(password || "123456"), u.id);
  res.json({ ok: true });
});

router.delete("/users/:id", A.adminRequired, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!u || u.deleted) return res.status(404).json({ error: "员工不存在" });
  if (u.id === req.user.id) return res.status(400).json({ error: "不能删除自己的账号" });
  if (u.role === "admin") return res.status(400).json({ error: "不能删除管理员账号" });
  db.prepare("UPDATE users SET deleted=1 WHERE id=?").run(u.id);
  res.json({ ok: true });
});

/* =========================================================
 *  自定义字段 / 工厂下拉（管理员）
 * ========================================================= */
router.post("/fields", A.adminRequired, (req, res) => {
  const { section, label, type, options } = req.body || {};
  if (!["order", "production"].includes(section)) return res.status(400).json({ error: "板块不对" });
  const lb = String(label || "").trim();
  if (!lb) return res.status(400).json({ error: "请填写字段名称" });
  const fields = getSetting("fields", { order: [], production: [] });
  if (fields[section].some(x => x.label === lb)) return res.status(400).json({ error: `「${lb}」字段已存在，不能重复添加` });
  const f = { k: "f" + Date.now(), label: lb, type: type || "text" };
  if (type === "select") f.options = (options || []).map(s => String(s).trim()).filter(Boolean);
  fields[section].push(f);
  setSetting("fields", fields);
  if (type === "log") { // 给已有订单补上这个进度字段的空数组
    db.prepare("SELECT id, data FROM orders").all().forEach(r => {
      const d = JSON.parse(r.data); d.logs = d.logs || {}; if (!d.logs[f.k]) d.logs[f.k] = [];
      db.prepare("UPDATE orders SET data=? WHERE id=?").run(JSON.stringify(d), r.id);
    });
  }
  res.json(fields);
});

router.delete("/fields/:section/:key", A.adminRequired, (req, res) => {
  const { section, key } = req.params;
  const fields = getSetting("fields", { order: [], production: [] });
  if (!fields[section]) return res.status(400).json({ error: "板块不对" });
  const f = fields[section].find(x => x.k === key);
  if (!f) return res.status(404).json({ error: "字段不存在" });
  if (f.core) return res.status(400).json({ error: "核心字段不可删除" });
  fields[section] = fields[section].filter(x => x.k !== key);
  setSetting("fields", fields);
  res.json(fields);
});

router.post("/factories", A.adminRequired, (req, res) => {
  const { kind, name } = req.body || {};
  const factories = getSetting("factories", { emb: [], prod: [], proc: [] });
  if (!factories[kind]) return res.status(400).json({ error: "类型不对" });
  const v = String(name || "").trim();
  if (v && !factories[kind].includes(v)) factories[kind].push(v);
  setSetting("factories", factories);
  res.json(factories);
});

router.delete("/factories/:kind/:name", A.adminRequired, (req, res) => {
  const { kind, name } = req.params;
  const factories = getSetting("factories", { emb: [], prod: [], proc: [] });
  if (!factories[kind]) return res.status(400).json({ error: "类型不对" });
  factories[kind] = factories[kind].filter(x => x !== decodeURIComponent(name));
  setSetting("factories", factories);
  res.json(factories);
});

/* ---------- 季节管理（管理员：新建订单可选的季节列表） ---------- */
router.post("/seasons", A.adminRequired, (req, res) => {
  const name = String((req.body || {}).name || "").trim();
  if (!name) return res.status(400).json({ error: "请填写季节名称" });
  const seasons = getSetting("seasons", []);
  if (seasons.includes(name)) return res.status(400).json({ error: "已有同名季节" });
  seasons.push(name);
  setSetting("seasons", seasons);
  res.json(seasons);
});

router.delete("/seasons/:name", A.adminRequired, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const seasons = getSetting("seasons", []);
  if (!seasons.includes(name)) return res.status(404).json({ error: "季节不存在" });
  const used = db.prepare("SELECT COUNT(*) c FROM orders WHERE season = ?").get(name).c;
  if (used) return res.status(400).json({ error: `还有 ${used} 个订单是「${name}」季节，请先修改这些订单的季节` });
  const next = seasons.filter(x => x !== name);
  setSetting("seasons", next);
  res.json(next);
});

/* =========================================================
 *  订单
 * ========================================================= */
function canCreateOrder(u) { return !!u; }

router.get("/orders", (req, res) => res.json(visibleOrdersPublic(req.user)));
router.get("/orders/:id", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  if (!A.canViewOrder(req.user, o)) return res.status(403).json({ error: "无权查看此订单" });
  res.json(orderPublic(o));
});

router.post("/orders", (req, res) => {
  if (!canCreateOrder(req.user)) return res.status(403).json({ error: "只有业务员或管理员可以新建订单" });
  const { season, values } = req.body || {};
  const v = values || {};
  if (!v.styleNo && !v.styleName) return res.status(400).json({ error: "请至少填写货号或款式名" });
  if (req.user.role === "sales" && !v.sales) v.sales = req.user.id;
  const id = uid(), now = Date.now();
  db.prepare("INSERT INTO orders(id,season,created_by,created_at,updated_at,data) VALUES(?,?,?,?,?,?)")
    .run(id, season || "未分季", req.user.id, now, now, JSON.stringify(emptyOrderData(v)));
  res.json(orderPublic(loadOrder(id)));
});

router.post("/orders/import", (req, res) => {
  if (!canCreateOrder(req.user)) return res.status(403).json({ error: "只有业务员或管理员可以导入" });
  const rows = (req.body && req.body.orders) || [];
  let n = 0; const now = Date.now();
  for (const r of rows) {
    const v = r.values || {};
    if (!v.styleNo && !v.styleName) continue;
    if (req.user.role === "sales" && !v.sales) v.sales = req.user.id;
    db.prepare("INSERT INTO orders(id,season,created_by,created_at,updated_at,data) VALUES(?,?,?,?,?,?)")
      .run(uid(), r.season || "未分季", req.user.id, now, now, JSON.stringify(emptyOrderData(v)));
    n++;
  }
  if (!n) return res.status(400).json({ error: "没有可导入的订单（每单至少要有货号或款式名）" });
  res.json({ imported: n });
});

router.patch("/orders/:id", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  if (!A.canEditBasic(req.user, o)) return res.status(403).json({ error: "无权修改此订单的基本信息" });
  const { season, values } = req.body || {};
  // 季节算"一、订单明细"的内容；values 里每个字段按它所属的板块(order/production)分别校验——
  // 业务员只能改"一、订单明细"，下厂员只能改"二、生产明细"，主管/管理员不受限
  if (season !== undefined && String(season).trim()) {
    if (!A.canEditSection(req.user, o, "order")) return res.status(403).json({ error: "无权修改「一、订单明细」的内容" });
    o.season = String(season).trim();
  }
  if (values && typeof values === "object") {
    for (const key of Object.keys(values)) {
      // 发货日期一旦填写，只有管理员能再改这一个字段；没填写时本单相关人员(业务员/下厂员/主管/
      // 管理员，不分一二板块)都能设置；不影响订单其它内容的正常编辑
      if (key === "shipDate") {
        if (A.shipLocked(o) && !A.isAdmin(req.user)) {
          return res.status(403).json({ error: "发货日期一经填写，只有管理员能再修改" });
        }
        if (!A.canEditBasic(req.user, o)) {
          return res.status(403).json({ error: "无权修改发货日期" });
        }
        continue;
      }
      // 指定下厂员是谁算业务员能管的事(建单时随便指定不受此限)：业务员(自己的单)/主管/管理员能改，下厂员不能自己改派
      if (key === "follower") {
        if (!A.canEditSection(req.user, o, "order")) {
          return res.status(403).json({ error: "无权指定下厂员" });
        }
        continue;
      }
      const section = sectionOfKey(key);
      if (!A.canEditSection(req.user, o, section)) {
        return res.status(403).json({ error: `无权修改「${section === "order" ? "一、订单明细" : "二、生产明细"}」的内容` });
      }
    }
    o.data.values = Object.assign({}, o.data.values, values);
  }
  saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

router.delete("/orders/:id", A.adminRequired, (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  db.prepare("DELETE FROM orders WHERE id=?").run(o.id);
  res.json({ ok: true });
});

/* ---------- 打卡记录 ---------- */
router.post("/orders/:id/logs", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  const { key, text, process, workers, estDone } = req.body || {};
  const section = sectionOfKey(key);
  if (!A.canAddLog(req.user, o, section)) return res.status(403).json({ error: "你没有权限在此订单打卡" });
  const list = listForKey(o, key);
  if (!list) return res.status(400).json({ error: "字段不存在" });
  const t = String(text || "").trim();
  const photos = cleanPhotos((req.body || {}).photos);
  const entry = { id: uid(), by: req.user.id, byName: req.user.name, t: Date.now(), text: t, photos };
  // 主厂/加工点打卡：生产工序/车工人数/预计下车时间是必填项，其它进度字段(面料进度/裁剪进度等)仍是纯文字打卡
  if (key === "mainLog" || String(key).startsWith("sub:")) {
    const proc = String(process || "").trim(), wk = String(workers || "").trim(), est = String(estDone || "").trim();
    if (!proc || !wk || !est) return res.status(400).json({ error: "请填写生产工序、车工人数、预计下车时间" });
    Object.assign(entry, { process: proc, workers: wk, estDone: est });
  } else if (!t && !photos.length) return res.status(400).json({ error: "请填写打卡内容或添加照片" });
  list.push(entry);
  saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

router.patch("/orders/:id/logs/:key/:entryId", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  const list = listForKey(o, req.params.key);
  const e = list && list.find(x => x.id === req.params.entryId);
  if (!e) return res.status(404).json({ error: "记录不存在" });
  if (!A.canTouchEntry(req.user, o, e, sectionOfKey(req.params.key))) return res.status(403).json({ error: "无权修改这条打卡记录" });
  const t = String((req.body || {}).text || "").trim();
  const photos = Array.isArray((req.body || {}).photos) ? cleanPhotos((req.body || {}).photos) : (e.photos || []);
  if (!t && !photos.length) return res.status(400).json({ error: "内容和照片不能都为空" });
  e.text = t; e.photos = photos; saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

router.delete("/orders/:id/logs/:key/:entryId", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  const list = listForKey(o, req.params.key);
  const e = list && list.find(x => x.id === req.params.entryId);
  if (!e) return res.status(404).json({ error: "记录不存在" });
  if (!A.canTouchEntry(req.user, o, e, sectionOfKey(req.params.key))) return res.status(403).json({ error: "无权删除这条打卡记录" });
  list.splice(list.indexOf(e), 1); saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

// 加工点：下厂员自己决定要不要加、加几个、叫什么名字，不用管理员预先配置下拉
router.post("/orders/:id/subs", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  if (!A.canAddLog(req.user, o, "production")) return res.status(403).json({ error: "无权添加加工点" });
  const name = String((req.body || {}).name || "").trim();
  if (!name) return res.status(400).json({ error: "请填写加工点名称" });
  o.data.subs = o.data.subs || [];
  o.data.subs.push({ id: uid(), name, log: [] });
  saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

router.patch("/orders/:id/subs/:subId", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  if (!A.canAddLog(req.user, o, "production")) return res.status(403).json({ error: "无权修改" });
  const sub = (o.data.subs || []).find(x => x.id === req.params.subId);
  if (!sub) return res.status(404).json({ error: "加工点不存在" });
  const name = String((req.body || {}).name || "").trim();
  if (!name) return res.status(400).json({ error: "名称不能为空" });
  sub.name = name; saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

router.delete("/orders/:id/subs/:subId", A.adminRequired, (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  const before = (o.data.subs || []).length;
  o.data.subs = (o.data.subs || []).filter(x => x.id !== req.params.subId);
  if (o.data.subs.length === before) return res.status(404).json({ error: "加工点不存在" });
  saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

/* ---------- 验货问题 ----------
 * 「发现问题」只能业务员/管理员写；「整改情况」只能本单负责下厂员/管理员写。
 * 业务员验货时一次可以记录当次发现的所有问题（每条一个 item，fix 先留空）；
 * 下厂员随后逐条填整改情况。不再要求手动选日期，用提交时的服务器时间。
 */
router.post("/orders/:id/inspections", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  if (!A.canWriteInspProblem(req.user, o)) return res.status(403).json({ error: "无权在此订单记录验货发现的问题" });
  const problems = ((req.body || {}).problems || []).map(x => String(x || "").trim()).filter(Boolean);
  const inspPhotos = cleanPhotos((req.body || {}).photos);
  if (!problems.length && !inspPhotos.length) return res.status(400).json({ error: "请至少填写一条发现的问题或添加照片" });
  const now = Date.now();
  const items = problems.map(p => ({
    id: uid(), problem: p, problemBy: req.user.id, problemByName: req.user.name, problemAt: now,
    fix: "", fixBy: null, fixByName: "", fixAt: null, notes: []
  }));
  o.data.inspections.push({ id: uid(), t: now, by: req.user.id, byName: req.user.name, photos: inspPhotos, items });
  saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

// 改某一条的「发现问题」或「整改情况」——两个字段各自独立校验权限，传哪个改哪个
router.patch("/orders/:id/inspections/:instId/items/:itemId", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  const batch = o.data.inspections.find(x => x.id === req.params.instId);
  const item = batch && batch.items.find(x => x.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: "记录不存在" });
  const body = req.body || {};
  let touched = false;
  if (body.problem !== undefined) {
    if (!A.canWriteInspProblem(req.user, o)) return res.status(403).json({ error: "无权修改发现的问题" });
    const v = String(body.problem).trim();
    if (!v) return res.status(400).json({ error: "发现的问题不能为空" });
    item.problem = v; item.problemBy = req.user.id; item.problemByName = req.user.name; item.problemAt = Date.now();
    touched = true;
  }
  if (body.fix !== undefined) {
    if (!A.canWriteInspFix(req.user, o)) return res.status(403).json({ error: "只有本单负责下厂员或管理员可以填写整改情况" });
    item.fix = String(body.fix).trim(); item.fixBy = req.user.id; item.fixByName = req.user.name; item.fixAt = Date.now();
    touched = true;
  }
  if (!touched) return res.status(400).json({ error: "没有可修改的内容" });
  saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

// 补充说明：漏填/需要补充时，双方（发现问题方或整改方）都能加一条，不覆盖原内容
router.post("/orders/:id/inspections/:instId/items/:itemId/notes", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  const batch = o.data.inspections.find(x => x.id === req.params.instId);
  const item = batch && batch.items.find(x => x.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: "记录不存在" });
  if (!A.canWriteInspProblem(req.user, o) && !A.canWriteInspFix(req.user, o)) return res.status(403).json({ error: "无权添加补充说明" });
  const text = String((req.body || {}).text || "").trim();
  if (!text) return res.status(400).json({ error: "请填写补充说明" });
  item.notes = item.notes || [];
  item.notes.push({ id: uid(), by: req.user.id, byName: req.user.name, t: Date.now(), text });
  saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

router.delete("/orders/:id/inspections/:inspId", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  const g = o.data.inspections.find(x => x.id === req.params.inspId);
  if (!g) return res.status(404).json({ error: "记录不存在" });
  if (!A.canTouchEntry(req.user, o, g)) return res.status(403).json({ error: "无权删除这条验货记录" });
  o.data.inspections = o.data.inspections.filter(x => x.id !== g.id); saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

/* ---------- 跟单问题 ---------- */
router.post("/orders/:id/follow", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  if (!A.canAddLog(req.user, o)) return res.status(403).json({ error: "无权在此订单添加跟单小结" });
  const t = String((req.body || {}).text || "").trim();
  const photos = cleanPhotos((req.body || {}).photos);
  if (!t && !photos.length) return res.status(400).json({ error: "请填写内容或添加照片" });
  o.data.followIssues.push({ id: uid(), by: req.user.id, byName: req.user.name, t: Date.now(), text: t, photos });
  saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

router.delete("/orders/:id/follow/:entryId", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  const e = o.data.followIssues.find(x => x.id === req.params.entryId);
  if (!e) return res.status(404).json({ error: "记录不存在" });
  if (!A.canTouchEntry(req.user, o, e)) return res.status(403).json({ error: "无权删除这条记录" });
  o.data.followIssues = o.data.followIssues.filter(x => x.id !== e.id); saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

/* =========================================================
 *  职位管理（管理员）：名称自由，权限从两套模板里选
 * ========================================================= */
router.get("/roles", (req, res) => res.json(getSetting("roles", [])));

router.post("/roles", A.adminRequired, (req, res) => {
  const { label, template } = req.body || {};
  const name = String(label || "").trim();
  if (!name) return res.status(400).json({ error: "请填写职位名称" });
  if (!["sales", "follower", "supervisor"].includes(template))
    return res.status(400).json({ error: "请选择权限模板（业务员权限 / 下厂员权限 / 主管权限）" });
  const roles = getSetting("roles", []);
  if (roles.some(r => r.label === name)) return res.status(400).json({ error: "已有同名职位" });
  roles.push({ k: "r" + Date.now(), label: name, template });
  setSetting("roles", roles);
  res.json(roles);
});

router.delete("/roles/:k", A.adminRequired, (req, res) => {
  const roles = getSetting("roles", []);
  const r = roles.find(x => x.k === req.params.k);
  if (!r) return res.status(404).json({ error: "职位不存在" });
  if (r.core) return res.status(400).json({ error: "内置职位不可删除" });
  const used = db.prepare("SELECT COUNT(*) c FROM users WHERE role = ? AND deleted = 0").get(r.k).c;
  if (used) return res.status(400).json({ error: `还有 ${used} 位员工是「${r.label}」，请先把他们改成其它职位` });
  setSetting("roles", roles.filter(x => x.k !== r.k));
  res.json(roles.filter(x => x.k !== r.k));
});

/* =========================================================
 *  私人聊天（所有人可用，一对一）
 * ========================================================= */
// 联系人列表：除自己外的所有在职同事 + 最后一条消息 + 未读数
router.get("/chat/contacts", (req, res) => {
  const meId = req.user.id;
  const others = db.prepare("SELECT * FROM users WHERE deleted = 0 AND id <> ?").all(meId);
  const lastStmt = db.prepare(`SELECT * FROM messages
      WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
      ORDER BY created_at DESC LIMIT 1`);
  const unreadStmt = db.prepare("SELECT COUNT(*) c FROM messages WHERE from_user = ? AND to_user = ? AND read_at IS NULL");
  const list = others.map(u => {
    const last = lastStmt.get(meId, u.id, u.id, meId);
    return Object.assign(A.userPublic(u), {
      unread: unreadStmt.get(u.id, meId).c,
      last: last ? { text: last.text || (last.attachment ? "[附件]" : ""), t: last.created_at,
        fromMe: last.from_user === meId } : null
    });
  });
  // 有聊天记录的按最后消息时间排前面，其余按姓名
  list.sort((a, b) => {
    if (a.last && b.last) return b.last.t - a.last.t;
    if (a.last) return -1;
    if (b.last) return 1;
    return a.name.localeCompare(b.name, "zh");
  });
  res.json(list);
});

// 未读总数（用于导航红点轮询）
router.get("/chat/unread", (req, res) => {
  const rows = db.prepare("SELECT from_user, COUNT(*) c FROM messages WHERE to_user = ? AND read_at IS NULL GROUP BY from_user")
    .all(req.user.id);
  const byUser = {};
  let total = 0;
  rows.forEach(r => { byUser[r.from_user] = r.c; total += r.c; });
  res.json({ total, byUser });
});

// 与某人的对话（打开即把对方发来的消息标记为已读）
router.get("/chat/with/:userId", (req, res) => {
  const meId = req.user.id, otherId = req.params.userId;
  const other = db.prepare("SELECT * FROM users WHERE id = ? AND deleted = 0").get(otherId);
  if (!other) return res.status(404).json({ error: "该同事不存在或已离职" });
  db.prepare("UPDATE messages SET read_at = ? WHERE from_user = ? AND to_user = ? AND read_at IS NULL")
    .run(Date.now(), otherId, meId);
  const msgs = db.prepare(`SELECT * FROM messages
      WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
      ORDER BY created_at ASC`).all(meId, otherId, otherId, meId);
  res.json({
    contact: A.userPublic(other),
    messages: msgs.map(m => ({ id: m.id, text: m.text, t: m.created_at, fromMe: m.from_user === meId,
      attachment: m.attachment ? JSON.parse(m.attachment) : null }))
  });
});

router.post("/chat/with/:userId", (req, res) => {
  const meId = req.user.id, otherId = req.params.userId;
  if (otherId === meId) return res.status(400).json({ error: "不能给自己发消息" });
  const other = db.prepare("SELECT id FROM users WHERE id = ? AND deleted = 0").get(otherId);
  if (!other) return res.status(404).json({ error: "该同事不存在或已离职" });
  const text = String((req.body || {}).text || "").trim();
  const att = (req.body || {}).attachment || null;
  if (!text && !att) return res.status(400).json({ error: "消息不能为空" });
  if (text.length > 2000) return res.status(400).json({ error: "消息太长了" });
  db.prepare("INSERT INTO messages(id,from_user,to_user,text,attachment,created_at,read_at) VALUES(?,?,?,?,?,?,NULL)")
    .run(uid(), meId, otherId, text, att ? JSON.stringify(att) : null, Date.now());
  res.json({ ok: true });
});

/* ---------- 某员工的历史打卡（本人或管理员可看） ---------- */
router.get("/users/:id/logs", (req, res) => {
  const targetId = req.params.id;
  if (targetId !== req.user.id && req.user.role !== "admin")
    return res.status(403).json({ error: "只能查看自己的打卡记录" });
  const fields = getSetting("fields", { order: [], production: [] });
  const logFs = [...fields.order, ...fields.production].filter(f => f.type === "log");
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

/* ---------- 款式图上传 ---------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, uid() + (path.extname(file.originalname || "").toLowerCase() || ".jpg"))
});
const upload = multer({
  storage, limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype))
});
router.post("/upload", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "请选择图片文件" });
  res.json({ url: "/uploads/" + req.file.filename });
});

/* ---------- 聊天附件：图片和常见办公文件 ---------- */
const OK_EXT = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic",
  ".pdf", ".xlsx", ".xls", ".csv", ".doc", ".docx", ".ppt", ".pptx", ".txt", ".zip"];
const chatUpload = multer({
  storage, limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, OK_EXT.includes(path.extname(file.originalname || "").toLowerCase()))
});
router.post("/chat/upload", chatUpload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "不支持的文件类型，或文件超过 20MB" });
  const name = Buffer.from(req.file.originalname || "文件", "latin1").toString("utf8");
  res.json({
    url: "/uploads/" + req.file.filename,
    name, size: req.file.size,
    isImage: /^image\//.test(req.file.mimetype)
  });
});

/* ---------- 导入：解析上传的 Excel / CSV ----------
 * 直接支持 .xlsx/.xls，不用再另存为 CSV；
 * CSV 先按 UTF-8 解，出现乱码字符时自动改用 GBK
 *（Windows 版 Excel「另存为 CSV」默认就是 GBK，不处理会中文全乱码）。
 */
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const IMPORT_EXT = [".xlsx", ".xls", ".csv", ".txt"];

router.post("/import/parse", (req, res, next) => {
  memUpload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "文件太大（超过 50MB），请压缩图片后再导入" : "文件上传失败" });
    next();
  });
}, (req, res) => {
  if (!req.file) return res.status(400).json({ error: "请选择文件" });
  const ext = path.extname(req.file.originalname || "").toLowerCase();
  if (!IMPORT_EXT.includes(ext))
    return res.status(400).json({ error: "只支持 Excel(.xlsx/.xls) 和 CSV(.csv/.txt) 文件" });

  let wb, encoding = "UTF-8";
  try {
    if (ext === ".xlsx" || ext === ".xls") {
      wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true, dateNF: "yyyy-mm-dd" });
      encoding = "Excel";
    } else {
      let text = new TextDecoder("utf-8").decode(req.file.buffer);
      if (text.includes("\uFFFD")) {                       // 有乱码字符 -> 多半是 GBK
        try { text = new TextDecoder("gbk").decode(req.file.buffer); encoding = "GBK"; } catch (e) { }
      }
      wb = XLSX.read(text, { type: "string", cellDates: true, dateNF: "yyyy-mm-dd" });
    }
  } catch (e) {
    return res.status(400).json({ error: "文件解析失败，请确认是有效的 Excel 或 CSV" });
  }

  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return res.status(400).json({ error: "表格里没有内容" });
  // WPS 导出的表格经常把 !ref(声明的数据范围) 留得比实际数据大很多(比如曾经格式化过一大片区域后又删掉内容，
  // 范围没跟着缩回去)，最坏情况能到 100 多万行；如果照着声明的范围去读，哪怕实际只有两三行数据，
  // 也要在内存里遍历上百万个空单元格，实测能卡住服务器 20+ 秒(而且是同步阻塞，卡住的是所有人，不只是这一个请求)。
  // 这里改成先找出真正有数据的单元格，收紧成实际范围再读，不再迷信文件自己声明的 !ref。
  const usedRange = (() => {
    let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
    Object.keys(ws).forEach(addr => {
      if (addr[0] === "!") return;
      const c = XLSX.utils.decode_cell(addr);
      if (c.r < minR) minR = c.r; if (c.r > maxR) maxR = c.r;
      if (c.c < minC) minC = c.c; if (c.c > maxC) maxC = c.c;
    });
    return minR === Infinity ? null : { s: { r: minR, c: minC }, e: { r: maxR, c: maxC } };
  })();
  const rawRows = usedRange
    ? XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "", range: usedRange })
        .map(r => r.map(c => (c == null ? "" : String(c).trim())))
    : [];
  // 过滤掉空行的同时，记一下"原始行号 -> 过滤后行号"的对应关系，
  // 好让嵌入图片(按原始行号锚定)能对上过滤后、真正发给前端的那份 rows 的下标
  const rows = []; const origToFiltered = {};
  rawRows.forEach((r, origIdx) => { if (r.some(c => c !== "")) { origToFiltered[origIdx] = rows.length; rows.push(r); } });
  if (rows.length < 2) return res.status(400).json({ error: "至少需要表头和一行数据" });

  // WPS/Excel 表格里直接贴的图片(比如款式图)：尝试抠出来，按行号配对，失败也不影响文字数据导入
  const rowImages = {};
  if (ext === ".xlsx") {
    try {
      const found = extractEmbeddedImages(req.file.buffer);
      Object.keys(found).forEach(origRow => {
        const filteredIdx = origToFiltered[origRow];
        if (filteredIdx === undefined) return;
        const img = found[origRow];
        if (img.data.length > 8 * 1024 * 1024) return; // 跟 /api/upload 的单张图片大小上限保持一致
        const fname = uid() + (img.ext || ".png");
        fs.writeFileSync(path.join(UPLOAD_DIR, fname), img.data);
        rowImages[filteredIdx] = "/uploads/" + fname;
      });
    } catch (e) { /* 图片抠取失败就算了，不影响正常的表格文字导入 */ }
  }
  res.json({ rows, sheet: wb.SheetNames[0], encoding, rowImages });
});

/* ---------- 导出 Excel（管理员）：订单基本信息 + 生产进度 + 验货问题 + 跟单小结，可按季节筛选 ---------- */
router.get("/export", A.adminRequired, (req, res) => {
  const fields = getSetting("fields", { order: [], production: [] });
  const users = db.prepare("SELECT id,name FROM users").all();
  const nameOf = id => (users.find(u => u.id === id) || {}).name || id || "";
  const seasonFilter = String(req.query.season || "").trim();
  let orders = allOrdersPublic();
  if (seasonFilter) orders = orders.filter(o => o.season === seasonFilter);
  const styleOf = o => o.values.styleNo || o.values.styleName || o.id;
  const timeText = t => t ? new Date(t).toLocaleString("zh-CN") : "";

  // 导出时把真实图片嵌入表格（而不是"（有图）"文字或裸链接），这里边构建每张表的行边记录哪一行哪一列该嵌哪些图
  const imagePlacements = [];
  const trackImg = (sheetNum, rowIdx, colIdx, photos) => {
    const arr = (Array.isArray(photos) ? photos : (photos ? [photos] : [])).filter(Boolean);
    if (arr.length) imagePlacements.push({ sheet: sheetNum, row: rowIdx + 1, col: colIdx, urls: arr });
  };

  // 表一：订单基本信息（与原有逻辑一致，仍是每个字段取最新一条打卡摘要）。
  // 货号(styleNo)已经作为固定的第二列(styleOf，带款式名/id兜底)单独放了，这里排除掉，避免表头重复出现两次"货号"
  const cols = [...fields.order, ...fields.production].filter(f => f.k !== "styleNo");
  const header1 = ["季节", "货号", ...cols.map(f => f.label)];
  const imgColIdx = 2 + cols.findIndex(f => f.k === "img");
  const rows1 = orders.map((o, i) => {
    if (imgColIdx >= 2) trackImg(1, i, imgColIdx, o.values.img);
    return [o.season, styleOf(o), ...cols.map(f => {
      if (f.type === "log") {
        const arr = (o.logs[f.k] || []).slice().sort((a, b) => b.t - a.t);
        const l = arr[0];
        return l ? `${l.text}（${l.byName} ${timeText(l.t)}）` : "";
      }
      if (f.type === "image") return ""; // 款式图是真的嵌进表格里，这一格文字留空
      if (f.type === "user-sales" || f.type === "user-follower") return nameOf(o.values[f.k]);
      const v = o.values[f.k];
      return Array.isArray(v) ? v.join("、") : (v || "");
    })];
  });

  // 表二：生产进度（主厂 + 每个动态加工点 + 面料/绣印/产前样/裁剪/整烫/包装 的每一条打卡）
  const header2 = ["季节", "货号", "环节", "生产工序", "车工人数", "预计下车时间", "内容", "记录人", "时间", "照片"];
  const rows2 = [];
  const photoCol2 = header2.length - 1;
  orders.forEach(o => {
    (o.mainLog || []).forEach(e => { trackImg(2, rows2.length, photoCol2, e.photos); rows2.push([o.season, styleOf(o), "主厂", e.process || "", e.workers || "", e.estDone || "", e.text || "", e.byName, timeText(e.t), ""]); });
    (o.subs || []).forEach(s => (s.log || []).forEach(e => { trackImg(2, rows2.length, photoCol2, e.photos); rows2.push([o.season, styleOf(o), s.name, e.process || "", e.workers || "", e.estDone || "", e.text || "", e.byName, timeText(e.t), ""]); }));
    [...fields.order, ...fields.production].filter(f => f.type === "log").forEach(f =>
      (o.logs[f.k] || []).forEach(e => { trackImg(2, rows2.length, photoCol2, e.photos); rows2.push([o.season, styleOf(o), f.label, "", "", "", e.text || "", e.byName, timeText(e.t), ""]); }));
  });

  // 表三：验货问题（发现问题/整改情况/补充说明 各自独立一行方便查看）
  const header3 = ["季节", "货号", "发现问题", "发现人", "发现时间", "整改情况", "整改人", "整改时间", "补充说明", "照片"];
  const rows3 = [];
  const photoCol3 = header3.length - 1;
  orders.forEach(o => (o.inspections || []).forEach(g => (g.items || []).forEach(it => {
    trackImg(3, rows3.length, photoCol3, g.photos);
    rows3.push([
      o.season, styleOf(o), it.problem || "", it.problemByName || "", timeText(it.problemAt),
      it.fix || "（待整改）", it.fixByName || "", timeText(it.fixAt),
      (it.notes || []).map(n => `${n.byName}：${n.text}`).join("；"), ""
    ]);
  })));

  // 表四：跟单小结
  const header4 = ["季节", "货号", "记录人", "时间", "内容", "照片"];
  const rows4 = [];
  const photoCol4 = header4.length - 1;
  orders.forEach(o => (o.followIssues || []).forEach(e => {
    trackImg(4, rows4.length, photoCol4, e.photos);
    rows4.push([o.season, styleOf(o), e.byName, timeText(e.t), e.text || "", ""]);
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header1, ...rows1]), "订单基本信息");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header2, ...rows2]), "生产进度");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header3, ...rows3]), "验货问题");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header4, ...rows4]), "跟单小结");
  let buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  try { buf = embedImagesIntoXlsx(buf, imagePlacements); } catch (e) { /* 嵌图失败就退回纯文字表格，不影响导出本身 */ }
  const fname = `订单导出-${seasonFilter || "全部季节"}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send(buf);
});

module.exports = router;
