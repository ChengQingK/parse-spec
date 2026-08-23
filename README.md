# Parse-Spec

Parse-Spec 是一个本地离线的英文 SPEC PDF 长难句解析工具。浏览器使用 PDF.js 渲染 PDF 与透明文本层；悬停可预览句子范围，单击后由 Flask 后端调用本地 spaCy 模型构建逻辑分句树，并在可停靠分析栏中展示语法主干和技术词释义。

## 功能

- PDF 在浏览器本地读取，不上传文件；后端只接收选中的纯文本句子。
- canvas 保持 PDF 原始显示，透明文本层支持选择与复制，独立坐标标记层负责完整句子高亮。
- 同一 PDF 文本块包含多个句子时按指针坐标命中；快速切换文件时会取消并隔离旧加载。
- 跨页未完句在“上一页无句末标点、下一页小写续接”等保守条件下自动合并，并提示人工确认。
- spaCy `en_core_web_sm` 负责依存解析；模型不可用或运行异常时自动切换到纯规则解析并返回原因。
- 术语抽取与 spaCy tokenizer/lemma 对齐；根目录 `glossary.json` 可覆盖或扩展词典，保存后无需重启服务。
- 分析栏支持左、右、上、下停靠或关闭，宽高可调；提供浅色、暗色、护眼主题及三档解析密度。
- 支持 PDF 自带目录导航；悬停不请求后端，单击结果按句子缓存。

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

如果系统默认 Python 缺少 Flask，但项目 `.venv` 已存在，`server.py` 会自动切换到项目环境。浏览器打开 <http://127.0.0.1:5197>，选择本地 PDF 即可。服务只绑定 `127.0.0.1`。

如需重新生成示例 PDF：

```powershell
python make_sample.py
```

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
  └─ PDF.js：canvas 渲染 + 透明文本层 + 坐标标记层
       ├─ TextItem 原始阅读顺序优先，坐标顺序回退
       ├─ 前端切句、坐标命中、跨页保守合并、目录导航
       └─ POST /api/analyze（只传句子文本）
            ├─ spaCy 依存解析 / 带原因的纯规则降级
            ├─ tokenizer + lemma 术语候选
            └─ 内置词典 + 自动热重载 glossary.json
                 └─ 分析栏展示逻辑树、主句主干、术语与警告
```

关键文件：

- `server.py`：静态资源与 `/api/analyze`，含输入限制、请求体上限、安全响应头和进程级 LRU 缓存。
- `static/app.js`：加载模块版 PDF.js、辅助函数与阅读器。
- `static/viewer.js`：PDF 渲染、切句、跨页状态、选中状态机、目录和分析栏。
- `static/pdf_helpers.js`：无 DOM 依赖的坐标与目录辅助函数。
- `parse/spacy_parser.py`：依存解析、分句建树、逐分句语法与术语 lemma。
- `parse/clauser.py`：统一树数据结构、规则解析与可观察降级入口。
- `parse/glossary.py`：内置词典与用户词典覆盖。
- `tests/`：Python API/解析测试和 Node 前端回归测试。

## 已知边界

- 切句仍包含启发式判断；PDF 自身阅读顺序错误、复杂表格、页眉页脚仍可能造成误判。
- 跨页合并采用保守规则，无法覆盖下一页以专有名词或大写缩写续接的全部情况；UI 会提示复核。
- 连字符断词只在跨页且下一页小写续接时自动去除，语义连字符仍需人工确认。
- spaCy 小模型对高度歧义、省略结构和部分规范化表达可能误标；低置信节点应结合原句判断。
- 页面仍会依次完整渲染，但每页间主动让出浏览器事件循环并支持新文档取消；超大 PDF 后续可进一步虚拟化。
- Flask 开发服务器仅用于本机，不应绑定到公网地址。

## PDF.js 维护

运行时直接使用 `static/pdf.min.mjs` 和 `static/pdf.worker.min.mjs`，无前端构建步骤。升级依赖后执行：

```powershell
npm run sync:pdfjs
npm test
```

同步脚本会复制并计算哈希；测试会拒绝依赖包与仓库运行文件不一致的状态。
