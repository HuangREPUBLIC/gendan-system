"use strict";
// 订单字段的表单控件：下拉、日期、多选工厂、季节标签

// 管理员添加/修改字段时可选的类型(同服务端 FIELD_TYPES)
const FIELD_TYPE_OPTIONS = [
  ["text", "文本"], ["textarea", "多行文本"], ["number", "数字"], ["date", "日期"],
  ["select", "下拉单选（自填选项）"], ["multiselect", "下拉多选（自填选项）"],
  ["user-staff", "选人：员工(不含主管)"], ["user-any", "选人：所有人"],
  ["user-sales", "选人：业务员"], ["user-follower", "选人：下厂员"],
  ["factory-prod", "选服装工厂"], ["factory-fabric", "选面料工厂（可多选）"], ["factory-emb", "选绣印工厂（可多选）"],
  ["log", "进度打卡（保留历史）"]
];
const fieldHasOptions = type => type === "select" || type === "multiselect";
// 人员下拉：值存用户 id，显示姓名
const USER_FIELD_PICK = {
  "user-staff": u => u.template !== "supervisor" && u.template !== "admin",
  "user-any": () => true,
  "user-sales": u => u.template === "sales",
  "user-follower": u => u.template === "follower"
};
const isUserField = f => !!USER_FIELD_PICK[f.type];

