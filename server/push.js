"use strict";
/* 系统推送(Web Push)：只管投递，谁该收到由 routes.js 决定。
 * iOS 需添加到主屏幕、微信内不支持、部分安卓不稳定，所以页面内红点轮询仍保留 */
const fs = require("fs");
const path = require("path");
const webpush = require("web-push");
const { db, uid, DATA_DIR } = require("./db");

// VAPID 密钥首次启动生成并持久化；换密钥会让所有订阅作废
function loadKeys() {
  const p = path.join(DATA_DIR, ".vapid.json");
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) {
    const keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(p, JSON.stringify(keys), { mode: 0o600 });
    console.log("[push] 已生成 VAPID 密钥");
    return keys;
  }
}
const KEYS = loadKeys();
webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@glorytianjin.com",
  KEYS.publicKey, KEYS.privateKey);

const publicKey = () => KEYS.publicKey;

// 同一设备重复订阅按 endpoint 覆盖
function saveSubscription(userId, sub, ua) {
  const endpoint = String((sub || {}).endpoint || "");
  const keys = (sub || {}).keys || {};
  if (!endpoint || !keys.p256dh || !keys.auth) return false;
  db.prepare(`INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth,ua,created_at,fail_count)
    VALUES(?,?,?,?,?,?,?,0)
    ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh,
      auth=excluded.auth, ua=excluded.ua, fail_count=0`)
    .run(uid(), userId, endpoint, keys.p256dh, keys.auth, String(ua || "").slice(0, 200), Date.now());
  return true;
}
function removeSubscription(endpoint) {
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(String(endpoint || ""));
}
const subscriptionsOf = (userId) =>
  db.prepare("SELECT * FROM push_subscriptions WHERE user_id = ?").all(userId);
const countOf = (userId) =>
  db.prepare("SELECT COUNT(*) c FROM push_subscriptions WHERE user_id = ?").get(userId).c;

const MAX_FAIL = 3;  // 连续失败达到次数就清掉订阅

// 失败不抛错，推送不能影响主流程
async function sendOne(row, payload) {
  const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
    db.prepare("UPDATE push_subscriptions SET fail_count = 0, last_ok_at = ? WHERE endpoint = ?")
      .run(Date.now(), row.endpoint);
  } catch (e) {
    // 410/404：订阅已永久失效
    if (e && (e.statusCode === 410 || e.statusCode === 404)) {
      removeSubscription(row.endpoint);
      return;
    }
    // 其它错误累计次数，避免一次抖动就丢订阅
    const n = (row.fail_count || 0) + 1;
    if (n >= MAX_FAIL) removeSubscription(row.endpoint);
    else db.prepare("UPDATE push_subscriptions SET fail_count = ? WHERE endpoint = ?").run(n, row.endpoint);
  }
}

/* 推给若干用户的所有设备。payload: { title, body, url, tag }，同 tag 互相覆盖。
 * 调用方无需 await */
async function sendToUsers(userIds, payload) {
  try {
    const ids = [...new Set((userIds || []).filter(Boolean))];
    if (!ids.length) return;
    await Promise.all(ids.flatMap(subscriptionsOf).map(r => sendOne(r, payload)));
  } catch (e) { console.error("[push] 发送失败", e); }
}

module.exports = { publicKey, saveSubscription, removeSubscription, countOf, sendToUsers };
