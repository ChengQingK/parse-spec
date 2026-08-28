const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFreshViewer } = require('./helpers/browser_sandbox');

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
    this.rect = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  addEventListener(t, cb) { if (!this.listeners.has(t)) this.listeners.set(t, []); this.listeners.get(t).push(cb); }
  emit(t, e = {}) {
    if (this.pointerLayer) {
      if (t === 'mouseenter') return this.pointerLayer.emit('mousemove', { clientX: this.pointerX, clientY: this.pointerY, ...e });
      if (t === 'mouseleave') return this.pointerLayer.emit('mouseleave', e);
      if (t === 'click') return this.pointerLayer.emit('click', { clientX: this.pointerX, clientY: this.pointerY, ...e });
    }
    for (const cb of this.listeners.get(t) || []) cb({ target: this, ...e });
  }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.get(k); }
  querySelectorAll(sel) { return sel === 'span' ? this.spans : []; }
  appendChild() {}
  contains(target) { return target === this; }
  getBoundingClientRect() { return this.rect; }
  setPointerCapture() {}
}

function resultFor(text) {
  return {
    schema_version: 3,
    text,
    engine: 'spacy',
    main_clause_id: 'c0',
    clauses: [
      { id: 'c0', parent_id: null, order: 0, text: 'the data is sampled', start: 0, end: 19, segments: [[0, 19]], relation: 'main', label: '核心命题', grammar: { subject: 'the data', predicate: 'is sampled', voice: 'passive', negated: false }, confidence: .95, warnings: ['main warning'] },
      { id: 'c1', parent_id: 'c0', order: 1, text: 'when ready', start: 20, end: 30, segments: [[20, 30]], relation: 'time', label: '时间关系', grammar: { subject: 'it', predicate: 'is ready', voice: 'active', negated: false }, confidence: .7, warnings: ['child warning'] },
    ],
    terms: [{ word: 'sampled', pos: 'v.', zh: '采样', note: 'technical note' }],
    complex_words: [{ word: 'interfere', lemma: 'interfere', zh: '干扰；妨碍', level: '较难', note: 'reading note' }],
    translation: { text: '数据被 sampled。' },
    warnings: ['global warning'],
  };
}

