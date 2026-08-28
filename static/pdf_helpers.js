/* PDF 阅读区使用的纯辅助函数；独立于 DOM，便于回归测试。 */
(function exposePdfHelpers(global) {
  "use strict";

  function buildSentenceLineRects(sentence, rowTolerance = 11.2) {
    const rows = [];
    for (const word of sentence || []) {
      if (!word || ![word.x0, word.x1, word.y0, word.y1].every(Number.isFinite)) continue;
      let row = rows.find((candidate) => Math.abs(candidate.y - word.y0) < rowTolerance);
      if (!row) {
        row = { y: word.y0, x0: word.x0, x1: word.x1, y0: word.y0, y1: word.y1 };
        rows.push(row);
      } else {
        row.x0 = Math.min(row.x0, word.x0);
        row.x1 = Math.max(row.x1, word.x1);
        row.y0 = Math.min(row.y0, word.y0);
        row.y1 = Math.max(row.y1, word.y1);
      }
    }
    rows.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    return rows.map((row) => ({
      left: Math.max(0, row.x0 - 1),
      top: Math.max(0, row.y0 - 1),
      width: Math.max(1, row.x1 - row.x0 + 2),
      height: Math.max(1, row.y1 - row.y0 + 2),
    }));
  }

  function mergeNearbyRects(rects, rowTolerance = 3, gapTolerance = 4) {
    const ordered = (rects || [])
      .filter((rect) => rect && [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0)
      .map((rect) => ({ ...rect }))
      .sort((a, b) => a.top - b.top || a.left - b.left);
    const merged = [];
    for (const rect of ordered) {
      const previous = merged[merged.length - 1];
      const sameRow = previous
        && Math.abs(previous.top - rect.top) <= rowTolerance
        && Math.abs((previous.top + previous.height) - (rect.top + rect.height)) <= rowTolerance;
      const gap = previous ? rect.left - (previous.left + previous.width) : Number.POSITIVE_INFINITY;
      if (sameRow && gap >= -1 && gap <= gapTolerance) {
        const right = Math.max(previous.left + previous.width, rect.left + rect.width);
        const bottom = Math.max(previous.top + previous.height, rect.top + rect.height);
        previous.left = Math.min(previous.left, rect.left);
        previous.top = Math.min(previous.top, rect.top);
        previous.width = right - previous.left;
        previous.height = bottom - previous.top;
      } else {
        merged.push(rect);
      }
    }
    return merged;
  }

  function buildSentenceDomRects(sentence, textDivs, wrapRect, pageWidth, pageHeight, rangeFactory = null, visualScale = 1) {
    if (!sentence || !sentence.length || !textDivs || !textDivs.length || !wrapRect) return [];
    const rangesByItem = new Map();
    for (const word of sentence) {
      if (!Number.isInteger(word.itemIndex) || !Number.isInteger(word.charStart) || !Number.isInteger(word.charEnd)) continue;
      const previous = rangesByItem.get(word.itemIndex);
      if (previous) {
        previous.start = Math.min(previous.start, word.charStart);
        previous.end = Math.max(previous.end, word.charEnd);
      } else {
        rangesByItem.set(word.itemIndex, { start: word.charStart, end: word.charEnd });
      }
    }
    const createRange = rangeFactory || (global.document && typeof global.document.createRange === "function"
      ? () => global.document.createRange()
      : null);
    if (!createRange) return [];

    const rects = [];
    const scale = Number.isFinite(Number(visualScale)) && Number(visualScale) > 0 ? Number(visualScale) : 1;
    for (const [itemIndex, offsets] of rangesByItem) {
      const span = textDivs[itemIndex];
      const node = span && span.firstChild;
      if (!node || typeof node.textContent !== "string") continue;
      const length = node.textContent.length;
      const start = Math.max(0, Math.min(length, offsets.start));
      const end = Math.max(start, Math.min(length, offsets.end));
      if (start === end) continue;
      let range;
      try {
        range = createRange();
        range.setStart(node, start);
        range.setEnd(node, end);
        for (const clientRect of range.getClientRects()) {
          // DOMRect 是缩放后的视口坐标；标记层样式需要页面自身的未缩放坐标。
          // 若直接把前者写回已缩放页面，会产生二次缩放，导致点击句子后仍保留旧分析结果。
          const left = Math.max(0, (clientRect.left - wrapRect.left) / scale);
          const top = Math.max(0, (clientRect.top - wrapRect.top) / scale);
          const right = Math.min(pageWidth, (clientRect.right - wrapRect.left) / scale);
          const bottom = Math.min(pageHeight, (clientRect.bottom - wrapRect.top) / scale);
          if (right > left && bottom > top) rects.push({ left, top, width: right - left, height: bottom - top });
        }
      } catch (_ignored) {
        // 某些损坏 PDF 会让文本节点与 TextItem 的字符数不一致，交给坐标回退。
      } finally {
        if (range && typeof range.detach === "function") range.detach();
      }
    }
    return mergeNearbyRects(rects);
  }

  function targetAtPoint(targets, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const matches = [];
    for (const target of targets || []) {
      for (const rect of target.rects || []) {
        if (x < rect.left || x > rect.left + rect.width || y < rect.top || y > rect.top + rect.height) continue;
        const area = rect.width * rect.height;
        const centerDistance = Math.abs(x - (rect.left + rect.width / 2)) + Math.abs(y - (rect.top + rect.height / 2));
        matches.push({ target, area, centerDistance });
      }
    }
    matches.sort((a, b) => a.area - b.area || a.centerDistance - b.centerDistance);
    return matches.length ? matches[0].target : null;
  }

  async function resolvePdfDestination(pdf, destination) {
    if (!pdf || !destination) return null;
    let explicit = destination;
    if (typeof explicit === "string") explicit = await pdf.getDestination(explicit);
    if (!Array.isArray(explicit) || !explicit.length) return null;
    const pageRef = explicit[0];
    let pageIndex = null;
    if (Number.isInteger(pageRef)) pageIndex = pageRef;
    else {
      try {
        pageIndex = await pdf.getPageIndex(pageRef);
      } catch (_ignored) {
        return null;
      }
    }
    if (!Number.isInteger(pageIndex) || pageIndex < 0) return null;
    const kindValue = explicit[1];
    const kind = typeof kindValue === "string" ? kindValue : String(kindValue && kindValue.name || "Fit");
    return { pageNum: pageIndex + 1, kind, args: explicit.slice(2), explicit };
  }

  async function resolveOutlinePage(pdf, destination) {
    const resolved = await resolvePdfDestination(pdf, destination);
    return resolved ? resolved.pageNum : null;
  }

  // 命中滚动位置所在的页：返回第一个 bottom > scrollTop + bias 的页（0-based）。
  // tops/heights 为未缩放页面坐标，调用方自行把滚动偏移除以缩放倍率。
  function pageIndexAtScroll(tops, heights, scrollTop, bias = 8) {
    const count = Math.min((tops || []).length, (heights || []).length);
    if (!count) return 0;
    const target = (Number(scrollTop) || 0) + bias;
    let low = 0;
    let high = count - 1;
    let answer = count - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (tops[mid] + heights[mid] > target) {
        answer = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return answer;
  }

  // 含 margin 的可见页区间（1-based 页码，闭区间），供页面虚拟化调度。
  function visiblePageRange(tops, heights, scrollTop, viewHeight, margin = 0) {
    const count = Math.min((tops || []).length, (heights || []).length);
    if (!count) return { start: 1, end: 0 };
    const top = (Number(scrollTop) || 0) - Math.max(0, margin);
    const bottom = (Number(scrollTop) || 0) + (Number(viewHeight) || 0) + Math.max(0, margin);
    const start = pageIndexAtScroll(tops, heights, Math.max(0, top), 0);
    const end = pageIndexAtScroll(tops, heights, Math.max(0, bottom), 0);
    return { start: start + 1, end: end + 1 };
  }

  // canvas 渲染倍率封顶：同时限制最大倍率与总像素，避免低端设备内存暴涨。
  function fitCanvasScale(widthPt, heightPt, desiredScale, { maxScale = 3.2, maxPixels = 16e6 } = {}) {
    const width = Number(widthPt) || 0;
    const height = Number(heightPt) || 0;
    let scale = Number.isFinite(Number(desiredScale)) && Number(desiredScale) > 0 ? Number(desiredScale) : 1;
    scale = Math.min(scale, maxScale);
    if (width > 0 && height > 0 && width * scale * (height * scale) > maxPixels) {
      scale = Math.max(0.5, Math.sqrt(maxPixels / (width * height)));
    }
    return scale;
  }

  // trailing 防抖；定时器可注入，便于测试。
  function debounce(fn, wait, timers = {}) {
    const set = timers.setTimeout || ((callback, ms) => setTimeout(callback, ms));
    const clear = timers.clearTimeout || ((id) => clearTimeout(id));
    let timer = 0;
    return function debounced(...args) {
      if (timer) clear(timer);
      timer = set(() => {
        timer = 0;
        fn.apply(this, args);
      }, wait);
    };
  }

  // 行级回退矩形（从 viewer 内联逻辑提取的纯函数），虚拟化挂载时先用它兜底命中。
  function computeFallbackRects(sentence, rowTolerance, pageWidth, pageHeight) {
    const width = Number(pageWidth) || 0;
    const height = Number(pageHeight) || 0;
    return buildSentenceLineRects(sentence, rowTolerance).map((rect) => {
      const left = Math.max(0, Math.min(width, rect.left));
      const top = Math.max(0, Math.min(height, rect.top));
      const right = Math.max(left, Math.min(width, rect.left + rect.width));
      const bottom = Math.max(top, Math.min(height, rect.top + rect.height));
      return { left, top, width: right - left, height: bottom - top };
    }).filter((rect) => rect.width > 0 && rect.height > 0);
  }

  global.__parseSpecPdfHelpers = {
    buildSentenceDomRects,
    buildSentenceLineRects,
    computeFallbackRects,
    debounce,
    fitCanvasScale,
    mergeNearbyRects,
    pageIndexAtScroll,
    resolveOutlinePage,
    resolvePdfDestination,
    targetAtPoint,
    visiblePageRange,
  };
}(globalThis));
