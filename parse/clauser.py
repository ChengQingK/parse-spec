# -*- coding: utf-8 -*-
"""句子切分、统一分析数据模型与纯规则回退。"""

from __future__ import annotations

from dataclasses import dataclass, field
import logging
import re


LOGGER = logging.getLogger(__name__)


@dataclass(slots=True)
class Grammar:
    """一个分句的可读语法主干。"""

    subject: str = ""
    predicate: str = ""
    object: str = ""
    agent: str = ""
    complement: str = ""
    voice: str = "active"
    negated: bool = False
    modality: str = ""
    direct_object: str = ""
    indirect_object: str = ""
    auxiliaries: list[str] = field(default_factory=list)
    particles: list[str] = field(default_factory=list)
    tense: str = ""
    aspect: str = ""
    mood: str = ""
    requirement_level: str = "unspecified"
    modifiers: list[str] = field(default_factory=list)
    prepositional_phrases: list[str] = field(default_factory=list)
    coordination: list[str] = field(default_factory=list)
    antecedent: str = ""
    evidence_sources: list[str] = field(default_factory=list)
    agreement: str = "single-source"


@dataclass(slots=True)
class ClauseNode:
    """面向 UI 的逻辑分句节点。"""

    id: str
    parent_id: str | None
    order: int
    text: str
    start: int
    end: int
    segments: list[tuple[int, int]]
    kind: str
    relation: str
    label: str
    marker: str = ""
    grammar: Grammar = field(default_factory=Grammar)
    confidence: float = 1.0
    warnings: list[str] = field(default_factory=list)


@dataclass(slots=True)
class ParsedSentence:
    text: str
    clauses: list[ClauseNode]
    main_clause_id: str = ""
    engine: str = "rule-fallback"
    warnings: list[str] = field(default_factory=list)
    term_candidates: list[tuple[str, str]] = field(default_factory=list, repr=False)
    # (start, end, lemma)：spaCy 路径随解析一并产出，供复杂词识别复用，避免二次解析。
    lemma_spans: list[tuple[int, int, str]] = field(default_factory=list, repr=False)
    # 非空表示分句树由该在线模型精修过（本地解析始终即时返回，精修是可选增强层）。
    refined_by: str = ""


@dataclass(slots=True)
class Chunk:
    """纯规则回退使用的中间分块。"""

    text: str
    kind: str
    marker: str = ""
    note: str = ""


_ABBREVIATIONS = {
    "e.g.", "i.e.", "etc.", "vs.", "viz.", "approx.", "fig.", "ref.",
    "sec.", "no.", "vol.", "mr.", "mrs.", "ms.", "dr.", "prof.",
    "st.", "ave.", "dept.", "est.", "inc.", "corp.", "ltd.", "jr.", "sr.",
}

CLAUSE_MARKERS: list[tuple[re.Pattern[str], str, str]] = [
    (re.compile(r"\bthat\b", re.I), "content", "that 引导定语从句或内容从句"),
    (re.compile(r"\bwhich\b", re.I), "relative", "which 引导定语从句"),
    (re.compile(r"\b(?:who|whom|whose)\b", re.I), "relative", "关系代词引导定语从句"),
    (re.compile(r"\bwhen\b", re.I), "time", "when 引导时间关系"),
    (re.compile(r"\bwhere\b", re.I), "relative", "where 引导地点或范围关系"),
    (re.compile(r"\bwhile\b", re.I), "ambiguous", "while 可能表示时间或让步"),
    (re.compile(r"\bbecause\b", re.I), "cause", "because 引导原因"),
    (re.compile(r"\b(?:although|though)\b", re.I), "concession", "although/though 引导让步"),
    (re.compile(r"\bsince\b", re.I), "ambiguous", "since 可能表示时间或原因"),
    (re.compile(r"\bunless\b", re.I), "condition", "unless 引导否定条件"),
    (re.compile(r"\bif\b", re.I), "condition", "if 引导条件"),
    (re.compile(r"\buntil\b", re.I), "time", "until 引导时间边界"),
    (re.compile(r"\bbefore\b", re.I), "time", "before 引导时间关系"),
    (re.compile(r"\bafter\b", re.I), "time", "after 引导时间关系"),
    (re.compile(r"\b(?:such that|so that|in order that)\b", re.I), "purpose", "引导目的或结果"),
]

_SOFT_BREAK = re.compile(r"\s*(?:,|;|--|—)\s*")
_WORD = re.compile(r"[A-Za-z]+(?:['-][A-Za-z]+)*|\d+(?:\.\d+)?|[^\w\s]")
_AUX = set("will would shall should can could may might must do does did have has had is are was were be been being am".split())
_VERB_STARTER = _AUX | set(
    "allow allows cause causes complete completes contain contains control controls "
    "depend depends detect detects disable disables enable enables ensure ensures execute executes "
    "flush flushes latch latches load loads operate operates perform performs provide provides "
    "read reads require requires return returns set sets store stores support supports transfer transfers "
    "transmit transmits use used write writes".split()
)

