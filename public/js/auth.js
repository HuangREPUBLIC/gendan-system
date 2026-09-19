"use strict";
// 登录页、欢迎页、退出登录

const brandHtml = () => `<div class="login-brand">
      <div class="login-logo">${APP_LOGO}</div>
      <p class="login-company">${esc(COMPANY_NAME)}</p>
      <h1 class="login-title">${esc(APP_NAME)}</h1>
    </div>`;
function vLogin() {
  return `<div class="login-page"><div class="login-inner">
    ${brandHtml()}
    <div class="login-card">
      <label class="lg-field"><span>手机号</span>
        <input id="lg-phone" inputmode="tel" autocomplete="username" placeholder="请输入手机号"></label>
      <label class="lg-field"><span>密码</span>
        <input id="lg-pass" type="password" autocomplete="current-password" placeholder="请输入密码"
          onkeydown="if(event.key==='Enter')A.login()"></label>
    </div>
    <button class="btn block login-btn" onclick="A.login()">登 录</button>
    ${canOfferInstall() ? `<button class="btn ghost block install-cta" onclick="A.install()">📲 安装到手机（像 App 一样用）</button>` : ""}
  </div></div>`;
}

function vWelcome() {
  return `<div class="login-page" onclick="A.dismissWelcome()"><div class="login-inner">${brandHtml()}</div></div>`;
}

Object.assign(A, {
  async login() {
    const phone = $("lg-phone").value.trim(), password = $("lg-pass").value;
    try {
      const r = await api("POST", "/login", { phone, password });
      state.token = r.token; localStorage.setItem("daka_token", r.token);
      showWelcome = true; render();  // 先顶上欢迎界面，不等 bootstrap
      await Promise.all([refresh(), new Promise(res => setTimeout(res, 1500))]);
      go("orders");
      A.dismissWelcome();
      A.refreshUnread(); A.refreshNotifUnread();
    } catch (e) {
      // 只有 bootstrap 失败才收回欢迎界面；密码错误不重画，免得清空输入
      if (showWelcome) { showWelcome = false; render(); }
      toast((e && e.error) || "登录失败");
    }
  },
  dismissWelcome() {
    if (!showWelcome) return;
    showWelcome = false; render();
  },

  logout() {
    confirmDanger("退出登录？", "下次需要重新输入手机号和密码。", () => A.forceLogout(), "退出");
  },
  forceLogout() {
    state.token = null; state.me = null; localStorage.removeItem("daka_token"); localStorage.removeItem(STATE_CACHE_KEY);
    route = { v: "orders", id: null }; render();
  },
});
