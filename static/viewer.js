/* Parse-Spec 前端：pdf.js 渲染 + 可复制文本层 + 句子悬浮命中 + 浮窗。
   依赖 /static/pdf.min.js (pdfjs-dist 2.x)。
   坐标权威完全由 pdf.js 提供，后端只做文本断句/成分/词义。 */

pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/pdf.worker.min.js";

const S = 1.4;                    // 渲染倍率
const fileInput = document.getElementById("file");
const pagesEl = document.getElementById("pages");
const placeholder = document.getElementById("placeholder");
const tooltip = document.getElementById("tooltip");

const sentenceResults = new Map();   // sentenceText -> 后端解析结果

let currentPdf = null;
let currentHoverKey = null;          // 当前悬浮的句子索引
let currentHoverSpans = null;        // 当前悬浮句子的文本层 span（高亮）
let hideTimer = null;                // 延迟隐藏计时器（允许光标移入浮窗）
let lastPointer = null;              // 最近一次鼠标位置（内容渲染后重定位浮窗）
let showTimer = null;                // 悬停意图计时器：停留后再弹出浮窗，避免移动途中遮挡
let pendingShowSi = null;            // 待弹出的句子索引

/* 当前页数据：句子文本 / 每句的 span 组（wireTextLayer 填充） */
let pageSentTexts = [];
const pageSentGroups = new Map();

/* ---------------- 句子切分 ---------------- */

