/* Parse-Spec 前端：pdf.js 渲染、可复制文本层、句子选择、目录与可停靠分析栏。
 *
 * 全部状态与函数都封装在 createViewer 工厂内：浏览器导入本模块时立即创建唯一
 * 实例；Node 回归测试通过 globalThis.__parseSpecViewerFactory 按需创建全新实例，
 * 每个实例等价于一次全新的页面加载，测试基建因此无需动态执行任何代码。 */
function createViewer() {
  const pdfjsLib = globalThis.pdfjsLib;
  if (!pdfjsLib) throw new Error("PDF.js 尚未加载");
  const pdfHelpers = globalThis.__parseSpecPdfHelpers;
  if (!pdfHelpers) throw new Error("PDF 阅读辅助模块尚未加载");
  const {
    buildSentenceDomRects,
    buildSentenceLineRects,
    computeFallbackRects,
    debounce,
    fitCanvasScale,
    pageIndexAtScroll,
    resolvePdfDestination,
    targetAtPoint,
  } = pdfHelpers;
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/pdf.worker.min.mjs";

  // 句子切分与标记层位于独立模块，经全局命名空间注入（与 pdf_helpers 同一模式）。
  const parts = globalThis.__parseSpecViewerParts;
  if (!parts) throw new Error("阅读器句子/标记模块尚未加载");
  const {
    S,
    addClassToSpans,
    alignTextDivs,
    buildSentences,
    clearSentenceMarks,
    createPageVirtualizer,
    createWireTextLayer,
    createSidebar,
    createSentenceMarks,
    finalizeDocumentSentences,
    hasTerminalPunctuation,
    isSentenceEnd,
    joinAcrossPages,
    purgePageMarks,
    removeClassFromSpans,
    sentenceText,
    shouldMergeAcrossPages,
    toWords,
    toggleSentenceMarks,
    wordAtTextOffset,
  } = parts;

  const fileInput = document.getElementById("file");
const emptyFileInput = document.getElementById("file-empty");
const pagesEl = document.getElementById("pages");
const documentPane = document.getElementById("doc");
const placeholder = document.getElementById("placeholder");
const workspace = document.getElementById("workspace");
const analysisContent = document.getElementById("analysis-content");
const analysisPanel = document.getElementById("analysis-panel");
const panelToggle = document.getElementById("panel-toggle");
const panelClose = document.getElementById("panel-close");
const panelResizer = document.getElementById("panel-resizer");
const docMeta = document.getElementById("doc-meta");
const recentDocs = document.getElementById("recent-docs");
const recentDocsMenu = document.getElementById("recent-docs-menu");
const recentDocsList = document.getElementById("recent-docs-list");
const themeCycle = document.getElementById("theme-cycle");
const themeIcon = document.getElementById("theme-icon");
const depthButtons = ["concise", "standard", "detailed"].map((value) => document.getElementById(`depth-${value}`)).filter(Boolean);
const structureButtons = ["bracket", "linked"].map((value) => document.getElementById(`structure-${value}`)).filter(Boolean);
const outlineToggle = document.getElementById("outline-toggle");
const outlinePanel = document.getElementById("outline-panel");
const outlineClose = document.getElementById("outline-close");
const outlineContent = document.getElementById("outline-content");
const bookmarkToggle = document.getElementById("bookmark-toggle");
const bookmarkPanel = document.getElementById("bookmark-panel");
const bookmarkClose = document.getElementById("bookmark-close");
const bookmarkAdd = document.getElementById("bookmark-add");
const bookmarkName = document.getElementById("bookmark-name");
const bookmarkContent = document.getElementById("bookmark-content");
const navResizer = document.getElementById("nav-resizer");
const complexWordToggle = document.getElementById("complex-word-toggle");
const complexWordDialog = document.getElementById("complex-word-dialog");
const complexWordClose = document.getElementById("complex-word-close");
const complexWordSearch = document.getElementById("complex-word-search");
const complexWordList = document.getElementById("complex-word-list");
const complexWordForm = document.getElementById("complex-word-form");
const complexWordWord = document.getElementById("complex-word-word");
const complexWordLevel = document.getElementById("complex-word-level");
const complexWordZh = document.getElementById("complex-word-zh");
const complexWordNote = document.getElementById("complex-word-note");
const complexWordMessage = document.getElementById("complex-word-message");
const complexWordDelete = document.getElementById("complex-word-delete");
const complexWordInfo = document.getElementById("complex-word-info");
const glossaryToggle = document.getElementById("glossary-toggle");
const glossaryDialog = document.getElementById("glossary-dialog");
const glossaryClose = document.getElementById("glossary-close");
const glossarySearch = document.getElementById("glossary-search");
const glossaryList = document.getElementById("glossary-list");
const glossaryForm = document.getElementById("glossary-form");
const glossaryWord = document.getElementById("glossary-word");
const glossaryPos = document.getElementById("glossary-pos");
const glossaryZh = document.getElementById("glossary-zh");
const glossaryNote = document.getElementById("glossary-note");
const glossaryMessage = document.getElementById("glossary-message");
const glossaryBackupSelect = document.getElementById("glossary-backup-select");
const glossaryBackupCreate = document.getElementById("glossary-backup-create");
const glossaryBackupRestore = document.getElementById("glossary-backup-restore");
const glossaryBackupDownload = document.getElementById("glossary-backup-download");
const glossaryBackupDelete = document.getElementById("glossary-backup-delete");
const glossaryDelete = document.getElementById("glossary-delete");
const pageStatus = document.getElementById("page-status");
const zoomOut = document.getElementById("zoom-out");
const zoomReset = document.getElementById("zoom-reset");
const zoomIn = document.getElementById("zoom-in");

const SETTINGS_KEY = "parse-spec:settings";
const PDF_ZOOM_KEY = "parse-spec:pdf-zoom";
const LEGACY_BOOKMARKS_KEY = "parse-spec:bookmarks";
const DEFAULT_SETTINGS = Object.freeze({ theme: "light", analysisDepth: "standard", structureView: "bracket" });
const VALID_THEMES = new Set(["light", "dark", "eye"]);
const VALID_DEPTHS = new Set(["concise", "standard", "detailed"]);
const VALID_STRUCTURE_VIEWS = new Set(["bracket", "linked"]);
const THEME_ORDER = ["light", "dark", "eye"];
const THEME_LABELS = Object.freeze({ light: "浅色", dark: "暗色", eye: "护眼色" });
/* 主题图标用内联 SVG，随主题切换并保持跨平台渲染一致 */
const THEME_ICONS = Object.freeze({
  light: '<svg class="icon-sun" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="3.4"/><path d="M10 2.2v2M10 15.8v2M2.2 10h2M15.8 10h2M4.6 4.6l1.4 1.4M14 14l1.4 1.4M15.4 4.6L14 6M6 14l-1.4 1.4"/></svg>',
  dark: '<svg class="icon-moon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.5 12.2A6.5 6.5 0 0 1 7.8 4.5a6.5 6.5 0 1 0 7.7 7.7Z"/></svg>',
  eye: '<svg class="icon-eye" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 10s2.8-4.7 7.5-4.7S17.5 10 17.5 10s-2.8 4.7-7.5 4.7S2.5 10 2.5 10Z"/><circle cx="10" cy="10" r="2.1"/></svg>',
});
const sentenceResults = new Map();
const pageSentenceTargets = new Map();

/* 命中映射：span 对齐、指针命中与悬停/点击接线，依赖显式注入。 */
const wireTextLayer = createWireTextLayer({
  sentences: { S, sentenceText },
  helpers: { computeFallbackRects, targetAtPoint },
  marks: { createSentenceMarks },
  refs: {
    getPdfZoom: () => pdfZoom,
    pageSentenceTargets,
  },
  ui: { hasTextSelection, setPreview, clearPreview, selectSentence, requestUiFrame },
});

/* 页面虚拟化与挂载管线：可变状态内聚在工厂内，viewer 侧依赖显式注入。 */
const pages = createPageVirtualizer({
  sentences: { S, toWords, buildSentences, alignTextDivs },
  helpers: { fitCanvasScale, buildSentenceDomRects },
  marks: { addClassToSpans, createSentenceMarks, toggleSentenceMarks, purgePageMarks },
  utils: { measuredRect },
  refs: {
    pdfjsLib,
    getLoadSerial: () => documentLoadSerial,
    getCurrentPdf: () => currentPdf,
    getPdfZoom: () => pdfZoom,
    getDocumentPane: () => documentPane,
    getSelectedTarget: () => selectedTarget,
    getPreviewTarget: () => previewTarget,
    pageSentenceTargets,
  },
  hooks: {
    createPageTargets,
    wireTextLayer,
    renderAnnotationLayer,
    getCurrentVisiblePage: () => currentVisiblePage(),
  },
});
/* 侧栏区块（分析栏渲染/弹窗/拖拽调宽）：状态内聚，viewer 依赖注入。 */
const sidebar = createSidebar({
  text: { esc },
  sentences: { wordAtTextOffset },
  utils: { debounce, measuredRect, requestUiFrame },
  els: {
    analysisContent, analysisPanel, panelToggle, panelClose, panelResizer, workspace, navResizer,
    outlinePanel, bookmarkPanel,
    complexWordDialog, complexWordToggle, complexWordSearch, complexWordList, complexWordWord,
    complexWordLevel, complexWordZh, complexWordNote, complexWordMessage, complexWordDelete, complexWordInfo,
    glossaryDialog, glossaryToggle, glossarySearch, glossaryList, glossaryWord, glossaryPos,
    glossaryZh, glossaryNote, glossaryMessage, glossaryBackupSelect, glossaryDelete,
  },
  refs: {
    getUiSettings: () => uiSettings,
    getSelectedTarget: () => selectedTarget,
    sentenceResults,
  },
  settings: { validStructureViews: VALID_STRUCTURE_VIEWS, defaultSettings: DEFAULT_SETTINGS },
  hooks: {
    invalidateSentenceResultsFor,
    refreshSelectedAnalysis,
    loadAndRender,
    bumpRequestSerial: () => ++requestSerial,
    clearSelection,
    clearPreview,
    isNarrowViewport,
  },
});
const {
  renderEmptyPanel, renderLoadingPanel, renderErrorPanel, renderAnalysisPanel, toggleTranslationTerm,
  openGlossary, closeGlossary, openComplexWords, closeComplexWords, editComplexWord,
  submitComplexWord, deleteComplexWord, submitGlossaryEntry, deleteGlossaryEntry,
  syncComplexWordDeleteState, syncGlossaryDeleteState, createGlossaryBackup, restoreGlossaryBackup,
  downloadGlossaryBackup, deleteGlossaryBackup, loadWordInfo, clearWordInfo,
  renderComplexWordEntriesDebounced, renderGlossaryEntriesDebounced,
  setPanelCollapsed, closeAnalysisPanel, isPanelCollapsed, setPanelWidth, restorePanelWidth,
  startResize, moveResize, endResize, resizeByKeyboard,
  startNavResize, moveNavResize, endNavResize, resizeNavByKeyboard,
  setOutlineWidth, restoreOutlineWidth, finishLiveResize,
} = sidebar;

/* 单词级缓存失效：词典变更只让包含该词的分析缓存过期，不再全表清空。 */
function invalidateSentenceResultsFor(word) {
  const needle = String(word || "").trim().toLowerCase();
  if (!needle) {
    sentenceResults.clear();
    return;
  }
  const pattern = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  for (const key of [...sentenceResults.keys()]) {
    if (pattern.test(key)) sentenceResults.delete(key);
  }
}
const recentDocuments = [];

let currentPdf = null;
let activeLoadingTask = null;
let documentLoadSerial = 0;
let previewTarget = null;
let selectedTarget = null;
let requestSerial = 0;
let currentDocumentKey = "no-document";
let bookmarkCacheKey = null;
let bookmarkCache = [];
let bookmarkLoadSerial = 0;
let activeRecentDocumentKey = null;
let pdfZoom = 1;
let committedPdfZoom = 1;
let zoomCommitTimer = 0;
let pageStatusFrame = 0;
let uiSettings = loadSettings();


/* ---------------- 界面状态 ---------------- */

function loadSettings() {
  try {
    const raw = window.localStorage && window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      theme: VALID_THEMES.has(parsed.theme) ? parsed.theme : DEFAULT_SETTINGS.theme,
      analysisDepth: VALID_DEPTHS.has(parsed.analysisDepth) ? parsed.analysisDepth : DEFAULT_SETTINGS.analysisDepth,
      structureView: VALID_STRUCTURE_VIEWS.has(parsed.structureView) ? parsed.structureView : DEFAULT_SETTINGS.structureView,
    };
  } catch (_ignored) {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    if (window.localStorage) window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(uiSettings));
  } catch (_ignored) {}
}

