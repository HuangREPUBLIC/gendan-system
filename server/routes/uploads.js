"use strict";
// 订单照片上传
const express = require("express");
const multer = require("multer");
const { uid, UPLOAD_DIR } = require("../db");
const { PHOTO_EXT } = require("./helpers");

const router = express.Router();

const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, uid() + PHOTO_EXT[file.mimetype])
});
const upload = multer({
  storage: photoStorage, limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, !!PHOTO_EXT[file.mimetype])
});
router.post("/upload", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "只支持 JPG / PNG / GIF / WebP 格式的图片" });
  res.json({ url: "/uploads/" + req.file.filename });
});

module.exports = router;