_RELATION_LABELS = {
    "main": "核心命题",
    "concession": "让步背景",
    "condition": "条件",
    "time": "时间关系",
    "cause": "原因",
    "purpose": "目的 / 结果",
    "relative": "定语修饰",
    "content": "内容从句",
    "complement": "补充说明",
    "parenthetical": "插入说明",
    "basis": "依据要求",
    "means": "方式手段",
    "ambiguous": "关系待确认",
}


def split_sentences(text: str) -> list[str]:
    """按句末标点切分文本，同时避开常见缩写和小数。"""
    source = re.sub(r"\s+", " ", text).strip()
    if not source:
        return []

    result: list[str] = []
    start = 0
    i = 0
    while i < len(source):
        if source[i] not in ".!?":
            i += 1
            continue
        if source[i] == "." and i and i + 1 < len(source) and source[i - 1].isdigit() and source[i + 1].isdigit():
            i += 1
            continue
        prefix = source[start : i + 1]
        token = re.search(r"(?:[A-Za-z]+\.){1,3}$", prefix)
        if token and token.group(0).lower() in _ABBREVIATIONS:
            i += 1
            continue
        end = i + 1
        while end < len(source) and source[end] in "\"')]}’”":
            end += 1
        if end == len(source) or source[end].isspace():
            sentence = source[start:end].strip()
            if sentence:
                result.append(sentence)
            start = end
            while start < len(source) and source[start].isspace():
                start += 1
            i = start
            continue
        i += 1
    tail = source[start:].strip()
    if tail:
        result.append(tail)
    return result


def _find_markers(text: str) -> list[tuple[int, int, str, str, str]]:
    found: list[tuple[int, int, str, str, str]] = []
    for pattern, relation, note in CLAUSE_MARKERS:
        for match in pattern.finditer(text):
            found.append((match.start(), match.end(), relation, match.group(0), note))
    found.sort(key=lambda item: (item[0], -(item[1] - item[0])))
    deduped: list[tuple[int, int, str, str, str]] = []
    for item in found:
        if not deduped or item[0] >= deduped[-1][1]:
            deduped.append(item)
    return deduped


def segment_clauses(text: str) -> list[Chunk]:
    """按软断点和从句引导词生成回退分块。"""
    sentence = text.strip()
    if not sentence:
        return []

    chunks: list[Chunk] = []
    for coarse in filter(None, (part.strip() for part in _SOFT_BREAK.split(sentence))):
        markers = _find_markers(coarse)
        if not markers:
            kind = "parenthetical" if coarse.startswith(("(", "[")) else "main"
            chunks.append(Chunk(coarse, kind))
            continue
        cursor = 0
        for index, marker in enumerate(markers):
            start, _end, relation, marker_text, note = marker
            if start > cursor:
                prefix = coarse[cursor:start].strip()
                if prefix:
                    chunks.append(Chunk(prefix, "main"))
            next_start = markers[index + 1][0] if index + 1 < len(markers) else len(coarse)
            clause = coarse[start:next_start].strip()
            if clause:
                chunks.append(Chunk(clause, relation, marker_text, note))
            cursor = next_start
    return chunks or [Chunk(sentence, "main")]


def structure(text: str) -> tuple[str, str]:
    """启发式提取谓语和主语，供无 spaCy 时回退。"""
    tokens = [token for token in _WORD.findall(text) if re.match(r"[A-Za-z]", token)]
    verb_index = -1
    for index, token in enumerate(tokens):
        lower = token.lower()
        if lower in _VERB_STARTER or lower.endswith(("ed", "ing")):
            verb_index = index
            break
    if verb_index < 0:
        return "", " ".join(tokens[:6])

    verb_tokens = [tokens[verb_index]]
    if tokens[verb_index].lower() in _AUX and verb_index + 1 < len(tokens):
        verb_tokens.append(tokens[verb_index + 1])
    subject = " ".join(tokens[:verb_index]).strip()
    return " ".join(verb_tokens), subject


def _rule_grammar(text: str, subject: str, predicate: str) -> Grammar:
    lower = text.lower()
    modal_match = re.search(r"\b(shall|must|should|may|might|can|could|will|would)\b", lower)
    modal = modal_match.group(1) if modal_match else ""
    negated = bool(re.search(r"\b(?:not|never|neither|nor)\b", lower))
    if modal in {"shall", "must"}:
        requirement = "prohibited" if negated else "mandatory"
    elif modal == "should":
        requirement = "recommended"
    elif modal in {"may", "can", "could"}:
        requirement = "permitted"
    else:
        requirement = "unspecified"
    passive = bool(re.search(r"\b(?:is|are|was|were|be|been|being)\s+(?:\w+ly\s+)?\w+(?:ed|en)\b", lower))
    return Grammar(
        subject=subject,
        predicate=predicate,
        voice="passive" if passive else "active",
        negated=negated,
        modality=modal,
        auxiliaries=[modal] if modal else [],
        requirement_level=requirement,
        evidence_sources=["technical-rule"],
        agreement="rule-fallback",
    )


