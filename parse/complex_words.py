# -*- coding: utf-8 -*-
"""识别技术文档中较难理解的通用英文单词。

“复杂词”与“术语”分开：前者回答英语阅读难点，后者解释领域概念和信号。
词表只收录本项目常见 SPEC 阅读词，不宣称是官方 CEFR 评级。
"""

from __future__ import annotations

import re
import json
from pathlib import Path
from typing import Any


# level 是面向本工具的阅读难度提示；释义优先表达技术规范中的常见含义。
BUILTIN: dict[str, dict[str, str]] = {
    "acknowledge": {"zh": "确认；应答", "level": "较难", "note": "确认收到请求或信号"},
    "aggregate": {"zh": "汇总；聚合", "level": "较难", "note": "把多个部分合成整体"},
    "arbitrary": {"zh": "任意的", "level": "较难", "note": "不受固定取值或顺序限制"},
    "associated": {"zh": "相关联的", "level": "进阶", "note": "与某对象存在关联"},
    "concurrent": {"zh": "并发的", "level": "较难", "note": "在同一时间段发生"},
    "conflicting": {"zh": "相互冲突的", "level": "进阶", "note": "多个要求不能同时满足"},
    "consecutive": {"zh": "连续的", "level": "进阶", "note": "依次相连且不中断"},
    "determine": {"zh": "确定；决定", "level": "进阶", "note": "根据条件得出结果"},
    "discard": {"zh": "丢弃", "level": "进阶", "note": "放弃不再使用的结果"},
    "ensure": {"zh": "确保", "level": "进阶", "note": "使某个条件或结果得到保证"},
    "facilitate": {"zh": "促进；使更容易", "level": "较难", "note": "帮助某过程顺利进行"},
    "implement": {"zh": "实现", "level": "进阶", "note": "把设计或规则落实为功能"},
    "indicate": {"zh": "表示；指示", "level": "进阶", "note": "通过状态或信号表达含义"},
    "initiate": {"zh": "发起；启动", "level": "进阶", "note": "使操作或协议开始"},
    "interfere": {"zh": "干扰；妨碍", "level": "较难", "note": "对另一过程造成不利影响"},
    "notwithstanding": {"zh": "尽管；不受……影响", "level": "较难", "note": "正式规范中的让步表达"},
    "permitted": {"zh": "被允许的", "level": "进阶", "note": "规范允许某行为发生"},
    "preceding": {"zh": "前面的；先前的", "level": "进阶", "note": "位于当前内容之前"},
    "prevent": {"zh": "防止；阻止", "level": "进阶", "note": "使某事件不能发生"},
    "programmable": {"zh": "可编程的", "level": "较难", "note": "可通过配置改变行为"},
    "regardless": {"zh": "不论；不受影响", "level": "较难", "note": "表示条件不改变结论"},
    "respectively": {"zh": "分别地；依次对应地", "level": "较难", "note": "按前后顺序一一对应"},
    "simultaneously": {"zh": "同时地", "level": "较难", "note": "多个事件在同一时刻发生"},
    "speculative": {"zh": "推测性的", "level": "较难", "note": "在结果确认前预先执行"},
    "subsequent": {"zh": "随后的；后续的", "level": "较难", "note": "发生在当前事件之后"},
    "sufficient": {"zh": "足够的；充分的", "level": "进阶", "note": "达到所需条件或数量"},
    "transmit": {"zh": "传输；发送", "level": "进阶", "note": "把数据或信号送往目标"},
    "violate": {"zh": "违反；违背", "level": "较难", "note": "不满足协议或规则"},
}

# 兼容已有导入；内置表只读，自定义内容写入项目根目录 complex_words.json。
COMPLEX_WORDS = BUILTIN

_WORD = re.compile(r"[A-Za-z][A-Za-z'-]*")


