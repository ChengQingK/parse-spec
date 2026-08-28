# AGENTS.md

这里是 **parse-spec** —— 一个英文长难句解析工具：前端用 pdf.js 渲染 SPEC PDF，悬停预览句子范围，单击后调用后端构建逻辑分句树并在持久侧边栏展示。解析、术语与整句翻译**全程本地离线**；唯一例外是右击单词的词典详情（`/api/word-info`）与复杂词添加的释义兜底（`/api/complex-words/suggest` 第四级）会联网查询在线免费词典，带磁盘缓存与离线降级。所有注释与 UI 均为中文。

## 运行命令

- 启动服务：`python server.py` → 默认 http://127.0.0.1:5197（Flask，仅绑定本地）；端口不可绑定时自动回退到 5800 等备用端口，以终端打印地址为准。指定端口用环境变量，如 `$env:PARSE_SPEC_PORT=6800`。
- 生成示例 PDF：`python make_sample.py` → 生成 `docs/sample_spec.pdf`；`docs/DDR_PHY_Interface_Specification_v5_2.pdf` 是真实 DFI 回归样本，用于验证目录 Link 注解、复杂文本层和长句解析。
- 初始化环境：`uv venv --python 3.11 .venv`，然后 `uv pip install --python .venv\Scripts\python.exe -r requirements.txt .\vendor\en_core_web_sm-3.8.0-py3-none-any.whl`
- `server.py` 在直接运行且当前解释器缺 Flask 时，会自动切换到已有的项目 `.venv`；没有 `.venv` 则打印上述安装命令。
- 完整自测：`.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py" -v`、`npm test`（首次运行前端测试前先 `npm ci` 安装 devDependencies）
- 端到端测试：`npm run test:e2e`（Playwright + 系统 Edge 通道，webServer 自动拉起 `python server.py`；`PARSE_SPEC_BROWSER` / `PARSE_SPEC_E2E_PORT` / `PARSE_SPEC_PYTHON` 可覆盖，默认端口 5800 规避 5197 常见的 Windows 排除范围）
- CI：`.github/workflows/ci.yml` 在 push/PR 时跑 Python 测试（ubuntu + windows）与 `npm test`
- 模块冒烟：`python -m parse.clauser`、`python -m parse.glossary`
- 环境：Python 3.11；前端测试要求 Node.js ≥22.13。
- 前端无构建步骤：`pdfjs-dist@6.2.108` 的模块版运行文件已 vendor 到 `static/pdf.min.mjs` 与 `static/pdf.worker.min.mjs`。升级后运行 `npm run sync:pdfjs`；`npm test` 会先做哈希一致性校验。

## 解析引擎：spaCy（本地离线）

`parse_sentence` 的实际解析**已由原纯规则引擎替换为 spaCy**（见 `parse/spacy_parser.py`）：

- 使用本地模型 **`en_core_web_sm`（3.8.0）**，wheel 保存在 `vendor/`，可完全离线安装和运行。
- 模型**不在常用 PyPI 镜像上**，不要在初始化时重复下载；直接安装仓库中的 wheel（见 `requirements.txt` 头部注释）。
- `parse/clauser.py` 保留原纯规则逻辑（`segment_clauses`/`structure`）作为**回退**：spaCy 或模型不可用时 `parse_sentence` 自动降级；运行异常会写日志并在 `warnings` 中标明异常类型。
- `parse/__init__.py` 中的旧铁律"禁止 spaCy"已随此替换废除，以本文件为准。
- **解析隔离**：`python server.py` 直接运行时经 `parse/spacy_worker.py` 把解析放入持久工作进程，`PARSE_SPEC_PARSE_TIMEOUT`（默认 10s）限时；超时/工作进程崩溃自动降级到规则引擎并在 `warnings` 说明。测试与导入场景保持同步解析路径；`_analyze_sentence` 与 `extract_complex_words` 共享同一次 spaCy 解析（`ParsedSentence.lemma_spans`），不要对同一句子重复调用 `_NLP`。

### spaCy 解析实现要点（`parse/spacy_parser.py`）

- `_clause_roots`：按 `relcl` / `advcl` / `ccomp` / `xcomp` / `csubj` / `acl` 找分句根；`_nearest_clause_parent` 沿依存祖先建立父子关系，嵌套从句不再被合并丢失。
- `_own_tokens` / `_segments`：从节点文本中排除子分句，同时保留精确字符区间；主句允许多个不连续 `segments`。
- `_grammar`：为每个分句独立提取主语、谓语、宾语、被动执行者、补语、语态、否定和情态。
- `_relation`：结合依存标签和连接词映射 `main/concession/condition/time/cause/purpose/result/relative/content/complement/ambiguous`；多义连接词返回警告。
- 模块间使用延迟导入避免循环依赖；`spacy_parser` 顶层不运行时 import `clauser`。

