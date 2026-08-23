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

  function targetAtPoint(targets, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return (targets || []).find((target) => (target.rects || []).some((rect) => (
      x >= rect.left && x <= rect.left + rect.width
      && y >= rect.top && y <= rect.top + rect.height
    ))) || null;
  }

  async function resolveOutlinePage(pdf, destination) {
    if (!pdf || !destination) return null;
    let explicit = destination;
    if (typeof explicit === "string") explicit = await pdf.getDestination(explicit);
    if (!Array.isArray(explicit) || !explicit.length) return null;
    const pageRef = explicit[0];
    if (Number.isInteger(pageRef)) return pageRef + 1;
    try {
      const pageIndex = await pdf.getPageIndex(pageRef);
      return Number.isInteger(pageIndex) ? pageIndex + 1 : null;
    } catch (_ignored) {
      return null;
    }
  }

  global.__parseSpecPdfHelpers = { buildSentenceLineRects, resolveOutlinePage, targetAtPoint };
}(globalThis));
