"""解析质检层：对已构建的分句树做确定性"判卷"。

质检只判断"这棵树大概率不合理"，不负责给出正确结构；修复交给
spacy_parser 的候选策略重排序与可选的在线精修。所有信号都是纯本地
规则，高精度优先，避免把又长又合法的简单句误判为可疑。

强信号（任一命中即判可疑）：
- 句中出现句级连接副词（however/therefore…），但分句树上没有对应边界；
- 模型把文本切成多段（多个依存 ROOT）但只产出一个分句；
- 句子含分号却只有一个分句（技术文档中分号几乎总是并列独立分句）；
- 单一分句内含多个"名词主语 + 限定动词"核心。

弱信号（仅累计，不单独判可疑）：
- 主句语法主干缺失（主语或谓语为空）；
- ambiguous 关系分句数量过多。
"""

from __future__ import annotations

import re
from typing import Any

# 句级连接副词 → 逻辑关系；None 表示仅表递进/补充，关系需结合语境确认。
CONJ_ADVERBS: dict[str, str | None] = {
    "however": "concession",
    "nevertheless": "concession",
    "nonetheless": "concession",
    "instead": "concession",
    "still": "concession",
    "therefore": "result",
    "thus": "result",
    "hence": "result",
    "consequently": "result",
    "accordingly": "result",
    "otherwise": "condition",
    "moreover": None,
    "furthermore": None,
    "meanwhile": None,
}

_CONJ_ADVERB_PATTERN = re.compile(
    r"\b(" + "|".join(sorted(CONJ_ADVERBS, key=len, reverse=True)) + r")\b",
    re.IGNORECASE,
)

_FINITE_TAGS = {"VBZ", "VBD", "VBP"}

# 与 spacy_parser._CLAUSE_DEPS 同义的从句依存集合；本模块不导入 spacy_parser 以避免循环依赖。
_SUBORDINATE_DEPS = {"relcl", "advcl", "ccomp", "xcomp", "csubj", "acl"}


def _inside_subordinate_clause(token: Any) -> bool:
    current = token.head
    seen: set[int] = set()
    while current.i not in seen and current.head.i != current.i:
        seen.add(current.i)
        if current.dep_.split(":", 1)[0] in _SUBORDINATE_DEPS:
            return True
        current = current.head
    return False


def assess(text: str, parsed: Any, doc: Any = None) -> dict:
    """返回 {"suspicious": bool, "strong": [...], "weak": [...]}。

    doc 为 spaCy Doc 时启用依存信号（多句根、多主谓核心）；仅传
    text + parsed 时只做词面检查，方便规则回退路径与单元测试复用。
    """
    strong: list[str] = []
    weak: list[str] = []
    clauses = list(parsed.clauses)
    markers = {(clause.marker or "").lower() for clause in clauses}
    relations = {clause.relation for clause in clauses}

    # 句级连接副词没有任何对应分句边界。只认"分句边界位置"的连接副词：
    # 前一个非空字符必须是逗号/分号/冒号——"However, X"（句首语篇副词）、
    # "instead of"（介词）、"or otherwise"（固定搭配）、"is still"（时间副词）
    # 都不满足该位置条件，属于高频误报族，在此一并排除。
    for match in _CONJ_ADVERB_PATTERN.finditer(text or ""):
        lower = match.group(0).lower()
        if lower in markers or CONJ_ADVERBS[lower] in relations:
            continue
        before = (text or "")[: match.start()].rstrip()
        if not before.endswith((",", ";", ":")):
            continue
        strong.append(f"连接副词 “{lower}” 在句中但没有对应的分句边界")
        break

    # 技术文档里分号几乎总是并列独立分句的边界。
    if ";" in (text or "") and len(clauses) <= 1:
        strong.append("句子包含分号但没有拆分出并列分句")

    if doc is not None:
        root_tokens = [token for token in doc if token.dep_ == "ROOT"]
        if len(root_tokens) > 1 and len(clauses) <= 1:
            strong.append(
                f"模型将文本切分为 {len(root_tokens)} 段独立句，但只产出一个分句"
            )

        if len(clauses) <= 1:
            cores = set()
            for token in doc:
                if token.tag_ not in _FINITE_TAGS:
                    continue
                # "=" 等符号偶发被标成动词（Verilog 字面量常见），不能算主谓核心。
                if not token.is_alpha:
                    continue
                # 带 mark（if/when/that…）或祖先链经过从句依存的动词是从句核心，
                # 与"漏拆并列独立分句"无关。
                if any(child.dep_.split(":", 1)[0] == "mark" for child in token.children):
                    continue
                if _inside_subordinate_clause(token):
                    continue
                if not any(
                    child.dep_.split(":", 1)[0] in {"nsubj", "nsubj:pass"}
                    for child in token.children
                ):
                    continue
                cores.add((token.i, token.head.i))
            if len(cores) >= 2:
                strong.append(
                    f"单一分句内检测到 {len(cores)} 个独立主谓核心，疑似漏拆并列分句"
                )

    main = next((clause for clause in clauses if clause.id == parsed.main_clause_id), None)
    if main is not None and main.grammar is not None:
        if not (main.grammar.subject or "").strip() or not (main.grammar.predicate or "").strip():
            weak.append("主句语法主干缺失（主语或谓语为空）")
    if sum(1 for clause in clauses if clause.relation == "ambiguous") >= 2:
        weak.append("关系待确认的分句过多")

    return {"suspicious": bool(strong), "strong": strong, "weak": weak}


def better(a: dict, b: dict) -> bool:
    """候选 b 的质检结果是否严格优于 a；平局保持 a（倾向稳定输出）。"""
    return (len(b["strong"]), len(b["weak"])) < (len(a["strong"]), len(a["weak"]))
