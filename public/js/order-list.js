"use strict";
// 订单列表和筛选

function latestLog(o) {
  let best = null;
  for (const f of allFieldDefs().filter(f => f.type === "log")) for (const e of (o.logs[f.k] || [])) if (!best || e.t > best.t) best = { ...e, fieldLabel: f.label };
  for (const s of (o.subs || [])) for (const e of s.log) if (!best || e.t > best.t) best = { ...e, fieldLabel: s.name };
  return best;
}
const isRecent = l => !!l && (Date.now() - l.t) <= 7 * 24 * 60 * 60 * 1000;
// 概览卡片筛选条件显示成可取消的标签
function statFilterChip() {
  const label = filt.ship === "pending" ? "进行中（未填发货日期）"
    : filt.ship === "shipped" ? "已发货" : filt.recent ? "近7天有更新" : "";
  if (!label) return "";
  return ` <span class="tag filter-chip">${esc(label)}
    <a href="javascript:void(0)" onclick="A.setStatFilter('all')" title="取消筛选">✕</a></span>`;
}
function vOrders() {
  const factoriesOf = o => [o.values.factory, o.values.fabricFactory1, o.values.fabricFactory2, o.values.embFactory, o.values.printFactory].flat().filter(Boolean);
  // 概览卡片的数字跟随其它筛选条件
  const baseFiltered = state.orders.filter(o =>
    (!filt.season || o.season === filt.season) &&
    (!filt.sales || o.values.sales === filt.sales) &&
    (!filt.follower || o.values.follower === filt.follower) &&
    (!filt.kw || [o.values.styleNo, o.values.styleName, o.values.style]
      .join(" ").toLowerCase().includes(filt.kw.toLowerCase())) &&
    (!filt.factoryKw || factoriesOf(o).includes(filt.factoryKw))
  );
  const list = baseFiltered.filter(o =>
    (!filt.ship || (filt.ship === "shipped" ? !!o.values.shipDate : !o.values.shipDate)) &&
    (!filt.recent || isRecent(latestLog(o)))
  ).slice().sort((a, b) => b.createdAt - a.createdAt);
  const opt = (arr, cur) => arr.map(([v, t]) =>
    `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(t)}</option>`).join("");
  const allFactories = [...new Set([...state.factories.prod, ...state.factories.fabric, ...state.factories.emb])];
  const all = baseFiltered;
  const shipped = all.filter(o => o.values.shipDate).length;
  const recent = all.filter(o => isRecent(latestLog(o))).length;
  const pct = n => all.length ? Math.round(n / all.length * 100) + "%" : "—";
  const qtySum = arr => arr.reduce((t, o) => t + (parseFloat(String(o.values.qty || "").replace(/[,，\s]/g, "")) || 0), 0)
    .toLocaleString("zh-CN");
  // 点卡片按条件筛选，再点取消
  const statActive = k => k === "all" ? (!filt.ship && !filt.recent)
    : k === "recent" ? !!filt.recent : filt.ship === k;
  const statCard = (key, label, value, sub, icon, tone) => `<button type="button"
    class="dstat${statActive(key) ? " on" : ""}" onclick="A.setStatFilter('${key}')"
    aria-pressed="${statActive(key)}" title="点击筛选出这些订单">
    <span class="dstat-ic ${tone || ""}">${icon}</span>
    <div class="dstat-main"><div class="dstat-label">${esc(label)}</div>
      <div class="dstat-num num">${esc(String(value))}</div>
      <div class="dstat-sub">${esc(sub)}</div></div></button>`;
  return `<section class="group dstats-wrap"><div class="dstats">
      ${statCard("all", "订单总数", all.length, "合计数量 " + qtySum(all) + " 件", ICONS.orders)}
      ${statCard("pending", "进行中", all.length - shipped, "尚未填写发货日期", ICONS.clock, "warn")}
      ${statCard("shipped", "已发货", shipped, "占 " + pct(shipped), ICONS.truck, "ok")}
      ${statCard("recent", "近7天有更新", recent, "占 " + pct(recent), ICONS.pulse, "sky")}
    </div></section>
  <section class="group">
    <div class="card"><div class="filters">
      <input class="in f-kw" id="flt-kw" type="search" enterkeyhint="search" autocomplete="off" placeholder="搜货号 / 款式名" value="${esc(filt.kw)}" oninput="A.setFKw(this.value)">
      <div class="f-chips">
      <select class="in${filt.season ? " on" : ""}" aria-label="按季节筛选" onchange="A.setF('season',this.value)"><option value="">全部季节</option>${opt(seasonOptions("").map(s => [s, s]), filt.season)}</select>
      <select class="in${filt.sales ? " on" : ""}" aria-label="按业务员筛选" onchange="A.setF('sales',this.value)"><option value="">全部业务员</option>${opt(state.users.filter(u => u.template === "sales").map(u => [u.id, u.name]), filt.sales)}</select>
      <select class="in${filt.follower ? " on" : ""}" aria-label="按下厂员筛选" onchange="A.setF('follower',this.value)"><option value="">全部下厂员</option>${opt(state.users.filter(u => u.template === "follower").map(u => [u.id, u.name]), filt.follower)}</select>
      <select class="in${filt.factoryKw ? " on" : ""}" aria-label="按工厂筛选" onchange="A.setF('factoryKw',this.value)"><option value="">全部工厂</option>${opt(allFactories.map(x => [x, x]), filt.factoryKw)}</select>
      </div>
    </div></div></section>
  <section class="group">
    <div class="group-title">订单列表 · 共 ${list.length} 单 · ${qtySum(list)} 件${statFilterChip()}</div>
    <div class="card olist">${list.map(o => {
      const latest = latestLog(o);
      return `<div class="ocard" onclick="go('detail','${o.id}')" role="button" tabindex="0" onkeydown="if(event.key==='Enter')go('detail','${o.id}')">
        <div class="thumb">${coverImgHtml(normalizePhotos(o.values.img)) || `<span class="thumb-ph" aria-label="暂无款式图">${ICONS.shirt}</span>`}</div>
        <div class="o-main">
          <div class="o-title">${seasonTag(o.season)}${esc(o.values.styleNo || "")} ${esc([o.values.styleName, o.values.style].filter(Boolean).join(" "))}</div>
          <div class="o-meta"><span>业务员 ${esc(uname(o.values.sales)) || "—"}</span><span>下厂员 ${esc(uname(o.values.follower)) || "未指定"}</span>
            <span class="num">数量 ${esc(o.values.qty || "-")}</span><span>交期 ${esc(fmtDate(o.values.deadline)) || "-"}</span></div>
          ${isRecent(latest)
            ? `<div class="o-latest">最新：${esc(latest.fieldLabel)} · ${esc(latest.text)} <span class="num">(${fmtT(latest.t)})</span></div>` : ""}
        </div><span class="chev">›</span></div>`;
    }).join("") || `<div class="empty">${state.orders.length ? "没有符合条件的订单" : "还没有订单，点右上角 ＋ 新建"}</div>`}</div>
  </section>`;
}

Object.assign(A, {
  setF(k, v) { filt[k] = v; render(); },
  // 不在订单页时先跳回订单页
  setStatFilter(kind) {
    const already = kind === "recent" ? filt.recent : filt.ship === kind;
    if (kind === "all" || already) { filt.ship = ""; filt.recent = false; }
    else if (kind === "recent") { filt.ship = ""; filt.recent = true; }
    else { filt.ship = kind; filt.recent = false; }
    if (route.v !== "orders") go("orders"); else { render(); window.scrollTo(0, 0); }
  },
  // 桌面顶部搜索与列表共用 filt.kw
  setDeskKw(v) { filt.kw = v; rerenderKeepFocus("dh-kw", () => { if (route.v !== "orders") go("orders"); else render(); }); },

  setFKw(v) { filt.kw = v; rerenderKeepFocus("flt-kw"); },
});
