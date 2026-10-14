const BASE=(process.env.BASE_URL || "http://localhost:3000")+"/api"; let pass=0,fail=0;
const ok=(c,n)=>{if(c){pass++;console.log("PASS "+n);}else{fail++;console.log("FAIL "+n);}};
async function call(m,p,t,b){const h={"Content-Type":"application/json"};if(t)h.Authorization="Bearer "+t;
  const r=await fetch(BASE+p,{method:m,headers:h,body:b?JSON.stringify(b):undefined});
  let j=null;try{j=await r.json();}catch(e){} return {status:r.status,j};}
(async()=>{
  const aT=(await call("POST","/login",null,{phone:"13800000000",password:"123456"})).j.token;
  const u1=await call("POST","/users",aT,{name:"离职员工",phone:"13911112222",role:"follower"});
  ok(u1.status===200,"创建员工");
  ok((await call("POST","/users",aT,{name:"重复",phone:"13911112222",role:"sales"})).status===400,"在职时手机号不可重复");
  ok((await call("DELETE","/users/"+u1.j.id,aT)).status===200,"删除(离职)");
  const u2=await call("POST","/users",aT,{name:"返聘员工",phone:"13911112222",role:"sales"});
  ok(u2.status===200,"同一手机号可重新创建账号(返聘)");
  const lg=await call("POST","/login",null,{phone:"13911112222",password:"123456"});
  ok(lg.status===200&&lg.j.user.name==="返聘员工"&&lg.j.user.role==="sales","新账号能正常登录(不会命中已删除的旧账号)");

  // 离职员工：老订单上仍显示原名(不是一串 id)，也不再收到这些单的通知
  const q=await call("POST","/users",aT,{name:"离职业务员",phone:"13911113333",role:"sales"});
  const qo=await call("POST","/orders",aT,{season:"SS2027",values:{styleNo:"QUIT-1",sales:q.j.id}});
  ok((await call("DELETE","/users/"+q.j.id,aT)).status===200,"业务员离职");
  const bt=(await call("GET","/bootstrap",aT)).j;
  ok(!bt.users.some(u=>u.id===q.j.id),"离职的人不在员工名单里");
  const fu=(bt.formerUsers||[]).find(u=>u.id===q.j.id);
  ok(!!fu&&fu.name==="离职业务员"&&fu.phone===undefined,"启动数据带上离职员工的姓名(不带手机号)，老订单能显示原名");
  await call("PATCH","/orders/"+qo.j.id,aT,{values:{desc:"离职后改单"}});
  if(process.env.DATA_DIR){
    const {DatabaseSync}=require("node:sqlite");
    const db=new DatabaseSync(require("path").join(process.env.DATA_DIR,"daka.db"),{readOnly:true});
    ok(db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=?").get(q.j.id).c===0,"离职员工不再收到订单通知(也就不会推送到他手机上)");
    db.close();
  }
  // 选人字段改成文本：离职员工也换成姓名，不能把 id 写死进去
  const cf=(await call("POST","/fields",aT,{section:"order",label:"离职测试跟单",type:"user-staff"})).j.order.find(f=>f.label==="离职测试跟单");
  const q2=await call("POST","/users",aT,{name:"离职跟单",phone:"13911114444",role:"follower"});
  await call("PATCH","/orders/"+qo.j.id,aT,{values:{[cf.k]:q2.j.id}});
  await call("DELETE","/users/"+q2.j.id,aT);
  await call("PATCH",`/fields/order/${cf.k}`,aT,{type:"text"});
  ok((await call("GET","/orders/"+qo.j.id,aT)).j.values[cf.k]==="离职跟单","选人字段改成文本时，离职员工换成姓名而不是一串 id");
  await call("DELETE",`/fields/order/${cf.k}`,aT); await call("DELETE","/orders/"+qo.j.id,aT);  // 不影响后面的测试
  console.log(`\n结果：PASS ${pass}, FAIL ${fail}`); process.exit(fail?1:0);
})();
