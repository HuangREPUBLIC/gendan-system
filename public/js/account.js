"use strict";
// 「我的」页

function vAccount() {
  const m = me();
  return `<section class="group">
    <div class="card">
      <div class="card-pad" style="display:flex;align-items:center;gap:14px">
        ${avatarHtml(m.name)}
        <div><div style="font-size:19px;font-weight:600">${esc(m.name)}</div>
          <div class="row-sub">${esc(roleLabelOf(m))} · <span class="num">${esc(m.phone)}</span></div></div></div>
    </div></section>

  <section class="group">
    <div class="card"><div class="row-item tap" onclick="go('notifs')" role="button" tabindex="0">
      <div class="row-main"><div class="row-label">消息通知</div></div>
      ${badgeHtml(state.notifs.unread)}<span class="chev">›</span></div></div>
  </section>

  <section class="group">
    <div class="group-title">修改密码</div>
    <div class="card">
      <label class="field"><span>新密码</span><input class="in" type="password" id="my-p1" autocomplete="new-password"></label>
      <label class="field"><span>确认新密码</span><input class="in" type="password" id="my-p2" autocomplete="new-password"></label>
      <div class="btn-row"><button class="btn" onclick="A.changeMyPw()">确认修改</button></div></div>
  </section>

  <section class="group">
    <div class="group-title">我的打卡记录${state.myLogs ? ` · 共 ${state.myLogs.length} 条` : ""}</div>
    <div class="log-groups">${logListHtml(state.myLogs)}</div>
  </section>

  ${pushSectionHtml()}

  <section class="group">
    <div class="btn-row" style="padding-left:0;padding-right:0">
      ${canOfferInstall() ? `<button class="btn ghost block" style="margin-bottom:10px" onclick="A.install()">📲 安装到手机</button>` : ""}
      <button class="btn danger ghost block" onclick="A.logout()">退出登录</button></div>
  </section>`;
}

Object.assign(A, {
  async changeMyPw() {
    const p1 = $("my-p1").value, p2 = $("my-p2").value;
    if (!p1 || p1 !== p2) return toast("两次输入的新密码不一致");
    try { await api("POST", "/password/change", { newPassword: p1 }); $("my-p1").value = ""; $("my-p2").value = ""; toast("密码修改成功"); }
    catch (e) { toast((e && e.error) || "修改失败"); }
  },
});
