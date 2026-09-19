"use strict";
// 订单详情：基础信息、跟进记录、加工点

function logEntriesHtml(list, o, key, section) {
  const entries = (list || []).slice().sort((a, b) => b.t - a.t);
  if (!entries.length) return `<div class="empty" style="padding:8px 0">暂无打卡记录</div>`;
  const isMainSub = key === "mainLog" || key.startsWith("sub:");
  return `<ul class="log">${entries.map(e => `<li>
    <div class="meta"><b>${esc(e.byName)}</b><span class="num">${fmtT(e.t)}</span>
      <span class="act-row">${canTouchEntry(o, e, section) ? `<button type="button" class="act-btn" onclick="A.editLog('${o.id}','${key}','${e.id}')">改</button>` : ""}
      ${canTouchEntry(o, e, section) ? `<button type="button" class="act-btn danger" onclick="A.delLog('${o.id}','${key}','${e.id}')">删</button>` : ""}</span></div>
    ${isMainSub && e.process ? `<div style="font-size:13px;color:var(--ink-2);margin-top:2px">
      生产工序：${esc(e.process)} · 车工人数：${esc(e.workers)} · 预计下车：${esc(fmtDate(e.estDone))}</div>` : ""}
    ${e.text ? `<div class="txt">${esc(e.text)}</div>` : ""}${photoGallery(e.photos)}</li>`).join("")}</ul>`;
}
// 本厂/加工点打卡必填工序、人数、预计下车时间
function mainSubAddBoxHtml(oid, key, placeholder) {
  return `<div class="addbox" id="add-${key}">
    <label class="field"><span>生产工序</span><input class="in" id="proc-${key}" placeholder="例：车缝、锁边"></label>
    <label class="field"><span>车工人数</span><input class="in" type="number" id="workers-${key}" placeholder="例：12"></label>
    <label class="field"><span>预计下车时间</span>${dateFieldHtml("est-" + key, "")}</label>
    <textarea class="in" id="txt-${key}" placeholder="${esc(placeholder)}" style="margin-top:8px"></textarea>
    ${photoPicker("log:" + key)}
    <div style="margin-top:8px"><button class="btn mini" onclick="A.addLog('${oid}','${key}')">提交打卡</button></div></div>`;
}
function logFieldHtml(o, f, list, addKey, canAdd, section) {
  return `<div class="logfield">
    <div class="lf-head"><span><span class="lf-dot"></span>${esc(f.label)}</span><span class="cnt">${(list || []).length} 条</span>
      ${canAdd ? `<button class="btn mini right" onclick="A.toggleAdd('${addKey}')">＋ 打卡</button>` : ""}</div>
    ${canAdd ? `<div class="addbox" id="add-${addKey}">
      <textarea class="in" id="txt-${addKey}" placeholder="填写当前进度情况，可详细描述…"></textarea>
      ${photoPicker("log:" + addKey)}
      <div style="margin-top:8px"><button class="btn mini" onclick="A.addLog('${o.id}','${addKey}')">提交打卡</button></div></div>` : ""}
    ${logEntriesHtml(list, o, addKey, section)}</div>`;
}
function subCardHtml(o, s, canProdLog) {
  const key = "sub:" + s.id;
  return `<div style="margin-top:10px;border-top:.5px solid var(--line);padding-top:10px">
    <div class="lf-head fac-head">
      <span class="fac-kind">加工点</span><span class="tag hl">${esc(s.name)}</span>
      ${canProdLog || isAdmin() ? `<span class="act-row">${canProdLog ? `<button type="button" class="act-btn" onclick="A.renameSub('${o.id}','${s.id}')">改名</button>` : ""}${
        isAdmin() ? `<button type="button" class="act-btn danger" onclick="A.delSub('${o.id}','${s.id}')">删除</button>` : ""}</span>` : ""}
      ${canProdLog ? `<button class="btn mini right" onclick="A.toggleAdd('${key}')">＋ 打卡</button>` : ""}
    </div>
    ${canProdLog ? mainSubAddBoxHtml(o.id, key, "该加工点的进度情况（补充说明，选填）…") : ""}
    ${logEntriesHtml(s.log, o, key, "production")}</div>`;
}

