/* 句子切分与文本工具：从原始词坐标构建句子、跨页合并判定与文本层对齐。
   独立于阅读器可变状态，供 viewer.js 与回归测试共同使用。 */
(function exposeViewerSentences(global) {
  "use strict";

  // 渲染倍率：词坐标一律按该倍率生成，页面 CSS zoom 只影响视觉呈现。
  const S = 1.4;

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

  function finalizeDocumentSentences(state) {
    if (state && state.pending && state.pending.target) {
      const target = state.pending.target;
      if (!(target.contextWarnings || []).length) {
        target.contextWarnings = ["文档末尾没有明确句末标点，请确认句子是否完整。"];
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

  global.__parseSpecViewerParts = Object.assign(global.__parseSpecViewerParts || {}, {
    S,
    alignTextDivs,
    buildSentences,
    finalizeDocumentSentences,
    hasTerminalPunctuation,
    isSentenceEnd,
    joinAcrossPages,
    sentenceText,
    shouldMergeAcrossPages,
    toWords,
    wordAtTextOffset,
  });
}(globalThis));
