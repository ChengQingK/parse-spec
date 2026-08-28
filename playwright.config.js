/* Playwright e2e 配置：默认走系统 Edge（无需下载浏览器内核）。
 *
 * - 端口：默认 5800（server.py 的首个回退端口——5197 常被 Windows 动态
 *   排除范围拦截）。端口被其他应用占用或被排除时，用
 *   PARSE_SPEC_E2E_PORT 显式指定；若 5800 上已是 parse-spec 实例则会直接复用。
 * - 浏览器：换用 Chrome 设 PARSE_SPEC_BROWSER=chrome；内置 Chromium 需先
 *   `npx playwright install chromium`，再设 PARSE_SPEC_BROWSER=chromium。
 * - Python：PARSE_SPEC_PYTHON 指定启动解释器（默认 python，缺 Flask 时
 *   server.py 会自动切换到项目 .venv）。
 */
"use strict";

const { defineConfig } = require("@playwright/test");

const DEFAULT_PORT = process.env.PARSE_SPEC_E2E_PORT || "5800";

module.exports = defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${DEFAULT_PORT}`,
    channel: process.env.PARSE_SPEC_BROWSER || "msedge",
    viewport: { width: 1440, height: 900 },
    actionTimeout: 10_000,
  },
  webServer: {
    command: `${process.env.PARSE_SPEC_PYTHON || "python"} server.py`,
    url: `http://127.0.0.1:${DEFAULT_PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { ...process.env, PARSE_SPEC_PORT: DEFAULT_PORT },
  },
});
