# -*- coding: utf-8 -*-
"""结构翻译的语料层：短语表、用户词表与整句模板。

内置语料面向英文技术规范阅读；用户可在 `data/translation_corpus.json`
中扩展，结构为 {"phrases": {"英文短语": "中文"}, "words": {"英文词": "中文"}}，
用户条目优先于内置。文件按 mtime/大小签名自动重载；损坏或非法条目按整文件
忽略并记录日志，绝不让译文层因语料问题崩溃。
"""

from __future__ import annotations

import json
import logging
import re
import threading
from pathlib import Path
from typing import Any

LOGGER = logging.getLogger(__name__)

CORPUS_FILENAME = "translation_corpus.json"
MAX_ENTRY_CHARS = 200
MAX_ENTRIES = 500

# 技术规范高频短语：整段替换优先于逐词翻译，顺序按长度由长到短匹配。
BUILTIN_PHRASES: dict[str, str] = {
    "do not interfere with signals on the dram interface": "不与 DRAM 接口上的信号发生 interfere",
    "update modes when the dfi bus is placed in an idle state": "DFI 总线处于空闲状态时可用的更新模式",
    "signals on the dram interface": "DRAM 接口上的信号",
    "is placed in an idle state": "处于空闲状态",
    "do not interfere with": "不 interfere",
    "to ensure that": "为 ensure",
    "the dfi bus": "DFI 总线",
    "update modes": "更新模式",
    "the minimum number of additional data clocks": "最少附加数据时钟数",
    "minimum number of additional data clocks": "最少附加数据时钟数",
    "a minimum additional delay": "最小附加延迟",
    "target chip select": "目标片选",
    "timing parameter": "时序参数",
    "required between commands": "命令之间所需的",
    "between commands": "在命令之间",
    "as required by": "按照……的要求",
    "which is driven by the controller": "其由控制器驱动",
    "at the rising edge of the clock": "在时钟上升沿",
    "at the falling edge": "在下降沿",
    "is latched into": "被锁存到",
    "rising edge": "上升沿",
    "falling edge": "下降沿",
    "signals, timing parameters and programmable parameters required to transfer command information and data": "传输命令信息和数据所需的信号、时序参数和可编程参数",
    "signals, timing parameters and programmable parameters": "信号、时序参数和可编程参数",
    "across the dfi and between": "通过 DFI 在",
    "command information and data": "命令信息和数据",
    "as long as": "只要",
    "as soon as": "一旦",
    "even if": "即使",
    "even though": "尽管",
    "in order to": "为了",
    "in order that": "为了",
    "is required to": "必须",
    "are required to": "必须",
    "shall not": "不得",
    "must not": "不得",
    "may not": "可能不允许",
    "so that": "以便",
    "such that": "从而",
    "that defines": "，它定义",
    "is an": "是一种",
    "is a": "是一种",
    "required to transfer": "需要传输",
    "applies to": "适用于",
    "does not encompass": "不涵盖",
    "does not": "不",
    "nor does": "也不",
    "with respect to": "关于",
    # DDR/SDR 数据率术语与其常见搭配（LPDDR 规范高频）
    "single data rate": "单数据速率",
    "double data rate": "双数据速率",
    "split across": "拆分到",
    "sent in the first phase": "在第一个相位发送",
    "sent in the second phase": "在第二个相位发送",
}


def _normalize_identifier(value: str) -> str:
    normalized = re.sub(r"\s+", "_", value.strip())
    return re.sub(r"^t_?phy_", "t_phy_", normalized, flags=re.I)


def _render_timing_parameter_definition(match: re.Match) -> dict[str, Any] | None:
    """DFI 时序参数定义句的双规定模板渲染。"""
    parameter = _normalize_identifier(match.group("parameter"))
    signal = match.group("signal")
    authority = match.group("authority")
    first = f"切换由 {signal} 信号驱动的目标片选时，命令之间所需的最少附加数据时钟数"
    second = f"按照 {authority} 的要求切换目标片选时，命令之间的最小附加延迟"
    return {
        "text": f"{parameter} 时序参数规定了{first}；同时还规定了{second}。",
        "clauses": [
            {"clause_id": "semantic-1", "label": "第一项规定", "text": first + "。"},
            {"clause_id": "semantic-2", "label": "并列规定", "text": second + "。"},
        ],
    }


