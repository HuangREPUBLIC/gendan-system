"use strict";
// 私人聊天和聊天附件
const express = require("express");
const multer = require("multer");
const path = require("path");
const { db, uid, UPLOAD_DIR } = require("../db");
const A = require("../auth");
const P = require("../push");
const { activeUser } = require("./helpers");

const router = express.Router();

// 联系人：在职同事 + 最后一条消息 + 未读数；有记录的按时间排前
router.get("/chat/contacts", (req, res) => {
  const meId = req.user.id;
  const others = db.prepare("SELECT * FROM users WHERE deleted = 0 AND id <> ?").all(meId);
  const lastStmt = db.prepare(`SELECT * FROM messages
      WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
      ORDER BY created_at DESC LIMIT 1`);
  const unreadStmt = db.prepare("SELECT COUNT(*) c FROM messages WHERE from_user = ? AND to_user = ? AND read_at IS NULL");
  const list = others.map(u => {
    const last = lastStmt.get(meId, u.id, u.id, meId);
    return Object.assign(A.userPublic(u), {
      unread: unreadStmt.get(u.id, meId).c,
      last: last ? { text: last.text || (last.attachment ? "[附件]" : ""), t: last.created_at,
        fromMe: last.from_user === meId } : null
    });
  });
  list.sort((a, b) => {
    if (a.last && b.last) return b.last.t - a.last.t;
    if (a.last) return -1;
    if (b.last) return 1;
    return a.name.localeCompare(b.name, "zh");
  });
  res.json(list);
});

router.get("/chat/unread", (req, res) => {
  const rows = db.prepare("SELECT from_user, COUNT(*) c FROM messages WHERE to_user = ? AND read_at IS NULL GROUP BY from_user")
    .all(req.user.id);
  const byUser = {};
  let total = 0;
  rows.forEach(r => { byUser[r.from_user] = r.c; total += r.c; });
  res.json({ total, byUser });
});

// 打开对话即把对方消息标为已读
router.get("/chat/with/:userId", (req, res) => {
  const meId = req.user.id, otherId = req.params.userId;
  const other = activeUser(otherId);
  if (!other) return res.status(404).json({ error: "该同事不存在或已离职" });
  db.prepare("UPDATE messages SET read_at = ? WHERE from_user = ? AND to_user = ? AND read_at IS NULL")
    .run(Date.now(), otherId, meId);
  const msgs = db.prepare(`SELECT * FROM messages
      WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
      ORDER BY created_at ASC`).all(meId, otherId, otherId, meId);
  res.json({
    contact: A.userPublic(other),
    messages: msgs.map(m => ({ id: m.id, text: m.text, t: m.created_at, fromMe: m.from_user === meId,
      attachment: m.attachment ? JSON.parse(m.attachment) : null }))
  });
});

router.post("/chat/with/:userId", (req, res) => {
  const meId = req.user.id, otherId = req.params.userId;
  if (otherId === meId) return res.status(400).json({ error: "不能给自己发消息" });
  const other = activeUser(otherId);
  if (!other) return res.status(404).json({ error: "该同事不存在或已离职" });
  const text = String((req.body || {}).text || "").trim();
  const att = (req.body || {}).attachment || null;
  if (!text && !att) return res.status(400).json({ error: "消息不能为空" });
  if (text.length > 2000) return res.status(400).json({ error: "消息太长了" });
  db.prepare("INSERT INTO messages(id,from_user,to_user,text,attachment,created_at,read_at) VALUES(?,?,?,?,?,?,NULL)")
    .run(uid(), meId, otherId, text, att ? JSON.stringify(att) : null, Date.now());
  // tag 用发信人 id，连发只留最新一条通知
  P.sendToUsers([otherId], {
    title: req.user.name,
    body: text ? text.slice(0, 60) : "[图片]",
    url: `/?chat=${meId}`, tag: `chat-${meId}`
  });
  res.json({ ok: true });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, uid() + (path.extname(file.originalname || "").toLowerCase() || ".jpg"))
});

const OK_EXT = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic",
  ".pdf", ".xlsx", ".xls", ".csv", ".doc", ".docx", ".ppt", ".pptx", ".txt", ".zip"];
const chatUpload = multer({
  storage, limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, OK_EXT.includes(path.extname(file.originalname || "").toLowerCase()))
});
router.post("/chat/upload", chatUpload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "不支持的文件类型，或文件超过 20MB" });
  const name = Buffer.from(req.file.originalname || "文件", "latin1").toString("utf8");
  res.json({
    url: "/uploads/" + req.file.filename,
    name, size: req.file.size,
    isImage: /^image\//.test(req.file.mimetype)
  });
});

module.exports = router;
