"use strict";

// 图片拖进或粘贴到照片框(粘贴进最近点过的那个)；表格文件拖到导入区
(function setupPhotoDropPaste() {
  let lastCtx = null;
  const gridOf = t => t && t.closest ? t.closest(".photos-grid[data-ctx]") : null;
  const impOf = t => t && t.closest ? t.closest('[data-drop="import"]') : null;
  document.addEventListener("pointerdown", e => { const g = gridOf(e.target); if (g) lastCtx = g.dataset.ctx; }, true);
  document.addEventListener("dragover", e => {
    e.preventDefault();  // 阻止浏览器直接打开拖进来的文件
    const g = gridOf(e.target) || impOf(e.target); if (g) g.classList.add("drop");
  });
  document.addEventListener("dragleave", e => { const g = gridOf(e.target) || impOf(e.target); if (g && !g.contains(e.relatedTarget)) g.classList.remove("drop"); });
  document.addEventListener("drop", e => {
    e.preventDefault();
    const g = gridOf(e.target), imp = impOf(e.target);
    document.querySelectorAll(".photos-grid.drop, .imp-drop.drop").forEach(x => x.classList.remove("drop"));
    const files = e.dataTransfer ? [...e.dataTransfer.files] : [];
    if (g) { lastCtx = g.dataset.ctx; A.queuePhotos(g.dataset.ctx, files); }
    else if (imp && files[0]) A.importFileObj(files[0]);
  });
  document.addEventListener("paste", e => {
    const files = [...((e.clipboardData && e.clipboardData.files) || [])].filter(looksLikeImage);
    if (!files.length) return;
    const grids = [...document.querySelectorAll(".photos-grid[data-ctx]")].filter(g => g.offsetParent);
    const g = grids.find(x => x.dataset.ctx === lastCtx) || (grids.length === 1 ? grids[0] : null);
    if (!g) return;
    e.preventDefault(); A.queuePhotos(g.dataset.ctx, files);
  });
})();
