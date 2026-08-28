const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");


class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...values) { for (const value of values) this.values.add(value); }
  remove(...values) { for (const value of values) this.values.delete(value); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const enabled = force === undefined ? !this.values.has(value) : !!force;
    if (enabled) this.values.add(value); else this.values.delete(value);
    return enabled;
  }
}


class FakeStyle {
  constructor() { this.values = new Map(); }
  setProperty(name, value) { this.values.set(name, value); }
  getPropertyValue(name) { return this.values.get(name) || ""; }
}


class FakeElement {
  constructor(text = "") {
    this.textContent = text;
    this.innerHTML = "";
    this.hidden = false;
    this.dataset = {};
    this.style = new FakeStyle();
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.attributes = new Map();
    this.spans = [];
    this.children = [];
    this.files = [];
    this.value = "";
  }

  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }

  emit(type, event = {}) {
    if (this.pointerLayer) {
      if (type === "mouseenter") return this.pointerLayer.emit("mousemove", { clientX: this.pointerX, clientY: this.pointerY, ...event });
      if (type === "mouseleave") return this.pointerLayer.emit("mouseleave", event);
      if (type === "click") return this.pointerLayer.emit("click", { clientX: this.pointerX, clientY: this.pointerY, ...event });
    }
    for (const callback of this.listeners.get(type) || []) callback(event);
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name); }
  appendChild(child) { this.children.push(child); return child; }
  querySelectorAll(selector) { return selector === "span" ? this.spans : []; }
  getBoundingClientRect() { return { left: 0, top: 0 }; }
  contains(target) { return target === this; }
  setPointerCapture() {}
}


function responseFor(text) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      results: [{
        schema_version: 2,
        text,
        engine: "spacy",
        main_clause_id: "c0",
        clauses: [{
          id: "c0",
          parent_id: null,
          order: 0,
          text,
          start: 0,
          end: text.length,
          segments: [[0, text.length]],
          kind: "main",
          relation: "main",
          label: "核心命题",
          marker: "",
          grammar: { subject: "The data", predicate: "is sampled", object: "", agent: "", complement: "", voice: "passive", negated: false, modality: "" },
          confidence: .96,
          warnings: [],
        }],
        terms: [],
        translation: null,
        warnings: [],
      }],
    }),
  };
}


function loadViewer(
  fetchImpl = async (_url, options) => responseFor(JSON.parse(options.body).sentences[0]),
  settings = {},
) {
  const ids = [
    "file", "file-empty", "pages", "placeholder", "workspace", "analysis-panel",
    "analysis-content", "panel-toggle", "panel-close", "panel-resizer", "doc-meta",
    "recent-docs", "recent-docs-menu", "recent-docs-list", "theme-cycle", "theme-icon",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  elements["recent-docs-menu"].hidden = true;
  const documentListeners = new Map();
  const documentElement = new FakeElement();
  const body = new FakeElement();
  const storage = new Map();
  let selection = "";
  const document = {
    documentElement,
    body,
    getElementById: (id) => elements[id],
    createElement: () => new FakeElement(),
    addEventListener: (type, callback) => {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(callback);
    },
    emit: (type, event) => {
      for (const callback of documentListeners.get(type) || []) callback(event);
    },
  };
  const windowListeners = new Map();
  const window = {
    innerWidth: 1600,
    innerHeight: 900,
    getSelection: () => ({ toString: () => selection }),
    addEventListener: (type, callback) => {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(callback);
    },
    matchMedia: () => ({ matches: !!settings.narrow }),
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
  };
  const context = {
    console,
    Map,
    Promise,
    pdfjsLib: { GlobalWorkerOptions: {}, ...(settings.pdfjsLib || {}) },
    document,
    window,
    fetch: fetchImpl,
    getComputedStyle: (element) => ({ getPropertyValue: (name) => element.style.getPropertyValue(name) }),
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync("static/pdf_helpers.js", "utf8"), context);
  vm.runInNewContext(fs.readFileSync("static/viewer.js", "utf8"), context);
  return {
    context,
    elements,
    document,
    storage,
    setSelection: (value) => { selection = value; },
  };
}


function wireSentence(context, pageNum, text) {
  const span = new FakeElement(text);
  const layer = new FakeElement();
  layer.spans = [span];
  const wrap = new FakeElement();
  const words = [{ text, x0: 0, y0: 10, x1: 100, y1: 20 }];
  context.wireTextLayer(layer, wrap, [words], words, pageNum);
  span.pointerLayer = layer;
  span.pointerX = 50;
  span.pointerY = 15;
  return span;
}


test("示例 PDF 仍切分为 9 句", async () => {
  const { context } = loadViewer();
  const pdfjs = await pdfjsPromise;
  const data = new Uint8Array(fs.readFileSync("docs/sample_spec.pdf"));
  const pdf = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1.4 });
  const textContent = await page.getTextContent();
  const words = context.toWords(textContent.items, viewport, 1.4);
  assert.equal(context.buildSentences(words).length, 9);
});

