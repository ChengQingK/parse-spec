const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...v) { v.forEach((x) => this.values.add(x)); }
  remove(...v) { v.forEach((x) => this.values.delete(x)); }
  contains(v) { return this.values.has(v); }
  toggle(v, force) {
    const on = force === undefined ? !this.values.has(v) : !!force;
    if (on) this.values.add(v); else this.values.delete(v);
    return on;
  }
}
class FakeStyle {
  constructor() { this.values = new Map(); }
  setProperty(k, v) { this.values.set(k, v); }
  getPropertyValue(k) { return this.values.get(k) || ''; }
}
class FakeElement {
  constructor() {
    this.textContent = '';
    this.innerHTML = '';
    this.hidden = false;
    this.dataset = {};
    this.style = new FakeStyle();
    this.classList = new FakeClassList();
    this.attributes = new Map();
    this.listeners = new Map();
    this.files = [];
    this.value = '';
    this.disabled = false;
    this.spans = [];
  }
  addEventListener(t, cb) { if (!this.listeners.has(t)) this.listeners.set(t, []); this.listeners.get(t).push(cb); }
  emit(t, e = {}) { for (const cb of this.listeners.get(t) || []) cb({ target: this, ...e }); }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.get(k); }
  querySelectorAll(sel) { return sel === 'span' ? this.spans : []; }
  appendChild() {}
  contains(target) { return target === this; }
  getBoundingClientRect() { return { top: 0, left: 0 }; }
  setPointerCapture() {}
}

function resultFor(text) {
  return {
    schema_version: 2,
    text,
    engine: 'spacy',
    main_clause_id: 'c0',
    clauses: [
      { id: 'c0', parent_id: null, order: 0, text: 'the data is sampled', start: 0, end: 19, segments: [[0, 19]], relation: 'main', label: '核心命题', grammar: { subject: 'the data', predicate: 'is sampled', voice: 'passive', negated: false }, confidence: .95, warnings: ['main warning'] },
      { id: 'c1', parent_id: 'c0', order: 1, text: 'when ready', start: 20, end: 30, segments: [[20, 30]], relation: 'time', label: '时间关系', grammar: { subject: 'it', predicate: 'is ready', voice: 'active', negated: false }, confidence: .7, warnings: ['child warning'] },
    ],
    terms: [{ word: 'sampled', pos: 'v.', zh: '采样', note: 'technical note' }],
    translation: { text: '数据被采样。' },
    warnings: ['global warning'],
  };
}

