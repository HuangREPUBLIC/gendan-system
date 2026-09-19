"use strict";
// 通用小工具：DOM 取值、转义、日期和大小格式化、复制、提示条

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// 今年省略年份：7月20日 17:51
function fmtT(t) {
  const d = new Date(t), p = n => String(n).padStart(2, "0");
  const y = d.getFullYear() === new Date().getFullYear() ? "" : d.getFullYear() + "年";
  return `${y}${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 本地时区的今天(toISOString 是 UTC)
function todayStr() {
  const d = new Date(), p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 2026-08-15 -> 2026年8月15日
function fmtDate(v) {
  if (!v) return "";
  const m = String(v).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return v;
  return `${m[1]}年${+m[2]}月${+m[3]}日`;
}
function fmtSize(n) {
  if (!n && n !== 0) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

// clipboard 接口要求 https，否则退回 execCommand
async function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch (e) { }
  const ta = document.createElement("textarea");
  ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
  document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
  let ok = false; try { ok = document.execCommand("copy"); } catch (e) { }
  ta.remove(); return ok;
}
function toast(s, sticky) {
  const m = $("msg"); m.textContent = s; m.classList.add("show");
  clearTimeout(toast._t);
  if (!sticky) toast._t = setTimeout(() => m.classList.remove("show"), 2400);
}

function rerenderKeepFocus(inputId, redraw) {
  clearTimeout(rerenderKeepFocus.t);
  rerenderKeepFocus.t = setTimeout(() => {
    (redraw || render)();
    const inp = $(inputId);
    if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  }, 300);
}
