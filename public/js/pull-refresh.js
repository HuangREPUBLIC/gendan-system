"use strict";

// 页面顶部下拉刷新数据；单聊、大图、弹窗打开时不生效
(function setupPullRefresh() {
  const THRESHOLD = 62;
  let startY = null, dragging = false, dist = 0, refreshing = false;
  const canPull = () => !refreshing && me() && !modalState && !lightbox
    && !(route.v === "chat" && state.chat.activeId) && window.scrollY === 0;
  document.addEventListener("touchstart", (e) => {
    if (!canPull()) { startY = null; return; }
    startY = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (startY == null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || window.scrollY > 0) return;
    dragging = true; dist = dy;
  }, { passive: true });
  document.addEventListener("touchend", async () => {
    if (!dragging) { startY = null; return; }
    dragging = false; startY = null;
    if (dist < THRESHOLD) return;
    refreshing = true;
    try { await refresh(); render(); toast("已刷新"); } catch (e) { }
    refreshing = false;
  });
})();
