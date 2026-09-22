"use strict";
// 管理后台：人员、权限、表单配置、数据（导出）

const PERM_LABELS = [
  ["editOrder",   "改「一、订单明细」",      "货号、款式、数量、交期、工厂这些字段"],
  ["editProd",    "改「二、生产明细」",      "指定下厂员、加工点、发货日期"],
  ["logOrder",    "在「一、订单明细」打卡",  "面料进度、绣印进度、产前样进度"],
  ["logProd",     "在「二、生产明细」打卡",  "裁剪、整烫、包装、本厂和加工点"],
  ["createOrder", "新建 / 导入订单",         ""],
  ["inspect",     "验货问题与整改",          ""]
];
const TEMPLATE_LABEL = { sales: "业务员", follower: "下厂员", supervisor: "主管" };

function adminPeopleHtml() {
  const roleCell = u => u.role === "admin"
    ? `<span class="tag role">管理员</span>`
    : `<select class="in tbl-select" onchange="A.changeRole('${u.id}',this.value)">
        ${state.roles.map(r => `<option value="${esc(r.k)}" ${u.role === r.k ? "selected" : ""}>${esc(r.label)}</option>`).join("")}</select>`;
  const kw = adminUserFilt.kw.trim().toLowerCase();
  const allStaff = state.users.filter(u => u.role !== "admin");
  const matched = kw ? allStaff.filter(u => u.name.toLowerCase().includes(kw)) : allStaff;
  const totalPages = Math.max(1, Math.ceil(matched.length / ADMIN_USERS_PAGE_SIZE));
  if (adminUserFilt.page > totalPages) adminUserFilt.page = totalPages;
  if (adminUserFilt.page < 1) adminUserFilt.page = 1;
  const pageStart = (adminUserFilt.page - 1) * ADMIN_USERS_PAGE_SIZE;
  const pageStaff = matched.slice(pageStart, pageStart + ADMIN_USERS_PAGE_SIZE);
  return `<section class="group a-users">
    <div class="group-title">员工账号 · 共 ${allStaff.length} 人</div>
    <div class="card"><div class="card-pad" style="padding-bottom:0">
      <input class="in" id="admin-user-kw" placeholder="搜索姓名" value="${esc(adminUserFilt.kw)}" oninput="A.setAdminUserKw(this.value)">
    </div><div class="tbl-wrap"><table class="tbl stack">
      <tr><th>姓名</th><th>手机号</th><th>职位</th><th>操作</th></tr>
      ${pageStaff.map(u => `<tr>
        <td style="white-space:nowrap">${esc(u.name)}${u.id === me().id ? ` <span class="tag">我</span>` : ""}</td>
        <td class="num">${esc(u.phone)}</td><td>${roleCell(u)}</td>
        <td style="white-space:nowrap"><button class="btn mini ghost" onclick="A.viewStaffLogs('${u.id}')">查看打卡</button>${
          u.role === "admin" ? "" : ` <button class="btn mini ghost" onclick="A.resetUserPw('${u.id}')">重置密码</button>
          <button class="btn mini danger ghost" onclick="A.deleteUser('${u.id}')">删除</button>`}</td></tr>`).join("")
        || `<tr><td colspan="4"><div class="empty">没有符合条件的员工</div></td></tr>`}
    </table></div>
    ${totalPages > 1 ? `<div class="card-pad" style="display:flex;align-items:center;justify-content:center;gap:14px">
      <button class="btn mini ghost" ${adminUserFilt.page <= 1 ? "disabled" : ""} onclick="A.setAdminUserPage(${adminUserFilt.page - 1})">‹ 上一页</button>
      <span class="row-sub num">第 ${adminUserFilt.page} / ${totalPages} 页</span>
      <button class="btn mini ghost" ${adminUserFilt.page >= totalPages ? "disabled" : ""} onclick="A.setAdminUserPage(${adminUserFilt.page + 1})">下一页 ›</button>
    </div>` : ""}
    </div>
  </section>

  <section class="group a-newuser">
    <div class="group-title">新增员工</div>
    <div class="card">
      <label class="field"><span>姓名</span><input class="in" id="nu-name"></label>
      <label class="field"><span>手机号</span><input class="in" id="nu-phone" inputmode="tel"></label>
      <label class="field"><span>职位</span><select class="in" id="nu-role">${
        state.roles.map(r => `<option value="${esc(r.k)}">${esc(r.label)}</option>`).join("")}</select></label>
      <label class="field"><span>初始密码</span><input class="in" id="nu-pass" value="123456"></label>
      <div class="btn-row"><button class="btn" onclick="A.addUser()">创建账号</button></div></div>
  </section>`;
}