def _simple_lemma(word: str, known_words: set[str] | None = None) -> str:
    lower = word.lower()
    known = known_words or set(BUILTIN)
    if lower in known:
        return lower
    for suffix, replacement in (("ied", "y"), ("ing", ""), ("ed", ""), ("es", ""), ("s", "")):
        if lower.endswith(suffix) and len(lower) > len(suffix) + 3:
            candidate = lower[: -len(suffix)] + replacement
            if candidate in known:
                return candidate
            if candidate + "e" in known:
                return candidate + "e"
    return lower


def lemma_for_word(word: str) -> str:
    """使用已加载的 spaCy 模型归一化单词，失败时采用轻量词形规则。"""
    source = str(word or "").strip()
    if not source:
        return ""
    try:
        from .spacy_parser import _NLP, _SPACY_OK

        if _SPACY_OK and _NLP is not None:
            tokens = [token for token in _NLP(source) if token.is_alpha]
            if len(tokens) == 1 and tokens[0].lemma_:
                return tokens[0].lemma_.lower()
    except Exception:
        pass
    return _simple_lemma(source)


class ComplexWordTable:
    """合并内置复杂词与项目级自定义复杂词。"""

    def __init__(self, user_path: str | Path | None = None):
        self.user_path = Path(user_path) if user_path else None
        self.user: dict[str, dict[str, str]] = {}
        if self.user_path and self.user_path.exists():
            try:
                raw = json.loads(self.user_path.read_text(encoding="utf-8-sig"))
                if isinstance(raw, dict):
                    for raw_word, raw_entry in raw.items():
                        if not isinstance(raw_entry, dict):
                            continue
                        word = str(raw_word).strip().lower()
                        zh = str(raw_entry.get("zh", "")).strip()
                        if word and zh:
                            self.user[word] = {
                                "zh": zh,
                                "level": str(raw_entry.get("level", "较难")).strip() or "较难",
                                "note": str(raw_entry.get("note", "")).strip(),
                            }
            except (OSError, ValueError):
                self.user = {}

    @property
    def known_words(self) -> set[str]:
        return set(BUILTIN) | set(self.user)

    def lookup(self, word: str) -> dict[str, str] | None:
        key = str(word or "").strip().lower()
        entry = self.user.get(key)
        if entry:
            return {**entry, "source": "custom"}
        entry = BUILTIN.get(key)
        return {**entry, "source": "builtin"} if entry else None

    def entries(self) -> list[dict[str, str]]:
        merged = {word: {**entry, "word": word, "source": "builtin"} for word, entry in BUILTIN.items()}
        for word, entry in self.user.items():
            merged[word] = {**entry, "word": word, "source": "custom"}
        return [merged[word] for word in sorted(merged)]


def extract_complex_words(text: str, table: ComplexWordTable | None = None) -> list[dict[str, Any]]:
    """返回单个难词，不把固定词组或带下划线的技术标识符混入。"""
    source = str(text or "")
    if not source:
        return []
    registry = table or ComplexWordTable()
    lemmas: dict[tuple[int, int], str] = {}
    try:
        from .spacy_parser import _NLP, _SPACY_OK

        if _SPACY_OK and _NLP is not None:
            doc = _NLP(source)
            for token in doc:
                if token.is_alpha:
                    lemmas[(token.idx, token.idx + len(token.text))] = token.lemma_.lower()
    except Exception:
        pass

    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for match in _WORD.finditer(source):
        surface = match.group(0)
        lemma = lemmas.get((match.start(), match.end()), _simple_lemma(surface, registry.known_words))
        entry = registry.lookup(lemma) or registry.lookup(surface)
        if not entry or lemma in seen:
            continue
        seen.add(lemma)
        result.append({
            "word": surface,
            "lemma": lemma,
            "zh": entry["zh"],
            "level": entry.get("level", "较难"),
            "note": entry.get("note", ""),
            "source": entry.get("source", "builtin"),
            "start": match.start(),
            "end": match.end(),
        })
    return result[:12]