def _locate_chunks(source: str, chunks: list[Chunk]) -> list[tuple[Chunk, int, int]]:
    located: list[tuple[Chunk, int, int]] = []
    cursor = 0
    for chunk in chunks:
        start = source.lower().find(chunk.text.lower(), cursor)
        if start < 0:
            start = source.lower().find(chunk.text.lower())
        if start < 0:
            start = cursor
        end = min(len(source), start + len(chunk.text))
        located.append((chunk, start, end))
        cursor = end
    return located


def fallback_parse(sentence: str, reason: str = "spaCy 不可用，已使用规则降级解析") -> ParsedSentence:
    chunks = segment_clauses(sentence)
    located = _locate_chunks(sentence, chunks)
    main_parts = [(chunk, start, end) for chunk, start, end in located if chunk.kind == "main"]
    if not main_parts and located:
        main_parts = [located[0]]

    main_text = " ".join(chunk.text for chunk, _start, _end in main_parts).strip() or sentence
    predicate, subject = structure(main_text)
    main_segments = [(start, end) for _chunk, start, end in main_parts]
    main_start = min((start for start, _end in main_segments), default=0)
    main_end = max((end for _start, end in main_segments), default=len(sentence))
    first_main_order = next(
        (index for index, item in enumerate(located) if item in main_parts),
        0,
    )
    nodes = [
        ClauseNode(
            id="c0",
            parent_id=None,
            order=first_main_order,
            text=main_text,
            start=main_start,
            end=main_end,
            segments=main_segments or [(0, len(sentence))],
            kind="main",
            relation="main",
            label=_RELATION_LABELS["main"],
            grammar=_rule_grammar(main_text, subject, predicate),
            confidence=0.45,
            warnings=["当前结果由纯规则回退生成，结构精度有限"],
        )
    ]

    node_index = 1
    for order, (chunk, start, end) in enumerate(located):
        if (chunk, start, end) in main_parts:
            continue
        relation = chunk.kind if chunk.kind in _RELATION_LABELS else "ambiguous"
        predicate, subject = structure(chunk.text)
        warnings = [chunk.note] if chunk.note else []
        if relation == "ambiguous":
            warnings.append("连接词存在多种语义，需要结合上下文确认")
        nodes.append(
            ClauseNode(
                id=f"c{node_index}",
                parent_id="c0",
                order=order,
                text=chunk.text,
                start=start,
                end=end,
                segments=[(start, end)],
                kind="clause",
                relation=relation,
                label=_RELATION_LABELS[relation],
                marker=chunk.marker,
                grammar=_rule_grammar(chunk.text, subject, predicate),
                confidence=0.4,
                warnings=warnings,
            )
        )
        node_index += 1

    return ParsedSentence(
        text=sentence,
        clauses=nodes,
        main_clause_id="c0",
        engine="rule-fallback",
        warnings=[reason],
        term_candidates=[(token, token.lower()) for token in re.findall(r"[A-Za-z]+(?:['-][A-Za-z]+)*", sentence)],
    )


def parse_sentence(text: str) -> ParsedSentence:
    """优先使用 spaCy 生成逻辑树；模型不可用时返回同构的规则结果。"""
    sentence = text.strip()
    if not sentence:
        return ParsedSentence("", [], warnings=["句子为空"])
    try:
        from .spacy_parser import _SPACY_ERROR, parse_spacy

        parsed = parse_spacy(sentence)
        if parsed is not None and parsed.clauses:
            return parsed
        reason = "spaCy 模型不可用，已使用规则降级解析"
        if _SPACY_ERROR:
            LOGGER.warning("spaCy 初始化失败：%s", _SPACY_ERROR)
    except Exception as exc:
        # 保留降级可用性，同时让真正的解析缺陷在日志和响应中可观察。
        LOGGER.exception("spaCy 解析异常，已降级到规则引擎")
        reason = f"spaCy 解析异常（{type(exc).__name__}），已使用规则降级解析"
    return fallback_parse(sentence, reason)


def _self_test() -> None:
    samples = [
        "The register latches data.",
        "Although the bus is busy, the controller must stall.",
    ]
    for sentence in samples:
        parsed = parse_sentence(sentence)
        assert parsed.clauses
        assert parsed.main_clause_id == "c0"
        print(parsed)


if __name__ == "__main__":
    _self_test()
