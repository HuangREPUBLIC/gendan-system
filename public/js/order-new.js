"use strict";
// 新建订单页（批量导入入口也在这一页）

function vNew() {
  const scalars = scalarFields;
  if (!photoDraft.img) photoDraft.img = [];
  // 日期默认今天，但填后锁定的(发货日期等)不能默认
  const defVal = f => (f.type === "date" && !f.lock) ? todayStr()
    : (f.k === "sales" && me().template === "sales" ? me().id : "");
  return `<section class="group">
    <div class="group-title">订单明细</div>
    <div class="card">
      <label class="field"><span>订单季节</span>${seasonSelectHtml("")}</label>
      <div class="grid2">${scalars("order").map(f => fieldRow(f, defVal(f))).join("")}</div>
    </div></section>
  <section class="group">
    <div class="group-title">生产安排（指定负责打卡的下厂员）</div>
    <div class="card"><div class="grid2">${scalars("production").map(f => !f.lock ? fieldRow(f, defVal(f))
      : `<label class="field"><span>${esc(f.label)}</span>${fieldInput(f, defVal(f))}
          <div style="margin-top:6px;font-size:12px;color:var(--bad);display:flex;align-items:center;gap:4px">
            <span>⚠️</span><span>一旦选择，不可以再次修改</span></div></label>`).join("")}</div></div>
    <div class="btn-row" style="padding-left:0;padding-right:0">
      <button class="btn block" onclick="A.createOrder()">保存订单</button></div>
  </section>
  <section class="group">
    <div class="group-title">表格批量导入<button type="button" class="btn plain right" onclick="A.downloadImportTemplate()">下载导入模板</button></div>
    <div class="card"><div class="card-pad">
      <div class="imp-drop" data-drop="import">
        <input type="file" id="imp-file" class="file-native" accept=".xlsx,.xls,.csv,.txt" onchange="A.importFile(this)">
        <button type="button" class="imp-drop-btn" onclick="document.getElementById('imp-file').click()">
          <span class="imp-drop-ic">${ICONS.orders}</span>
          <span class="imp-drop-main" id="imp-file--name">选择 Excel / CSV 文件</span>
          <span class="imp-drop-sub">支持 .xlsx .xls .csv<span class="imp-drop-desk">，也可以把文件拖到这里</span></span>
        </button>
      </div>
      <details class="imp-paste"${importRaw ? " open" : ""}><summary>或者直接粘贴表格内容</summary>
        <textarea class="in" id="imp-text" placeholder="在 Excel / WPS 里选中要导入的区域(含表头)，复制后粘贴到这里">${esc(importRaw)}</textarea>
        <div style="margin-top:10px"><button class="btn ghost" onclick="A.importText()">识别粘贴的内容</button></div>
      </details>
    </div>${importPreview ? importPreviewHtml() : ""}</div>
  </section>`;
}

Object.assign(A, {
  async createOrder() {
    if (photosBlocked("img")) return;
    const season = ($("nf-season").value || "").trim();
    if (!season) return toast("请选择订单季节");
    const values = {}; A.collectScalars("order", values); A.collectScalars("production", values);
    if (!values.styleNo && !values.styleName) return toast("请至少填写货号或款式名");
    try { await api("POST", "/orders", { season, values }); photoDraft = {}; await refresh(); go("orders"); toast("订单已创建"); }
    catch (e) { toast((e && e.error) || "创建失败"); }
  },
});
