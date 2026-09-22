"use strict";
// 启动：挂到 window、处理从系统通知进来的跳转、boot

window.go = go; window.A = A;

// 从系统通知进来(?order= / ?chat= / ?notifs=)时直接跳转，并清掉参数
function openFromPush() {
  try {
    const q = new URLSearchParams(location.search);
    const order = q.get("order"), chat = q.get("chat"), notifs = q.get("notifs");
    if (!order && !chat && !notifs) return;
    history.replaceState(null, "", location.pathname);
    if (order) go("detail", order);
    else if (notifs) go("notifs");
    else if (chat) { go("chat"); A.openChat(chat); }
  } catch (e) {}
}

(async function boot() {
  // 已登录时先展示欢迎界面(index.html 里有静态的一份)，数据回来前不露出空页面
  if (state.token) {
    loadStateCache();  // 先用缓存数据填上
    showWelcome = true; render();
    const refreshP = refresh().catch(e => { state.token = null; localStorage.removeItem("daka_token"); showWelcome = false; });
    // 欢迎界面至少 1.5 秒，跟网络请求并行
    await Promise.all([refreshP, new Promise(r => setTimeout(r, 1500))]);
  }
  render();
  if (showWelcome) A.dismissWelcome();
  if (state.me) { A.refreshUnread(); A.refreshNotifUnread(); A.loadContacts(true); openFromPush(); }
  setInterval(() => { if (state.me) { A.refreshUnread(); A.refreshNotifUnread(); } }, 10000);
  setInterval(() => {
    if (!state.me) return;
    if (route.v === "chat") { if (state.chat.activeId) A.loadConversation(); else A.loadContacts(); }
  }, 4000);
})();