function optionsFor(f) {
  if (isUserField(f)) return state.users.filter(USER_FIELD_PICK[f.type]).map(u => [u.id, u.name]);
  if (f.type === "factory-fabric") return state.factories.fabric.map(x => [x, x]);
  if (f.type === "factory-emb") return state.factories.emb.map(x => [x, x]);
  if (f.type === "factory-prod") return state.factories.prod.map(x => [x, x]);
  if (fieldHasOptions(f.type)) return (f.options || []).map(x => [x, x]);
  return null;
}
function displayVal(o, f) {
  const v = (o.values || {})[f.k];
  if (v == null || v === "") return "";
  if (Array.isArray(v)) return v.length ? v.join("、") : "";
  if (isUserField(f)) return uname(v) || v;
  if (f.type === "date") return fmtDate(v);
  return v;
}
// 多选字段：值存数组，用标签+下拉逐个添加
const isMultiPick = f => f.type === "multiselect" || f.type === "factory-fabric" || f.type === "factory-emb";
const allFieldDefs = () => [...state.fields.order, ...state.fields.production];
const scalarFields = s => state.fields[s].filter(f => f.type !== "log");
function fieldInput(f, val, prefix) {
  prefix = prefix || "nf-";
  const id = prefix + f.k;
  if (isMultiPick(f)) return multiPickHtml(f, val, id);
  const opts = optionsFor(f);
  if (opts) {
    // 值不在下拉列表里(如导入的)也保留显示
    const isFactory = f.type === "factory-prod";
    const extra = (isFactory && val && !opts.some(([v]) => v === val)) ? [[val, val]] : [];
    return `<select class="in" id="${id}"><option value="">请选择</option>${[...extra, ...opts].map(([v, t]) =>
      `<option value="${esc(v)}" ${v === val ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
  }
  if (f.type === "textarea") return `<textarea class="in" id="${id}">${esc(val || "")}</textarea>`;
  if (f.type === "date") return dateFieldHtml(id, val);
  if (f.type === "number") return `<input class="in" type="number" inputmode="decimal" id="${id}" value="${esc(val || "")}">`;
  if (f.type === "image") return photoPicker("img");
  // 数量弹数字键盘；货号关掉自动大写和联想
  const kb = f.k === "qty" ? ` inputmode="numeric" pattern="[0-9,]*"`
    : f.k === "styleNo" ? ` autocapitalize="characters" autocorrect="off" spellcheck="false"` : "";
  return `<input class="in" id="${id}" value="${esc(val || "")}" autocomplete="off"${kb}>`;
}
const fieldRow = (f, val, prefix) => `<label class="field"><span>${esc(f.label)}</span>${fieldInput(f, val, prefix)}</label>`;

// 多选：面料/绣印工厂可挂多个供应商，自定义多选字段同理
function multiPickHtml(f, val, id) {
  const opts = optionsFor(f) || [];
  const arr = Array.isArray(val) ? val.slice() : (val ? [val] : []);
  const remaining = opts.filter(([v]) => !arr.includes(v));
  return `<div class="multifactory" data-id="${id}">
    <div class="multifactory-chips">${arr.length ? arr.map(v => chipHtml(v, `A.removeMultiPick('${id}','${encodeURIComponent(v)}')`)).join("")
      : `<span class="row-sub">未选择</span>`}</div>
    ${remaining.length ? `<div style="display:flex;gap:8px;margin-top:8px">
      <select class="in" id="${id}--add"><option value="">选择要添加的${f.type === "multiselect" ? "选项" : "工厂"}</option>${remaining.map(([v, t]) =>
        `<option value="${esc(v)}">${esc(t)}</option>`).join("")}</select>
      <button type="button" class="btn mini ghost" onclick="A.addMultiPick('${id}')">添加</button></div>` : ""}
    <input type="hidden" id="${id}" value='${esc(JSON.stringify(arr))}'></div>`;
}

// 原生日期框透明盖在中文按钮上直接接收点击(部分手机不支持 showPicker)
function dateFieldHtml(id, val, extraOnChange) {
  return `<div class="datefield">
    <button type="button" class="in date-btn ${val ? "" : "empty"}" id="${id}--label" tabindex="-1"
      >${val ? esc(fmtDate(val)) : "选择日期"}</button>
    <input type="date" id="${id}" class="date-native" value="${esc(val || "")}" autocomplete="off"
      onchange="${extraOnChange ? extraOnChange + ";" : ""}A.syncDateLabel('${id}')" onclick="A.openDate(this)" onfocus="A.openDate(this)"></div>`;
}

// 订单里用到但已被删掉的季节仍要显示
function seasonOptions(cur) {
  const list = (state.seasons || []).slice();
  state.orders.forEach(o => { if (o.season && !list.includes(o.season)) list.unshift(o.season); });
  if (cur && !list.includes(cur)) list.unshift(cur);
  return list;
}
// 季节四色轮换：按后台季节顺序取色；已删的季节按名字算固定颜色
function seasonTone(s) {
  let i = (state.seasons || []).indexOf(s);
  if (i < 0) i = [...String(s || "")].reduce((h, c) => h + c.charCodeAt(0), 0);
  return "s" + (i % 4);
}
function seasonTag(s, style) {
  return `<span class="tag season ${seasonTone(s)}"${style ? ` style="${style}"` : ""}>${esc(s)}</span>`;
}
function seasonSelectHtml(cur, prefix) {
  return `<select class="in" id="${(prefix || "nf-")}season"><option value="">请选择季节</option>${
    seasonOptions(cur).map(s => `<option ${s === cur ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>`;
}

Object.assign(A, {
  openDate(el) {
    // 点在日期数字上也强制弹选择器
    try { if (el.showPicker) el.showPicker(); } catch (e) { }
  },
  syncDateLabel(id) {
    const el = $(id), lab = $(id + "--label"); if (!el || !lab) return;
    lab.textContent = el.value ? fmtDate(el.value) : "选择日期";
    lab.classList.toggle("empty", !el.value);
  },

  syncFileName(id, name) {
    const el = $(id + "--name"); if (el) el.textContent = name || "未选择文件";
  },

  collectScalars(section, into) {
    for (const f of scalarFields(section)) {
      if (f.type === "image") { into[f.k] = photoDraft.img || []; continue; }
      const el = $("nf-" + f.k); if (!el) continue;
      if (isMultiPick(f)) { try { into[f.k] = JSON.parse(el.value || "[]"); } catch (e) { into[f.k] = []; } continue; }
      into[f.k] = el.value.trim();
    }
  },
  addMultiPick(id) {
    const sel = $(id + "--add"); if (!sel || !sel.value) return;
    const hidden = $(id); let arr = []; try { arr = JSON.parse(hidden.value || "[]"); } catch (e) { }
    if (!arr.includes(sel.value)) arr.push(sel.value);
    A.rerenderMultiPick(id, arr);
  },
  removeMultiPick(id, encVal) {
    const hidden = $(id); let arr = []; try { arr = JSON.parse(hidden.value || "[]"); } catch (e) { }
    arr = arr.filter(v => v !== decodeURIComponent(encVal));
    A.rerenderMultiPick(id, arr);
  },
  rerenderMultiPick(id, arr) {
    const container = document.querySelector(`.multifactory[data-id="${CSS.escape(id)}"]`); if (!container) return;
    const fKey = id.replace(/^(nf-|imp\d+-)/, "");
    const f = allFieldDefs().find(x => x.k === fKey);
    if (!f) return;
    container.outerHTML = multiPickHtml(f, arr, id);
  },
});
