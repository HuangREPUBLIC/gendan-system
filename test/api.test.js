const BASE = (process.env.BASE_URL || "http://localhost:3000") + "/api";
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n); } };
async function call(method, path, token, body) {
  const h = { "Content-Type": "application/json" };
  if (token) h.Authorization = "Bearer " + token;
  const r = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}
(async () => {
  // login wrong
  ok((await call("POST", "/login", null, { phone: "13800000000", password: "x" })).status === 400, "错误密码拒绝");
  // admin login
  const adm = await call("POST", "/login", null, { phone: "13800000000", password: "123456" });
  ok(adm.status === 200 && adm.j.token, "管理员登录");
  const aT = adm.j.token, aId = adm.j.user.id;
  // bootstrap
  const boot = await call("GET", "/bootstrap", aT);
  ok(boot.status === 200 && boot.j.orders.length === 3 && boot.j.users.length === 5, "bootstrap 返回订单与用户");
  ok(boot.j.me.role === "admin", "me 是管理员");
  const orders = boot.j.orders, users = boot.j.users;
  const o1 = orders.find(o => o.values.styleNo === "SS27-T012");
  const wang = users.find(u => u.name === "王建国"), liu = users.find(u => u.name === "刘敏"), chen = users.find(u => u.name === "陈晓芳");

  // sales / follower login
  const sT = (await call("POST", "/login", null, { phone: "13811112222", password: "123456" })).j.token; // 陈晓芳(o1 业务员)
  const wT = (await call("POST", "/login", null, { phone: "13855556666", password: "123456" })).j.token; // 王建国(o1 下厂员)
  const fT = (await call("POST", "/login", null, { phone: "13877778888", password: "123456" })).j.token; // 刘敏(负责 o2，跟 o1 无关)

  // 谁负责的内容谁有权限：跟 o1 无关的下厂员不能在 o1 上打卡
  ok((await call("POST", `/orders/${o1.id}/logs`, fT, { key: "cutting", text: "非本单下厂员打卡" })).status === 403, "跟本单无关的下厂员不能在此订单打卡");
  // 本单负责下厂员(王建国)能打卡
  ok((await call("POST", `/orders/${o1.id}/logs`, wT, { key: "cutting", text: "本单下厂员打卡" })).status === 200, "本单负责下厂员能打卡");
  // admin can log
  const al = await call("POST", `/orders/${o1.id}/logs`, aT, { key: "cutting", text: "管理员打卡测试" });
  ok(al.status === 200 && al.j.logs.cutting.some(e => e.text === "管理员打卡测试" && e.byName === "老板"), "管理员打卡并自动记名");
  // sales(陈晓芳 创建 o1) can update both order-section and production-section progress on 自己的订单
  ok((await call("POST", `/orders/${o1.id}/logs`, sT, { key: "fabricProg", text: "业务员更新面料" })).status === 200, "业务员更新订单明细进度");
  ok((await call("POST", `/orders/${o1.id}/logs`, sT, { key: "ironing", text: "业务员也能打卡" })).status === 200, "本单业务员也能在生产明细打卡");
  // sales edit basic ok; 跟本单无关的下厂员不行
  ok((await call("PATCH", `/orders/${o1.id}`, sT, { values: { fabric: "改过的面料" } })).status === 200, "业务员改自己订单基本信息");
  ok((await call("PATCH", `/orders/${o1.id}`, fT, { values: { fabric: "x" } })).status === 403, "跟本单无关的下厂员不能改基本信息");
  ok((await call("PATCH", `/orders/${o1.id}`, wT, { values: { fabric: "王建国改的面料" } })).status === 200, "本单负责下厂员能改基本信息");

  // create order: 任意登录用户仍可建单(建单后自己就是负责人)
  ok((await call("POST", "/orders", fT, { season: "SS2027", values: { styleNo: "X" } })).status === 200, "下厂员能建单");
  const co = await call("POST", "/orders", sT, { season: "SS2027", values: { styleNo: "NEW-1", styleName: "新单" } });
  ok(co.status === 200 && co.j.values.sales === chen.id, "业务员建单并自动带上自己");

  // import
  const imp = await call("POST", "/orders/import", sT, { orders: [
    { season: "SS2027", values: { styleNo: "IMP-1", styleName: "导入甲", follower: wang.id } },
    { season: "SS2027", values: {} } ] });
  ok(imp.status === 200 && imp.j.imported === 1, "批量导入跳过空单");

  // ROLE CHANGE: admin can change others (王建国 follower -> sales), NOT self
  ok((await call("PATCH", `/users/${aId}`, aT, { role: "follower" })).status === 400, "不能改自己的职位");
  const rc = await call("PATCH", `/users/${wang.id}`, aT, { role: "sales" });
  ok(rc.status === 200 && rc.j.role === "sales", "管理员下拉改他人职位(下厂员→业务员)");
  await call("PATCH", `/users/${wang.id}`, aT, { role: "follower" }); // 改回
  // non-admin cannot change roles
  ok((await call("PATCH", `/users/${liu.id}`, sT, { role: "sales" })).status === 403, "业务员不能改职位");

  // user delete: cannot self, cannot admin; can others
  ok((await call("DELETE", `/users/${aId}`, aT)).status === 400, "不能删除自己");
  const newU = await call("POST", "/users", aT, { name: "临时工", phone: "13900008888", role: "follower" });
  ok(newU.status === 200, "创建员工");
  ok((await call("DELETE", `/users/${newU.j.id}`, aT)).status === 200, "删除员工(软删)");
  ok((await call("POST", "/login", null, { phone: "13900008888", password: "123456" })).status === 400, "被删员工无法登录");

  // custom field
  const cf = await call("POST", "/fields", aT, { section: "production", label: "吊牌进度", type: "log" });
  ok(cf.status === 200 && cf.j.production.some(f => f.label === "吊牌进度"), "新增自定义打卡字段");
  ok((await call("POST", "/fields", aT, { section: "production", label: "吊牌进度", type: "log" })).status === 400, "同名字段不能重复添加");

  // inspection + follow
  ok((await call("POST", `/orders/${o1.id}/inspections`, aT, { problems: ["P"] })).status === 200, "新增验货记录(业务员/管理员创建)");
  ok((await call("POST", `/orders/${o1.id}/follow`, aT, { text: "跟单问题测试" })).status === 200, "新增跟单问题");

  // ---- 照片 ----
  // 打卡带照片，且恶意/外部 URL 被过滤，只留 /uploads/ 路径
  const lp = await call("POST", `/orders/${o1.id}/logs`, aT, { key: "cutting", text: "带图打卡",
    photos: ["/uploads/a1.jpg", "javascript:alert(1)", "https://evil.com/x.jpg", "/uploads/a2.jpg"] });
  const cutE = lp.j.logs.cutting.find(e => e.text === "带图打卡");
  ok(lp.status === 200 && cutE.photos.length === 2 && cutE.photos[0] === "/uploads/a1.jpg", "打卡照片保存且只留 /uploads/ 路径");
  // 只发照片、不写字也可以
  ok((await call("POST", `/orders/${o1.id}/logs`, aT, { key: "cutting", text: "", photos: ["/uploads/only.jpg"] })).status === 200, "只发照片也能打卡");
  // 文字和照片都空则拒绝
  ok((await call("POST", `/orders/${o1.id}/logs`, aT, { key: "cutting", text: "", photos: [] })).status === 400, "文字照片都空被拒");
  // 编辑打卡只改文字，照片保留
  const eid = cutE.id;
  const ed = await call("PATCH", `/orders/${o1.id}/logs/cutting/${eid}`, aT, { text: "改了字" });
  const cutE2 = ed.j.logs.cutting.find(e => e.id === eid);
  ok(ed.status === 200 && cutE2.text === "改了字" && cutE2.photos.length === 2, "编辑打卡改字不丢照片");
  // 验货带照片；只发照片、不写发现问题也行
  ok((await call("POST", `/orders/${o1.id}/inspections`, aT, { problems: [], photos: ["/uploads/insp.jpg"] })).status === 200, "验货只加照片也能存");
  const ins = await call("GET", `/orders/${o1.id}`, aT);
  ok(ins.j.inspections.some(g => (g.photos || []).includes("/uploads/insp.jpg") && g.items.length === 0), "验货照片已保存(无问题条目)");
  // 跟单带照片
  const fl = await call("POST", `/orders/${o1.id}/follow`, aT, { text: "带图跟单", photos: ["/uploads/f1.jpg"] });
  ok(fl.status === 200 && fl.j.followIssues.some(e => e.text === "带图跟单" && (e.photos || []).includes("/uploads/f1.jpg")), "跟单照片已保存");
  // 款式图多图相册
  const alb = await call("POST", "/orders", aT, { season: "SS2027", values: { styleNo: "ALB-1", img: ["/uploads/p1.jpg", "/uploads/p2.jpg", "/uploads/p3.jpg"] } });
  ok(alb.status === 200 && Array.isArray(alb.j.values.img) && alb.j.values.img.length === 3, "款式图可存多张");

  // export xlsx (admin only)，导出全部内容(订单基本信息/生产进度/验货问题/跟单小结)，可按季节筛选
  const exp = await fetch(BASE + "/export", { headers: { Authorization: "Bearer " + aT } });
  const buf = Buffer.from(await exp.arrayBuffer());
  ok(exp.status === 200 && buf.slice(0, 2).toString() === "PK" && buf.length > 500, "导出真实 .xlsx (PK 头)");
  ok((await fetch(BASE + "/export", { headers: { Authorization: "Bearer " + sT } })).status === 403, "非管理员不能导出");
  const XLSX = require("xlsx");
  const wb = XLSX.read(buf, { type: "buffer" });
  ok(["订单基本信息", "生产进度", "验货问题", "跟单小结"].every(n => wb.SheetNames.includes(n)), "导出含四个分表：基本信息/生产进度/验货问题/跟单小结");
  const baseHeader = XLSX.utils.sheet_to_json(wb.Sheets["订单基本信息"], { header: 1 })[0];
  ok(baseHeader.filter(h => h === "货号").length === 1, "「订单基本信息」表头里「货号」不重复出现两次");
  ok(baseHeader.includes("发货日期"), "「订单基本信息」表头包含发货日期字段");
  const inspSheet = XLSX.utils.sheet_to_json(wb.Sheets["验货问题"]);
  ok(inspSheet.some(r => r["发现问题"] === "首件肩缝有轻微起皱"), "验货问题表含发现问题内容");
  // 按季节筛选导出
  const expFiltered = await fetch(BASE + "/export?season=" + encodeURIComponent(o1.season), { headers: { Authorization: "Bearer " + aT } });
  const wbF = XLSX.read(Buffer.from(await expFiltered.arrayBuffer()), { type: "buffer" });
  const baseRows = XLSX.utils.sheet_to_json(wbF.Sheets["订单基本信息"]);
  ok(baseRows.length > 0 && baseRows.every(r => r["季节"] === o1.season), "按季节筛选导出后只含该季节的订单");
  const noMatch = await fetch(BASE + "/export?season=不存在的季节XYZ", { headers: { Authorization: "Bearer " + aT } });
  const wbEmpty = XLSX.read(Buffer.from(await noMatch.arrayBuffer()), { type: "buffer" });
  ok(XLSX.utils.sheet_to_json(wbEmpty.Sheets["订单基本信息"]).length === 0, "筛选不存在的季节时导出为空");

  // ---- 导出真正嵌入图片(款式图 + 打卡/验货/跟单照片)，而不是"（有图）"文字或裸链接 ----
  const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const fd = new FormData();
  fd.append("image", new Blob([pngBytes], { type: "image/png" }), "test.png");
  const upRes = await fetch(BASE + "/upload", { method: "POST", headers: { Authorization: "Bearer " + aT }, body: fd });
  const upJ = await upRes.json();
  ok(upRes.status === 200 && upJ.url, "上传测试图片成功(供嵌图测试用)");

  const imgOrder = await call("POST", "/orders", aT, { season: "SS2027", values: { styleNo: "IMGTEST-1", img: [upJ.url] } });
  ok(imgOrder.status === 200, "创建带款式图的测试订单");
  const mlog = await call("POST", `/orders/${imgOrder.j.id}/logs`, aT,
    { key: "mainLog", text: "嵌图测试打卡", process: "车缝", workers: "5", estDone: "2026-08-01", photos: [upJ.url] });
  ok(mlog.status === 200, "本厂打卡带照片(供嵌图测试用)");

  const exp2 = await fetch(BASE + "/export", { headers: { Authorization: "Bearer " + aT } });
  const buf2 = Buffer.from(await exp2.arrayBuffer());
  const AdmZip = require("adm-zip");
  const zip2 = new AdmZip(buf2);
  ok(!!zip2.getEntry("xl/drawings/drawing1.xml"), "「订单基本信息」表已嵌入款式图 drawing");
  ok(!!zip2.getEntry("xl/drawings/drawing2.xml"), "「生产进度」表已嵌入打卡照片 drawing");
  ok(zip2.getEntry("[Content_Types].xml").getData().toString("utf8").includes("drawing+xml"), "[Content_Types].xml 已声明 drawing 部件类型");
  const mediaEntries = zip2.getEntries().filter(e => e.entryName.startsWith("xl/media/"));
  ok(mediaEntries.length > 0, "xlsx 内含真实图片文件(xl/media)");
  ok(mediaEntries.some(e => e.getData().length === pngBytes.length), "嵌入的图片字节数与原图一致(未损坏)");

  const wb2 = XLSX.read(buf2, { type: "buffer" });
  const rows1raw = XLSX.utils.sheet_to_json(wb2.Sheets["订单基本信息"], { header: 1 });
  const styleRowIdx = rows1raw.findIndex(r => r[1] === "IMGTEST-1");
  ok(styleRowIdx > 0, "「订单基本信息」表能找到测试订单这一行");
  ok(!(rows1raw[styleRowIdx] || []).includes("（有图）"), "款式图列不再是「（有图）」占位文字");
  const drawing1Xml = zip2.getEntry("xl/drawings/drawing1.xml").getData().toString("utf8");
  ok(drawing1Xml.includes(`<xdr:row>${styleRowIdx}</xdr:row>`), "款式图图片锚定在测试订单所在的正确行");

  const rows2raw = XLSX.utils.sheet_to_json(wb2.Sheets["生产进度"], { header: 1 });
  const logRowIdx = rows2raw.findIndex(r => r[6] === "嵌图测试打卡");
  ok(logRowIdx > 0, "「生产进度」表能找到测试打卡这一行");
  ok(!(rows2raw[logRowIdx] || []).some(c => String(c || "").startsWith("/uploads/")), "打卡照片列不再是裸链接文字");
  const drawing2Xml = zip2.getEntry("xl/drawings/drawing2.xml").getData().toString("utf8");
  ok(drawing2Xml.includes(`<xdr:row>${logRowIdx}</xdr:row>`), "打卡照片图片锚定在测试打卡所在的正确行");

  // ---- 导入解析：WPS 导出的表格 !ref(声明的数据范围) 经常比实际数据大很多(最坏到 100 多万行)，
  // 之前会照着声明的范围去读，哪怕实际只有两三行数据，也要同步遍历上百万个空单元格，实测能卡住服务器 20+ 秒。
  // 现在改成按实际有数据的单元格收紧范围，这里验证：哪怕文件自己声明了一个夸张的大范围，解析也应该又快又准 ----
  const bigRangeWs = XLSX.utils.aoa_to_sheet([["货号", "款式名"], ["WPSBIG-1", "夸张范围测试款"], ["WPSBIG-2", "夸张范围测试款2"]]);
  bigRangeWs["!ref"] = "A1:AZ1048576"; // 模拟 WPS 留下的夸张 !ref，实际只有 3 行数据
  const bigRangeWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(bigRangeWb, bigRangeWs, "Sheet1");
  const bigRangeBuf = XLSX.write(bigRangeWb, { type: "buffer", bookType: "xlsx" });
  // Node fetch(undici) 在这个测试文件跑到第60多个请求时，偶尔会复用一个已经失效的 keep-alive 连接导致 EPIPE/ECONNRESET，
  // 跟服务端逻辑无关(同样的请求用 curl/全新连接怎么测都是秒回、结果正确)，这里多重试几次、间隔一下再试，规避这个客户端连接池问题
  const tBig0 = Date.now();
  let bigRes;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const fdBig = new FormData();
      fdBig.append("file", new Blob([bigRangeBuf]), "big-range.xlsx");
      bigRes = await fetch(BASE + "/import/parse", { method: "POST", headers: { Authorization: "Bearer " + aT }, body: fdBig });
      break;
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise(r => setTimeout(r, 200));
    }
  }
  const bigJ = await bigRes.json();
  const bigElapsed = Date.now() - tBig0;
  ok(bigRes.status === 200, "!ref 声明范围夸张的表格也能正常解析");
  ok(bigJ.rows && bigJ.rows.length === 3, "解析结果只有实际的3行数据，没有把上百万空行也读进来(表头+2行)");
  ok(bigElapsed < 5000, `!ref 夸张的表格解析耗时应该在几毫秒到几百毫秒级别，不应该卡住几十秒(实际耗时 ${bigElapsed}ms)`);

  // ---- 完全权限开关：职位管理里勾上后不受"谁负责的内容谁有权限"限制 ----
  const newRole = await call("POST", "/roles", aT, { label: "测试主管", template: "sales" });
  ok(newRole.status === 200, "创建新职位成功");
  const newRoleK = newRole.j.find(r => r.label === "测试主管").k;
  await call("PATCH", `/users/${liu.id}`, aT, { role: newRoleK }); // 刘敏(fT)临时改成这个新职位
  ok((await call("POST", `/orders/${o1.id}/logs`, fT, { key: "cutting", text: "还没开完全权限" })).status === 403,
    "还没打开完全权限开关前，「测试主管」还是只能管自己负责的订单");
  ok((await call("PATCH", `/roles/${newRoleK}`, aT, { fullAccess: true })).status === 200, "管理员打开「测试主管」的完全权限开关");
  ok((await call("POST", `/orders/${o1.id}/logs`, fT, { key: "cutting", text: "完全权限打卡" })).status === 200,
    "打开完全权限开关后，「测试主管」能管理任何订单(不受负责人限制)");

  // ---- 发货日期锁定：一旦填写，除管理员外任何人(包括完全权限职位)都不能再改这单任何内容 ----
  const lockOrder = await call("POST", "/orders", sT, { season: "SS2027", values: { styleNo: "LOCK-1", styleName: "锁定测试" } });
  ok(lockOrder.status === 200, "创建锁定测试订单");
  ok((await call("PATCH", `/orders/${lockOrder.j.id}`, sT, { values: { shipDate: "2026-09-01" } })).status === 200, "业务员本人可以填发货日期");
  ok((await call("PATCH", `/orders/${lockOrder.j.id}`, sT, { values: { fabric: "锁定后想改" } })).status === 403, "发货日期填写后，本单业务员自己也不能再改了");
  ok((await call("POST", `/orders/${lockOrder.j.id}/logs`, fT, { key: "cutting", text: "完全权限也改不了" })).status === 403, "发货日期填写后，完全权限职位也不能再改这单");
  ok((await call("PATCH", `/orders/${lockOrder.j.id}`, aT, { values: { fabric: "管理员改的" } })).status === 200, "管理员仍能修改已锁定的订单");
  await call("PATCH", `/users/${liu.id}`, aT, { role: "follower" }); // 测试收尾，把刘敏职位改回去
  await call("DELETE", `/roles/${newRoleK}`, aT); // 清理掉测试用的临时职位，避免影响其它测试文件对职位数量的断言(同一个 npm test 进程里所有测试文件共用一个服务端/数据库)

  // no-token blocked
  ok((await call("GET", "/bootstrap", null)).status === 401, "未登录被拦截");
  // 安全：公网"凭手机号自助改密"已移除（原来可盗号）
  ok((await call("POST", "/password/reset", null, { phone: "13800000000", newPassword: "x" })).status >= 400, "自助改密接口已下线（未登录无法改密）");

  console.log(`\n结果：PASS ${pass}, FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERROR", e); process.exit(1); });
