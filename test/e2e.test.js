const fs = require("fs");
const { JSDOM, VirtualConsole } = require("jsdom");
// jsdom 未实现 window.scrollTo 等，属正常现象，静音掉避免干扰测试输出
const vc = new VirtualConsole();
vc.on("jsdomError", () => {});
const BASEU = process.env.BASE_URL || "http://localhost:3000";
const ROOT = require("path").join(__dirname, "..", "public");
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const html = fs.readFileSync(ROOT + "/index.html", "utf8");
  const dom = new JSDOM(html, { runScripts: "dangerously", url: BASEU + "/", virtualConsole: vc });
  const { window } = dom, doc = window.document;
  // 注入浏览器 API
  window.fetch = (u, o) => fetch(new URL(u, BASEU + "/").toString(), o);
  window.FormData = FormData; window.Blob = Blob; window.URL.createObjectURL = () => "blob:x";
  window.URL.revokeObjectURL = () => {};
  const sc = doc.createElement("script");
  sc.textContent = fs.readFileSync(ROOT + "/app.js", "utf8");
  doc.body.appendChild(sc);
  await sleep(300);
  const app = () => doc.getElementById("app").innerHTML;
  const A = window.A;

  ok(app().includes("跟单系统") && app().includes("lg-phone") && app().includes("lg-pass"), "未登录显示登录页");

  // 错误密码
  doc.getElementById("lg-phone").value = "13800000000";
  doc.getElementById("lg-pass").value = "wrong";
  await A.login(); A.dismissWelcome(); await sleep(250);
  ok(!app().includes("订单列表"), "错误密码不能登录");

  // 管理员登录
  doc.getElementById("lg-pass").value = "123456";
  await A.login(); A.dismissWelcome(); await sleep(400);
  ok(app().includes("订单列表") && app().includes('data-tab="admin"'), "管理员登录成功（含管理 Tab）");
  ok(app().includes("SS27-T012") && app().includes("女装印花短袖T恤"), "订单列表来自服务端");
  ok(window.localStorage.getItem("daka_token"), "token 已保存");

  // 详情页 + 打卡
  const st = () => window.eval("state");
  const o1 = st().orders.find(o => o.values.styleNo === "SS27-T012");
  window.go("detail", o1.id); await sleep(200);
  ok(app().includes("一、订单明细") && app().includes("二、生产明细") && app().includes("三、验货问题") && app().includes("四、跟单小结"), "详情页四大板块");
  doc.getElementById("txt-cutting").value = "E2E 打卡测试";
  await A.addLog(o1.id, "cutting"); await sleep(400);
  ok(app().includes("E2E 打卡测试"), "打卡后页面显示新记录");
  // 服务端确认已持久化
  const r = await fetch(BASEU + "/api/orders/" + o1.id, { headers: { Authorization: "Bearer " + st().token } });
  const srv = await r.json();
  ok(srv.logs.cutting.some(e => e.text === "E2E 打卡测试" && e.byName === "老板"), "打卡已存到服务端(带姓名)");

  // 跟单问题
  doc.getElementById("txt-follow").value = "E2E 跟单问题";
  await A.addFollow(o1.id); await sleep(400);
  ok(app().includes("E2E 跟单问题"), "跟单问题添加成功");

  // 管理后台：职位下拉
  window.go("admin"); await sleep(250);
  ok(app().includes("员工账号") && app().includes("职位管理"), "管理后台渲染");
  ok(app().includes('data-view="admin"'), "当前页面是管理后台");
  const selCount = (app().match(/A\.changeRole\(/g) || []).length;
  const admins = st().users.filter(u => u.role === "admin").length;
  ok(selCount === st().users.length - admins, "每个非管理员都有职位下拉，管理员没有");
  ok(!app().includes(`A.changeRole('${st().me.id}'`), "自己(管理员)没有职位下拉");
  const wang = st().users.find(u => u.name === "王建国");
  await A.changeRole(wang.id, "sales"); await sleep(400);
  ok(st().users.find(u => u.id === wang.id).role === "sales", "下拉改职位：下厂员→业务员");
  await A.changeRole(wang.id, "follower"); await sleep(400);
  ok(st().users.find(u => u.id === wang.id).role === "follower", "改回下厂员");

  // 删除员工二次确认
  doc.getElementById("nu-name").value = "E2E临时";
  doc.getElementById("nu-phone").value = "13900007777";
  await A.addUser(); await sleep(400);
  const tmp = st().users.find(u => u.phone === "13900007777");
  ok(!!tmp, "创建员工成功");
  A.deleteUser(tmp.id); await sleep(100);
  ok(doc.getElementById("mask").classList.contains("show"), "删除弹出二次确认");
  A.modalCancel(); await sleep(200);
  ok(st().users.some(u => u.id === tmp.id), "取消则未删除");
  A.deleteUser(tmp.id); await sleep(100);
  await A.modalOk(); await sleep(500);
  ok(!st().users.some(u => u.id === tmp.id), "确认后员工已删除");

  // 新建订单（季节下拉）
  window.go("new"); await sleep(200);
  const seasonSel = doc.getElementById("nf-season");
  ok(seasonSel && seasonSel.tagName === "SELECT", "季节是下拉");
  const y = new Date().getFullYear();
  const opts = [...seasonSel.options].map(o => o.value);
  ok(opts.includes("SS" + y) && opts.includes("FW" + (y + 1)), "季节按当前年份自动生成");
  seasonSel.value = "SS" + (y + 1);
  doc.getElementById("nf-styleNo").value = "E2E-001";
  doc.getElementById("nf-styleName").value = "E2E新款";
  await A.createOrder(); await sleep(500);
  ok(st().orders.some(o => o.values.styleNo === "E2E-001"), "新建订单成功");

  // 批量导入：识别→可编辑→确认
  window.go("new"); await sleep(200);
  doc.getElementById("imp-text").value = "季节,货号,款式名,数量,业务员,下厂员\nSS2027,E2E-IMP1,导入甲,500,陈晓芳,王建国\nSS2027,E2E-IMP2,导入乙,800,查无此人,刘敏";
  const beforeN = st().orders.length;
  A.importText(); await sleep(250);
  ok(st().orders.length === beforeN, "识别后未直接入库");
  ok(doc.getElementById("imp0-styleNo").value === "E2E-IMP1", "识别结果填入可编辑输入框");
  ok(doc.getElementById("imp1-sales").value === "", "查不到的业务员留空待选");
  doc.getElementById("imp0-styleName").value = "导入甲改名";
  A.removeImportRow(1); await sleep(200);
  ok(doc.getElementById("imp0-styleName").value === "导入甲改名", "移除一单后其它修改保留");
  await A.confirmImport(); await sleep(600);
  ok(st().orders.some(o => o.values.styleName === "导入甲改名"), "导入时用户的修改被保存");
  ok(!st().orders.some(o => o.values.styleNo === "E2E-IMP2"), "被移除的单未导入");

  // 批量导入：粘贴文字时列顺序打乱了也要能按表头名字对齐，不能按位置瞎猜；发货日期也要能正确导入(不丢失)
  window.go("new"); await sleep(200);
  doc.getElementById("imp-text").value = "数量,季节,款式名,货号,发货日期,订单交期\n500,SS2027,乱序测试款,E2E-ORDER,2026-09-10,2026-08-20";
  A.importText(); await sleep(250);
  ok(doc.getElementById("imp0-styleNo").value === "E2E-ORDER", "列顺序打乱后，货号依然按表头名字对上了正确的值");
  ok(doc.getElementById("imp0-qty").value === "500", "数量也对上了(不是被货号那一列的值覆盖)");
  ok(doc.getElementById("imp0-shipDate") && doc.getElementById("imp0-shipDate").value === "2026-09-10", "发货日期能正确导入，不再丢失");
  ok(doc.getElementById("imp0-deadline") && doc.getElementById("imp0-deadline").value === "2026-08-20", "订单交期也正确导入，跟发货日期没混淆");
  await A.confirmImport(); await sleep(500);
  const orderX = st().orders.find(o => o.values.styleNo === "E2E-ORDER");
  ok(!!orderX && orderX.values.shipDate === "2026-09-10" && orderX.values.deadline === "2026-08-20", "确认导入后发货日期/订单交期都正确保存");


  // 权限：下厂员视角
  A.forceLogout(); await sleep(150);
  doc.getElementById("lg-phone").value = "13877778888"; // 刘敏
  doc.getElementById("lg-pass").value = "123456";
  await A.login(); A.dismissWelcome(); await sleep(400);
  ok(!app().includes('data-tab="admin"'), "下厂员看不到管理 Tab");
  ok(app().includes("go('new')"), "任意登录用户都能看到新建订单入口");
  window.go("detail", o1.id); await sleep(250); // o1 归王建国，跟刘敏(o2 下厂员)无关
  ok(!app().includes("txt-cutting"), "谁负责的内容谁有权限：跟本单无关的下厂员看不到打卡框");

  console.log(`\n结果：PASS ${pass}, FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERROR", e); process.exit(1); });
