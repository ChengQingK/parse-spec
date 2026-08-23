# Parse-Spec

Parse-Spec 是一个本地离线的英文 SPEC PDF 长难句解析工具。浏览器使用 PDF.js 渲染 PDF、透明文本层和安全链接层；悬停可预览精确句子范围，单击后由 Flask 后端调用本地 spaCy 模型构建逻辑分句树，并在可停靠分析栏中展示中文辅助译文、语法证据和技术词释义。

## 功能

- PDF 在浏览器本地读取，不上传文件；后端只接收选中的纯文本句子。
- canvas 保持 PDF 原始显示，透明文本层支持选择与复制；高亮使用字符级 DOM Range 获取真实字形矩形，不再按整行估算。
- 同一 PDF 文本块包含多个句子时按字符位置命中；不连续文本不会填满中间空白，所有标记裁剪在页面边界内。
- 跨页未完句在“上一页无句末标点、下一页小写续接”等保守条件下自动合并，并提示人工确认。
- spaCy `en_core_web_sm` 负责依存解析；形态信息和技术规则独立复核语态、否定、情态与规范强度，并展示来源一致性。
- 本地结构翻译器结合逻辑分句、技术规则和用户/内置术语表生成完整及逐分句中文辅助译文，全程不联网。
- 术语抽取与 spaCy tokenizer/lemma 对齐；顶栏“术语表”可搜索内置/自定义词条，并将新增或覆盖内容保存到根目录 `glossary.json`，立即用于当前句翻译。
- 分析栏支持左、右、上、下停靠或关闭，宽高可调；下栏左侧图标可循环切换浅色、暗色和护眼主题；设置中提供三档解析密度，逻辑结构可在彩色主从句分组的“嵌套原文”和紧凑的“原文联动树”之间切换。
- 顶栏只显示当前 PDF 文件名；点击文件名可快速切换本次页面会话打开过的最近文档。最近文件对象只保存在页面内存中，刷新或关闭页面后自动清空。
- 目录栏和分析栏支持实时拖动调宽；拖动期间侧栏提升为独立固定层并冻结 PDF 网格，松手时只提交一次最终尺寸，避免长文档因连续重排产生跟手延迟。
- 目录/书签共用可拖动调宽的持久导航栏，可与左侧分析栏并排存在且跳转后不自动关闭；书签可记录页或精确句子，并统一保存到项目根目录 `bookmarks.json`；旧版浏览器书签会按文档自动迁移。PDF 页面自带的内部目录、页码和安全外链也可点击。

## 环境与启动

推荐使用 `uv` 创建项目内的 Python 3.11 环境：

```powershell
uv venv --python 3.11 .venv
uv pip install --python .venv\Scripts\python.exe `
  -r requirements.txt `
  .\vendor\en_core_web_sm-3.8.0-py3-none-any.whl
```

启动本地服务：

```powershell
python server.py
```

如果系统默认 Python 缺少 Flask，但项目 `.venv` 已存在，`server.py` 会自动切换到项目环境。服务默认打开 <http://127.0.0.1:5197>；如果该端口被 Windows 动态保留或已占用，会自动选择 `5800` 等备用端口并打印最终地址。服务始终只绑定 `127.0.0.1`。如需指定端口，可先设置环境变量，例如 `$env:PARSE_SPEC_PORT=6800`。

如需重新生成轻量示例 PDF：

```powershell
python make_sample.py
```

仓库中的 `docs/DDR_PHY_Interface_Specification_v5_2.pdf` 是真实 DFI 回归样本，用于验证目录 Link 注解、复杂文本层和长句解析。

## 验证

Node 测试要求 Node.js 22.13 或更高版本。首次验证先安装开发依赖：

```powershell
npm ci
.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py" -v
npm test
```

`npm test` 会先校验仓库中的 PDF.js 运行文件是否与 `node_modules` 一致，再执行前端回归测试。模块冒烟：

```powershell
.venv\Scripts\python.exe -m parse.clauser
.venv\Scripts\python.exe -m parse.glossary
```

## 架构

```text
本地 PDF
  └─ PDF.js：canvas 渲染 + 透明文本层 + Link 注解层 + 字符级标记层
       ├─ TextItem 原始阅读顺序优先，坐标顺序回退
       ├─ 前端切句、字符命中、跨页保守合并、持久目录与原生链接导航
       ├─ GET/POST /api/bookmarks → 项目根目录 bookmarks.json
       └─ POST /api/analyze（只传句子文本）
            ├─ spaCy 依存 + 形态特征 + 技术规则交叉验证 / 带原因的纯规则降级
            ├─ tokenizer + lemma 术语候选
            ├─ 内置词典 + 自动热重载 glossary.json
            └─ 本地结构辅助翻译
                 └─ 分析栏展示译文、逻辑树、丰富语法、术语与警告
```

关键文件：

- `server.py`：静态资源与 `/api/analyze`、`/api/glossary`、`/api/bookmarks`，含输入限制、安全响应头和原子 JSON 写入。
- `static/app.js`：加载模块版 PDF.js、辅助函数与阅读器。
- `static/viewer.js`：PDF 渲染、切句、跨页状态、选中状态机、目录和分析栏。
- `static/pdf_helpers.js`：无 DOM 依赖的坐标与目录辅助函数。
- `parse/spacy_parser.py`：依存解析、分句建树、逐分句语法与术语 lemma。
- `parse/clauser.py`：统一树数据结构、规则解析与可观察降级入口。
- `parse/glossary.py`：内置词典与用户词典覆盖。
- `parse/translator.py`：完全离线的术语保护、技术短语和逐分句辅助翻译。
- `tests/`：Python API/解析测试和 Node 前端回归测试。

## 已知边界

- 切句仍包含启发式判断；PDF 自身阅读顺序错误、复杂表格、页眉页脚仍可能造成误判。
- 跨页合并采用保守规则，无法覆盖下一页以专有名词或大写缩写续接的全部情况；UI 会提示复核。
- 连字符断词只在跨页且下一页小写续接时自动去除，语义连字符仍需人工确认。
- spaCy 小模型对高度歧义、省略结构和部分规范化表达可能误标；低置信节点应结合原句判断。
- 内置翻译是透明标注的“结构辅助译文”，不是生成式大模型；信号名、规范性措辞和数值仍应以英文原文为准。
- 页面仍会依次完整渲染，但每页间主动让出浏览器事件循环并支持新文档取消；超大 PDF 后续可进一步虚拟化。
- Flask 开发服务器仅用于本机，不应绑定到公网地址。

## PDF.js 维护

运行时直接使用 `static/pdf.min.mjs` 和 `static/pdf.worker.min.mjs`，无前端构建步骤。升级依赖后执行：

```powershell
npm run sync:pdfjs
npm test
```

同步脚本会复制并计算哈希；测试会拒绝依赖包与仓库运行文件不一致的状态。