function adminPermsHtml() {
  return `<section class="group a-roles">
    <div class="group-title">职位</div>
    <div class="card"><div class="card-pad">
      <div class="chip-wall">${state.roles.map(r => chipHtml(`${r.label} · ${TEMPLATE_LABEL[r.template] || "下厂员"}权限`,
        r.core ? "" : `A.delRole('${r.k}')`)).join("")}</div></div>
      <label class="field"><span>新职位名称</span><input class="in" id="nr-label" placeholder="例：跟单主管"></label>
      <label class="field"><span>权限模板</span><select class="in" id="nr-template">
        <option value="sales">业务员权限（管自己创建/负责的订单）</option>
        <option value="follower">下厂员权限（管自己被指派的订单）</option>
        <option value="supervisor">主管权限（管所有订单）</option></select></label>
      <div class="btn-row"><button class="btn" onclick="A.addRole()">添加职位</button></div></div>
  </section>

  <section class="group a-perms">
    <div class="group-title">权限配置</div>
    ${state.roles.map(r => {
      const p = permsOfRole(r);
      return `<div class="card" style="margin-top:12px">
        <div class="row-item" style="background:var(--bg)">
          <div class="row-main"><div class="row-label">${esc(r.label)}</div>
            <div class="row-sub">${TEMPLATE_LABEL[r.template] || "下厂员"}模板${r.perms ? " · 已自定义" : " · 默认权限"}</div></div>
          ${r.perms ? `<button class="btn mini ghost" onclick="A.resetRolePerms('${r.k}')">恢复默认</button>` : ""}
        </div>
        <label class="field"><span>看订单范围</span>
          <select class="in" onchange="A.setRolePerm('${r.k}','scope',this.value)">
            <option value="own" ${p.scope === "own" ? "selected" : ""}>只看自己相关的订单</option>
            <option value="all" ${p.scope === "all" ? "selected" : ""}>看全部订单</option></select></label>
        ${PERM_LABELS.map(([k, name, sub]) => `<label class="perm-row">
          <input type="checkbox" ${p[k] ? "checked" : ""} onchange="A.setRolePerm('${r.k}','${k}',this.checked)">
          <span class="perm-main"><span class="perm-name">${name}</span>${
            sub ? `<div class="perm-sub">${sub}</div>` : ""}</span></label>`).join("")}
      </div>`;
    }).join("")}
  </section>`;
}

// 字段类型下拉 + 下拉选项输入框，添加和修改字段共用；打卡字段不能和其它类型互转
function fieldTypeFormHtml(prefix, f) {
  const type = f ? f.type : "text";
  // 修改时保留当前类型，哪怕它不在常用列表里
  const choices = f && !FIELD_TYPE_CHOICES.includes(type) ? [...FIELD_TYPE_CHOICES, type] : FIELD_TYPE_CHOICES;
  const types = f ? choices.filter(v => (v === "log") === (type === "log")) : choices;
  return `<label class="field"><span>字段类型</span><select class="in" id="${prefix}-type" onchange="A.syncFieldOpts('${prefix}')">
      ${types.map(v => `<option value="${v}" ${v === type ? "selected" : ""}>${esc(FIELD_TYPE_LABEL[v] || v)}</option>`).join("")}</select></label>
    <label class="field" id="${prefix}-opts-wrap"${fieldHasOptions(type) ? "" : ` style="display:none"`}><span>下拉选项（逗号分隔）</span>
      <input class="in" id="${prefix}-opts" placeholder="例：选项A,选项B" value="${esc(f && f.options ? f.options.join(",") : "")}"></label>`;
}
// 字段位置：放在本板块哪个字段后面；修改时默认选当前位置
function fieldAfterHtml(prefix, section, f) {
  const list = state.fields[section].filter(x => x !== f);
  const i = f ? state.fields[section].indexOf(f) : -1;
  const cur = f ? (i > 0 ? state.fields[section][i - 1].k : "") : (list.length ? list[list.length - 1].k : "");
  return `<label class="field"><span>放在哪个字段后面</span><select class="in" id="${prefix}-after">
    <option value="" ${cur === "" ? "selected" : ""}>放在最前面</option>
    ${list.map(x => `<option value="${esc(x.k)}" ${x.k === cur ? "selected" : ""}>${esc(x.label)}</option>`).join("")}</select></label>`;
}
const readFieldOptions = (prefix, type) => fieldHasOptions(type)
  ? $(prefix + "-opts").value.split(/[,，、]/).map(s => s.trim()).filter(Boolean) : undefined;