test("DFI 第 62 页同一 TextItem 内的连续句子会正确拆分", async () => {
  const { context } = loadViewer();
  const pdfjs = await pdfjsPromise;
  const data = new Uint8Array(fs.readFileSync("docs/DDR_PHY_Interface_Specification_v5_2.pdf"));
  const pdf = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  const page = await pdf.getPage(62);
  const viewport = page.getViewport({ scale: 1.4 });
  const textContent = await page.getTextContent();
  const words = context.toWords(textContent.items, viewport, 1.4);
  const texts = context.buildSentences(words).map(context.sentenceText);
  const paragraph = texts.filter((text) => /dfi_init_(?:start|complete)|associated timing parameters/.test(text));

  assert.ok(paragraph.includes("The signals used in the frequency change protocol are dfi_init_start and dfi_init_complete during normal operation."));
  assert.ok(paragraph.includes("The behavior of the dfi_init_start signal depends on the dfi_init_complete signal."));
  assert.ok(paragraph.includes("A frequency change request is triggered when the MC asserts dfi_init_start."));
  assert.ok(paragraph.includes("The PHY indicates the acceptance of the frequency change by de-asserting dfi_init_complete."));
  assert.ok(paragraph.includes("The associated timing parameters are tinit_start and tinit_complete."));
});

test("TextItem 与 textLayer span 按文本对齐，不被空项整体错位", () => {
  const { context } = loadViewer();
  const first = new FakeElement("First line");
  const second = new FakeElement("Second line");
  const aligned = context.alignTextDivs(
    [{ str: "" }, { str: "First line" }, { str: "" }, { str: "Second line" }],
    [first, second],
  );
  assert.equal(aligned[1], first);
  assert.equal(aligned[3], second);
});

test("PDF Link 注解渲染为可点击的安全内部链接层", async () => {
  const { context } = loadViewer();
  const wrap = new FakeElement();
  const page = {
    getAnnotations: async () => [{ subtype: "Link", rect: [10, 20, 80, 40], dest: "intro", overlaidText: "Introduction" }],
  };
  const viewport = {
    width: 200,
    height: 300,
    convertToViewportPoint: (x, y) => [x, 300 - y],
  };
  await context.renderAnnotationLayer(page, viewport, wrap, {});
  assert.equal(wrap.children.length, 1);
  assert.equal(wrap.children[0].children.length, 1);
  assert.equal(wrap.children[0].children[0].getAttribute("aria-label"), "Introduction");
});


test("同一文本 span 横跨两个句子时按指针坐标命中", () => {
  const requested = [];
  const { context } = loadViewer(async (_url, options) => {
    const text = JSON.parse(options.body).sentences[0];
    requested.push(text);
    return responseFor(text);
  });
  const span = new FakeElement("First sentence. Second sentence.");
  const layer = new FakeElement();
  layer.spans = [span];
  const wrap = new FakeElement();
  const first = [{ text: "First sentence.", x0: 0, y0: 10, x1: 90, y1: 20 }];
  const second = [{ text: "Second sentence.", x0: 100, y0: 10, x1: 200, y1: 20 }];
  context.wireTextLayer(layer, wrap, [first, second], [...first, ...second], 1);

  layer.emit("click", { clientX: 140, clientY: 15 });
  assert.deepEqual(requested, ["Second sentence."]);
});


test("快速连续打开 PDF 时旧加载不能覆盖新文档", async () => {
  const pending = [];
  const destroyed = [];
  const { context, elements } = loadViewer(undefined, {
    pdfjsLib: {
      getDocument: () => {
        let resolve;
        const promise = new Promise((done) => { resolve = done; });
        const task = { promise, destroy: async () => { destroyed.push(task); } };
        pending.push({ resolve, task });
        return task;
      },
    },
  });
  const firstFile = { name: "first.pdf", arrayBuffer: async () => new ArrayBuffer(1) };
  const secondFile = { name: "second.pdf", arrayBuffer: async () => new ArrayBuffer(1) };
  const firstLoad = context.openPdf(firstFile);
  await new Promise((resolve) => setImmediate(resolve));
  const secondLoad = context.openPdf(secondFile);
  await new Promise((resolve) => setImmediate(resolve));

  const secondPdf = { numPages: 0, getOutline: async () => [], destroy: async () => {} };
  pending[1].resolve(secondPdf);
  await secondLoad;
  const firstPdf = { numPages: 0, getOutline: async () => [], destroy: async () => { destroyed.push(firstPdf); } };
  pending[0].resolve(firstPdf);
  await firstLoad;

  assert.equal(elements["doc-meta"].textContent, "second.pdf");
  assert.ok(elements["recent-docs-list"].innerHTML.indexOf("second.pdf") < elements["recent-docs-list"].innerHTML.indexOf("first.pdf"));
  assert.ok(destroyed.includes(firstPdf));
  assert.ok(destroyed.includes(pending[0].task));
});