## 架构与数据流

```
PDF ──(pdf.js 前端)──> 词坐标 ──> 前端聚类成句子 ──POST /api/analyze──> 后端纯文本解析
```

- **坐标权威完全在前端**（pdf.js），后端**从不接触 PDF**，只做纯文本断句/成分/词义。
- **动作原则**：改动可能影响解析逻辑时，在本机用 `python -m parse.clauser` / `python -m parse.glossary` 的自测代码验证，不要假设测试框架存在。

## 前端实现要点（`static/viewer.js` + `static/style.css`，2026-08 更新）

### 模块结构：createViewer 工厂 + 命名空间注入（2026-08-29 重构）

- `viewer.js` 全部状态与函数封装在 `createViewer()` 工厂内，模块末尾导出 `globalThis.__parseSpecViewerFactory` 并在浏览器环境（有 document/window）导入时立即创建唯一实例；Node 测试经 `tests/helpers/browser_sandbox.js` 静态 require 工厂、每次调用得到全新实例——**测试基建不允许出现 eval/vm/动态 require**。
- 句子切分纯函数（`S/toWords/buildSentences/跨页合并判定/alignTextDivs/wordAtTextOffset`）在 `viewer_sentences.js`；句子 mark 层与“页码:句序”引用缓存在 `viewer_marks.js`（卸载用 `purgePageMarks`，重开文档用 `clearSentenceMarks`）；**页面虚拟化与挂载管线在 `viewer_pages.js`**——`createPageVirtualizer(deps)` 工厂内聚 `parsePage/mountPageVisual/unmountPage/observer 调度/LRU 回收/渲染并发闸门/页码坐标` 全部可变状态，viewer 侧状态经 refs/hooks 注入（`getLoadSerial/getCurrentPdf/getPdfZoom` 等），重开文档调 `resetVirtualization()`，虚拟化测试钩子由 `pages.testApi` 委托；**命中映射在 `viewer_hits.js`**——`createWireTextLayer(deps)` 返回无状态的 `wireTextLayer`（span 对齐、字符矩形命中、悬停 rAF 节流与点击接线），缩放/选中/预览等依赖注入；**侧栏区块在 `viewer_sidebar.js`**——`createSidebar(deps)` 内聚分析栏渲染、术语/复杂词弹窗 CRUD、面板收起与拖拽调宽（含导航栏浮层拖宽）的可变状态，选中态/请求串号/分析缓存与元素引用经注入，`panelCollapsed` 经 `isPanelCollapsed()` 暴露。
- `app.js` 加载顺序固定：pdf_helpers → viewer_sentences → viewer_marks → viewer_pages → viewer_hits → viewer_sidebar → viewer；`index.html` 的 modulepreload 列表需与之一致。

### 渲染：两阶段管线 + 页面虚拟化（2026-08-27 重构）

