"use strict";
// 应用内消息通知

// 老通知没有 actorName 等字段，退回纯文本
function notifItemsHtml() {
  const list = state.notifs.list;
  if (!list) return `<div class="empty">加载中…</div>`;
  if (!list.length) return `<div class="empty">暂无通知</div>`;
  return list.map(n => {
    const rich = !!(n.actorName && n.orderLabel && n.what);
    return `<div class="notif${rich ? " rich" : ""}${n.read ? "" : " un"}" role="button" tabindex="0"
      onclick="A.openNotif('${n.id}','${esc(n.orderId || "")}')">
      ${rich ? avatarHtml(n.actorName, "sm") : `<span class="n-dot"></span>`}
      <div class="n-main">${rich ? `
        <div class="n-top"><span class="n-actor">${esc(n.actorName)}</span>
          <span class="tag order num">${esc(n.orderLabel)}</span>
          <span class="n-time num">${fmtT(n.createdAt)}</span></div>
        <div class="n-what">${esc(n.what)}</div>` : `
        <div class="n-text">${esc(n.text)}</div>
        <div class="n-time num">${fmtT(n.createdAt)}</div>`}
      </div><button type="button" class="n-del" title="删除这条通知" aria-label="删除这条通知"
        onclick="event.stopPropagation();A.deleteNotif('${n.id}')">✕</button></div>`;
  }).join("");
}

function vNotifs() {
  const list = state.notifs.list;
  return `<section class="group">
    <div class="group-title">订单动态${list ? ` · 共 ${list.length} 条` : ""}</div>
    <div class="card notif-list">${notifItemsHtml()}</div>
    ${(list || []).some(x => x.read) ? `<div class="btn-row"><button class="btn plain block" onclick="A.clearReadNotifs()">清空已读通知</button></div>` : ""}
  </section>`;
}

Object.assign(A, {
  async refreshNotifUnread() {
    try {
      const r = await api("GET", "/notifications/unread-count");
      const changed = r.total !== state.notifs.unread;
      state.notifs.unread = r.total;
      if (changed && document.querySelector(".tabbar")) render();
    } catch (e) { }
  },
  async loadNotifs() {
    try { state.notifs.list = await api("GET", "/notifications"); }
    catch (e) { state.notifs.list = []; }
    render();
  },
  toggleNotifPanel() {
    state.notifs.open = !state.notifs.open;
    render();
    if (state.notifs.open) A.loadNotifs();
  },
  closeNotifPanel() { state.notifs.open = false; render(); },
  // 标记已读并跳到订单（订单已删则留在原页）
  async openNotif(id, orderId) {
    state.notifs.open = false;
    const n = (state.notifs.list || []).find(x => x.id === id);
    if (n && !n.read) {
      n.read = true;
      state.notifs.unread = Math.max(0, state.notifs.unread - 1);
      try { await api("POST", `/notifications/${id}/read`); } catch (e) { }
    }
    if (orderId && state.orders.some(o => o.id === orderId)) go("detail", orderId);
    else { render(); if (orderId) toast("这张订单已经不在了"); }
  },
  async deleteNotif(id) {
    try {
      await api("DELETE", `/notifications/${id}`);
      const n = (state.notifs.list || []).find(x => x.id === id);
      if (n && !n.read) state.notifs.unread = Math.max(0, state.notifs.unread - 1);
      state.notifs.list = (state.notifs.list || []).filter(x => x.id !== id);
      render();
    } catch (e) { toast((e && e.error) || "删除失败"); }
  },
  clearReadNotifs() {
    confirmDanger("清空已读通知？", "只删除你自己已读过的通知，未读的会保留。", async () => {
      try {
        await api("DELETE", "/notifications?read=1");
        state.notifs.list = (state.notifs.list || []).filter(x => !x.read);
        render(); toast("已清空已读通知");
      } catch (e) { toast((e && e.error) || "操作失败"); }
    }, "清空");
  },
  async markAllNotifsRead() {
    try {
      await api("POST", "/notifications/read-all");
      state.notifs.unread = 0;
      (state.notifs.list || []).forEach(n => n.read = true);
      render(); toast("已全部标为已读");
    } catch (e) { toast((e && e.error) || "操作失败"); }
  },
});
