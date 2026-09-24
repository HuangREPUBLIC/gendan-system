"use strict";
// 安装到手机主屏、系统推送（微信内置浏览器、未添加到主屏的 iOS 不支持推送）

let deferredInstall = null;  // 安卓/桌面 Chrome 的安装事件
// 手机/平板才提示「安装到手机」
const isMobileDevice = () => /iPhone|iPad|iPod|Android|Mobile|HarmonyOS/i.test(navigator.userAgent || "")
  || (navigator.maxTouchPoints > 1 && window.matchMedia && window.matchMedia("(pointer:coarse)").matches);
const isStandalone = () => (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
  || window.navigator.standalone === true;
const isIOSDevice = () => /iPhone|iPad|iPod/i.test(navigator.userAgent || "")
  || (/Mac/i.test(navigator.userAgent || "") && navigator.maxTouchPoints > 1);
// 系统推送状态；微信内置浏览器、未添加到主屏的 iOS 不支持
let pushState = { supported: false, permission: "default", on: false, devices: 0, checked: false };
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
// base64url 公钥 -> Uint8Array
function urlB64ToUint8Array(base64) {
  const pad = "=".repeat((4 - base64.length % 4) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
async function refreshPushState(rerender) {
  pushState.checked = true;
  pushState.supported = pushSupported();
  if (!pushState.supported) { if (rerender) render(); return; }
  pushState.permission = Notification.permission;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    pushState.on = !!sub && Notification.permission === "granted";
  } catch (e) { pushState.on = false; }
  if (rerender) render();
}

// App 内置浏览器大多不支持下载文件
function inAppBrowser() { return /MicroMessenger|wxwork|DingTalk|\bQQ\/|Lark|Feishu|AlipayClient|Weibo/i.test(navigator.userAgent || ""); }
const isIosStandalone = () => isIOSDevice() && isStandalone();
const canOfferInstall = () => isMobileDevice() && !isStandalone();

function pushSectionHtml() {
  const iosNeedsInstall = isIOSDevice() && !isStandalone();
  let body;
  if (iosNeedsInstall) {
    // iOS 只有从主屏图标打开才能收通知
    body = `<div class="row-item"><div class="row-main">
        <div class="row-label">需要先安装到手机</div>
        <div class="row-sub">iPhone 上只有从主屏幕图标打开，才能收到系统通知</div></div></div>
      <div class="btn-row"><button class="btn ghost block" onclick="A.install()">📲 安装到手机</button></div>`;
  } else if (!pushState.supported) {
    body = `<div class="row-item"><div class="row-main">
        <div class="row-label">当前浏览器不支持系统通知</div>
        <div class="row-sub">微信里打开的收不到通知，请用系统浏览器打开，或先安装到手机</div></div></div>`;
  } else if (pushState.permission === "denied") {
    body = `<div class="row-item"><div class="row-main">
        <div class="row-label">通知权限已被拒绝</div>
        <div class="row-sub">要到手机的「设置 → 通知」里，把本应用的通知重新打开</div></div></div>`;
  } else if (pushState.on) {
    body = `<div class="row-item"><div class="row-main">
        <div class="row-label">已开启</div></div>
        <span class="tag ok">开启中</span></div>
      <div class="btn-row"><button class="btn danger ghost" onclick="A.disablePush()">关闭通知</button></div>`;
  } else {
    body = `<div class="row-item"><div class="row-main">
        <div class="row-label">未开启</div></div></div>
      <div class="btn-row"><button class="btn block" onclick="A.enablePush()">开启消息通知</button></div>`;
  }
  return `<section class="group"><div class="group-title">消息通知</div>
    <div class="card">${body}</div></section>`;
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); deferredInstall = e;  // 等用户点「安装到手机」再弹
  if (state.me || !$("app").innerHTML) { /* 下次渲染时按钮自然出现 */ }
});
window.addEventListener("appinstalled", () => { deferredInstall = null; toast("已添加到手机主屏"); });

Object.assign(A, {
  async enablePush() {
    try {
      const perm = await Notification.requestPermission();
      pushState.permission = perm;
      if (perm !== "granted") { render(); return toast(perm === "denied" ? "已拒绝通知权限" : "没有开启通知"); }
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await api("GET", "/push/key");
      const sub = (await reg.pushManager.getSubscription())
        || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(publicKey) });
      const r = await api("POST", "/push/subscribe", { subscription: sub.toJSON() });
      pushState.on = true; pushState.devices = r.devices || 1;
      render();
      toast("已开启通知");
    } catch (e) {
      console.error(e);
      toast((e && e.error) || "开启失败，请换个浏览器或稍后再试");
    }
  },
  async disablePush() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api("POST", "/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe().catch(() => {});
      }
      pushState.on = false; render();
      toast("已关闭通知");
    } catch (e) { toast("关闭失败"); }
  },

  async install() {
    if (isStandalone()) return toast("已经是从主屏打开的了");
    if (deferredInstall) {
      deferredInstall.prompt();
      try { await deferredInstall.userChoice; } catch (e) {}
      deferredInstall = null;
      return;
    }
    A.installGuide();  // iOS 等给图文步骤
  },
  installGuide() {
    const ua = navigator.userAgent || "";
    const isIOS = /iPhone|iPad|iPod/i.test(ua);
    const isWeixin = /MicroMessenger/i.test(ua);
    let steps;
    if (isWeixin) {
      steps = `<div class="guide-step"><b>1.</b> 点右上角 <b>···</b> 菜单</div>
        <div class="guide-step"><b>2.</b> 选「在浏览器打开」（Safari 或 Chrome）</div>
        <div class="guide-step"><b>3.</b> 再按下面的步骤添加到主屏</div>
        <div class="guide-note">微信内置浏览器不能直接装，要先用系统浏览器打开</div>`;
    } else if (isIOS) {
      steps = `<div class="guide-step"><b>1.</b> 点底部中间的 <span class="ios-share"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 12v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-7"/></svg></span> 分享按钮
          （方框加向上箭头）</div>
        <div class="guide-step"><b>2.</b> 在菜单里找到 <b>「添加到主屏幕」</b></div>
        <div class="guide-step"><b>3.</b> 右上角点「添加」，桌面就出现图标了</div>`;
    } else {
      steps = `<div class="guide-step"><b>1.</b> 点浏览器右上角 <b>⋮</b> 菜单</div>
        <div class="guide-step"><b>2.</b> 选 <b>「安装应用」</b> 或「添加到主屏幕」</div>
        <div class="guide-step"><b>3.</b> 确认，桌面就出现图标了</div>`;
    }
    modal({ title: "装到手机主屏", html: `<div class="guide">${steps}</div>`,
      okText: "知道了", onOk: () => A.modalCancel() });
  },
});
