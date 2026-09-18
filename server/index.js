"use strict";
const express = require("express");
const path = require("path");
const { seedIfEmpty, ensureDefaults, UPLOAD_DIR } = require("./db");
const api = require("./routes");

seedIfEmpty();
ensureDefaults();

const app = express();
app.use(express.json({ limit: "2mb" }));

app.use("/api", api);

// 上传文件：文件名随机可长缓存；nosniff，网页/脚本类文件一律不给打开
app.use("/uploads", (req, res, next) => {
  if (/\.(html?|xhtml|svg|xml|js|mjs)$/i.test(req.path)) return res.status(404).end();
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
}, express.static(UPLOAD_DIR, { maxAge: "30d", immutable: true }));

const PUBLIC = path.join(__dirname, "..", "public");
// Service Worker 和 manifest 不缓存，否则前端更新推不下去
app.get(["/sw.js", "/manifest.webmanifest"], (req, res, next) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  next();
});
app.use(express.static(PUBLIC));
// 单页应用兜底
app.get(/^\/(?!api|uploads).*/, (req, res) => res.sendFile(path.join(PUBLIC, "index.html")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "服务器出错" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`跟单系统已启动： http://localhost:${PORT}`));
