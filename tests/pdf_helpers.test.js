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

test("PDF 目录支持命名目标和显式页引用", async () => {
  const { resolveOutlinePage } = loadHelpers();
  const pdf = {
    getDestination: async (name) => name === "intro" ? [{ num: 7 }, { name: "XYZ" }] : null,
    getPageIndex: async (ref) => ref.num === 7 ? 4 : 0,
  };

  assert.equal(await resolveOutlinePage(pdf, "intro"), 5);
  assert.equal(await resolveOutlinePage(pdf, [2, { name: "Fit" }]), 3);
  assert.equal(await resolveOutlinePage(pdf, "missing"), null);
});

test("模块启动顺序保证辅助函数先于阅读器加载", () => {
  const app = fs.readFileSync("static/app.js", "utf8");
  const helpers = app.indexOf('/static/pdf_helpers.js');
  const viewer = app.indexOf('/static/viewer.js');
  assert.ok(helpers >= 0);
  assert.ok(viewer > helpers);
  assert.match(fs.readFileSync("static/index.html", "utf8"), /type="module" src="\/static\/app\.js"/);
});
