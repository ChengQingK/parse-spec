const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

function loadHelpers() {
  const context = { console, Promise, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync("static/pdf_helpers.js", "utf8"), context);
  return context.__parseSpecPdfHelpers;
}

test("句子标记按真实词坐标覆盖每一行完整范围", () => {
  const { buildSentenceLineRects } = loadHelpers();
  const rects = buildSentenceLineRects([
    { text: "The", x0: 10, x1: 30, y0: 20, y1: 32 },
    { text: "data", x0: 34, x1: 62, y0: 20, y1: 32 },
    { text: "continues", x0: 12, x1: 70, y0: 42, y1: 54 },
    { text: "here.", x0: 74, x1: 102, y0: 42, y1: 54 },
  ], 5);

  assert.equal(rects.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(rects[0])), { left: 9, top: 19, width: 54, height: 14 });
  assert.deepEqual(JSON.parse(JSON.stringify(rects[1])), { left: 11, top: 41, width: 92, height: 14 });
});

test("字符级 DOM Range 不把同一 TextItem 的相邻句子一起高亮", () => {
  const { buildSentenceDomRects, targetAtPoint } = loadHelpers();
  const node = { textContent: "First sentence. Second sentence." };
  const span = { firstChild: node };
  let start = 0;
  let end = 0;
  const rangeFactory = () => ({
    setStart: (_node, value) => { start = value; },
    setEnd: (_node, value) => { end = value; },
    getClientRects: () => [{ left: 10 + start * 5, top: 20, right: 10 + end * 5, bottom: 32 }],
    detach() {},
  });
  const first = [{ itemIndex: 0, charStart: 0, charEnd: 15 }];
  const second = [{ itemIndex: 0, charStart: 16, charEnd: 32 }];
  const firstRects = buildSentenceDomRects(first, [span], { left: 10, top: 10 }, 300, 100, rangeFactory);
  const secondRects = buildSentenceDomRects(second, [span], { left: 10, top: 10 }, 300, 100, rangeFactory);
  assert.deepEqual(JSON.parse(JSON.stringify(firstRects)), [{ left: 0, top: 10, width: 75, height: 12 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(secondRects)), [{ left: 80, top: 10, width: 80, height: 12 }]);
  assert.equal(targetAtPoint([{ id: "first", rects: firstRects }, { id: "second", rects: secondRects }], 77, 15), null);
  assert.equal(targetAtPoint([{ id: "first", rects: firstRects }, { id: "second", rects: secondRects }], 100, 15).id, "second");
});

test("页面缩放后 DOM 字符矩形会还原为页面坐标，避免句子命中错位", () => {
  const { buildSentenceDomRects, targetAtPoint } = loadHelpers();
  const node = { textContent: "First sentence. Second sentence." };
  const span = { firstChild: node };
  let start = 0;
  let end = 0;
  const rangeFactory = () => ({
    setStart: (_node, value) => { start = value; },
    setEnd: (_node, value) => { end = value; },
    getClientRects: () => [{ left: 20 + start * 5.5, top: 42, right: 20 + end * 5.5, bottom: 55.2 }],
    detach() {},
  });
  const second = [{ itemIndex: 0, charStart: 16, charEnd: 32 }];
  const rects = buildSentenceDomRects(second, [span], { left: 20, top: 20 }, 300, 100, rangeFactory, 1.1);
  assert.deepEqual(JSON.parse(JSON.stringify(rects)), [{ left: 80, top: 20, width: 80, height: 12 }]);
  assert.equal(targetAtPoint([{ id: "second", rects }], 100, 25).id, "second");
});

test("PDF 目录支持命名目标和显式页引用", async () => {
  const { resolveOutlinePage, resolvePdfDestination } = loadHelpers();
  const pdf = {
    getDestination: async (name) => name === "intro" ? [{ num: 7 }, { name: "XYZ" }] : null,
    getPageIndex: async (ref) => ref.num === 7 ? 4 : 0,
  };

  assert.equal(await resolveOutlinePage(pdf, "intro"), 5);
  assert.equal(await resolveOutlinePage(pdf, [2, { name: "Fit" }]), 3);
  assert.equal(await resolveOutlinePage(pdf, "missing"), null);
  assert.deepEqual(
    JSON.parse(JSON.stringify(await resolvePdfDestination(pdf, [2, { name: "XYZ" }, 10, 200, null]))),
    { pageNum: 3, kind: "XYZ", args: [10, 200, null], explicit: [2, { name: "XYZ" }, 10, 200, null] },
  );
});

test("DFI SPEC 的原生目录 Link 注解可解析到真实页", async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync("docs/DDR_PHY_Interface_Specification_v5_2.pdf")),
    verbosity: 0,
  });
  const pdf = await loadingTask.promise;
  try {
    const page = await pdf.getPage(5);
    const links = (await page.getAnnotations({ intent: "display" })).filter((item) => item.subtype === "Link" && item.dest);
    assert.ok(links.length >= 20);
    const { resolvePdfDestination } = loadHelpers();
    const target = await resolvePdfDestination(pdf, links[0].dest);
    assert.ok(target && target.pageNum > 5 && target.pageNum <= pdf.numPages);
  } finally {
    await loadingTask.destroy();
  }
});

