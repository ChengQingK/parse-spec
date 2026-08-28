/* Parse-Spec 前端：pdf.js 渲染、可复制文本层、句子选择、目录与可停靠分析栏。 */

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

const S = 1.4;
const PAGE_GAP_PX = 20;              // 与 style.css #pages 的 gap 保持一致
const MOUNTED_PAGE_LIMIT = 8;        // 页面虚拟化：最多同时挂载的页数
const MOUNT_SETTLE_MS = 120;         // 进入视距后的挂载沉降，过滤快速掠过
const MAX_CONCURRENT_RENDERS = 2;    // canvas 光栅化并发闸门
const CANVAS_MAX_SCALE = 3.2;
const CANVAS_MAX_PIXELS = 16_000_000;
const SEARCH_DEBOUNCE_MS = 150;
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
const OUTLINE_WIDTH_KEY = "parse-spec:outline-width";
const PDF_ZOOM_KEY = "parse-spec:pdf-zoom";
const LEGACY_BOOKMARKS_KEY = "parse-spec:bookmarks";
const DEFAULT_SETTINGS = Object.freeze({ theme: "light", analysisDepth: "standard", structureView: "bracket" });
const VALID_THEMES = new Set(["light", "dark", "eye"]);
const VALID_DEPTHS = new Set(["concise", "standard", "detailed"]);
const VALID_STRUCTURE_VIEWS = new Set(["bracket", "linked"]);
const THEME_ORDER = ["light", "dark", "eye"];
const THEME_LABELS = Object.freeze({ light: "浅色", dark: "暗色", eye: "护眼色" });
const THEME_ICONS = Object.freeze({ light: "☀", dark: "☾", eye: "◐" });
const sentenceResults = new Map();
const pageSentenceTargets = new Map();
const renderComplexWordEntriesDebounced = debounce((value) => renderComplexWordEntries(value), SEARCH_DEBOUNCE_MS);
const renderGlossaryEntriesDebounced = debounce((value) => renderGlossaryEntries(value), SEARCH_DEBOUNCE_MS);

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
let panelCollapsed = false;
let resizeStart = null;
let navResizeStart = null;
let currentDocumentKey = "no-document";
let bookmarkCacheKey = null;
let bookmarkCache = [];
let bookmarkLoadSerial = 0;
let glossaryEntries = [];
let glossaryBackups = [];
let activeGlossarySource = null;
let complexWordEntries = [];
let activeComplexWordSource = null;
let complexWordSuggestionSerial = 0;
let wordInfoSerial = 0;
let activeRecentDocumentKey = null;
let pdfZoom = 1;
let committedPdfZoom = 1;
let zoomCommitTimer = 0;
let pageStatusFrame = 0;
let uiSettings = loadSettings();

/* 页面虚拟化状态：解析阶段只建占位与句子数据，视觉渲染按需挂载/回收。 */
let pageTops = [];
let pageHeights = [];
const pageDataByNum = new Map();
const mountedPages = new Map();
const visibleSlots = new Set();
const mountTimers = new Map();
const markElementsByKey = new Map();
let pageObserver = null;
let activeRenders = 0;
const renderQueue = [];

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
  if (themeIcon) themeIcon.textContent = THEME_ICONS[next];
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
  if (currentPdf) rerenderMountedCanvases();
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

/* ---------------- 句子切分 ---------------- */

function isSentenceEnd(word, next, fontSize, newRow) {
  const wordStr = word.text;
  if (newRow && next && (next.y0 - word.y0) > fontSize * 1.4 && /^[A-Z0-9"'(]/.test(next.text)) return true;
  if (!/[.!?]["')\]]*$/.test(wordStr)) return false;
  if (/^(e\.g\.?|i\.e\.?|etc\.?|vs\.?|viz\.?|Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?|St\.?|No\.?|Fig\.?|Ref\.?|Sec\.?|Eq\.?|Rev\.?|Tab\.?|approx\.?)$/i.test(wordStr)) return false;
  if (/^(?:[A-Z]\.){2,}$/i.test(wordStr)) return false;
  if (!next) return true;
  if (newRow) return true;
  const gap = next.x0 - word.x1;
  const bigGap = gap > Math.max(6, fontSize * 0.35);
  const capStart = /^[A-Z"'(]/.test(next.text);
  // 真实 SPEC 常把“句末 + 下一句开头”放在同一个 TextItem 内，此时视觉间距只有普通空格。
  // 字符边界能证明二者来自同一文本块，直接按句号 + 大写开头切分。
  const sameTextItemBoundary = Number.isInteger(word.itemIndex)
    && word.itemIndex === next.itemIndex
    && Number.isInteger(word.charEnd)
    && Number.isInteger(next.charStart)
    && next.charStart > word.charEnd;
  return capStart && (bigGap || sameTextItemBoundary);
}

function buildSentences(words) {
  if (!words.length) return [];
  const rowTol = 8 * S;
  const rows = [];
  for (const word of words) {
    let placed = false;
    for (const row of rows) {
      if (Math.abs(word.y0 - row.y) < rowTol) {
        row.items.push(word);
        placed = true;
        break;
      }
    }
    if (!placed) rows.push({ y: word.y0, items: [word] });
  }
  rows.sort((a, b) => a.y - b.y);
  for (const row of rows) row.items.sort((a, b) => a.x0 - b.x0);
  // pdf.js 的 TextItem 顺序通常保留文档阅读顺序，对多栏比单纯按 y/x 排序可靠。
  // 缺少 itemIndex 的手工/旧数据才回退到视觉坐标顺序。
  const hasSourceOrder = words.every((word) => Number.isInteger(word.itemIndex));
  const ordered = hasSourceOrder
    ? words.map((word, index) => ({ word, index })).sort((a, b) => a.word.itemIndex - b.word.itemIndex || a.index - b.index).map((item) => item.word)
    : rows.flatMap((row) => row.items);

  const sentences = [];
  let current = [];
  for (let index = 0; index < ordered.length; index++) {
    const word = ordered[index];
    const next = ordered[index + 1];
    current.push(word);
    const newRow = !!(next && (word.hasEOL || Math.abs(next.y0 - word.y0) >= rowTol));
    const fontSize = Math.max(8, word.y1 - word.y0);
    if (isSentenceEnd(word, next, fontSize, newRow)) {
      sentences.push(current);
      current = [];
    }
  }
  if (current.length) sentences.push(current);
  return sentences;
}

function toWords(items, viewport, scale) {
  const words = [];
  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    const raw = String(item.str || "");
    if (!raw.trim()) continue;
    const transform = item.transform || [1, 0, 0, 1, 0, 0];
    const point = viewport.convertToViewportPoint(transform[4], transform[5]);
    const fontSize = Math.max(8, Math.hypot(transform[2], transform[3]) * scale);
    const itemWidth = Math.max(1, Number(item.width || raw.length * fontSize * .5) * scale);
    const parts = Array.from(raw.matchAll(/\S+/g));
    const totalChars = Math.max(1, raw.length);
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const match = parts[partIndex];
      const part = match[0];
      const partX0 = point[0] + itemWidth * (match.index / totalChars);
      const partX1 = point[0] + itemWidth * ((match.index + part.length) / totalChars);
      words.push({
        text: part,
        x0: partX0,
        y0: point[1] - fontSize,
        x1: partX1,
        y1: point[1],
        itemIndex,
        charStart: match.index,
        charEnd: match.index + part.length,
        hasEOL: !!item.hasEOL && partIndex === parts.length - 1,
      });
    }
  }
  return words;
}

/* ---------------- PDF 页面 ---------------- */

function devicePixelRatioSafe() {
  return Math.max(1, Math.min(3, Number(window.devicePixelRatio) || 1));
}

function renderScaleFor(viewport) {
  return fitCanvasScale(
    viewport.width / S,
    viewport.height / S,
    S * devicePixelRatioSafe() * pdfZoom,
    { maxScale: CANVAS_MAX_SCALE, maxPixels: CANVAS_MAX_PIXELS },
  );
}

function acquireRenderSlot() {
  if (activeRenders < MAX_CONCURRENT_RENDERS) {
    activeRenders += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => renderQueue.push(resolve));
}

function releaseRenderSlot() {
  activeRenders = Math.max(0, activeRenders - 1);
  const next = renderQueue.shift();
  if (next) {
    activeRenders += 1;
    next();
  }
}

/* 解析阶段：只取文本与建句子数据，创建定尺寸占位，不做任何视觉渲染。 */
async function parsePage(pdf, pageNum, container, documentSentenceState, loadId) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: S });
  const wrap = document.createElement("div");
  wrap.className = "page-wrap";
  wrap.dataset.pageNumber = String(pageNum);
  wrap.__pdfViewport = viewport;
  wrap.style.setProperty("--scale-factor", String(Number(viewport.scale || S)));
  wrap.style.width = `${Math.floor(viewport.width)}px`;
  wrap.style.height = `${Math.floor(viewport.height)}px`;
  container.appendChild(wrap);
  const textContent = await page.getTextContent();
  if (loadId !== documentLoadSerial || pdf !== currentPdf) return null;
  const words = toWords(textContent.items, viewport, S);
  const sentences = buildSentences(words);
  const sentenceTargets = createPageTargets(sentences, pageNum, documentSentenceState);
  sentenceTargets.forEach((target, sentenceIndex) => {
    pageSentenceTargets.set(`${pageNum}:${sentenceIndex}`, target);
  });
  pageDataByNum.set(pageNum, { page, viewport, textContent, words, sentences, targets: sentenceTargets, wrap });
  pageHeights[pageNum - 1] = Math.floor(viewport.height);  // 与占位取整一致，避免页码坐标漂移
  pageTops[pageNum - 1] = pageNum > 1
    ? (pageTops[pageNum - 2] || 0) + (pageHeights[pageNum - 2] || 0) + PAGE_GAP_PX
    : 0;
  if (pageObserver) pageObserver.observe(wrap);
  else await mountPageVisual(pageNum, loadId);  // 无 IntersectionObserver 的环境回退为全量渲染
  return wrap;
}

function sizeCanvasToViewport(canvas, viewport) {
  const scale = renderScaleFor(viewport);
  canvas.width = Math.max(1, Math.floor((viewport.width / S) * scale));
  canvas.height = Math.max(1, Math.floor((viewport.height / S) * scale));
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  return scale;
}

/* 单个挂载页的位图渲染：先取消在途渲染并等其落定，杜绝同 canvas 并发 render；
   拿到渲染槽后复查状态，任何路径都保证释放槽位。 */
