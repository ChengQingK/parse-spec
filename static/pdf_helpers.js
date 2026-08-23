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

  global.__parseSpecPdfHelpers = {
    buildSentenceDomRects,
    buildSentenceLineRects,
    mergeNearbyRects,
    resolveOutlinePage,
    resolvePdfDestination,
    targetAtPoint,
  };
}(globalThis));