# 整句模板：语料驱动的“模式 + 渲染”列表，新语料只需追加条目而无需改引擎。
BUILTIN_SENTENCE_TEMPLATES: list[dict[str, Any]] = [
    {
        "name": "dfi-timing-parameter-definition",
        "pattern": re.compile(
            r"^The\s+(?P<parameter>.+?)\s+timing\s+parameter\s+specifies\s+the\s+minimum\s+number\s+of\s+"
            r"additional\s+Data\s+clocks\s+required\s+between\s+commands\s+when\s+changing\s+the\s+target\s+"
            r"chip\s+select\s+driven\s+on\s+the\s+(?P<signal>[A-Za-z0-9_]+)\s+signal\s+and\s+defines\s+a\s+"
            r"minimum\s+additional\s+delay\s+between\s+commands\s+when\s+changing\s+the\s+target\s+chip\s+"
            r"select\s+as\s+required\s+by\s+the\s+(?P<authority>[A-Za-z0-9_]+)\.?$",
            re.I,
        ),
        "render": _render_timing_parameter_definition,
    },
]


def _validate_entries(raw: Any, kind: str) -> dict[str, str]:
    """校验用户语料条目：字符串键值、非空、限长、限量，非法时抛 ValueError。"""
    if not isinstance(raw, dict):
        raise ValueError(f"{kind} 必须是 JSON 对象")
    if len(raw) > MAX_ENTRIES:
        raise ValueError(f"{kind} 条目数不能超过 {MAX_ENTRIES}")
    result: dict[str, str] = {}
    for key, value in raw.items():
        phrase = str(key).strip()
        translation = str(value).strip()
        if not phrase or not translation:
            raise ValueError(f"{kind} 条目不能为空")
        if len(phrase) > MAX_ENTRY_CHARS or len(translation) > MAX_ENTRY_CHARS:
            raise ValueError(f"{kind} 条目过长：{phrase[:40]}")
        result[phrase.lower()] = translation
    return result


class TranslationCorpus:
    """内置语料 + 用户语料文件覆盖；支持按文件签名热重载。"""

    def __init__(self, user_path: str | Path | None = None):
        self.user_path = Path(user_path) if user_path else None
        self._signature: tuple[int, int] | None = None
        self.phrases: dict[str, str] = dict(BUILTIN_PHRASES)
        self.words: dict[str, str] = {}
        self._reload_user()

    def _reload_user(self) -> None:
        self._signature = self._current_signature()
        if self.user_path is None:
            return
        try:
            raw = json.loads(self.user_path.read_text(encoding="utf-8-sig"))
            if not isinstance(raw, dict):
                raise ValueError("语料根节点必须是 JSON 对象")
            phrases = _validate_entries(raw.get("phrases", {}), "phrases")
            words = _validate_entries(raw.get("words", {}), "words")
        except (OSError, ValueError) as exc:
            if not isinstance(exc, FileNotFoundError):
                LOGGER.warning("用户翻译语料加载失败，已忽略 %s：%s", self.user_path, exc)
            return
        # 用户条目优先；内置短语保持兜底
        self.phrases = {**BUILTIN_PHRASES, **phrases}
        self.words = words

    def _current_signature(self) -> tuple[int, int] | None:
        if self.user_path is None or not self.user_path.exists():
            return None
        try:
            stat = self.user_path.stat()
        except OSError:
            return None
        return stat.st_mtime_ns, stat.st_size

    def refresh_if_changed(self) -> bool:
        """文件签名变化时重载用户语料；返回是否发生了重载。"""
        signature = self._current_signature()
        if signature == self._signature:
            return False
        self._reload_user()
        return True

    def sorted_phrases(self) -> list[tuple[str, str]]:
        return sorted(self.phrases.items(), key=lambda item: -len(item[0]))

    def sentence_templates(self) -> list[dict[str, Any]]:
        return BUILTIN_SENTENCE_TEMPLATES


_default_corpus: TranslationCorpus | None = None
_default_lock = threading.Lock()


def default_corpus() -> TranslationCorpus:
    """项目级默认语料：读取 data/ 目录下的可选 translation_corpus.json。"""
    global _default_corpus
    with _default_lock:
        if _default_corpus is None:
            data_dir = Path(__file__).resolve().parent.parent / "data"
            _default_corpus = TranslationCorpus(data_dir / CORPUS_FILENAME)
        else:
            _default_corpus.refresh_if_changed()
        return _default_corpus
