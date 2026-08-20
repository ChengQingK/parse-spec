# Parse-Spec

Parse-Spec 是一个本地离线的英文 SPEC PDF 长难句解析工具。浏览器使用 pdf.js 渲染 PDF 和透明文本层；悬停句子可预览范围，单击后由 Flask 后端调用本地 spaCy 模型构建逻辑分句树，并在持久侧边栏中展示语法主干和技术词释义。

## 功能

- PDF 在浏览器本地读取，不上传文件；后端只接收纯文本句子。
- canvas 保持 PDF 原始显示，透明文本层支持选择、复制、悬停预览和单击选择。
- spaCy `en_core_web_sm` 负责依存解析；模型不可用时自动切换到纯规则解析。
- 内置硬件/协议词典，可通过根目录 `glossary.json` 覆盖或扩展。
- 右侧分析栏展示核心命题及让步、条件、时间、原因、定语等逻辑关系；每个节点可展开查看主谓宾、语态、否定和情态。
- 悬停不请求后端；单击结果按句子缓存，选中状态持久保留。分析栏支持拖动宽度、Esc 收起和窄屏底部抽屉。

## 环境与启动

推荐使用 `uv` 创建项目内的 Python 3.11 环境。首次安装：

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

如果系统默认 `python` 没有安装 Flask，但 `.venv` 已存在，`server.py` 会自动切换到项目环境。VS Code 工作区也应选择 `.venv\Scripts\python.exe`。

浏览器打开 <http://127.0.0.1:5197>，选择本地 PDF 即可。服务只绑定 `127.0.0.1`。

如需重新生成示例 PDF：

```powershell
python make_sample.py
```

## 验证

```powershell
python -m unittest discover -s tests -p "test_*.py" -v
npm test
```

不安装 spaCy 模型也可以运行 Python 测试，此时会覆盖纯规则回退；完整验收应安装仓库中的模型 wheel，再确认 spaCy 路径。

## 架构

```text
本地 PDF
  └─ pdf.js：canvas 渲染 + 透明文本层
       └─ 前端按坐标聚类成行、按标点/段间距切句
            └─ POST /api/analyze（只传句子文本）
                 ├─ spaCy 依存解析 / 纯规则回退
                 └─ 内置词典 + glossary.json 用户覆盖
                      └─ 右侧栏展示逻辑树、主句主干和术语
```

关键文件：

- `server.py`：静态资源与 `/api/analyze` 接口，含输入限制和进程级 LRU 缓存。
- `static/viewer.js`：PDF 渲染、切句、预览/选中状态机和侧边栏树渲染。
- `parse/spacy_parser.py`：spaCy 依存解析、分句建树和逐分句语法提取。
- `parse/clauser.py`：统一树数据结构、规则解析与降级入口。
- `parse/glossary.py`：内置词典与用户词典覆盖。
- `tests/`：Python API/解析测试及前端 Node 回归测试。

## 已知边界

- 切句仍是启发式算法，多栏、表格、页眉页脚可能造成误判。
- 句子目前按单页处理，跨页长句不会自动合并。
- PDF 文本提取中的断词和重复短文本可能影响句子命中映射。
- PDF 正文暂时只做整句高亮；从句字符区间在右侧原句中用于节点联动，不拆分 pdf.js 文本 span。
- Flask 开发服务器仅用于本机，不应绑定到公网地址。

## 前端依赖

运行时直接使用 `static/pdf.min.js` 和 `static/pdf.worker.min.js`，无需前端构建。只有更新 pdf.js 时才需要：

```powershell
npm ci
```

更新后应同步复制 `node_modules/pdfjs-dist/build/` 中对应的压缩文件，并核对哈希。
