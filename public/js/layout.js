"use strict";
// 路由和页面框架：go 跳转、标签栏、桌面端侧栏和顶栏（窄屏隐藏）、render 总入口

function go(v, id) {
  route = { v, id: id || null }; editingBasic = false; editingFollower = false;
  photoDraft = {}; resetPhotoPending(); state.notifs.open = false;
  if (lightbox) closeLightboxNow(0, 0, false);
  if (v !== "chat") { state.chat.activeId = null; state.chat.messages = []; state.chat.draft = ""; state.chat.att = null; }
  render(); window.scrollTo(0, 0);
  if (v === "account") { A.loadMyLogs(state.me.id); refreshPushState(true); }
  if (v === "staffLogs" && id) A.loadMyLogs(id);
  if (v === "chat") { A.loadContacts(); A.refreshUnread(); }
  if (v === "notifs") A.loadNotifs();
}

// 各页标题栏；crumb 给桌面端面包屑用
function pageMeta() {
  const back = (label, fn) => `<button class="nav-btn" onclick="${fn}">‹ ${esc(label)}</button>`;
  const crumb = (label, fn) => ({ label, fn });
  switch (route.v) {
    case "orders": return { title: "订单",
      right: canCreateOrder() ? `<button class="nav-btn plus" title="新建订单" onclick="go('new')">＋</button>` : "" };
    case "new": return { title: "新建订单", left: back("订单", "go('orders')"), crumb: crumb("订单", "go('orders')") };
    case "detail": return { title: "订单详情", left: back("订单", "go('orders')"), crumb: crumb("订单", "go('orders')") };
    case "chat": return state.chat.activeId
      ? { title: (state.chat.contact && state.chat.contact.name) || "聊天", left: back("聊天", "A.closeChat()"), crumb: crumb("聊天", "A.closeChat()") }
      : { title: "聊天" };
    case "admin": return { title: "管理后台" };
    case "account": return { title: "我的" };
    case "notifs": return { title: "消息通知", left: back("我的", "go('account')"), crumb: crumb("我的", "go('account')"),
      right: state.notifs.unread ? `<button class="nav-btn" onclick="A.markAllNotifsRead()">全部已读</button>` : "" };
    case "staffLogs": {
      const u = userById(route.id);
      return { title: (u ? u.name : "") + "的打卡", left: back("管理", "go('admin')"), crumb: crumb("管理", "go('admin')") };
    }
    default: return { title: "订单" };
  }
}
const ICONS = {
  shirt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4 4.5 6.5 3 11l3 1.2V20h12v-7.8l3-1.2-1.5-4.5L15 4c-.6 1.3-1.7 2-3 2s-2.4-.7-3-2z"/></svg>`,
  orders: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8a2 2 0 0 1 2 2v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6a2 2 0 0 1 2-2z"/><path d="M9 3h6v3H9z"/><path d="M9.5 11h5M9.5 15h5"/></svg>`,
  chat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a7.5 7.5 0 0 1-7.5 7.5c-1.2 0-2.3-.25-3.3-.7L4.5 20l1.3-4.2A7.4 7.4 0 0 1 5 12a7.5 7.5 0 0 1 15 0z"/></svg>`,
  admin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 14a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V20a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H4a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H10a1.6 1.6 0 0 0 1-1.5V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V10a1.6 1.6 0 0 0 1.5 1H20a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg>`,
  account: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M12 8.5v7M8.5 12h7"/></svg>`,
  bell: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15.5V10a6 6 0 1 0-12 0v5.5L4.5 18h15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.2"/><path d="M12 7.4V12l3.1 1.9"/></svg>`,
  truck: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5h10v9H3z"/><path d="M13 11h4l3 3v2.5h-7z"/><circle cx="7" cy="17.5" r="1.7"/><circle cx="16.5" cy="17.5" r="1.7"/></svg>`,
  pulse: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12.5h3.6l2.3-5.6 3.4 10.2 2.5-6.1 1.6 1.5H21"/></svg>`
};
const badgeHtml = n => n ? `<span class="badge">${n > 99 ? "99+" : n}</span>` : "";
const chipHtml = (label, onDel) => `<span class="tag role">${esc(label)}${
  onDel ? ` <a href="javascript:void(0)" onclick="${onDel}" style="margin-left:4px">✕</a>` : ""}</span>`;
// 聊天用聊天未读，「我的」用通知未读
function tabBadgeOf(v) {
  if (v === "chat") return state.unread.total;
  if (v === "account" || v === "notifs") return state.notifs.unread;
  return 0;
}
function tabbarHtml() {
  const m = me();
  const tabs = [["orders", "订单", ICONS.orders], ["chat", "聊天", ICONS.chat]];
  if (m.template === "admin") tabs.push(["admin", "管理", ICONS.admin]);
  tabs.push(["account", "我的", ICONS.account]);
  const activeTab = route.v === "new" || route.v === "detail" ? "orders"
    : route.v === "staffLogs" ? "admin" : route.v === "notifs" ? "account" : route.v;
  return `<nav class="tabbar">${tabs.map(([v, label, icon]) => `
    <button class="tab ${activeTab === v ? "on" : ""}" data-tab="${v}" onclick="go('${v}')">
      <span class="ti">${icon}${badgeHtml(tabBadgeOf(v))}</span>
      <span>${label}</span></button>`).join("")}</nav>`;
}