function syncAnalysisControls() {
  for (const button of depthButtons) button.setAttribute("aria-pressed", String(button.dataset.analysisDepth === uiSettings.analysisDepth));
  for (const button of structureButtons) button.setAttribute("aria-pressed", String(button.dataset.structureView === uiSettings.structureView));
}

function setTheme(theme, persist = true) {
  const next = VALID_THEMES.has(theme) ? theme : DEFAULT_SETTINGS.theme;
  uiSettings.theme = next;
  if (document.documentElement && document.documentElement.dataset) document.documentElement.dataset.theme = next;
  if (themeIcon) themeIcon.innerHTML = THEME_ICONS[next];
  if (themeCycle) {
    const nextTheme = THEME_ORDER[(THEME_ORDER.indexOf(next) + 1) % THEME_ORDER.length];
    themeCycle.setAttribute("aria-label", `当前为${THEME_LABELS[next]}主题，切换为${THEME_LABELS[nextTheme]}主题`);
    themeCycle.setAttribute("title", `当前：${THEME_LABELS[next]} · 点击切换为${THEME_LABELS[nextTheme]}`);
  }
  if (persist) saveSettings();
}

function cycleTheme() {
  const index = THEME_ORDER.indexOf(uiSettings.theme);
  setTheme(THEME_ORDER[(index + 1) % THEME_ORDER.length]);
}