function loadViewer({ narrow = false, preset = null } = {}) {
  const ids = [
    'file','file-empty','pages','placeholder','workspace','analysis-content','panel-toggle','panel-close','panel-resizer','doc-meta',
    'settings-toggle','settings-popover','settings-close','theme-select','depth-select','position-select','settings-reset',
  ];
  const els = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  els['settings-popover'].hidden = true;
  const storage = new Map();
  if (preset) storage.set('parse-spec:settings', JSON.stringify(preset));
  const documentElement = new FakeElement();
  const body = new FakeElement();
  const docListeners = new Map();
  const document = {
    documentElement,
    body,
    getElementById: (id) => els[id],
    createElement: () => new FakeElement(),
    addEventListener: (t, cb) => { if (!docListeners.has(t)) docListeners.set(t, []); docListeners.get(t).push(cb); },
  };
  const winListeners = new Map();
  const window = {
    localStorage: { getItem: (k) => storage.get(k) || null, setItem: (k, v) => storage.set(k, String(v)) },
    matchMedia: () => ({ matches: narrow }),
    getSelection: () => ({ toString: () => '' }),
    addEventListener: (t, cb) => { if (!winListeners.has(t)) winListeners.set(t, []); winListeners.get(t).push(cb); },
  };
  let fetchCount = 0;
  const fetch = async (_url, options) => {
    fetchCount++;
    const text = JSON.parse(options.body).sentences[0];
    return { ok: true, status: 200, json: async () => ({ results: [resultFor(text)] }) };
  };
  const context = {
    console, Map, Set, Object, JSON, Promise,
    document, window, fetch,
    pdfjsLib: { GlobalWorkerOptions: {} },
    getComputedStyle: (el) => ({ getPropertyValue: (name) => el.style.getPropertyValue(name) }),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'static', 'pdf_helpers.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'static', 'viewer.js'), 'utf8'), context);
  return { context, els, storage, getFetchCount: () => fetchCount };
}

test('主题设置写入 data-theme 并持久化', () => {
  const { context, els, storage } = loadViewer();
  context.setTheme('dark');
  assert.equal(els['theme-select'].value, 'dark');
  assert.equal(context.document.documentElement.dataset.theme, 'dark');
  assert.match(storage.get('parse-spec:settings'), /"theme":"dark"/);
});

test('上下停靠切换为水平分隔条并保存高度', () => {
  const { context, els, storage } = loadViewer();
  context.setPanelPosition('top');
  assert.equal(els.workspace.dataset.panelPosition, 'top');
  assert.equal(els['panel-resizer'].getAttribute('aria-orientation'), 'horizontal');
  context.setPanelHeight(900, true);
  assert.equal(els['panel-resizer'].getAttribute('aria-valuenow'), '560');
  assert.equal(storage.get('parse-spec:panel-height'), '560');
});

test('关闭分析栏时选句不发起后端请求', () => {
  const { context, els, getFetchCount } = loadViewer();
  context.setPanelPosition('off');
  const span = new FakeElement();
  const target = { key: '1:0', pageNum: 1, sentenceIndex: 0, text: 'The data is sampled.', spans: [span] };
  context.selectSentence(target);
  assert.equal(getFetchCount(), 0);
  assert.equal(els.workspace.classList.contains('panel-collapsed'), true);
  assert.equal(els['panel-toggle'].disabled, true);
});

test('解析程度三档控制内容密度', () => {
  const { context, els } = loadViewer();
  const target = { key: '1:0', pageNum: 1, sentenceIndex: 0, text: 'The data is sampled when ready.', spans: [] };
  const result = resultFor(target.text);

  context.setAnalysisDepth('concise');
  context.renderAnalysisPanel(target, result);
  assert.match(els['analysis-content'].innerHTML, /核心命题/);
  assert.doesNotMatch(els['analysis-content'].innerHTML, /逻辑结构/);
  assert.doesNotMatch(els['analysis-content'].innerHTML, /复杂词 \/ 术语/);

  context.setAnalysisDepth('standard');
  context.renderAnalysisPanel(target, result);
  assert.match(els['analysis-content'].innerHTML, /逻辑结构/);
  assert.match(els['analysis-content'].innerHTML, /复杂词 \/ 术语/);
  assert.doesNotMatch(els['analysis-content'].innerHTML, /technical note/);
  assert.doesNotMatch(els['analysis-content'].innerHTML, /高可信/);

  context.setAnalysisDepth('detailed');
  context.renderAnalysisPanel(target, result);
  assert.match(els['analysis-content'].innerHTML, /technical note/);
  assert.match(els['analysis-content'].innerHTML, /高可信/);
  assert.match(els['analysis-content'].innerHTML, /global warning/);
  assert.match(els['analysis-content'].innerHTML, /推荐译文/);
});

function wireSentence(context, pageNum, text) {
  const span = new FakeElement();
  span.textContent = text;
  const layer = new FakeElement();
  layer.spans = [span];
  const wrap = new FakeElement();
  const words = [{ text, x0: 0, y0: 10, x1: 100, y1: 20 }];
  context.wireTextLayer(layer, wrap, [words], words, pageNum);
  return span;
}

test('回归：悬停只预览，单击才解析并锁定', async () => {
  const { context, getFetchCount } = loadViewer();
  const span = wireSentence(context, 1, 'The data is sampled.');
  span.emit('mouseenter');
  assert.equal(span.classList.contains('is-preview'), true);
  assert.equal(getFetchCount(), 0);
  span.emit('click');
  assert.equal(getFetchCount(), 1);
  assert.equal(span.classList.contains('is-selected'), true);
});

test('回归：窄屏初始收起，选句后按设置方向展开', () => {
  const { context, els } = loadViewer({ narrow: true, preset: { theme: 'light', analysisDepth: 'standard', panelPosition: 'left' } });
  assert.equal(els.workspace.classList.contains('panel-collapsed'), true);
  const span = wireSentence(context, 1, 'The data is sampled.');
  span.emit('click');
  assert.equal(els.workspace.dataset.panelPosition, 'left');
  assert.equal(els.workspace.classList.contains('panel-collapsed'), false);
});

test('回归：宽度边界与旧存储键继续兼容', () => {
  const { context, els, storage } = loadViewer();
  context.setPanelWidth(900, true);
  assert.equal(els['panel-resizer'].getAttribute('aria-valuenow'), '620');
  assert.equal(storage.get('parse-spec:panel-width'), '620');
  context.setPanelWidth(100, true);
  assert.equal(els['panel-resizer'].getAttribute('aria-valuenow'), '340');
});