function vDetail() {
  const o = state.orders.find(x => x.id === route.id);
  if (!o) return `<div class="card"><div class="empty">订单不存在</div></div>`;
  const scalars = scalarFields;
  const logsOf = s => state.fields[s].filter(f => f.type === "log");
  const canEditOrd = canEditSection(o, "order");
  const canOrdLog = canAddLog(o, "order"), canProdLog = canAddLog(o, "production");
  const canInsp = canWriteInspProblem(o), canFix = canWriteInspFix(o);
  // 订单交期/发货日期可在详情页直接选
  const isQuickDateField = f => f.k === "deadline" || f.k === "shipDate";
  const kv = (fs, canEditThis) => fs.map(f => {
    const isShipDateRow = f.k === "shipDate";
    const rowStyle = isShipDateRow ? ` style="border-bottom:0"` : "";
    // 发货日期已锁定且有权改时显示「清空」
    const showClearBtn = isShipDateRow && canEditThis && shipLocked(o);
    const clearBtn = showClearBtn ? `<button class="btn mini ghost" onclick="A.clearShipDate('${o.id}')">清空</button>` : "";
    const row = isQuickDateField(f) && canEditThis
      ? `<div class="row-item"${rowStyle}><div class="row-main"><div class="row-label">${esc(f.label)}</div></div>
          <div class="row-value" style="display:flex;align-items:center;gap:10px">${dateFieldHtml("qd-" + o.id + "-" + f.k, o.values[f.k], `A.quickSetDate('${o.id}','${f.k}',this.value)`)}${clearBtn}</div></div>`
      : `<div class="row-item"${rowStyle}><div class="row-main"><div class="row-label">${esc(f.label)}</div></div>
          <div class="row-value">${esc(displayVal(o, f)) || "—"}</div></div>`;
    const warn = isShipDateRow ? `<div style="margin:0 16px 12px;padding:10px 14px;border-radius:var(--radius);background:var(--bad-soft);color:var(--bad);font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px">
        <span>⚠️</span><span>发货日期一旦选择，不可以再次修改</span></div>` : "";
    return row + warn;
  }).join("");
  const editForm = s => `<div class="grid2">${scalars(s).filter(f => !isQuickDateField(f)).map(f => fieldRow(f, o.values[f.k] || "")).join("")}</div>`;
  const photos = normalizePhotos(o.values.img);
  const headerThumb = coverImgHtml(photos, "header-thumb");
  const dateFieldsProd = scalars("production").filter(isQuickDateField);
  const topProdScalars = scalars("production").filter(f => !isQuickDateField(f));
  const orderKvFields = scalars("order").filter(f => f.type !== "image" && !isQuickDateField(f));
  const dateFieldsOrder = scalars("order").filter(isQuickDateField);

  return `<section class="group g-head">
    <div class="card"><div class="card-pad" style="display:flex;align-items:center;gap:14px">
      ${seasonTag(o.season, "flex:none;font-size:14px;padding:5px 12px")}
      <div style="flex:1;min-width:0">
        <div style="font-size:20px;font-weight:700;letter-spacing:-.02em">${esc(o.values.styleNo || "")}</div>
        <div style="color:var(--ink-2);margin-top:2px">${esc([o.values.styleName, o.values.style].filter(Boolean).join(" "))}</div>
      </div>
      ${headerThumb}
    </div></div></section>

  <section class="group g-order">
    <div class="group-title"><span class="cat-title">一、订单明细</span>${canEditOrd ? `<button class="btn mini ghost right" onclick="A.toggleBasic()">${editingBasic ? "取消" : "编辑"}</button>` : ""}</div>
    <div class="card">${editingBasic && canEditOrd
      ? `<label class="field"><span>订单季节</span>${seasonSelectHtml(o.season)}</label>${editForm("order")}
         <div class="btn-row"><button class="btn" onclick="A.saveBasic('${o.id}')">保存修改</button></div>`
      : kv(orderKvFields, canEditOrd)}</div>
    ${dateFieldsOrder.length ? `<div class="card" style="margin-top:14px">${kv(dateFieldsOrder, canEditOrd)}</div>` : ""}
    <div class="card" style="margin-top:14px">${logsOf("order").map(f => logFieldHtml(o, f, o.logs[f.k] || [], f.k, canOrdLog, "order")).join("")}</div>
  </section>

  <section class="group g-prod">
    <div class="group-title"><span class="cat-title">二、生产明细</span>${canEditOrd ? `<button class="btn mini ghost right" onclick="A.toggleFollower()">${editingFollower ? "取消" : "编辑"}</button>` : ""}
      <span style="margin-left:8px;font-size:12.5px;color:var(--ink-2)">${o.values.follower ? `负责人 ${esc(uname(o.values.follower))}` : "未指定下厂员"}</span></div>
    <div class="card">${editingFollower && canEditOrd
      ? `${editForm("production")}<div class="btn-row"><button class="btn" onclick="A.saveBasic('${o.id}')">保存修改</button></div>`
      : kv(topProdScalars, false)}</div>
    <div class="card" style="margin-top:14px">
      ${logsOf("production").filter(f => f.k === "cutting").map(f => logFieldHtml(o, f, o.logs[f.k] || [], f.k, canProdLog, "production")).join("")}
      <div class="prodgroup-title"><span><span class="lf-dot"></span>生产进度</span></div>
      <div class="logfield" style="padding-top:0">
        <div style="margin-top:10px;border-top:.5px solid var(--line);padding-top:10px">
          <div class="lf-head fac-head"><span class="fac-kind">本厂</span>
            <span class="tag hl">${esc(o.values.factory) || "未指定"}</span>
            ${canProdLog ? `<button class="btn mini right" onclick="A.toggleAdd('mainLog')">＋ 打卡</button>` : ""}</div>
          ${canProdLog ? mainSubAddBoxHtml(o.id, "mainLog", "本厂生产进度（补充说明，选填）…") : ""}
          ${logEntriesHtml(o.mainLog, o, "mainLog", "production")}</div>
        ${(o.subs || []).map(s => subCardHtml(o, s, canProdLog)).join("")}
        ${canProdLog ? `<div style="margin-top:10px;border-top:.5px solid var(--line);padding-top:10px">
          <button class="btn mini ghost" onclick="A.addSubPrompt('${o.id}')">＋ 添加加工点</button></div>` : ""}
      </div>
      ${logsOf("production").filter(f => f.k !== "cutting").map(f => logFieldHtml(o, f, o.logs[f.k] || [], f.k, canProdLog, "production")).join("")}
    </div>
    ${dateFieldsProd.length ? `<div class="card" style="margin-top:14px">${kv(dateFieldsProd, canEditShipDate(o))}</div>` : ""}
  </section>

  <section class="group g-insp">
    <div class="group-title"><span class="cat-title">三、验货问题</span>${canInsp ? `<button class="btn mini ghost right" onclick="A.toggleAdd('insp')">＋ 新增</button>` : ""}</div>
    <div class="card">
      ${canInsp ? `<div class="addbox" id="add-insp">
        <div id="insp-items"><label class="field"><span>发现问题</span><textarea class="in insp-p" style="min-height:62px"></textarea></label></div>
        <div class="field" style="border:0"><span>照片</span>${photoPicker("insp")}</div>
        <div class="btn-row"><button class="btn mini ghost" onclick="A.inspAddRow()">＋ 再加一条</button>
          <button class="btn mini" onclick="A.saveInsp('${o.id}')">保存验货记录</button></div></div>` : ""}
      ${o.inspections.length ? o.inspections.slice().sort((a, b) => b.t - a.t).map(g => inspBatchHtml(o, g, canInsp, canFix)).join("")
        : `<div class="empty">暂无验货记录</div>`}</div>
  </section>

  <section class="group g-follow">
    <div class="group-title"><span class="cat-title">四、跟单小结</span><button class="btn mini ghost right" onclick="A.toggleAdd('follow')">＋ 添加</button></div>
    <div class="card">
      <div class="addbox" id="add-follow" style="padding:12px 16px">
        <textarea class="in" id="txt-follow" placeholder="填写跟单过程中的问题、沟通事项…"></textarea>
        ${photoPicker("follow")}
        <div style="margin-top:8px"><button class="btn mini" onclick="A.addFollow('${o.id}')">提交</button></div></div>
      ${o.followIssues.length ? `<ul class="log" style="padding:4px 16px 12px">${o.followIssues.slice().sort((a, b) => b.t - a.t).map(e => `<li>
        <div class="meta"><b>${esc(e.byName)}</b><span class="num">${fmtT(e.t)}</span>${canTouchEntry(o, e) ?
          `<button type="button" class="act-btn danger" onclick="A.delFollow('${o.id}','${e.id}')">删</button>` : ""}</div>
        ${e.text ? `<div class="txt">${esc(e.text)}</div>` : ""}${photoGallery(e.photos)}</li>`).join("")}</ul>` : `<div class="empty">暂无记录</div>`}</div>
  </section>
  ${isAdmin() ? `<section class="group g-del"><div class="btn-row" style="padding-left:0;padding-right:0">
    <button class="btn danger ghost block" onclick="A.delOrder('${o.id}')">删除此订单</button></div></section>` : ""}`;
}