function clampPdfZoom(value) {
  return Math.max(.75, Math.min(2, Math.round(Number(value) * 100) / 100));
}

function updatePdfZoomControls() {
  if (!zoomReset) return;
  const percent = `${Math.round(pdfZoom * 100)}%`;
  zoomReset.textContent = percent;
  zoomReset.setAttribute("aria-label", `当前 PDF 缩放 ${percent}，点击恢复为 100%`);
  if (zoomOut) zoomOut.disabled = pdfZoom <= .75;
  if (zoomIn) zoomIn.disabled = pdfZoom >= 2;
}

function commitPdfZoom(persist = true) {
  if (!pagesEl || !pagesEl.style) return;
  const previous = committedPdfZoom || 1;
  const ratio = pdfZoom / previous;
  const pane = documentPane;
  const centerTop = pane ? (Number(pane.scrollTop) || 0) + (Number(pane.clientHeight) || 0) / 2 : 0;
  const centerLeft = pane ? (Number(pane.scrollLeft) || 0) + (Number(pane.clientWidth) || 0) / 2 : 0;
  pagesEl.classList.add("is-committing-zoom");
  pagesEl.style.zoom = String(pdfZoom);
  pagesEl.style.transform = "";
  committedPdfZoom = pdfZoom;
  if (pane && ratio !== 1) {
    pane.scrollTop = Math.max(0, centerTop * ratio - (Number(pane.clientHeight) || 0) / 2);
    pane.scrollLeft = Math.max(0, centerLeft * ratio - (Number(pane.clientWidth) || 0) / 2);
  }
  requestUiFrame(() => pagesEl.classList.remove("is-committing-zoom"));
  if (persist) {
    try { if (window.localStorage) window.localStorage.setItem(PDF_ZOOM_KEY, String(pdfZoom)); } catch (_ignored) {}
  }
  if (currentPdf) pages.rerenderMountedCanvases();
  schedulePageStatusUpdate();
}

function setPdfZoom(value, persist = true, animate = true) {
  pdfZoom = clampPdfZoom(value);
  updatePdfZoomControls();
  if (!pagesEl || !pagesEl.style) return;
  if (!animate) {
    clearTimeout(zoomCommitTimer);
    zoomCommitTimer = 0;
    committedPdfZoom = pdfZoom;
    pagesEl.style.zoom = String(pdfZoom);
    pagesEl.style.transform = "";
    if (persist) {
      try { if (window.localStorage) window.localStorage.setItem(PDF_ZOOM_KEY, String(pdfZoom)); } catch (_ignored) {}
    }
    return;
  }
  pagesEl.style.transform = `scale(${pdfZoom / committedPdfZoom})`;
  clearTimeout(zoomCommitTimer);
  zoomCommitTimer = setTimeout(() => {
    zoomCommitTimer = 0;
    commitPdfZoom(persist);
  }, 120);
}

function restorePdfZoom() {
  let saved = 1;
  try { saved = Number(window.localStorage && window.localStorage.getItem(PDF_ZOOM_KEY)) || 1; } catch (_ignored) {}
  setPdfZoom(saved, false, false);
}

function updatePageStatus() {
  if (!pageStatus) return;
  pageStatus.textContent = currentPdf ? `${currentVisiblePage()} / ${currentPdf.numPages}` : "— / —";
}

function schedulePageStatusUpdate() {
  if (pageStatusFrame || typeof requestAnimationFrame !== "function") {
    if (!pageStatusFrame) updatePageStatus();
    return;
  }
  pageStatusFrame = requestAnimationFrame(() => {
    pageStatusFrame = 0;
    updatePageStatus();
  });
}

function recentDocumentKey(file) {
  return `${String(file && file.name || "")}:${Number(file && file.size) || 0}:${Number(file && file.lastModified) || 0}`;
}

function renderRecentDocuments() {
  if (!recentDocsList) return;
  if (!recentDocuments.length) {
    recentDocsList.innerHTML = '<div class="recent-docs-empty">暂无最近文档</div>';
    return;
  }
  recentDocsList.innerHTML = recentDocuments.map((entry) => {
    const current = entry.key === activeRecentDocumentKey;
    return `<button class="recent-doc-item" type="button" role="menuitem" data-recent-key="${esc(entry.key)}"${current ? ' aria-current="true"' : ""}>`
      + `<span class="recent-doc-item-name">${esc(entry.file.name)}</span>`
      + (current ? '<span class="recent-doc-current">当前</span>' : "")
      + "</button>";
  }).join("");
}

function rememberRecentDocument(file) {
  const key = recentDocumentKey(file);
  const oldIndex = recentDocuments.findIndex((entry) => entry.key === key);
  if (oldIndex >= 0) recentDocuments.splice(oldIndex, 1);
  recentDocuments.unshift({ key, file });
  if (recentDocuments.length > 8) recentDocuments.length = 8;
  activeRecentDocumentKey = key;
  renderRecentDocuments();
  return key;
}

function openRecentDocuments() {
  if (!recentDocsMenu || !docMeta) return;
  renderRecentDocuments();
  recentDocsMenu.hidden = false;
  docMeta.setAttribute("aria-expanded", "true");
}

function closeRecentDocuments() {
  if (!recentDocsMenu || !docMeta) return;
  recentDocsMenu.hidden = true;
  docMeta.setAttribute("aria-expanded", "false");
}

function toggleRecentDocuments() {
  if (!recentDocsMenu || recentDocsMenu.hidden) openRecentDocuments();
  else closeRecentDocuments();
}

function switchRecentDocument(key) {
  const entry = recentDocuments.find((item) => item.key === key);
  closeRecentDocuments();
  if (!entry || (entry.key === activeRecentDocumentKey && (currentPdf || activeLoadingTask))) return;
  openPdf(entry.file);
}

function setDocumentLabel(file, status = "") {
  if (!docMeta || !file) return;
  docMeta.textContent = file.name;
  const description = status ? `${file.name} · ${status}` : file.name;
  docMeta.setAttribute("title", description);
  docMeta.setAttribute("aria-label", status ? description : `${file.name}，打开最近文档`);
}

function setAnalysisDepth(depth, persist = true) {
  const next = VALID_DEPTHS.has(depth) ? depth : DEFAULT_SETTINGS.analysisDepth;
  uiSettings.analysisDepth = next;
  for (const button of depthButtons) button.setAttribute("aria-pressed", String(button.dataset.analysisDepth === next));
  if (persist) saveSettings();
  refreshSelectedAnalysis(false);
}

function setStructureView(view, persist = true) {
  const next = VALID_STRUCTURE_VIEWS.has(view) ? view : DEFAULT_SETTINGS.structureView;
  uiSettings.structureView = next;
  for (const button of structureButtons) button.setAttribute("aria-pressed", String(button.dataset.structureView === next));
  if (persist) saveSettings();
  refreshSelectedAnalysis(false);
}

function safeExternalUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value), window.location && window.location.href);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch (_ignored) {
    return null;
  }
}