function loadViewer({ narrow = false, preset = null, legacyBookmarks = null } = {}) {
  const ids = [
    'file','file-empty','pages','placeholder','workspace','analysis-panel','analysis-content','panel-toggle','panel-close','panel-resizer','doc-meta',
    'recent-docs','recent-docs-menu','recent-docs-list','theme-cycle','theme-icon',
    'depth-concise','depth-standard','depth-detailed','structure-bracket','structure-linked',
    'outline-toggle','outline-panel','outline-close','outline-content','bookmark-toggle','bookmark-panel','bookmark-close','bookmark-name','bookmark-add','bookmark-content','nav-resizer','doc',
    'page-status','zoom-out','zoom-reset','zoom-in','panel-source-text','complex-word-toggle','complex-word-dialog','complex-word-close','complex-word-search','complex-word-list','complex-word-form','complex-word-word','complex-word-level','complex-word-zh','complex-word-note','complex-word-message','complex-word-delete','complex-word-info','glossary-toggle','glossary-dialog','glossary-close','glossary-search','glossary-list','glossary-form','glossary-word','glossary-pos','glossary-zh','glossary-note','glossary-message','glossary-delete','glossary-backup-select','glossary-backup-create','glossary-backup-restore','glossary-backup-download','glossary-backup-delete',
  ];
  const els = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  for (const value of ['concise','standard','detailed']) els[`depth-${value}`].dataset.analysisDepth = value;
  for (const value of ['bracket','linked']) els[`structure-${value}`].dataset.structureView = value;
  els['recent-docs-menu'].hidden = true;
  els['outline-panel'].hidden = true;
  els['bookmark-panel'].hidden = true;
  els['complex-word-dialog'].hidden = true;
  const storage = new Map();
  if (preset) storage.set('parse-spec:settings', JSON.stringify(preset));
  if (legacyBookmarks) storage.set('parse-spec:bookmarks', JSON.stringify(legacyBookmarks));
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
  const frameCallbacks = new Map();
  let nextFrameId = 1;
  const window = {
    localStorage: {
      getItem: (k) => storage.get(k) || null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    matchMedia: () => ({ matches: narrow }),
    getSelection: () => ({ toString: () => '' }),
    addEventListener: (t, cb) => { if (!winListeners.has(t)) winListeners.set(t, []); winListeners.get(t).push(cb); },
    requestAnimationFrame: (callback) => { const id = nextFrameId++; frameCallbacks.set(id, callback); return id; },
    cancelAnimationFrame: (id) => frameCallbacks.delete(id),
  };
  const flushAnimationFrames = () => {
    const callbacks = [...frameCallbacks.values()];
    frameCallbacks.clear();
    callbacks.forEach((callback) => callback());
  };
  let fetchCount = 0;
  const projectBookmarks = {};
  const projectComplexWords = {};
  const fetch = async (url, options = {}) => {
    if (String(url).startsWith('/api/bookmarks?')) {
      const documentKey = decodeURIComponent(String(url).split('document_key=')[1] || '');
      return { ok: true, status: 200, json: async () => ({ bookmarks: projectBookmarks[documentKey] || [], user_file: 'bookmarks.json' }) };
    }
    if (url === '/api/bookmarks') {
      const payload = JSON.parse(options.body);
      projectBookmarks[payload.document_key] = payload.bookmarks;
      return { ok: true, status: 200, json: async () => ({ bookmarks: payload.bookmarks, user_file: 'bookmarks.json' }) };
    }
    if (url === '/api/complex-words' && (!options.method || options.method === 'GET')) {
      const entries = [
        { word: 'ensure', zh: '确保', level: '进阶', note: '', source: 'builtin' },
        ...Object.entries(projectComplexWords).map(([word, entry]) => ({ word, ...entry, source: 'custom' })),
      ];
      return { ok: true, status: 200, json: async () => ({ entries, user_file: 'complex_words.json' }) };
    }
    if (String(url).startsWith('/api/complex-words/suggest?')) {
      const word = decodeURIComponent(String(url).split('word=')[1] || '');
      const meanings = { latency: '延迟', intricate: '复杂的；错综的' };
      const zh = meanings[word];
      return zh
        ? { ok: true, status: 200, json: async () => ({ suggestion: { word, lemma: word, zh, level: '较难', note: '自动取自本地术语表', source: 'glossary' } }) }
        : { ok: false, status: 404, json: async () => ({ error: '本地词典暂未收录该单词' }) };
    }
    if (String(url).startsWith('/api/word-info?')) {
      const word = decodeURIComponent(String(url).split('word=')[1] || '');
      if (word === 'latency') {
        return { ok: true, status: 200, json: async () => ({ info: { word, phonetic: '/ˈleɪtənsi/', pos_entries: [{ pos: 'noun', definitions: ['The time delay in a system.'], examples: ['Latency is constrained.'], synonyms: ['delay'] }], collocations: [], source: 'dictionaryapi.dev' } }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: '在线词典暂未收录该单词' }) };
    }
    if (url === '/api/complex-words' && options.method === 'POST') {
      const payload = JSON.parse(options.body);
      projectComplexWords[payload.word] = { zh: payload.zh, level: payload.level, note: payload.note };
      return { ok: true, status: 200, json: async () => ({ entry: { ...payload, source: 'custom' } }) };
    }
    if (url === '/api/complex-words' && options.method === 'DELETE') {
      const payload = JSON.parse(options.body);
      delete projectComplexWords[payload.word];
      return { ok: true, status: 200, json: async () => ({ deleted: payload.word, reverted_to_builtin: payload.word === 'ensure' }) };
    }
    fetchCount++;
    const text = JSON.parse(options.body).sentences[0];
    return { ok: true, status: 200, json: async () => ({ results: [resultFor(text)] }) };
  };
  globalThis.pdfjsLib = { GlobalWorkerOptions: {} };
  globalThis.document = document;
  globalThis.window = window;
  globalThis.fetch = fetch;
  globalThis.getComputedStyle = (el) => ({ getPropertyValue: (name) => el.style.getPropertyValue(name) });
  const instance = createFreshViewer();
  const context = { document, window, fetch, ...instance };
  return { context, els, storage, projectBookmarks, projectComplexWords, flushAnimationFrames, getPendingFrameCount: () => frameCallbacks.size, getFetchCount: () => fetchCount };
}

test('复杂词表可维护，分析原文右击单词会自动填充释义', async () => {
  const { context, els, projectComplexWords } = loadViewer();
  assert.equal(context.wordAtTextOffset('The controller handles intricate timing.', 25), 'intricate');
  context.window.getSelection = () => ({ toString: () => 'latency' });
  context.renderAnalysisPanel({ text: 'Latency is constrained.', pageNum: 1, sentenceIndex: 0 }, resultFor('Latency is constrained.'));
  let prevented = false;
  els['panel-source-text'].emit('contextmenu', { preventDefault: () => { prevented = true; } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(prevented, true);
  assert.equal(els['complex-word-dialog'].hidden, false);
  assert.equal(els['complex-word-word'].value, 'latency');
  assert.equal(els['complex-word-zh'].value, '延迟');
  assert.match(els['complex-word-message'].textContent, /已自动填充/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(els['complex-word-info'].innerHTML, /ˈleɪtənsi/);
  assert.match(els['complex-word-info'].innerHTML, /noun/);
  els['complex-word-level'].value = '较难';
  await context.submitComplexWord({ preventDefault() {} });
  assert.equal(projectComplexWords.latency.zh, '延迟');
  assert.match(els['complex-word-message'].textContent, /已保存/);
});

test('主题位于下栏，分析选项直接位于分析栏', () => {
  const { context, els, storage } = loadViewer();
  context.setTheme('dark');
  assert.equal(context.document.documentElement.dataset.theme, 'dark');
  assert.equal(els['theme-icon'].textContent, '☾');
  assert.match(els['theme-cycle'].getAttribute('aria-label'), /切换为护眼色主题/);
  els['theme-cycle'].emit('click');
  assert.equal(context.document.documentElement.dataset.theme, 'eye');
  assert.match(storage.get('parse-spec:settings'), /"theme":"eye"/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'static', 'index.html'), 'utf8');
  assert.match(html, /class="bottom-bar"/);
  assert.match(html, /class="analysis-toolbar"/);
  assert.doesNotMatch(html, /id="settings-toggle"/);
  assert.doesNotMatch(html, /id="theme-select"/);
});

test('下栏 PDF 缩放先平滑预览再提交布局并持久化', async () => {
  const { context, els, storage } = loadViewer();
  context.setPdfZoom(1.6);
  assert.equal(els.pages.style.transform, 'scale(1.6)');
  assert.equal(els.pages.style.zoom, '1');
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.equal(els.pages.style.zoom, '1.6');
  assert.equal(els.pages.style.transform, '');
  assert.equal(els['zoom-reset'].textContent, '160%');
  assert.equal(storage.get('parse-spec:pdf-zoom'), '1.6');
  context.setPdfZoom(9);
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.equal(els.pages.style.zoom, '2');
  assert.equal(els['zoom-in'].disabled, true);
});

test('译文中的未翻译词点击后原位切换为中文释义', () => {
  const { context } = loadViewer();
  const button = new FakeElement();
  button.dataset.termOriginal = 'interfere';
  button.dataset.termTranslation = '干扰';
  assert.equal(context.toggleTranslationTerm(button), true);
  assert.equal(button.textContent, '干扰');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(context.toggleTranslationTerm(button), false);
  assert.equal(button.textContent, 'interfere');
});

test('最近文档只保存在页面内存，顶栏仅渲染文件名', () => {
  const { context, els, storage } = loadViewer();
  const first = { name: 'first.pdf', size: 10, lastModified: 1 };
  const second = { name: 'second.pdf', size: 20, lastModified: 2 };
  context.rememberRecentDocument(first);
  context.rememberRecentDocument(second);
  context.setDocumentLabel(second, '正在加载 2/216 页');
  assert.equal(els['doc-meta'].textContent, 'second.pdf');
  assert.match(els['doc-meta'].getAttribute('title'), /2\/216/);
  assert.ok(els['recent-docs-list'].innerHTML.indexOf('second.pdf') < els['recent-docs-list'].innerHTML.indexOf('first.pdf'));
  assert.equal([...storage.keys()].some((key) => key.includes('recent')), false);
  context.openRecentDocuments();
  assert.equal(els['recent-docs-menu'].hidden, false);
  assert.equal(els['doc-meta'].getAttribute('aria-expanded'), 'true');
});

test('分析栏固定右侧且只保留宽度调节', () => {
  const { els } = loadViewer();
  const html = fs.readFileSync(path.join(__dirname, '..', 'static', 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'static', 'settings.css'), 'utf8');
  assert.equal(els['panel-resizer'].getAttribute('aria-orientation'), 'vertical');
  assert.doesNotMatch(html, /position-select|data-panel-position/);
  assert.doesNotMatch(css, /data-panel-position|panel-height/);
  assert.match(css, /doc resizer panel/);
});

test('逻辑结构展示方式可切换并持久化', () => {
  const { context, els, storage } = loadViewer();
  const target = { key: '1:0', pageNum: 1, sentenceIndex: 0, text: 'The data is sampled when ready.', spans: [] };
  const result = resultFor(target.text);

  context.setStructureView('linked');
  context.renderAnalysisPanel(target, result);
  assert.equal(els['structure-linked'].getAttribute('aria-pressed'), 'true');
  assert.equal(els['structure-bracket'].getAttribute('aria-pressed'), 'false');
  assert.match(storage.get('parse-spec:settings'), /"structureView":"linked"/);
  assert.match(els['analysis-content'].innerHTML, /逻辑结构 · 原文联动树/);
  assert.match(els['analysis-content'].innerHTML, /linked-source-map/);

  context.setStructureView('bracket');
  context.renderAnalysisPanel(target, result);
  assert.match(els['analysis-content'].innerHTML, /逻辑结构 · 嵌套原文/);
  assert.match(els['analysis-content'].innerHTML, /bracket-structure/);
  assert.match(els['analysis-content'].innerHTML, /bracket-group clause-interactive relation-main/);
  assert.match(els['analysis-content'].innerHTML, /bracket-nested-children/);
  assert.match(els['analysis-content'].innerHTML, /主句/);
  assert.match(els['analysis-content'].innerHTML, /时间从句/);
});

test('分析栏收起后可由顶栏直接恢复', () => {
  const { context, els } = loadViewer();
  context.setPanelCollapsed(true);
  assert.equal(els.workspace.classList.contains('panel-collapsed'), true);
  assert.equal(els['panel-toggle'].disabled, false);
  els['panel-toggle'].emit('click');
  assert.equal(els.workspace.classList.contains('panel-collapsed'), false);
  assert.equal(els['panel-toggle'].getAttribute('aria-expanded'), 'true');
});

test('解析程度三档控制内容密度', () => {
  const { context, els } = loadViewer();
  const target = { key: '1:0', pageNum: 1, sentenceIndex: 0, text: 'The data is sampled when ready.', spans: [] };
  const result = resultFor(target.text);

  context.setAnalysisDepth('concise');
  context.renderAnalysisPanel(target, result);
  assert.match(els['analysis-content'].innerHTML, /核心命题/);
  assert.match(els['analysis-content'].innerHTML, /中文翻译/);
  assert.doesNotMatch(els['analysis-content'].innerHTML, /逻辑结构/);
  assert.doesNotMatch(els['analysis-content'].innerHTML, /section-heading">复杂词/);

  context.setAnalysisDepth('standard');
  context.renderAnalysisPanel(target, result);
  assert.match(els['analysis-content'].innerHTML, /逻辑结构/);
  assert.match(els['analysis-content'].innerHTML, /中文翻译/);
  assert.match(els['analysis-content'].innerHTML, /section-heading">复杂词/);
  assert.match(els['analysis-content'].innerHTML, /interfere/);
  assert.doesNotMatch(els['analysis-content'].innerHTML, /at the rising edge of/);
  assert.match(els['analysis-content'].innerHTML, /translation-term/);
  assert.doesNotMatch(els['analysis-content'].innerHTML, /technical note/);
  assert.doesNotMatch(els['analysis-content'].innerHTML, /高可信/);

  context.setAnalysisDepth('detailed');
  context.renderAnalysisPanel(target, result);
  assert.match(els['analysis-content'].innerHTML, /technical note/);
  assert.match(els['analysis-content'].innerHTML, /高可信/);
  assert.match(els['analysis-content'].innerHTML, /global warning/);
  assert.match(els['analysis-content'].innerHTML, /中文翻译/);
});

test('目录与固定右侧分析栏保持独立', () => {
  const { context, els } = loadViewer({ preset: { theme: 'light', analysisDepth: 'standard' } });
  context.setOutlineOpen(true);
  assert.equal(els['outline-panel'].hidden, false);
  assert.equal(els.workspace.classList.contains('outline-open'), true);
  assert.equal(els.workspace.classList.contains('panel-collapsed'), false);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'static', 'settings.css'), 'utf8'), /outline nav-resizer doc resizer panel/);
});

test('目录宽度可调整、受边界限制并持久化', () => {
  const { context, els, storage } = loadViewer();
  context.setOutlineWidth(900, true);
  assert.equal(els.workspace.style.getPropertyValue('--outline-width'), '520px');
  assert.equal(storage.get('parse-spec:outline-width'), '520');
  context.setOutlineWidth(100, true);
  assert.equal(els.workspace.style.getPropertyValue('--outline-width'), '220px');
});

test('侧栏拖动首个移动事件立即更新浮层，松手后才提交 PDF 网格宽度', () => {
  const { context, els, storage, flushAnimationFrames, getPendingFrameCount } = loadViewer();
  els['analysis-panel'].rect = { left: 840, top: 62, right: 1280, bottom: 720, width: 440, height: 658 };
  els['panel-resizer'].rect = { left: 833, top: 62, right: 840, bottom: 720, width: 7, height: 658 };
  context.startResize({ clientX: 100, clientY: 20, preventDefault() {} });
  context.moveResize({ clientX: 40, clientY: 20 });
  context.moveResize({ clientX: 20, clientY: 20 });
  assert.equal(context.document.documentElement.style.getPropertyValue('--panel-width'), '');
  assert.equal(getPendingFrameCount(), 0);
  assert.equal(els['analysis-panel'].style.width, '520px');
  assert.equal(els['analysis-panel'].style.left, '760px');
  assert.equal(els.workspace.classList.contains('is-live-resizing'), true);
  assert.equal(context.document.body.classList.contains('is-resizing-x'), true);
  context.endResize();
  assert.equal(context.document.documentElement.style.getPropertyValue('--panel-width'), '520px');
  assert.equal(storage.get('parse-spec:panel-width'), '520');
  assert.equal(context.document.body.classList.contains('is-resizing-x'), false);
  flushAnimationFrames();
  flushAnimationFrames();
  assert.equal(els.workspace.classList.contains('is-live-resizing'), false);
  assert.equal(els['analysis-panel'].style.width, '');

  context.setOutlineOpen(true);
  els['outline-panel'].rect = { left: 0, top: 62, right: 300, bottom: 720, width: 300, height: 658 };
  els['nav-resizer'].rect = { left: 300, top: 62, right: 306, bottom: 720, width: 6, height: 658 };
  context.startNavResize({ clientX: 100, preventDefault() {} });
  context.moveNavResize({ clientX: 180 });
  assert.equal(els.workspace.style.getPropertyValue('--outline-width'), '300px');
  assert.equal(getPendingFrameCount(), 0);
  assert.equal(els['outline-panel'].style.width, '380px');
  assert.equal(els['nav-resizer'].style.left, '380px');
  context.endNavResize();
  assert.equal(els.workspace.style.getPropertyValue('--outline-width'), '380px');
  flushAnimationFrames();
  flushAnimationFrames();
  assert.equal(els['outline-panel'].style.width, '');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'static', 'settings.css'), 'utf8'), /\.analysis-panel\.is-live-resizing.*position:fixed!important/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'static', 'settings.css'), 'utf8'), /body\.is-resizing-[xy] \*/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'static', 'style.css'), 'utf8'), /contain:\s*layout paint style/);
});

