"use strict";
// 请求服务端、刷新数据、本地缓存

async function api(method, path, body) {
  const headers = {};
  if (state.token) headers.Authorization = "Bearer " + state.token;
  const opts = { method, headers };
  if (body !== undefined) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const r = await fetch("/api" + path, opts);
  if (r.status === 401 && state.token) { A.forceLogout(); throw { error: "登录已失效，请重新登录" }; }
  let j = null; try { j = await r.json(); } catch (e) { }
  if (!r.ok) throw (j || { error: "请求失败" });
  return j;
}
async function refresh() {
  const b = await api("GET", "/bootstrap");
  state.me = b.me; state.users = b.users; state.fields = b.fields;
  state.factories = b.factories; state.orders = b.orders; state.roles = b.roles || [];
  state.seasons = b.seasons || [];
  saveStateCache();
}
// 本地缓存上次的数据，打开时先显示再后台刷新；跟 token 绑定
const STATE_CACHE_KEY = "daka_cache_v1";
function saveStateCache() {
  try {
    localStorage.setItem(STATE_CACHE_KEY, JSON.stringify({
      token: state.token, me: state.me, users: state.users, fields: state.fields,
      factories: state.factories, orders: state.orders, roles: state.roles, seasons: state.seasons
    }));
  } catch (e) { /* 存储满了/不可用就算了，不影响功能 */ }
}
function loadStateCache() {
  try {
    const c = JSON.parse(localStorage.getItem(STATE_CACHE_KEY) || "null");
    if (!c || c.token !== state.token) return;
    state.me = c.me; state.users = c.users; state.fields = c.fields;
    state.factories = c.factories; state.orders = c.orders; state.roles = c.roles; state.seasons = c.seasons;
  } catch (e) { /* 缓存损坏就忽略，走正常的网络加载 */ }
}

async function run(fn, okMsg) {
  try { await fn(); await refresh(); render(); if (okMsg) toast(okMsg); }
  catch (e) { toast((e && e.error) || "操作失败"); }
}