// 核心字段只展示；其它字段点名字修改，点 ✕ 删除
const fieldChipHtml = (s, f) => f.core ? chipHtml(f.label, "")
  : `<span class="tag role"><a href="javascript:void(0)" onclick="A.editField('${s}','${f.k}')" title="点击修改名称、类型和位置">${esc(f.label)}</a>
    <a href="javascript:void(0)" onclick="A.delField('${s}','${f.k}')" style="margin-left:4px">✕</a></span>`;

function adminFormHtml() {
  return `<section class="group a-fields">
    <div class="group-title">自定义字段</div>
    <div class="card cf-split">
      <div class="cf-lists">${["order", "production"].map(s => `<div class="card-pad" style="padding-bottom:6px">
        <div class="row-sub" style="margin-bottom:6px">${s === "order" ? "一、订单明细" : "二、生产明细"}</div>
        <div class="chip-wall">${state.fields[s].map(f => fieldChipHtml(s, f)).join("")}</div></div>`).join("")}
        <div class="row-sub card-pad" style="padding-top:0">点字段名可以修改名称、类型和位置</div></div>
      <div class="cf-form">
      <label class="field"><span>添加到板块</span><select class="in" id="cf-sec" onchange="A.syncFieldAfter()"><option value="order">一、订单明细</option><option value="production">二、生产明细</option></select></label>
      <div id="cf-after-wrap">${fieldAfterHtml("cf", "order")}</div>
      <label class="field"><span>字段名称</span><input class="in" id="cf-label" placeholder="例：吊牌进度"></label>
      ${fieldTypeFormHtml("cf")}
      <div class="btn-row"><button class="btn" onclick="A.addField()">添加字段</button></div></div></div>
  </section>

  <section class="group a-factories">
    <div class="group-title">工厂下拉选项</div>
    <div class="card">${[["fabric", "面料工厂"], ["emb", "绣花/印花工厂"], ["prod", "服装工厂"]].map(([k, t]) => `
      <div class="card-pad" style="padding-bottom:10px">
        <div class="row-sub" style="margin-bottom:6px">${t}</div>
        <div class="chip-wall">${state.factories[k].map(x => chipHtml(x, `A.delFactory('${k}','${encodeURIComponent(x)}')`)).join("")}</div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <input class="in" id="fac-${k}" placeholder="新工厂名"><button class="btn mini ghost" onclick="A.addFactory('${k}')">添加</button></div></div>`).join("")}</div>
  </section>

  <section class="group a-seasons">
    <div class="group-title">季节</div>
    <div class="card"><div class="card-pad">
      <div class="chip-wall">${state.seasons.map(s => chipHtml(s, `A.delSeason('${encodeURIComponent(s)}')`)).join("")}</div></div>
      <label class="field"><span>新季节名称</span><input class="in" id="ns-name" placeholder="例：SS2029"></label>
      <div class="btn-row"><button class="btn" onclick="A.addSeason()">添加季节</button></div></div>
  </section>`;
}

function adminDataHtml() {
  return `<section class="group a-export">
    <div class="group-title">数据导出</div>
    <div class="card"><div class="card-pad">
      <p class="row-sub" style="margin:0 0 12px">导出订单全部内容（订单基本信息、生产进度、验货问题、跟单小结）为 Excel(.xlsx) 文件，照片直接嵌在表格里</p>
      <label class="field" style="padding-left:0;padding-right:0;border:0"><span>按季节筛选（可选）</span>
        <select class="in" id="exp-season"><option value="">全部季节</option>${
          seasonOptions("").map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}</select></label>
      <button class="btn" id="exp-btn" onclick="A.exportData()"><span class="btn-spin" aria-hidden="true"></span><span>导出订单数据</span></button>
      <p class="row-sub" style="margin:10px 0 0">文件会交给浏览器下载；在微信里打开本系统时无法下载，请先用浏览器打开</p></div></div>
  </section>`;
}