function isSentenceEnd(word, next, fontSize, newRow) {
  const wordStr = word.text;
  // 行尾 + 与下一行的垂直间距明显大于当前行高（约等于标题/段落间距）=> 即使无句末标点也切句
  if (newRow && next && (next.y0 - word.y0) > fontSize * 1.4 && /^[A-Z0-9"'(]/.test(next.text)) return true;  // 段间距大于行高且下一行大写开头 → 切句
  // 词以句末标点结尾（允许引号/括号包裹）
  if (!/[.!?]["')\]]*$/.test(wordStr)) return false;
  // 缩写（e.g. i.e. etc. vs. Dr. Mr. Ms. 等）不结束句子
  if (/^(e\.g\.?|i\.e\.?|etc\.?|vs\.?|viz\.?|Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Prof\.?|St\.?|No\.?|Fig\.?|Ref\.?|Sec\.?|approx\.?)$/i.test(wordStr)) return false;
  // 下一词不存在（文末）=> 结束
  if (!next) return true;
  // 下一词属于新行：行末的句号即为句子结束
  if (newRow) return true;
  const gap = next.x0 - word.x1;
  const bigGap = gap > Math.max(6, fontSize * 0.35);
  const capStart = /^[A-Z"'(]/.test(next.text);
  // 同行内新句常以较大间距 + 大写首字母开始
  return bigGap && capStart;
}

/* ---------------- 句子聚合 ---------------- */
function buildSentences(words) {
  // words: [{text, x0, y0, x1, y1}]
  if (!words.length) return [];
  // 按 y0 分行（同高聚类），再按 x0 排序
  const rowTol = 8 * S;             // 同行的 y 容差
  const rows = [];
  for (const w of words) {
    let placed = false;
    for (const row of rows) {
      if (Math.abs(w.y0 - row.y) < rowTol) { row.items.push(w); placed = true; break; }
    }
    if (!placed) rows.push({ y: w.y0, items: [w] });
  }
  for (const row of rows) row.items.sort((a, b) => a.x0 - b.x0);
  // 记录每个词所属行号，用于判定"换行"
  rows.sort((a, b) => a.y - b.y);
  const rowOf = new Map();
  rows.forEach((row, ri) => row.items.forEach((it) => rowOf.set(it, ri)));
  // 按行顺序（y）合并成一个词流
  const stream = [];
  for (const row of rows) for (const it of row.items) stream.push(it);

  // 聚合句子
  const sentences = [];
  let cur = [];
  for (let i = 0; i < stream.length; i++) {
    const w = stream[i];
    cur.push(w);
    const next = stream[i + 1] || null;
    const fontSize = (w.y1 - w.y0) || 10;
    const newRow = next ? rowOf.get(next) !== rowOf.get(w) : false;
    if (isSentenceEnd(w, next, fontSize, newRow)) {
      sentences.push(clone(cur));
      cur = [];
    }
  }
  if (cur.length) sentences.push(clone(cur));
  return sentences;
}

function clone(arr) { return arr.map((w) => ({ ...w })); }

/* ---------------- 词级重建 ---------------- */
function toWords(items, viewport, S) {
  const words = [];
  for (const item of items) {
    if (!item.str || !item.str.trim()) continue;
    // 将 PDF 用户空间坐标转换为视口坐标（上左角为原点、y 向下）
    const [px, py] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    const h = (item.height != null ? item.height : Math.abs(item.transform[3])) * S;
    const totalW = item.width * S;
    let cx = px;
    const n = item.str.length || 1;
    const avgW = totalW / n;   // 平均字宽（近似）
    for (const part of item.str.split(/(\s+)/)) {
      if (!part) continue;
      const pw = part.length * avgW;
      if (/^\s+$/.test(part)) { cx += pw; continue; }  // 空格只前进不产词
      words.push({ text: part, x0: cx, y0: py, x1: cx + pw, y1: py + h });
      cx += pw;
    }
  }
  return words;
}

/* ---------------- 页面渲染 ---------------- */
async function renderPage(pdf, pageNum, container) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: S });

  const wrap = document.createElement("div");
  wrap.className = "page-wrap";
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  wrap.appendChild(canvas);
  container.appendChild(wrap);

  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;

  const tc = await page.getTextContent();
  const words = toWords(tc.items, viewport, S);
  const sentences = buildSentences(words);

  // 文本层：提供可复制/选中的透明文字，同时作为悬浮命中层
  //（不再使用整页覆盖层，避免挡住原生文本选择）
  const textLayer = document.createElement("div");
  textLayer.className = "textLayer";
  textLayer.style.width = canvas.width + "px";
  textLayer.style.height = canvas.height + "px";
  wrap.appendChild(textLayer);
  await pdfjsLib.renderTextLayer({
    textContent: tc,
    container: textLayer,
    viewport: viewport,
    textDivs: [],
  }).promise;
  textLayer.style.visibility = "visible";

  wireTextLayer(textLayer, wrap, sentences, words);
  console.log(`P${pageNum}: ${words.length} 词, ${sentences.length} 句`);
}

/* ---------------- 文本层命中 ---------------- */
function wireTextLayer(textLayer, wrap, sentences, words) {
  const rowTol = 8 * S;             // 与 buildSentences 分行容差一致
  const rows = [];
  for (const w of words) {
    let placed = false;
    for (const row of rows) {
      if (Math.abs(w.y0 - row.y) < rowTol) { row.items.push(w); placed = true; break; }
    }
    if (!placed) rows.push({ y: w.y0, items: [w] });
  }
  const rowYs = rows.map((r) => r.y);

  // 行 -> 句子索引
  const rowToSent = new Map();
  sentences.forEach((sent, si) => {
    for (const w of sent) {
      for (let ri = 0; ri < rowYs.length; ri++) {
        if (Math.abs(rowYs[ri] - w.y0) < rowTol) { rowToSent.set(ri, si); break; }
      }
    }
  });

  pageSentTexts = sentences.map((sent) => sent.map((w) => w.text).join(" ").trim());
  pageSentGroups.clear();
  const wrapRect = wrap.getBoundingClientRect();
  const norm = (s) => String(s).replace(/\s+/g, " ").trim();
  const sentNorms = pageSentTexts.map(norm);

  for (const span of textLayer.querySelectorAll("span")) {
    if (span.classList.contains("endOfContent") || !span.textContent.trim()) continue;
    const st = norm(span.textContent);
    if (st.length < 2) continue;
    // 首选文本匹配：一行文本是该句的连续子串（不受文本层坐标偏移影响）
    const matches = [];
    for (let i = 0; i < sentNorms.length; i++) {
      if (sentNorms[i].includes(st)) matches.push(i);
    }
    let si = -1;
    if (matches.length === 1) {
      si = matches[0];
    } else if (matches.length > 1) {
      // 极短行命中多句：用坐标兜底
      const rect = span.getBoundingClientRect();
      const sy = rect.top - wrapRect.top;
      for (let ri = 0; ri < rowYs.length; ri++) {
        if (Math.abs(rowYs[ri] - sy) < rowTol) { si = rowToSent.get(ri) ?? -1; break; }
      }
      if (si < 0) si = matches[0];
    }
    if (si < 0) continue;
    span.dataset.sentId = String(si);
    if (!pageSentGroups.has(si)) pageSentGroups.set(si, []);
    pageSentGroups.get(si).push(span);

    span.addEventListener("mouseenter", (e) => onHover(si, e));
    span.addEventListener("mousemove", (e) => positionTooltip(e));
    span.addEventListener("mouseleave", spanLeave);
  }
}

/* ---------------- 悬浮 ---------------- */
function onHover(si, ev) {
  cancelHide();
  if (currentHoverKey !== si) {
    clearHover();
    currentHoverKey = si;
    currentHoverSpans = pageSentGroups.get(si) || [];
    for (const el of currentHoverSpans) el.classList.add("hl");
  }
  if (ev) positionTooltip(ev);
  const text = pageSentTexts[si];
  if (!text) return;
  if (tooltip.hidden) {
    pendShow(si);              // 首次：悬停意图延迟后再弹出
  } else if (pendingShowSi !== si) {
    fireShow(si);              // 已在显示其它句：立即切换
  }
}

function clearHover() {
  if (currentHoverSpans) {
    for (const el of currentHoverSpans) el.classList.remove("hl");
    currentHoverSpans = null;
  }
  currentHoverKey = null;
}

/* ---------------- 浮窗 ---------------- */
function showLoadingTooltip(text) {
  tooltip.hidden = false;
  tooltip.innerHTML = `<div class="tt-src">${esc(text)}</div><div class="loading">解析中…</div>`;
}

async function loadAndShow(text) {
  let result = sentenceResults.get(text);
  if (!result) {
    try {
      const resp = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sentences: [text] }),
      });
      const data = await resp.json();
      result = data.results && data.results[0];
      sentenceResults.set(text, result);
    } catch (err) {
      tooltip.innerHTML = `<div class="tt-src">${esc(text)}</div><div class="empty">解析请求失败：${esc(String(err))}</div>`;
      return;
    }
  }
  renderTooltip(text, result);
}

