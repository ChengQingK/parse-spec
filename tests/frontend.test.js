const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");


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
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
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
    pdfjsLib: { GlobalWorkerOptions: {} },
    document,
    window,
    fetch: fetchImpl,
    getComputedStyle: (element) => ({ getPropertyValue: (name) => element.style.getPropertyValue(name) }),
    setTimeout,
    clearTimeout,
  };
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
  return span;
}


test("示例 PDF 仍切分为 9 句", async () => {
  const { context } = loadViewer();
  const data = new Uint8Array(fs.readFileSync("docs/sample_spec.pdf"));
  const standardFontDataUrl = path.join(
    path.dirname(require.resolve("pdfjs-dist/package.json")),
    "standard_fonts",
  ) + path.sep;
  const pdf = await pdfjs.getDocument({ data, standardFontDataUrl }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1.4 });
  const textContent = await page.getTextContent();
  const words = context.toWords(textContent.items, viewport, 1.4);
  assert.equal(context.buildSentences(words).length, 9);
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
  assert.match(html, /核心命题/);
  assert.match(html, /让步背景/);
  assert.match(html, /时间关系/);
  assert.match(html, /is not sampled/);
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
