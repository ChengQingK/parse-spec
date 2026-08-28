/* 先加载模块版 PDF.js，再启动保持零构建步骤的阅读器脚本。
   pdf_helpers 与 pdf.min 并行拉取；viewer_sentences / viewer_marks /
   viewer_pages / viewer_hits / viewer_sidebar 依次注入全局命名空间，
   执行顺序必须先于 viewer。 */
const helpersPromise = import("/static/pdf_helpers.js");
const pdfjs = await import("/static/pdf.min.mjs");

globalThis.pdfjsLib = pdfjs;
await helpersPromise;
await import("/static/viewer_sentences.js");
await import("/static/viewer_marks.js");
await import("/static/viewer_pages.js");
await import("/static/viewer_hits.js");
await import("/static/viewer_sidebar.js");
await import("/static/viewer.js");
