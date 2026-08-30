/* 侧栏区块：句子分析栏渲染、术语/复杂词弹窗与分析栏/导航栏拖拽调宽。
 *
 * 渲染层为纯 HTML 生成；弹窗 CRUD、条目缓存与拖拽浮层状态内聚在
 * createSidebar 工厂内。viewer 侧的选中态、请求串号、分析缓存与元素
 * 引用经 refs/hooks/els 显式注入，模块自身不读取 viewer 可变状态。 */
(function exposeViewerSidebar(global) {
  "use strict";

  const SEARCH_DEBOUNCE_MS = 150;
  const OUTLINE_WIDTH_KEY = "parse-spec:outline-width";

  function createSidebar(deps) {
    const {
      text,      // { esc }
      sentences, // { wordAtTextOffset }
      utils,     // { debounce, measuredRect, requestUiFrame }
      els,       // { 分析栏/弹窗/导航栏元素引用 }
      refs,      // { getUiSettings, getSelectedTarget, sentenceResults }
      settings,  // { validStructureViews, defaultSettings }
      hooks,     // { invalidateSentenceResultsFor, refreshSelectedAnalysis, loadAndRender, bumpRequestSerial, clearSelection, clearPreview, isNarrowViewport }
    } = deps;

    const { esc } = text;
    const { wordAtTextOffset } = sentences;
    const { debounce, measuredRect, requestUiFrame } = utils;
    const { validStructureViews: VALID_STRUCTURE_VIEWS, defaultSettings: DEFAULT_SETTINGS } = settings;
    const {
      invalidateSentenceResultsFor, refreshSelectedAnalysis, loadAndRender,
      bumpRequestSerial, clearSelection, clearPreview, isNarrowViewport,
      getSentenceFeedbackNote, submitSentenceFeedback, removeSentenceFeedback,
    } = hooks;
    const {
      analysisContent, analysisPanel, panelToggle, panelClose, panelResizer, workspace,
      navResizer, outlinePanel, bookmarkPanel,
      complexWordDialog, complexWordToggle, complexWordSearch, complexWordList, complexWordWord,
      complexWordLevel, complexWordZh, complexWordNote, complexWordMessage, complexWordDelete, complexWordInfo,
      glossaryDialog, glossaryToggle, glossarySearch, glossaryList, glossaryWord, glossaryPos,
      glossaryZh, glossaryNote, glossaryMessage, glossaryBackupSelect, glossaryDelete,
    } = els;
    const { getUiSettings, getSelectedTarget, sentenceResults } = refs;

    let panelCollapsed = false;
    let resizeStart = null;
    let navResizeStart = null;
    let glossaryEntries = [];
    let glossaryBackups = [];
    let activeGlossarySource = null;
    let complexWordEntries = [];
    let activeComplexWordSource = null;
    let complexWordSuggestionSerial = 0;
    let wordInfoSerial = 0;
    const renderComplexWordEntriesDebounced = debounce((value) => renderComplexWordEntries(value), SEARCH_DEBOUNCE_MS);
    const renderGlossaryEntriesDebounced = debounce((value) => renderGlossaryEntries(value), SEARCH_DEBOUNCE_MS);

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
      const selectedTarget = getSelectedTarget();
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
          ? (entry.source === "custom" ? "正在编辑自定义复杂词。" : "保存后会在 data/complex_words.json 中覆盖该内置释义。")
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
        const selectedTarget = getSelectedTarget();
        if (selectedTarget) {
          const requestId = bumpRequestSerial();
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
        glossaryMessage.textContent = entry.source === "custom" ? "正在编辑自定义词条。" : "保存后会在 data/glossary.json 中覆盖该内置释义。";
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
        const selectedTarget = getSelectedTarget();
        if (selectedTarget) {
          const requestId = bumpRequestSerial();
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

    function renderEmptyPanel() {
      analysisContent.innerHTML = `<div class="panel-empty">
    <span class="panel-empty-icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 14L14 6M7.5 6H14v6.5"/></svg></span>
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
        const currentTarget = getSelectedTarget();
        if (!currentTarget || currentTarget.key !== target.key) return;
        sentenceResults.delete(target.text);
        const requestId = bumpRequestSerial();
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
        means: "方式手段",
        conjunct: "并列分句",
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

    // 树节点里的长引号标题（如 Figure 图题）折叠展示，避免淹没分句主干；
    // 原句卡片与原文联动高亮始终完整。悬停可查看未折叠全文。
    const QUOTE_FOLD_MAX_WORDS = 6;

    function foldLongQuotedTitles(text) {
      return String(text || "").replace(/[“"]([^”"]{24,})[”"]/g, (match, inner) => {
        const words = inner.trim().split(/\s+/);
        if (words.length <= QUOTE_FOLD_MAX_WORDS) return match;
        return `${match[0]}${words.slice(0, QUOTE_FOLD_MAX_WORDS).join(" ")} …${match[match.length - 1]}`;
      });
    }

    function foldedClauseHtml(text) {
      const source = String(text || "");
      const folded = foldLongQuotedTitles(source);
      const escaped = esc(folded);
      return folded === source ? escaped : `<span class="folded-quote" title="${esc(source)}">${escaped}</span>`;
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
    <span class="bracket-inline-text">${foldedClauseHtml(bracketClauseText(clause))}</span>
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
      <strong id="clause-focus-text">${foldedClauseHtml(main.text)}</strong>
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
        <div class="linked-node-text">${foldedClauseHtml(clause.text)}</div>
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
      const uiSettings = getUiSettings();
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
      const refineBadge = result.refined_by
        ? `<span class="engine-badge refine-badge" title="分句树由在线模型精修，本地解析仍即时可用">在线精修 · ${esc(result.refined_by)}</span>`
        : "";
      const qaSignals = (result.qa && Array.isArray(result.qa.signals)) ? result.qa.signals : [];
      const qaBadge = result.qa && result.qa.suspicious
        ? `<button class="engine-badge qa-badge qa-badge-toggle" type="button" aria-expanded="false" aria-controls="qa-detail" title="点击查看存疑信号明细">解析存疑</button>`
        : "";
      const qaDetail = qaBadge && qaSignals.length
        ? `<div class="qa-detail" id="qa-detail" hidden>
        <div class="qa-detail-title">解析质检发现以下可疑信号，请结合原句复核：</div>
        <ul>${qaSignals.map((signal) => `<li>${esc(signal)}</li>`).join("")}</ul>
        <div class="qa-detail-note">该句的分句边界或关系标注可能不准；可切换“详细”密度查看逐分句警告，或对照原文人工确认。</div>
      </div>`
        : "";
      const feedbackNote = typeof getSentenceFeedbackNote === "function" ? getSentenceFeedbackNote(target) : null;
      const flagged = feedbackNote !== null;
      const flagSection = `<div class="flag-section">
      <button class="flag-toggle${flagged ? " is-flagged" : ""}" type="button" aria-expanded="false" aria-controls="sentence-flag-form" title="${flagged ? "已标注异常：点击查看或修改本句意见" : "本句读不通或解析有疑问？标注并附注意见，供批量优化解析"}">${flagged ? "标注异常 · 已标注" : "标注异常"}</button>
      <div class="flag-form" id="sentence-flag-form" hidden>
        <textarea id="sentence-flag-note" rows="3" maxlength="2000" placeholder="可选：说明哪里读不通、期望的正确结构是什么…">${flagged ? esc(feedbackNote) : ""}</textarea>
        <div class="flag-actions">
          <button class="flag-save" type="button">保存标注</button>
          <button class="flag-delete" type="button"${flagged ? "" : " disabled"}>删除标注</button>
          <button class="flag-cancel" type="button">取消</button>
        </div>
        <div class="flag-message" aria-live="polite"></div>
      </div>
    </div>`;
      const structureLabel = structureView === "linked" ? "原文联动树" : "嵌套原文";
      const logicSection = concise ? "" : `<section class="analysis-section"><h3 class="section-heading">逻辑结构 · ${structureLabel}</h3>${structureHtml}</section>`;
      const termsSection = concise ? "" : `<section class="analysis-section"><h3 class="section-heading">复杂词</h3>${complexWordsHtml || '<div class="empty-copy">本句没有识别到较难的通用单词</div>'}<h3 class="section-heading term-heading">术语</h3>${termsHtml}</section>`;
      const conciseCore = concise ? `<section class="analysis-section concise-core"><h3 class="section-heading">核心命题</h3><div class="core-card">${foldedClauseHtml(main.text)}</div></section>` : "";

      analysisContent.innerHTML = `<div class="sentence-meta">
      <span>${targetLocationText(target)}</span>
      <span class="meta-badges"><span class="depth-badge">${depthText(depth)}</span><span class="engine-badge">${engineName}</span>${refineBadge}${qaBadge}</span>
    </div>
    ${qaDetail}${flagSection}
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

      for (const qaToggle of analysisContent.querySelectorAll(".qa-badge-toggle")) {
        const qaDetailElement = document.getElementById("qa-detail");
        qaToggle.addEventListener("click", () => {
          const expanded = qaToggle.getAttribute("aria-expanded") === "true";
          qaToggle.setAttribute("aria-expanded", String(!expanded));
          if (qaDetailElement) qaDetailElement.hidden = expanded;
        });
      }

      for (const flagToggle of analysisContent.querySelectorAll(".flag-toggle")) {
        const flagForm = document.getElementById("sentence-flag-form");
        const noteInput = document.getElementById("sentence-flag-note");
        const message = flagForm ? flagForm.querySelector(".flag-message") : null;
        const setMessage = (value, isError = false) => {
          if (!message) return;
          message.textContent = value;
          message.classList.toggle("is-error", isError);
        };
        flagToggle.addEventListener("click", () => {
          const expanded = flagToggle.getAttribute("aria-expanded") === "true";
          flagToggle.setAttribute("aria-expanded", String(!expanded));
          if (flagForm) flagForm.hidden = expanded;
          if (!expanded && noteInput && noteInput.focus) noteInput.focus();
        });
        const saveButton = flagForm ? flagForm.querySelector(".flag-save") : null;
        if (saveButton && typeof submitSentenceFeedback === "function") {
          saveButton.addEventListener("click", async () => {
            const note = noteInput ? String(noteInput.value || "").trim() : "";
            saveButton.disabled = true;
            setMessage("正在保存…");
            try {
              await submitSentenceFeedback(target, note, {
                qa: result.qa || null,
                parse: (result.clauses || []).map((clause) => ({ relation: clause.relation, marker: clause.marker || "" })),
              });
              flagToggle.classList.add("is-flagged");
              flagToggle.title = "已标注异常：点击查看或修改本句意见";
              flagToggle.textContent = "标注异常 · 已标注";
              if (deleteButton) deleteButton.disabled = false;
              if (flagForm) flagForm.hidden = true;
              flagToggle.setAttribute("aria-expanded", "false");
              setMessage("已保存标注。积累的标注会存入 data/sentence_feedback.json。");
            } catch (error) {
              setMessage(`保存失败：${String(error)}`, true);
            } finally {
              saveButton.disabled = false;
            }
          });
        }
        const deleteButton = flagForm ? flagForm.querySelector(".flag-delete") : null;
        if (deleteButton && typeof removeSentenceFeedback === "function") {
          deleteButton.addEventListener("click", async () => {
            deleteButton.disabled = true;
            try {
              await removeSentenceFeedback(target);
              flagToggle.classList.remove("is-flagged");
              flagToggle.title = "本句读不通或解析有疑问？标注并附注意见，供批量优化解析";
              flagToggle.textContent = "标注异常";
              if (noteInput) noteInput.value = "";
              if (flagForm) flagForm.hidden = true;
              flagToggle.setAttribute("aria-expanded", "false");
              setMessage("已删除标注。");
            } catch (error) {
              setMessage(`删除失败：${String(error)}`, true);
              deleteButton.disabled = false;
            }
          });
        }
        const cancelButton = flagForm ? flagForm.querySelector(".flag-cancel") : null;
        if (cancelButton) {
          cancelButton.addEventListener("click", () => {
            if (flagForm) flagForm.hidden = true;
            flagToggle.setAttribute("aria-expanded", "false");
          });
        }
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
          const folded = foldLongQuotedTitles(clause.text || "");
          focusText.textContent = folded;
          focusText.title = folded === String(clause.text || "") ? "" : String(clause.text || "");
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

    return {
      renderEmptyPanel, targetLocationText, renderLoadingPanel, renderErrorPanel, renderAnalysisPanel,
      toggleTranslationTerm, openGlossary, closeGlossary, openComplexWords, closeComplexWords,
      editComplexWord, submitComplexWord, deleteComplexWord, submitGlossaryEntry, deleteGlossaryEntry,
      syncComplexWordDeleteState, syncGlossaryDeleteState, createGlossaryBackup, restoreGlossaryBackup,
      downloadGlossaryBackup, deleteGlossaryBackup, loadWordInfo, clearWordInfo,
      renderComplexWordEntries, loadComplexWordEntries, renderGlossaryEntries, loadGlossaryEntries,
      renderGlossaryBackups, loadGlossaryBackups,
      renderComplexWordEntriesDebounced, renderGlossaryEntriesDebounced,
      setPanelCollapsed, closeAnalysisPanel, isPanelCollapsed: () => panelCollapsed,
      setPanelWidth, restorePanelWidth,
      startResize, moveResize, endResize, resizeByKeyboard,
      startNavResize, moveNavResize, endNavResize, resizeNavByKeyboard,
      setOutlineWidth, outlineWidth, restoreOutlineWidth, finishLiveResize, clearLiveResizeStyles,
      sourceWordFromContextEvent,
    };
  }

  global.__parseSpecViewerParts = Object.assign(global.__parseSpecViewerParts || {}, {
    createSidebar,
  });
}(globalThis));