- **解析阶段**（`parsePage`，严格页序、可取消）：每页只取 `textContent` → 断句 → `createPageTargets` 并登记 `pageSentenceTargets`，创建定尺寸占位 `.page-wrap`；不做任何视觉渲染。跨页合并依赖页序，必须保持。
- **渲染阶段**（`mountPageVisual`/`unmountPage`）：`IntersectionObserver`（rootMargin 1600px，120ms 沉降）按需挂载 canvas/textLayer/注解层，最多同时挂载 8 页（LRU + 距当前页距离回收），canvas 光栅化并发上限 2。无 IO 的环境（含 Node 测试）回退为全量顺序渲染。
- canvas 位图按 `fitCanvasScale(S × devicePixelRatio × pdfZoom)`（封顶 3.2 倍/1600 万像素）渲染；CSS `zoom` 布局体系不变，缩放提交后仅重渲已挂载页的位图（`rerenderMountedCanvases`），高倍缩放不再模糊。
- 高亮 rect **懒计算**：挂载时只用行级回退矩形（`computeFallbackRects` 纯坐标），字符级精确矩形由 `scheduleExactRectsWarmup`（requestIdleCallback/60ms 回退）升级并重建 mark 层；悬停命中 leading 同步 + rAF trailing 合并；`toggleSentenceMarks` 走 `markElementsByKey` 引用缓存，不再全文档 `querySelectorAll`。
- 页码统计用缓存的未缩放 `pageTops/pageHeights` 数组 + `pageIndexAtScroll` 二分；术语/复杂词搜索 150ms 防抖；词典保存按词失效 `sentenceResults`。
- `static/app.js` 并行拉取 `pdf.min.mjs` 与 `pdf_helpers.js`，随后依次注入 `viewer_sentences.js`、`viewer_marks.js`、`viewer_pages.js`、`viewer_hits.js`、`viewer_sidebar.js` 再加载 `viewer.js`（顺序不可变），`index.html` 有 modulepreload；静态响应带 `Cache-Control: max-age=86400`；`mountPageVisual` 使用 PDF.js 6 的 `TextLayer` 类生成透明文本层。
- 文本层保留原生文本选择/复制；必须保留 PDF.js 6 的 `--total-scale-factor/--text-scale-factor/--font-height/--scale-x` CSS，缺失会导致透明文字宽度和高亮越过页面右侧。
- `.sentence-mark-layer` 使用每个 TextItem 内的字符偏移和 DOM `Range.getClientRects()` 绘制真实字形范围，坐标估算只作为损坏文本层的回退。
- 每页还会读取 Link annotation，生成只支持内部目标、安全 named action 和 HTTP(S) 的 `.annotation-layer`；不得执行 PDF JavaScript。
- 已废弃整页 `.hover-layer/.sent` 覆盖层（会挡住原生文本选择，是"无法复制"的根因），相关 CSS 已从 `style.css` 移除。

### 句子切分（`buildSentences` / `isSentenceEnd`）

- `S = 1.4` 渲染倍率；`toWords` 保留 `TextItem.itemIndex/hasEOL`。切句优先使用 PDF 原始阅读顺序（改善多栏），缺失原始序号时才按 y/x 坐标回退。
- 切句启发式：句末标点之外，新增"行尾 + 与下一行垂直间距 > `fontSize*1.4` + 下一行大写开头"规则，用于标题/段间距（把 `Sample Bus Specification ...` 标题与正文行正确分开，示例 PDF 由误切 17 句变 9 句）。
- 跨页状态会在“上一页无句末标点、下一页小写或连接词续接”等保守条件下合并；跨页断词会去除页尾连字符，并在 UI 中提示复核。

### 命中映射（`wireTextLayer`）

- `alignTextDivs` 必须按 TextItem 和 textLayer span 的实际文本顺序匹配，不能仅按数组下标对齐（marked content/空项会造成整体偏移）。
- 同一个 span 可包含多句；不得给 span 绑定某个固定句子的点击事件，`mousemove/click` 统一按字符矩形落点命中。
- 同一行的不连续字符范围保持多个矩形，不允许用最左/最右坐标填满中间空白。

### 预览、选中与侧边栏交互

- 悬停只设置 `.is-preview` 浅色高亮，**不请求后端**；单击后设置 `.is-selected` 并调用 `/api/analyze`，结果在右侧栏持久展示。
- `previewTarget` 与 `selectedTarget` 分离；选中不会随鼠标移开消失。切换句子时移除旧选中类，请求序号阻止旧异步响应覆盖新结果。
- 分析栏固定在右侧，可收起并保存宽度；目录/书签是左侧独立持久导航栏。窄屏时两种抽屉互斥。
- 分析栏顶部以横向分段按钮直接提供简洁/标准/详细解析密度与两种逻辑结构展示；主题在下栏切换，不保留独立设置弹层。目录跳转后保持打开并标记活动项。
- 下栏显示当前页/总页数和 75%–200% PDF 缩放；`Ctrl` + 滚轮也可缩放。缩放时点击命中坐标按缩放比例还原。
- 书签支持创建时自定义名称及后续重命名，仍统一写入根目录 `bookmarks.json`。
- 术语表支持删除自定义词条；每次修改/删除/恢复前自动备份到 `backups/glossary/`，也支持手动备份、恢复、导出和删除备份；最多保留 30 份。
- “复杂词”指较难理解的单个通用英文单词，由 `parse/complex_words.py` 的内置表与根目录 `complex_words.json` 的用户表共同识别；顶栏复杂词表支持增删改查，分析原文支持右击单词快速添加，并按复杂词表、术语表、本地翻译词典的顺序自动填写释义。不要再把固定词组显示为复杂词。译文中仍为英文且存在释义的词可点击原位切换为中文。
- `Esc`、关闭按钮或顶栏收起会清除选中并关闭分析栏；拖选文字时 `hasTextSelection()` 抑制句子选择。
- 树节点悬停时使用后端 `segments` 在右栏原句中精确标记对应片段；PDF 文本层仍保持整句高亮，避免破坏原生复制。

