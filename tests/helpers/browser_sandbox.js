/* 测试专用：加载仓库 static/ 下的一手浏览器脚本，并按需创建全新阅读器实例。
 *
 * viewer.js 导出的是 createViewer 工厂：每次调用都返回一套全新的模块级状态，
 * 等价于浏览器一次全新页面加载。本文件只使用静态路径 require，不存在任何
 * 把字符串当代码执行的通道（无 eval / vm / 动态拼接路径）。
 */
"use strict";

let loaded = false;

function ensureBrowserScriptsLoaded() {
  if (loaded) return;
  require("../../static/pdf_helpers.js");
  require("../../static/viewer_sentences.js");
  require("../../static/viewer_marks.js");
  require("../../static/viewer_pages.js");
  require("../../static/viewer_hits.js");
  require("../../static/viewer_sidebar.js");
  require("../../static/viewer.js");
  loaded = true;
}

function createFreshViewer() {
  ensureBrowserScriptsLoaded();
  const factory = globalThis.__parseSpecViewerFactory;
  if (typeof factory !== "function") throw new Error("viewer.js 未暴露 createViewer 工厂");
  return factory();
}

module.exports = { createFreshViewer };