const ADMIN_TABS = [["people", "人员"], ["perms", "权限"], ["form", "表单配置"], ["data", "数据"]];
function vAdmin() {
  if (!isAdmin()) return `<div class="card"><div class="empty">仅管理员可访问</div></div>`;
  const body = adminTab === "perms" ? adminPermsHtml()
    : adminTab === "form" ? adminFormHtml()
    : adminTab === "data" ? adminDataHtml()
    : adminPeopleHtml();
  return `<nav class="subnav">${ADMIN_TABS.map(([k, label]) =>
    `<button class="${adminTab === k ? "on" : ""}" onclick="A.setAdminTab('${k}')">${label}</button>`).join("")}</nav>
  ${body}`;
}

Object.assign(A, {
  setAdminTab(t) { adminTab = t; render(); window.scrollTo(0, 0); },
  // 权限开关即改即存
  async setRolePerm(roleKey, key, value) {
    const r = state.roles.find(x => x.k === roleKey); if (!r) return;
    const perms = Object.assign({}, permsOfRole(r), r.perms || {});
    perms[key] = value;
    await run(() => api("PATCH", `/roles/${roleKey}/perms`, { perms }), "已保存");
  },
  async resetRolePerms(roleKey) {
    confirmDanger("恢复默认权限", "这个职位的权限将恢复成所属模板的默认配置。",
      () => run(() => api("PATCH", `/roles/${roleKey}/perms`, { perms: null }), "已恢复默认"), "恢复");
  },

  setAdminUserKw(v) { adminUserFilt.kw = v; adminUserFilt.page = 1; rerenderKeepFocus("admin-user-kw"); },
  setAdminUserPage(p) { adminUserFilt.page = p; render(); },

  async addUser() {
    const name = $("nu-name").value.trim(), phone = $("nu-phone").value.trim(),
      role = $("nu-role").value, password = $("nu-pass").value || "123456";
    if (!name || !phone) return toast("请填写姓名和手机号");
    await run(() => api("POST", "/users", { name, phone, role, password }), "账号已创建：" + name);
  },
  async changeRole(id, role) {
    const u = userById(id);
    await run(() => api("PATCH", "/users/" + id, { role }), `已把 ${u ? u.name : ""} 的职位改为${labelForRoleKey(role)}`);
  },
  deleteUser(id) {
    const u = userById(id); if (!u) return;
    confirmDanger(`删除员工「${u.name}」？`, "删除后该账号无法登录；历史打卡记录仍会保留。此操作不可恢复。",
      () => run(() => api("DELETE", "/users/" + id), "已删除员工：" + u.name));
  },
  resetUserPw(id) {
    const u = userById(id); if (!u) return;
    askText({ title: `为 ${u.name} 设置新密码`, value: "123456", okText: "重置" },
      password => run(() => api("POST", `/users/${id}/reset-password`, { password }), "密码已重置"));
  },
  async addRole() {
    const label = $("nr-label").value.trim(), template = $("nr-template").value;
    if (!label) return toast("请填写职位名称");
    await run(() => api("POST", "/roles", { label, template }), "职位已添加：" + label);
  },
  delRole(k) {
    const r = state.roles.find(x => x.k === k); if (!r) return;
    confirmDanger(`删除职位「${r.label}」？`, "只有没人担任该职位时才能删除。", () => run(() => api("DELETE", "/roles/" + k), "职位已删除"));
  },
  async addSeason() {
    const name = $("ns-name").value.trim();
    if (!name) return toast("请填写季节名称");
    await run(() => api("POST", "/seasons", { name }), "季节已添加：" + name);
  },
  delSeason(encName) {
    const name = decodeURIComponent(encName);
    confirmDanger(`删除季节「${name}」？`, "只有没有订单使用该季节时才能删除。", () => run(() => api("DELETE", "/seasons/" + encName), "季节已删除"));
  },
  syncFieldOpts(prefix) {
    $(prefix + "-opts-wrap").style.display = fieldHasOptions($(prefix + "-type").value) ? "" : "none";
  },
  syncFieldAfter() { $("cf-after-wrap").innerHTML = fieldAfterHtml("cf", $("cf-sec").value); },
  async addField() {
    const section = $("cf-sec").value, label = $("cf-label").value.trim(), type = $("cf-type").value, after = $("cf-after").value;
    if (!label) return toast("请填写字段名称");
    const options = readFieldOptions("cf", type);
    if (options && !options.length) return toast("请填写下拉选项");
    await run(() => api("POST", "/fields", { section, label, type, options, after }), "字段已添加：" + label);
  },
  editField(section, key) {
    const f = state.fields[section].find(x => x.k === key); if (!f) return;
    modal({ title: `修改字段「${f.label}」`, okText: "保存", keepOpenOnOk: true,
      html: `<label class="field"><span>字段名称</span><input class="in" id="ef-label" value="${esc(f.label)}"></label>
        ${fieldTypeFormHtml("ef", f)}
        ${fieldAfterHtml("ef", section, f)}
        <div class="row-sub">改成选人类型后，订单里已填的姓名会自动对应到员工。</div>`,
      onOk: async () => {
        const label = $("ef-label").value.trim(), type = $("ef-type").value, after = $("ef-after").value;
        if (!label) return toast("请填写字段名称");
        const options = readFieldOptions("ef", type);
        if (options && !options.length) return toast("请填写下拉选项");
        A.modalCancel();
        await run(() => api("PATCH", `/fields/${section}/${key}`, { label, type, options, after }), "字段已修改：" + label);
      } });
  },
  delField(section, key) {
    const f = state.fields[section].find(x => x.k === key); if (!f) return;
    confirmDanger(`删除字段「${f.label}」？`, "已填写的数据将不再显示。", () => run(() => api("DELETE", `/fields/${section}/${key}`), "字段已删除"));
  },
  async addFactory(kind) {
    const name = $("fac-" + kind).value.trim(); if (!name) return;
    await run(() => api("POST", "/factories", { kind, name }), "已添加");
  },
  async delFactory(kind, encName) { await run(() => api("DELETE", `/factories/${kind}/${encName}`), "已删除"); },

  // 导出：先取一次性下载链接，交给浏览器下载。
  // 微信等内置浏览器给指引和可复制链接；iPhone 主屏 App 交给 Safari；其它直接下载
  async exportData() {
    if (!isAdmin()) return toast("仅管理员可导出");
    if (A.exportData.busy) return;
    const btn = $("exp-btn");
    A.exportData.busy = true;
    if (btn) { btn.disabled = true; btn.classList.add("is-busy"); }
    try {
      const season = ($("exp-season") || {}).value || "";
      const t = await api("POST", "/export/ticket", { season });
      if (!t.count) return toast(season ? `「${season}」下没有订单` : "还没有订单可导出");
      const url = new URL(t.url, location.href).href;
      if (inAppBrowser()) {
        modal({ title: "请在浏览器里下载", okText: "复制下载链接",
          body: "微信等 App 里打不开下载。可以点右上角「···」选「在浏览器打开」后重新导出；或者复制下面的链接，粘贴到手机浏览器里打开（5 分钟内有效，只能用一次）。",
          onOk: () => copyText(url).then(ok => toast(ok ? "链接已复制，去浏览器里粘贴打开" : "复制失败，请用浏览器打开本系统后再导出")) });
      } else if (isIosStandalone()) {
        modal({ title: `导出 ${t.count} 单已准备好`, okText: "用 Safari 下载",
          body: "点下面的按钮会打开 Safari 下载文件，下载好后在「文件」App 的「下载」里能找到。",
          onOk: () => window.open(url, "_blank") });
      } else {
        const a = document.createElement("a");
        a.href = url; a.download = t.filename; a.rel = "noopener";
        document.body.appendChild(a); a.click(); a.remove();
        toast(`开始下载 ${t.count} 单，照片多时文件较大，请留意浏览器的下载提示`);
      }
    } catch (e) { toast((e && e.error) || "导出失败"); }
    finally {
      A.exportData.busy = false;
      const b2 = $("exp-btn"); if (b2) { b2.disabled = false; b2.classList.remove("is-busy"); }
    }
  },
});
