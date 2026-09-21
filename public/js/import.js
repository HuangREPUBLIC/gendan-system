"use strict";
// 批量导入：预览、修改、确认

let importUnknownCols = [];  // 没认出的列，预览时提示

const clearImportPhotoDrafts = () => Object.keys(photoDraft).forEach(k => { if (/^imp\d+-img$/.test(k)) delete photoDraft[k]; });

const importScalars = () => [...scalarFields("order").filter(f => f.type !== "image"), ...scalarFields("production")];
function importPreviewHtml() {
  const orderScalars = scalarFields("order").filter(f => f.type !== "image"), prodScalars = scalarFields("production");
  const n = importPreview.length, warnRows = importPreview.filter(r => r.warn && r.warn.length).length;
  // 少于 4 单全部展开，否则只展开有问题的
  const openAll = n <= 3;
  return `<div class="imp-summary${warnRows ? " warn" : ""}">
      <div class="imp-sum-main">识别到 <b class="num">${n}</b> 单，尚未保存${warnRows ? `，其中 <b class="num">${warnRows}</b> 单需要确认` : "，没发现问题"}</div>
      <div class="imp-sum-sub">可以直接修改下面任意字段，确认无误后点底部「确认导入」。</div>
      ${importUnknownCols.length ? `<div class="imp-sum-sub">这些列没认出来，不会导入：${importUnknownCols.map(esc).join("、")}</div>` : ""}
    </div>
    ${importPreview.map((r, i) => {
      const w = r.warn || [];
      return `<details class="imp-block${w.length ? " has-warn" : ""}"${openAll || w.length ? " open" : ""}>
      <summary class="imp-head"><span class="imp-no num">${i + 1}</span>
        <span class="imp-title">${esc(r.values.styleNo || "")} ${esc(r.values.styleName || "")}</span>
        ${w.length ? `<span class="tag warn">${w.length} 处待确认</span>` : ""}
        ${n > 1 ? `<button type="button" class="act-btn danger" onclick="event.preventDefault();A.removeImportRow(${i})">移除</button>` : ""}</summary>
      ${w.length ? `<ul class="imp-warns">${w.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      <label class="field"><span>订单季节</span>${seasonSelectHtml(r.season, "imp" + i + "-")}</label>
      <label class="field"><span>款式图</span>${photoPicker("imp" + i + "-img")}</label>
      <div class="grid2">${orderScalars.map(f => fieldRow(f, r.values[f.k] || "", "imp" + i + "-")).join("")}</div>
      <div class="grid2">${prodScalars.map(f => fieldRow(f, r.values[f.k] || "", "imp" + i + "-")).join("")}</div>
    </details>`;
    }).join("")}
    <div class="btn-row imp-actions">
      <button class="btn" onclick="A.confirmImport()">确认导入 ${n} 单</button>
      <button class="btn ghost" onclick="A.cancelImport()">取消</button></div>`;
}

Object.assign(A, {
  async importFile(input) {
    const f = input.files && input.files[0]; input.value = "";  // 清空后同一文件可再次选择
    if (f) await A.importFileObj(f);
  },
  async importFileObj(f) {
    if (A.importFileObj.busy) return toast("正在识别上一个文件，请稍候");
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    if (!["xlsx", "xls", "csv", "txt"].includes(ext)) return toast("只支持 Excel(.xlsx/.xls) 或 CSV(.csv/.txt) 文件");
    A.syncFileName("imp-file", f.name);
    A.importFileObj.busy = true;
    const btn = document.querySelector(".imp-drop-btn"); if (btn) btn.disabled = true;
    try {
      // xlsx 在本地解析，不用上传整份文件
      if (ext === "xlsx") {
        try {
          await ensureXlsx("正在准备中，请稍候…");
          await A.importFileClientSide(f);
          return;
        } catch (e) { console.error("本地解析失败，退回服务器解析：", e); }
      }
      await A.importFileServerFallback(f);
    } finally { A.importFileObj.busy = false; const b2 = document.querySelector(".imp-drop-btn"); if (b2) b2.disabled = false; }
  },

  showPreview(rows, extra) {
    if (!rows.length) return toast("未识别到有效数据，请检查表头列名");
    importPreview = rows; A.resyncImportPhotoDrafts(); render();
    const w = rows.filter(r => r.warn && r.warn.length).length;
    toast(`识别到 ${rows.length} 单${extra || ""}${w ? `，其中 ${w} 单需要确认` : ""}，请在下方核对后导入`);
    const first = document.querySelector(".imp-summary"); if (first && first.scrollIntoView) first.scrollIntoView({ behavior: "smooth", block: "start" });
  },
  // 按当前行号重建每行的款式图草稿
  resyncImportPhotoDrafts() {
    clearImportPhotoDrafts();
    (importPreview || []).forEach((r, i) => { photoDraft["imp" + i + "-img"] = normalizePhotos(r.values.img); });
  },
  importText() {
    const raw = ($("imp-text").value || "").trim();
    importRaw = raw;
    if (!raw) return toast("请先粘贴表格内容或选择文件");
    const lines = raw.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return toast("至少需要表头和一行数据");
    const sep = lines[0].includes("\t") ? "\t" : ",";
    const split = l => {
      if (sep === "\t") return l.split("\t");
      const out = []; let cur = "", q = false;
      for (let i = 0; i < l.length; i++) {
        const c = l[i];
        if (q) { if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
        else if (c === '"') q = true;
        else if (c === ",") { out.push(cur); cur = ""; }
        else cur += c;
      }
      out.push(cur); return out;
    };
    A.showPreview(A.rowsToPreview(lines.map(split)));
  },
  syncImportInputs() {
    if (!importPreview) return;
    const scal = importScalars();
    importPreview.forEach((r, i) => {
      const se = $("imp" + i + "-season"); if (se) r.season = se.value || "";
      const img = photoDraft["imp" + i + "-img"];
      if (img && img.length) r.values.img = img.slice(); else delete r.values.img;
      scal.forEach(f => {
        const el = $("imp" + i + "-" + f.k); if (!el) return;
        if (isMultiPick(f)) {
          let arr = []; try { arr = JSON.parse(el.value || "[]"); } catch (e) { }
          if (arr.length) r.values[f.k] = arr; else delete r.values[f.k];
          return;
        }
        const v = (el.value || "").trim(); if (v) r.values[f.k] = v; else delete r.values[f.k];
      });
    });
  },
  removeImportRow(i) {
    // 照片没传完不能删行，否则行号错位串图
    if (photosBlocked(/^imp\d+-img$/)) return;
    A.syncImportInputs(); if (!importPreview) return;
    importPreview.splice(i, 1); if (!importPreview.length) importPreview = null;
    A.resyncImportPhotoDrafts();
    render();
  },
  cancelImport() {
    importPreview = null;
    clearImportPhotoDrafts();
    render(); toast("已取消，未导入任何数据");
  },
  async confirmImport() {
    if (!importPreview || !importPreview.length) return;
    if (photosBlocked(/^imp\d+-img$/)) return;
    A.syncImportInputs();
    const built = importPreview.filter(r => r.values.styleNo || r.values.styleName)
      .map(r => ({ season: r.season || "未分季", values: r.values }));
    if (!built.length) return toast("每一单请至少填写货号或款式名");
    if (built.length > 500) return toast("一次最多导入 500 单，请把表格拆开分批导入");
    // 按修改后的值再查一次重复，有重复先确认
    const dup = built.filter(r => r.values.styleNo && state.orders.some(o =>
      String(o.values.styleNo || "").trim().toUpperCase() === String(r.values.styleNo).trim().toUpperCase() && o.season === r.season)).length;
    if (dup && !A.confirmImport.forced) {
      return modal({ title: `有 ${dup} 单可能重复`, okText: "仍然全部导入",
        body: `这 ${dup} 单的货号和季节跟系统里已有的订单一样，可能是同一份表导入了两次。可以先取消、在预览里把重复的移除。`,
        onOk: () => { A.confirmImport.forced = true; A.confirmImport().finally(() => { A.confirmImport.forced = false; }); } });
    }
    try {
      const r = await api("POST", "/orders/import", { orders: built });
      importPreview = null; importRaw = "";
      clearImportPhotoDrafts();
      await refresh(); go("orders"); toast(`成功导入 ${r.imported} 个订单`);
    } catch (e) { toast((e && e.error) || "导入失败"); }
  },
});