## 核心接口

- `parse/clauser.py` → `parse_sentence(s: str) -> ParsedSentence(text, clauses, main_clause_id, engine, warnings)`。
  - `ClauseNode` 带 `parent_id/order/text/start/end/segments/kind/relation/label/marker/grammar/confidence/warnings`。
  - `Grammar` 除基础主干外，还带直接/间接宾语、助动词、短语动词、时态/体/语气、规范强度、修饰语、介词短语、并列结构、先行词和多源一致性证据。
- `parse_sentence` 优先走 spaCy，不可用则返回同构的 `rule-fallback` 树；`term_candidates` 是仅供后端词典抽取使用的原词/lemma 对。
- `parse/spacy_parser.py` → `parse_spacy(text) -> ParsedSentence | None`；模块级 `_SPACY_OK` 指示模型是否就绪。
- `parse/glossary.py` → `Glossary.lookup(word) -> dict | None`；**未命中返回 `None`**（调用方应做"未收录"兜底）。
  - `BUILTIN` 内置词典 + 可选用户词典 `glossary.json`（用户优先级高）；服务按 mtime/大小自动热重载并清除旧分析缓存。
- `parse/translator.py` → `translate_sentence(parsed, glossary)`；返回完整和逐分句的本地结构辅助译文，明确附带能力边界警告。

## API 契约（POST `/api/analyze`）

`server.py` 还暴露以下端点（均仅本地、带输入限制、安全响应头和原子 JSON 写入；请求前校验 Host 只接受 `127.0.0.1`/`localhost`/`::1`，阻断 DNS rebinding；单词类参数统一用 `[a-z]+(?:['-][a-z]+)*` 校验）：

- `/api/glossary`：术语表 GET/POST/DELETE，及 `/api/glossary/backups`（备份列表/创建/读取/删除）和 `/api/glossary/restore`（恢复）。
- `/api/complex-words`：复杂词表 GET/POST/DELETE，及 `/api/complex-words/suggest`（添加时按复杂词表→术语表→本地翻译词典顺序建议释义，本地均未命中时再用在线词典的中文释义兜底）。
- `/api/bookmarks`：书签 GET/POST，统一持久化到根目录 `bookmarks.json`。
- `/api/word-info`：在线词典详情（音标/在线中文释义/词性/英文释义/双语例句/同义词/搭配），由 `parse/online_dict.py` 多源查询——默认有道（youdao）优先、dictionaryapi.dev（freeapi）回退，`PARSE_SPEC_DICT_SOURCES` 环境变量可调整顺序；单源网络失败会熔断跳过 30 分钟，避免每次查询都等待超时。2.5s 超时、内存+`word_cache.json` 磁盘正负缓存（命中永久有效、未收录 24h、网络错误 1h TTL）；失败返回 404，前端回退为仅显示本地释义。整句翻译路径不经过此端点。

`POST /api/analyze` 请求：
```json
{ "sentences": ["sentence 1", "..."] }
```
响应：
```json
{
  "results": [{
    "schema_version": 3,
    "text": "...",
    "engine": "spacy",
    "main_clause_id": "c0",
    "clauses": [{
      "id": "c0", "parent_id": null, "relation": "main", "label": "核心命题",
      "text": "...", "start": 0, "end": 20, "segments": [[0, 20]],
      "grammar": { "subject": "...", "predicate": "...", "voice": "active", "negated": false }
    }],
    "terms": [{ "word": "...", "pos": "...", "zh": "...", "note": "..." }],
    "complex_words": [{ "word": "...", "lemma": "...", "zh": "...", "level": "较难" }],
    "translation": { "text": "...", "engine": "structured-local", "clauses": [], "warnings": [] },
    "warnings": []
  }]
}
```

`translation` 由完全离线的结构翻译器生成，属于辅助译文而非生成式模型输出；`terms`、`complex_words` 和 `warnings` 可能为空数组。复杂词由 `parse/complex_words.py` 的内置阅读词表、项目根目录 `complex_words.json` 的用户词表及 spaCy lemma 共同识别。

## 已知坑

