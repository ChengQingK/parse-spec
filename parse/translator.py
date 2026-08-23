# -*- coding: utf-8 -*-
"""完全离线的结构辅助翻译器。

它不冒充大模型翻译：优先使用用户/内置术语表，再结合技术规范常见短语、
情态和被动语态规则生成可读中文，并把能力边界随结果返回给 UI。
"""

from __future__ import annotations

import re
from typing import Any


_PHRASES = {
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
}

_WORDS = {
    "a": "", "an": "", "the": "", "this": "该", "that": "该", "these": "这些", "those": "那些",
    "it": "它", "they": "它们", "each": "每个", "all": "所有", "any": "任何", "both": "两者",
    "and": "和", "or": "或者", "but": "但是", "because": "因为", "although": "尽管", "though": "尽管",
    "if": "如果", "unless": "除非", "when": "当", "whenever": "每当", "while": "当", "where": "其中",
    "before": "在……之前", "after": "在……之后", "until": "直到", "once": "一旦", "since": "由于",
    "as": "由于", "than": "比", "which": "其", "who": "其", "whose": "其", "otherwise": "否则",
    "of": "的", "to": "到", "from": "从", "for": "用于", "with": "与", "without": "不带",
    "by": "由", "in": "在", "into": "进入", "on": "在", "at": "在", "between": "在……之间",
    "through": "通过", "during": "在……期间", "within": "在……以内", "outside": "在……之外",
    "is": "", "are": "", "was": "", "were": "", "be": "", "been": "", "being": "",
    "do": "", "does": "", "did": "", "have": "已", "has": "已", "had": "已",
    "shall": "必须", "must": "必须", "may": "可以", "might": "可能", "should": "应当",
    "can": "能够", "could": "能够", "will": "将", "would": "将", "not": "不", "never": "绝不",
    "also": "也", "only": "仅", "then": "然后", "therefore": "因此", "however": "但是",
    "required": "要求", "require": "要求", "requires": "要求", "ignored": "忽略", "ignore": "忽略",
    "updated": "更新", "update": "更新", "performed": "执行", "perform": "执行", "supported": "支持",
    "support": "支持", "enabled": "启用", "enable": "启用", "disabled": "禁用", "disable": "禁用",
    "active": "有效", "inactive": "无效", "available": "可用", "valid": "有效", "invalid": "无效",
    "data": "数据", "write": "写入", "read": "读取", "command": "命令", "mode": "模式",
    "interface": "接口", "signal": "信号", "value": "值", "bit": "位", "field": "字段",
    "resource": "资源", "target": "目标", "source": "源", "destination": "目标", "device": "器件",
    "parameter": "参数", "parameters": "参数", "programmable": "可编程", "timing": "时序",
    "minimum": "最小", "number": "数量", "additional": "附加", "clock": "时钟", "clocks": "时钟",
    "delay": "延迟", "chip": "片", "select": "选择", "driven": "驱动", "specifies": "规定", "specify": "规定",
    "transfer": "传输", "information": "信息", "across": "跨越", "protocol": "协议", "defines": "定义",
    "apply": "适用", "applies": "适用", "encompass": "涵盖", "feature": "功能", "restriction": "限制",
    "corresponding": "对应", "version": "版本", "configuration": "配置", "interoperability": "互操作性",
    "system": "系统", "memory": "存储器", "operation": "操作", "request": "请求", "response": "响应",
    "cycle": "周期", "time": "时间", "state": "状态", "sequence": "序列", "control": "控制",
    "low": "低", "high": "高", "power": "功耗", "calibration": "校准", "background": "后台",
    "changing": "切换", "change": "切换", "between": "在……之间", "sharing": "共享",
    "same": "相同", "different": "不同", "following": "以下", "previous": "前一个", "subsequent": "后续",
    "first": "第一个", "last": "最后一个", "more": "更多", "less": "更少", "other": "其他",
    "true": "真", "false": "假", "set": "设置", "cleared": "清除", "clear": "清除",
    "used": "使用", "use": "使用", "defined": "定义", "define": "定义", "specified": "规定",
    "allows": "允许", "allow": "允许", "prevents": "防止", "prevent": "防止", "contains": "包含",
    "consists": "由……组成", "means": "表示", "indicates": "表示", "indicate": "表示",
}

_TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9_'-]*(?:\[[^\]]+\])?|\d+(?:\.\d+)?|[^\w\s]", re.UNICODE)
_TECHNICAL = re.compile(r"(?:[A-Z]{2,}[A-Za-z0-9_]*|[A-Za-z]+\d+[A-Za-z0-9_]*|[a-z]+_[A-Za-z0-9_]+|t[A-Z][A-Za-z0-9_]*)$")
_TIMING_PARAMETER_DEFINITION = re.compile(
    r"^The\s+(?P<parameter>.+?)\s+timing\s+parameter\s+specifies\s+the\s+minimum\s+number\s+of\s+"
    r"additional\s+Data\s+clocks\s+required\s+between\s+commands\s+when\s+changing\s+the\s+target\s+"
    r"chip\s+select\s+driven\s+on\s+the\s+(?P<signal>[A-Za-z0-9_]+)\s+signal\s+and\s+defines\s+a\s+"
    r"minimum\s+additional\s+delay\s+between\s+commands\s+when\s+changing\s+the\s+target\s+chip\s+"
    r"select\s+as\s+required\s+by\s+the\s+(?P<authority>[A-Za-z0-9_]+)\.?$",
    re.I,
)