function annotationRect(viewport, rect) {
  if (!viewport || !Array.isArray(rect) || rect.length < 4) return null;
  const first = viewport.convertToViewportPoint(rect[0], rect[1]);
  const second = viewport.convertToViewportPoint(rect[2], rect[3]);
  const converted = [first[0], first[1], second[0], second[1]];
  const left = Math.max(0, Math.min(converted[0], converted[2]));
  const top = Math.max(0, Math.min(converted[1], converted[3]));
  const right = Math.min(viewport.width, Math.max(converted[0], converted[2]));
  const bottom = Math.min(viewport.height, Math.max(converted[1], converted[3]));
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
}

function handleNamedAction(action) {
  if (!currentPdf || !action || !pages.getPageTops().length) return false;
  const currentIndex = currentVisiblePage() - 1;
  const named = String(action);
  const target = named === "FirstPage" ? 1
    : named === "LastPage" ? currentPdf.numPages
      : named === "NextPage" ? Math.min(currentPdf.numPages, currentIndex + 2)
        : named === "PrevPage" ? Math.max(1, currentIndex)
          : null;
  return target ? scrollToPage(target) : false;
}

async function renderAnnotationLayer(page, viewport, wrap, pdf) {
  if (!page || typeof page.getAnnotations !== "function") return;
  let annotations;
  try {
    annotations = await page.getAnnotations({ intent: "display" });
  } catch (_ignored) {
    return;
  }
  const links = (annotations || []).filter((annotation) => annotation && annotation.subtype === "Link");
  if (!links.length) return;
  const layer = document.createElement("div");
  layer.className = "annotation-layer";
  layer.setAttribute("aria-label", "PDF 链接层");
  for (const annotation of links) {
    const rect = annotationRect(viewport, annotation.rect);
    if (!rect) continue;
    const external = safeExternalUrl(annotation.url || annotation.unsafeUrl);
    const link = document.createElement(external ? "a" : "button");
    link.className = "annotation-link";
    link.style.left = `${rect.left}px`;
    link.style.top = `${rect.top}px`;
    link.style.width = `${rect.width}px`;
    link.style.height = `${rect.height}px`;
    const label = String(annotation.overlaidText || annotation.contentsObj && annotation.contentsObj.str || "PDF 链接").trim();
    link.setAttribute("aria-label", label || "PDF 链接");
    link.title = label || "PDF 链接";
    if (external) {
      link.href = external;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    } else {
      link.type = "button";
      link.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (annotation.dest) await navigatePdfDestination(pdf, annotation.dest);
        else if (annotation.action) handleNamedAction(annotation.action);
      });
    }
    layer.appendChild(link);
  }
  if (layer.children.length) wrap.appendChild(layer);
}

function yieldToBrowser() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

function createPageTargets(sentences, pageNum, state) {
  const targets = [];
  let startIndex = 0;
  if (state.pending && sentences.length) {
    if (shouldMergeAcrossPages(state.pending.sentence, sentences[0])) {
      const target = state.pending.target;
      const previousText = target.text;
      target.text = joinAcrossPages(previousText, sentenceText(sentences[0]));
      target.endPageNum = pageNum;
      target.contextWarnings = ["该句由相邻两页自动合并，请结合分页处原文确认。"];
      sentenceResults.delete(previousText);
      targets.push(target);
      startIndex = 1;
    } else {
      state.pending.target.contextWarnings = ["该句位于页尾且没有明确句末标点，可能被分页截断。"];
    }
  }
  for (let sentenceIndex = startIndex; sentenceIndex < sentences.length; sentenceIndex++) {
    targets[sentenceIndex] = {
      key: `doc:${state.nextId++}`,
      pageNum,
      endPageNum: pageNum,
      sentenceIndex,
      text: sentenceText(sentences[sentenceIndex]),
      spans: [],
      locations: [],
      contextWarnings: [],
    };
  }
  if (sentences.length) {
    const lastIndex = sentences.length - 1;
    const lastTarget = targets[lastIndex];
    state.pending = hasTerminalPunctuation(sentences[lastIndex])
      ? null
      : { target: lastTarget, sentence: sentences[lastIndex] };
  }
  return targets;
}


/* ---------------- 预览与选中状态 ---------------- */

function hasTextSelection() {
  return !!(window.getSelection && window.getSelection().toString());
}

/* ---------------- PDF 目录 ---------------- */

function setNavigationPanel(kind) {
  const showOutline = kind === "outline";
  const showBookmarks = kind === "bookmarks";
  const open = showOutline || showBookmarks;
  if (open && isNarrowViewport() && !isPanelCollapsed()) setPanelCollapsed(true);
  if (outlinePanel) outlinePanel.hidden = !showOutline;
  if (bookmarkPanel) bookmarkPanel.hidden = !showBookmarks;
  workspace.classList.toggle("outline-open", open);
  if (outlineToggle) outlineToggle.setAttribute("aria-expanded", String(showOutline));
  if (bookmarkToggle) bookmarkToggle.setAttribute("aria-expanded", String(showBookmarks));
  if (showBookmarks) void loadDocumentBookmarks();
}

function setOutlineOpen(open) {
  if (!outlinePanel || !outlineToggle) return;
  if (open) setNavigationPanel("outline");
  else if (!outlinePanel.hidden) setNavigationPanel(null);
}

function setBookmarksOpen(open) {
  if (!bookmarkPanel || !bookmarkToggle) return;
  if (open) setNavigationPanel("bookmarks");
  else if (!bookmarkPanel.hidden) setNavigationPanel(null);
}

function requestUiFrame(callback) {
  const schedule = window.requestAnimationFrame || ((next) => setTimeout(next, 0));
  return schedule(callback);
}

function measuredRect(element, fallbackWidth = 0, fallbackHeight = 0) {
  const rect = element && element.getBoundingClientRect ? element.getBoundingClientRect() : {};
  const left = Number(rect.left) || 0;
  const top = Number(rect.top) || 0;
  const width = Number(rect.width) || fallbackWidth;
  const height = Number(rect.height) || fallbackHeight;
  return {
    left,
    top,
    width,
    height,
    right: Number.isFinite(Number(rect.right)) ? Number(rect.right) : left + width,
    bottom: Number.isFinite(Number(rect.bottom)) ? Number(rect.bottom) : top + height,
  };
}

function setOutlineStatus(message) {
  if (outlineContent) outlineContent.innerHTML = `<div class="outline-empty">${esc(message)}</div>`;
}

function scrollToPage(pageNum) {
  if (!Number.isInteger(pageNum) || pageNum < 1 || !document.querySelector) return false;
  const pageElement = document.querySelector(`.page-wrap[data-page-number="${pageNum}"]`);
  if (!pageElement) return false;
  if (pageElement.scrollIntoView) pageElement.scrollIntoView({ behavior: "smooth", block: "start" });
  pageElement.classList.add("outline-target-page");
  setTimeout(() => pageElement.classList.remove("outline-target-page"), 1100);
  setTimeout(updatePageStatus, 180);
  return true;
}

/* ---------------- 用户书签 ---------------- */

