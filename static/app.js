/* 先加载模块版 PDF.js，再启动保持零构建步骤的阅读器脚本。 */
import * as pdfjsLib from "/static/pdf.min.mjs";

globalThis.pdfjsLib = pdfjsLib;
await import("/static/pdf_helpers.js");
await import("/static/viewer.js");
