"use strict";
// 聊天

const avatarHtml = (name, cls) => `<span class="avatar ${cls || ""}">${esc((name || "?").slice(0, 1))}</span>`;
function contactsHtml() {
  const list = state.chat.contacts;
  if (!list.length) return `<div class="empty">还没有其他同事，先到「管理后台」创建员工账号</div>`;
  return list.map(c => `<div class="contact" onclick="A.openChat('${c.id}')">
    ${avatarHtml(c.name)}
    <div class="c-main">
      <div class="c-top"><b>${esc(c.name)}</b>
        ${c.last ? `<span class="c-time num">${fmtT(c.last.t)}</span>` : ""}</div>
      <div class="c-last">${c.last ? (c.last.fromMe ? "我：" : "") + esc(c.last.text) : "打个招呼吧"}</div>
    </div>
    ${badgeHtml(c.unread) || `<span class="chev">›</span>`}
  </div>`).join("");
}
function attachmentHtml(a, mine) {
  if (!a) return "";
  if (a.isImage) return `<img class="b-img" src="${esc(a.url)}" alt="${esc(a.name)}"
    data-gallery='${JSON.stringify([a.url])}' data-i="0" onclick="A.lightboxFromEl(this)">`;
  return `<a class="b-file" href="${esc(a.url)}" target="_blank" rel="noopener" download="${esc(a.name)}"
    style="${mine ? "color:#fff" : ""}"><span class="fi">📄</span>
    <span><span class="fn">${esc(a.name)}</span><br><span class="fs num">${fmtSize(a.size)}</span></span></a>`;
}
// 间隔超过 5 分钟才显示时间
function chatTimeLabel(t) {
  const d = new Date(t), n = new Date(), p = x => String(x).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.toDateString() === n.toDateString()) return hm;
  const y = d.getFullYear() === n.getFullYear() ? "" : d.getFullYear() + "年";
  return `${y}${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}
function messagesHtml() {
  const ms = state.chat.messages;
  if (!ms.length) return `<div class="empty" style="padding:30px 0">还没有聊天记录，发第一条消息吧</div>`;
  let lastT = 0;
  return ms.map(m => {
    let sep = "";
    if (m.t - lastT > 5 * 60 * 1000) sep = `<div class="day-sep">${chatTimeLabel(m.t)}</div>`;
    lastT = m.t;
    return sep + `<div class="bubble-row ${m.fromMe ? "mine" : ""}">
      ${m.fromMe ? "" : avatarHtml(state.chat.contact && state.chat.contact.name, "sm")}
      <div class="bubble" title="${esc(fmtT(m.t))}">${attachmentHtml(m.attachment, m.fromMe)}${m.text ? esc(m.text) : ""}</div></div>`;
  }).join("");
}
function vChat() {
  if (!state.chat.activeId) {
    return `<section class="group" style="margin-top:4px">
      <div class="card" id="chat-contacts">${contactsHtml()}</div></section>`;
  }
  const a = state.chat.att;
  return `<div class="chat-card">
    <div class="chat-msgs" id="chat-msgs">${messagesHtml()}</div>
    ${a ? `<div class="att-bar">${a.isImage ? "🖼" : "📄"} ${esc(a.name)} <span class="num" style="color:var(--ink-2)">${fmtSize(a.size)}</span>
      <span class="x" onclick="A.clearAtt()">✕</span></div>` : ""}
    <div class="chat-input">
      <input type="file" id="chat-file" style="display:none"
        accept=".jpg,.jpeg,.png,.gif,.webp,.heic,.pdf,.xlsx,.xls,.csv,.doc,.docx,.ppt,.pptx,.txt,.zip"
        onchange="A.pickAtt(this)">
      <button class="icon-btn" title="发送图片或文件" onclick="document.getElementById('chat-file').click()">＋</button>
      <textarea class="in" id="chat-text" rows="1" placeholder="输入消息…"
        oninput="A.onDraft(this.value)"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();A.sendMsg();}">${esc(state.chat.draft)}</textarea>
      <button class="btn chat-send" onclick="A.sendMsg()">发送</button>
    </div></div>`;
}

Object.assign(A, {
  async loadContacts(silent) {
    try {
      const list = await api("GET", "/chat/contacts");
      const changed = JSON.stringify(list) !== JSON.stringify(state.chat.contacts);
      state.chat.contacts = list;
      if (changed && !silent && route.v === "chat" && !state.chat.activeId) {
        const box = $("chat-contacts"); if (box) box.innerHTML = contactsHtml(); else render();
      }
    } catch (e) { }
  },
  async openChat(userId) {
    state.chat.activeId = userId; state.chat.messages = []; state.chat.contact = userById(userId) || null;
    state.chat.draft = ""; state.chat.att = null;
    render();
    await A.loadConversation();
    await A.refreshUnread();
  },
  closeChat() {
    state.chat.activeId = null; state.chat.messages = []; state.chat.contact = null;
    state.chat.draft = ""; state.chat.att = null;
    render(); A.loadContacts(true).then(render);
  },
  onDraft(v) { state.chat.draft = v; },
  async pickAtt(input) {
    const file = input.files && input.files[0]; if (!file) return;
    const fd = new FormData(); fd.append("file", file);
    toast("正在上传…");
    try {
      state.chat.att = await xhrUpload("/api/chat/upload", fd); input.value = ""; render();
      const box = $("chat-msgs"); if (box) box.scrollTop = box.scrollHeight;
      toast("附件已就绪，点发送");
    } catch (e) { toast((e && e.error) || "上传失败"); }
  },
  clearAtt() { state.chat.att = null; render(); },
  async loadConversation() {
    if (!state.chat.activeId) return;
    try {
      const r = await api("GET", "/chat/with/" + state.chat.activeId);
      const changed = JSON.stringify(r.messages) !== JSON.stringify(state.chat.messages);
      state.chat.contact = r.contact; state.chat.messages = r.messages;
      if (changed) {
        const box = $("chat-msgs");
        if (box) { box.innerHTML = messagesHtml(); box.scrollTop = box.scrollHeight; }
        else render();
      }
    } catch (e) { }
  },
  async sendMsg() {
    const el = $("chat-text"); if (!el) return;
    const text = (el.value || "").trim(), att = state.chat.att;
    if (!text && !att) return;
    el.value = ""; state.chat.draft = ""; state.chat.att = null;
    if (att) render();
    try {
      await api("POST", "/chat/with/" + state.chat.activeId, { text, attachment: att });
      await A.loadConversation();
      A.loadContacts(true);
    } catch (e) {
      const back = $("chat-text"); if (back) back.value = text;
      state.chat.draft = text; state.chat.att = att;
      toast((e && e.error) || "发送失败"); render();
    }
  },
  async refreshUnread() {
    try {
      const u = await api("GET", "/chat/unread");
      const changed = u.total !== state.unread.total;
      state.unread = u;
      if (changed && document.querySelector(".tabbar")) render();
    } catch (e) { }
  },
});