function legacyBookmarkSets() {
  try {
    const parsed = JSON.parse(window.localStorage && window.localStorage.getItem(LEGACY_BOOKMARKS_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_ignored) { return {}; }
}

function documentBookmarks() {
  return bookmarkCacheKey === currentDocumentKey ? bookmarkCache : [];
}

function removeLegacyDocumentBookmarks(documentKey) {
  try {
    if (!window.localStorage) return;
    const all = legacyBookmarkSets();
    delete all[documentKey];
    if (Object.keys(all).length) window.localStorage.setItem(LEGACY_BOOKMARKS_KEY, JSON.stringify(all));
    else if (window.localStorage.removeItem) window.localStorage.removeItem(LEGACY_BOOKMARKS_KEY);
    else window.localStorage.setItem(LEGACY_BOOKMARKS_KEY, "{}");
  } catch (_ignored) {}
}

function bookmarkIdentity(bookmark) {
  return `${Number(bookmark.pageNum)}:${Number.isInteger(bookmark.sentenceIndex) ? bookmark.sentenceIndex : "page"}:${bookmark.text || ""}`;
}

async function persistDocumentBookmarks(documentKey, bookmarks) {
  const response = await fetch("/api/bookmarks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ document_key: documentKey, bookmarks }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return Array.isArray(data.bookmarks) ? data.bookmarks : bookmarks;
}

async function loadDocumentBookmarks() {
  if (!bookmarkContent) return [];
  const initialLegacy = legacyBookmarkSets()[currentDocumentKey];
  if (!currentPdf && currentDocumentKey === "no-document" && !Array.isArray(initialLegacy)) {
    bookmarkCacheKey = currentDocumentKey;
    bookmarkCache = [];
    bookmarkContent.innerHTML = `<div class="outline-empty">请先打开 PDF。</div>`;
    return [];
  }
  const documentKey = currentDocumentKey;
  const loadId = ++bookmarkLoadSerial;
  bookmarkContent.innerHTML = `<div class="outline-empty">正在读取项目书签…</div>`;
  try {
    const response = await fetch(`/api/bookmarks?document_key=${encodeURIComponent(documentKey)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (loadId !== bookmarkLoadSerial || documentKey !== currentDocumentKey) return [];
    const stored = Array.isArray(data.bookmarks) ? data.bookmarks : [];
    const legacy = documentKey === currentDocumentKey ? initialLegacy : legacyBookmarkSets()[documentKey];
    const merged = [...stored];
    const identities = new Set(stored.map(bookmarkIdentity));
    if (Array.isArray(legacy)) {
      for (const bookmark of legacy) {
        const identity = bookmarkIdentity(bookmark);
        if (!identities.has(identity)) {
          identities.add(identity);
          merged.push(bookmark);
        }
      }
      const saved = await persistDocumentBookmarks(documentKey, merged);
      if (loadId !== bookmarkLoadSerial || documentKey !== currentDocumentKey) return [];
      merged.splice(0, merged.length, ...saved);
      removeLegacyDocumentBookmarks(documentKey);
    }
    bookmarkCacheKey = documentKey;
    bookmarkCache = merged;
    renderBookmarks();
    return merged;
  } catch (error) {
    if (loadId === bookmarkLoadSerial && documentKey === currentDocumentKey) {
      bookmarkCacheKey = documentKey;
      bookmarkCache = [];
      bookmarkContent.innerHTML = `<div class="outline-empty">书签读取失败：${esc(String(error))}</div>`;
    }
    return [];
  }
}

async function saveDocumentBookmarks(bookmarks) {
  const documentKey = currentDocumentKey;
  bookmarkCacheKey = documentKey;
  bookmarkCache = [...bookmarks];
  renderBookmarks();
  try {
    const saved = await persistDocumentBookmarks(documentKey, bookmarkCache);
    if (documentKey === currentDocumentKey) {
      bookmarkCache = saved;
      renderBookmarks();
    }
    return true;
  } catch (error) {
    if (documentKey === currentDocumentKey && bookmarkContent) {
      bookmarkContent.innerHTML = `<div class="outline-empty">书签保存失败：${esc(String(error))}</div>`;
    }
    return false;
  }
}

function currentVisiblePage() {
  const tops = pages.getPageTops();
  if (!tops.length) return 1;
  const scrollTop = documentPane ? (Number(documentPane.scrollTop) || 0) / (committedPdfZoom || 1) : 0;
  return pageIndexAtScroll(tops, pages.getPageHeights(), scrollTop) + 1;
}

function renderBookmarks() {
  if (!bookmarkContent) return;
  const bookmarks = documentBookmarks();
  if (!bookmarks.length) {
    bookmarkContent.innerHTML = `<div class="outline-empty">尚无书签。选择一句话后添加，可精确跳回该句；未选句时记录当前页。</div>`;
    return;
  }
  bookmarkContent.innerHTML = bookmarks.map((bookmark) => `
    <div class="bookmark-item">
      <button class="outline-item bookmark-jump" type="button" data-bookmark-action="jump" data-bookmark-id="${esc(bookmark.id)}">
        <strong>${esc(bookmark.name || `第 ${Number(bookmark.pageNum)} 页`)}</strong>
        <small>第 ${Number(bookmark.pageNum)} 页${Number.isInteger(bookmark.sentenceIndex) ? ` · 句子 ${bookmark.sentenceIndex + 1}` : ""} · ${esc(bookmark.text || "页面书签")}</small>
      </button>
      <button class="bookmark-rename" type="button" data-bookmark-action="rename" data-bookmark-id="${esc(bookmark.id)}" aria-label="重命名此书签">✎</button>
      <button class="bookmark-remove" type="button" data-bookmark-action="remove" data-bookmark-id="${esc(bookmark.id)}" aria-label="删除此书签">×</button>
    </div>`).join("");
}

async function addBookmark() {
  if (!currentPdf) {
    if (bookmarkContent) bookmarkContent.innerHTML = `<div class="outline-empty">请先打开 PDF。</div>`;
    return null;
  }
  if (bookmarkCacheKey !== currentDocumentKey) await loadDocumentBookmarks();
  const target = selectedTarget;
  const pageNum = target ? target.pageNum : currentVisiblePage();
  const bookmark = {
    id: `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    name: bookmarkName && bookmarkName.value.trim() ? bookmarkName.value.trim() : `第 ${pageNum} 页`,
    pageNum,
    sentenceIndex: target ? target.sentenceIndex : null,
    text: target ? target.text : `第 ${pageNum} 页`,
    createdAt: new Date().toISOString(),
  };
  const bookmarks = documentBookmarks();
  const duplicate = bookmarks.find((item) => item.pageNum === bookmark.pageNum && item.sentenceIndex === bookmark.sentenceIndex && item.text === bookmark.text);
  if (duplicate) {
    if (bookmarkName && bookmarkName.value.trim()) {
      duplicate.name = bookmark.name;
      await saveDocumentBookmarks(bookmarks);
      bookmarkName.value = "";
    }
    return duplicate;
  }
  bookmarks.unshift(bookmark);
  await saveDocumentBookmarks(bookmarks);
  if (bookmarkName) bookmarkName.value = "";
  return bookmark;
}

async function removeBookmark(id) {
  await saveDocumentBookmarks(documentBookmarks().filter((bookmark) => bookmark.id !== id));
}

async function renameBookmark(id, requestedName = null) {
  const bookmark = documentBookmarks().find((item) => item.id === id);
  if (!bookmark) return false;
  const promptValue = requestedName === null && typeof window.prompt === "function"
    ? window.prompt("书签名称", bookmark.name || `第 ${bookmark.pageNum} 页`)
    : requestedName;
  if (promptValue === null) return false;
  const name = String(promptValue).trim().slice(0, 200);
  if (!name) return false;
  bookmark.name = name;
  await saveDocumentBookmarks(documentBookmarks());
  return true;
}

function jumpToBookmark(bookmark) {
  if (!bookmark) return false;
  const jumped = scrollToPage(Number(bookmark.pageNum));
  if (Number.isInteger(bookmark.sentenceIndex)) {
    const target = pageSentenceTargets.get(`${Number(bookmark.pageNum)}:${bookmark.sentenceIndex}`);
    if (target) selectSentence(target);
  }
  if (isNarrowViewport()) setBookmarksOpen(false);
  return jumped;
}

async function navigatePdfDestination(pdf, destination) {
  const resolved = await resolvePdfDestination(pdf, destination);
  if (!resolved || !document.querySelector) return false;
  const pageElement = document.querySelector(`.page-wrap[data-page-number="${resolved.pageNum}"]`);
  if (!pageElement) return false;
  const viewport = pageElement.__pdfViewport;
  let localX = 0;
  let localY = 0;
  const numberAt = (index, fallback = null) => Number.isFinite(Number(resolved.args[index])) ? Number(resolved.args[index]) : fallback;
  if (viewport) {
    let pdfX = 0;
    let pdfY = null;
    if (resolved.kind === "XYZ") {
      pdfX = numberAt(0, 0);
      pdfY = numberAt(1, null);
    } else if (["FitH", "FitBH"].includes(resolved.kind)) {
      pdfY = numberAt(0, null);
    } else if (resolved.kind === "FitR") {
      pdfX = numberAt(0, 0);
      pdfY = numberAt(3, null);
    }
    if (pdfY !== null) {
      const point = viewport.convertToViewportPoint(pdfX, pdfY);
      localX = Math.max(0, point[0]);
      localY = Math.max(0, point[1]);
    }
  }
  if (documentPane && typeof documentPane.scrollTo === "function") {
    // 全部换算到滚动容器的可视坐标系：getBoundingClientRect 与 scrollTop
    // 同属一套坐标（CSS zoom 下 offsetTop 的单位存在浏览器歧义，不再使用）；
    // localX/localY 是页面未缩放布局像素，需乘以缩放倍率。
    const paneRect = documentPane.getBoundingClientRect();
    const pageRect = pageElement.getBoundingClientRect();
    const zoom = committedPdfZoom || 1;
    documentPane.scrollTo({
      top: Math.max(0, pageRect.top - paneRect.top + (Number(documentPane.scrollTop) || 0) + localY * zoom - 12),
      left: Math.max(0, pageRect.left - paneRect.left + (Number(documentPane.scrollLeft) || 0) + localX * zoom - 12),
      behavior: "smooth",
    });
  } else if (pageElement.scrollIntoView) {
    pageElement.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  pageElement.classList.add("outline-target-page");
  setTimeout(() => pageElement.classList.remove("outline-target-page"), 1100);
  return true;
}

async function navigateOutlineItem(pdf, item, button) {
  if (!item) return;
  if (item.dest) {
    if (await navigatePdfDestination(pdf, item.dest)) {
      if (outlinePanel && outlinePanel.querySelectorAll) {
        for (const node of outlinePanel.querySelectorAll(".outline-item.is-active")) node.classList.remove("is-active");
      }
      if (button) button.classList.add("is-active");
      return;
    }
  }
  if (item.action && handleNamedAction(item.action)) return;
  if (item.url && window.open) {
    try {
      const externalUrl = new URL(item.url, window.location && window.location.href);
      if (["http:", "https:"].includes(externalUrl.protocol)) {
        window.open(externalUrl.href, "_blank", "noopener,noreferrer");
      } else {
        setOutlineStatus("该目录链接使用了不受支持的协议，已阻止打开。");
      }
    } catch (_ignored) {
      setOutlineStatus("该目录链接无效，无法打开。");
    }
  }
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

async function loadPdfOutline(pdf, loadId = documentLoadSerial) {
  if (!outlineContent || !pdf || typeof pdf.getOutline !== "function") return;
  setOutlineStatus("正在读取目录…");
  try {
    const outline = await pdf.getOutline();
    if (loadId !== documentLoadSerial || pdf !== currentPdf) return;
    outlineContent.innerHTML = "";
    if (!Array.isArray(outline) || !outline.length) {
      setOutlineStatus("此 PDF 未提供可用目录（书签）。");
      if (outlineToggle) outlineToggle.setAttribute("aria-label", "PDF 未提供目录");
      return;
    }
    if (outlineToggle) outlineToggle.setAttribute("aria-label", `打开 PDF 目录，共 ${outline.length} 个顶级条目`);
    const list = document.createElement("ol");
    list.className = "outline-list";
    appendOutlineItems(list, outline, pdf);
    outlineContent.appendChild(list);
  } catch (error) {
    if (loadId === documentLoadSerial && pdf === currentPdf) setOutlineStatus(`目录读取失败：${String(error)}`);
  }
}

function setPreview(target) {
  if (hasTextSelection() || (previewTarget && previewTarget.key === target.key)) return;
  clearPreview();
  previewTarget = target;
  if (!selectedTarget || selectedTarget.key !== target.key) addClassToSpans(target, "is-preview");
}

function clearPreview(target = null) {
  if (!previewTarget) return;
  if (target && target.key !== previewTarget.key) return;
  removeClassFromSpans(previewTarget, "is-preview");
  previewTarget = null;
}

function clearSelection({ renderEmpty = true } = {}) {
  requestSerial++;
  if (selectedTarget) removeClassFromSpans(selectedTarget, "is-selected");
  selectedTarget = null;
  if (renderEmpty) renderEmptyPanel();
}

function selectSentence(target) {
  if (!target || !target.text) return;
  if (isNarrowViewport() && ((outlinePanel && !outlinePanel.hidden) || (bookmarkPanel && !bookmarkPanel.hidden))) setNavigationPanel(null);
  if (selectedTarget && selectedTarget.key !== target.key) removeClassFromSpans(selectedTarget, "is-selected");
  clearPreview();
  selectedTarget = target;
  addClassToSpans(target, "is-selected");
  setPanelCollapsed(false);
  const requestId = ++requestSerial;
  renderLoadingPanel(target);
  loadAndRender(target, requestId);
}

async function loadAndRender(target, requestId, force = false) {
  let result = force ? null : sentenceResults.get(target.text);
  if (!result) {
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sentences: [target.text] }),
      });
      if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
          const body = await response.json();
          if (body && body.error) detail = body.error;
        } catch (_ignored) {}
        throw new Error(detail);
      }
      const data = await response.json();
      result = data.results && data.results[0];
      if (!result) throw new Error("服务未返回分析结果");
      sentenceResults.set(target.text, result);
    } catch (error) {
      if (requestId !== requestSerial || !selectedTarget || selectedTarget.key !== target.key) return;
      renderErrorPanel(target, error);
      return;
    }
  }
  if (requestId !== requestSerial || !selectedTarget || selectedTarget.key !== target.key) return;
  renderAnalysisPanel(target, result);
  maybeRefineSentence(target, requestId);
}