test("跨页未完句与下一页小写开头自动合并", () => {
  const { context } = loadViewer();
  const state = { nextId: 0, pending: null };
  const firstPage = [[
    { text: "The", x0: 0, y0: 10, x1: 20, y1: 20 },
    { text: "control-", x0: 24, y0: 10, x1: 80, y1: 20 },
  ]];
  const secondPage = [[
    { text: "ler", x0: 0, y0: 10, x1: 20, y1: 20 },
    { text: "waits.", x0: 24, y0: 10, x1: 70, y1: 20 },
  ]];
  const firstTargets = context.createPageTargets(firstPage, 1, state);
  const secondTargets = context.createPageTargets(secondPage, 2, state);

  assert.equal(secondTargets[0], firstTargets[0]);
  assert.equal(firstTargets[0].text, "The controller waits.");
  assert.equal(firstTargets[0].endPageNum, 2);
  assert.match(firstTargets[0].contextWarnings[0], /自动合并/);
  assert.equal(state.pending, null);
});


test("多栏文本优先遵循 PDF 的原始阅读顺序", () => {
  const { context } = loadViewer();
  const words = [
    { text: "Left one.", x0: 0, y0: 10, x1: 70, y1: 20, itemIndex: 0, hasEOL: true },
    { text: "Left two.", x0: 0, y0: 30, x1: 70, y1: 40, itemIndex: 1, hasEOL: true },
    { text: "Right one.", x0: 200, y0: 10, x1: 280, y1: 20, itemIndex: 2, hasEOL: true },
    { text: "Right two.", x0: 200, y0: 30, x1: 280, y1: 40, itemIndex: 3, hasEOL: true },
  ];
  const texts = context.buildSentences(words).map((sentence) => sentence.map((word) => word.text).join(" "));
  assert.deepEqual(JSON.parse(JSON.stringify(texts)), ["Left one.", "Left two.", "Right one.", "Right two."]);
});


test("句子命中矩形懒计算：挂载用行级回退，精确矩形待空闲升级", () => {
  const { context } = loadViewer();
  const layer = new FakeElement();
  const wrap = new FakeElement();
  const words = [{ text: "The data is sampled.", x0: 0, y0: 10, x1: 100, y1: 20 }];
  const targets = context.wireTextLayer(layer, wrap, [words], words, 1);
  assert.equal(targets.length, 1);
  assert.ok(targets[0].rects.length > 0);
  assert.ok(targets[0].rects[0].top >= 0);
  assert.equal(targets[0].rects[0].left >= 0, true);
});

test("悬停只预览，单击才请求并锁定", () => {
  let fetchCount = 0;
  const { context, elements } = loadViewer(() => {
    fetchCount++;
    return new Promise(() => {});
  });
  const span = wireSentence(context, 1, "The data is sampled.");

  span.emit("mouseenter");
  assert.equal(span.classList.contains("is-preview"), true);
  assert.equal(fetchCount, 0);

  span.emit("click");
  span.emit("mouseleave");
  assert.equal(fetchCount, 1);
  assert.equal(span.classList.contains("is-selected"), true);
  assert.match(elements["analysis-content"].innerHTML, /正在构建逻辑结构/);
});


test("多页选择互不覆盖，旧选中会被清理", () => {
  const { context } = loadViewer(() => new Promise(() => {}));
  const first = wireSentence(context, 1, "First page sentence.");
  const second = wireSentence(context, 2, "Second page sentence.");

  first.emit("click");
  second.emit("mouseenter");
  assert.equal(first.classList.contains("is-selected"), true);
  assert.equal(second.classList.contains("is-preview"), true);

  second.emit("click");
  assert.equal(first.classList.contains("is-selected"), false);
  assert.equal(second.classList.contains("is-selected"), true);
});


