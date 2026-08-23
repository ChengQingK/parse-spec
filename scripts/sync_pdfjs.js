/* 同步并校验浏览器运行时使用的 PDF.js 文件。 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const files = ["pdf.min.mjs", "pdf.worker.min.mjs"];
const checkOnly = process.argv.includes("--check");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

let mismatch = false;
for (const name of files) {
  const source = path.join(projectRoot, "node_modules", "pdfjs-dist", "build", name);
  const target = path.join(projectRoot, "static", name);
  if (!fs.existsSync(source)) {
    throw new Error(`缺少 ${source}，请先执行 npm ci`);
  }
  if (checkOnly) {
    if (!fs.existsSync(target) || sha256(source) !== sha256(target)) {
      console.error(`${name} 与 node_modules 中的版本不一致`);
      mismatch = true;
    }
  } else {
    fs.copyFileSync(source, target);
    console.log(`${name}  ${sha256(target)}`);
  }
}

if (mismatch) process.exitCode = 1;