- `glossary.json` 位于项目根目录，格式 `{ "word": { "pos": ..., "zh": ..., "note": ... } }`；用户词条优先于 `BUILTIN`，保存后下一次请求自动重载。
- spaCy 路径用 tokenizer 与 lemma 抽取术语；规则降级路径仍依赖正则候选和 `Glossary.lookup` 的轻量后缀还原。
- 跨页合并是保守启发式：下一页以专有名词或大写缩写续接时可能只给出“疑似截断”提示；表格和 PDF 自身错误阅读顺序仍可能误切。
- `/api/word-info` 依赖在线词典（有道 + dictionaryapi.dev）：全部源失败或未收录时详情区显示“在线详情不可用”；解析译文中的中文释义始终来自本地词表，不受网络影响（复杂词添加弹层里的“在线中文”释义除外，会明确标注来源）。`word_cache.json` 是运行期缓存，不提交 Git。
- 页面虚拟化以占位高度估算滚动位置，极端变高页的滚动锚点在挂载/卸载瞬间可能有轻微偏移；`page.cleanup()` 后重渲依赖 pdf.js 重新解析，超大页重渲仍有成本。

## 变更记录（2026-08）

- 2026-08-29：全面工程化整改（源自全面分析报告的 8 项路线）——①消除热路径双重 spaCy 解析（`ParsedSentence.lemma_spans` 透传给复杂词识别）；②`bookmarks/glossary/complex_words` 三份用户数据 JSON 出库并加入 `.gitignore`；③新增 GitHub Actions CI（Python 双平台 + npm test）；④新增 `parse/spacy_worker.py` 隔离工作进程，`PARSE_SPEC_PARSE_TIMEOUT` 限时、超时自动降级规则引擎；⑤`viewer.js` 重构为 `createViewer` 工厂并拆分出 `viewer_sentences.js`/`viewer_marks.js`/`viewer_pages.js`/`viewer_hits.js`/`viewer_sidebar.js`（虚拟化管线状态内聚、命中映射与侧栏依赖注入），Node 测试基建移除全部 vm 动态执行（新 `tests/helpers/browser_sandbox.js`）；⑥修复 `wireTextLayer` 高倍缩放下歧义 span 判别失准；⑦翻译层语料化：新增 `parse/translation_corpus.py`（内置短语/模板列表 + 可选用户 `translation_corpus.json`，签名热重载并清除分析缓存），`translator.py` 改为消费语料层的纯引擎；⑧新增 Playwright e2e（`npm run test:e2e`，真实浏览器覆盖加载/点击解析/主题/Esc）。另：`online_dict` 增加 https + 预期词典主机校验与重定向守卫，缓存写合并；`server.py` 增加 Host 白名单；单词校验收紧；词典模块日志统一；CI YAML 经 js-yaml 结构校验。测试数 51（Python）+ 46（Node）+ 4（e2e）。
- 2026-08-28：在线词典多源化——`parse/online_dict.py` 从单一 dictionaryapi.dev 改为多源查询：有道（youdao jsonapi）优先、dictionaryapi.dev 回退，单源网络失败熔断跳过 30 分钟，`PARSE_SPEC_DICT_SOURCES` 可调顺序；响应新增在线中文释义（`zh_gloss`）与双语例句（`examples`）字段并在词详情区展示。`/api/complex-words/suggest` 在本地三级源均未命中时，用在线中文释义（去词性前缀）兜底自动填表。背景：dictionaryapi.dev 在境内长期直连超时，导致右击词典详情几乎总是 404。
- 2026-08-27：性能与词典增强——渲染改为两阶段管线（解析占位 + IO 驱动可见页虚拟化，LRU 8 页、光栅并发 2）；高亮 rect 懒计算 + 悬停 rAF 节流 + mark 引用缓存；缩放提交按 DPR 重渲可见页位图；页码二分统计；搜索防抖；缓存按词失效；modulepreload + 静态 Cache-Control。新增 `/api/word-info`（`parse/online_dict.py`）：右击单词在复杂词弹层展示音标/词性/英文释义/例句/同义词/搭配，dictionaryapi.dev + 磁盘正负缓存 + 离线降级；中文释义仍全部来自本地词表。
- 2026-08-23：全面优化——PDF.js 由存在安全公告的 2.x 升级到 6.2.108 模块版并加入同步/哈希校验；修复连续打开 PDF 的竞态和单 span 多句无法命中；目录由猴子补丁改为显式模块；增加跨页保守合并、多栏原始阅读顺序、词典热重载、lemma 术语、解析异常可观测性、请求体上限与安全响应头；同步中文 UI、文档和回归测试。
- 2026-08-20：新增主题、三档解析密度、分析栏五种位置、完整句子坐标标记和 PDF 目录导航。
- 2026-08-20：从内容悬浮窗重构为持久分析侧栏——悬停仅预览、单击解析并锁定；新增可拖动右栏/窄屏底部抽屉、逻辑分句树、逐分句 grammar、精确字符 segments、API schema v2、规则同构降级和对应回归测试。旧 tooltip 交互已删除。
- 2026-08-19/20：前端交互四项修复（仅改 `static/viewer.js` / `static/style.css`，后端未动）——
  1. 断句：`Sample Bus Specification ...` 标题与 `The write data ...` 正文不再被合并成一个句子（`isSentenceEnd` 增行间距 + 大写启发式）。
  2. 复制：废弃整页覆盖层，改用 pdf.js `renderTextLayer` 透明文本层，PDF 文字可正常选中/复制。
  3. 浮窗偏移：`positionTooltip` 偏移收紧为 `+12/+8`，内容渲染后按光标重定位。
  4. 浮窗交互：可移入、可滚动（`overflow-y:auto` + `max-height:70vh`）、移出 200ms 延迟隐藏；新增 350ms 悬停意图延迟防吞指针。
