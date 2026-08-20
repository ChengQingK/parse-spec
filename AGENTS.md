# AGENTS.md

这里是 **parse-spec** —— 一个**本地离线**的英文长难句解析工具：前端用 pdf.js 渲染 SPEC PDF，悬浮句子时调用后端做断句/成分/词义解析，浮窗展示结果。所有注释与 UI 均为中文。

## 运行命令

- 启动服务：`python server.py` → http://127.0.0.1:5197（Flask，仅绑定本地）
- 生成示例 PDF：`python make_sample.py` → 生成 `docs/sample_spec.pdf`
- 安装依赖：`pip install -r requirements.txt`（依赖记录于 `requirements.txt`：flask / reportlab / spacy；无 venv）
- 模块自测（无测试框架，改动后跑这些）：`python -m parse.clauser`、`python -m parse.glossary`
- 环境：Python 3.11（`list[T]` 下标、`str | None` 联合类型）
- 前端无构建步骤：`pdfjs-dist@2.x` 已 vendor 到 `static/pdf.min.js` 与 `static/pdf.worker.min.js`（与 `package.json` 中 `pdfjs-dist@^2.16.105` 一致，`node_modules/pdfjs-dist` SHA256 已验证相同）

## 解析引擎：spaCy（本地离线）

`parse_sentence` 的实际解析**已由原纯规则引擎替换为 spaCy**（见 `parse/spacy_parser.py`）：

- 使用本地模型 **`en_core_web_sm`（3.8.0）**，已用 pip 安装到当前 Python 环境，完全离线运行。
- 模型**不在 PyPI 镜像上**（阿里/清华均无 `en-core-web-sm`），需从 GitHub Releases 下载 whl 后 `pip install` 本地安装（见 `requirements.txt` 头部注释，GitHub 可用但很慢，约 29KB/s）。
- `parse/clauser.py` 保留原纯规则逻辑（`segment_clauses`/`structure`）作为**回退**：spaCy 或模型不可用时 `parse_sentence` 自动降级，保证功能不缺失。
- `parse/__init__.py` 中的旧铁律"禁止 spaCy"已随此替换废除，以本文件为准。

### spaCy 解析实现要点（`parse/spacy_parser.py`）

- `_clause_spans` / `_merge_spans`：按依存标签 `relcl` / `advcl` / `ccomp` / `xcomp` / `csubj` 找从句的精确字符区间（`left_edge..right_edge`），合并嵌套后切块。
- `_extract_main_verb`：ROOT 动词 + 其 `aux`/`auxpass`（如 `is latched`）；ROOT 是名词时回退到句中第一个动词核心。
- `_extract_subject`：取 nsubj/nsubjpass 名词短语，仅含 `det/amod/compound` 等横向修饰，**不含嵌套从句**。
- 模块间用**延迟导入**（`from .clauser import Chunk`）避免循环依赖，`spacy_parser` 顶层不 import `clauser`。

## 架构与数据流

```
PDF ──(pdf.js 前端)──> 词坐标 ──> 前端聚类成句子 ──POST /api/analyze──> 后端纯文本解析
```

- **坐标权威完全在前端**（pdf.js），后端**从不接触 PDF**，只做纯文本断句/成分/词义。
- **动作原则**：改动可能影响解析逻辑时，在本机用 `python -m parse.clauser` / `python -m parse.glossary` 的自测代码验证，不要假设测试框架存在。

## 前端实现要点（`static/viewer.js` + `static/style.css`，2026-08 更新）

### 渲染：canvas + 透明文本层（可复制/可选中 + 命中）

- `renderPage`：canvas 绘制正文后，用 `pdfjsLib.renderTextLayer({ textContent, container, viewport, textDivs: [] })` 生成**透明文本层**（`.textLayer`，CSS 中 `color: transparent`）。
- 文本层同时承担**原生文本选择/复制**（`.textLayer ::selection` 高亮）与**悬浮命中**（每个 `span` 挂 `mouseenter/mousemove/mouseleave`）。
- 已废弃整页 `.hover-layer/.sent` 覆盖层（会挡住原生文本选择，是"无法复制"的根因），相关 CSS 已从 `style.css` 移除。

### 句子切分（`buildSentences` / `isSentenceEnd`）

- `S = 1.4` 渲染倍率；`toWords` 用 `getTextContent().items` 重建词坐标，按 y 聚类成行（容差 `8*S`）、按 x 排序，再聚合成句子。
- 切句启发式：句末标点之外，新增"行尾 + 与下一行垂直间距 > `fontSize*1.4` + 下一行大写开头"规则，用于标题/段间距（把 `Sample Bus Specification ...` 标题与正文行正确分开，示例 PDF 由误切 17 句变 9 句）。
- 已知局限：启发式对多栏排版、表格、页眉页脚、跨页句子可能误判（见"评估"节）。

