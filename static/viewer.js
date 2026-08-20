/* Parse-Spec 前端：pdf.js 渲染、可复制文本层、句子选择与持久分析侧栏。
   悬停只预览句子范围；单击才请求后端并锁定分析结果。 */

pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/pdf.worker.min.js";

const S = 1.4;
const fileInput = document.getElementById("file");
const emptyFileInput = document.getElementById("file-empty");
const pagesEl = document.getElementById("pages");
const placeholder = document.getElementById("placeholder");
const workspace = document.getElementById("workspace");
const analysisContent = document.getElementById("analysis-content");
const panelToggle = document.getElementById("panel-toggle");
const panelClose = document.getElementById("panel-close");
const panelResizer = document.getElementById("panel-resizer");
const docMeta = document.getElementById("doc-meta");

const sentenceResults = new Map();

let currentPdf = null;
let previewTarget = null;
let selectedTarget = null;
let requestSerial = 0;
let panelCollapsed = false;
let resizeStart = null;

/* ---------------- 句子切分 ---------------- */

function isSentenceEnd(word, next, fontSize, newRow) {
  const wordStr = word.text;
  if (newRow && next && (next.y0 - word.y0) > fontSize * 1.4 && /^[A-Z0-9"'(]/.test(next.text)) return true;
  if (!/[.!?]["')\]]*$/.test(wordStr)) return false;
  if (/^(e\.g\.?|i\.e\.?|etc\.?|vs\.?|viz\.?|Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?|St\.?|No\.?|Fig\.?|Ref\.?|Sec\.?|approx\.?)$/i.test(wordStr)) return false;
  if (!next) return true;
  if (newRow) return true;
  const gap = next.x0 - word.x1;
  const bigGap = gap > Math.max(6, fontSize * 0.35);
  const capStart = /^[A-Z"'(]/.test(next.text);
  return bigGap && capStart;
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
  const ordered = rows.flatMap((row) => row.items);

  const sentences = [];
  let current = [];
  for (let index = 0; index < ordered.length; index++) {
    const word = ordered[index];
    const next = ordered[index + 1];
    current.push(word);
    const newRow = !!(next && Math.abs(next.y0 - word.y0) >= rowTol);
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
  for (const item of items) {
    const raw = String(item.str || "").trim();
    if (!raw) continue;
    const transform = item.transform || [1, 0, 0, 1, 0, 0];
    const point = viewport.convertToViewportPoint(transform[4], transform[5]);
    const fontSize = Math.max(8, Math.hypot(transform[2], transform[3]) * scale);
    const itemWidth = Math.max(1, Number(item.width || raw.length * fontSize * .5) * scale);
    const parts = raw.split(/\s+/).filter(Boolean);
    const totalChars = Math.max(1, parts.reduce((sum, part) => sum + part.length, 0));
    let cursorX = point[0];
    for (const part of parts) {
      const partWidth = itemWidth * (part.length / totalChars);
      words.push({
        text: part,
        x0: cursorX,
        y0: point[1] - fontSize,
        x1: cursorX + partWidth,
        y1: point[1],
      });
      cursorX += partWidth + (parts.length > 1 ? itemWidth * .02 : 0);
    }
  }
  return words;
}

/* ---------------- PDF 页面 ---------------- */

async function renderPage(pdf, pageNum, container) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: S });
  const wrap = document.createElement("div");
  wrap.className = "page-wrap";
  wrap.dataset.pageNumber = String(pageNum);

  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  wrap.appendChild(canvas);
  container.appendChild(wrap);

  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  const textContent = await page.getTextContent();
  const words = toWords(textContent.items, viewport, S);
  const sentences = buildSentences(words);

  const textLayer = document.createElement("div");
  textLayer.className = "textLayer";
  textLayer.style.width = `${canvas.width}px`;
  textLayer.style.height = `${canvas.height}px`;
  wrap.appendChild(textLayer);
  await pdfjsLib.renderTextLayer({
    textContent,
    container: textLayer,
    viewport,
    textDivs: [],
  }).promise;
  textLayer.style.visibility = "visible";
  wireTextLayer(textLayer, wrap, sentences, words, pageNum);
  console.log(`P${pageNum}: ${words.length} 词, ${sentences.length} 句`);
}

function wireTextLayer(textLayer, wrap, sentences, words, pageNum) {
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

  const sentenceTexts = sentences.map((sentence) => sentence.map((word) => word.text).join(" ").trim());
  const sentenceGroups = new Map();
  const wrapRect = wrap.getBoundingClientRect();
  const normalize = (value) => String(value).replace(/\s+/g, " ").trim();
  const normalizedSentences = sentenceTexts.map(normalize);

  for (const span of textLayer.querySelectorAll("span")) {
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
    if (!sentenceGroups.has(sentenceIndex)) sentenceGroups.set(sentenceIndex, []);
    sentenceGroups.get(sentenceIndex).push(span);
  }

  for (const [sentenceIndex, spans] of sentenceGroups) {
    const target = {
      key: `${pageNum}:${sentenceIndex}`,
      pageNum,
      sentenceIndex,
      text: sentenceTexts[sentenceIndex],
      spans,
    };
    for (const span of spans) {
      span.addEventListener("mouseenter", () => setPreview(target));
      span.addEventListener("mouseleave", () => clearPreview(target));
      span.addEventListener("click", () => {
        if (hasTextSelection()) return;
        selectSentence(target);
      });
    }
  }
}

/* ---------------- 预览与选中状态 ---------------- */

function hasTextSelection() {
  return !!(window.getSelection && window.getSelection().toString());
}

function addClassToSpans(target, className) {
  if (!target || !target.spans) return;
  for (const span of target.spans) span.classList.add(className);
}

function removeClassFromSpans(target, className) {
  if (!target || !target.spans) return;
  for (const span of target.spans) span.classList.remove(className);
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
  if (selectedTarget && selectedTarget.key !== target.key) {
    removeClassFromSpans(selectedTarget, "is-selected");
  }
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

/* ---------------- 分析栏渲染 ---------------- */

function renderEmptyPanel() {
  analysisContent.innerHTML = `<div class="panel-empty">
    <span class="panel-empty-icon">↗</span>
    <h3>从 PDF 中选择一句话</h3>
    <p>悬停查看句子范围，单击锁定分析。选中状态不会随鼠标移开而消失。</p>
  </div>`;
}

function renderLoadingPanel(target) {
  analysisContent.innerHTML = `<div class="sentence-meta"><span>第 ${target.pageNum} 页 · 句子 ${target.sentenceIndex + 1}</span></div>
    <div class="source-card"><p class="source-text">${esc(target.text)}</p></div>
    <div class="loading-panel" aria-label="解析中">
      <div class="loading-label">正在构建逻辑结构…</div>
      <div class="skeleton-line"></div><div class="skeleton-line medium"></div>
      <div class="skeleton-line"></div><div class="skeleton-line short"></div>
      <div class="skeleton-line medium"></div>
    </div>`;
}

function renderErrorPanel(target, error) {
  analysisContent.innerHTML = `<div class="sentence-meta"><span>第 ${target.pageNum} 页 · 句子 ${target.sentenceIndex + 1}</span></div>
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

function grammarRows(grammar, compact = false) {
  if (!grammar) return "";
  const rows = [
    ["主语", grammar.subject],
    ["谓语", grammar.predicate],
    ["宾语", grammar.object],
    ["执行者", grammar.agent],
    ["补语", grammar.complement],
    ["情态", grammar.modality],
  ].filter((row) => row[1]);
  if (!compact) {
    rows.push(["语态", grammar.voice === "passive" ? "被动" : "主动"]);
    if (grammar.negated) rows.push(["否定", "是（包含 not / never 等否定成分）"]);
  }
  return rows.map(([label, value]) => `<span class="grammar-label">${esc(label)}</span><span class="grammar-value">${esc(value)}</span>`).join("");
}

function renderTreeNode(clause, childrenByParent) {
  const children = (childrenByParent.get(clause.id) || []).slice().sort((a, b) => a.order - b.order);
  const warnings = (clause.warnings || []).map((warning) => `<div class="node-warning">${esc(warning)}</div>`).join("");
  const grammar = grammarRows(clause.grammar);
  const childHtml = children.length
    ? `<ol class="tree-children">${children.map((child) => renderTreeNode(child, childrenByParent)).join("")}</ol>`
    : "";
  return `<li class="tree-item" data-clause-id="${esc(clause.id)}">
    <details class="tree-node relation-${esc(clause.relation || "ambiguous")}" open>
      <summary>
        <div class="tree-summary-row">
          <span class="relation-badge">${esc(clause.label || clause.relation)}</span>
          <span class="confidence-badge">${confidenceText(Number(clause.confidence || 0))}</span>
        </div>
        <div class="node-text">${esc(clause.text)}</div>
      </summary>
      ${(grammar || warnings) ? `<div class="node-detail"><div class="grammar-grid">${grammar}</div>${warnings}</div>` : ""}
    </details>
    ${childHtml}
  </li>`;
}

function renderSourceText(text, segments = []) {
  const normalized = segments
    .map((segment) => [Math.max(0, Number(segment[0])), Math.min(text.length, Number(segment[1]))])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && start < end)
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const segment of normalized) {
    if (merged.length && segment[0] <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], segment[1]);
    } else {
      merged.push(segment.slice());
    }
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
  const clausesById = new Map(result.clauses.map((clause) => [clause.id, clause]));
  const childrenByParent = new Map();
  for (const clause of result.clauses) {
    if (!clause.parent_id) continue;
    if (!childrenByParent.has(clause.parent_id)) childrenByParent.set(clause.parent_id, []);
    childrenByParent.get(clause.parent_id).push(clause);
  }
  const main = clausesById.get(result.main_clause_id) || result.clauses[0];
  const treeHtml = renderTreeNode(main, childrenByParent);
  const translationHtml = result.translation && result.translation.text
    ? `<section class="analysis-section"><h3 class="section-heading">推荐译文</h3><div class="translation-card"><p class="translation-text">${esc(result.translation.text)}</p></div></section>`
    : "";
  const skeleton = grammarRows(main.grammar, true);
  const skeletonExtra = main.grammar
    ? `<span class="key">语态</span><span class="value">${main.grammar.voice === "passive" ? "被动" : "主动"}${main.grammar.negated ? " · 含否定" : ""}</span>`
    : "";
  const termsHtml = Array.isArray(result.terms) && result.terms.length
    ? `<ul class="term-list">${result.terms.map((term) => `<li class="term-item">
        <span class="term-word">${esc(term.word)}</span><span class="term-pos">${esc(term.pos || "")}</span><span class="term-zh">${esc(term.zh || "")}</span>
        ${term.note ? `<span class="term-note">${esc(term.note)}</span>` : ""}
      </li>`).join("")}</ul>`
    : `<div class="empty-copy">本句没有命中已收录术语</div>`;
  const globalWarnings = (result.warnings || []).map((warning) => `<div class="global-warning">${esc(warning)}</div>`).join("");
  const engineName = result.engine === "spacy" ? "spaCy 本地解析" : "规则降级解析";

  analysisContent.innerHTML = `<div class="sentence-meta">
      <span>第 ${target.pageNum} 页 · 句子 ${target.sentenceIndex + 1}</span>
      <span class="engine-badge">${engineName}</span>
    </div>
    <div class="source-card"><p class="source-text" id="panel-source-text">${esc(result.text || target.text)}</p></div>
    ${translationHtml}
    <section class="analysis-section">
      <h3 class="section-heading">逻辑结构</h3>
      <ol class="logic-tree">${treeHtml}</ol>
    </section>
    <section class="analysis-section">
      <h3 class="section-heading">主句主干</h3>
      <div class="skeleton-card">${skeleton}${skeletonExtra}</div>
    </section>
    <section class="analysis-section">
      <h3 class="section-heading">复杂词 / 术语</h3>
      ${termsHtml}
    </section>
    ${globalWarnings}`;

  const sourceElement = document.getElementById("panel-source-text");
  if (sourceElement) {
    for (const item of analysisContent.querySelectorAll("[data-clause-id]")) {
      const clause = clausesById.get(item.dataset.clauseId);
      if (!clause) continue;
      item.addEventListener("mouseenter", () => {
        sourceElement.innerHTML = renderSourceText(result.text || target.text, clause.segments || [[clause.start, clause.end]]);
      });
      item.addEventListener("mouseleave", () => {
        sourceElement.textContent = result.text || target.text;
      });
    }
  }
}

/* ---------------- 分析栏开关与尺寸 ---------------- */

function setPanelCollapsed(collapsed) {
  panelCollapsed = !!collapsed;
  workspace.classList.toggle("panel-collapsed", panelCollapsed);
  panelToggle.setAttribute("aria-expanded", String(!panelCollapsed));
  panelToggle.textContent = panelCollapsed ? "展开分析" : "收起分析";
}

function closeAnalysisPanel() {
  clearSelection();
  clearPreview();
  setPanelCollapsed(true);
}

function panelWidth() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--panel-width");
  return Number.parseInt(raw, 10) || 440;
}

function setPanelWidth(width, persist = false) {
  const clamped = Math.max(340, Math.min(620, Math.round(width)));
  document.documentElement.style.setProperty("--panel-width", `${clamped}px`);
  panelResizer.setAttribute("aria-valuenow", String(clamped));
  if (persist && window.localStorage) {
    try { window.localStorage.setItem("parse-spec:panel-width", String(clamped)); } catch (_ignored) {}
  }
}

function restorePanelWidth() {
  try {
    const saved = window.localStorage && Number(window.localStorage.getItem("parse-spec:panel-width"));
    if (saved) setPanelWidth(saved);
  } catch (_ignored) {}
}

function isNarrowViewport() {
  return !!(window.matchMedia && window.matchMedia("(max-width: 760px)").matches);
}

function startResize(event) {
  if (isNarrowViewport()) return;
  resizeStart = { x: event.clientX, width: panelWidth() };
  panelResizer.classList.add("is-dragging");
  document.body.classList.add("is-resizing");
  if (panelResizer.setPointerCapture && event.pointerId !== undefined) panelResizer.setPointerCapture(event.pointerId);
}

function moveResize(event) {
  if (!resizeStart) return;
  setPanelWidth(resizeStart.width + resizeStart.x - event.clientX);
}

function endResize() {
  if (!resizeStart) return;
  resizeStart = null;
  panelResizer.classList.remove("is-dragging");
  document.body.classList.remove("is-resizing");
  setPanelWidth(panelWidth(), true);
}

panelToggle.addEventListener("click", () => {
  if (panelCollapsed) {
    setPanelCollapsed(false);
  } else {
    closeAnalysisPanel();
  }
});
panelClose.addEventListener("click", closeAnalysisPanel);
panelResizer.addEventListener("pointerdown", startResize);
window.addEventListener("pointermove", moveResize);
window.addEventListener("pointerup", endResize);
panelResizer.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  setPanelWidth(panelWidth() + (event.key === "ArrowLeft" ? 16 : -16), true);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && (selectedTarget || !panelCollapsed)) closeAnalysisPanel();
});

/* ---------------- 文件加载 ---------------- */

async function openPdf(file) {
  if (!file) return;
  pagesEl.innerHTML = "";
  placeholder.hidden = true;
  sentenceResults.clear();
  clearPreview();
  clearSelection();
  setPanelCollapsed(isNarrowViewport());
  docMeta.textContent = `${file.name} · 加载中`;
  try {
    const data = await file.arrayBuffer();
    currentPdf = await pdfjsLib.getDocument({ data }).promise;
    for (let pageNum = 1; pageNum <= currentPdf.numPages; pageNum++) {
      await renderPage(currentPdf, pageNum, pagesEl);
      docMeta.textContent = `${file.name} · ${pageNum}/${currentPdf.numPages} 页`;
    }
    docMeta.textContent = `${file.name} · ${currentPdf.numPages} 页`;
  } catch (error) {
    currentPdf = null;
    placeholder.hidden = false;
    placeholder.innerHTML = `<span class="placeholder-mark">!</span><h1>PDF 加载失败</h1><p>${esc(String(error))}</p>`;
    docMeta.textContent = "加载失败";
  }
}

function bindFileInput(input) {
  input.addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    openPdf(file);
  });
}

bindFileInput(fileInput);
bindFileInput(emptyFileInput);
restorePanelWidth();
setPanelCollapsed(isNarrowViewport());

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]
  ));
}