- 2026-08-20：仓库可维护性整理——恢复 `parse/*.py` / `requirements.txt` 为可执行纯文本；模型 wheel 移入 `vendor/`；新增 README、`.gitignore`、Python/Node 回归测试；多页悬停改为页面级状态，异步响应加入过期保护；API 增加输入校验和 LRU 缓存。
- 更早：解析引擎替换为 spaCy（见"解析引擎"节）、新增 `requirements.txt`、新增 `glossary.json`、模块自测脚本。

## 项目评估、建议与已知缺陷（维护者注）

以下为本人的实现评估与改进方向，仅作参考，不作为强制要求；改动前请与上文的现状描述对照，避免文档与实现脱节。

### 做得好的地方

- **职责分离干净**：坐标权威全在前端，后端只做纯文本分析；schema v3 将树结构、丰富语法、术语和本地译文分开。
- **离线优先**：spaCy 本地模型 + vendor 的 pdf.js，无外部网络依赖，隐私与可用性都好；解析引擎带纯规则回退，健壮。
- **零构建、零部署成本**：单个 Flask 入口 + 静态文件，`python server.py` 即可运行，适合个人本地工具。
- **阅读交互稳定**：透明文本层保留复制；悬停不触发解析，单击结果持久显示，避免浮层遮挡正文或吞掉指针。

### 当前缺陷 / 风险

- **断句仍是启发式**：已使用 `TextItem` 原始顺序、`hasEOL`、段间距和跨页状态，但复杂表格、页眉页脚及 PDF 自身错误阅读顺序仍会误判。
- **跨页规则偏保守**：能处理小写续接和跨页断词，但下一页以专有名词/大写缩写续接时不会自动合并，只会提示疑似截断。
- **模型边界**：`en_core_web_sm` 对高度歧义或省略结构仍可能误标；`confidence` 是启发式等级，不是统计校准值。
- **翻译边界**：当前是术语表和语法规则驱动的结构辅助译文；复杂修辞和领域外词汇可能保留英文。
- **超大文档性能**：已做可见页虚拟化（最多挂载 8 页）；更极端的千页文档仍可进一步优化占位与解析吞吐。
- **解析超时**：spaCy 超长句仍是 CPU 密集任务，目前只有输入长度/请求体限制，没有进程级硬超时。
- **真实浏览器自动化**：本轮已人工完成真实浏览器冒烟，但仓库测试仍以 Node 模拟 DOM 为主，尚未引入 Playwright 端到端套件。

### 建议的改进方向（按优先级）

1. **真实浏览器回归**：加入 Playwright 端到端测试，覆盖文件选择、复制、坐标点击、目录、侧栏拖动和窄屏布局。
2. ~~超大 PDF 虚拟化~~（2026-08-27 已完成：可见页挂载 + LRU 回收 + 懒 rect）。
3. **解析隔离与超时**：把 spaCy 调用放入可取消的工作进程，为超长句提供明确降级提示。
4. **复杂版面语料**：补真实多栏、表格、页眉页脚和跨页大写续接 PDF，用样本驱动而非继续堆叠无数据启发式。
5. **翻译模型扩展**：在现有 `structured-local` 适配器之后增加可选本地小模型，同时保留术语、否定、情态和数值一致性校验。
