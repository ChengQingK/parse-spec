# AGENTS.md

这里是 **parse-spec** —— 一个**本地离线**的英文长难句解析工具：前端用 pdf.js 渲染 SPEC PDF，悬停预览句子范围，单击后调用后端构建逻辑分句树并在持久侧边栏展示。所有注释与 UI 均为中文。

## 运行命令

- 启动服务：`python server.py` → http://127.0.0.1:5197（Flask，仅绑定本地）
- 生成示例 PDF：`python make_sample.py` → 生成 `docs/sample_spec.pdf`
- 初始化环境：`uv venv --python 3.11 .venv`，然后 `uv pip install --python .venv\Scripts\python.exe -r requirements.txt .\vendor\en_core_web_sm-3.8.0-py3-none-any.whl`
- `server.py` 在直接运行且当前解释器缺 Flask 时，会自动切换到已有的项目 `.venv`；没有 `.venv` 则打印上述安装命令。
- 完整自测：`python -m unittest discover -s tests -p "test_*.py" -v`、`npm test`
- 模块冒烟：`python -m parse.clauser`、`python -m parse.glossary`
- 环境：Python 3.11（`list[T]` 下标、`str | None` 联合类型）
- 前端无构建步骤：`pdfjs-dist@2.x` 已 vendor 到 `static/pdf.min.js` 与 `static/pdf.worker.min.js`（与 `package.json` 中 `pdfjs-dist@^2.16.105` 一致，`node_modules/pdfjs-dist` SHA256 已验证相同）

## 解析引擎：spaCy（本地离线）

`parse_sentence` 的实际解析**已由原纯规则引擎替换为 spaCy**（见 `parse/spacy_parser.py`）：

- 使用本地模型 **`en_core_web_sm`（3.8.0）**，wheel 保存在 `vendor/`，可完全离线安装和运行。
- 模型**不在常用 PyPI 镜像上**，不要在初始化时重复下载；直接安装仓库中的 wheel（见 `requirements.txt` 头部注释）。
- `parse/clauser.py` 保留原纯规则逻辑（`segment_clauses`/`structure`）作为**回退**：spaCy 或模型不可用时 `parse_sentence` 自动降级，保证功能不缺失。
- `parse/__init__.py` 中的旧铁律"禁止 spaCy"已随此替换废除，以本文件为准。

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

### 渲染：canvas + 透明文本层（可复制/可选中 + 命中）

- `renderPage`：canvas 绘制正文后，用 `pdfjsLib.renderTextLayer({ textContent, container, viewport, textDivs: [] })` 生成**透明文本层**（`.textLayer`，CSS 中 `color: transparent`）。
- 文本层同时承担**原生文本选择/复制**（`.textLayer ::selection` 高亮）与句子命中（每个 `span` 挂 `mouseenter/mouseleave/click`）。
- 已废弃整页 `.hover-layer/.sent` 覆盖层（会挡住原生文本选择，是"无法复制"的根因），相关 CSS 已从 `style.css` 移除。

### 句子切分（`buildSentences` / `isSentenceEnd`）

- `S = 1.4` 渲染倍率；`toWords` 用 `getTextContent().items` 重建词坐标，按 y 聚类成行（容差 `8*S`）、按 x 排序，再聚合成句子。
- 切句启发式：句末标点之外，新增"行尾 + 与下一行垂直间距 > `fontSize*1.4` + 下一行大写开头"规则，用于标题/段间距（把 `Sample Bus Specification ...` 标题与正文行正确分开，示例 PDF 由误切 17 句变 9 句）。
- 已知局限：启发式对多栏排版、表格、页眉页脚、跨页句子可能误判（见"评估"节）。

### 命中映射（`wireTextLayer`）

- **文本子串匹配优先**：把每行 `span` 文本归一化（去空白）后与 `pageSentTexts` 比对，一行文本是某句的连续子串且唯一命中即归属；把整句的多个 `span` 归入 `pageSentGroups`。
- **坐标兜底**：短行命中多句时，用 `span.getBoundingClientRect()` 的 y 与重建词坐标的行号匹配。
- 注意：textLayer `span` 顶部比 `convertToViewportPoint` 的 y0 高约 13px（基线偏移），**坐标匹配不可靠，文本匹配才是正解**。

### 预览、选中与侧边栏交互

- 悬停只设置 `.is-preview` 浅色高亮，**不请求后端**；单击后设置 `.is-selected` 并调用 `/api/analyze`，结果在右侧栏持久展示。
- `previewTarget` 与 `selectedTarget` 分离；选中不会随鼠标移开消失。切换句子时移除旧选中类，请求序号阻止旧异步响应覆盖新结果。
- 右栏默认 440px，可拖动为 340–620px 并保存到 `localStorage`；窄屏（≤760px）切换为底部抽屉。
- `Esc`、关闭按钮或顶栏收起会清除选中并关闭分析栏；拖选文字时 `hasTextSelection()` 抑制句子选择。
- 树节点悬停时使用后端 `segments` 在右栏原句中精确标记对应片段；PDF 文本层仍保持整句高亮，避免破坏原生复制。

## 核心接口

