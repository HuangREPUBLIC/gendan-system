"use strict";
// 打卡记录（按订单分组）

const LOG_GROUP_PREVIEW = 5;  // 每组默认显示的条数
function logListHtml(rows) {
  if (!rows) return `<div class="card"><div class="empty">加载中…</div></div>`;
  if (!rows.length) return `<div class="card"><div class="empty">还没有打卡记录</div></div>`;
  const groups = [];
  const byOrder = new Map();
  rows.forEach(r => {
    let g = byOrder.get(r.orderId);
    if (!g) { g = { orderId: r.orderId, styleNo: r.styleNo, styleName: r.styleName, items: [] }; byOrder.set(r.orderId, g); groups.push(g); }
    g.items.push(r);
  });
  groups.forEach(g => g.items.sort((a, b) => b.t - a.t));
  groups.sort((a, b) => b.items[0].t - a.items[0].t);
  return groups.map(g => {
    const expanded = expandedLogGroups.has(g.orderId);
    const visible = expanded ? g.items : g.items.slice(0, LOG_GROUP_PREVIEW);
    const hidden = g.items.length - visible.length;
    return `<div class="card log-group">
    <div class="lf-head" style="padding:11px 16px 0">
      <a href="javascript:void(0)" onclick="go('detail','${g.orderId}')">${esc(g.styleNo || "")} ${esc(g.styleName || "")}</a>
      <span class="cnt right">共 ${g.items.length} 条</span></div>
    <div class="loglist">${visible.map(r => `<div class="logrow">
      <div class="lr-top"><span>${esc(r.label)}</span><span class="num right">${fmtT(r.t)}</span></div>
      <div class="lr-text">${esc(r.text)}</div></div>`).join("")}</div>
    ${hidden > 0 ? `<button class="btn plain block" onclick="A.toggleLogGroup('${g.orderId}')">展开剩余 ${hidden} 条</button>`
      : (expanded && g.items.length > LOG_GROUP_PREVIEW ? `<button class="btn plain block" onclick="A.toggleLogGroup('${g.orderId}')">收起</button>` : "")}
    </div>`;
  }).join("");
}

function vStaffLogs() {
  const u = userById(route.id);
  return `<section class="group">
    <div class="group-title">${esc(u ? u.name : "")} 的打卡记录${state.myLogs ? ` · 共 ${state.myLogs.length} 条` : ""}</div>
    <div class="log-groups">${logListHtml(state.myLogs)}</div></section>`;
}

Object.assign(A, {
  async loadMyLogs(userId) {
    state.myLogs = null; expandedLogGroups.clear();
    try { state.myLogs = await api("GET", `/users/${userId}/logs`); }
    catch (e) { state.myLogs = []; toast((e && e.error) || "读取失败"); }
    render();
  },
  toggleLogGroup(orderId) {
    if (expandedLogGroups.has(orderId)) expandedLogGroups.delete(orderId); else expandedLogGroups.add(orderId);
    render();
  },
  viewStaffLogs(id) { go("staffLogs", id); },
});
