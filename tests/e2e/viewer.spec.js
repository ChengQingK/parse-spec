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
  await expect(page.locator("#page-status")).toHaveText("1 / 1");
  // 两阶段管线：canvas 位图 + 透明文本层 + 句子标记层都已挂载
  await expect(page.locator("#pages .page-wrap canvas")).toBeVisible();
  await expect(page.locator("#pages .page-wrap .textLayer span").first()).toBeAttached();
  await expect(page.locator(".sentence-mark-layer .sentence-mark").first()).toBeAttached();
});

test("单击句子经后端解析并在分析栏展示逻辑结构", async ({ page }) => {
  await page.setInputFiles("#file", SAMPLE_PDF);
  await expect(page.locator("#page-status")).toHaveText("1 / 1");

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
  await expect(page.locator("#page-status")).toHaveText("1 / 1");
  await page.locator("#pages .page-wrap .textLayer span").first().click();
  await expect(page.locator("#analysis-content")).toContainText("主句主干");

  await page.keyboard.press("Escape");
  await expect(page.locator("#workspace")).toHaveClass(/panel-collapsed/);
});
