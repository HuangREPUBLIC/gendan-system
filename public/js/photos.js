"use strict";
// 照片：选择、压缩、上传队列、缩略图

let photoDraft = {};  // { ctx: [url] } 表单里正在编辑的照片

function normalizePhotos(v) {
  if (Array.isArray(v)) return v.filter(x => typeof x === "string" && x);
  if (typeof v === "string" && v) return [v];
  return [];
}
const PHOTO_MAX_EDGE = 2000;
const PHOTO_MAX_BYTES = 8 * 1024 * 1024;  // 同服务端单张上限
const PHOTO_MAX_PER_PICKER = 30;
function isHeic(file) { return /hei[cf]/i.test(file.type || "") || /\.hei[cf]$/i.test(file.name || ""); }
// 部分安卓选出的文件 type 为空，再看扩展名
function looksLikeImage(file) {
  return !!file && (/^image\//.test(file.type || "") || /\.(jpe?g|png|gif|webp|hei[cf]|bmp)$/i.test(file.name || ""));
}
// 优先 createImageBitmap(按 EXIF 摆正)，不支持再用 <img>；不读成 base64，避免低端机内存爆
async function decodeImage(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) { /* 走下面的兜底 */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = url; });
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
}
// 压缩成 JPEG：顺带去掉 GPS 等 EXIF；透明 PNG 铺白底；用完清空画布(iOS 画布内存有上限)。GIF 保留原图
async function compressImage(file) {
  if (!looksLikeImage(file)) throw { error: "只能上传图片", noRetry: true };
  if (/gif$/i.test(file.type || "")) {
    if (file.size > PHOTO_MAX_BYTES) throw { error: "GIF 动图不能超过 8MB", noRetry: true };
    return file;
  }
  let src;
  try { src = await decodeImage(file); }
  catch (e) {
    throw { noRetry: true, error: isHeic(file)
      ? "这张是 HEIC 格式照片，当前浏览器打不开。请把相机的照片格式改成「兼容性最佳 / JPG」，或截图后再传"
      : "这张图片打不开，可能已损坏或格式不支持" };
  }
  const w0 = src.width, h0 = src.height;
  const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, w, h);
  if (src.close) src.close();
  const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.85));
  c.width = c.height = 0;
  if (blob) return blob;
  if (file.size <= PHOTO_MAX_BYTES && !isHeic(file)) return file;  // 个别浏览器 toBlob 失败时原图直传
  throw { error: "图片处理失败，请换一张试试", noRetry: true };
}
function xhrUpload(url, fd, { timeout, onProgress, holder } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (holder) holder.xhr = xhr;
    xhr.open("POST", url);
    xhr.setRequestHeader("Authorization", "Bearer " + state.token);
    if (timeout) xhr.timeout = timeout;
    if (xhr.upload && onProgress) xhr.upload.onprogress = e => onProgress(e.lengthComputable && e.total ? e.loaded / e.total : null);
    xhr.onload = () => {
      let j = null; try { j = JSON.parse(xhr.responseText); } catch (e) { }
      if (xhr.status >= 200 && xhr.status < 300 && j) return resolve(j);
      reject({ error: (j && j.error) || `上传失败(${xhr.status})`, fatal: xhr.status >= 400 && xhr.status < 500 });
    };
    xhr.onerror = () => reject({ error: "网络出错，上传失败" });
    xhr.ontimeout = () => reject({ error: "上传超时，网络太慢" });
    xhr.onabort = () => reject({ error: "已取消", aborted: true });
    xhr.send(fd);
  });
}
async function uploadBlob(blob, onProgress, holder) {
  const ext = blob.type === "image/gif" ? "gif" : blob.type === "image/png" ? "png" : "jpg";
  const fd = new FormData(); fd.append("image", blob, "photo." + ext);
  const j = await xhrUpload("/api/upload", fd, { timeout: 20000 + Math.ceil(blob.size / 102400) * 2000,
    onProgress: onProgress && (p => { if (p != null) onProgress(p); }), holder });
  if (!j.url) throw { error: "上传失败" };
  return j.url;
}
// 网络错误自动重试一次
async function uploadWithRetry(blob, onProgress, holder) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    if (holder && holder.removed) throw { error: "已取消", aborted: true };
    try { return await uploadBlob(blob, onProgress, holder); }
    catch (e) { lastErr = e; if (e.fatal || e.aborted) break; }
  }
  throw lastErr;
}
async function uploadOnePhoto(file) { return uploadWithRetry(await compressImage(file)); }

/* ---------- 上传队列 ----------
 * 选完先出本地预览和进度条，失败的格子可重试；
 * 压缩串行(低端机内存)，上传并发 3 张；按选择顺序落位 */
let photoPending = {};
const photoPreviewOf = {};  // 刚传完的照片用本地预览显示，不再下载
let photoSeq = 0, compressChain = Promise.resolve();
let upActive = 0; const upWaiters = [];
async function upSlot() { if (upActive < 3) { upActive++; return; } await new Promise(r => upWaiters.push(r)); }
function upRelease() { const next = upWaiters.shift(); if (next) next(); else upActive--; }