### 命中映射（`wireTextLayer`）

- **文本子串匹配优先**：把每行 `span` 文本归一化（去空白）后与 `pageSentTexts` 比对，一行文本是某句的连续子串且唯一命中即归属；把整句的多个 `span` 归入 `pageSentGroups`。
- **坐标兜底**：短行命中多句时，用 `span.getBoundingClientRect()` 的 y 与重建词坐标的行号匹配。
- 注意：textLayer `span` 顶部比 `convertToViewportPoint` 的 y0 高约 13px（基线偏移），**坐标匹配不可靠，文本匹配才是正解**。

### 悬浮与浮窗交互

- 悬停停留 **350ms**（`pendShow` / `fireShow` / `cancelShowDelay`）才弹出浮窗，避免鼠标移动途中浮窗先弹出、吞掉指针导致永远到不了目标句（配 `spanLeave` 的 `movingToTooltip` 判断）。
- `positionTooltip` 使用 **`+12/+8` 小偏移**（贴近光标，修正"偏下一点"的观感）；靠右/下边缘时翻转到光标另一侧并 clamp 回视口；`renderTooltip` 渲染完内容后按 `lastPointer` 重定位一次，避免浮窗长大后被顶到错误位置。
- 浮窗 `pointer-events:auto`、`max-height:70vh` + `overflow-y:auto`（可滚动看长内容）；移入浮窗保持打开（`tooltip mouseenter` → `cancelHide`），移出后 200ms 延迟隐藏（`scheduleHide`）。
- 句子高亮：`currentHoverSpans` 给该句所有 `span` 加 `.hl` 类（`static/style.css` 的 `.textLayer span.hl` 背景高亮）。

## 核心接口

- `parse/clauser.py` → `parse_sentence(s: str) -> ParsedSentence(text, chunks, main_verb, subject_hint)`
  - `Chunk(text, kind, marker, note, main_verb)`；`kind` 取值：`main` / `rel-clause` / `adv-clause` / `noun-clause` / `parenthetical` 等。
  - `parse_sentence` 优先走 spaCy（`spacy_parser.parse_spacy`），不可用则回退到纯规则的 `segment_clauses` / `structure`。
- `parse/spacy_parser.py` → `parse_spacy(text) -> (chunks, main_verb, subject_hint)`；模块级 `_SPACY_OK` 标志指示 spaCy 是否就绪。
- `parse/glossary.py` → `Glossary.lookup(word) -> dict | None`；**未命中返回 `None`**（调用方应做"未收录"兜底）。
  - `BUILTIN` 内置词典 + 可选用户词典 `glossary.json`（用户优先级高）；词形还原靠去后缀兜底，命中时带 `variant: true`。

## API 契约（POST `/api/analyze`）

请求：
```json
{ "sentences": ["sentence 1", "..."] }
```
响应：
```json
{
  "results": [{
    "text": "...",
    "chunks": [{ "text": "...", "kind": "...", "marker": "...", "note": "..." }],
    "main_verb": "...",
    "subject_hint": "...",
    "words": [{ "word": "...", "pos": "...", "zh": "...", "note": "..." }]
  }]
}
```

注意：`chunks` 元素**不包含** `main_verb` 字段（只有 `text/kind/marker/note`）；`words` 可能为空数组。

## 已知坑

- `glossary.json`（用户自定义词典）**现位于项目根目录**，格式 `{ "word": { "pos": ..., "zh": ..., "note": ... } }`；该文件用户可自定义，启动时由 `server.py` 加载，内容优先级高于内置 `BUILTIN`。
- 数据后端的词典命中的"复杂词"由正则 `[A-Za-z]+(?:['-][A-Za-z]+)*` 从句子中抽取，**粒度与 spaCy 分词不一致**（例：`clock.then` 会被当一个词，`don't` 整体命中但词形还原靠去后缀）。
- 前端：坐标匹配受 ~13px 基线偏移影响不可靠（命中用文本子串匹配规避）；句子按"单页"切分，**跨页句子会被截成两段**；`positionTooltip` 在小视口 + 长浮窗时会被 clamp 到顶部，可能与悬浮行重叠（此时滚轮可滚动查看）。

## 变更记录（2026-08）