- `parse/clauser.py` → `parse_sentence(s: str) -> ParsedSentence(text, clauses, main_clause_id, engine, warnings)`。
  - `ClauseNode` 带 `parent_id/order/text/start/end/segments/kind/relation/label/marker/grammar/confidence/warnings`。
  - `Grammar` 带 `subject/predicate/object/agent/complement/voice/negated/modality`。
  - `parse_sentence` 优先走 spaCy，不可用则返回同构的 `rule-fallback` 树。
- `parse/spacy_parser.py` → `parse_spacy(text) -> ParsedSentence | None`；模块级 `_SPACY_OK` 指示模型是否就绪。
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
    "schema_version": 2,
    "text": "...",
    "engine": "spacy",
    "main_clause_id": "c0",
    "clauses": [{
      "id": "c0", "parent_id": null, "relation": "main", "label": "核心命题",
      "text": "...", "start": 0, "end": 20, "segments": [[0, 20]],
      "grammar": { "subject": "...", "predicate": "...", "voice": "active", "negated": false }
    }],
    "terms": [{ "word": "...", "pos": "...", "zh": "...", "note": "..." }],
    "translation": null,
    "warnings": []
  }]
}
```

`translation` 是未来本地翻译适配器的稳定扩展点；未配置模型时必须为 `null`。`terms` 和 `warnings` 可能为空数组。

## 已知坑

- `glossary.json`（用户自定义词典）**现位于项目根目录**，格式 `{ "word": { "pos": ..., "zh": ..., "note": ... } }`；该文件用户可自定义，启动时由 `server.py` 加载，内容优先级高于内置 `BUILTIN`。
- 数据后端的词典命中的"复杂词"由正则 `[A-Za-z]+(?:['-][A-Za-z]+)*` 从句子中抽取，**粒度与 spaCy 分词不一致**（例：`clock.then` 会被当一个词，`don't` 整体命中但词形还原靠去后缀）。
- 前端：坐标匹配受 ~13px 基线偏移影响不可靠（命中用文本子串匹配规避）；句子按"单页"切分，**跨页句子会被截成两段**。

## 变更记录（2026-08）

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

- **职责分离干净**：坐标权威全在前端，后端只做纯文本分析；schema v2 将树结构、语法主干、术语与未来翻译扩展点分开。
- **离线优先**：spaCy 本地模型 + vendor 的 pdf.js，无外部网络依赖，隐私与可用性都好；解析引擎带纯规则回退，健壮。
- **零构建、零部署成本**：单个 Flask 入口 + 静态文件，`python server.py` 即可运行，适合个人本地工具。
- **阅读交互稳定**：透明文本层保留复制；悬停不触发解析，单击结果持久显示，避免浮层遮挡正文或吞掉指针。

### 当前缺陷 / 风险

- **断句是启发式且有单页局限**：依赖"行间距 > 行高 1.4× + 下一行大写"判断标题/段首；对多栏、表格、页眉页脚、行首大写单词的折行易误判；句子按页切分，跨页长句会被硬拆成两段。
- **命中映射对歧义文本敏感**：文本子串匹配在"同一行文本在多句中都出现"或"PDF 提取文本带连字符断词（hyphenation）"时会错配；坐标兜底本身受 ~13px 基线偏移影响，可靠性有限。
- **术语抽取粒度不一致**：后端用正则而非 spaCy tokenize 抽"复杂词"，与前端/词典粒度脱节；`glossary.lookup` 的去后缀还原较粗（不处理不规则变体）。
- **自动化覆盖仍有限**：已有 Python 解析/API 测试和 Node 前端回归测试，覆盖示例 9 句与多页状态隔离；真实浏览器文本选择、跨页句子、多栏/表格仍缺少自动化覆盖。
- **模型边界**：`en_core_web_sm` 对某些高度歧义或省略结构会误标；关系为 `ambiguous` 时 UI 会提示，但置信度是启发式等级，不是统计校准值。
- **性能**：单击才 POST，前端按句子缓存、后端有进程级 LRU；spaCy 对超长句仍是 CPU 密集，目前没有超时取消。
- **运维面**：Flask 无鉴权，若误绑非 localhost 会暴露解析接口；`server.log` 记录了每次请求，长期运行需轮转（次要）。

### 建议的改进方向（按优先级）

1. **扩充测试**：在现有 `tests/` 基础上补真实浏览器文本选择、跨页句子、缩写、引号、多从句、多栏和表格样例。
2. **断句用真实行信息 + 后端判据**：优先利用 pdf.js `TextItem` 的 `hasEOL`/`transform` 判定行与段，必要时把"行尾句号是否真为句界"交给后端 spaCy `sentencizer` 二次确认，降低纯前端启发式误判。
3. **支持跨页句子**：维护跨页缓存（上一页末尾未收尾的行带入下一页合并），或至少在侧边栏中提示"句子可能被分页截断"。
4. **术语抽取对齐 spaCy**：用 `nlp.tokenizer` 输出替代正则，还原用 `token.lemma_`，统一词形与词典键；`glossary.lookup` 增加正则/不规则还原。
5. **翻译与语料扩展**：在 `translation` 扩展点接入本地小模型；先锁定术语，再用本地平行语料检索增强，输出否定/情态/数值一致性警告。
6. **性能**：为超长句增加超时/取消和清晰降级提示；必要时按可见页懒渲染 PDF。
7. **测试扩展**：补真实浏览器文本选择、侧栏拖动、窄屏抽屉以及多栏/表格样例。
