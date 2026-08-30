# -*- coding: utf-8 -*-
"""完全离线的结构辅助翻译引擎。

它不冒充大模型翻译：语料层（translation_corpus）提供短语表、用户词表与
整句模板，引擎负责术语表优先、占位替换、中英文边界与能力边界警告。
"""

from __future__ import annotations

import re
from typing import Any

from .translation_corpus import TranslationCorpus, default_corpus


# 通用功能词与内容词：翻译引擎的基础词汇，领域语料见 translation_corpus。
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
    # 缩写整体保留为一个 token 后在此翻译；i.e. = that is（即），e.g. = for example（例如）
    "i.e.": "即", "e.g.": "例如", "etc": "等等", "etc.": "等等",
    "lower": "低", "upper": "高", "sent": "发送", "send": "发送", "sends": "发送",
    "single": "单个", "rate": "速率", "width": "宽度", "bus": "总线", "phase": "相位",
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
    "changing": "切换", "change": "切换", "sharing": "共享",
    "same": "相同", "different": "不同", "following": "以下", "previous": "前一个", "subsequent": "后续",
    "first": "第一个", "last": "最后一个", "more": "更多", "less": "更少", "other": "其他",
    "true": "真", "false": "假", "set": "设置", "cleared": "清除", "clear": "清除",
    "used": "使用", "use": "使用", "defined": "定义", "define": "定义", "specified": "规定",
    "allows": "允许", "allow": "允许", "prevents": "防止", "prevent": "防止", "contains": "包含",
    "consists": "由……组成", "means": "表示", "indicates": "表示", "indicate": "表示",
    # 系动词补“是”：等式句（X is Y）逐词直译缺系动词会读不通
    "is": "是", "are": "是", "was": "是", "were": "是",
}

# token 顺序敏感：带点缩写与“数字+字母”复合词必须先于通用词形匹配，
# 否则 i.e. 被切碎成 i/./e/. 且 2N 被拆成 2/N（间距与术语识别都会出错）。
_TOKEN = re.compile(
    r"[A-Za-z]\.(?:[A-Za-z]\.)+"                      # i.e. / e.g.
    r"|[A-Za-z][A-Za-z0-9_'-]*(?:\[[^\]]+\])?"
    r"|\d+(?:\.\d+)?[A-Za-z]*"                        # 2N / 7bit / 011b
    r"|[^\w\s]",
    re.UNICODE,
)
_POSSESSIVE = re.compile(r"([A-Za-z][A-Za-z0-9_]*)(?:['’]s)")
_TECHNICAL = re.compile(r"(?:[A-Z]{2,}[A-Za-z0-9_]*|[A-Za-z]+\d+[A-Za-z0-9_]*|[a-z]+_[A-Za-z0-9_]+|t[A-Z][A-Za-z0-9_]*)$")


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


def _translate_word(token: str, glossary: Any, corpus: TranslationCorpus | None = None) -> str:
    if _TECHNICAL.fullmatch(token):
        return token
    possessive = _POSSESSIVE.fullmatch(token)
    if possessive:
        # “DRAM's” → “DRAM 的”：所有格拆出基词翻译，技术名保持原文
        return f"{_translate_word(possessive.group(1), glossary, corpus)} 的"
    if token.isdigit() or re.fullmatch(r"\d+(?:\.\d+)?[A-Za-z]*", token):
        return token
    entry = glossary.lookup(token) if glossary is not None else None
    if entry and entry.get("zh"):
        return str(entry["zh"]).split("；", 1)[0].split("/", 1)[0]
    user_words = corpus.words if corpus is not None else {}
    for candidate in _lemma_candidates(token):
        if candidate in user_words:
            return user_words[candidate]
        if candidate in _WORDS:
            return _WORDS[candidate]
    return token


def lookup_word_translation(word: str, glossary: Any = None, corpus: TranslationCorpus | None = None) -> str | None:
    """从术语表、用户语料和结构翻译词库查询单词释义；未命中时明确返回 None。"""
    source = str(word or "").strip()
    if not source:
        return None
    translated = _translate_word(source, glossary, corpus if corpus is not None else default_corpus())
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


def translate_text(text: str, glossary: Any, corpus: TranslationCorpus | None = None) -> str:
    if corpus is None:
        corpus = default_corpus()
    protected = text
    phrase_values: dict[str, str] = {}
    for phrase, chinese in corpus.sorted_phrases():
        placeholder = f"PHRASE{len(phrase_values)}TOKEN"
        next_text = re.sub(rf"\b{re.escape(phrase)}\b", placeholder, protected, flags=re.I)
        if next_text != protected:
            phrase_values[placeholder] = chinese
            protected = next_text
    translated = []
    for token in _TOKEN.findall(protected):
        translated.append(phrase_values.get(token, _translate_word(token, glossary, corpus)))
    result = _join(translated)
    if result and result[-1] not in "。！？":
        result += "。"
    return result


def _apply_sentence_templates(text: str, corpus: TranslationCorpus) -> dict[str, Any] | None:
    stripped = text.strip()
    for template in corpus.sentence_templates():
        match = template["pattern"].fullmatch(stripped)
        if not match:
            continue
        rendered = template["render"](match)
        if rendered is not None:
            return rendered
    return None


def translate_sentence(parsed: Any, glossary: Any, corpus: TranslationCorpus | None = None) -> dict[str, Any]:
    """返回完整译文和逐分句译文，供 schema v3 的分析栏展示。"""
    if corpus is None:
        corpus = default_corpus()
    repaired = _apply_sentence_templates(parsed.text, corpus)
    if repaired:
        text = repaired["text"]
        clauses = repaired["clauses"]
    else:
        text = translate_text(parsed.text, glossary, corpus)
        clauses = []
        visible = [
            clause for clause in sorted(parsed.clauses, key=lambda item: item.order)
            if clause.id == parsed.main_clause_id or clause.parent_id == parsed.main_clause_id
        ]
        for clause in visible[:4]:
            clauses.append({
                "clause_id": clause.id,
                "label": getattr(clause, "label", "结构片段"),
                "text": translate_text(clause.text, glossary, corpus),
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
