const BASE=(process.env.BASE_URL || "http://localhost:3000")+"/api"; let pass=0,fail=0;
const ok=(c,n)=>{if(c){pass++;console.log("PASS "+n);}else{fail++;console.log("FAIL "+n);}};
async function call(m,p,t,b){const h={"Content-Type":"application/json"};if(t)h.Authorization="Bearer "+t;
  const r=await fetch(BASE+p,{method:m,headers:h,body:b?JSON.stringify(b):undefined});
  let j=null;try{j=await r.json();}catch(e){} return {status:r.status,j};}
(async()=>{
  const aT=(await call("POST","/login",null,{phone:"13800000000",password:"123456"})).j.token;
  const boot=(await call("GET","/bootstrap",aT)).j;
  ok(Array.isArray(boot.roles)&&boot.roles.length===2,"bootstrap 带职位表");
  const chen=boot.users.find(u=>u.name==="陈晓芳"), wang=boot.users.find(u=>u.name==="王建国");
  ok(chen.roleLabel==="业务员"&&wang.roleLabel==="下厂员","用户带职位名称");

  // 自定义职位
  const nr=await call("POST","/roles",aT,{label:"跟单主管",template:"sales"});
  ok(nr.status===200&&nr.j.some(r=>r.label==="跟单主管"),"新增自定义职位");
  ok((await call("POST","/roles",aT,{label:"X",template:"boss"})).status===400,"权限模板必须合法");
  ok((await call("DELETE","/roles/sales",aT)).status===400,"内置职位不可删");
  const rk=nr.j.find(r=>r.label==="跟单主管").k;
  // 把王建国改成跟单主管 -> 应获得业务员权限（可建单）
  ok((await call("PATCH","/users/"+wang.id,aT,{role:rk})).status===200,"把员工改成自定义职位");
  const wT=(await call("POST","/login",null,{phone:"13855556666",password:"123456"})).j.token;
  ok((await call("POST","/orders",wT,{season:"SS2027",values:{styleNo:"ROLE-1"}})).status===200,"自定义职位继承业务员权限(可建单)");
  ok((await call("DELETE","/roles/"+rk,aT)).status===400,"职位使用中不可删除");
  await call("PATCH","/users/"+wang.id,aT,{role:"follower"});
  ok((await call("DELETE","/roles/"+rk,aT)).status===200,"无人使用后可删除职位");

  // 季节管理（管理员可增删，非管理员不行；使用中的季节不可删）
  ok(Array.isArray(boot.seasons)&&boot.seasons.length>0,"bootstrap 带季节列表");
  const ns=await call("POST","/seasons",aT,{name:"SS2099"});
  ok(ns.status===200&&ns.j.includes("SS2099"),"管理员新增季节");
  ok((await call("POST","/seasons",aT,{name:"SS2099"})).status===400,"不能新增同名季节");
  ok((await call("POST","/seasons",wT,{name:"SS2100"})).status===403,"非管理员不能新增季节");
  const so=await call("POST","/orders",aT,{season:"SS2099",values:{styleNo:"SEASON-1"}});
  ok(so.status===200,"用新季节建单");
  ok((await call("DELETE","/seasons/SS2099",aT)).status===400,"季节使用中不可删除");
  ok((await call("DELETE","/seasons/"+encodeURIComponent("FW2099"),aT)).status===404,"删除不存在的季节报错");
  const noUse=await call("POST","/seasons",aT,{name:"FW2099"});
  ok(noUse.status===200,"再新增一个没人用的季节");
  ok((await call("DELETE","/seasons/"+encodeURIComponent("FW2099"),wT)).status===403,"非管理员不能删季节");
  ok((await call("DELETE","/seasons/"+encodeURIComponent("FW2099"),aT)).status===200,"无人使用可删除季节");

  // 聊天
  const cT=(await call("POST","/login",null,{phone:"13811112222",password:"123456"})).j.token; // 陈晓芳
  let contacts=(await call("GET","/chat/contacts",aT)).j;
  ok(contacts.length===boot.users.length-1&&!contacts.some(c=>c.id===boot.me.id),"联系人列表不含自己");
  ok(contacts.every(c=>c.unread===0&&c.last===null),"初始无未读无消息");
  ok((await call("POST","/chat/with/"+boot.me.id,aT,{text:"自己"})).status===400,"不能给自己发消息");
  ok((await call("POST","/chat/with/"+chen.id,aT,{text:""})).status===400,"空消息被拒");
  ok((await call("POST","/chat/with/"+chen.id,aT,{text:"晓芳，SS27-T012 面料到了吗？"})).status===200,"老板发消息给陈晓芳");
  // 陈晓芳看到未读
  const un=(await call("GET","/chat/unread",cT)).j;
  ok(un.total===1&&un.byUser[boot.me.id]===1,"收件人有 1 条未读");
  contacts=(await call("GET","/chat/contacts",cT)).j;
  ok(contacts[0].name==="老板"&&contacts[0].unread===1&&contacts[0].last.fromMe===false,"联系人列表按最新消息排序且标未读");
  // 打开会话 -> 已读
  const conv=(await call("GET","/chat/with/"+boot.me.id,cT)).j;
  ok(conv.messages.length===1&&conv.messages[0].fromMe===false&&conv.contact.name==="老板","会话内容正确");
  ok((await call("GET","/chat/unread",cT)).j.total===0,"打开会话后已读清零");
  // 回复
  await call("POST","/chat/with/"+boot.me.id,cT,{text:"到了，2860kg"});
  const conv2=(await call("GET","/chat/with/"+chen.id,aT)).j;
  ok(conv2.messages.length===2&&conv2.messages[1].fromMe===false&&conv2.messages[1].text==="到了，2860kg","双向会话正确");
  // 第三方看不到别人的私聊
  const fT=(await call("POST","/login",null,{phone:"13877778888",password:"123456"})).j.token;
  ok((await call("GET","/chat/with/"+chen.id,fT)).j.messages.length===0,"第三方看不到别人的私聊");
  ok((await call("GET","/chat/contacts",null)).status===401,"未登录不能用聊天");

  // ---- 聊天附件 ----
  async function upload(token, filename, bytes, type) {
    const fd = new FormData();
    fd.append("file", new Blob([bytes], { type }), filename);
    const r = await fetch(BASE + "/chat/upload", { method: "POST", headers: { Authorization: "Bearer " + token }, body: fd });
    return { status: r.status, j: await r.json().catch(() => null) };
  }
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
    "0000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082", "hex");
  const up = await upload(aT, "工艺单.png", png, "image/png");
  ok(up.status === 200 && up.j.url.startsWith("/uploads/") && up.j.isImage === true, "上传图片附件");
  ok(up.j.name === "工艺单.png", "中文文件名不乱码");
  const bad = await upload(aT, "病毒.exe", Buffer.from("MZ"), "application/octet-stream");
  ok(bad.status === 400, "不支持的文件类型被拒绝");

  ok((await call("POST", "/chat/with/" + chen.id, aT, { attachment: up.j })).status === 200, "只发附件不带文字也可以");
  const withAtt = (await call("GET", "/chat/with/" + chen.id, aT)).j;
  const lastMsg = withAtt.messages[withAtt.messages.length - 1];
  ok(lastMsg.attachment && lastMsg.attachment.name === "工艺单.png" && lastMsg.attachment.isImage, "会话里带回附件信息");
  const cc = (await call("GET", "/chat/contacts", cT)).j.find(c => c.name === "老板");
  ok(cc && cc.last.text === "[附件]", "联系人预览显示 [附件]");
  ok((await call("POST", "/chat/with/" + chen.id, aT, {})).status === 400, "既无文字又无附件被拒");
  const dl = await fetch(BASE.replace("/api", "") + up.j.url);
  ok(dl.status === 200, "附件可以下载");

  // ---- 导入：直接读 Excel / GBK 编码的 CSV ----
  const XLSX = require("xlsx");
  async function parseUpload(token, filename, buf, type) {
    const fd = new FormData();
    fd.append("file", new Blob([buf], { type }), filename);
    const r = await fetch(BASE + "/import/parse", { method: "POST", headers: { Authorization: "Bearer " + token }, body: fd });
    return { status: r.status, j: await r.json().catch(() => null) };
  }
  // 真的 .xlsx
  const ws = XLSX.utils.aoa_to_sheet([["季节", "货号", "款式名", "数量"], ["SS2027", "XL-1", "表格导入款", "600"]]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "订单");
  const xbuf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const xr = await parseUpload(aT, "订单表.xlsx", xbuf, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  ok(xr.status === 200 && xr.j.rows.length === 2 && xr.j.rows[1][1] === "XL-1", "可直接解析 .xlsx（不用另存为 CSV）");
  ok(xr.j.rows[0][0] === "季节", "xlsx 中文表头正确");

  // Windows 版 Excel 存的 GBK 编码 CSV
  const gbkCsv = Buffer.concat([
    Buffer.from([0xBC,0xBE,0xBD,0xDA,0x2C,0xBB,0xF5,0xBA,0xC5,0x0A]),      // 季节,货号\n
    Buffer.from("SS2027,GB-1\n", "latin1")
  ]);
  const gr = await parseUpload(aT, "订单.csv", gbkCsv, "text/csv");
  ok(gr.status === 200 && gr.j.encoding === "GBK", "GBK 编码的 CSV 被识别");
  ok(gr.j.rows[0][0] === "季节" && gr.j.rows[0][1] === "货号", "GBK 中文表头不乱码");

  // UTF-8 CSV 仍正常
  const ur = await parseUpload(aT, "u.csv", Buffer.from("季节,货号\nSS2027,U-1\n", "utf8"), "text/csv");
  ok(ur.status === 200 && ur.j.rows[0][0] === "季节" && ur.j.encoding === "UTF-8", "UTF-8 编码的 CSV 正常");

  // 带图片的 Excel：图片会被忽略，文字数据照样解析出来
  const fs = require("fs"), path = require("path");
  const imgXlsx = fs.readFileSync(path.join(__dirname, "fixtures", "with-image.xlsx"));
  const ix = await parseUpload(aT, "带图.xlsx", imgXlsx, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  ok(ix.status === 200 && ix.j.rows.length >= 3, "带图片的 Excel 也能解析出数据行");
  ok(ix.j.rows[0].includes("货号") && ix.j.rows[1].includes("IMG-001"), "带图片 Excel 的表头和数据正确");

  ok((await parseUpload(aT, "x.pdf", Buffer.from("%PDF"), "application/pdf")).status === 400, "不支持的格式被拒绝");

  // 员工打卡记录
  ok((await call("GET","/users/"+chen.id+"/logs",aT)).status===200,"管理员可查员工打卡");
  ok((await call("GET","/users/"+chen.id+"/logs",fT)).status===403,"他人不可查别人打卡");
  ok((await call("GET","/users/"+boot.me.id+"/logs",aT)).status===200,"本人可查自己打卡");
  console.log(`\n结果：PASS ${pass}, FAIL ${fail}`); process.exit(fail?1:0);
})();
