"use strict";
// 批量导入：读取 Excel 里的文字和图片，转成待确认订单

// 导入的各种日期写法统一成 2026-08-15；认不出返回 null
function normalizeImportDate(s) {
  s = String(s || "").trim();
  if (!s) return "";
  const iso = (y, m, d) => {
    y = +y; m = +m; d = +d; if (y < 100) y += 2000;
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
      ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
  };
  let m;
  if ((m = s.match(/^(\d{4})[\/\-年.](\d{1,2})[\/\-月.](\d{1,2})日?(\s|T|$)/))) return iso(m[1], m[2], m[3]);  // 2026-8-15、2026/8/15、2026年8月15日、2026.8.15
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return iso(m[1], m[2], m[3]);
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/))) return iso(m[3], m[1], m[2]);  // Excel 英文格式 8/15/26
  if ((m = s.match(/^(\d{1,2})月(\d{1,2})日?$/))) return iso(new Date().getFullYear(), m[1], m[2]);  // 按今年
  if (/^\d{5}$/.test(s) && +s > 30000 && +s < 80000) {  // Excel 日期序号
    const dt = new Date(Date.UTC(1899, 11, 30) + (+s) * 86400000);
    return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  return null;
}
// 表头比对前清洗：去空格/星号/冒号和末尾括号备注，不分大小写
function normHeader(h) {
  return String(h == null ? "" : h).replace(/^\uFEFF/, "").replace(/[\s*＊:：]/g, "").replace(/[（(][^（()）]*[）)]$/, "").toLowerCase();
}