function renderTooltip(text, r) {
  if (!r) { tooltip.innerHTML = `<div class="tt-src">${esc(text)}</div><div class="empty">（暂无可解析内容）</div>`; return; }
  let chunksHtml = "";
  if (r.chunks && r.chunks.length) {
    chunksHtml = r.chunks.map((c) => {
      const k = { "main": "k-main", "rel-clause": "k-rel", "adv-clause": "k-adv",
                  "noun-clause": "k-rel", "noun/rel-clause": "k-rel", "parenthetical": "k-paren" }[c.kind] || "k-main";
      const kindZh = { "main": "主句", "rel-clause": "定语从句", "adv-clause": "状语从句",
                       "noun-clause": "名词性从句", "noun/rel-clause": "从句", "parenthetical": "插入语" }[c.kind] || c.kind;
      const marker = c.marker ? `<span class="marker">${esc(c.marker)}</span>` : "";
      const note = c.note ? `<div class="kind">${esc(c.note)}</div>` : "";
      return `<div class="chunk ${k}">${marker}${esc(c.text)}<div class="kind">${kindZh}</div>${note}</div>`;
    }).join("");
  }
  let glossHtml = "";
  if (r.words && r.words.length) {
    glossHtml = `<div class="sec"><div class="sec-title">复杂词 / 术语</div><ul class="gloss">` +
      r.words.map((g) => `<li><span class="w">${esc(g.word)}</span><span class="p">${esc(g.pos || "")}</span>` +
        `<span class="zn">${esc(g.zh || "")}</span>` +
        (g.note ? `<span class="nt">${esc(g.note)}</span>` : "") + `</li>`).join("") + `</ul></div>`;
  } else {
    glossHtml = `<div class="sec"><div class="sec-title">复杂词 / 术语</div><div class="empty">本句无已收录术语</div></div>`;
  }
  const verbRows = [];
  if (r.subject_hint) verbRows.push(`主语：<b>${esc(r.subject_hint)}</b>`);
  if (r.main_verb) verbRows.push(`谓语：<b>${esc(r.main_verb)}</b>`);
  const conf = verbRows.length
    ? `<div class="sec sec-title">主句主干</div><div class="chunk-box">${verbRows.map((v) => `<div class="verb-row">${v}</div>`).join("")}</div>`
    : "";

  tooltip.innerHTML = `<div class="tt-src">${esc(text)}</div>` +
    `<div class="sec"><div class="sec-title">断句（按从句切分）</div><div class="chunk-box">${chunksHtml}</div></div>` +
    conf + glossHtml;
  // 内容高度确定后按光标重定位，避免浮窗长大后被顶到错误位置
  if (lastPointer) positionTooltip(lastPointer);
}

