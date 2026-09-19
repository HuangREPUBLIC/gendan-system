"use strict";
// 按 index.html 里 <script src> 的顺序，把前端脚本逐个注入 jsdom，和浏览器的加载方式一致
const fs = require("fs");
const path = require("path");

const PUBLIC = path.join(__dirname, "..", "public");

// index.html 里本站脚本的路径，按加载顺序
function frontendScripts() {
  const html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  return [...html.matchAll(/<script src="(\/[^"]+\.js)"><\/script>/g)].map(m => m[1]);
}

function loadFrontend(win) {
  for (const src of frontendScripts()) {
    const sc = win.document.createElement("script");
    sc.textContent = fs.readFileSync(path.join(PUBLIC, src), "utf8");
    win.document.body.appendChild(sc);
  }
}

module.exports = { frontendScripts, loadFrontend };