test("结构树展示逻辑关系且不拼接重复引导词", () => {
  const { context, elements } = loadViewer();
  const text = "Although the transfer is initiated, the data is not sampled until the arbiter grants ownership.";
  context.renderAnalysisPanel({ pageNum: 2, sentenceIndex: 3, text }, {
    schema_version: 2,
    text,
    engine: "spacy",
    main_clause_id: "c0",
    clauses: [
      { id: "c0", parent_id: null, order: 1, text: "the data is not sampled", start: 0, end: text.length, segments: [[36, 59]], kind: "main", relation: "main", label: "核心命题", marker: "", grammar: { subject: "the data", predicate: "is not sampled", object: "", agent: "", complement: "", voice: "passive", negated: true, modality: "" }, confidence: .96, warnings: [] },
      { id: "c1", parent_id: "c0", order: 0, text: "Although the transfer is initiated", start: 0, end: 34, segments: [[0, 34]], kind: "advcl", relation: "concession", label: "让步背景", marker: "Although", grammar: { subject: "the transfer", predicate: "is initiated", voice: "passive", negated: false }, confidence: .93, warnings: [] },
      { id: "c2", parent_id: "c0", order: 2, text: "until the arbiter grants ownership", start: 60, end: text.length, segments: [[60, text.length - 1]], kind: "advcl", relation: "time", label: "时间关系", marker: "until", grammar: { subject: "the arbiter", predicate: "grants", object: "ownership", voice: "active", negated: false }, confidence: .93, warnings: [] },
    ],
    terms: [],
    translation: null,
    warnings: [],
  });
  const html = elements["analysis-content"].innerHTML;
  assert.match(html, /主句/);
  assert.match(html, /is not sampled/);
  assert.match(html, /让步从句 · Although/);
  assert.match(html, /主句/);
  assert.match(html, /截止从句 · until/);
  assert.match(html, /bracket-group clause-interactive relation-concession/);
  assert.match(html, /bracket-group clause-interactive relation-main[\s\S]*bracket-nested-children[\s\S]*relation-time/);
  assert.match(html, /bracket-focus-card/);
  assert.doesNotMatch(html, /AlthoughAlthough|untiluntil/);
});


test("拖动宽度受边界限制并保存", () => {
  const { context, elements, storage } = loadViewer();
  context.setPanelWidth(900, true);
  assert.equal(elements["panel-resizer"].getAttribute("aria-valuenow"), "620");
  assert.equal(storage.get("parse-spec:panel-width"), "620");
  context.setPanelWidth(100, true);
  assert.equal(elements["panel-resizer"].getAttribute("aria-valuenow"), "340");
});


test("Esc 清除选中并收起分析栏", () => {
  const { context, elements, document } = loadViewer(() => new Promise(() => {}));
  const span = wireSentence(context, 1, "The data is sampled.");
  span.emit("click");
  document.emit("keydown", { key: "Escape" });
  assert.equal(span.classList.contains("is-selected"), false);
  assert.equal(elements.workspace.classList.contains("panel-collapsed"), true);
});


test("窄屏初始收起，选句后打开底部分析面板", () => {
  const { context, elements } = loadViewer(() => new Promise(() => {}), { narrow: true });
  assert.equal(elements.workspace.classList.contains("panel-collapsed"), true);
  const span = wireSentence(context, 1, "The data is sampled.");
  span.emit("click");
  assert.equal(elements.workspace.classList.contains("panel-collapsed"), false);
});


test("较早的异步响应不能覆盖新选句", async () => {
  const pending = [];
  const { context, elements } = loadViewer((_url, options) => {
    const text = JSON.parse(options.body).sentences[0];
    return new Promise((resolve) => pending.push(() => resolve(responseFor(text))));
  });
  const first = wireSentence(context, 1, "First page sentence.");
  const second = wireSentence(context, 2, "Second page sentence.");
  first.emit("click");
  second.emit("click");

  pending[1]();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(elements["analysis-content"].innerHTML, /Second page sentence/);

  pending[0]();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(elements["analysis-content"].innerHTML, /Second page sentence/);
  assert.doesNotMatch(elements["analysis-content"].innerHTML, /First page sentence/);
});


test("无 IntersectionObserver 的回退路径不受挂载上限回收影响", () => {
  const { context } = loadViewer();
  const hook = context.__parseSpecViewerTest;
  assert.equal(hook.hasPageObserver, false);  // 测试环境无 IO，走回退路径
  hook.setMountedPages([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  hook.setVisibleSlots([1, 2, 3]);
  hook.enforceMountedPageLimit();
  // 回退路径必须保留全部已挂载页，否则第 9 页起永久空白
  assert.equal(hook.mountedPageCount, 12);
});


test("有 IntersectionObserver 时按距离回收最远页", () => {
  const { context } = loadViewer();
  const hook = context.__parseSpecViewerTest;
  hook.setPageObserver({ observe() {}, unobserve() {}, disconnect() {} });
  hook.setMountedPages([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  hook.setVisibleSlots([5, 6, 7]);
  hook.enforceMountedPageLimit();
  // 上限 8 页：可见页 5/6/7 必须保留，最远的页 12 被回收
  assert.ok(hook.mountedPageCount <= 8);
  assert.ok(hook.mountedPageNums.includes(5));
  assert.ok(hook.mountedPageNums.includes(6));
  assert.ok(hook.mountedPageNums.includes(7));
  assert.ok(!hook.mountedPageNums.includes(12));
});
