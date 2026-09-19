"use strict";
// 应用内通知、系统推送订阅（投递见 push.js）
const express = require("express");
const { db } = require("../db");
const P = require("../push");

const router = express.Router();

const NOTIF_LIMIT = 50;

router.get("/notifications", (req, res) => {
  const rows = db.prepare(`SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ${NOTIF_LIMIT}`)
    .all(req.user.id);
  // actorName/orderLabel/what 老通知为 NULL，前端退回纯文本
  res.json(rows.map(r => ({
    id: r.id, orderId: r.order_id, text: r.text, createdAt: r.created_at, read: !!r.read_at,
    actorName: r.actor_name, orderLabel: r.order_label, what: r.what
  })));
});

router.get("/notifications/unread-count", (req, res) => {
  const c = db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND read_at IS NULL").get(req.user.id).c;
  res.json({ total: c });
});

router.post("/notifications/read-all", (req, res) => {
  db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(Date.now(), req.user.id);
  res.json({ ok: true });
});

function ownNotif(req, res) {
  const row = db.prepare("SELECT * FROM notifications WHERE id = ?").get(req.params.id);
  if (!row) res.status(404).json({ error: "通知不存在" });
  else if (row.user_id !== req.user.id) res.status(403).json({ error: "无权操作这条通知" });
  else return row;
}
router.post("/notifications/:id/read", (req, res) => {
  const row = ownNotif(req, res); if (!row) return;
  if (!row.read_at) db.prepare("UPDATE notifications SET read_at = ? WHERE id = ?").run(Date.now(), row.id);
  res.json({ ok: true });
});

// ?read=1 清空自己的已读通知
router.delete("/notifications", (req, res) => {
  if (req.query.read !== "1") return res.status(400).json({ error: "只支持清空已读通知" });
  const r = db.prepare("DELETE FROM notifications WHERE user_id = ? AND read_at IS NOT NULL").run(req.user.id);
  res.json({ ok: true, deleted: r.changes });
});

router.delete("/notifications/:id", (req, res) => {
  const row = ownNotif(req, res); if (!row) return;
  db.prepare("DELETE FROM notifications WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

router.get("/push/key", (req, res) => res.json({ publicKey: P.publicKey() }));

router.post("/push/subscribe", (req, res) => {
  const ok = P.saveSubscription(req.user.id, (req.body || {}).subscription, req.headers["user-agent"]);
  if (!ok) return res.status(400).json({ error: "订阅信息不完整" });
  res.json({ ok: true, devices: P.countOf(req.user.id) });
});

// 只能退订自己的设备
router.post("/push/unsubscribe", (req, res) => {
  const endpoint = String((req.body || {}).endpoint || "");
  const row = db.prepare("SELECT user_id FROM push_subscriptions WHERE endpoint = ?").get(endpoint);
  if (row && row.user_id !== req.user.id) return res.status(403).json({ error: "无权操作这个订阅" });
  P.removeSubscription(endpoint);
  res.json({ ok: true, devices: P.countOf(req.user.id) });
});

module.exports = router;
