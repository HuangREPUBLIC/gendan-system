"use strict";
// 导出订单：生成 xlsx；下载链接不需要登录，靠一次性票据
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const zlib = require("zlib");
const { promisify } = require("util");
const { pipeline } = require("stream/promises");
const XLSX = require("xlsx");
const AdmZip = require("adm-zip");
const { db, UPLOAD_DIR } = require("../db");
const A = require("../auth");
const { allFields, activeUser, allOrdersPublic, USER_FIELD_TYPES, XML_HEAD, NS_REL, relsXml } = require("./helpers");

const router = express.Router();
const pub = express.Router();  // 不需要登录的路由

const deflateRaw = promisify(zlib.deflateRaw);

// 导出的一次性下载链接：浏览器直接打开带不了登录头，凭票据放行(见 /export/ticket)
pub.get("/export/file", (req, res, next) => {
  const tk = takeExportTicket(req.query.t);
  const u = tk && activeUser(tk.userId);
  if (!u || u.role !== "admin") {
    return res.status(410).type("text/plain; charset=utf-8").send("下载链接已失效，请回到系统里重新点「导出」");
  }
  sendExport(u, tk.season, res, next);
});

const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

const THUMB_EMU = 60 * 9525, THUMB_STEP_EMU = 64 * 9525;  // 缩略图 60px，同格多图纵向排、间隔 4px
// 主题/样式取 SheetJS 默认的两份，启动时生成一次
const XLSX_THEME_STYLES = (() => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[""]]), "S");
  const zip = new AdmZip(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  return [["xl/theme/theme1.xml", zip.readFile("xl/theme/theme1.xml")], ["xl/styles.xml", zip.readFile("xl/styles.xml")]];
})();
const XML_ENT = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
// XML 转义规则同 SheetJS：特殊字符转实体，非法控制字符写成 _xHHHH_
const xmlEsc = s => String(s).replace(/[&<>"']/g, c => XML_ENT[c])
  .replace(/[\u0000-\u0008\u000b-\u001f\ufffe\uffff]/g, c => "_x" + c.charCodeAt(0).toString(16).padStart(4, "0") + "_");
const colName = i => (i >= 26 ? colName(Math.floor(i / 26) - 1) : "") + String.fromCharCode(65 + i % 26);
const photoList = p => (Array.isArray(p) ? p : [p]).filter(Boolean);
// 可嵌入的图片类型；其它扩展名按 jpg 处理
const IMAGE_TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", bmp: "image/bmp",
  tif: "image/tiff", tiff: "image/tiff", webp: "image/webp", emf: "image/x-emf", wmf: "image/x-wmf" };

// 内容带换行或首尾空白时加 xml:space="preserve"，否则 Excel 会吞掉
const keepSpace = x => /(^\s|\s$|\n)/.test(x) ? ` xml:space="preserve"` : "";
function cellXml(v, ref) {
  if (v == null) return "";
  if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
  if (typeof v === "boolean") return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
  const x = xmlEsc(v), inner = `<v${keepSpace(x)}>${x}</v>`;
  return `<c r="${ref}" t="str"${keepSpace(inner)}>${inner}</c>`;
}

// 一张表 -> zip 里的文件：sheet XML，有照片时加 drawing 和两份 rels
function sheetFiles(n, sheet, media) {
  const photoCol = sheet.photoCol ?? sheet.header.length - 1;
  const anchors = [];
  const rows = [{ cells: sheet.header }, ...sheet.rows].map((row, r) => {
    const pics = photoList(row.photos).map(u => media.get(String(u))).filter(Boolean);
    pics.forEach((m, i) => anchors.push({ row: r, off: i * THUMB_STEP_EMU, m }));
    const ht = pics.length ? ` ht="${Math.max(20, pics.length * 64 * 0.75 + 3).toFixed(2)}" customHeight="1"` : "";
    const cells = row.cells.map((v, c) => cellXml(v, colName(c) + (r + 1))).join("");
    return `<row r="${r + 1}"${keepSpace(cells)}${ht}>${cells}</row>`;
  });
  const ref = `A1:${colName(sheet.header.length - 1)}${rows.length}`;
  const sheetXml = XML_HEAD + `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><dimension ref="${ref}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>` +
    (anchors.length ? `<cols><col min="${photoCol + 1}" max="${photoCol + 1}" width="11" customWidth="1"/></cols>` : "") +
    `<sheetData>${rows.join("")}</sheetData><ignoredErrors><ignoredError numberStoredAsText="1" sqref="${ref}"/></ignoredErrors>` +
    (anchors.length ? `<drawing r:id="rId1"/>` : "") + `</worksheet>`;
  if (!anchors.length) return [[`xl/worksheets/sheet${n}.xml`, sheetXml]];

  const drawingXml = XML_HEAD + `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS_REL}">` +
    anchors.map((a, i) => `<xdr:oneCellAnchor>` +
      `<xdr:from><xdr:col>${photoCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.row}</xdr:row><xdr:rowOff>${a.off}</xdr:rowOff></xdr:from>` +
      `<xdr:ext cx="${THUMB_EMU}" cy="${THUMB_EMU}"/><xdr:pic>` +
      `<xdr:nvPicPr><xdr:cNvPr id="${i + 1}" name="img${i + 1}"/><xdr:cNvPicPr/></xdr:nvPicPr>` +
      `<xdr:blipFill><a:blip r:embed="rId${i + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
      `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${THUMB_EMU}" cy="${THUMB_EMU}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>` +
      `</xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`).join("") + `</xdr:wsDr>`;
  return [
    [`xl/worksheets/sheet${n}.xml`, sheetXml],
    [`xl/worksheets/_rels/sheet${n}.xml.rels`, relsXml([["rId1", "drawing", `../drawings/drawing${n}.xml`]])],
    [`xl/drawings/drawing${n}.xml`, drawingXml],
    [`xl/drawings/_rels/drawing${n}.xml.rels`, relsXml(anchors.map((a, i) => [`rId${i + 1}`, "image", `../media/${a.m.name}`]))]
  ];
}

/* 极简 zip 流式打包。files: [文件名, 内容(字符串/Buffer/返回 Promise<Buffer> 的函数), 是否原样存]
 * 照片原样存(STORED)，XML 用 DEFLATE */
async function* zipChunks(files) {
  const central = [];
  let offset = 0;
  for (const [name, content, stored] of files) {
    const raw = typeof content === "function" ? await content() : Buffer.from(content);
    const data = stored ? raw : await deflateRaw(raw);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);  // 0x800：文件名 UTF-8
    local.writeUInt16LE(stored ? 0 : 8, 8); local.writeUInt16LE(0x21, 12);  // 日期 1980-01-01
    local.writeUInt32LE(zlib.crc32(raw), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    // 中央目录项 = 本地头字段 + 本地头偏移
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); local.copy(entry, 6, 4, 30); entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    yield Buffer.concat([local, nameBuf]);
    yield data;
    offset += local.length + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  yield dir;
  yield end;
}

const exportingUsers = new Set();  // 同一人同时只跑一份导出
router.get("/export", A.adminRequired, (req, res, next) => sendExport(req.user, req.query.season, res, next));

// 一次性下载链接：5 分钟有效、只能用一次，交给浏览器自带下载管理器下载；链接不含登录凭证
const exportTickets = new Map();
const EXPORT_TICKET_TTL = 5 * 60 * 1000;
router.post("/export/ticket", A.adminRequired, (req, res) => {
  if (exportingUsers.has(req.user.id)) return res.status(429).json({ error: "上一份导出还没完成，请稍候" });
  const now = Date.now();
  for (const [k, t] of exportTickets) if (t.exp < now) exportTickets.delete(k);
  const season = String((req.body || {}).season || "").trim();
  const count = season ? db.prepare("SELECT COUNT(*) c FROM orders WHERE season = ?").get(season).c
    : db.prepare("SELECT COUNT(*) c FROM orders").get().c;
  const ticket = crypto.randomBytes(24).toString("hex");
  exportTickets.set(ticket, { userId: req.user.id, season, exp: now + EXPORT_TICKET_TTL });
  res.json({ url: "/api/export/file?t=" + ticket, filename: exportFileName(season), count });
});
function takeExportTicket(t) {
  const tk = exportTickets.get(String(t || ""));
  if (!tk) return null;
  exportTickets.delete(String(t));
  return tk.exp >= Date.now() ? tk : null;
}
const today = () => new Date().toISOString().slice(0, 10);
const exportFileName = season => `订单导出-${season || "全部季节"}-${today()}.xlsx`;

async function sendExport(user, season, res, next) {
  if (exportingUsers.has(user.id)) return res.status(429).json({ error: "上一份导出还没完成，请稍候" });
  exportingUsers.add(user.id);
  res.on("close", () => exportingUsers.delete(user.id));
  res.setTimeout(120000, () => res.destroy());  // 连接僵死 2 分钟后断开
  try {
    const fieldList = allFields();
    const userNames = new Map(db.prepare("SELECT id,name FROM users").all().map(u => [u.id, u.name]));
    const nameOf = id => userNames.get(id) || id || "";
    const seasonFilter = String(season || "").trim();
    const orders = allOrdersPublic().filter(o => !seasonFilter || o.season === seasonFilter);
    const styleOf = o => o.values.styleNo || o.values.styleName || o.id;
    const timeText = t => t ? new Date(t).toLocaleString("zh-CN") : "";

    // 表一：订单基本信息，打卡字段取最新一条；货号固定在第二列
    const cols = fieldList.filter(f => f.k !== "styleNo");
    const imgCol = cols.findIndex(f => f.k === "img");
    const sheet1 = { name: "订单基本信息", header: ["季节", "货号", ...cols.map(f => f.label)], photoCol: 2 + imgCol,
      rows: orders.map(o => ({ photos: imgCol >= 0 ? o.values.img : null, cells: [o.season, styleOf(o), ...cols.map(f => {
        if (f.type === "log") {
          const l = (o.logs[f.k] || []).slice().sort((a, b) => b.t - a.t)[0];
          return l ? `${l.text}（${l.byName} ${timeText(l.t)}）` : "";
        }
        if (f.type === "image") return "";  // 款式图嵌在表格里，文字留空
        if (USER_FIELD_TYPES.includes(f.type)) return nameOf(o.values[f.k]);
        const v = o.values[f.k];
        return Array.isArray(v) ? v.join("、") : (v || "");
      })] })) };

    // 表二：生产进度，每条打卡一行
    const sheet2 = { name: "生产进度", header: ["季节", "货号", "环节", "生产工序", "车工人数", "预计下车时间", "内容", "记录人", "时间", "照片"], rows: [] };
    orders.forEach(o => {
      const add = (stage, e, p) => sheet2.rows.push({ photos: e.photos,
        cells: [o.season, styleOf(o), stage, p.process || "", p.workers || "", p.estDone || "", e.text || "", e.byName, timeText(e.t), ""] });
      (o.mainLog || []).forEach(e => add("主厂", e, e));
      (o.subs || []).forEach(s => (s.log || []).forEach(e => add(s.name, e, e)));
      fieldList.filter(f => f.type === "log").forEach(f => (o.logs[f.k] || []).forEach(e => add(f.label, e, {})));
    });

    // 表三：验货问题
    const sheet3 = { name: "验货问题", header: ["季节", "货号", "发现问题", "发现人", "发现时间", "整改情况", "整改人", "整改时间", "补充说明", "照片"],
      rows: orders.flatMap(o => (o.inspections || []).flatMap(g => (g.items || []).map(it => ({ photos: g.photos, cells: [
        o.season, styleOf(o), it.problem || "", it.problemByName || "", timeText(it.problemAt),
        it.fix || "（待整改）", it.fixByName || "", timeText(it.fixAt),
        (it.notes || []).map(n => `${n.byName}：${n.text}`).join("；"), ""] })))) };

    // 表四：跟单小结
    const sheet4 = { name: "跟单小结", header: ["季节", "货号", "记录人", "时间", "内容", "照片"],
      rows: orders.flatMap(o => (o.followIssues || []).map(e => ({ photos: e.photos, cells: [o.season, styleOf(o), e.byName, timeText(e.t), e.text || "", ""] }))) };
    const sheets = [sheet1, sheet2, sheet3, sheet4];

    // 只嵌存在的照片；同一张图只存一份
    const urls = [...new Set(sheets.flatMap(s => s.rows.flatMap(r => photoList(r.photos).map(String))))];
    const found = await Promise.all(urls.map(async u => {
      const rel = u.replace(/^\/+/, "");
      if (!rel.startsWith("uploads/")) return null;
      const file = path.join(UPLOAD_DIR, path.basename(rel));
      return (await fs.promises.stat(file).catch(() => null))?.isFile() ? file : null;
    }));
    const media = new Map();
    urls.forEach((u, i) => {
      const ext = path.extname(found[i] || "").slice(1).toLowerCase();
      if (found[i]) media.set(u, { file: found[i], name: `image${media.size + 1}.${IMAGE_TYPES[ext] ? ext : "jpg"}` });
    });
    const imageExts = [...new Set([...media.values()].map(m => m.name.split(".").pop()))];

    const parts = sheets.map((s, i) => sheetFiles(i + 1, s, media));
    const CT = "application/vnd.openxmlformats-officedocument.";
    const files = [
      ["[Content_Types].xml", XML_HEAD + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        imageExts.map(e => `<Default Extension="${e}" ContentType="${IMAGE_TYPES[e]}"/>`).join("") +
        `<Override PartName="/xl/workbook.xml" ContentType="${CT}spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="${CT}spreadsheetml.styles+xml"/>` +
        `<Override PartName="/xl/theme/theme1.xml" ContentType="${CT}theme+xml"/>` +
        parts.map((p, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${CT}spreadsheetml.worksheet+xml"/>` +
          (p.length > 1 ? `<Override PartName="/xl/drawings/drawing${i + 1}.xml" ContentType="${CT}drawing+xml"/>` : "")).join("") +
        `</Types>`],
      ["_rels/.rels", relsXml([["rId1", "officeDocument", "xl/workbook.xml"]])],
      ["xl/workbook.xml", XML_HEAD + `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>` +
        sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") + `</sheets></workbook>`],
      ["xl/_rels/workbook.xml.rels", relsXml([...sheets.map((s, i) => [`rId${i + 1}`, "worksheet", `worksheets/sheet${i + 1}.xml`]),
        ["rId5", "theme", "theme/theme1.xml"], ["rId6", "styles", "styles.xml"]])],
      ...XLSX_THEME_STYLES,
      ...parts.flat(),
      // 导出途中照片被删时放空图占位，不中断下载
      ...[...media.values()].map(m => [`xl/media/${m.name}`, () => fs.promises.readFile(m.file).catch(() => Buffer.alloc(0)), true])
    ];

    const fname = exportFileName(seasonFilter);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    // filename 是给老浏览器的英文名，新浏览器用 filename* 的中文名
    const asciiName = `orders-${seasonFilter.replace(/[^\w.-]/g, "") || "all"}-${today()}.xlsx`;
    res.setHeader("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    await pipeline(zipChunks(files), res);
  } catch (e) {
    if (!res.headersSent) next(e);  // 已开始发送后出错(多半是浏览器断开)，pipeline 会自行关闭连接
  }
}

module.exports = { pub, router };
