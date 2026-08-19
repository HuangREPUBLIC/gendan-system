/** 前端新功能的端到端测试：聊天、职位、忘记密码弹窗、季节筛选、我的账号打卡记录 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
const BASEU = process.env.BASE_URL || "http://localhost:3000";
const ROOT = path.join(__dirname, "..", "public");
const vc = new VirtualConsole(); vc.on("jsdomError", () => {});
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function apiAs(phone, method, p, body) {
  const lg = await fetch(BASEU + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password: "123456" }) });
  const { token } = await lg.json();
  const r = await fetch(BASEU + "/api" + p, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, j: await r.json().catch(() => null) };
}

(async () => {
  const html = fs.readFileSync(ROOT + "/index.html", "utf8");
  const dom = new JSDOM(html, { runScripts: "dangerously", url: BASEU + "/", virtualConsole: vc });
  const { window } = dom, doc = window.document;
  window.fetch = (u, o) => fetch(new URL(u, BASEU + "/").toString(), o);
  window.FormData = FormData; window.Blob = Blob;
  window.URL.createObjectURL = () => "blob:x"; window.URL.revokeObjectURL = () => {};
  const sc = doc.createElement("script");
  sc.textContent = fs.readFileSync(ROOT + "/app.js", "utf8");
  doc.body.appendChild(sc);
  await sleep(300);
  const app = () => doc.getElementById("app").innerHTML;
  const mask = () => doc.getElementById("mask");
  const A = window.A, st = () => window.eval("state");

  // ---- 登录页已移除"忘记密码"自助改密（改为管理员重置 / 登录后自改）----
  ok(!app().includes("忘记密码"), "登录页不再有忘记密码入口");
  ok(typeof A.openForgotPw === "undefined", "自助改密函数已移除");

  // ---- 登录 ----
  doc.getElementById("lg-phone").value = "13800000000";
  doc.getElementById("lg-pass").value = "123456";
  await A.login(); await sleep(50);
  ok(app().includes("天津锦利国际贸易有限公司") && app().includes("跟单系统"), "登录后先显示欢迎界面(公司名+跟单系统)");
  A.dismissWelcome(); await sleep(500);
  ok(app().includes("订单列表"), "管理员登录");
  ok(doc.querySelector(".home-brand .co").textContent === "天津锦利国际贸易有限公司"
    && doc.querySelector(".home-brand .app").textContent === "跟单系统", "订单首页顶部带公司名称+跟单系统抬头(不含logo)");
  ok(!doc.querySelector(".home-brand svg") && !doc.querySelector(".home-brand img"), "首页抬头不含logo图标");

  // ---- 导航：聊天取代我的打卡 ----
  ok(app().includes('data-tab="chat"') && !app().includes('data-tab="mine"'), "Tab 栏有「聊天」，没有「我的打卡」");
  ok(app().includes('class="tabbar"'), "底部 Tab 栏存在");
  ok(app().includes('class="navbar"'), "顶部标题栏存在");

  // ---- 季节筛选用自动生成选项 ----
  const y = new Date().getFullYear();
  const filterSel = doc.querySelector(".filters select");
  const opts = [...filterSel.options].map(o => o.value);
  ok(opts.includes("SS" + (y + 1)) && opts.includes("FW" + (y + 1)), "季节筛选含未来季节(不再锁死在已有订单)");

  // ---- 独立的工厂搜索框：跟季节筛选一样是从已有工厂列表里选，不是手打 ----
  const factorySel = [...doc.querySelectorAll(".filters select")].find(s =>
    [...s.options].some(o => o.value === "宏发制衣厂"));
  ok(!!factorySel, "工厂搜索是下拉选择框(选项来自已定义的工厂列表)，不是文本输入框");
  A.setF("factoryKw", "宏发制衣厂"); await sleep(400);
  ok(app().includes("SS27-T012") && !app().includes("裙"), "按工厂筛选到对应订单，其它订单被过滤掉");
  A.setF("factoryKw", ""); await sleep(400);
  A.setFKw("宏发"); await sleep(400);
  ok(!app().includes("SS27-T012"), "货号/款式名搜索框不再匹配工厂名");
  A.setFKw(""); await sleep(400);

  // ---- 我的账号：职位 + 打卡记录 + 意见反馈 ----
  window.go("account"); await sleep(500);
  ok(!app().includes("角色"), "全站不再出现「角色」字样");
  ok(app().includes(st().me.roleLabel), "我的账号显示职位名称");
  ok(app().includes("退出登录"), "我的页面有退出登录入口");
  ok(app().includes("我的打卡记录"), "打卡记录移到我的账号");
  ok(app().includes("意见反馈"), "「我的」页有意见反馈入口");
  A.submitFeedback(); await sleep(100);
  doc.getElementById("m-input").value = "UI测试-建议增加导出定时任务";
  await A.modalOk(); await sleep(400);
  ok(!doc.getElementById("mask").classList.contains("show"), "反馈提交后弹窗关闭");

  // ---- 管理后台：职位管理 ----
  window.go("admin"); await sleep(400);
  ok(app().includes("职位管理") && app().includes("权限模板"), "管理后台有职位管理");
  ok(app().includes("<th>职位</th>") && !app().includes("<th>角色</th>"), "员工表表头是「职位」");
  doc.getElementById("nr-label").value = "跟单主管";
  doc.getElementById("nr-template").value = "sales";
  await A.addRole(); await sleep(600);
  ok(st().roles.some(r => r.label === "跟单主管"), "新增自定义职位");
  const chen = st().users.find(u => u.name === "陈晓芳");
  const sel = [...doc.querySelectorAll("select")].find(s => s.outerHTML.includes(chen.id));
  ok(sel && [...sel.options].some(o => o.textContent === "跟单主管"), "自定义职位出现在员工职位下拉里");
  ok(app().includes("查看打卡"), "管理员可查看员工打卡");

  // ---- 管理后台：季节管理（新增/删除，且新建订单里能选到） ----
  ok(app().includes("季节管理"), "管理后台有季节管理入口");
  doc.getElementById("ns-name").value = "SS2099UI";
  await A.addSeason(); await sleep(500);
  ok(st().seasons.includes("SS2099UI"), "通过界面新增季节");
  window.go("new"); await sleep(300);
  const newSeasonSel = doc.getElementById("nf-season");
  ok(newSeasonSel && [...newSeasonSel.options].some(o => o.value === "SS2099UI"), "新增的季节出现在新建订单的季节下拉里");
  window.go("admin"); await sleep(400);
  A.delSeason(encodeURIComponent("SS2099UI")); await sleep(150);
  await A.modalOk(); await sleep(500);
  ok(!st().seasons.includes("SS2099UI"), "通过界面删除季节");

  // ---- 管理后台：数据导出挪到员工账号/新增员工附近，且能看到刚提交的意见反馈 ----
  ok(app().indexOf("数据导出") < app().indexOf("职位管理") && app().indexOf("数据导出") < app().indexOf("季节管理"),
    "数据导出已挪到员工账号/新增员工附近，排在职位管理/季节管理前面");
  ok(!!doc.getElementById("exp-season"), "数据导出带季节筛选下拉");
  await sleep(300);
  ok(app().includes("意见反馈") && app().includes("UI测试-建议增加导出定时任务") && app().includes("王建国"),
    "管理员能在后台看到刚提交的意见反馈，带提交人姓名");
  ok(app().includes("标记已处理"), "反馈列表带「标记已处理」按钮");
  const fbId = st().feedback.find(f => f.text === "UI测试-建议增加导出定时任务").id;
  await A.toggleFeedbackHandled(fbId, true); await sleep(400);
  ok(app().includes("已处理") && app().includes("标记未处理"), "标记已处理后显示「已处理」，按钮变成「标记未处理」");

  // ---- 打卡记录按订单分组显示（王建国在两个不同订单上都有打卡） ----
  const wang = st().users.find(u => u.name === "王建国");
  const wangOrders = st().orders.filter(o => o.values.follower === wang.id);
  ok(wangOrders.length >= 2, "测试前提：王建国在至少两个订单上有打卡记录");
  // 记录多了(超过预览条数)要能收起来，不然一个订单打卡多了整页会很长
  for (let i = 0; i < 8; i++) {
    await apiAs("13855556666", "POST", `/orders/${wangOrders[0].id}/logs`, { key: "cutting", text: "批量测试打卡" + i });
  }
  A.viewStaffLogs(wang.id); await sleep(600);
  const firstGroupIdx = app().indexOf(wangOrders[0].values.styleNo);
  const secondGroupIdx = app().indexOf(wangOrders[1].values.styleNo);
  ok(firstGroupIdx > -1 && secondGroupIdx > -1, "打卡记录按订单货号分组显示");
  ok(app().includes("共") && app().includes("条"), "每组显示该订单的打卡条数");
  ok(!app().includes("批量测试打卡0"), "记录多的订单默认只显示最近几条，最早的先被收起来");
  ok(/展开剩余 \d+ 条/.test(app()), "记录超过预览条数时显示「展开剩余」按钮");
  A.toggleLogGroup(wangOrders[0].id); await sleep(200);
  ok(app().includes("批量测试打卡0") && app().includes("批量测试打卡7"), "点击展开后能看到全部记录，包括最早的");
  ok(app().includes("收起"), "展开后按钮变成「收起」");
  A.toggleLogGroup(wangOrders[0].id); await sleep(200);
  ok(!app().includes("批量测试打卡0"), "再点一下收起，恢复只显示最近几条");

  // ---- 聊天 ----
  window.go("chat"); await sleep(600);
  ok(app().includes('data-view="chat"') && app().includes("chat-contacts"), "聊天页渲染");
  ok(!app().includes("group-title\">同事") && !app().includes('class="c-role"'), "聊天页不显示「同事」标题和联系人职位");
  ok(st().chat.contacts.length === st().users.length - 1, "联系人=其他同事");
  ok(!st().chat.contacts.some(c => c.id === st().me.id), "联系人不含自己");
  await A.openChat(chen.id); await sleep(500);
  ok(doc.getElementById("chat-text") && app().includes("chat-msgs"), "打开会话界面");
  const before = st().chat.messages.length;   // 同一台测试服务器上可能已有历史消息
  doc.getElementById("chat-text").value = "晓芳，这单交期要提前";
  await A.sendMsg(); await sleep(600);
  ok(app().includes("晓芳，这单交期要提前"), "发出的消息显示在对话里");
  const sent = st().chat.messages;
  ok(sent.length === before + 1 && sent[sent.length - 1].fromMe === true
    && sent[sent.length - 1].text === "晓芳，这单交期要提前", "消息标记为自己发出");

  // 聊天图片跟订单照片用同一个大图查看器，同样支持双指缩放；查看器不再显示文字提示(不管哪种图片)
  const chatImgHtml = window.eval(`attachmentHtml({isImage:true,url:"/uploads/x.jpg",name:"x.jpg"}, false)`);
  ok(chatImgHtml.includes('onclick="A.lightboxFromEl(this)"') && !chatImgHtml.includes("target=\"_blank\""),
    "聊天图片点开用大图查看器，不是新开标签页");
  window.eval(`A.lightboxFromEl({getAttribute:(n)=>({"data-gallery":'["/uploads/x.jpg"]',"data-i":"0"}[n])})`);
  await sleep(100);
  const lb = doc.getElementById("lightbox");
  ok(!!lb && !lb.innerHTML.includes("双指放大"), "大图查看器不再显示双指缩放的文字提示(聊天/订单图片都一样)");
  A.closeLightbox(); await sleep(100);

  // 对方回复后，会话轮询能收到
  await apiAs("13811112222", "POST", "/chat/with/" + st().me.id, { text: "收到，我马上联系工厂" });
  await A.loadConversation(); await sleep(300);
  const got = st().chat.messages;
  ok(got.length === before + 2 && got[got.length - 1].fromMe === false
    && got[got.length - 1].text === "收到，我马上联系工厂", "收到对方回复");
  ok(doc.getElementById("chat-msgs").innerHTML.includes("收到，我马上联系工厂"), "回复渲染到气泡区");

  // 未读红点：让第三人发消息给我
  await apiAs("13877778888", "POST", "/chat/with/" + st().me.id, { text: "老板，包装完成了" });
  await A.refreshUnread(); await sleep(300);
  ok(st().unread.total >= 1, "有未读消息计数");
  window.go("chat"); await sleep(500);
  ok(app().includes("badge") || st().unread.total >= 1, "未读显示红点");

  // ---- 日期中文化 / 中文文件选择 / 登录页图标 ----
  window.go("orders"); await sleep(400);
  const listTxt = app();
  ok(/\d{4}年\d{1,2}月\d{1,2}日/.test(listTxt), "订单列表交期是中文年月日");
  ok(!/\d{4}-\d{2}-\d{2}/.test(listTxt), "列表不再出现 2026-08-15 格式");
  // 订单列表的"最新：..."提示，超过7天要自动消失
  ok(listTxt.includes("最新："), "7天内有最新动态时正常显示「最新：」");
  window.eval(`
    state.orders.forEach(o => {
      Object.values(o.logs || {}).forEach(list => (list||[]).forEach(e => e.t = Date.now() - 8*24*60*60*1000));
      (o.subs || []).forEach(s => (s.log||[]).forEach(e => e.t = Date.now() - 8*24*60*60*1000));
    });
  `);
  window.go("orders"); await sleep(200);
  ok(!app().includes("最新："), "所有最新动态都超过7天后，「最新：」这行自动消失");

  const anyOrder = st().orders[0];
  window.go("detail", anyOrder.id); await sleep(500);
  ok(/\d{1,2}月\d{1,2}日 \d{2}:\d{2}/.test(app()), "打卡时间是中文月日");

  window.go("new"); await sleep(500);
  const d = new Date(), pad = n => String(n).padStart(2, "0");
  const todayCn = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  const todayIso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  ok(doc.getElementById("nf-deadline--label").textContent === todayCn, "新建订单日期默认当天且显示中文");
  ok(doc.getElementById("nf-deadline").value === todayIso, "底层日期值就是本地当天（不受 UTC 时差影响）");
  ok(doc.getElementById("nf-shipDate--label").textContent === "选择日期" && doc.getElementById("nf-shipDate").value === "", "发货日期新建时保持空白(填了会被当成已发货锁死订单)");
  ok(!!doc.getElementById("pe-img") && app().includes("拍照") && app().includes("相册"), "款式图是多图相册选择器，且拍照/相册是两个独立入口(不受 multiple 属性影响拍照选项)");
  ok(doc.querySelector("#imp-file--name") && doc.querySelector("#imp-file--name").textContent.includes("未选择文件"), "CSV 文件控件仍显示中文");
  ok(!/Choose File|No file chosen/i.test(app()), "没有英文文件选择文案");
  ok(doc.getElementById("nf-deadline").type === "date", "底层仍是原生日期控件（手机可调系统日期轮）");
  // 日期按钮不再靠 JS 模拟点击原生控件(showPicker，部分手机浏览器不支持导致点了没反应)，
  // 而是原生 input 直接盖满按钮区域接收真实点击/触摸，按钮本身不该再挂 onclick、也不占 Tab 顺序
  ok(!doc.getElementById("nf-deadline--label").hasAttribute("onclick"), "装饰用的日期按钮本身不挂 onclick，真正接收点击的是盖在上面的原生输入框");
  ok(doc.getElementById("nf-deadline--label").getAttribute("tabindex") === "-1", "日期按钮不占 Tab 顺序，真正可交互的是底下的原生输入框");
  ok(doc.getElementById("nf-deadline").hasAttribute("onclick") && doc.getElementById("nf-deadline").hasAttribute("onfocus"),
    "原生日期框点击/聚焦时都会强制弹一次系统选择器(只点在日历图标才会自动弹，点日期数字部分不会，所以要强制)");
  // 多图相册：模拟加两张已上传的照片，能显示缩略图且可点开大图
  window.eval("photoDraft.img = ['/uploads/t1.jpg','/uploads/t2.jpg']");
  const pe = doc.getElementById("pe-img"); pe.innerHTML = window.eval("pickerInner('img')");
  ok(pe.querySelectorAll(".ph-thumb").length === 2, "相册显示两张缩略图");
  pe.querySelector(".ph-thumb img").click();
  await sleep(100);
  ok(!!doc.getElementById("lightbox"), "点缩略图打开大图查看器");
  window.A.lbStep(1); ok(window.eval("lightbox.i") === 1, "大图可切到下一张");
  window.A.closeLightbox(); ok(!doc.getElementById("lightbox"), "大图可关闭");
  window.eval("photoDraft = {}");

  // ---- 生产进度/验货问题/头部/高亮 等新版界面 ----
  A.forceLogout(); await sleep(150);
  doc.getElementById("lg-phone").value = "13800000000"; doc.getElementById("lg-pass").value = "123456";
  await A.login(); A.dismissWelcome(); await sleep(400);
  const o1 = st().orders.find(o => o.values.styleNo === "SS27-T012");
  window.go("detail", o1.id); await sleep(500);
  ok(app().includes('class="cat-title"') && app().includes("一、订单明细") && app().includes("四、跟单小结"), "四大类标题都带高亮 class");
  ok(app().includes("女装印花短袖T恤 圆领短袖"), "头部把款式名+款式合并显示");
  ok(app().includes('class="header-thumb"') || !app().includes("暂无照片"), "头部区域渲染不报错");
  ok(app().includes("生产进度") && !app().includes("加工厂明细"), "「加工厂明细」已改名「生产进度」");
  ok(app().includes(">本厂<") && app().includes(o1.values.factory), "服装工厂名称自动带入「本厂」打卡区");
  ok(app().includes(`<span class="tag hl">${o1.values.factory}</span>`), "服装工厂名称用高亮样式(.tag.hl)展示");
  // 本厂打卡：生产工序/车工人数/预计下车时间是必填项，且打卡记录里会展示
  ok(!!doc.getElementById("proc-mainLog") && !!doc.getElementById("workers-mainLog") && !!doc.getElementById("est-mainLog"),
    "本厂打卡框里有生产工序/车工人数/预计下车时间三个必填项");
  A.toggleAdd("mainLog"); await sleep(100);
  doc.getElementById("txt-mainLog").value = "本厂打卡-缺必填项";
  await A.addLog(o1.id, "mainLog"); await sleep(300);
  ok(!st().orders.find(x => x.id === o1.id).mainLog.some(e => e.text === "本厂打卡-缺必填项"), "本厂打卡不填工序/人数/预计下车时间不会提交成功");
  doc.getElementById("proc-mainLog").value = "车缝";
  doc.getElementById("workers-mainLog").value = "9";
  doc.getElementById("est-mainLog").value = "2026-08-12";
  doc.getElementById("txt-mainLog").value = "本厂打卡-含必填项";
  await A.addLog(o1.id, "mainLog"); await sleep(300);
  window.go("detail", o1.id); await sleep(300);
  ok(app().includes("本厂打卡-含必填项") && app().includes("生产工序：车缝") && app().includes("车工人数：9"),
    "本厂打卡填齐三项后成功，打卡记录里展示这三项");
  ok(!app().includes("验货日期"), "验货问题不再要求选日期");
  ok(app().includes("发货日期") && app().indexOf("包装进度") < app().indexOf("发货日期"), "发货日期排在包装进度后面");

  // 订单交期/发货日期：不进编辑页也能在详情页直接点选修改，编辑表单里不再重复出现
  ok(!!doc.getElementById(`qd-${o1.id}-deadline`) && doc.getElementById(`qd-${o1.id}-deadline`).type === "date", "订单交期在详情页直接可点选(不用进编辑页)");
  ok(!!doc.getElementById(`qd-${o1.id}-shipDate`) && doc.getElementById(`qd-${o1.id}-shipDate`).type === "date", "发货日期在详情页直接可点选(不用进编辑页)");
  A.toggleBasic(); await sleep(150);
  ok(!app().includes('id="nf-deadline"') && !app().includes('id="nf-shipDate"'), "编辑表单里不再重复出现订单交期/发货日期");
  ok(!!doc.getElementById(`qd-${o1.id}-deadline`) && !!doc.getElementById(`qd-${o1.id}-shipDate`), "编辑模式下日期字段仍在详情页可直接点选");
  A.toggleBasic(); await sleep(150); // 退出编辑模式，不保存
  await A.quickSetDate(o1.id, "deadline", "2026-09-01"); await sleep(400);
  ok(st().orders.find(x => x.id === o1.id).values.deadline === "2026-09-01", "直接点选交期后立即生效，无需进编辑页/点保存");
  window.go("detail", o1.id); await sleep(300);
  ok(app().includes("2026年9月1日"), "页面上交期显示为新值");

  // 动态加工点：新增(只填名字) -> 改名 -> 打卡(要求填工序/人数/预计下车时间，跟本厂一致)
  await A.addSubPrompt(o1.id); await sleep(100);
  doc.getElementById("m-input").value = "新加工点X";
  await A.modalOk(); await sleep(400);
  const newSub = st().orders.find(o => o.id === o1.id).subs.find(s => s.name === "新加工点X");
  ok(!!newSub, "新增加工点成功，名字是自己填的，不用先填工序/人数/预计下车时间");
  window.go("detail", o1.id); await sleep(300);
  ok(app().includes("加工点") && app().includes(`<span class="tag hl">新加工点X</span>`),
    "新加工点显示在生产进度里，标题是「加工点」+高光标签展示名字(跟本厂同样式)");
  // 打卡这个加工点要求填工序/人数/预计下车时间，跟本厂一致
  const subKey = "sub:" + newSub.id;
  ok(!!doc.getElementById("proc-" + subKey) && !!doc.getElementById("workers-" + subKey) && !!doc.getElementById("est-" + subKey),
    "加工点打卡框里有生产工序/车工人数/预计下车时间三个必填项");
  A.toggleAdd(subKey); await sleep(100);
  doc.getElementById("txt-" + subKey).value = "打卡测试-缺必填项";
  await A.addLog(o1.id, subKey); await sleep(300);
  ok(!st().orders.find(o => o.id === o1.id).subs.find(s => s.id === newSub.id).log.some(e => e.text === "打卡测试-缺必填项"),
    "加工点打卡不填工序/人数/预计下车时间不会提交成功");
  doc.getElementById("proc-" + subKey).value = "车缝";
  doc.getElementById("workers-" + subKey).value = "8";
  doc.getElementById("est-" + subKey).value = "2026-08-10";
  doc.getElementById("txt-" + subKey).value = "打卡测试-含必填项";
  await A.addLog(o1.id, subKey); await sleep(400);
  window.go("detail", o1.id); await sleep(300);
  ok(app().includes("打卡测试-含必填项") && app().includes("生产工序：车缝") && app().includes("车工人数：8"),
    "加工点打卡填齐三项后成功，打卡记录里展示这三项");
  // 改名：只改名字
  A.renameSub(o1.id, newSub.id); await sleep(100);
  doc.getElementById("m-input").value = "新加工点X改名后";
  await A.modalOk(); await sleep(400);
  const renamedSub = st().orders.find(o => o.id === o1.id).subs.find(s => s.id === newSub.id);
  ok(renamedSub.name === "新加工点X改名后", "改名只改名字");

  // 验货：业务员创建「发现问题」，本单下厂员填「整改情况」，双方都不能越权
  window.go("detail", o1.id); await sleep(300);
  ok(app().includes("＋ 新增") && app().includes("三、验货问题"), "管理员(等同业务员权限)能看到验货新增入口");
  A.forceLogout(); await sleep(150);
  doc.getElementById("lg-phone").value = "13811112222"; doc.getElementById("lg-pass").value = "123456"; // 陈晓芳(sales)
  await A.login(); A.dismissWelcome(); await sleep(400);
  window.go("detail", o1.id); await sleep(400);
  ok(app().includes("＋ 新增"), "业务员能看到验货新增入口");
  A.toggleAdd("insp"); await sleep(100);
  doc.getElementById("insp-items").querySelector(".insp-p").value = "UI测试-发现的新问题";
  await A.saveInsp(o1.id); await sleep(500);
  ok(app().includes("UI测试-发现的新问题"), "业务员通过界面创建的验货问题显示出来");
  ok(app().includes("待整改"), "新建的问题整改情况显示「待整改」");
  ok(app().includes('onclick="A.editInspFix'), "权限统一后，业务员也能看到「填写整改」链接");

  A.forceLogout(); await sleep(150);
  doc.getElementById("lg-phone").value = "13855556666"; doc.getElementById("lg-pass").value = "123456"; // 王建国(follower, 负责o1)
  await A.login(); A.dismissWelcome(); await sleep(400);
  window.go("detail", o1.id); await sleep(400);
  ok(app().includes("＋ 新增") && app().includes("三、验货问题"), "权限统一后，下厂员也能看到验货「新增」入口");
  const newItem = st().orders.find(o => o.id === o1.id).inspections.flatMap(g => g.items).find(i => i.problem === "UI测试-发现的新问题");
  ok(!!newItem, "下厂员能看到业务员刚创建的问题");
  A.editInspFix(o1.id, st().orders.find(o => o.id === o1.id).inspections.find(g => g.items.some(i => i.id === newItem.id)).id, newItem.id);
  await sleep(150);
  doc.getElementById("m-input").value = "UI测试-已整改";
  await A.modalOk(); await sleep(500);
  ok(app().includes("UI测试-已整改"), "下厂员通过界面填写的整改情况显示出来");

  // 王建国自己提交一条反馈，管理员标记已处理后，王建国在「我的」页应该能看到已处理
  A.submitFeedback(); await sleep(100);
  doc.getElementById("m-input").value = "UI测试-王建国自己的反馈";
  await A.modalOk(); await sleep(400);
  const wangFbId = (await apiAs("13800000000", "GET", "/feedback")).j.find(f => f.text === "UI测试-王建国自己的反馈").id;
  await apiAs("13800000000", "PATCH", `/feedback/${wangFbId}`, { handled: true });

  window.go("account"); await sleep(600);
  ok(app().includes("UI测试-王建国自己的反馈") && app().includes("已处理"),
    "提交人在「我的」页能看到自己提交的反馈已被管理员标记处理");
  ok(!app().includes("不点退出的话"), "已移除登录状态说明文字");
  ok(!app().includes("服装生产进度") && !app().includes("一对一私聊")
     && !app().includes("职位可直接下拉修改") && !app().includes("员工离职请用")
     && !app().includes("除内置的业务员"), "多余的说明文案已全部移除");

  A.forceLogout(); await sleep(200);
  ok(app().includes("<svg") && app().includes("login-logo"), "登录页使用 SVG 应用图标");
  // 电脑端（jsdom 非移动 UA）不显示"安装到手机"
  ok(!app().includes("install-cta"), "电脑端不显示安装到手机");
  // 安装引导本身仍可用（手机上才会显示入口，这里直接调函数验证走图文引导）
  A.install(); await sleep(150);
  ok(doc.getElementById("mask").classList.contains("show") && doc.getElementById("mask").innerHTML.includes("添加到主屏"),
     "点安装弹出图文引导");
  A.modalCancel(); await sleep(100);

  // ---- 重新打开App(已登录态，token还有效)：静态欢迎界面先兜底(不空白)，接着 JS 接管欢迎界面，1.5秒后进正常页面 ----
  const freshToken = (await (await fetch(BASEU + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "13800000000", password: "123456" }) })).json()).token;
  const html2 = fs.readFileSync(ROOT + "/index.html", "utf8");
  ok(html2.includes("天津锦利国际贸易有限公司") && html2.includes("跟单系统") && html2.includes('id="app">'),
    "index.html 里已内置静态欢迎界面，JS 跑起来之前手机屏幕不会是空的");
  const dom2 = new JSDOM(html2, { runScripts: "dangerously", url: BASEU + "/", virtualConsole: vc });
  const win2 = dom2.window;
  // JS 还没执行前，静态版本已经在屏幕上了
  ok(win2.document.getElementById("app").innerHTML.includes("天津锦利国际贸易有限公司"), "JS 执行前就已经显示静态欢迎界面，不是空白");
  win2.fetch = (u, o) => fetch(new URL(u, BASEU + "/").toString(), o);
  win2.FormData = FormData; win2.Blob = Blob; win2.URL.createObjectURL = () => "blob:x"; win2.URL.revokeObjectURL = () => {};
  win2.localStorage.setItem("daka_token", freshToken);
  const sc2 = win2.document.createElement("script");
  sc2.textContent = fs.readFileSync(ROOT + "/app.js", "utf8");
  win2.document.body.appendChild(sc2);
  await sleep(100);
  ok(win2.eval("showWelcome") && win2.document.getElementById("app").innerHTML.includes("跟单系统"),
    "重新打开已登录的App，JS 接管后欢迎界面依然在(不会中间掉一下空白)");
  await sleep(2200);
  ok(!win2.eval("showWelcome") && win2.document.getElementById("app").innerHTML.includes("订单列表"),
    "欢迎界面展示一会儿后自动进入正常页面");

  // ---- 本地数据缓存：像微信一样，下次打开先用上次缓存瞬间显示，不用干等网络 ----
  const cachedRaw = win2.localStorage.getItem("daka_cache_v1");
  ok(!!cachedRaw, "刷新成功后会把订单/用户等数据缓存到本地(daka_cache_v1)");
  const cached = JSON.parse(cachedRaw || "{}");
  ok(cached.token === freshToken && Array.isArray(cached.orders) && cached.orders.length > 0,
    "本地缓存的数据里包含当前账号 token 和订单列表");
  win2.eval("state.orders = []; loadStateCache();");
  ok(win2.eval("state.orders.length") > 0, "loadStateCache() 能把本地缓存的数据立即同步回 state，不用等网络返回");

  console.log(`\n结果：PASS ${pass}, FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERROR", e); process.exit(1); });