- 2026-08-19/20：前端交互四项修复（仅改 `static/viewer.js` / `static/style.css`，后端未动）——
  1. 断句：`Sample Bus Specification ...` 标题与 `The write data ...` 正文不再被合并成一个句子（`isSentenceEnd` 增行间距 + 大写启发式）。
  2. 复制：废弃整页覆盖层，改用 pdf.js `renderTextLayer` 透明文本层，PDF 文字可正常选中/复制。
  3. 浮窗偏移：`positionTooltip` 偏移收紧为 `+12/+8`，内容渲染后按光标重定位。
  4. 浮窗交互：可移入、可滚动（`overflow-y:auto` + `max-height:70vh`）、移出 200ms 延迟隐藏；新增 350ms 悬停意图延迟防吞指针。
- 更早：解析引擎替换为 spaCy（见"解析引擎"节）、新增 `requirements.txt`、新增 `glossary.json`、模块自测脚本。

## 项目评估、建议与已知缺陷（维护者注）

以下为本人的实现评估与改进方向，仅作参考，不作为强制要求；改动前请与上文的现状描述对照，避免文档与实现脱节。

### 做得好的地方

- **职责分离干净**：坐标权威全在前端，后端只做纯文本分析，接口契约（`text/chunks/main_verb/subject_hint/words`）稳定且简单。
- **离线优先**：spaCy 本地模型 + vendor 的 pdf.js，无外部网络依赖，隐私与可用性都好；解析引擎带纯规则回退，健壮。
- **零构建、零部署成本**：单个 Flask 入口 + 静态文件，`python server.py` 即可运行，适合个人本地工具。
- **本次四项修复针对性明确**：文本层方案一步解决了"复制"与"命中"两个问题；350ms 意图延迟解决了浮窗"半路拦截鼠标"这类真实交互 bug。

### 当前缺陷 / 风险

- **断句是启发式且有单页局限**：依赖"行间距 > 行高 1.4× + 下一行大写"判断标题/段首；对多栏、表格、页眉页脚、行首大写单词的折行易误判；句子按页切分，跨页长句会被硬拆成两段，浮窗内容不完整。
- **命中映射对歧义文本敏感**：文本子串匹配在"同一行文本在多句中都出现"或"PDF 提取文本带连字符断词（hyphenation）"时会错配；坐标兜底本身受 ~13px 基线偏移影响，可靠性有限。
- **术语抽取粒度不一致**：后端用正则而非 spaCy tokenize 抽"复杂词"，与前端/词典粒度脱节；`glossary.lookup` 的去后缀还原较粗（不处理不规则变体）。
- **无自动化测试**：后端只有模块自测代码，前端完全没有仓库内测试；本次 e2e 用临时脚本（已清理）验证，未沉淀为可重复运行的测试，后续改动回归风险高。
- **交互细节**：拖选文本时会不断触发 `mouseenter`（可加节流/选择态抑制）；浮窗固定 460px 宽，窄窗口无自适应；无 Esc/点击空白关闭浮窗的快捷键。
- **性能**：每次悬浮都 POST `/api/analyze`（前端按句子缓存），无后端进程级缓存；spaCy 对超长句是 CPU 密集，无超时/降级提示。
- **运维面**：Flask 无鉴权，若误绑非 localhost 会暴露解析接口；`server.log` 记录了每次请求，长期运行需轮转（次要）。

### 建议的改进方向（按优先级）

1. **先补测试**：把本次 puppeteer DOM e2e（句子数、复制、浮窗交互断言）沉淀为 `tests/`，并给 `parse_sentence` 加一个轻量 pytest/unittest 样例集（含跨页、缩写、引号、多从句样例）。
2. **断句用真实行信息 + 后端判据**：优先利用 pdf.js `TextItem` 的 `hasEOL`/`transform` 判定行与段，必要时把"行尾句号是否真为句界"交给后端 spaCy `sentencizer` 二次确认，降低纯前端启发式误判。
3. **支持跨页句子**：维护跨页缓存（上一页末尾未收尾的行带入下一页合并），或至少在浮窗中提示"句子可能被分页截断"。
4. **术语抽取对齐 spaCy**：用 `nlp.tokenizer` 输出替代正则，还原用 `token.lemma_`，统一词形与词典键；`glossary.lookup` 增加正则/不规则还原。
5. **交互打磨**：拖选文本时抑制悬浮；浮窗宽度改 `max-width: min(460px, calc(100vw - 32px))`；增加 Esc / 空白处点击关闭。
6. **性能**：后端加进程级 LRU 缓存（键=句子文本），长文本异步 + 前端 loading 态已有；有网络时可选最近邻/分词预取。
7. **文档与工程化**：本文件已更新；可选补充 `README.md`、.gitignore（若将来 git 化），并把 `python -m parse.clauser` 自测沉淀为统一测试入口。