def _lemma_candidates(word: str) -> list[str]:
    lower = word.lower()
    result = [lower]
    if lower.endswith("ies") and len(lower) > 4:
        result.append(lower[:-3] + "y")
    if lower.endswith("ied") and len(lower) > 4:
        result.append(lower[:-3] + "y")
    for suffix in ("ing", "ed", "es", "s"):
        if lower.endswith(suffix) and len(lower) > len(suffix) + 2:
            stem = lower[:-len(suffix)]
            result.extend((stem, stem + "e"))
    return list(dict.fromkeys(result))


def _translate_word(token: str, glossary: Any) -> str:
    if _TECHNICAL.fullmatch(token):
        return token
    if token.isdigit() or re.fullmatch(r"\d+(?:\.\d+)?", token):
        return token
    entry = glossary.lookup(token) if glossary is not None else None
    if entry and entry.get("zh"):
        return str(entry["zh"]).split("；", 1)[0].split("/", 1)[0]
    for candidate in _lemma_candidates(token):
        if candidate in _WORDS:
            return _WORDS[candidate]
    return token


def lookup_word_translation(word: str, glossary: Any = None) -> str | None:
    """从本地术语表和结构翻译词库查询单词释义；未命中时明确返回 None。"""
    source = str(word or "").strip()
    if not source:
        return None
    translated = _translate_word(source, glossary)
    if not translated or translated.casefold() == source.casefold():
        return None
    return translated


def _join(tokens: list[str]) -> str:
    result = ""
    for token in tokens:
        if not token:
            continue
        if token in {".", "。"}:
            result = result.rstrip("，；： ") + "。"
        elif token in {",", "，"}:
            result = result.rstrip() + "，"
        elif token in {";", "；"}:
            result = result.rstrip() + "；"
        elif token in {":", "："}:
            result = result.rstrip() + "："
        elif token in {")", "]", "}"}:
            result = result.rstrip() + token
        elif token in {"(", "[", "{"}:
            result += token
        else:
            previous = result[-1] if result else ""
            current = token[0]
            previous_word = previous.isalnum() or previous in "_]"
            current_word = current.isalnum() or current == "_"
            mixed_boundary = previous_word and current_word and (previous.isascii() != current.isascii())
            ascii_boundary = previous_word and current_word and previous.isascii() and current.isascii()
            needs_space = bool(result and (mixed_boundary or ascii_boundary))
            result += (" " if needs_space else "") + token
    return result.strip()


def translate_text(text: str, glossary: Any) -> str:
    protected = text
    phrase_values: dict[str, str] = {}
    for index, (phrase, chinese) in enumerate(sorted(_PHRASES.items(), key=lambda item: -len(item[0]))):
        placeholder = f"PHRASE{index}TOKEN"
        next_text = re.sub(rf"\b{re.escape(phrase)}\b", placeholder, protected, flags=re.I)
        if next_text != protected:
            phrase_values[placeholder] = chinese
            protected = next_text
    translated = []
    for token in _TOKEN.findall(protected):
        translated.append(phrase_values.get(token, _translate_word(token, glossary)))
    result = _join(translated)
    if result and result[-1] not in "。！？":
        result += "。"
    return result


def _normalize_identifier(value: str) -> str:
    normalized = re.sub(r"\s+", "_", value.strip())
    return re.sub(r"^t_?phy_", "t_phy_", normalized, flags=re.I)


def _translate_timing_parameter_definition(text: str) -> dict[str, Any] | None:
    match = _TIMING_PARAMETER_DEFINITION.fullmatch(text.strip())
    if not match:
        return None
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


def translate_sentence(parsed: Any, glossary: Any) -> dict[str, Any]:
    """返回完整译文和逐分句译文，供 schema v3 的分析栏展示。"""
    repaired = _translate_timing_parameter_definition(parsed.text)
    if repaired:
        text = repaired["text"]
        clauses = repaired["clauses"]
    else:
        text = translate_text(parsed.text, glossary)
        clauses = []
        visible = [
            clause for clause in sorted(parsed.clauses, key=lambda item: item.order)
            if clause.id == parsed.main_clause_id or clause.parent_id == parsed.main_clause_id
        ]
        for clause in visible[:4]:
            clauses.append({
                "clause_id": clause.id,
                "label": getattr(clause, "label", "结构片段"),
                "text": translate_text(clause.text, glossary),
            })
    return {
        "text": text,
        "engine": "structured-local",
        "label": "本地结构辅助译文",
        "clauses": clauses,
        "warnings": ["译文由本地术语表和语法规则生成；规范性措辞、数值及信号名请以英文原文为准。"],
    }


if __name__ == "__main__":
    from .glossary import Glossary

    print(translate_text("The controller must not ignore this bit.", Glossary()))