function sidebarHtml() {
  const m = me();
  const groups = [
    ["总览", [["orders", "订单列表", ICONS.orders]]],
    ["业务", [["new", "新建订单", ICONS.plus], ["chat", "聊天", ICONS.chat]]],
    ["系统", [
      ...(m.template === "admin" ? [["admin", "管理后台", ICONS.admin]] : []),
      ["notifs", "消息通知", ICONS.bell],
      ["account", "我的", ICONS.account]
    ]]
  ];
  const active = route.v === "detail" ? "orders" : route.v === "staffLogs" ? "admin" : route.v;
  return `<aside class="dsidebar">
    <div class="ds-brand">
      <div class="ds-logo">${APP_LOGO}</div>
      <div class="ds-brand-txt"><div class="ds-co">${esc(COMPANY_NAME)}</div><div class="ds-app">${esc(APP_NAME)}</div></div>
    </div>
    <nav class="ds-nav">${groups.map(([title, items]) => `
      <div class="ds-group"><div class="ds-group-title">${esc(title)}</div>
        ${items.map(([v, label, icon]) => `<button class="ds-item ${active === v ? "on" : ""}" data-nav="${v}" onclick="go('${v}')">
          <span class="ds-ic">${icon}</span><span class="ds-label">${esc(label)}</span>${badgeHtml(tabBadgeOf(v))}</button>`).join("")}
      </div>`).join("")}</nav>
    <div class="ds-foot">
      ${avatarHtml(m.name, "sm")}
      <div class="ds-me"><div class="ds-me-name">${esc(m.name)}</div><div class="ds-me-role">${esc(roleLabelOf(m))}</div></div>
    </div></aside>`;
}

function deskHeaderHtml() {
  const n = state.notifs;
  return `<div class="dheader">
    <label class="dh-search"><span class="dh-sic">${ICONS.search}</span>
      <input class="dh-input" id="dh-kw" placeholder="搜索货号 / 款式名" value="${esc(filt.kw)}"
        oninput="A.setDeskKw(this.value)"></label>
    <div class="dh-actions">
      <button class="dh-icon" title="消息通知" onclick="A.toggleNotifPanel()">${ICONS.bell}${badgeHtml(n.unread)}</button>
      <div class="dh-user">${avatarHtml(me().name, "sm")}<span class="dh-uname">${esc(me().name)}</span></div>
    </div>
    ${n.open ? `<div class="notif-back" onclick="A.closeNotifPanel()"></div>
      <div class="notif-panel"><div class="np-head"><span>消息通知</span>
        <span class="np-acts">${(n.list || []).some(x => x.read) ? `<button class="btn plain" onclick="event.stopPropagation();A.clearReadNotifs()">清空已读</button>` : ""}
        <button class="btn plain" onclick="event.stopPropagation();A.markAllNotifsRead()">全部已读</button></span></div>
      <div class="np-list">${notifItemsHtml()}</div>
      <div class="np-foot"><button class="btn plain block" onclick="A.closeNotifPanel();go('notifs')">查看全部通知</button></div></div>` : ""}
  </div>`;
}

function render() {
  const app = $("app");
  if (showWelcome) { app.innerHTML = vWelcome(); return; }
  if (!me()) { app.innerHTML = vLogin(); return; }
  const meta = pageMeta();
  const views = { orders: vOrders, new: vNew, detail: vDetail, chat: vChat,
    admin: vAdmin, account: vAccount, staffLogs: vStaffLogs, notifs: vNotifs };
  app.innerHTML = `
    ${sidebarHtml()}${deskHeaderHtml()}
    ${route.v === "orders" ? `<div class="home-brand"><div class="co">${esc(COMPANY_NAME)}</div><div class="app">${esc(APP_NAME)}</div></div>` : ""}
    ${meta.crumb ? `<nav class="dbreadcrumb"><button class="dbc-link" onclick="${meta.crumb.fn}">${esc(meta.crumb.label)}</button><span class="dbc-sep">›</span><span class="dbc-current">${esc(meta.title)}</span></nav>` : ""}
    <header class="navbar"><div class="navbar-in">
      <div class="nav-slot">${meta.left || ""}</div>
      <h1 class="nav-title">${esc(meta.title)}</h1>
      <div class="nav-slot right">${meta.right || ""}</div>
    </div></header>
    ${tabbarHtml()}
    <main class="page${route.v === "chat" && state.chat.activeId ? " chat-full" : ""}" data-view="${route.v}">${
      (views[route.v] || vOrders)()}</main>`;
}