function positionTooltip(e) {
  lastPointer = { clientX: e.clientX, clientY: e.clientY };
  const pad = 8;
  const tw = tooltip.offsetWidth || 460;
  const th = tooltip.offsetHeight || 200;
  let x = e.clientX + 12, y = e.clientY + 8;   // 小偏移：贴近光标，避免明显偏下
  if (x + tw > window.innerWidth - pad) x = e.clientX - tw - 10;
  if (y + th > window.innerHeight - pad) y = e.clientY - th - 10;
  tooltip.style.left = Math.max(pad, x) + "px";
  tooltip.style.top = Math.max(pad, y) + "px";
}

function spanLeave(e) {
  if (movingToTooltip(e)) {
    // 光标移入浮窗：若还在延迟阶段则立即弹出
    cancelShowDelay();
    if (tooltip.hidden && currentHoverKey != null) fireShow(currentHoverKey);
    return;
  }
  cancelShowDelay();
  scheduleHide();
}

function hideTooltip() {
  cancelHide();
  cancelShowDelay();
  tooltip.hidden = true;
  clearHover();
}

function scheduleHide() {
  cancelHide();
  hideTimer = setTimeout(hideTooltip, 200);
}

function cancelHide() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}

/* 悬停意图：停留 350ms 后再弹出，避免鼠标移动途中浮窗遮挡/吞掉指针 */
function pendShow(si) {
  cancelShowDelay();
  pendingShowSi = si;
  showTimer = setTimeout(() => {
    showTimer = null;
    if (pendingShowSi != null) {
      const s = pendingShowSi;
      pendingShowSi = null;
      fireShow(s);
    }
  }, 350);
}

function cancelShowDelay() {
  if (showTimer) { clearTimeout(showTimer); showTimer = null; }
  pendingShowSi = null;
}

function fireShow(si) {
  pendingShowSi = null;
  const text = pageSentTexts[si];
  if (!text) return;
  showLoadingTooltip(text);
  loadAndShow(text);
}

function movingToTooltip(e) {
  const rt = e.relatedTarget;
  return !!(rt && (rt === tooltip || tooltip.contains(rt)));
}

// 浮窗自身可交互：移入保持打开（可滚动/查看长内容）
tooltip.addEventListener("mouseenter", () => cancelHide());
tooltip.addEventListener("mouseleave", () => scheduleHide());

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------- 文件加载 ---------------- */
fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  pagesEl.innerHTML = "";
  placeholder.hidden = true;
  sentenceResults.clear();
  hideTooltip();
  clearHover();
  try {
    const data = await file.arrayBuffer();
    currentPdf = await pdfjsLib.getDocument({ data }).promise;
    for (let i = 1; i <= currentPdf.numPages; i++) {
      await renderPage(currentPdf, i, pagesEl);
    }
  } catch (err) {
    placeholder.hidden = false;
    placeholder.innerHTML = `<p style="color:#c00">加载失败：${esc(String(err))}</p>`;
  }
});