// 在线精修失败过的句子本会话内不再重试，避免每次点击都等待超时。
const refineSkipped = new Set();

async function maybeRefineSentence(target, requestId) {
  const sentence = String(target.text || "");
  const current = sentenceResults.get(sentence);
  if (!sentence || sentence.length > 400 || (current && current.refined_by) || refineSkipped.has(sentence)) return;
  try {
    const response = await fetch("/api/refine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sentence }),
    });
    if (!response.ok) {
      refineSkipped.add(sentence); // 404 = 未配置/不可用：静默保留本地解析
      return;
    }
    const data = await response.json();
    const refined = data && data.result;
    if (!refined || !refined.refined_by || !Array.isArray(refined.clauses) || !refined.clauses.length) return;
    sentenceResults.set(sentence, refined);
    if (requestId === requestSerial && selectedTarget && selectedTarget.key === target.key) {
      renderAnalysisPanel(target, refined);
    }
  } catch (_error) {
    refineSkipped.add(sentence);
  }
}

function refreshSelectedAnalysis(loadIfMissing = true) {
  if (!selectedTarget) return;
  const cached = sentenceResults.get(selectedTarget.text);
  if (cached) {
    renderAnalysisPanel(selectedTarget, cached);
  } else if (loadIfMissing) {
    const requestId = ++requestSerial;
    renderLoadingPanel(selectedTarget);
    loadAndRender(selectedTarget, requestId);
  }
}

