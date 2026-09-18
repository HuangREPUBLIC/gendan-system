#!/usr/bin/env node
"use strict";
/* 正式启用前初始化：清空员工、订单、聊天和上传图片，只留一个管理员。
 * 用法：npm run init-admin -- --name 姓名 --phone 手机号 [--password 密码] [--keep-orders 保留订单] */
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { db, uid, getSetting, setSetting, seedIfEmpty, ensureDefaults, UPLOAD_DIR } = require("../server/db");
const { hashPassword } = require("../server/auth");

const args = process.argv.slice(2);
const get = (k) => { const i = args.indexOf("--" + k); return i >= 0 ? args[i + 1] : null; };
const has = (k) => args.includes("--" + k);

const name = get("name");
const phone = get("phone");
const password = get("password") || "123456";
const keepOrders = has("keep-orders");

if (!name || !phone) {
  console.error("用法：npm run init-admin -- --name 姓名 --phone 手机号 [--password 密码] [--keep-orders]");
  process.exit(1);
}
if (!/^\d{6,20}$/.test(phone)) {
  console.error("手机号格式不对：" + phone);
  process.exit(1);
}

seedIfEmpty();
ensureDefaults();

const counts = {
  users: db.prepare("SELECT COUNT(*) c FROM users").get().c,
  orders: db.prepare("SELECT COUNT(*) c FROM orders").get().c,
  messages: db.prepare("SELECT COUNT(*) c FROM messages").get().c
};

console.log("\n即将执行：");
console.log(`  · 删除全部 ${counts.users} 个账号，新建管理员「${name}」(${phone})`);
console.log(`  · ${keepOrders ? `保留现有 ${counts.orders} 个订单` : `删除全部 ${counts.orders} 个订单`}`);
console.log(`  · 删除全部 ${counts.messages} 条聊天记录`);
console.log(`  · 初始密码：${password}${password === "123456" ? "（登录后请立刻修改）" : ""}`);
console.log("  · 职位、自定义字段、工厂选项等配置保留\n");

function run() {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM users").run();
    db.prepare("DELETE FROM messages").run();
    if (!keepOrders) db.prepare("DELETE FROM orders").run();
    db.prepare("INSERT INTO users(id,name,phone,password_hash,role,deleted,created_at) VALUES(?,?,?,?,?,0,?)")
      .run(uid(), name, phone, hashPassword(password), "admin", Date.now());
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }

  if (!keepOrders) {
    try {
      fs.readdirSync(UPLOAD_DIR).forEach(f => fs.rmSync(path.join(UPLOAD_DIR, f), { force: true }));
    } catch (e) {}
  }
  console.log(`✓ 完成。现在用 ${phone} / ${password} 登录，只有这一个管理员账号。`);
  console.log("  下一步：登录 →「管理后台」创建员工 →「我的账号」修改密码。\n");
}

if (has("yes")) { run(); process.exit(0); }
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question("确认执行？此操作不可恢复 (输入 yes 继续): ", a => {
  rl.close();
  if (a.trim().toLowerCase() !== "yes") { console.log("已取消，没有改动任何数据。"); process.exit(0); }
  run();
});
