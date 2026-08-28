/* 页面虚拟化与挂载管线：解析占位 → IO 驱动挂载 → LRU 回收 → 渲染并发闸门。
 *
 * 全部可变状态（页数据、挂载表、可视槽位、渲染队列、页码坐标）内聚在
 * createPageVirtualizer 工厂内；viewer.js 的外部状态经 refs/hooks 显式注入，
 * 便于按实例重置与回归测试。 */
(function exposeViewerPages(global) {
  "use strict";

  const PAGE_GAP_PX = 20;              // 与 style.css #pages 的 gap 保持一致
  const MOUNTED_PAGE_LIMIT = 8;        // 页面虚拟化：最多同时挂载的页数
  const MOUNT_SETTLE_MS = 120;         // 进入视距后的挂载沉降，过滤快速掠过
  const MAX_CONCURRENT_RENDERS = 2;    // canvas 光栅化并发闸门
  const CANVAS_MAX_SCALE = 3.2;
  const CANVAS_MAX_PIXELS = 16_000_000;

  function createPageVirtualizer(deps) {
    const {
      sentences,  // { S, toWords, buildSentences, alignTextDivs }
      helpers,    // { fitCanvasScale, buildSentenceDomRects }
      marks,      // { addClassToSpans, createSentenceMarks, toggleSentenceMarks, purgePageMarks }
      utils,      // { measuredRect }
      refs,       // { pdfjsLib, getLoadSerial, getCurrentPdf, getPdfZoom, getDocumentPane, getSelectedTarget, getPreviewTarget, pageSentenceTargets }
      hooks,      // { createPageTargets, wireTextLayer, renderAnnotationLayer, getCurrentVisiblePage }
    } = deps;

    const { S, toWords, buildSentences, alignTextDivs } = sentences;
    const { fitCanvasScale, buildSentenceDomRects } = helpers;
    const { addClassToSpans, createSentenceMarks, toggleSentenceMarks, purgePageMarks } = marks;
    const { measuredRect } = utils;
    const {
      pdfjsLib,
      getLoadSerial,
      getCurrentPdf,
      getPdfZoom,
      getDocumentPane,
      getSelectedTarget,
      getPreviewTarget,
      pageSentenceTargets,
    } = refs;
    const { createPageTargets, wireTextLayer, renderAnnotationLayer, getCurrentVisiblePage } = hooks;

    let pageTops = [];
    let pageHeights = [];
    const pageDataByNum = new Map();
    const mountedPages = new Map();
    const visibleSlots = new Set();
    const mountTimers = new Map();
    let pageObserver = null;
    let activeRenders = 0;
    const renderQueue = [];

    function devicePixelRatioSafe() {
      return Math.max(1, Math.min(3, Number(window.devicePixelRatio) || 1));
    }

    function renderScaleFor(viewport) {
      return fitCanvasScale(
        viewport.width / S,
        viewport.height / S,
        S * devicePixelRatioSafe() * getPdfZoom(),
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
      if (loadId !== getLoadSerial() || pdf !== getCurrentPdf()) return null;
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
      if (serial !== mount.renderSerial || mount.stage === "unmounted" || mount.loadId !== getLoadSerial()) return;
      const scale = sizeCanvasToViewport(mount.canvas, data.viewport);
      await acquireRenderSlot();
      try {
        if (serial !== mount.renderSerial || mount.stage === "unmounted" || mount.loadId !== getLoadSerial()) return;
        mount.renderTask = data.page.render({ canvasContext: mount.canvas.getContext("2d"), viewport: data.page.getViewport({ scale }) });
        await mount.renderTask.promise;
      } catch (error) {
        if (mount.stage !== "unmounted" && mount.loadId === getLoadSerial() && String(error && error.name) !== "RenderingCancelledException") {
          console.warn(`第 ${mount.pageNum} 页位图渲染失败`, error);
        }
      } finally {
        releaseRenderSlot();
      }
    }

    /* 渲染阶段：挂载 canvas/textLayer/注解层并接线交互，可取消、受挂载上限约束。 */
    async function mountPageVisual(pageNum, loadId = getLoadSerial()) {
      if (mountedPages.has(pageNum)) return mountedPages.get(pageNum).ready;
      const data = pageDataByNum.get(pageNum);
      if (!data || loadId !== getLoadSerial() || !getCurrentPdf()) return null;
      const mount = {
        pageNum,
        loadId,
        stage: "mounting",
        zoomAtMount: getPdfZoom(),
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
          if (loadId !== getLoadSerial() || mount.stage === "unmounted") return;

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
          if (loadId !== getLoadSerial() || mount.stage === "unmounted") return;
          mount.alignedTextDivs = alignTextDivs(textContent.items, textDivs);
          mount.targets = wireTextLayer(textLayer, wrap, sentences, words, pageNum, mount.alignedTextDivs, targets, viewport.width, viewport.height);
          await renderAnnotationLayer(page, viewport, wrap, getCurrentPdf());
          if (typeof page.cleanup === "function") page.cleanup();
          mount.stage = "mounted";
          // 重新挂载的页需要恢复选中/预览高亮
          const selected = getSelectedTarget();
          if (selected && (selected.locations || []).some((location) => location.pageNum === pageNum)) {
            addClassToSpans(selected, "is-selected");
          }
          const preview = getPreviewTarget();
          if (preview && (preview.locations || []).some((location) => location.pageNum === pageNum)) {
            addClassToSpans(preview, "is-preview");
          }
          // 挂载期间发生过缩放提交：位图按新倍率补渲一次
          if (mount.zoomAtMount !== getPdfZoom()) await renderMountCanvas(mount);
          scheduleExactRectsWarmup(mount);
          enforceMountedPageLimit();
        } catch (error) {
          // 失败页移出挂载表，允许再次进入视距时重试
          if (mount.stage !== "unmounted") mountedPages.delete(pageNum);
          if (mount.stage !== "unmounted" && loadId === getLoadSerial()) {
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
      purgePageMarks(pageNum);  // 丢弃该页的 mark 引用，重新挂载时由 createSentenceMarks 重建
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
      }, { root: getDocumentPane() || null, rootMargin: "1600px 0px", threshold: 0 });
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
      const current = getCurrentVisiblePage();
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
      const visualScale = wrapRect.width > 0 ? wrapRect.width / width : getPdfZoom();
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
      const selected = getSelectedTarget();
      if (selected && (selected.locations || []).some((location) => location.pageNum === pageNum)) {
        marks.toggleSentenceMarks(selected, "is-selected", true);
      }
      const preview = getPreviewTarget();
      if (preview && (preview.locations || []).some((location) => location.pageNum === pageNum)) {
        marks.toggleSentenceMarks(preview, "is-preview", true);
      }
    }

    function scheduleExactRectsWarmup(mount) {
      const idle = (window && typeof window.requestIdleCallback === "function")
        ? (callback) => window.requestIdleCallback(callback, { timeout: 800 })
        : (callback) => setTimeout(callback, 60);
      idle(() => {
        if (mount.stage !== "mounted" || mount.loadId !== getLoadSerial()) return;
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

    /* 打开新文档时整体重置：断开观察器、清空挂载/渲染状态与页码坐标。 */
    function resetVirtualization() {
      if (pageObserver) {
        pageObserver.disconnect();
        pageObserver = null;
      }
      for (const timer of mountTimers.values()) clearTimeout(timer);
      mountTimers.clear();
      mountedPages.clear();
      visibleSlots.clear();
      pageDataByNum.clear();
      pageTops = [];
      pageHeights = [];
    }

    return {
      parsePage,
      mountPageVisual,
      unmountPage,
      ensurePageObserver,
      enforceMountedPageLimit,
      rerenderMountedCanvases,
      resetVirtualization,
      getPageTops: () => pageTops,
      getPageHeights: () => pageHeights,
      testApi: {
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
          nums.forEach((n) => mountedPages.set(n, { pageNum: n, stage: "mounted", loadId: getLoadSerial() }));
        },
        enforceMountedPageLimit,
        unmountPage,
      },
    };
  }

  global.__parseSpecViewerParts = Object.assign(global.__parseSpecViewerParts || {}, {
    createPageVirtualizer,
  });
}(globalThis));