async function ensureXlsx(msg) {
  if (!window.XLSX) { toast(msg, true); await loadScriptOnce("/xlsx.mini.min.js"); }
}
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src; s.onload = () => resolve(); s.onerror = () => reject(new Error("组件加载失败"));
    document.head.appendChild(s);
  });
}
// 浏览器本地读 zip 里的指定文件，只支持 STORED/DEFLATE，不支持的跳过
async function zipReadEntries(buf, wantNames) {
  const dv = new DataView(buf), bytes = new Uint8Array(buf);
  let eocd = -1;
  const back = Math.min(bytes.length, 65557);  // EOCD 22 字节 + 最长 65535 字节注释
  for (let i = bytes.length - 22; i >= bytes.length - back && i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 zip/xlsx 文件");
  const cdOffset = dv.getUint32(eocd + 16, true);
  const cdEntryCount = dv.getUint16(eocd + 10, true);
  const wantSet = new Set(wantNames);
  const found = {};
  let p = cdOffset;
  for (let i = 0; i < cdEntryCount && Object.keys(found).length < wantSet.size; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = new TextDecoder("utf-8").decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (wantSet.has(name)) found[name] = { method, compressedSize, localOffset };
    p += 46 + nameLen + extraLen + commentLen;
  }
  const result = {};
  for (const name of Object.keys(found)) {
    const { method, compressedSize, localOffset } = found[name];
    const lNameLen = dv.getUint16(localOffset + 26, true);
    const lExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) { result[name] = compressed; continue; }
    if (method === 8) {
      if (!window.DecompressionStream) continue;
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      result[name] = new Uint8Array(await new Response(stream).arrayBuffer());
      continue;
    }
  }
  return result;
}
// 从 xlsx 抠出贴在表格里的图片，按锚定行号配对(同服务端 extractEmbeddedImages)，失败返回已抠到的
async function extractEmbeddedImagesClient(buf) {
  const images = {};
  try {
    const step1 = await zipReadEntries(buf, ["xl/worksheets/_rels/sheet1.xml.rels"]);
    const relsBytes = step1["xl/worksheets/_rels/sheet1.xml.rels"];
    if (!relsBytes) return images;
    const drawingRefM = new TextDecoder("utf-8").decode(relsBytes).match(/Target="[^"]*?(drawing\d*\.xml)"/);
    if (!drawingRefM) return images;
    const drawingName = drawingRefM[1];
    const step2 = await zipReadEntries(buf, ["xl/drawings/" + drawingName, "xl/drawings/_rels/" + drawingName + ".rels"]);
    const drawingBytes = step2["xl/drawings/" + drawingName];
    if (!drawingBytes) return images;
    const drawingXml = new TextDecoder("utf-8").decode(drawingBytes);
    const rIdToMedia = {};
    const drawingRelsBytes = step2["xl/drawings/_rels/" + drawingName + ".rels"];
    if (drawingRelsBytes) {
      const relsText = new TextDecoder("utf-8").decode(drawingRelsBytes);
      const re = /<Relationship[^>]*Id="(rId\d+)"[^>]*Target="[^"]*?(media\/[^"]+)"/g;
      let m; while ((m = re.exec(relsText))) rIdToMedia[m[1]] = "xl/" + m[2];
    }
    const anchorRe = /<xdr:(?:twoCellAnchor|oneCellAnchor)[\s\S]*?<\/xdr:(?:twoCellAnchor|oneCellAnchor)>/g;
    const rowToMedia = {};
    let am;
    while ((am = anchorRe.exec(drawingXml))) {
      const block = am[0];
      const rowM = block.match(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/);
      const embedM = block.match(/r:embed="(rId\d+)"/);
      if (!rowM || !embedM) continue;
      const mediaPath = rIdToMedia[embedM[1]];
      if (mediaPath) rowToMedia[parseInt(rowM[1], 10)] = mediaPath;
    }
    const mediaNames = [...new Set(Object.values(rowToMedia))];
    if (!mediaNames.length) return images;
    const step3 = await zipReadEntries(buf, mediaNames);
    Object.keys(rowToMedia).forEach(row => {
      const data = step3[rowToMedia[row]];
      if (!data) return;
      images[row] = { data, ext: (rowToMedia[row].split(".").pop() || "png").toLowerCase() };
    });
  } catch (e) { /* 抠图失败就返回已抠到的部分(可能是空)，不影响正常的表格文字导入 */ }
  return images;
}

Object.assign(A, {
  // 模板表头用当前字段名；第二张表写说明、示例和现有季节/员工
  async downloadImportTemplate() {
    if (inAppBrowser()) return toast("微信等 App 里无法下载文件，请用浏览器打开本系统后再下载模板");
    try {
      await ensureXlsx("正在生成模板…");
      const cols = importScalars();
      const head = ["季节", ...cols.map(f => f.label)];
      const names = tpl => state.users.filter(u => u.template === tpl).map(u => u.name);
      const later = new Date(Date.now() + 30 * 86400000), pad = x => String(x).padStart(2, "0");
      const sampleOf = f => f.k === "styleNo" ? "SS27-T001" : f.k === "styleName" ? "女装印花短袖T恤" : f.k === "qty" ? "1200"
        : f.type === "date" ? (f.k === "shipDate" ? "" : `${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())}`)
        : f.type === "user-sales" ? (names("sales")[0] || "") : f.type === "user-follower" ? (names("follower")[0] || "")
        : isMultiFactory(f) ? "工厂A、工厂B" : "";
      const help = [
        ["填写说明"],
        ["1. 在「订单」表里从第二行开始，一行一单；列的顺序可以随便调，用不到的列可以删掉。"],
        ["2. 货号和款式名至少填一个，其余都可以空着，导入后再补。"],
        ["3. 日期写成 2026-08-15 或 2026/8/15。发货日期一旦填写就会锁定，没发货前请留空。"],
        ["4. 业务员、下厂员填员工姓名，要跟下面名单里的字完全一样。"],
        ["5. 面料/绣花等可以有多个工厂的，用顿号「、」隔开。"],
        ["6. 款式图可以直接贴(插入图片)到对应那一行里，导入时会自动带上。"],
        [], ["示例："], head, [state.seasons[0] || "SS2027", ...cols.map(sampleOf)],
        [], ["现有季节", ...state.seasons], ["业务员", ...names("sales")], ["下厂员", ...names("follower")]
      ];
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([head]);
      ws["!cols"] = head.map(h => ({ wch: Math.max(10, String(h).length * 2 + 4) }));
      XLSX.utils.book_append_sheet(wb, ws, "订单");
      const hs = XLSX.utils.aoa_to_sheet(help); hs["!cols"] = [{ wch: 14 }, ...head.slice(1).map(() => ({ wch: 14 }))];
      XLSX.utils.book_append_sheet(wb, hs, "填写说明");
      XLSX.writeFile(wb, "订单导入模板.xlsx");
      toast("模板已开始下载");
    } catch (e) { toast("模板生成失败，请稍后再试"); }
  },
  // 本地解析文字，并抠出表格图片压缩后上传
  async importFileClientSide(f) {
    toast("正在本地解析文件…", true);
    const buf = await f.arrayBuffer();
    // type:"array" 必须传 Uint8Array
    const wb = XLSX.read(new Uint8Array(buf), { type: "array", cellDates: true, dateNF: "yyyy-mm-dd" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error("表格里没有内容");
    // WPS 声明的范围常比实际大，按实际数据收紧
    let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
    Object.keys(ws).forEach(addr => {
      if (addr[0] === "!") return;
      const c = XLSX.utils.decode_cell(addr);
      if (c.r < minR) minR = c.r; if (c.r > maxR) maxR = c.r;
      if (c.c < minC) minC = c.c; if (c.c > maxC) maxC = c.c;
    });
    const rawRows = minR === Infinity ? [] :
      XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "", range: { s: { r: minR, c: minC }, e: { r: maxR, c: maxC } } })
        .map(r => r.map(c => (c == null ? "" : String(c).trim())));
    const rows = []; const origToFiltered = {};
    rawRows.forEach((r, origIdx) => { if (r.some(c => c !== "")) { origToFiltered[origIdx] = rows.length; rows.push(r); } });
    if (rows.length < 2) throw new Error("至少需要表头和一行数据");

    toast("正在识别表格里的图片…", true);
    const found = await extractEmbeddedImagesClient(buf);
    const rowImages = {};
    // 图片并发 3 张上传
    const entries = Object.keys(found)
      .map(origRow => ({ filteredIdx: origToFiltered[origRow], img: found[origRow] }))
      .filter(e => e.filteredIdx !== undefined && e.img.data.length <= 8 * 1024 * 1024);
    if (entries.length) {
      let done = 0;
      toast(`正在上传图片…（0/${entries.length}）`, true);
      let next = 0;
      const worker = async () => {
        while (next < entries.length) {
          const { filteredIdx, img } = entries[next++];
          try {
            const mime = img.ext === "png" ? "image/png" : img.ext === "gif" ? "image/gif" : "image/jpeg";
            const url = await uploadOnePhoto(new Blob([img.data], { type: mime }));
            if (url) rowImages[filteredIdx] = url;
          } catch (e) { /* 单张图片传失败就跳过，不影响其它行的数据 */ }
          done++;
          toast(`正在上传图片…（${done}/${entries.length}）`, true);
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, entries.length) }, worker));
    }
    importRaw = "";
    toast("解析完成");
    A.showPreview(A.rowsToPreview(rows, rowImages), Object.keys(rowImages).length ? "，已自动识别表格里的款式图" : "");
  },
  // 本地解析失败时交给服务器
  async importFileServerFallback(f) {
    try {
      const fd = new FormData(); fd.append("file", f);
      const j = await xhrUpload("/api/import/parse", fd, { timeout: 180000, onProgress: p =>
        toast(p == null ? "正在上传文件，请稍候…" : p < 1 ? `正在上传文件… ${Math.round(p * 100)}%` : "上传完成，正在解析…", true) });
      importRaw = "";
      const gotImages = j.rowImages && Object.keys(j.rowImages).length;
      toast("解析完成");
      A.showPreview(A.rowsToPreview(j.rows, j.rowImages), (j.encoding === "GBK" ? "（已按 GBK 编码读取）" : "") + (gotImages ? "，已自动识别表格里的款式图" : ""));
    } catch (e) { toast((e && e.error) || "文件解析失败"); }
  },
  // 表头 -> 字段：认系统字段名和常见别名/旧表头
  importMap() {
    const m = {}, known = new Set(importScalars().map(f => f.k));
    importScalars().forEach(f => { m[normHeader(f.label)] = f.k; });
    const alias = {
      "货号": "styleNo", "款号": "styleNo", "款式编号": "styleNo", "款式名": "styleName", "款名": "styleName", "品名": "styleName",
      "款式": "style", "数量": "qty", "件数": "qty", "订单数量": "qty", "下单数量": "qty", "款式描述": "desc", "描述": "desc",
      "订单交期": "deadline", "交期": "deadline", "交货期": "deadline", "交货日期": "deadline", "货期": "deadline",
      "发货日期": "shipDate", "出货日期": "shipDate", "业务员": "sales", "业务": "sales", "下厂员": "follower", "跟单员": "follower",
      "季节": "_season", "订单季节": "_season", "季度": "_season",
      "服装工厂": "factory", "生产厂": "factory", "加工厂": "factory",  // 旧表头
      "面料工厂1": "fabricFactory1", "面料工厂2": "fabricFactory2", "面料工厂": "fabricFactory1", "面料厂": "fabricFactory1",
      "绣花工厂": "embFactory", "绣花厂": "embFactory", "印花工厂": "printFactory", "印花厂": "printFactory", "绣印工厂": "embFactory"
    };
    Object.keys(alias).forEach(h => {
      const k = normHeader(h);
      if (!m[k] && (alias[h] === "_season" || known.has(alias[h]))) m[k] = alias[h];
    });
    return m;
  },
  // 二维数组(首行表头) -> 待确认订单，warn 为需要用户确认的问题
  rowsToPreview(grid, rowImages) {
    const MAP = A.importMap();
    // 表头行：前 10 行里第一行含已知列名的
    let hi = 0;
    for (let i = 0; i < Math.min(grid.length, 10); i++) {
      if ((grid[i] || []).some(c => MAP[normHeader(c)])) { hi = i; break; }
    }
    const rawHeads = (grid[hi] || []).map(h => String(h == null ? "" : h).trim().replace(/^\uFEFF/, ""));
    const keys = rawHeads.map(h => MAP[normHeader(h)] || null);
    importUnknownCols = rawHeads.filter((h, j) => h && !keys[j]);
    const fieldOf = {}; importScalars().forEach(f => { fieldOf[f.k] = f; });
    const out = [];
    for (let i = hi + 1; i < grid.length; i++) {
      const cells = grid[i] || [];
      if (!cells.some(c => String(c == null ? "" : c).trim())) continue;
      const values = {}, warn = []; let season = "";
      keys.forEach((key, j) => {
        const v = String(cells[j] == null ? "" : cells[j]).trim();
        if (!v || !key) return;
        if (key === "_season") {
          season = v;
          if (!(state.seasons || []).includes(v)) warn.push(`季节「${v}」不在后台的季节列表里`);
          return;
        }
        const f = fieldOf[key];
        if (key === "sales" || key === "follower") {
          const u = state.users.find(x => x.name === v && x.template === key) || state.users.find(x => x.name === v);
          if (u) values[key] = u.id;
          else warn.push(`${f ? f.label : key}「${v}」不在员工名单里，请在下面手动选择`);
          return;
        }
        if (f && f.type === "date") {
          const d = normalizeImportDate(v);
          if (d) values[key] = d; else warn.push(`${f.label}「${v}」不是能识别的日期，请在下面手动选择`);
        } else if (f && isMultiFactory(f)) values[key] = v.split(/[,，、\/;；]/).map(x => x.trim()).filter(Boolean);
        else values[key] = v;
      });
      if (!values.styleNo && !values.styleName) continue;
      if (values.qty && !/^\d+(\.\d+)?$/.test(String(values.qty).replace(/[,，\s]/g, ""))) warn.push(`数量「${values.qty}」不是纯数字，合计数量时不会算进去`);
      if (!season) warn.push("没有填季节，请在下面选择（不选会归到「未分季」）");
      if (me().template === "sales" && !values.sales) values.sales = me().id;
      if (rowImages && rowImages[i]) values.img = [rowImages[i]];  // 表格里嵌的款式图
      out.push({ season, values, warn });
    }
    // 重复检查：表格内重复，或系统里已有同货号(季节都有时要相同)；只能比对自己看得到的订单
    const keyOf = r => String(r.values.styleNo || "").trim().toUpperCase();
    const cnt = {}; out.forEach(r => { const k = keyOf(r); if (k) cnt[k] = (cnt[k] || 0) + 1; });
    out.forEach(r => {
      const k = keyOf(r); if (!k) return;
      if (cnt[k] > 1) r.warn.push(`货号 ${r.values.styleNo} 在表格里出现了 ${cnt[k]} 次`);
      const ex = state.orders.find(o => String(o.values.styleNo || "").trim().toUpperCase() === k && (!r.season || !o.season || o.season === r.season));
      if (ex) r.warn.push(`系统里已经有货号 ${r.values.styleNo} 的订单${ex.season ? `（${ex.season}）` : ""}，可能是重复导入`);
    });
    return out;
  },
});