function repaintPicker(ctx) { const el = $("pe-" + ctx); if (el) el.innerHTML = pickerInner(ctx); }
function flushPending(ctx) {
  const pend = photoPending[ctx] || [];
  photoDraft[ctx] = photoDraft[ctx] || [];
  while (pend.length && pend[0].status === "done") {
    const it = pend.shift();
    if (it.preview) photoPreviewOf[it.url] = it.preview;
    photoDraft[ctx].push(it.url);
  }
  if (!pend.length) delete photoPending[ctx];
  repaintPicker(ctx);
}
async function processPhoto(ctx, it) {
  try {
    it.status = "work"; repaintPicker(ctx);
    if (!it.blob) {
      const job = compressChain.then(() => it.removed ? null : compressImage(it.file));
      compressChain = job.catch(() => { });
      it.blob = await job;
      if (it.removed || !it.blob) return;
      it.file = null;
      it.preview = URL.createObjectURL(it.blob);
      repaintPicker(ctx);
    }
    await upSlot();
    try {
      if (it.removed) return;
      it.status = "up"; it.pct = 0; repaintPicker(ctx);
      it.url = await uploadWithRetry(it.blob, p => {
        it.pct = p;
        const bar = document.querySelector(`#pp-${it.id} .ph-bar i`);
        if (bar) bar.style.width = Math.round(p * 100) + "%";
      }, it);
    } finally { upRelease(); }
    it.status = "done";
  } catch (e) {
    if (it.removed) return;
    it.status = "err"; it.err = (e && e.error) || "上传失败"; it.noRetry = !!(e && e.noRetry);
    toast(it.err);
  }
  if (!it.removed) flushPending(ctx);
}
// 照片没传完或有失败时不许保存
function photosBusyMsg(test) {
  const match = k => typeof test === "string" ? k === test : test.test(k);
  const items = Object.keys(photoPending).filter(match).flatMap(k => photoPending[k]);
  if (items.some(it => it.status === "err")) return "有照片上传失败，请点「重试」或删掉后再保存";
  if (items.length) return "照片还在上传，请稍等几秒再保存";
  return "";
}
const photosBlocked = test => { const m = photosBusyMsg(test); if (m) toast(m); return !!m; };
function resetPhotoPending() {
  Object.values(photoPending).flat().forEach(it => { it.removed = true; if (it.xhr) it.xhr.abort(); });
  photoPending = {};
}

// 缩略图；可编辑时带删除叉，款式图第一张标「封面」
function photoThumbs(urls, editable, ctx) {
  const gallery = esc(JSON.stringify(urls));
  const cover = editable && urls.length > 1 && /(^|-)img$/.test(ctx || "");
  return urls.map((u, i) => `<div class="ph-thumb">
    <img src="${esc(photoPreviewOf[u] || u)}" alt="照片 ${i + 1}" loading="lazy" decoding="async"
      data-gallery="${gallery}" data-i="${i}" onclick="A.lightboxFromEl(this)">
    ${cover && i === 0 ? `<span class="ph-cover">封面</span>` : ""}
    ${editable ? `<button type="button" class="ph-x" aria-label="删除第 ${i + 1} 张照片" onclick="A.removeDraftPhoto('${ctx}',${i})">✕</button>` : ""}</div>`).join("");
}
function pendingTile(ctx, it) {
  const err = it.status === "err";
  return `<div class="ph-thumb ph-pending${err ? " is-err" : ""}" id="pp-${it.id}">
    ${it.preview ? `<img src="${it.preview}" alt="">` : `<span class="ph-skel"></span>`}
    ${err ? (it.noRetry ? `<span class="ph-errmsg" title="${esc(it.err)}">无法上传</span>`
          : `<button type="button" class="ph-retry" title="${esc(it.err)}" onclick="A.retryPhoto('${ctx}',${it.id})">${PHOTO_ICONS.retry}<span>重试</span></button>`)
      : `<span class="ph-bar" aria-label="上传中"><i style="width:${Math.round((it.pct || 0) * 100)}%"></i></span>`}
    <button type="button" class="ph-x" aria-label="取消这张照片" onclick="A.cancelPhoto('${ctx}',${it.id})">✕</button></div>`;
}
const PHOTO_ICONS = {
  camera: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.2-1.8A1.5 1.5 0 0 1 10 4.5h4a1.5 1.5 0 0 1 1.3.7L16.5 7h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.5" r="3.3"/></svg>`,
  album: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 15.5 16 11l-7.5 8.5"/></svg>`,
  retry: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></svg>`,
  save: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>`
};
// 拍照和相册分成两个入口：部分手机(华为)在 multiple 时会隐藏拍照；图标用 SVG，emoji 在安卓上不统一
function pickerInner(ctx) {
  const list = photoDraft[ctx] || [], pend = photoPending[ctx] || [];
  const full = list.length + pend.length >= PHOTO_MAX_PER_PICKER;
  return photoThumbs(list, true, ctx) + pend.map(it => pendingTile(ctx, it)).join("") + (full ? "" :
    `<label class="ph-add"><input type="file" accept="image/*" capture="environment" hidden onchange="A.addDraftPhotos('${ctx}',this)">
      <span class="ph-ic">${PHOTO_ICONS.camera}</span><span>拍照</span></label>` +
    `<label class="ph-add"><input type="file" accept="image/*" multiple hidden onchange="A.addDraftPhotos('${ctx}',this)">
      <span class="ph-ic">${PHOTO_ICONS.album}</span><span>相册</span></label>`);
}
function photoPicker(ctx) { return `<div class="photos-grid" id="pe-${ctx}" data-ctx="${ctx}">${pickerInner(ctx)}</div>`; }
function coverImgHtml(photos, cls) {
  if (!photos.length) return "";
  return `<img src="${esc(photoPreviewOf[photos[0]] || photos[0])}" alt="款式图"${cls ? ` class="${cls}"` : ""} loading="lazy" decoding="async"
    data-gallery="${esc(JSON.stringify(photos))}" data-i="0" onclick="event.stopPropagation();A.lightboxFromEl(this)">`;
}
function photoGallery(urls) {
  urls = normalizePhotos(urls);
  if (!urls.length) return "";
  return `<div class="photos-grid ro">${photoThumbs(urls, false)}</div>`;
}