function isNarrowViewport() {
  return !!(window.matchMedia && window.matchMedia("(max-width: 760px)").matches);
}

if (panelToggle) panelToggle.addEventListener("click", () => {
  if (isPanelCollapsed()) {
    setPanelCollapsed(false);
    refreshSelectedAnalysis(true);
  } else closeAnalysisPanel();
});
if (panelClose) panelClose.addEventListener("click", closeAnalysisPanel);
if (panelResizer) {
  panelResizer.addEventListener("pointerdown", startResize);
  panelResizer.addEventListener("keydown", resizeByKeyboard);
}
if (navResizer) {
  navResizer.addEventListener("pointerdown", startNavResize);
  navResizer.addEventListener("keydown", resizeNavByKeyboard);
}
window.addEventListener("pointermove", (event) => { moveResize(event); moveNavResize(event); });
window.addEventListener("pointerup", () => { endResize(); endNavResize(); });
window.addEventListener("pointercancel", () => { endResize(); endNavResize(); });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (complexWordDialog && !complexWordDialog.hidden) closeComplexWords();
    else if (glossaryDialog && !glossaryDialog.hidden) closeGlossary();
    else if ((outlinePanel && !outlinePanel.hidden) || (bookmarkPanel && !bookmarkPanel.hidden)) setNavigationPanel(null);
    else if (recentDocsMenu && !recentDocsMenu.hidden) closeRecentDocuments();
    else if (selectedTarget || !isPanelCollapsed()) closeAnalysisPanel();
  }
});

if (themeCycle) themeCycle.addEventListener("click", cycleTheme);
if (docMeta) docMeta.addEventListener("click", (event) => {
  if (event.stopPropagation) event.stopPropagation();
  toggleRecentDocuments();
});
if (recentDocsList) recentDocsList.addEventListener("click", (event) => {
  const button = event.target && event.target.closest ? event.target.closest("[data-recent-key]") : null;
  if (button) switchRecentDocument(button.dataset.recentKey);
});
for (const button of depthButtons) button.addEventListener("click", () => setAnalysisDepth(button.dataset.analysisDepth));
for (const button of structureButtons) button.addEventListener("click", () => setStructureView(button.dataset.structureView));
if (outlineToggle) outlineToggle.addEventListener("click", (event) => {
  if (event.stopPropagation) event.stopPropagation();
  setOutlineOpen(!outlinePanel || outlinePanel.hidden);
});
if (outlineClose) outlineClose.addEventListener("click", () => setOutlineOpen(false));
if (bookmarkToggle) bookmarkToggle.addEventListener("click", (event) => {
  if (event.stopPropagation) event.stopPropagation();
  setBookmarksOpen(!bookmarkPanel || bookmarkPanel.hidden);
});
if (bookmarkClose) bookmarkClose.addEventListener("click", () => setBookmarksOpen(false));
if (bookmarkAdd) bookmarkAdd.addEventListener("click", addBookmark);
if (bookmarkName) bookmarkName.addEventListener("keydown", (event) => { if (event.key === "Enter") addBookmark(); });
if (bookmarkContent) bookmarkContent.addEventListener("click", (event) => {
  const button = event.target && event.target.closest ? event.target.closest("[data-bookmark-action]") : null;
  if (!button) return;
  const id = button.dataset.bookmarkId;
  if (button.dataset.bookmarkAction === "remove") removeBookmark(id);
  else if (button.dataset.bookmarkAction === "rename") renameBookmark(id);
  else if (button.dataset.bookmarkAction === "jump") jumpToBookmark(documentBookmarks().find((bookmark) => bookmark.id === id));
});
if (complexWordToggle) complexWordToggle.addEventListener("click", () => openComplexWords());
if (complexWordClose) complexWordClose.addEventListener("click", closeComplexWords);
if (complexWordSearch) complexWordSearch.addEventListener("input", (event) => renderComplexWordEntriesDebounced(event.target.value));
if (complexWordList) complexWordList.addEventListener("click", (event) => {
  const entry = event.target && event.target.closest ? event.target.closest("[data-complex-word]") : null;
  if (entry) editComplexWord(entry.dataset.complexWord);
});
if (complexWordForm) complexWordForm.addEventListener("submit", submitComplexWord);
if (complexWordInfo) complexWordInfo.addEventListener("click", (event) => {
  const button = event.target && event.target.closest ? event.target.closest("[data-word-info-action]") : null;
  if (!button || button.disabled) return;
  if (button.dataset.wordInfoAction === "show-translation") {
    closeComplexWords();
    if (isPanelCollapsed()) setPanelCollapsed(false);
  }
});
if (complexWordWord) complexWordWord.addEventListener("input", syncComplexWordDeleteState);
if (complexWordDelete) complexWordDelete.addEventListener("click", deleteComplexWord);
if (complexWordDialog) complexWordDialog.addEventListener("click", (event) => { if (event.target === complexWordDialog) closeComplexWords(); });
if (glossaryToggle) glossaryToggle.addEventListener("click", () => openGlossary());
if (glossaryClose) glossaryClose.addEventListener("click", closeGlossary);
if (glossarySearch) glossarySearch.addEventListener("input", (event) => renderGlossaryEntriesDebounced(event.target.value));
if (glossaryList) glossaryList.addEventListener("click", (event) => {
  const entry = event.target && event.target.closest ? event.target.closest("[data-glossary-word]") : null;
  if (entry) editGlossaryEntry(entry.dataset.glossaryWord);
});
if (glossaryForm) glossaryForm.addEventListener("submit", submitGlossaryEntry);
if (glossaryWord) glossaryWord.addEventListener("input", syncGlossaryDeleteState);
if (glossaryDelete) glossaryDelete.addEventListener("click", deleteGlossaryEntry);
if (glossaryBackupCreate) glossaryBackupCreate.addEventListener("click", createGlossaryBackup);
if (glossaryBackupRestore) glossaryBackupRestore.addEventListener("click", restoreGlossaryBackup);
if (glossaryBackupDownload) glossaryBackupDownload.addEventListener("click", downloadGlossaryBackup);
if (glossaryBackupDelete) glossaryBackupDelete.addEventListener("click", deleteGlossaryBackup);
if (glossaryDialog) glossaryDialog.addEventListener("click", (event) => { if (event.target === glossaryDialog) closeGlossary(); });
if (zoomOut) zoomOut.addEventListener("click", () => setPdfZoom(pdfZoom - .1));
if (zoomReset) zoomReset.addEventListener("click", () => setPdfZoom(1));
if (zoomIn) zoomIn.addEventListener("click", () => setPdfZoom(pdfZoom + .1));
if (documentPane) {
  documentPane.addEventListener("scroll", schedulePageStatusUpdate, { passive: true });
  documentPane.addEventListener("wheel", (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const delta = Math.max(-80, Math.min(80, Number(event.deltaY) || 0));
    setPdfZoom(pdfZoom - delta * .0015);
  }, { passive: false });
}
document.addEventListener("click", (event) => {
  if (recentDocsMenu && !recentDocsMenu.hidden && recentDocs && !recentDocs.contains(event.target)) closeRecentDocuments();
});