async function renderMountCanvas(mount) {
  const serial = ++mount.renderSerial;
  const data = pageDataByNum.get(mount.pageNum);
  if (!data || !mount.canvas) return;
  if (mount.renderTask && typeof mount.renderTask.cancel === "function") {
    try { mount.renderTask.cancel(); } catch (_ignored) {}
    try { await mount.renderTask.promise; } catch (_ignored) {}
  }
  if (serial !== mount.renderSerial || mount.stage === "unmounted" || mount.loadId !== documentLoadSerial) return;
  const scale = sizeCanvasToViewport(mount.canvas, data.viewport);
  await acquireRenderSlot();
  try {
    if (serial !== mount.renderSerial || mount.stage === "unmounted" || mount.loadId !== documentLoadSerial) return;
    mount.renderTask = data.page.render({ canvasContext: mount.canvas.getContext("2d"), viewport: data.page.getViewport({ scale }) });
    await mount.renderTask.promise;
  } catch (error) {
    if (mount.stage !== "unmounted" && mount.loadId === documentLoadSerial && String(error && error.name) !== "RenderingCancelledException") {
      console.warn(`第 ${mount.pageNum} 页位图渲染失败`, error);
    }
  } finally {
    releaseRenderSlot();
  }
}

/* 渲染阶段：挂载 canvas/textLayer/注解层并接线交互，可取消、受挂载上限约束。 */
async function mountPageVisual(pageNum, loadId = documentLoadSerial) {
  if (mountedPages.has(pageNum)) return mountedPages.get(pageNum).ready;
  const data = pageDataByNum.get(pageNum);
  if (!data || loadId !== documentLoadSerial || !currentPdf) return null;
  const mount = {
    pageNum,
    loadId,
    stage: "mounting",
    zoomAtMount: pdfZoom,
    canvas: null,
    renderTask: null,
    renderSerial: 0,
    targets: null,
    alignedTextDivs: [],
    ready: null,
  };
  mountedPages.set(pageNum, mount);
  mount.ready = (async () => {
    try {
      const { page, viewport, textContent, words, sentences, targets, wrap } = data;
      const canvas = document.createElement("canvas");
      wrap.appendChild(canvas);
      mount.canvas = canvas;
      await renderMountCanvas(mount);
      if (loadId !== documentLoadSerial || mount.stage === "unmounted") return;

      const textLayer = document.createElement("div");
      textLayer.className = "textLayer";
      textLayer.style.width = `${Math.floor(viewport.width)}px`;
      textLayer.style.height = `${Math.floor(viewport.height)}px`;
      wrap.appendChild(textLayer);
      let textDivs = [];
      if (typeof pdfjsLib.TextLayer === "function") {
        const textLayerTask = new pdfjsLib.TextLayer({ textContentSource: textContent, container: textLayer, viewport });
        await textLayerTask.render();
        textDivs = textLayerTask.textDivs || [];
      } else {
        textDivs = [];
        await pdfjsLib.renderTextLayer({ textContent, container: textLayer, viewport, textDivs }).promise;
      }
      textLayer.style.visibility = "visible";
      if (loadId !== documentLoadSerial || mount.stage === "unmounted") return;
      mount.alignedTextDivs = alignTextDivs(textContent.items, textDivs);
      mount.targets = wireTextLayer(textLayer, wrap, sentences, words, pageNum, mount.alignedTextDivs, targets, viewport.width, viewport.height);
      await renderAnnotationLayer(page, viewport, wrap, currentPdf);
      if (typeof page.cleanup === "function") page.cleanup();
      mount.stage = "mounted";
      // 重新挂载的页需要恢复选中/预览高亮
      if (selectedTarget && (selectedTarget.locations || []).some((location) => location.pageNum === pageNum)) {
        addClassToSpans(selectedTarget, "is-selected");
      }
      if (previewTarget && (previewTarget.locations || []).some((location) => location.pageNum === pageNum)) {
        addClassToSpans(previewTarget, "is-preview");
      }
      // 挂载期间发生过缩放提交：位图按新倍率补渲一次
      if (mount.zoomAtMount !== pdfZoom) await renderMountCanvas(mount);
      scheduleExactRectsWarmup(mount);
      enforceMountedPageLimit();
    } catch (error) {
      // 失败页移出挂载表，允许再次进入视距时重试
      if (mount.stage !== "unmounted") mountedPages.delete(pageNum);
      if (mount.stage !== "unmounted" && loadId === documentLoadSerial) {
        console.warn(`第 ${pageNum} 页渲染失败`, error);
      }
    }
  })();
  return mount.ready;
}

function unmountPage(pageNum) {
  const mount = mountedPages.get(pageNum);
  if (!mount) return;
  mount.stage = "unmounted";
  mountedPages.delete(pageNum);
  if (mount.renderTask && typeof mount.renderTask.cancel === "function") {
    try { mount.renderTask.cancel(); } catch (_ignored) {}
  }
  const data = pageDataByNum.get(pageNum);
  if (data && data.wrap) data.wrap.innerHTML = "";  // 占位尺寸由 inline style 保留，无需重设
  for (const key of [...markElementsByKey.keys()]) {
    if (Number(key.split(":")[0]) === pageNum) markElementsByKey.delete(key);
  }
  // 丢弃已脱离 DOM 的 span 引用，重新挂载时由 wireTextLayer 重建
  for (const target of (data && data.targets) || []) {
    target.spans = (target.spans || []).filter((span) => span && span.isConnected !== false);
  }
}

function ensurePageObserver() {
  if (pageObserver || typeof IntersectionObserver !== "function") return pageObserver;
  pageObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const pageNum = Number(entry.target.dataset && entry.target.dataset.pageNumber) || 0;
      if (!pageNum) continue;
      if (entry.isIntersecting) {
        visibleSlots.add(pageNum);
        scheduleMount(pageNum);
      } else {
        visibleSlots.delete(pageNum);
        enforceMountedPageLimit();
      }
    }
  }, { root: documentPane || null, rootMargin: "1600px 0px", threshold: 0 });
  return pageObserver;
}

function scheduleMount(pageNum) {
  if (mountedPages.has(pageNum) || mountTimers.has(pageNum)) return;
  const timer = setTimeout(() => {
    mountTimers.delete(pageNum);
    if (visibleSlots.has(pageNum)) mountPageVisual(pageNum);
  }, MOUNT_SETTLE_MS);
  mountTimers.set(pageNum, timer);
}

function enforceMountedPageLimit() {
  if (!pageObserver) return;  // 无 IO 的回退路径必须保留全部已挂载页
  if (mountedPages.size <= MOUNTED_PAGE_LIMIT) return;
  const current = currentVisiblePage();
  // mountedPages 保持插入序；稳定排序下平局即挂载先后
  const candidates = [...mountedPages.values()]
    .filter((mount) => !visibleSlots.has(mount.pageNum))
    .sort((a, b) => Math.abs(b.pageNum - current) - Math.abs(a.pageNum - current));
  for (const mount of candidates) {
    if (mountedPages.size <= MOUNTED_PAGE_LIMIT) break;
    unmountPage(mount.pageNum);
  }
}

/* 高亮 rect 懒计算：挂载时先用行级回退矩形，空闲时再升级为字符级精确矩形。 */
function computeExactRectsForMount(mount) {
  const data = pageDataByNum.get(mount.pageNum);
  if (!data || !mount.targets || !mount.alignedTextDivs.length) return false;
  const wrapRect = measuredRect(data.wrap, data.viewport.width, data.viewport.height);
  const width = data.viewport.width;
  const height = data.viewport.height;
  const visualScale = wrapRect.width > 0 ? wrapRect.width / width : pdfZoom;
  let upgraded = false;
  mount.targets.forEach((target, sentenceIndex) => {
    const exact = buildSentenceDomRects(data.sentences[sentenceIndex], mount.alignedTextDivs, wrapRect, width, height, null, visualScale);
    if (exact.length) {
      target.rects = exact;
      upgraded = true;
    }
  });
  return upgraded;
}

function restoreHighlightsOnPage(pageNum) {
  if (selectedTarget && (selectedTarget.locations || []).some((location) => location.pageNum === pageNum)) {
    toggleSentenceMarks(selectedTarget, "is-selected", true);
  }
  if (previewTarget && (previewTarget.locations || []).some((location) => location.pageNum === pageNum)) {
    toggleSentenceMarks(previewTarget, "is-preview", true);
  }
}

function scheduleExactRectsWarmup(mount) {
  const idle = (window && typeof window.requestIdleCallback === "function")
    ? (callback) => window.requestIdleCallback(callback, { timeout: 800 })
    : (callback) => setTimeout(callback, 60);
  idle(() => {
    if (mount.stage !== "mounted" || mount.loadId !== documentLoadSerial) return;
    const data = pageDataByNum.get(mount.pageNum);
    if (data && computeExactRectsForMount(mount)) {
      createSentenceMarks(data.wrap, mount.targets);
      restoreHighlightsOnPage(mount.pageNum);  // mark 层整体重建后恢复选中/预览高亮
    }
  });
}

/* 缩放提交后按新倍率重渲已挂载页的 canvas 位图（textLayer/mark 层由 CSS zoom 缩放，无需重建）。 */
function rerenderMountedCanvases() {
  for (const mount of mountedPages.values()) {
    if (mount.stage === "mounted") void renderMountCanvas(mount);
  }
}

function alignTextDivs(items, textDivs) {
  const aligned = new Array((items || []).length);
  let cursor = 0;
  for (let itemIndex = 0; itemIndex < aligned.length; itemIndex++) {
    const source = String(items[itemIndex] && items[itemIndex].str || "");
    if (!source) continue;
    const normalizedSource = source.replace(/\s+/g, " ").trim();
    for (let divIndex = cursor; divIndex < textDivs.length; divIndex++) {
      const span = textDivs[divIndex];
      if (!span) continue;
      const spanText = String(span.textContent || "");
      const normalizedSpan = spanText.replace(/\s+/g, " ").trim();
      const matches = spanText === source || (normalizedSource && normalizedSpan === normalizedSource)
        || (!normalizedSource && !normalizedSpan);
      if (!matches) continue;
      aligned[itemIndex] = span;
      cursor = divIndex + 1;
      break;
    }
  }
  return aligned;
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
  if (!currentPdf || !action || !pageTops.length) return false;
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

function sentenceText(sentence) {
  return (sentence || []).map((word) => word.text).join(" ").replace(/\s+([.,;:!?])/g, "$1").trim();
}

function hasTerminalPunctuation(sentence) {
  const text = sentenceText(sentence);
  return /[.!?]["')\]]*$/.test(text);
}

function shouldMergeAcrossPages(previousSentence, nextSentence) {
  if (!previousSentence || !nextSentence || hasTerminalPunctuation(previousSentence)) return false;
  const previousText = sentenceText(previousSentence);
  const first = nextSentence[0] && nextSentence[0].text;
  if (!first) return false;
  if (/-$/.test(previousText)) return /^[a-z]/.test(first);
  return /^[a-z,;:)\]]/.test(first)
    || /^(?:and|or|but|because|which|that|when|where|while|if|unless|until|to)$/i.test(first);
}