test("模块启动顺序保证辅助函数先于阅读器加载", () => {
  const app = fs.readFileSync("static/app.js", "utf8");
  const helpers = app.indexOf('/static/pdf_helpers.js');
  const viewer = app.indexOf('/static/viewer.js');
  assert.ok(helpers >= 0);
  assert.ok(viewer > helpers);
  assert.match(fs.readFileSync("static/index.html", "utf8"), /type="module" src="\/static\/app\.js"/);
  const css = fs.readFileSync("static/style.css", "utf8");
  assert.match(css, /--text-scale-factor/);
  assert.match(css, /scaleX\(var\(--scale-x\)\)/);
});

test("pageIndexAtScroll 用二分找到第一个 bottom 超过滚动位置的页", () => {
  const { pageIndexAtScroll } = loadHelpers();
  const tops = [0, 1020, 2040];
  const heights = [1000, 1000, 1000];
  assert.equal(pageIndexAtScroll(tops, heights, 0), 0);
  assert.equal(pageIndexAtScroll(tops, heights, 995, 0), 0);
  assert.equal(pageIndexAtScroll(tops, heights, 995), 1);  // 默认 bias=8 提前翻页
  assert.equal(pageIndexAtScroll(tops, heights, 1010), 1);
  assert.equal(pageIndexAtScroll(tops, heights, 99999), 2);
  assert.equal(pageIndexAtScroll([], [], 100), 0);
});

test("visiblePageRange 返回含 margin 的 1-based 闭区间", () => {
  const { visiblePageRange } = loadHelpers();
  const tops = [0, 1020, 2040, 3060];
  const heights = [1000, 1000, 1000, 1000];
  const roundTrip = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(roundTrip(visiblePageRange(tops, heights, 0, 800, 0)), { start: 1, end: 1 });
  assert.deepEqual(roundTrip(visiblePageRange(tops, heights, 0, 800, 500)), { start: 1, end: 2 });
  assert.deepEqual(roundTrip(visiblePageRange(tops, heights, 2040, 1000, 2000)), { start: 1, end: 4 });
});

test("fitCanvasScale 同时封顶倍率与总像素", () => {
  const { fitCanvasScale } = loadHelpers();
  assert.equal(fitCanvasScale(600, 800, 2.8), 2.8);
  assert.equal(fitCanvasScale(600, 800, 9), 3.2);
  const capped = fitCanvasScale(4000, 4000, 3.2, { maxPixels: 16e6 });
  assert.ok(4000 * capped * (4000 * capped) <= 16e6);
  assert.equal(fitCanvasScale(600, 800, NaN), 1);
});

test("debounce 只保留最后一次调用", () => {
  const { debounce } = loadHelpers();
  const timers = new Map();
  let nextId = 1;
  const fakeTimers = {
    setTimeout: (callback) => { const id = nextId++; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  const calls = [];
  const debounced = debounce((value) => calls.push(value), 150, fakeTimers);
  debounced("a");
  debounced("b");
  debounced("c");
  assert.equal(timers.size, 1);
  for (const callback of [...timers.values()]) callback();
  assert.deepEqual(calls, ["c"]);
});

test("computeFallbackRects 裁剪到页面边界并过滤空矩形", () => {
  const { computeFallbackRects } = loadHelpers();
  const rects = JSON.parse(JSON.stringify(computeFallbackRects([
    { text: "A", x0: -5, x1: 30, y0: 20, y1: 32 },
    { text: "B", x0: 34, x1: 60, y0: 20, y1: 32 },
  ], 5, 100, 80)));
  assert.equal(rects.length, 1);
  assert.equal(rects[0].left, 0);
  assert.ok(rects[0].width <= 100);
  assert.deepEqual(JSON.parse(JSON.stringify(computeFallbackRects([], 5, 100, 80))), []);
});
