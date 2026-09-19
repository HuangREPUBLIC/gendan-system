"use strict";
// 通用弹窗

function confirmDanger(title, body, onOk, okText) {
  modal({ title, body, danger: true, okText: okText || "确认删除", onOk });
}
function askText(opts, onText) {
  modal(Object.assign({ input: "text" }, opts, { onOk: v => { const t = (v || "").trim(); if (t) onText(t); } }));
}

function modal(opts) { modalState = opts; renderModal(); }
function renderModal() {
  const mask = $("mask");
  if (!modalState) { mask.classList.remove("show"); mask.innerHTML = ""; return; }
  const o = modalState;
  mask.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
    <div class="m-title">${esc(o.title)}</div>
    ${o.body ? `<div class="m-body">${esc(o.body)}</div>` : ""}
    ${o.html ? `<div style="margin-top:14px">${o.html}</div>` : ""}
    ${o.input === "textarea" ? `<textarea class="in" id="m-input" style="margin-top:14px;min-height:110px"></textarea>`
      : o.input ? `<input class="in" id="m-input" style="margin-top:14px" ${o.password ? 'type="password"' : ""}>` : ""}
    <div class="m-actions">
      <button class="btn ghost" onclick="A.modalCancel()">取消</button>
      <button class="btn ${o.danger ? "danger" : ""}" onclick="A.modalOk()">${esc(o.okText || "确定")}</button>
    </div></div>`;
  if (o.input) { const i = $("m-input"); i.value = o.value || ""; i.focus(); }
  mask.classList.add("show");
}

Object.assign(A, {
  modalOk() {
    const st = modalState; if (!st) return;
    const v = st.input ? ($("m-input") ? $("m-input").value : "") : null;
    if (st.keepOpenOnOk) { if (st.onOk) st.onOk(v); return; }
    modalState = null; renderModal();
    if (st.onOk) st.onOk(v);
  },
  modalCancel() { modalState = null; renderModal(); },
});
