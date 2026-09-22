"use strict";
// 应用内消息通知

// 同一个人短时间内连着动了几张单(比如批量录入)，列表里收成一组，点开再看每一单
const NOTIF_GROUP_MIN = 3, NOTIF_GROUP_GAP = 30 * 60 * 1000;
const openNotifGroups = new Set();  // 展开的分组，用组里最新一条的 id 认
function groupNotifs(list) {
  const out = [];
  list.forEach(n => {
    const g = out[out.length - 1], prev = g && g.items[g.items.length - 1];
    const key = n.actorId || n.actorName;
    if (prev && key && g.key === key && prev.createdAt - n.createdAt < NOTIF_GROUP_GAP) g.items.push(n);
    else out.push({ key, items: [n] });
  });
  return out.flatMap(g => g.items.length >= NOTIF_GROUP_MIN ? [g] : g.items.map(n => ({ items: [n] })));
}

// 老通知没有 actorName 等字段，退回纯文本
function notifItemHtml(n, child) {
  const rich = !!(n.actorName && n.orderLabel && n.what);
  const more = n.merged > 1 ? `<span class="n-merged">· 共 ${n.merged} 次更新</span>` : "";
  return `<div class="notif${rich ? " rich" : ""}${n.read ? "" : " un"}${child ? " child" : ""}" role="button" tabindex="0"
    onclick="A.openNotif('${n.id}','${esc(n.orderId || "")}')">
    ${child ? "" : rich ? avatarHtml(n.actorName, "sm") : `<span class="n-dot"></span>`}
    <div class="n-main">${rich ? `
      <div class="n-top">${child ? "" : `<span class="n-actor">${esc(n.actorName)}</span>`}
        <span class="tag order num">${esc(n.orderLabel)}</span>
        <span class="n-time num">${fmtT(n.createdAt)}</span></div>
      <div class="n-what">${esc(n.what)}${more}</div>` : `
      <div class="n-text">${esc(n.text)}</div>
      <div class="n-time num">${fmtT(n.createdAt)}</div>`}
    </div><button type="button" class="n-del" title="删除这条通知" aria-label="删除这条通知"
      onclick="event.stopPropagation();A.deleteNotif('${n.id}')">✕</button></div>`;
}
function notifGroupHtml(g) {
  const head = g.items[0], gid = head.id, open = openNotifGroups.has(gid);
  const unread = g.items.some(n => !n.read);
  const labels = [...new Set(g.items.map(n => n.orderLabel))];
  return `<div class="notif-group${open ? " open" : ""}">
    <div class="notif rich${unread ? " un" : ""}" role="button" tabindex="0" aria-expanded="${open}"
      onclick="A.toggleNotifGroup('${gid}')" onkeydown="if(event.key==='Enter')A.toggleNotifGroup('${gid}')">
      ${avatarHtml(head.actorName, "sm")}
      <div class="n-main">
        <div class="n-top"><span class="n-actor">${esc(head.actorName)}</span>
          <span class="n-time num">${fmtT(head.createdAt)}</span></div>
        <div class="n-what">更新了 ${labels.length} 个订单<span class="n-chev" aria-hidden="true"></span></div>
        <div class="n-tags">${labels.slice(0, 4).map(l => `<span class="tag order num">${esc(l)}</span>`).join("")}${
          labels.length > 4 ? `<span class="n-merged">等 ${labels.length} 单</span>` : ""}</div>
      </div><button type="button" class="n-del" title="删除这一组通知" aria-label="删除这一组通知"
        onclick="event.stopPropagation();A.deleteNotifGroup('${gid}')">✕</button></div>
    ${open ? `<div class="notif-children">${g.items.map(n => notifItemHtml(n, true)).join("")}</div>` : ""}</div>`;
}
function notifItemsHtml() {
  const list = state.notifs.list;
  if (!list) return `<div class="empty">加载中…</div>`;
  if (!list.length) return `<div class="empty">暂无通知</div>`;
  return groupNotifs(list).map(g => g.items.length > 1 ? notifGroupHtml(g) : notifItemHtml(g.items[0])).join("");
}
const notifGroupItems = gid => (groupNotifs(state.notifs.list || []).find(g => g.items[0].id === gid) || { items: [] }).items;

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
  // 展开分组即算看过，组里未读的一起标为已读
  async toggleNotifGroup(gid) {
    if (openNotifGroups.has(gid)) { openNotifGroups.delete(gid); render(); return; }
    openNotifGroups.add(gid);
    const unread = notifGroupItems(gid).filter(n => !n.read);
    unread.forEach(n => n.read = true);
    state.notifs.unread = Math.max(0, state.notifs.unread - unread.length);
    render();
    if (unread.length) try { await api("POST", "/notifications/read-batch", { ids: unread.map(n => n.id) }); } catch (e) { }
  },
  async deleteNotifGroup(gid) {
    const items = notifGroupItems(gid), ids = new Set(items.map(n => n.id));
    try {
      await api("POST", "/notifications/delete-batch", { ids: [...ids] });
      state.notifs.unread = Math.max(0, state.notifs.unread - items.filter(n => !n.read).length);
      state.notifs.list = (state.notifs.list || []).filter(x => !ids.has(x.id));
      openNotifGroups.delete(gid);
      render();
    } catch (e) { toast((e && e.error) || "删除失败"); }
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