function joinAcrossPages(previousText, nextText) {
  if (/-$/.test(previousText) && /^[a-z]/.test(nextText)) return `${previousText.slice(0, -1)}${nextText}`;
  return `${previousText} ${nextText}`.replace(/\s+/g, " ").trim();
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

function finalizeDocumentSentences(state) {
  if (state && state.pending && state.pending.target) {
    const target = state.pending.target;
    if (!(target.contextWarnings || []).length) {
      target.contextWarnings = ["文档末尾没有明确句末标点，请确认句子是否完整。"];
    }
  }
}

function wireTextLayer(
  textLayer,
  wrap,
  sentences,
  words,
  pageNum,
  renderedTextDivs = [],
  providedTargets = null,
  pageWidth = null,
  pageHeight = null,
) {
  const rowTol = 8 * S;
  const rows = [];
  for (const word of words) {
    let placed = false;
    for (const row of rows) {
      if (Math.abs(word.y0 - row.y) < rowTol) {
        row.items.push(word);
        placed = true;
        break;
      }
    }
    if (!placed) rows.push({ y: word.y0, items: [word] });
  }
  const rowYs = rows.map((row) => row.y);
  const rowToSentence = new Map();
  sentences.forEach((sentence, sentenceIndex) => {
    for (const word of sentence) {
      for (let rowIndex = 0; rowIndex < rowYs.length; rowIndex++) {
        if (Math.abs(rowYs[rowIndex] - word.y0) < rowTol) {
          rowToSentence.set(rowIndex, sentenceIndex);
          break;
        }
      }
    }
  });

  const sentenceTexts = sentences.map(sentenceText);
  const analysisTargets = sentences.map((sentence, sentenceIndex) => (
    providedTargets && providedTargets[sentenceIndex]
      ? providedTargets[sentenceIndex]
      : {
          key: `${pageNum}:${sentenceIndex}`,
          pageNum,
          endPageNum: pageNum,
          sentenceIndex,
          text: sentenceTexts[sentenceIndex],
          spans: [],
          locations: [],
          contextWarnings: [],
        }
  ));
  const wrapRect = wrap.getBoundingClientRect();
  const derivedWidth = Math.max(0, ...words.map((word) => Number(word.x1) || 0));
  const derivedHeight = Math.max(0, ...words.map((word) => Number(word.y1) || 0));
  const width = Number.isFinite(pageWidth) ? pageWidth : Math.max(0, Number(wrapRect.width) || derivedWidth);
  const height = Number.isFinite(pageHeight) ? pageHeight : Math.max(0, Number(wrapRect.height) || derivedHeight);
  // 挂载时先用行级回退矩形（纯坐标计算，零布局开销）；
  // 字符级精确矩形由 scheduleExactRectsWarmup 在空闲时升级，避免加载期同步布局风暴。
  const targets = analysisTargets.map((analysisTarget, sentenceIndex) => {
    if (!analysisTarget.locations.some((location) => location.pageNum === pageNum && location.sentenceIndex === sentenceIndex)) {
      analysisTarget.locations.push({ pageNum, sentenceIndex });
    }
    return {
      analysisTarget,
      pageNum,
      sentenceIndex,
      rects: computeFallbackRects(sentences[sentenceIndex], rowTol, width, height),
    };
  });
  analysisTargets.forEach((target, sentenceIndex) => {
    pageSentenceTargets.set(`${pageNum}:${sentenceIndex}`, target);
  });
  const normalize = (value) => String(value).replace(/\s+/g, " ").trim();
  const normalizedSentences = sentenceTexts.map(normalize);

  const availableTextDivs = renderedTextDivs.filter(Boolean);
  const textSpans = availableTextDivs.length ? availableTextDivs : Array.from(textLayer.querySelectorAll("span"));
  for (const span of textSpans) {
    if (span.classList.contains("endOfContent") || !span.textContent.trim()) continue;
    const spanText = normalize(span.textContent);
    if (spanText.length < 2) continue;
    const matches = [];
    for (let index = 0; index < normalizedSentences.length; index++) {
      if (normalizedSentences[index].includes(spanText)) matches.push(index);
    }
    let sentenceIndex = -1;
    if (matches.length === 1) {
      sentenceIndex = matches[0];
    } else if (matches.length > 1) {
      const rect = span.getBoundingClientRect();
      const spanY = rect.top - wrapRect.top;
      for (let rowIndex = 0; rowIndex < rowYs.length; rowIndex++) {
        if (Math.abs(rowYs[rowIndex] - spanY) < rowTol) {
          sentenceIndex = rowToSentence.get(rowIndex) ?? -1;
          break;
        }
      }
      if (sentenceIndex < 0) sentenceIndex = matches[0];
    }
    if (sentenceIndex < 0) continue;
    span.dataset.sentId = String(sentenceIndex);
    analysisTargets[sentenceIndex].spans.push(span);
  }

  const eventTarget = (event) => {
    const rect = wrap.getBoundingClientRect ? wrap.getBoundingClientRect() : wrapRect;
    const localTarget = targetAtPoint(
      targets,
      (Number(event.clientX) - rect.left) / pdfZoom,
      (Number(event.clientY) - rect.top) / pdfZoom,
    );
    return localTarget ? localTarget.analysisTarget : null;
  };
  // 悬停命中：leading 边同步处理（保证首次移动即时反馈），帧内后续事件合并为 trailing。
  let hoverFrame = 0;
  let pendingHover = null;
  const processHover = (event) => {
    if (hasTextSelection()) return;
    const target = eventTarget(event);
    if (target) setPreview(target);
    else clearPreview();
  };
  textLayer.addEventListener("mousemove", (event) => {
    if (hoverFrame) {
      pendingHover = { clientX: event.clientX, clientY: event.clientY };
      return;
    }
    processHover(event);
    hoverFrame = requestUiFrame(() => {
      hoverFrame = 0;
      if (pendingHover) {
        const latest = pendingHover;
        pendingHover = null;
        processHover(latest);
      }
    });
  });
  textLayer.addEventListener("mouseleave", () => {
    pendingHover = null;
    clearPreview();
  });
  textLayer.addEventListener("click", (event) => {
    if (hasTextSelection()) return;
    const target = eventTarget(event);
    if (target) selectSentence(target);
  });
  createSentenceMarks(wrap, targets);
  return targets;
}

/* ---------------- 预览与选中状态 ---------------- */

function hasTextSelection() {
  return !!(window.getSelection && window.getSelection().toString());
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

/* ---------------- PDF 目录 ---------------- */

function setNavigationPanel(kind) {
  const showOutline = kind === "outline";
  const showBookmarks = kind === "bookmarks";
  const open = showOutline || showBookmarks;
  if (open && isNarrowViewport() && !panelCollapsed) setPanelCollapsed(true);
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

function clampOutlineWidth(value) {
  return Math.max(220, Math.min(520, Math.round(Number(value) || 300)));
}

function setOutlineWidth(value, persist = false) {
  const width = clampOutlineWidth(value);
  workspace.style.setProperty("--outline-width", `${width}px`);
  if (navResizer) navResizer.setAttribute("aria-valuenow", String(width));
  if (persist) {
    try { if (window.localStorage) window.localStorage.setItem(OUTLINE_WIDTH_KEY, String(width)); } catch (_ignored) {}
  }
  return width;
}

function outlineWidth() {
  const fromStyle = parseInt(workspace.style.getPropertyValue("--outline-width"), 10);
  return clampOutlineWidth(Number.isFinite(fromStyle) ? fromStyle : 300);
}

function restoreOutlineWidth() {
  let saved = 300;
  try { saved = parseInt(window.localStorage && window.localStorage.getItem(OUTLINE_WIDTH_KEY), 10) || 300; } catch (_ignored) {}
  setOutlineWidth(saved, false);
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

function clearLiveResizeStyles(element) {
  if (!element) return;
  element.classList.remove("is-live-resizing");
  for (const property of ["left", "right", "top", "bottom", "width", "height"]) element.style[property] = "";
}

function finishLiveResize(panel, resizer) {
  // 先让浏览器在侧栏仍独立悬浮时完成 PDF 网格的一次性布局，再归位侧栏。
  requestUiFrame(() => {
    if (workspace.getBoundingClientRect) workspace.getBoundingClientRect();
    requestUiFrame(() => {
      clearLiveResizeStyles(panel);
      clearLiveResizeStyles(resizer);
      workspace.classList.remove("is-live-resizing");
    });
  });
}

function applyNavOverlayWidth(state) {
  if (!state || !state.panel) return;
  const width = state.pendingWidth;
  state.panel.style.left = `${state.panelRect.left}px`;
  state.panel.style.top = `${state.panelRect.top}px`;
  state.panel.style.width = `${width}px`;
  state.panel.style.height = `${state.panelRect.height}px`;
  state.resizer.style.left = `${state.panelRect.left + width}px`;
  state.resizer.style.top = `${state.panelRect.top}px`;
  state.resizer.style.width = `${state.resizerRect.width || 6}px`;
  state.resizer.style.height = `${state.panelRect.height}px`;
}

function startNavResize(event) {
  if (!workspace.classList.contains("outline-open")) return;
  const width = outlineWidth();
  const panel = outlinePanel && !outlinePanel.hidden ? outlinePanel : bookmarkPanel;
  if (!panel) return;
  navResizeStart = {
    x: Number(event.clientX) || 0,
    width,
    pendingWidth: width,
    panel,
    panelRect: measuredRect(panel, width, workspace.clientHeight || 0),
    resizer: navResizer,
    resizerRect: measuredRect(navResizer, 6, workspace.clientHeight || 0),
  };
  workspace.classList.add("is-live-resizing");
  panel.classList.add("is-live-resizing");
  navResizer.classList.add("is-live-resizing");
  applyNavOverlayWidth(navResizeStart);
  navResizer.classList.add("is-dragging");
  document.body.classList.add("is-resizing-x");
  if (event.preventDefault) event.preventDefault();
  if (navResizer.setPointerCapture && event.pointerId !== undefined) navResizer.setPointerCapture(event.pointerId);
}

function moveNavResize(event) {
  if (!navResizeStart) return;
  navResizeStart.pendingWidth = clampOutlineWidth(navResizeStart.width + (Number(event.clientX) || 0) - navResizeStart.x);
  applyNavOverlayWidth(navResizeStart);
  if (event.preventDefault) event.preventDefault();
}

function endNavResize() {
  if (!navResizeStart) return;
  const state = navResizeStart;
  const pendingWidth = state.pendingWidth;
  navResizeStart = null;
  setOutlineWidth(pendingWidth, true);
  navResizer.classList.remove("is-dragging");
  document.body.classList.remove("is-resizing-x");
  finishLiveResize(state.panel, state.resizer);
}

function resizeNavByKeyboard(event) {
  if (!workspace.classList.contains("outline-open") || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  event.preventDefault();
  setOutlineWidth(outlineWidth() + (event.key === "ArrowRight" ? 16 : -16), true);
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
  if (!pageTops.length) return 1;
  const scrollTop = documentPane ? (Number(documentPane.scrollTop) || 0) / (committedPdfZoom || 1) : 0;
  return pageIndexAtScroll(pageTops, pageHeights, scrollTop) + 1;
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

/* ---------------- 术语表 ---------------- */

function renderComplexWordEntries(query = "") {
  if (!complexWordList) return;
  const needle = String(query).trim().toLowerCase();
  const visible = complexWordEntries.filter((entry) => !needle
    || entry.word.toLowerCase().includes(needle)
    || String(entry.zh || "").toLowerCase().includes(needle));
  if (!visible.length) {
    complexWordList.innerHTML = `<div class="outline-empty">没有匹配单词。可在右侧新增。</div>`;
    return;
  }
  complexWordList.innerHTML = visible.slice(0, 500).map((entry) => `
    <button class="glossary-entry" type="button" data-complex-word="${esc(entry.word)}">
      <span><strong>${esc(entry.word)}</strong><span class="glossary-source">${entry.source === "custom" ? "自定义" : "内置"}</span><br><small>${esc(entry.level || "较难")}</small></span>
      <span>${esc(entry.zh || "")}</span>
    </button>`).join("");
}

async function loadComplexWordEntries() {
  if (complexWordList) complexWordList.innerHTML = `<div class="outline-empty">正在读取复杂词表…</div>`;
  try {
    const response = await fetch("/api/complex-words");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    complexWordEntries = Array.isArray(data.entries) ? data.entries : [];
    renderComplexWordEntries(complexWordSearch ? complexWordSearch.value : "");
  } catch (error) {
    complexWordEntries = [];
    if (complexWordList) complexWordList.innerHTML = `<div class="outline-empty">复杂词表读取失败：${esc(String(error))}</div>`;
  }
}

async function suggestComplexWordMeaning(word) {
  const requestId = ++complexWordSuggestionSerial;
  if (complexWordMessage) {
    complexWordMessage.classList.remove("is-error");
    complexWordMessage.textContent = `正在查询“${word}”的本地释义…`;
  }
  try {
    const response = await fetch(`/api/complex-words/suggest?word=${encodeURIComponent(word)}`);
    const data = await response.json();
    if (requestId !== complexWordSuggestionSerial || !complexWordWord || complexWordWord.value.trim().toLowerCase() !== word) return;
    if (!response.ok || !data.suggestion) throw new Error(data.error || `HTTP ${response.status}`);
    const suggestion = data.suggestion;
    if (complexWordZh) complexWordZh.value = suggestion.zh || "";
    if (complexWordLevel) complexWordLevel.value = suggestion.level || "较难";
    if (complexWordNote) complexWordNote.value = suggestion.note || "";
    if (complexWordMessage) {
      const origin = suggestion.source === "online" ? "在线词典" : "本地词典";
      complexWordMessage.textContent = `已自动填充“${word}”的${origin}释义，请确认后保存。`;
    }
  } catch (error) {
    if (requestId !== complexWordSuggestionSerial) return;
    if (complexWordMessage) {
      complexWordMessage.classList.add("is-error");
      complexWordMessage.textContent = `自动释义失败：${String(error)}。本地词典未命中时不会猜测词义。`;
    }
  }
}

function renderWordInfoHtml(word, info) {
  const chips = (label, items) => (items && items.length
    ? `<div class="word-info-chips"><span class="word-info-label">${label}</span>${items.map((item) => `<span class="word-info-chip">${esc(item)}</span>`).join("")}</div>`
    : "");
  const posHtml = (info.pos_entries || []).map((entry) => `
    <div class="word-info-pos">
      <span class="word-info-pos-tag">${esc(entry.pos || "unknown")}</span>
      ${(entry.definitions || []).length ? `<ol class="word-info-defs">${entry.definitions.map((definition) => `<li>${esc(definition)}</li>`).join("")}</ol>` : ""}
      ${(entry.examples || []).map((example) => `<div class="word-info-example">例：${esc(example)}</div>`).join("")}
      ${chips("同义", entry.synonyms)}
    </div>`).join("");
  return `
    <div class="word-info-head">
      <strong>${esc(info.word || word)}</strong>
      ${info.phonetic ? `<span class="word-info-phonetic">${esc(info.phonetic)}</span>` : ""}
      <span class="word-info-source">${esc(info.source || "在线词典")}</span>
    </div>
    ${chips("在线中文", info.zh_gloss)}
    ${posHtml}
    ${(info.examples || []).map((example) => `<div class="word-info-example">例：${esc(example)}</div>`).join("")}
    ${chips("搭配", info.collocations)}
    <div class="word-info-actions">
      <button class="secondary-action" type="button" data-word-info-action="show-translation"${selectedTarget ? "" : " disabled"}>查看当前句译文</button>
    </div>`;
}

function clearWordInfo() {
  wordInfoSerial += 1;
  if (complexWordInfo) {
    complexWordInfo.hidden = true;
    complexWordInfo.innerHTML = "";
  }
}

async function loadWordInfo(word) {
  if (!complexWordInfo) return;
  const normalized = String(word || "").trim().toLowerCase();
  if (!normalized) {
    clearWordInfo();
    return;
  }
  const requestId = ++wordInfoSerial;
  complexWordInfo.hidden = false;
  complexWordInfo.innerHTML = `<div class="word-info-empty">正在查询“${esc(normalized)}”的在线词典详情…</div>`;
  try {
    const response = await fetch(`/api/word-info?word=${encodeURIComponent(normalized)}`);
    const data = await response.json();
    if (requestId !== wordInfoSerial) return;
    if (!response.ok || !data.info) throw new Error(data.error || `HTTP ${response.status}`);
    complexWordInfo.innerHTML = renderWordInfoHtml(normalized, data.info);
  } catch (error) {
    if (requestId !== wordInfoSerial) return;
    complexWordInfo.innerHTML = `<div class="word-info-empty">在线详情不可用（${esc(String(error))}），上方为本地释义。</div>`;
  }
}

function editComplexWord(word) {
  const normalized = String(word || "").trim().toLowerCase();
  const entry = complexWordEntries.find((item) => item.word.toLowerCase() === normalized);
  activeComplexWordSource = entry ? entry.source : null;
  if (complexWordWord) complexWordWord.value = entry ? entry.word : normalized;
  if (complexWordLevel) complexWordLevel.value = entry ? (entry.level || "较难") : "较难";
  if (complexWordZh) complexWordZh.value = entry ? (entry.zh || "") : "";
  if (complexWordNote) complexWordNote.value = entry ? (entry.note || "") : "";
  if (complexWordDelete) complexWordDelete.disabled = !entry || entry.source !== "custom";
  if (complexWordMessage) {
    complexWordMessage.classList.remove("is-error");
    complexWordMessage.textContent = entry
      ? (entry.source === "custom" ? "正在编辑自定义复杂词。" : "保存后会在 complex_words.json 中覆盖该内置释义。")
      : `已从原文选中“${normalized}”，正在自动查询中文释义。`;
  }
  if (!entry && normalized) suggestComplexWordMeaning(normalized);
  if (normalized) loadWordInfo(normalized);
  else clearWordInfo();
}

async function openComplexWords(word = "") {
  if (!complexWordDialog || !complexWordToggle) return;
  if (glossaryDialog && !glossaryDialog.hidden) closeGlossary();
  complexWordDialog.hidden = false;
  complexWordToggle.setAttribute("aria-expanded", "true");
  const normalized = String(word || "").trim().toLowerCase();
  if (complexWordSearch) complexWordSearch.value = normalized;
  await loadComplexWordEntries();
  if (normalized) {
    renderComplexWordEntries(normalized);
    editComplexWord(normalized);
  }
  if (normalized && complexWordZh && complexWordZh.focus) complexWordZh.focus();
  else if (complexWordSearch && complexWordSearch.focus) complexWordSearch.focus();
}

function closeComplexWords() {
  if (!complexWordDialog || !complexWordToggle) return;
  wordInfoSerial += 1;  // 关闭作废弃中的详情请求
  complexWordDialog.hidden = true;
  complexWordToggle.setAttribute("aria-expanded", "false");
}

function syncComplexWordDeleteState() {
  const word = complexWordWord ? complexWordWord.value.trim().toLowerCase() : "";
  const entry = complexWordEntries.find((item) => item.word.toLowerCase() === word);
  activeComplexWordSource = entry ? entry.source : null;
  if (complexWordDelete) complexWordDelete.disabled = !entry || entry.source !== "custom";
}

async function submitComplexWord(event) {
  if (event && event.preventDefault) event.preventDefault();
  const payload = {
    word: complexWordWord ? complexWordWord.value.trim() : "",
    level: complexWordLevel ? complexWordLevel.value : "较难",
    zh: complexWordZh ? complexWordZh.value.trim() : "",
    note: complexWordNote ? complexWordNote.value.trim() : "",
  };
  try {
    const response = await fetch("/api/complex-words", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    await loadComplexWordEntries();
    if (complexWordSearch) complexWordSearch.value = data.entry.word;
    renderComplexWordEntries(data.entry.word);
    editComplexWord(data.entry.word);
    if (complexWordMessage) complexWordMessage.textContent = `已保存“${data.entry.word}”，当前句会立即重新识别复杂词。`;
    invalidateSentenceResultsFor(data.entry.word);
    refreshSelectedAnalysis();
  } catch (error) {
    if (complexWordMessage) {
      complexWordMessage.classList.add("is-error");
      complexWordMessage.textContent = `保存失败：${String(error)}`;
    }
  }
}

async function deleteComplexWord() {
  const word = complexWordWord ? complexWordWord.value.trim().toLowerCase() : "";
  if (!word || activeComplexWordSource !== "custom") return;
  if (typeof window.confirm === "function" && !window.confirm(`确定删除自定义复杂词“${word}”？`)) return;
  try {
    const response = await fetch("/api/complex-words", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ word }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    await loadComplexWordEntries();
    if (complexWordSearch) complexWordSearch.value = word;
    renderComplexWordEntries(word);
    editComplexWord(word);
    if (complexWordMessage) complexWordMessage.textContent = data.reverted_to_builtin
      ? `已删除“${word}”的自定义覆盖，恢复为内置释义。`
      : `已删除自定义复杂词“${word}”。`;
    invalidateSentenceResultsFor(word);
    refreshSelectedAnalysis();
  } catch (error) {
    if (complexWordMessage) {
      complexWordMessage.classList.add("is-error");
      complexWordMessage.textContent = `删除失败：${String(error)}`;
    }
  }
}

function wordAtTextOffset(text, rawOffset) {
  const source = String(text || "");
  const offset = Math.max(0, Math.min(source.length, Number(rawOffset) || 0));
  const pattern = /[A-Za-z][A-Za-z'-]*/g;
  for (const match of source.matchAll(pattern)) {
    const end = match.index + match[0].length;
    if (offset >= match.index && offset <= end) return match[0].toLowerCase();
  }
  return "";
}

function sourceWordFromContextEvent(event, root) {
  if (!root) return "";
  const selection = window.getSelection ? window.getSelection() : null;
  const selected = selection ? String(selection.toString()).trim() : "";
  if (/^[A-Za-z][A-Za-z'-]*$/.test(selected) && (!selection.anchorNode || root.contains(selection.anchorNode))) return selected.toLowerCase();
  let node = null;
  let offset = 0;
  const position = document.caretPositionFromPoint && document.caretPositionFromPoint(event.clientX, event.clientY);
  if (position) {
    node = position.offsetNode;
    offset = position.offset;
  } else if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(event.clientX, event.clientY);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  }
  if (!node || !root.contains(node) || !document.createRange) return "";
  const prefix = document.createRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(node, offset);
  return wordAtTextOffset(root.textContent, prefix.toString().length);
}

function renderGlossaryEntries(query = "") {
  if (!glossaryList) return;
  const needle = String(query).trim().toLowerCase();
  const visible = glossaryEntries.filter((entry) => !needle
    || entry.word.toLowerCase().includes(needle)
    || entry.zh.toLowerCase().includes(needle)
    || String(entry.note || "").toLowerCase().includes(needle));
  if (!visible.length) {
    glossaryList.innerHTML = `<div class="outline-empty">没有匹配词条。可在右侧新增。</div>`;
    return;
  }
  glossaryList.innerHTML = visible.slice(0, 400).map((entry) => `
    <button class="glossary-entry" type="button" data-glossary-word="${esc(entry.word)}">
      <span><strong>${esc(entry.word)}</strong><span class="glossary-source">${entry.source === "custom" ? "自定义" : "内置"}</span><br><small>${esc(entry.pos || "未标词性")}</small></span>
      <span>${esc(entry.zh)}<br><small>${esc(entry.note || "")}</small></span>
    </button>`).join("");
}

async function loadGlossaryEntries() {
  if (glossaryList) glossaryList.innerHTML = `<div class="outline-empty">正在读取本地术语表…</div>`;
  try {
    const response = await fetch("/api/glossary");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    glossaryEntries = Array.isArray(data.entries) ? data.entries : [];
    renderGlossaryEntries(glossarySearch ? glossarySearch.value : "");
  } catch (error) {
    if (glossaryList) glossaryList.innerHTML = `<div class="outline-empty">术语表读取失败：${esc(String(error))}</div>`;
  }
}

function renderGlossaryBackups() {
  if (!glossaryBackupSelect) return;
  const selected = glossaryBackupSelect.value;
  glossaryBackupSelect.innerHTML = glossaryBackups.length
    ? glossaryBackups.map((backup) => `<option value="${esc(backup.filename)}">${esc(backup.created_at || backup.filename)} · ${Number(backup.entry_count) || 0} 条 · ${esc(backup.reason || "备份")}</option>`).join("")
    : '<option value="">暂无备份</option>';
  if (glossaryBackups.some((backup) => backup.filename === selected)) glossaryBackupSelect.value = selected;
}

async function loadGlossaryBackups() {
  try {
    const response = await fetch("/api/glossary/backups");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    glossaryBackups = Array.isArray(data.backups) ? data.backups : [];
    renderGlossaryBackups();
  } catch (error) {
    glossaryBackups = [];
    renderGlossaryBackups();
    if (glossaryMessage) {
      glossaryMessage.classList.add("is-error");
      glossaryMessage.textContent = `备份列表读取失败：${String(error)}`;
    }
  }
}

async function createGlossaryBackup() {
  if (glossaryMessage) {
    glossaryMessage.classList.remove("is-error");
    glossaryMessage.textContent = "正在创建备份…";
  }
  try {
    const response = await fetch("/api/glossary/backups", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    await loadGlossaryBackups();
    if (glossaryBackupSelect && data.backup) glossaryBackupSelect.value = data.backup.filename;
    if (glossaryMessage) glossaryMessage.textContent = "术语表备份已保存到项目 backups/glossary 目录。";
  } catch (error) {
    if (glossaryMessage) {
      glossaryMessage.classList.add("is-error");
      glossaryMessage.textContent = `备份失败：${String(error)}`;
    }
  }
}

async function restoreGlossaryBackup() {
  const filename = glossaryBackupSelect && glossaryBackupSelect.value;
  if (!filename) return;
  if (typeof window.confirm === "function" && !window.confirm("恢复所选备份？当前术语表会先自动备份。")) return;
  if (glossaryMessage) {
    glossaryMessage.classList.remove("is-error");
    glossaryMessage.textContent = "正在恢复备份…";
  }
  try {
    const response = await fetch("/api/glossary/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    invalidateSentenceResultsFor("");
    await Promise.all([loadGlossaryEntries(), loadGlossaryBackups()]);
    if (glossaryMessage) glossaryMessage.textContent = `已从 ${filename} 恢复术语表。`;
    if (selectedTarget) {
      const requestId = ++requestSerial;
      renderLoadingPanel(selectedTarget);
      loadAndRender(selectedTarget, requestId, true);
    }
  } catch (error) {
    if (glossaryMessage) {
      glossaryMessage.classList.add("is-error");
      glossaryMessage.textContent = `恢复失败：${String(error)}`;
    }
  }
}

function downloadGlossaryBackup() {
  const filename = glossaryBackupSelect && glossaryBackupSelect.value;
  if (!filename || !window.location) return;
  window.location.href = `/api/glossary/backups/${encodeURIComponent(filename)}`;
}

async function deleteGlossaryBackup() {
  const filename = glossaryBackupSelect && glossaryBackupSelect.value;
  if (!filename) return;
  if (typeof window.confirm === "function" && !window.confirm(`确定删除备份 ${filename}？此操作无法恢复。`)) return;
  try {
    const response = await fetch(`/api/glossary/backups/${encodeURIComponent(filename)}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    await loadGlossaryBackups();
    if (glossaryMessage) glossaryMessage.textContent = `已删除备份 ${filename}。`;
  } catch (error) {
    if (glossaryMessage) {
      glossaryMessage.classList.add("is-error");
      glossaryMessage.textContent = `删除备份失败：${String(error)}`;
    }
  }
}

async function openGlossary(word = "") {
  if (!glossaryDialog || !glossaryToggle) return;
  if (complexWordDialog && !complexWordDialog.hidden) closeComplexWords();
  glossaryDialog.hidden = false;
  glossaryToggle.setAttribute("aria-expanded", "true");
  const needle = String(word).trim();
  if (glossarySearch) glossarySearch.value = needle;
  await Promise.all([loadGlossaryEntries(), loadGlossaryBackups()]);
  if (needle) {
    renderGlossaryEntries(needle);
    editGlossaryEntry(glossaryEntries.find((entry) => entry.word.toLowerCase() === needle.toLowerCase())?.word || needle);
  }
  if (glossarySearch && glossarySearch.focus) glossarySearch.focus();
}

function closeGlossary() {
  if (!glossaryDialog || !glossaryToggle) return;
  glossaryDialog.hidden = true;
  glossaryToggle.setAttribute("aria-expanded", "false");
}

function editGlossaryEntry(word) {
  const entry = glossaryEntries.find((item) => item.word === word);
  if (!entry) return;
  activeGlossarySource = entry.source;
  if (glossaryWord) glossaryWord.value = entry.word;
  if (glossaryPos) glossaryPos.value = entry.pos || "";
  if (glossaryZh) glossaryZh.value = entry.zh || "";
  if (glossaryNote) glossaryNote.value = entry.note || "";
  if (glossaryDelete) {
    glossaryDelete.disabled = entry.source !== "custom";
    glossaryDelete.title = entry.source === "custom" ? `删除自定义词条 ${entry.word}` : "内置词条不能删除；保存覆盖后可删除自定义覆盖";
  }
  if (glossaryMessage) {
    glossaryMessage.classList.remove("is-error");
    glossaryMessage.textContent = entry.source === "custom" ? "正在编辑自定义词条。" : "保存后会在 glossary.json 中覆盖该内置释义。";
  }
}

function syncGlossaryDeleteState() {
  const word = glossaryWord ? glossaryWord.value.trim().toLowerCase() : "";
  const entry = glossaryEntries.find((item) => item.word.toLowerCase() === word);
  activeGlossarySource = entry ? entry.source : null;
  if (glossaryDelete) glossaryDelete.disabled = !entry || entry.source !== "custom";
}

async function deleteGlossaryEntry() {
  const word = glossaryWord ? glossaryWord.value.trim().toLowerCase() : "";
  if (!word || activeGlossarySource !== "custom") return;
  if (typeof window.confirm === "function" && !window.confirm(`确定删除自定义词条“${word}”？删除前会自动备份。`)) return;
  try {
    const response = await fetch("/api/glossary", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ word }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    invalidateSentenceResultsFor(word);
    await Promise.all([loadGlossaryEntries(), loadGlossaryBackups()]);
    if (glossarySearch) glossarySearch.value = word;
    renderGlossaryEntries(word);
    const fallback = glossaryEntries.find((item) => item.word === word);
    if (fallback) editGlossaryEntry(word);
    else {
      if (glossaryWord) glossaryWord.value = "";
      if (glossaryPos) glossaryPos.value = "";
      if (glossaryZh) glossaryZh.value = "";
      if (glossaryNote) glossaryNote.value = "";
      activeGlossarySource = null;
      if (glossaryDelete) glossaryDelete.disabled = true;
    }
    if (glossaryMessage) glossaryMessage.textContent = data.reverted_to_builtin
      ? `已删除“${word}”的自定义覆盖，当前恢复为内置释义。`
      : `已删除自定义词条“${word}”。`;
  } catch (error) {
    if (glossaryMessage) {
      glossaryMessage.classList.add("is-error");
      glossaryMessage.textContent = `删除词条失败：${String(error)}`;
    }
  }
}

async function submitGlossaryEntry(event) {
  if (event && event.preventDefault) event.preventDefault();
  const payload = {
    word: glossaryWord ? glossaryWord.value.trim() : "",
    pos: glossaryPos ? glossaryPos.value.trim() : "",
    zh: glossaryZh ? glossaryZh.value.trim() : "",
    note: glossaryNote ? glossaryNote.value.trim() : "",
  };
  if (glossaryMessage) {
    glossaryMessage.classList.remove("is-error");
    glossaryMessage.textContent = "正在保存…";
  }
  try {
    const response = await fetch("/api/glossary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    invalidateSentenceResultsFor(data.entry.word);
    await Promise.all([loadGlossaryEntries(), loadGlossaryBackups()]);
    if (glossarySearch) glossarySearch.value = data.entry.word;
    renderGlossaryEntries(data.entry.word);
    activeGlossarySource = "custom";
    if (glossaryDelete) glossaryDelete.disabled = false;
    if (glossaryMessage) glossaryMessage.textContent = `已保存“${data.entry.word}”，当前句的翻译与术语会重新解析。`;
    if (selectedTarget) {
      const requestId = ++requestSerial;
      renderLoadingPanel(selectedTarget);
      loadAndRender(selectedTarget, requestId, true);
    }
  } catch (error) {
    if (glossaryMessage) {
      glossaryMessage.classList.add("is-error");
      glossaryMessage.textContent = `保存失败：${String(error)}`;
    }
  }
}

function offsetWithin(element, ancestor, axis = "top") {
  let total = 0;
  let current = element;
  const key = axis === "left" ? "offsetLeft" : "offsetTop";
  while (current && current !== ancestor) {
    total += Number(current[key] || 0);
    current = current.offsetParent;
  }
  return total;
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
    // offsetTop/scrollTop 是 CSS zoom 后的缩放坐标，页内坐标需同步乘以缩放倍率
    const zoom = committedPdfZoom || 1;
    documentPane.scrollTo({
      top: Math.max(0, offsetWithin(pageElement, documentPane, "top") + localY * zoom - 12),
      left: Math.max(0, offsetWithin(pageElement, documentPane, "left") + localX * zoom - 12),
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

/* ---------------- 分析栏渲染 ---------------- */

function renderEmptyPanel() {
  analysisContent.innerHTML = `<div class="panel-empty">
    <span class="panel-empty-icon">↗</span>
    <h3>从 PDF 中选择一句话</h3>
    <p>悬停查看句子范围，单击锁定分析。解析方式和面板位置可在分析栏顶部直接调整。</p>
  </div>`;
}

function targetLocationText(target) {
  const startPage = Number(target.pageNum);
  const endPage = Number(target.endPageNum || startPage);
  if (endPage > startPage) return `第 ${startPage}–${endPage} 页 · 跨页句子`;
  return `第 ${startPage} 页 · 句子 ${Number(target.sentenceIndex) + 1}`;
}

function renderLoadingPanel(target) {
  analysisContent.innerHTML = `<div class="sentence-meta"><span>${targetLocationText(target)}</span></div>
    <div class="source-card"><p class="source-text">${esc(target.text)}</p></div>
    <div class="loading-panel" aria-label="解析中">
      <div class="loading-label">正在构建逻辑结构…</div>
      <div class="skeleton-line"></div><div class="skeleton-line medium"></div>
      <div class="skeleton-line"></div><div class="skeleton-line short"></div>
      <div class="skeleton-line medium"></div>
    </div>`;
}

function renderErrorPanel(target, error) {
  analysisContent.innerHTML = `<div class="sentence-meta"><span>${targetLocationText(target)}</span></div>
    <div class="source-card"><p class="source-text">${esc(target.text)}</p></div>
    <div class="error-card">解析失败：${esc(String(error && error.message ? error.message : error))}
      <br><button class="retry-btn" id="retry-analysis" type="button">重新解析</button>
    </div>`;
  const retry = document.getElementById("retry-analysis");
  if (retry) retry.addEventListener("click", () => {
    if (!selectedTarget || selectedTarget.key !== target.key) return;
    sentenceResults.delete(target.text);
    const requestId = ++requestSerial;
    renderLoadingPanel(target);
    loadAndRender(target, requestId, true);
  });
}

function confidenceText(value) {
  if (value >= .9) return "高可信";
  if (value >= .65) return "需留意";
  return "低可信";
}

function depthText(depth) {
  return ({ concise: "简洁", standard: "标准", detailed: "详细" })[depth] || "标准";
}

function grammarRows(grammar, compact = false, rich = false) {
  if (!grammar) return "";
  const rows = [
    ["主语", grammar.subject], ["谓语", grammar.predicate], ["宾语", grammar.object],
    ["执行者", grammar.agent], ["补语", grammar.complement], ["情态", grammar.modality],
  ].filter((row) => row[1]);
  if (!compact) {
    rows.push(["语态", grammar.voice === "passive" ? "被动" : "主动"]);
    if (grammar.negated) rows.push(["否定", "是（包含 not / never 等否定成分）"]);
  }
  if (rich) {
    const requirement = ({
      mandatory: "强制要求", prohibited: "禁止", recommended: "建议",
      permitted: "允许 / 能力", unspecified: "未明确",
    })[grammar.requirement_level] || grammar.requirement_level;
    rows.push(
      ["间接宾语", grammar.indirect_object],
      ["助动词", Array.isArray(grammar.auxiliaries) ? grammar.auxiliaries.join(" ") : grammar.auxiliaries],
      ["短语动词", Array.isArray(grammar.particles) ? grammar.particles.join(" ") : grammar.particles],
      ["时态 / 体 / 语气", [grammar.tense, grammar.aspect, grammar.mood].filter(Boolean).join(" / ")],
      ["规范强度", requirement],
      ["修饰成分", Array.isArray(grammar.modifiers) ? grammar.modifiers.join("；") : grammar.modifiers],
      ["介词短语", Array.isArray(grammar.prepositional_phrases) ? grammar.prepositional_phrases.join("；") : grammar.prepositional_phrases],
      ["并列结构", Array.isArray(grammar.coordination) ? grammar.coordination.join("；") : grammar.coordination],
      ["先行词 / 被修饰项", grammar.antecedent],
      ["证据来源", Array.isArray(grammar.evidence_sources) ? grammar.evidence_sources.join(" + ") : grammar.evidence_sources],
      ["来源一致性", grammar.agreement === "corroborated" ? "多源一致" : grammar.agreement === "conflict" ? "来源冲突" : "单源判断"],
    );
  }
  return rows.filter((row) => row[1]).map(([label, value]) => `<span class="grammar-label">${esc(label)}</span><span class="grammar-value">${esc(value)}</span>`).join("");
}

function clauseDetailsHtml(clause, detailed = false) {
  const warnings = detailed ? (clause.warnings || []).map((warning) => `<div class="node-warning">${esc(warning)}</div>`).join("") : "";
  const grammar = grammarRows(clause.grammar, false, true);
  return (grammar || warnings) ? `<div class="node-detail"><div class="grammar-grid">${grammar}</div>${warnings}</div>` : "";
}

function clauseMarkerHtml(clause) {
  const marker = String(clause.marker || "").trim();
  if (!marker) return "";
  const text = String(clause.text || "").trim().replace(/^["'(]+/, "");
  if (text.toLowerCase().startsWith(marker.toLowerCase())) return "";
  return `<span class="clause-marker">${esc(marker)}</span>`;
}

function bracketRelationLabel(clause) {
  const marker = String(clause.marker || "").toLowerCase();
  const labels = {
    main: "主句",
    concession: "让步从句",
    condition: "条件从句",
    time: marker === "until" ? "截止从句" : "时间从句",
    cause: "原因从句",
    purpose: "目的从句",
    result: "结果从句",
    basis: "依据要求",
    relative: "定语从句",
    content: "内容从句",
    complement: "补语从句",
    ambiguous: "待确认从句",
  };
  return labels[clause.relation] || clause.label || "从句";
}

function bracketSemanticLabel(clause) {
  if (clause.relation !== "main" || !clause.grammar) return "";
  return ({
    mandatory: "规范要求",
    prohibited: "规范禁止",
    recommended: "规范建议",
    permitted: "许可 / 能力",
  })[clause.grammar.requirement_level] || "";
}

function bracketClauseText(clause) {
  const text = String(clause.text || "").trim();
  const marker = String(clause.marker || "").trim();
  if (!marker) return text;
  const pattern = new RegExp(`^["'(]*${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[,:]?\\s*`, "i");
  const stripped = text.replace(pattern, "").trim();
  return stripped || text;
}

function clauseFocusMeta(clause, includeConfidence = false) {
  const grammar = clause.grammar || {};
  const relation = bracketRelationLabel(clause);
  const parts = [
    grammar.subject ? `主语 ${grammar.subject}` : "",
    grammar.modality ? `情态 ${grammar.modality}` : "",
    grammar.voice ? `语态 ${grammar.voice === "passive" ? "被动" : "主动"}` : "",
    `关系：${relation}`,
  ];
  if (includeConfidence) parts.push(`可信度：${confidenceText(Number(clause.confidence || 0))}`);
  return parts.filter(Boolean).join(" · ");
}

function renderBracketBranch(clause, childrenByParent, mainId, leadingIds) {
  let children = (childrenByParent.get(clause.id) || []).slice().sort((a, b) => a.order - b.order);
  if (clause.id === mainId) children = children.filter((child) => !leadingIds.has(child.id));
  const marker = String(clause.marker || "").trim();
  const semantic = bracketSemanticLabel(clause);
  const labelParts = [bracketRelationLabel(clause), semantic, marker].filter(Boolean);
  const nested = children.length
    ? `<div class="bracket-nested-children">${children.map((child) => renderBracketBranch(child, childrenByParent, mainId, leadingIds)).join("")}</div>`
    : "";
  return `<div class="bracket-group clause-interactive relation-${esc(clause.relation || "ambiguous")}" data-clause-id="${esc(clause.id)}">
    <span class="bracket-inline-label">${labelParts.map(esc).join(" · ")}</span>
    <span class="bracket-inline-text">${esc(bracketClauseText(clause))}</span>
    ${nested}
  </div>`;
}

function renderBracketStructure(clauses, main, childrenByParent, detailed = false) {
  const mainChildren = (childrenByParent.get(main.id) || []).slice();
  const leading = mainChildren.filter((clause) => clause.order < main.order).sort((a, b) => a.order - b.order);
  const leadingIds = new Set(leading.map((clause) => clause.id));
  const topLevel = [...leading, main].sort((a, b) => a.order - b.order);
  return `<div class="bracket-structure">
    <div class="bracket-groups">${topLevel.map((clause) => renderBracketBranch(clause, childrenByParent, main.id, leadingIds)).join("")}</div>
    <div class="bracket-focus-card">
      <span class="bracket-focus-label" id="clause-focus-label">${esc(bracketRelationLabel(main))}</span>
      <strong id="clause-focus-text">${esc(main.text)}</strong>
      <span class="bracket-focus-meta" id="clause-focus-meta">${esc(clauseFocusMeta(main, detailed))}</span>
    </div>
  </div>`;
}

function renderLinkedSource(text, clauses) {
  const ranges = [];
  for (const clause of clauses) {
    for (const segment of clause.segments || [[clause.start, clause.end]]) {
      const start = Math.max(0, Number(segment[0]));
      const end = Math.min(text.length, Number(segment[1]));
      if (Number.isFinite(start) && Number.isFinite(end) && start < end) ranges.push({ start, end, clause });
    }
  }
  ranges.sort((a, b) => a.start - b.start || (a.end - a.start) - (b.end - b.start));
  let cursor = 0;
  let html = "";
  for (const range of ranges) {
    if (range.end <= cursor) continue;
    const start = Math.max(cursor, range.start);
    if (start > cursor) html += esc(text.slice(cursor, start));
    html += `<span class="linked-source-segment clause-interactive relation-${esc(range.clause.relation || "ambiguous")}" data-clause-id="${esc(range.clause.id)}">${esc(text.slice(start, range.end))}</span>`;
    cursor = range.end;
  }
  return html + esc(text.slice(cursor));
}

function renderLinkedTreeNode(clause, childrenByParent, detailed = false) {
  const children = (childrenByParent.get(clause.id) || []).slice().sort((a, b) => a.order - b.order);
  const confidence = detailed ? `<span class="confidence-badge">${confidenceText(Number(clause.confidence || 0))}</span>` : "";
  const marker = clauseMarkerHtml(clause);
  const grammar = clause.grammar || {};
  const syntax = [grammar.subject, grammar.predicate, grammar.object].filter(Boolean).map(esc).join(" → ");
  const childrenHtml = children.length ? `<ol class="linked-tree-children">${children.map((child) => renderLinkedTreeNode(child, childrenByParent, detailed)).join("")}</ol>` : "";
  return `<li class="linked-tree-item">
    <details class="linked-tree-node clause-interactive relation-${esc(clause.relation || "ambiguous")}" data-clause-id="${esc(clause.id)}"${detailed ? " open" : ""}>
      <summary>
        <div class="linked-node-heading"><span class="relation-badge">${esc(clause.label || clause.relation)}</span>${marker}${confidence}</div>
        <div class="linked-node-text">${esc(clause.text)}</div>
        ${syntax ? `<div class="linked-node-syntax">${syntax}</div>` : ""}
      </summary>
      ${clauseDetailsHtml(clause, detailed)}
    </details>
    ${childrenHtml}
  </li>`;
}

function renderLinkedStructure(text, clauses, main, childrenByParent, detailed = false) {
  const legend = clauses.slice().sort((a, b) => a.order - b.order).map((clause) => `<button class="linked-legend-item clause-interactive relation-${esc(clause.relation || "ambiguous")}" type="button" data-clause-id="${esc(clause.id)}"><span class="linked-legend-swatch" aria-hidden="true"></span>${esc(clause.label || clause.relation)}</button>`).join("");
  return `<div class="linked-structure">
    <div class="linked-legend" aria-label="分句关系图例">${legend}</div>
    <div class="linked-source-map" aria-label="按逻辑分句标记的原文">${renderLinkedSource(text, clauses)}</div>
    <ol class="linked-tree">${renderLinkedTreeNode(main, childrenByParent, detailed)}</ol>
  </div>`;
}

function renderSourceText(text, segments = []) {
  const normalized = segments
    .map((segment) => [Math.max(0, Number(segment[0])), Math.min(text.length, Number(segment[1]))])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && start < end)
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const segment of normalized) {
    if (merged.length && segment[0] <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], segment[1]);
    else merged.push(segment.slice());
  }
  if (!merged.length) return esc(text);
  let cursor = 0;
  let html = "";
  for (const [start, end] of merged) {
    html += esc(text.slice(cursor, start));
    html += `<span class="source-segment is-active">${esc(text.slice(start, end))}</span>`;
    cursor = end;
  }
  html += esc(text.slice(cursor));
  return html;
}

function renderAnalysisPanel(target, result) {
  if (!result || !Array.isArray(result.clauses) || !result.clauses.length) {
    renderErrorPanel(target, new Error("返回的数据缺少逻辑分句"));
    return;
  }
  const depth = uiSettings.analysisDepth;
  const detailed = depth === "detailed";
  const concise = depth === "concise";
  const clausesById = new Map(result.clauses.map((clause) => [clause.id, clause]));
  const childrenByParent = new Map();
  for (const clause of result.clauses) {
    if (!clause.parent_id) continue;
    if (!childrenByParent.has(clause.parent_id)) childrenByParent.set(clause.parent_id, []);
    childrenByParent.get(clause.parent_id).push(clause);
  }
  const main = clausesById.get(result.main_clause_id) || result.clauses[0];
  const structureView = VALID_STRUCTURE_VIEWS.has(uiSettings.structureView) ? uiSettings.structureView : DEFAULT_SETTINGS.structureView;
  const structureHtml = concise ? "" : structureView === "linked"
    ? renderLinkedStructure(result.text || target.text, result.clauses, main, childrenByParent, detailed)
    : renderBracketStructure(result.clauses, main, childrenByParent, detailed);
  const clickableTranslation = (text) => {
    const terms = [
      ...(Array.isArray(result.terms) ? result.terms : []),
      ...(Array.isArray(result.complex_words) ? result.complex_words : []),
    ];
    const candidates = [];
    for (const term of terms) {
      for (const display of [term.word, term.lemma]) {
        const value = String(display || "").trim();
        const translation = String(term.zh || "").split(/[；，、/]/, 1)[0].trim();
        if (value.length >= 2 && translation) candidates.push({ value, word: term.word, translation });
      }
    }
    candidates.sort((a, b) => b.value.length - a.value.length);
    let cursor = 0;
    let html = "";
    const source = String(text || "");
    while (cursor < source.length) {
      let match = null;
      for (const candidate of candidates) {
        const index = source.toLowerCase().indexOf(candidate.value.toLowerCase(), cursor);
        if (index < 0 || (match && index > match.index)) continue;
        if (!match || index < match.index || candidate.value.length > match.candidate.value.length) match = { index, candidate };
      }
      if (!match) { html += esc(source.slice(cursor)); break; }
      html += esc(source.slice(cursor, match.index));
      const end = match.index + match.candidate.value.length;
      const original = source.slice(match.index, end);
      html += `<button class="translation-term" type="button" data-term-original="${esc(original)}" data-term-translation="${esc(match.candidate.translation)}" aria-label="将 ${esc(original)} 替换为中文释义 ${esc(match.candidate.translation)}">${esc(original)}</button>`;
      cursor = end;
    }
    return html || esc(source);
  };
  const translationClauses = detailed && result.translation && Array.isArray(result.translation.clauses)
    ? `<ol class="translation-clauses">${result.translation.clauses.map((item) => `<li>${item.label ? `<strong>${esc(item.label)}：</strong>` : ""}<span>${clickableTranslation(item.text)}</span></li>`).join("")}</ol>`
    : "";
  const translationWarnings = detailed && result.translation && Array.isArray(result.translation.warnings)
    ? result.translation.warnings.map((warning) => `<div class="translation-warning">${esc(warning)}</div>`).join("")
    : "";
  const translationHtml = result.translation && result.translation.text
    ? `<section class="analysis-section translation-section"><h3 class="section-heading">中文翻译</h3><div class="translation-card">
        <div class="translation-meta">${esc(result.translation.label || result.translation.engine || "本地翻译")}</div>
        <p class="translation-text">${clickableTranslation(result.translation.text)}</p>${translationClauses}${translationWarnings}
      </div></section>`
    : "";
  const skeleton = grammarRows(main.grammar, true);
  const skeletonExtra = main.grammar
    ? `<span class="key">语态</span><span class="value">${main.grammar.voice === "passive" ? "被动" : "主动"}${main.grammar.negated ? " · 含否定" : ""}</span>`
    : "";
  const termsHtml = Array.isArray(result.terms) && result.terms.length
    ? `<ul class="term-list">${result.terms.map((term) => `<li class="term-item">
        <button class="term-word term-open" type="button" data-glossary-word="${esc(term.word)}">${esc(term.word)}</button><span class="term-pos">${esc(term.pos || "")}</span><span class="term-zh">${esc(term.zh || "")}</span>
        ${detailed && term.note ? `<span class="term-note">${esc(term.note)}</span>` : ""}
      </li>`).join("")}</ul>`
    : `<div class="empty-copy">本句没有命中已收录术语</div>`;
  const complexWordsHtml = Array.isArray(result.complex_words) && result.complex_words.length
    ? `<div class="complex-word-list">${result.complex_words.map((word) => `<article class="complex-word-item">
        <div><strong>${esc(word.word)}</strong><span>${esc(word.level || "较难")}</span></div>
        <p>${esc(word.zh || "待补充释义")}</p>${detailed && word.note ? `<small>${esc(word.note)}</small>` : ""}
      </article>`).join("")}</div>`
    : "";
  const parserWarnings = detailed ? (result.warnings || []) : [];
  const globalWarnings = [...(target.contextWarnings || []), ...parserWarnings]
    .map((warning) => `<div class="global-warning">${esc(warning)}</div>`).join("");
  const engineName = result.engine === "spacy" ? "spaCy 本地解析" : "规则降级解析";
  const structureLabel = structureView === "linked" ? "原文联动树" : "嵌套原文";
  const logicSection = concise ? "" : `<section class="analysis-section"><h3 class="section-heading">逻辑结构 · ${structureLabel}</h3>${structureHtml}</section>`;
  const termsSection = concise ? "" : `<section class="analysis-section"><h3 class="section-heading">复杂词</h3>${complexWordsHtml || '<div class="empty-copy">本句没有识别到较难的通用单词</div>'}<h3 class="section-heading term-heading">术语</h3>${termsHtml}</section>`;
  const conciseCore = concise ? `<section class="analysis-section concise-core"><h3 class="section-heading">核心命题</h3><div class="core-card">${esc(main.text)}</div></section>` : "";

  analysisContent.innerHTML = `<div class="sentence-meta">
      <span>${targetLocationText(target)}</span>
      <span class="meta-badges"><span class="depth-badge">${depthText(depth)}</span><span class="engine-badge">${engineName}</span></span>
    </div>
    <div class="source-card"><p class="source-text" id="panel-source-text">${esc(result.text || target.text)}</p><div class="source-context-hint">右击原文中的英文单词，可加入复杂词表</div></div>
    ${translationHtml}${conciseCore}${logicSection}
    <section class="analysis-section"><h3 class="section-heading">主句主干</h3><div class="skeleton-card">${skeleton}${skeletonExtra}</div></section>
    ${termsSection}${globalWarnings}`;

  for (const termButton of analysisContent.querySelectorAll(".translation-term[data-term-translation]")) {
    termButton.addEventListener("click", () => toggleTranslationTerm(termButton));
  }
  for (const termButton of analysisContent.querySelectorAll(".term-open[data-glossary-word]")) {
    termButton.addEventListener("click", () => openGlossary(termButton.dataset.glossaryWord));
  }

  const sourceElement = document.getElementById("panel-source-text");
  if (sourceElement) {
    sourceElement.addEventListener("contextmenu", (event) => {
      const word = sourceWordFromContextEvent(event, sourceElement);
      if (!word) return;
      event.preventDefault();
      openComplexWords(word);
    });
  }
  if (sourceElement && !concise) {
    const interactiveItems = Array.from(analysisContent.querySelectorAll(".clause-interactive[data-clause-id]"));
    const focusLabel = document.getElementById("clause-focus-label");
    const focusText = document.getElementById("clause-focus-text");
    const focusMeta = document.getElementById("clause-focus-meta");
    let pinnedClauseId = null;
    const showClauseInSource = (clauseId) => {
      const clause = clausesById.get(clauseId);
      if (clause) sourceElement.innerHTML = renderSourceText(result.text || target.text, clause.segments || [[clause.start, clause.end]]);
      else sourceElement.textContent = result.text || target.text;
    };
    const syncPinnedClause = (clauseId) => {
      pinnedClauseId = pinnedClauseId === clauseId ? null : clauseId;
      for (const candidate of interactiveItems) candidate.classList.toggle("is-linked-active", !!pinnedClauseId && candidate.dataset.clauseId === pinnedClauseId);
      showClauseInSource(pinnedClauseId);
    };
    const showClauseDetail = (clause) => {
      if (!focusLabel || !focusText || !focusMeta) return;
      focusLabel.textContent = bracketRelationLabel(clause);
      focusText.textContent = clause.text || "";
      focusMeta.textContent = clauseFocusMeta(clause, detailed);
    };
    for (const item of interactiveItems) {
      const clause = clausesById.get(item.dataset.clauseId);
      if (!clause) continue;
      item.addEventListener("mouseenter", () => showClauseInSource(clause.id));
      item.addEventListener("mouseleave", () => showClauseInSource(pinnedClauseId));
      item.addEventListener("click", (event) => {
        if (event.stopPropagation) event.stopPropagation();
        showClauseDetail(clause);
        syncPinnedClause(clause.id);
      });
    }
  }
}

function toggleTranslationTerm(button) {
  if (!button || !button.dataset || !button.dataset.termTranslation) return false;
  const translated = button.classList.toggle("is-translated");
  button.textContent = translated ? button.dataset.termTranslation : button.dataset.termOriginal;
  button.setAttribute("aria-pressed", String(translated));
  return translated;
}

/* ---------------- 右侧分析栏开关与宽度 ---------------- */

function updatePanelControls() {
  if (panelToggle) {
    panelToggle.disabled = false;
    panelToggle.setAttribute("aria-expanded", String(!panelCollapsed));
    panelToggle.textContent = panelCollapsed ? "展开分析" : "收起分析";
  }
  if (panelResizer) {
    panelResizer.setAttribute("aria-orientation", "vertical");
    panelResizer.setAttribute("aria-label", "调整分析栏宽度");
  }
}

function setPanelCollapsed(collapsed) {
  panelCollapsed = !!collapsed;
  workspace.classList.toggle("panel-collapsed", panelCollapsed);
  updatePanelControls();
}

function closeAnalysisPanel() {
  clearSelection();
  clearPreview();
  setPanelCollapsed(true);
}

function cssNumber(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  return Number.parseInt(raw, 10) || fallback;
}

function panelWidth() { return cssNumber("--panel-width", 440); }
function clampPanelWidth(width) { return Math.max(340, Math.min(620, Math.round(width))); }

function setPanelWidth(width, persist = false) {
  const clamped = clampPanelWidth(width);
  document.documentElement.style.setProperty("--panel-width", `${clamped}px`);
  if (panelResizer) {
    panelResizer.setAttribute("aria-valuemin", "340");
    panelResizer.setAttribute("aria-valuemax", "620");
    panelResizer.setAttribute("aria-valuenow", String(clamped));
  }
  if (persist && window.localStorage) {
    try { window.localStorage.setItem("parse-spec:panel-width", String(clamped)); } catch (_ignored) {}
  }
}

function restorePanelWidth() {
  try {
    const savedWidth = window.localStorage && Number(window.localStorage.getItem("parse-spec:panel-width"));
    if (savedWidth) setPanelWidth(savedWidth);
  } catch (_ignored) {}
}

function isNarrowViewport() {
  return !!(window.matchMedia && window.matchMedia("(max-width: 760px)").matches);
}

function applyPanelOverlaySize(state) {
  if (!state || !state.panel) return;
  const width = state.pendingWidth;
  const left = state.panelRect.right - width;
  state.panel.style.left = `${left}px`;
  state.panel.style.top = `${state.panelRect.top}px`;
  state.panel.style.width = `${width}px`;
  state.panel.style.height = `${state.panelRect.height}px`;
  state.resizer.style.left = `${left - state.resizerRect.width}px`;
  state.resizer.style.top = `${state.panelRect.top}px`;
  state.resizer.style.width = `${state.resizerRect.width || 7}px`;
  state.resizer.style.height = `${state.panelRect.height}px`;
}

function startResize(event) {
  if (isNarrowViewport() || !analysisPanel) return;
  const width = panelWidth();
  resizeStart = {
    x: Number(event.clientX) || 0,
    width,
    pendingWidth: width,
    panel: analysisPanel,
    panelRect: measuredRect(analysisPanel, width, 0),
    resizer: panelResizer,
    resizerRect: measuredRect(panelResizer, 7, 7),
  };
  workspace.classList.add("is-live-resizing");
  analysisPanel.classList.add("is-live-resizing");
  panelResizer.classList.add("is-live-resizing");
  applyPanelOverlaySize(resizeStart);
  panelResizer.classList.add("is-dragging");
  document.body.classList.add("is-resizing-x");
  if (event.preventDefault) event.preventDefault();
  if (panelResizer.setPointerCapture && event.pointerId !== undefined) panelResizer.setPointerCapture(event.pointerId);
}

function moveResize(event) {
  if (!resizeStart) return;
  resizeStart.pendingWidth = clampPanelWidth(resizeStart.width - ((Number(event.clientX) || 0) - resizeStart.x));
  applyPanelOverlaySize(resizeStart);
  if (event.preventDefault) event.preventDefault();
}

function endResize() {
  if (!resizeStart) return;
  const state = resizeStart;
  resizeStart = null;
  applyPanelOverlaySize(state);
  setPanelWidth(state.pendingWidth, true);
  panelResizer.classList.remove("is-dragging");
  document.body.classList.remove("is-resizing-x");
  document.body.classList.remove("is-resizing-y");
  finishLiveResize(state.panel, state.resizer);
}

function resizeByKeyboard(event) {
  const step = 16;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    setPanelWidth(panelWidth() + (event.key === "ArrowLeft" ? step : -step), true);
  }
}

if (panelToggle) panelToggle.addEventListener("click", () => {
  if (panelCollapsed) {
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
    else if (selectedTarget || !panelCollapsed) closeAnalysisPanel();
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
    if (panelCollapsed) setPanelCollapsed(false);
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
  // 重置页面虚拟化状态
  if (pageObserver) {
    pageObserver.disconnect();
    pageObserver = null;
  }
  for (const timer of mountTimers.values()) clearTimeout(timer);
  mountTimers.clear();
  mountedPages.clear();
  visibleSlots.clear();
  pageDataByNum.clear();
  markElementsByKey.clear();
  pageTops = [];
  pageHeights = [];
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
    ensurePageObserver();
    const documentSentenceState = { nextId: 0, pending: null };
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      await parsePage(pdf, pageNum, pagesEl, documentSentenceState, loadId);
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

/* 测试钩子：暴露虚拟化内部状态只读访问，供回归测试验证挂载/回收语义。生产环境不依赖。 */
globalThis.__parseSpecViewerTest = {
  get mountedPageCount() { return mountedPages.size; },
  get mountedPageNums() { return [...mountedPages.keys()]; },
  get hasPageObserver() { return Boolean(pageObserver); },
  get visibleSlotCount() { return visibleSlots.size; },
  get activeRenderCount() { return activeRenders; },
  get renderQueueLength() { return renderQueue.length; },
  get pageCount() { return pageDataByNum.size; },
  setPageObserver(value) { pageObserver = value; },
  setVisibleSlots(nums) { visibleSlots.clear(); nums.forEach((n) => visibleSlots.add(n)); },
  setMountedPages(nums) {
    mountedPages.clear();
    nums.forEach((n) => mountedPages.set(n, { pageNum: n, stage: "mounted", loadId: documentLoadSerial }));
  },
  enforceMountedPageLimit,
  unmountPage,
  currentVisiblePage,
};
setPanelCollapsed(isNarrowViewport());

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]
  ));
}
