"use strict";
// 验货：发现问题、整改情况、补充说明

function inspItemHtml(o, g, it, canInsp, canFix) {
  // 没权限填整改时写明该谁填
  const fixHint = o.values.follower ? `由 ${esc(uname(o.values.follower))} 或管理员填写` : "尚未指定下厂员，需管理员先在「生产明细」指定负责人";
  return `<div class="insp-item">
    <div><span class="lbl p">发现问题</span>${esc(it.problem)}
      ${canInsp ? `<button type="button" class="act-btn" style="margin-left:6px" onclick="A.editInspProblem('${o.id}','${g.id}','${it.id}')">改</button>` : ""}</div>
    <div style="margin-top:4px"><span class="lbl f2">整改情况</span>${it.fix ? esc(it.fix)
        : `<span style="color:var(--ink-2)">待整改${canFix ? "" : `（${fixHint}）`}</span>`}
      ${canFix ? `<button type="button" class="act-btn" style="margin-left:6px" onclick="A.editInspFix('${o.id}','${g.id}','${it.id}')">${it.fix ? "改" : "填写"}</button>` : ""}</div>
    ${(it.notes || []).length ? it.notes.map(n => `<div style="margin-top:4px;font-size:12.5px;color:var(--ink-2)">补充说明（${esc(n.byName)} · ${fmtT(n.t)}）：${esc(n.text)}</div>`).join("") : ""}
    ${(canInsp || canFix) ? `<button type="button" class="act-btn ghost" style="margin-top:6px" onclick="A.addInspNote('${o.id}','${g.id}','${it.id}')">＋ 补充说明</button>` : ""}
  </div>`;
}
function inspBatchHtml(o, g, canInsp, canFix) {
  return `<div class="insp-day">
    <div class="lf-head"><span style="font-weight:400;color:var(--ink-2);font-size:12.5px">${esc(g.byName)} · <span class="num">${fmtT(g.t)}</span></span>
      ${canTouchEntry(o, g) ? `<button type="button" class="act-btn danger right" onclick="A.delInsp('${o.id}','${g.id}')">删除</button>` : ""}</div>
    ${g.items.map(it => inspItemHtml(o, g, it, canInsp, canFix)).join("")}${photoGallery(g.photos)}</div>`;
}

function inspItemOf(oid, gid, itemId) {
  const o = state.orders.find(x => x.id === oid);
  const g = o && o.inspections.find(x => x.id === gid);
  return g && g.items.find(x => x.id === itemId);
}

Object.assign(A, {
  inspAddRow() {
    const d = document.createElement("label"); d.className = "field";
    d.innerHTML = `<span>发现问题</span><textarea class="in insp-p" style="min-height:62px"></textarea>`;
    $("insp-items").appendChild(d);
  },
  async saveInsp(oid) {
    if (photosBlocked("insp")) return;
    const problems = [...document.querySelectorAll(".insp-p")].map(t => t.value.trim()).filter(Boolean);
    const photos = photoDraft.insp || [];
    if (!problems.length && !photos.length) return toast("请至少填写一条发现的问题或加照片");
    await run(() => api("POST", `/orders/${oid}/inspections`, { problems, photos }).then(() => { delete photoDraft.insp; }), "验货记录已保存");
  },
  delInsp(oid, gid) {
    confirmDanger("删除这组验货记录？", "", () => run(() => api("DELETE", `/orders/${oid}/inspections/${gid}`), "已删除"));
  },
  editInspProblem(oid, gid, itemId) {
    const it = inspItemOf(oid, gid, itemId); if (!it) return;
    askText({ title: "修改发现的问题", input: "textarea", value: it.problem, okText: "保存" },
      t => run(() => api("PATCH", `/orders/${oid}/inspections/${gid}/items/${itemId}`, { problem: t }), "已修改"));
  },
  editInspFix(oid, gid, itemId) {
    const it = inspItemOf(oid, gid, itemId); if (!it) return;
    modal({ title: "填写整改情况", input: "textarea", value: it.fix || "", okText: "保存",
      onOk: v => run(() => api("PATCH", `/orders/${oid}/inspections/${gid}/items/${itemId}`, { fix: (v || "").trim() }), "已保存") });
  },
  addInspNote(oid, gid, itemId) {
    askText({ title: "添加补充说明", input: "textarea", okText: "添加" },
      text => run(() => api("POST", `/orders/${oid}/inspections/${gid}/items/${itemId}/notes`, { text }), "已添加"));
  },
});
