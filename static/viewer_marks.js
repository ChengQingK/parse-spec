/* 句子高亮标记层：创建绝对定位的 mark 元素并维护“页码:句序”引用缓存。
   独立模块便于单独回收与回归测试；viewer.js 通过 parts 命名空间消费。 */
(function exposeViewerMarks(global) {
  "use strict";

  // “页码:句序” → 该句全部 mark 元素；跨页句按 locations 逐段命中。
  const markElementsByKey = new Map();

  function purgePageMarks(pageNum) {
    for (const key of [...markElementsByKey.keys()]) {
      if (Number(key.split(":")[0]) === pageNum) markElementsByKey.delete(key);
    }
  }

  function clearSentenceMarks() {
    markElementsByKey.clear();
  }

  function createSentenceMarks(wrap, targets) {
    const oldLayer = wrap.querySelector && wrap.querySelector(".sentence-mark-layer");
    if (oldLayer && oldLayer.remove) oldLayer.remove();
    // 该页的 mark 引用全部重建，先清掉旧缓存
    for (const target of targets || []) {
      markElementsByKey.delete(`${target.pageNum}:${target.sentenceIndex}`);
    }
    const layer = document.createElement("div");
    layer.className = "sentence-mark-layer";
    layer.setAttribute("aria-hidden", "true");
    for (const target of targets) {
      const marks = [];
      for (const rect of target.rects) {
        const mark = document.createElement("span");
        mark.className = "sentence-mark";
        mark.dataset.pageNumber = String(target.pageNum);
        mark.dataset.sentId = String(target.sentenceIndex);
        mark.style.left = `${rect.left}px`;
        mark.style.top = `${rect.top}px`;
        mark.style.width = `${rect.width}px`;
        mark.style.height = `${rect.height}px`;
        layer.appendChild(mark);
        marks.push(mark);
      }
      markElementsByKey.set(`${target.pageNum}:${target.sentenceIndex}`, marks);
    }
    wrap.appendChild(layer);
  }

  function toggleSentenceMarks(target, className, enabled) {
    if (!target) return;
    const locations = target.locations && target.locations.length
      ? target.locations
      : [{ pageNum: target.pageNum, sentenceIndex: target.sentenceIndex }];
    for (const location of locations) {
      const key = `${Number(location.pageNum)}:${Number(location.sentenceIndex)}`;
      const cached = markElementsByKey.get(key);
      if (cached) {
        for (const mark of cached) mark.classList.toggle(className, enabled);
        continue;
      }
      if (!document.querySelectorAll) continue;
      const selector = `.sentence-mark[data-page-number="${Number(location.pageNum)}"][data-sent-id="${Number(location.sentenceIndex)}"]`;
      for (const mark of document.querySelectorAll(selector)) mark.classList.toggle(className, enabled);
    }
  }

  function addClassToSpans(target, className) {
    if (!target || !target.spans) return;
    for (const span of target.spans) span.classList.add(className);
    toggleSentenceMarks(target, className, true);
  }

  function removeClassFromSpans(target, className) {
    if (!target || !target.spans) return;
    for (const span of target.spans) span.classList.remove(className);
    toggleSentenceMarks(target, className, false);
  }

  global.__parseSpecViewerParts = Object.assign(global.__parseSpecViewerParts || {}, {
    addClassToSpans,
    clearSentenceMarks,
    createSentenceMarks,
    purgePageMarks,
    removeClassFromSpans,
    toggleSentenceMarks,
  });
}(globalThis));
