/* PDF 阅读区补丁：完整句子标记层 + PDF 目录（outline）导航。 */
(function () {
  "use strict";

  const MARK_LAYER_CLASS = "sentence-mark-layer";
  const OUTLINE_PANEL_ID = "outline-panel";
  const OUTLINE_BUTTON_ID = "outline-toggle";

  function buildSentenceLineRects(sentence, rowTolerance) {
    const rows = [];
    for (const word of sentence || []) {
      if (!word || !Number.isFinite(word.x0) || !Number.isFinite(word.x1) || !Number.isFinite(word.y0) || !Number.isFinite(word.y1)) continue;
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

  function createSentenceMarks(wrap, sentences, pageNum) {
    if (!wrap || !wrap.appendChild || !Array.isArray(sentences)) return;
    const oldLayer = wrap.querySelector ? wrap.querySelector(`.${MARK_LAYER_CLASS}`) : null;
    if (oldLayer && oldLayer.remove) oldLayer.remove();

    const layer = document.createElement("div");
    layer.className = MARK_LAYER_CLASS;
    layer.setAttribute("aria-hidden", "true");
    const tolerance = 8 * (typeof S === "number" ? S : 1.4);

    sentences.forEach((sentence, sentenceIndex) => {
      for (const rect of buildSentenceLineRects(sentence, tolerance)) {
        const mark = document.createElement("span");
        mark.className = "sentence-mark";
        mark.dataset.pageNumber = String(pageNum);
        mark.dataset.sentId = String(sentenceIndex);
        mark.style.left = `${rect.left}px`;
        mark.style.top = `${rect.top}px`;
        mark.style.width = `${rect.width}px`;
        mark.style.height = `${rect.height}px`;
        layer.appendChild(mark);
      }
    });
    wrap.appendChild(layer);
  }

  function marksForTarget(target) {
    if (!target || !Number.isFinite(Number(target.pageNum)) || !Number.isFinite(Number(target.sentenceIndex))) return [];
    if (typeof document === "undefined" || !document.querySelectorAll) return [];
    return Array.from(document.querySelectorAll(
      `.sentence-mark[data-page-number="${Number(target.pageNum)}"][data-sent-id="${Number(target.sentenceIndex)}"]`,
    ));
  }

  function toggleMarks(target, className, enabled) {
    for (const mark of marksForTarget(target)) mark.classList.toggle(className, enabled);
  }

  async function resolveOutlinePage(pdf, dest) {
    if (!pdf || !dest) return null;
    let explicit = dest;
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

  function ensureOutlineUi() {
    if (typeof document === "undefined" || !document.querySelector || !document.createElement) return null;
    let button = document.getElementById && document.getElementById(OUTLINE_BUTTON_ID);
    let panel = document.getElementById && document.getElementById(OUTLINE_PANEL_ID);
    if (button && panel) return { button, panel };

    const topbar = document.querySelector(".topbar");
    if (!topbar) return null;

    button = document.createElement("button");
    button.id = OUTLINE_BUTTON_ID;
    button.className = "icon-btn outline-toggle";
    button.type = "button";
    button.textContent = "目录";
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", OUTLINE_PANEL_ID);
    button.setAttribute("aria-label", "打开 PDF 目录");

    const panelToggle = document.getElementById && document.getElementById("panel-toggle");
    if (panelToggle && panelToggle.parentNode === topbar && topbar.insertBefore) topbar.insertBefore(button, panelToggle);
    else topbar.appendChild(button);

    panel = document.createElement("aside");
    panel.id = OUTLINE_PANEL_ID;
    panel.className = "outline-panel";
    panel.hidden = true;
    panel.setAttribute("aria-label", "PDF 目录");
    panel.innerHTML = `<header class="outline-header"><div><div class="eyebrow">PDF outline</div><h2>目录</h2></div><button class="icon-btn outline-close" type="button" aria-label="关闭目录">×</button></header><div class="outline-content"><div class="outline-empty">打开 PDF 后读取目录…</div></div>`;
    document.body.appendChild(panel);

    const closeButton = panel.querySelector && panel.querySelector(".outline-close");
    const close = () => {
      panel.hidden = true;
      button.setAttribute("aria-expanded", "false");
    };
    const toggle = () => {
      panel.hidden = !panel.hidden;
      button.setAttribute("aria-expanded", String(!panel.hidden));
    };
    button.addEventListener("click", toggle);
    if (closeButton) closeButton.addEventListener("click", close);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !panel.hidden) close();
    });
    document.addEventListener("click", (event) => {
      if (panel.hidden || panel.contains(event.target) || button.contains(event.target)) return;
      close();
    });
    return { button, panel, close };
  }

  function setOutlineStatus(message) {
    const ui = ensureOutlineUi();
    if (!ui) return;
    const content = ui.panel.querySelector && ui.panel.querySelector(".outline-content");
    if (content) content.innerHTML = `<div class="outline-empty">${typeof esc === "function" ? esc(message) : String(message)}</div>`;
  }

  function scrollToPage(pageNum) {
    if (!Number.isInteger(pageNum) || pageNum < 1 || typeof document === "undefined" || !document.querySelector) return false;
    const page = document.querySelector(`.page-wrap[data-page-number="${pageNum}"]`);
    if (!page) return false;
    if (page.scrollIntoView) page.scrollIntoView({ behavior: "smooth", block: "start" });
    page.classList.add("outline-target-page");
    setTimeout(() => page.classList.remove("outline-target-page"), 1100);
    return true;
  }

  async function navigateOutlineItem(pdf, item, button) {
    if (!item) return;
    if (item.dest) {
      const pageNum = await resolveOutlinePage(pdf, item.dest);
      if (pageNum && scrollToPage(pageNum)) {
        const panel = document.getElementById && document.getElementById(OUTLINE_PANEL_ID);
        if (panel && panel.querySelectorAll) {
          for (const node of panel.querySelectorAll(".outline-item.is-active")) node.classList.remove("is-active");
        }
        if (button) button.classList.add("is-active");
        return;
      }
    }
    if (item.url && typeof window !== "undefined" && window.open) window.open(item.url, "_blank", "noopener,noreferrer");
  }

  function appendOutlineItems(listElement, items, pdf) {
    for (const item of items || []) {
      const li = document.createElement("li");
      li.className = "outline-node";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "outline-item";
      button.textContent = String(item.title || "未命名条目").trim() || "未命名条目";
      button.title = button.textContent;
      button.addEventListener("click", () => navigateOutlineItem(pdf, item, button));
      li.appendChild(button);
      if (Array.isArray(item.items) && item.items.length) {
        const children = document.createElement("ol");
        children.className = "outline-list outline-list-nested";
        appendOutlineItems(children, item.items, pdf);
        li.appendChild(children);
      }
      listElement.appendChild(li);
    }
  }

  async function loadPdfOutline(pdf) {
    const ui = ensureOutlineUi();
    if (!ui || !pdf || typeof pdf.getOutline !== "function") return;
    const content = ui.panel.querySelector && ui.panel.querySelector(".outline-content");
    if (!content) return;
    content.innerHTML = `<div class="outline-empty">正在读取目录…</div>`;
    try {
      const outline = await pdf.getOutline();
      content.innerHTML = "";
      if (!Array.isArray(outline) || !outline.length) {
        content.innerHTML = `<div class="outline-empty">此 PDF 未提供可用目录（书签）。</div>`;
        ui.button.setAttribute("aria-label", "PDF 未提供目录");
        return;
      }
      ui.button.setAttribute("aria-label", `打开 PDF 目录，共 ${outline.length} 个顶级条目`);
      const list = document.createElement("ol");
      list.className = "outline-list";
      appendOutlineItems(list, outline, pdf);
      content.appendChild(list);
    } catch (error) {
      content.innerHTML = `<div class="outline-empty">目录读取失败：${typeof esc === "function" ? esc(String(error)) : String(error)}</div>`;
    }
  }

  if (typeof wireTextLayer === "function") {
    const originalWireTextLayer = wireTextLayer;
    wireTextLayer = function patchedWireTextLayer(textLayer, wrap, sentences, words, pageNum) {
      originalWireTextLayer(textLayer, wrap, sentences, words, pageNum);
      createSentenceMarks(wrap, sentences, pageNum);
    };
  }

  if (typeof addClassToSpans === "function") {
    const originalAddClassToSpans = addClassToSpans;
    addClassToSpans = function patchedAddClassToSpans(target, className) {
      originalAddClassToSpans(target, className);
      toggleMarks(target, className, true);
    };
  }

  if (typeof removeClassFromSpans === "function") {
    const originalRemoveClassFromSpans = removeClassFromSpans;
    removeClassFromSpans = function patchedRemoveClassFromSpans(target, className) {
      originalRemoveClassFromSpans(target, className);
      toggleMarks(target, className, false);
    };
  }

  if (typeof openPdf === "function") {
    const originalOpenPdf = openPdf;
    openPdf = async function patchedOpenPdf(file) {
      const ui = ensureOutlineUi();
      if (ui) {
        ui.panel.hidden = true;
        ui.button.setAttribute("aria-expanded", "false");
        setOutlineStatus("正在读取 PDF…");
      }
      await originalOpenPdf(file);
      if (typeof currentPdf !== "undefined" && currentPdf) await loadPdfOutline(currentPdf);
    };
  }

  ensureOutlineUi();

  if (typeof globalThis !== "undefined") {
    globalThis.__parseSpecPdfUiFixes = {
      buildSentenceLineRects,
      resolveOutlinePage,
      scrollToPage,
      loadPdfOutline,
    };
  }
}());
