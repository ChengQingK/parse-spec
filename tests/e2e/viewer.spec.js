/* 真实浏览器端到端回归：覆盖文件加载、虚拟化渲染、坐标点击解析与主题切换。
   服务由 playwright.config.js 的 webServer 自动拉起（python server.py）。 */
const { test, expect } = require("@playwright/test");
const path = require("node:path");

const SAMPLE_PDF = path.resolve(__dirname, "..", "..", "docs", "sample_spec.pdf");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#analysis-content")).toContainText("从 PDF 中选择一句话");
});

test("加载示例 PDF 后虚拟化管线完成首页渲染", async ({ page }) => {
  await page.setInputFiles("#file", SAMPLE_PDF);
  await expect(page.locator("#doc-meta")).toContainText("sample_spec.pdf");
  await expect(page.locator("#page-status")).toHaveText("1 / 4");
  // 两阶段管线：canvas 位图 + 透明文本层 + 句子标记层都已挂载
  await expect(page.locator("#pages .page-wrap canvas").first()).toBeVisible();
  await expect(page.locator("#pages .page-wrap .textLayer span").first()).toBeAttached();
  await expect(page.locator(".sentence-mark-layer .sentence-mark").first()).toBeAttached();
});

test("单击句子经后端解析并在分析栏展示逻辑结构", async ({ page }) => {
  await page.setInputFiles("#file", SAMPLE_PDF);
  await expect(page.locator("#page-status")).toHaveText("1 / 4");

  const span = page.locator("#pages .page-wrap .textLayer span").first();
  await span.click();
  await expect(page.locator("#analysis-content")).toContainText("主句主干");
  await expect(page.locator("#analysis-content")).toContainText("逻辑结构");
  // 高亮标记随选中态切换
  await expect(page.locator(".sentence-mark.is-selected, .textLayer .is-selected").first()).toBeAttached();
});

test("主题按钮循环切换且即时生效", async ({ page }) => {
  await page.locator("#theme-cycle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator("#theme-cycle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "eye");
});

test("Esc 关闭弹层并收起分析栏", async ({ page }) => {
  await page.setInputFiles("#file", SAMPLE_PDF);
  await expect(page.locator("#page-status")).toHaveText("1 / 4");
  await page.locator("#pages .page-wrap .textLayer span").first().click();
  await expect(page.locator("#analysis-content")).toContainText("主句主干");

  await page.keyboard.press("Escape");
  await expect(page.locator("#workspace")).toHaveClass(/panel-collapsed/);
});

test("目录跳转在非 100% 缩放下准确落点", async ({ page }) => {
  await page.setInputFiles("#file", SAMPLE_PDF);
  await expect(page.locator("#page-status")).toHaveText("1 / 4");

  // 回归场景：任意非 100% 缩放（用户报告 112% 异常）。按钮步进 100% → 110%。
  await page.locator("#zoom-in").click();
  await expect(page.locator("#zoom-reset")).toHaveText("110%");
  // 等待 120ms 缩放动画提交完成，模拟“缩放稳定后用户再点目录”的真实节奏
  await page.waitForTimeout(300);

  // 通过目录跳到第 3 节（第 3 页），平滑滚动结束后页顶应对齐阅读区顶部
  await page.locator("#outline-toggle").click();
  await page.locator("#outline-panel .outline-item", { hasText: "Write Data and Read Data Signals" }).click();
  await expect.poll(async () => page.evaluate(() => {
    const pane = document.getElementById("doc");
    const target = document.querySelector('.page-wrap[data-page-number="3"]');
    if (!pane || !target) return Number.POSITIVE_INFINITY;
    return Math.abs(target.getBoundingClientRect().top - pane.getBoundingClientRect().top);
  }), { timeout: 5000 }).toBeLessThan(60);
  await expect(page.locator("#page-status")).toHaveText("3 / 4");
});
