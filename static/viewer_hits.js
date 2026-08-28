/* 命中映射：把 textLayer span 对齐到句子、按字符矩形命中指针位置，
   并接线悬停预览（leading 同步 + rAF trailing 合并）与单击选中。
   函数无自有状态，viewer 侧依赖经 createWireTextLayer 注入。 */
(function exposeViewerHits(global) {
  "use strict";

  function createWireTextLayer(deps) {
    const {
      sentences,  // { S, sentenceText }
      helpers,    // { computeFallbackRects, targetAtPoint }
      marks,      // { createSentenceMarks }
      refs,       // { getPdfZoom, pageSentenceTargets }
      ui,         // { hasTextSelection, setPreview, clearPreview, selectSentence, requestUiFrame }
    } = deps;

    const { S, sentenceText } = sentences;
    const { computeFallbackRects, targetAtPoint } = helpers;
    const { createSentenceMarks } = marks;
    const { getPdfZoom, pageSentenceTargets } = refs;
    const { hasTextSelection, setPreview, clearPreview, selectSentence, requestUiFrame } = ui;

    return function wireTextLayer(
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
      // wrapRect 处于 CSS zoom 后的视口坐标系；rowYs 与词坐标都是未缩放页面坐标。
      const visualScale = wrapRect.width > 0 ? wrapRect.width / width : getPdfZoom();
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
          // rect.top 是缩放后的视口坐标，需还原为页面坐标再与 rowYs 比较；
          // 否则高倍缩放下 span 归属判别整体失准并静默回退到第一个候选。
          const spanY = (rect.top - wrapRect.top) / (visualScale || 1);
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
          (Number(event.clientX) - rect.left) / getPdfZoom(),
          (Number(event.clientY) - rect.top) / getPdfZoom(),
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
    };
  }

  global.__parseSpecViewerParts = Object.assign(global.__parseSpecViewerParts || {}, {
    createWireTextLayer,
  });
}(globalThis));