/* ---------------- 文件加载 ---------------- */

async function openPdf(file) {
  if (!file) return;
  const loadId = ++documentLoadSerial;
  rememberRecentDocument(file);
  setDocumentLabel(file, "加载中");
  closeRecentDocuments();
  if (activeLoadingTask && typeof activeLoadingTask.destroy === "function") {
    Promise.resolve(activeLoadingTask.destroy()).catch(() => {});
  }
  if (currentPdf && typeof currentPdf.destroy === "function") {
    Promise.resolve(currentPdf.destroy()).catch(() => {});
  }
  activeLoadingTask = null;
  currentPdf = null;
  updatePageStatus();
  pagesEl.innerHTML = "";
  placeholder.hidden = true;
  sentenceResults.clear();
  pageSentenceTargets.clear();
  // 重置页面虚拟化状态与 mark 引用缓存
  pages.resetVirtualization();
  clearSentenceMarks();
  currentDocumentKey = `${file.name}:${Number(file.size) || 0}`;
  bookmarkLoadSerial++;
  bookmarkCacheKey = null;
  bookmarkCache = [];
  clearPreview();
  clearSelection();
  setPanelCollapsed(isNarrowViewport());
  setNavigationPanel(null);
  setOutlineStatus("正在读取 PDF…");
  try {
    const data = await file.arrayBuffer();
    if (loadId !== documentLoadSerial) return;
    const loadingTask = pdfjsLib.getDocument({ data, isEvalSupported: false });
    activeLoadingTask = loadingTask;
    const pdf = await loadingTask.promise;
    if (loadId !== documentLoadSerial) {
      if (typeof pdf.destroy === "function") await pdf.destroy();
      return;
    }
    activeLoadingTask = null;
    currentPdf = pdf;
    updatePageStatus();
    pages.ensurePageObserver();
    const documentSentenceState = { nextId: 0, pending: null };
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      await pages.parsePage(pdf, pageNum, pagesEl, documentSentenceState, loadId);
      if (loadId !== documentLoadSerial || pdf !== currentPdf) return;
      setDocumentLabel(file, `正在加载 ${pageNum}/${pdf.numPages} 页`);
      updatePageStatus();
      if (pageNum < pdf.numPages) await yieldToBrowser();
    }
    finalizeDocumentSentences(documentSentenceState);
    setDocumentLabel(file);
    updatePageStatus();
    await loadPdfOutline(pdf, loadId);
  } catch (error) {
    if (loadId !== documentLoadSerial) return;
    activeLoadingTask = null;
    currentPdf = null;
    updatePageStatus();
    placeholder.hidden = false;
    placeholder.innerHTML = `<span class="placeholder-mark">!</span><h1>PDF 加载失败</h1><p>${esc(String(error))}</p>`;
    setDocumentLabel(file, "加载失败");
  }
}

function bindFileInput(input) {
  if (!input) return;
  input.addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    openPdf(file);
  });
}

bindFileInput(fileInput);
bindFileInput(emptyFileInput);
setTheme(uiSettings.theme, false);
syncAnalysisControls();
restorePanelWidth();
restoreOutlineWidth();
restorePdfZoom();

/* 测试钩子：虚拟化内部状态经 pages.testApi 委托，保持 getter 实时性。生产环境不依赖。 */
const testHooks = {
  get mountedPageCount() { return pages.testApi.mountedPageCount; },
  get mountedPageNums() { return pages.testApi.mountedPageNums; },
  get hasPageObserver() { return pages.testApi.hasPageObserver; },
  get visibleSlotCount() { return pages.testApi.visibleSlotCount; },
  get activeRenderCount() { return pages.testApi.activeRenderCount; },
  get renderQueueLength() { return pages.testApi.renderQueueLength; },
  get pageCount() { return pages.testApi.pageCount; },
  setPageObserver: (value) => pages.testApi.setPageObserver(value),
  setVisibleSlots: (nums) => pages.testApi.setVisibleSlots(nums),
  setMountedPages: (nums) => pages.testApi.setMountedPages(nums),
  enforceMountedPageLimit: () => pages.testApi.enforceMountedPageLimit(),
  unmountPage: (pageNum) => pages.testApi.unmountPage(pageNum),
  currentVisiblePage,
};
setPanelCollapsed(isNarrowViewport());

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]
  ));
}

/* 实例公开面：浏览器运行时内部自洽，回归测试通过它驱动阅读器行为。 */
return {
  __parseSpecViewerTest: testHooks,
  alignTextDivs,
  buildSentences,
  createPageTargets,
  documentBookmarks,
  endNavResize,
  endResize,
  loadDocumentBookmarks,
  moveNavResize,
  moveResize,
  openPdf,
  openRecentDocuments,
  rememberRecentDocument,
  renderAnalysisPanel,
  renderAnnotationLayer,
  saveDocumentBookmarks,
  sentenceText,
  setAnalysisDepth,
  setBookmarksOpen,
  setDocumentLabel,
  setOutlineOpen,
  setOutlineWidth,
  setPanelCollapsed,
  setPanelWidth,
  setPdfZoom,
  setStructureView,
  setTheme,
  startNavResize,
  startResize,
  submitComplexWord,
  toWords,
  toggleTranslationTerm,
  wireTextLayer,
  wordAtTextOffset,
};
}

globalThis.__parseSpecViewerFactory = createViewer;
// 浏览器页面导入时立即完成一次初始化；Node 测试改为按需调用工厂创建实例。
if (globalThis.document && globalThis.window) createViewer();