test('目录与书签共用导航位且书签保存到项目接口', async () => {
  const { context, els, storage, projectBookmarks } = loadViewer();
  context.setOutlineOpen(true);
  context.setBookmarksOpen(true);
  assert.equal(els['outline-panel'].hidden, true);
  assert.equal(els['bookmark-panel'].hidden, false);
  assert.equal(els.workspace.classList.contains('outline-open'), true);

  await context.loadDocumentBookmarks();
  await context.saveDocumentBookmarks([{ id: 'b1', pageNum: 8, sentenceIndex: null, text: '第 8 页', createdAt: '' }]);
  assert.equal(projectBookmarks['no-document'][0].pageNum, 8);
  assert.equal(storage.has('parse-spec:bookmarks'), false);
  assert.equal(context.documentBookmarks()[0].id, 'b1');
});

test('旧浏览器书签会自动迁移到项目接口', async () => {
  const legacy = { 'no-document': [{ id: 'old', pageNum: 3, sentenceIndex: null, text: '第 3 页', createdAt: '' }] };
  const { context, storage, projectBookmarks } = loadViewer({ legacyBookmarks: legacy });
  await context.loadDocumentBookmarks();
  assert.equal(projectBookmarks['no-document'][0].id, 'old');
  assert.equal(storage.has('parse-spec:bookmarks'), false);
});

function wireSentence(context, pageNum, text) {
  const span = new FakeElement();
  span.textContent = text;
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

test('回归：窄屏初始收起，选句后从右侧展开', () => {
  const { context, els } = loadViewer({ narrow: true, preset: { theme: 'light', analysisDepth: 'standard' } });
  assert.equal(els.workspace.classList.contains('panel-collapsed'), true);
  const span = wireSentence(context, 1, 'The data is sampled.');
  span.emit('click');
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
