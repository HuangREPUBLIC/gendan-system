"use strict";
// 批量导入：服务端解析表格
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
const AdmZip = require("adm-zip");
const { uid, UPLOAD_DIR } = require("../db");
const { PHOTO_EXT, relsXml } = require("./helpers");

const router = express.Router();

// 从 xlsx 抠出嵌入图片，按锚定行号(0-based，含表头)配对；只看第一个工作表，失败返回空
function extractEmbeddedImages(buf) {
  const images = {};
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

/* ---------- 导入：解析 Excel / CSV ----------
 * CSV 先按 UTF-8 解，出现乱码再按 GBK(Windows Excel 另存 CSV 默认 GBK) */
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
      if (text.includes("\uFFFD")) {
        try { text = new TextDecoder("gbk").decode(req.file.buffer); encoding = "GBK"; } catch (e) { }
      }
      wb = XLSX.read(text, { type: "string", cellDates: true, dateNF: "yyyy-mm-dd" });
    }
  } catch (e) {
    return res.status(400).json({ error: "文件解析失败，请确认是有效的 Excel 或 CSV" });
  }

  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return res.status(400).json({ error: "表格里没有内容" });
  // WPS 表格声明的 !ref 常远大于实际数据(可达上百万行)，按实际有值的单元格收紧范围，免得同步阻塞整个服务
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
  // 过滤空行，并记下原始行号 -> 过滤后下标，给嵌入图片配对
  const rows = []; const origToFiltered = {};
  rawRows.forEach((r, origIdx) => { if (r.some(c => c !== "")) { origToFiltered[origIdx] = rows.length; rows.push(r); } });
  if (rows.length < 2) return res.status(400).json({ error: "至少需要表头和一行数据" });

  // 表格里贴的款式图：抠出来按行配对，失败不影响文字导入
  const rowImages = {};
  if (ext === ".xlsx") {
    try {
      const found = extractEmbeddedImages(req.file.buffer);
      Object.keys(found).forEach(origRow => {
        const filteredIdx = origToFiltered[origRow];
        if (filteredIdx === undefined) return;
        const img = found[origRow];
        if (img.data.length > 8 * 1024 * 1024) return;
        // 扩展名来自表格内部路径，同样只认白名单
        const fname = uid() + ([...Object.values(PHOTO_EXT), ".jpeg"].includes(img.ext) ? img.ext : ".png");
        fs.writeFileSync(path.join(UPLOAD_DIR, fname), img.data);
        rowImages[filteredIdx] = "/uploads/" + fname;
      });
    } catch (e) { /* 图片抠取失败就算了，不影响正常的表格文字导入 */ }
  }
  res.json({ rows, sheet: wb.SheetNames[0], encoding, rowImages });
});

module.exports = router;