/* 改一条记录的文字和照片(打卡、验货、跟单小结共用)。
 * opts: title, ctx(照片草稿键), text(undefined 表示没有文字框), photos, extraHtml, collect()->额外字段或错误文字,
 *       allowEmpty(文字和照片都空也能存), save(body)->Promise */
function editEntryModal(opts) {
  const ctx = opts.ctx;
  // 关弹窗(保存或取消)时丢掉这次的草稿和没传完的照片
  const cleanup = () => {
    (photoPending[ctx] || []).forEach(it => { it.removed = true; if (it.xhr) it.xhr.abort(); });
    delete photoPending[ctx]; delete photoDraft[ctx];
  };
  photoDraft[ctx] = normalizePhotos(opts.photos).slice();
  const hasText = opts.text !== undefined;
  modal({ title: opts.title, okText: "保存", wide: true, keepOpenOnOk: true, onCancel: cleanup,
    html: `${opts.extraHtml || ""}${hasText ? `<textarea class="in" id="ee-text" placeholder="填写内容"
      style="margin-top:8px;min-height:90px">${esc(opts.text || "")}</textarea>` : ""}
      <div class="ee-photos-label">照片 · 点 ✕ 删除，点「拍照」「相册」添加</div>${photoPicker(ctx)}`,
    onOk: async () => {
      if (photosBlocked(ctx)) return;
      const body = { photos: photoDraft[ctx] || [] };
      if (hasText) body.text = $("ee-text").value.trim();
      const extra = opts.collect ? opts.collect() : {};
      if (typeof extra === "string") return toast(extra);
      Object.assign(body, extra);
      if (!opts.allowEmpty && hasText && !body.text && !body.photos.length) return toast("内容和照片不能都为空");
      A.modalCancel();
      await run(() => opts.save(body), "已修改");
    } });
}

Object.assign(A, {
  addDraftPhotos(ctx, input) {
    const files = [...(input.files || [])]; input.value = "";
    A.queuePhotos(ctx, files);
  },
  queuePhotos(ctx, files) {
    if (!files.length) return;
    photoDraft[ctx] = photoDraft[ctx] || [];
    const pend = photoPending[ctx] = photoPending[ctx] || [];
    const imgs = files.filter(looksLikeImage);
    const room = Math.max(0, PHOTO_MAX_PER_PICKER - photoDraft[ctx].length - pend.length);
    if (imgs.length < files.length) toast("已跳过不是图片的文件");
    else if (imgs.length > room) toast(`每处最多 ${PHOTO_MAX_PER_PICKER} 张，多出的 ${imgs.length - room} 张没有添加`);
    imgs.slice(0, room).forEach(file => {
      const it = { id: ++photoSeq, status: "wait", pct: 0, file };
      pend.push(it); processPhoto(ctx, it);
    });
    if (!pend.length) delete photoPending[ctx];
    repaintPicker(ctx);
  },
  retryPhoto(ctx, id) {
    const it = (photoPending[ctx] || []).find(x => x.id === id);
    if (!it || it.status !== "err") return;
    it.status = "wait"; it.err = ""; processPhoto(ctx, it);
  },
  cancelPhoto(ctx, id) {
    const pend = photoPending[ctx] || [], k = pend.findIndex(x => x.id === id);
    if (k < 0) return;
    const it = pend[k]; it.removed = true;
    if (it.xhr) it.xhr.abort();
    if (it.preview) URL.revokeObjectURL(it.preview);
    pend.splice(k, 1);
    flushPending(ctx);  // 前面卡住的删掉后，后面传完的可以落位
  },
  removeDraftPhoto(ctx, i) {
    if (photoDraft[ctx]) { photoDraft[ctx].splice(i, 1); repaintPicker(ctx); }
  },
});