Object.assign(A, {
  async quickSetDate(oid, key, val) {
    await run(() => api("PATCH", "/orders/" + oid, { values: { [key]: val } }), "已更新");
  },
  clearShipDate(oid) {
    confirmDanger("清空发货日期？", "清空后这个字段会解锁，可以重新选择发货日期。",
      () => run(() => api("PATCH", "/orders/" + oid, { values: { shipDate: "" } }), "发货日期已清空"), "确认清空");
  },

  toggleBasic() {
    editingBasic = !editingBasic;
    resetPhotoPending();
    if (editingBasic) { const o = state.orders.find(x => x.id === route.id); photoDraft = { img: normalizePhotos(o && o.values.img) }; }
    else photoDraft = {};
    render();
  },
  toggleFollower() {
    editingFollower = !editingFollower;
    render();
  },
  async saveBasic(oid) {
    if (photosBlocked("img")) return;
    const season = ($("nf-season") || {}).value || "";
    const values = {}; A.collectScalars("order", values); A.collectScalars("production", values);
    await run(() => api("PATCH", "/orders/" + oid, { season, values }).then(() => { editingBasic = false; editingFollower = false; photoDraft = {}; }), "已保存修改");
  },
  delOrder(oid) {
    confirmDanger("删除此订单？", "删除后不可恢复，订单下的全部打卡记录一并删除。",
      () => run(() => api("DELETE", "/orders/" + oid).then(() => go("orders")), "订单已删除"));
  },

  toggleAdd(key) { const b = $("add-" + key); if (b) b.classList.toggle("show"); },
  async addLog(oid, key) {
    if (photosBlocked("log:" + key)) return;
    const el = $("txt-" + key), text = ((el && el.value) || "").trim();
    const photos = photoDraft["log:" + key] || [];
    const body = { key, text, photos };
    const isMainSub = key === "mainLog" || key.startsWith("sub:");
    if (isMainSub) {
      const process = ($("proc-" + key) || {}).value || "", workers = ($("workers-" + key) || {}).value || "";
      const estDone = ($("est-" + key) || {}).value || "";
      if (!process.trim() || !workers.trim() || !estDone) return toast("请填写生产工序、车工人数、预计下车时间");
      Object.assign(body, { process: process.trim(), workers: workers.trim(), estDone });
    } else if (!text && !photos.length) return toast("请填写打卡内容或加照片");
    await run(() => api("POST", `/orders/${oid}/logs`, body).then(() => { delete photoDraft["log:" + key]; }), "打卡成功");
  },
  editLog(oid, key, eid) {
    const o = state.orders.find(x => x.id === oid);
    const list = key === "mainLog" ? o.mainLog
      : key.startsWith("sub:") ? ((o.subs.find(s => s.id === key.slice(4)) || {}).log || [])
      : (o.logs[key] || []);
    const e = list.find(x => x.id === eid); if (!e) return;
    askText({ title: "修改打卡内容", input: "textarea", value: e.text, okText: "保存" },
      t => run(() => api("PATCH", `/orders/${oid}/logs/${key}/${eid}`, { text: t }), "已修改"));
  },
  delLog(oid, key, eid) {
    confirmDanger("删除这条打卡记录？", "", () => run(() => api("DELETE", `/orders/${oid}/logs/${key}/${eid}`), "已删除"));
  },

  addSubPrompt(oid) {
    askText({ title: "添加加工点", body: "给这个加工点起个名字，比如「绣花外发点」「二次印花点」。", okText: "添加" },
      name => run(() => api("POST", `/orders/${oid}/subs`, { name }), "已添加加工点：" + name));
  },
  renameSub(oid, subId) {
    const o = state.orders.find(x => x.id === oid);
    const sub = o && o.subs.find(x => x.id === subId);
    if (!sub) return;
    askText({ title: "修改加工点名称", value: sub.name, okText: "保存" },
      name => run(() => api("PATCH", `/orders/${oid}/subs/${subId}`, { name }), "已修改"));
  },
  delSub(oid, subId) {
    confirmDanger("删除这个加工点？", "删除后该加工点下的打卡记录一并删除，且不可恢复。",
      () => run(() => api("DELETE", `/orders/${oid}/subs/${subId}`), "已删除"));
  },

  async addFollow(oid) {
    if (photosBlocked("follow")) return;
    const text = ($("txt-follow").value || "").trim();
    const photos = photoDraft.follow || [];
    if (!text && !photos.length) return toast("请填写内容或加照片");
    await run(() => api("POST", `/orders/${oid}/follow`, { text, photos }).then(() => { delete photoDraft.follow; }), "已添加");
  },
  delFollow(oid, eid) {
    confirmDanger("删除这条记录？", "", () => run(() => api("DELETE", `/orders/${oid}/follow/${eid}`), "已删除"));
  },
});
