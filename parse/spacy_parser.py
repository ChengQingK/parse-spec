# -*- coding: utf-8 -*-
"""基于 spaCy 依存关系生成面向阅读的英文逻辑分句树。"""

from __future__ import annotations

import os
import re
from typing import TYPE_CHECKING, Any

from . import parse_qa

if TYPE_CHECKING:
    from .clauser import Grammar, ParsedSentence


_MODEL_ENV = "PARSE_SPEC_SPACY_MODEL"
_DEFAULT_MODELS = ("en_core_web_sm",)


def _model_candidates() -> list[str]:
    """解析模型加载顺序：环境变量显式指定的模型优先，失败后回退默认链。"""
    requested = os.environ.get(_MODEL_ENV, "").strip()
    chain = [requested] if requested else []
    for name in _DEFAULT_MODELS:
        if name not in chain:
            chain.append(name)
    return chain


_NLP = None
_MODEL_NAME = ""
_SPACY_OK = False
_SPACY_ERROR = ""
for _model_name in _model_candidates():
    try:
        import spacy

        _NLP = spacy.load(_model_name, disable=["ner"])
        _MODEL_NAME = _model_name
        _SPACY_OK = True
        _SPACY_ERROR = ""
        break
    except Exception as exc:
        _NLP = None
        _SPACY_OK = False
        _SPACY_ERROR = f"{type(exc).__name__}: {exc}"


_CLAUSE_DEPS = {"relcl", "advcl", "ccomp", "xcomp", "csubj", "acl"}
_REL_WORDS = {"that", "which", "who", "whom", "whose", "when", "where", "why", "what", "how"}
_MODALS = {"can", "could", "may", "might", "must", "shall", "should", "will", "would"}
_LABELS = {
    "main": "核心命题",
    "concession": "让步背景",
    "condition": "条件",
    "time": "时间关系",
    "cause": "原因",
    "purpose": "目的",
    "result": "结果",
    "relative": "定语修饰",
    "content": "内容从句",
    "complement": "补充说明",
    "basis": "依据要求",
    "means": "方式手段",
    "ambiguous": "关系待确认",
}


def _is_false_technical_acl(token: Any) -> bool:
    """识别小模型把“<信号名> timing parameter”中的 timing 当动词的情况。"""
    dep = token.dep_.split(":", 1)[0]
    return (
        token.lower_ == "timing"
        and dep in {"acl", "advcl"}
        and token.head.pos_ in {"NOUN", "PROPN"}
        and any(child.lower_ in {"parameter", "parameters"} for child in token.children)
    )


def _is_spurious_as_adverbial(token: Any) -> bool:
    """识别 “treat as reserved” 里被误标成 advcl 的 “as + 分词” 补语。

    真分句的 as 是 mark 依存（如 “as required by the PHY”，还带 agent）；
    这里的 as 是 advmod/case 且从句无 mark、无主语、无执行者。
    """
    if token.dep_.split(":", 1)[0] != "advcl" or token.tag_ != "VBN":
        return False
    has_as_marker = any(
        child.lower_ == "as" and child.dep_.split(":", 1)[0] in {"advmod", "case", "prep"}
        for child in token.children
    )
    if not has_as_marker:
        return False
    has_mark = any(child.dep_.split(":", 1)[0] == "mark" for child in token.children)
    has_subject = any(
        child.dep_.split(":", 1)[0] in {"nsubj", "nsubjpass", "csubj"} for child in token.children
    )
    has_agent = any(
        child.dep_.split(":", 1)[0] == "agent" or child.lower_ == "by" for child in token.children
    )
    return not has_mark and not has_subject and not has_agent


def _fronted_clause_roots(doc: Any, main_root: Any) -> list[tuple[Any, str, str, Any, str]]:
    """把 “By + 动名词” / “Based on + 名词” 等 prep 挂靠状语恢复为独立分句。

    模型把它们统一标成主句谓语的 prep 短语，不会进入 _CLAUSE_DEPS，于是
    “By setting the enable bit, ...” 的前半句永远留在主句里。返回
    (状语根, 关系, 标志词, 语法提取根, 提示) 元组；前置与后置位置都生效。
    """
    result: list[tuple[Any, str, str, Any, str]] = []
    for child in main_root.children:
        if child.dep_.split(":", 1)[0] != "prep":
            continue
        pcomp = next(
            (item for item in child.children if item.dep_.split(":", 1)[0] == "pcomp"),
            None,
        )
        if child.lower_ == "by" and pcomp is not None and pcomp.tag_ == "VBG":
            result.append(
                (child, "means", "by", pcomp, "该方式状语由规则从 “by + 动名词” 结构识别")
            )
        elif child.tag_ == "VBN" and child.lower_ in {"based", "according", "depending"}:
            result.append(
                (child, "basis", child.text, child, "该依据状语由规则从 “based/according to + 名词” 结构识别")
            )
    return result


def _main_root(doc: Any, prefer_first_root: bool = False) -> Any | None:
    # 模型把一句话切成多段（逗号+连接副词常见）时会出现多个 ROOT：
    # 第一段就是主句，直接采用；单 ROOT 的小模型名词误标仍走修复链。
    if prefer_first_root:
        root_tokens = [token for token in doc if token.dep_ == "ROOT"]
        if len(root_tokens) > 1:
            return root_tokens[0]
    root = next((token for token in doc if token.dep_ == "ROOT"), None)
    if root is not None and root.pos_ in {"VERB", "AUX"}:
        return root
    # 小模型偶尔把名词判作 ROOT。带助动词的后续动词更接近真正主句谓语。
    repaired = next(
        (
            token
            for token in doc
            if token.pos_ == "VERB"
            and any(child.dep_.split(":", 1)[0] in {"aux", "auxpass"} for child in token.children)
        ),
        None,
    )
    if repaired is not None:
        return repaired
    return next(
        (token for token in doc if token.pos_ == "VERB" and token.dep_.split(":", 1)[0] not in _CLAUSE_DEPS),
        root,
    )


def _clause_roots(doc: Any, main_root: Any, strategy: str = "base") -> list[Any]:
    roots = [
        token
        for token in doc
        if token.i != main_root.i and token.dep_.split(":", 1)[0] in _CLAUSE_DEPS
        # en_core_web_sm 常把名词短语“signals, timing parameters”中的 timing
        # 误标成 advcl；该模式没有从句含义，不能从上级分句中剥离。
        and not _is_false_technical_acl(token)
        and not _is_spurious_as_adverbial(token)
    ]
    if strategy in {"base"}:
        return roots
    # 候选策略：质检层判可疑后尝试的补充分句边界。只在主句子树内生效，
    # 避免把定语从句内部的连接副词误提为顶级分句。
    taken = {main_root.i, *(root.i for root in roots)}
    if strategy in {"multiroot", "auto"}:
        for token in doc:
            if token.dep_ == "ROOT" and token.i not in taken:
                roots.append(token)
                taken.add(token.i)
    if strategy in {"conjadv", "auto"}:
        for token in doc:
            head = token.head
            if (
                token.lower_ in parse_qa.CONJ_ADVERBS
                and token.dep_.split(":", 1)[0] in {"advmod", "cc"}
                and head.pos_ in {"VERB", "AUX"}
                and head.i not in taken
                and head.i != main_root.i
                and head.dep_.split(":", 1)[0] not in _CLAUSE_DEPS
                and _nearest_clause_parent(head, roots, main_root) is main_root
            ):
                roots.append(head)
                taken.add(head.i)
    return roots


def _subtree_bounds(token: Any) -> tuple[int, int]:
    subtree = list(token.subtree)
    first = min(subtree, key=lambda item: item.i)
    last = max(subtree, key=lambda item: item.i)
    return first.idx, last.idx + len(last.text)


def _marker(token: Any, source: str) -> str:
    # 连接词必须直接支配当前从句根；扫描整个子树会把嵌套 when 错挂到上层 required。
    candidates = [
        child
        for child in token.children
        if child.dep_.split(":", 1)[0] == "mark" or child.lower_ in _REL_WORDS
        or (child.lower_ in parse_qa.CONJ_ADVERBS and child.dep_.split(":", 1)[0] in {"advmod", "cc"})
    ]
    if not candidates:
        # 不定式目的状语 “To enable ...” 的 to 是 aux 依存，同样直接支配分句根。
        candidates = [
            child for child in token.children if child.dep_.split(":", 1)[0] == "aux" and child.tag_ == "TO"
        ]
    if not candidates:
        return ""
    first = candidates[0]
    tail = source[first.idx : _subtree_bounds(token)[1]].lower()
    for phrase in ("in order that", "as soon as", "even though", "even if", "so that", "such that"):
        if tail.startswith(phrase):
            return source[first.idx : first.idx + len(phrase)]
    return first.text


def _relation(token: Any, marker: str) -> tuple[str, list[str]]:
    dep = token.dep_.split(":", 1)[0]
    lower = marker.lower()
    if dep in {"relcl", "acl"}:
        return "relative", []
    if dep in {"ccomp", "csubj"}:
        return "content", []
    if dep == "xcomp":
        return "complement", []
    if lower in parse_qa.CONJ_ADVERBS:
        # 句级连接副词：however 表转折、therefore/thus 表结果等。
        relation = parse_qa.CONJ_ADVERBS[lower]
        if relation is None:
            return "ambiguous", [f"{marker} 仅表递进/补充，逻辑关系需结合语境确认"]
        return relation, []
    if lower == "to":
        return "purpose", []
    if lower in {"although", "though", "even though"}:
        return "concession", []
    if lower in {"if", "unless", "even if", "provided", "providing"}:
        return "condition", []
    if lower in {"when", "whenever", "until", "before", "after", "once", "as soon as"}:
        return "time", []
    if lower == "because":
        return "cause", []
    if lower in {"in order that", "so that"}:
        return "purpose", []
    if lower == "such that":
        return "result", []
    if lower == "as" and token.lemma_.lower() == "require" and any(
        child.dep_.split(":", 1)[0] == "agent" or child.lower_ == "by" for child in token.children
    ):
        return "basis", []
    if lower in {"since", "while", "as"}:
        return "ambiguous", [f"{marker} 可能表达多种逻辑关系，需要结合语境确认"]
    return "ambiguous", ["未能从连接词确定该分句的逻辑关系"]


def _nearest_clause_parent(token: Any, roots: list[Any], main_root: Any, elevated_main: set[int] | None = None) -> Any:
    root_by_index = {item.i: item for item in roots}
    elevated_main = elevated_main or set()
    # 多重句根策略下，额外 ROOT 的 head 指向自身；它与其余分句是并列关系，
    # 就近父节点按主句处理，否则会自指并让 _is_descendant 判定失效。
    if token.head.i == token.i:
        return main_root
    current = token.head
    seen: set[int] = set()
    while current.i not in seen:
        if current.i == main_root.i:
            return main_root
        if current.i in root_by_index:
            return root_by_index[current.i]
        if current.i in elevated_main:
            return main_root
        seen.add(current.i)
        if current.head is current:
            break
        current = current.head
    return main_root


def _is_descendant(root: Any, possible_ancestor: Any, roots: list[Any], main_root: Any, elevated_main: set[int] | None = None) -> bool:
    current = _nearest_clause_parent(root, roots, main_root, elevated_main)
    seen: set[int] = set()
    while current.i not in seen:
        if current.i == possible_ancestor.i:
            return True
        if current.i == main_root.i:
            return possible_ancestor.i == main_root.i
        seen.add(current.i)
        current = _nearest_clause_parent(current, roots, main_root, elevated_main)
    return False


def _own_tokens(
    doc: Any,
    root: Any,
    clause_roots: list[Any],
    main_root: Any,
    elevated_main: list[Any] | None = None,
) -> list[Any]:
    candidates = list(doc) if root.i == main_root.i else list(root.subtree)
    excluded: set[int] = set()
    elevated_main = elevated_main or []
    elevated_indexes = {token.i for token in elevated_main}
    for child_root in clause_roots:
        if child_root.i == root.i:
            continue
        if _is_descendant(child_root, root, clause_roots, main_root, elevated_indexes):
            excluded.update(token.i for token in child_root.subtree)
    if root.i != main_root.i:
        candidate_indexes = {token.i for token in candidates}
        for conjunct in elevated_main:
            if conjunct.i not in candidate_indexes:
                continue
            excluded.update(token.i for token in conjunct.subtree)
            if conjunct.i > 0 and doc[conjunct.i - 1].lower_ in {"and", "or", "but"}:
                excluded.add(conjunct.i - 1)
    return [token for token in candidates if token.i not in excluded]


def _elevated_main_conjuncts(doc: Any, main_root: Any) -> list[Any]:
    """修复有限并列谓语被错误挂到非谓语时间从句下的常见长句。"""
    result = []
    for token in doc:
        if token.dep_.split(":", 1)[0] != "conj" or token.pos_ != "VERB" or token.tag_ not in {"VBZ", "VBP", "VBD"}:
            continue
        if not any(child.dep_.split(":", 1)[0] == "cc" for child in token.head.children):
            continue
        current = token.head
        saw_nonfinite_clause = False
        seen: set[int] = set()
        while current.i not in seen and current.i != main_root.i:
            seen.add(current.i)
            if current.dep_.split(":", 1)[0] in _CLAUSE_DEPS and current.tag_ in {"VBG", "VBN"}:
                saw_nonfinite_clause = True
            if current.head is current:
                break
            current = current.head
        if current.i == main_root.i and saw_nonfinite_clause:
            result.append(token)
    return result


def _elevated_tokens(doc: Any, root: Any, clause_roots: list[Any], main_root: Any, elevated_indexes: set[int]) -> list[Any]:
    tokens = list(root.subtree)
    excluded: set[int] = set()
    for child_root in clause_roots:
        if _nearest_clause_parent(child_root, clause_roots, main_root, elevated_indexes).i == main_root.i:
            if child_root.i > root.i:
                excluded.update(token.i for token in child_root.subtree)
    useful = [token for token in tokens if token.i not in excluded]
    if root.i > 0 and doc[root.i - 1].lower_ in {"and", "or", "but"}:
        useful.append(doc[root.i - 1])
    return useful


def _segments(source: str, tokens: list[Any]) -> list[tuple[int, int]]:
    useful = sorted(tokens, key=lambda item: item.i)
    if not useful:
        return []
    runs: list[list[Any]] = [[useful[0]]]
    for token in useful[1:]:
        if token.i == runs[-1][-1].i + 1:
            runs[-1].append(token)
        else:
            runs.append([token])

    result: list[tuple[int, int]] = []
    for run in runs:
        start = run[0].idx
        end = run[-1].idx + len(run[-1].text)
        while start < end and source[start] in " \t\r\n,;—":
            start += 1
        while end > start and source[end - 1] in " \t\r\n,;.—":
            end -= 1
        if start < end:
            result.append((start, end))
    return result


def _display_text(source: str, segments: list[tuple[int, int]]) -> str:
    return " ".join(source[start:end].strip() for start, end in segments if source[start:end].strip())


def _phrase(head: Any | None, include_prepositions: bool = False, include_conjuncts: bool = True) -> str:
    if head is None:
        return ""
    allowed = {"det", "amod", "compound", "nummod", "poss", "case", "quantmod"}
    if include_prepositions:
        allowed |= {"prep", "pobj", "dative"}
    if include_conjuncts:
        # 并列短语（A and B）要连同 and/or 一起展示，否则“主语 The DFI signals
        # and the device”只显示前半个并列项。
        allowed |= {"conj", "cc"}
    tokens = [head]
    pending = [head]
    while pending:
        parent = pending.pop()
        for child in parent.children:
            false_acl_tail = _is_false_technical_acl(parent) and child.lower_ in {"parameter", "parameters"}
            if child.dep_.split(":", 1)[0] not in allowed and not _is_false_technical_acl(child) and not false_acl_tail:
                continue
            tokens.append(child)
            pending.append(child)
    return " ".join(token.text for token in sorted(set(tokens), key=lambda item: item.i))


def _subject(root: Any, main_root: Any) -> Any | None:
    if (
        root.i == main_root.i
        and root.dep_.split(":", 1)[0] in {"relcl", "acl"}
        and root.head.pos_ in {"NOUN", "PROPN"}
    ):
        return root.head
    if (
        root.dep_.split(":", 1)[0] in {"relcl", "acl"}
        and root.head.pos_ in {"NOUN", "PROPN"}
    ):
        explicit = next(
            (
                child
                for child in root.children
                if child.dep_.split(":", 1)[0] in {"nsubj", "nsubjpass", "csubj"}
            ),
            None,
        )
        return explicit or root.head
    subject = next(
        (
            child
            for child in root.children
            if child.dep_.split(":", 1)[0] in {"nsubj", "nsubjpass", "csubj"}
        ),
        None,
    )
    if subject is not None:
        return subject
    return None


def _grammar(root: Any, main_root: Any, owned_tokens: list[Any] | None = None) -> Grammar:
    from .clauser import Grammar

    subject_token = _subject(root, main_root)
    auxiliary_tokens = [
        child
        for child in root.children
        if child.dep_.split(":", 1)[0] in {"aux", "auxpass"}
    ]
    particle_tokens = [child for child in root.children if child.dep_.split(":", 1)[0] == "prt"]
    predicate_tokens = auxiliary_tokens + [child for child in root.children if child.dep_.split(":", 1)[0] == "neg"] + particle_tokens + [root]
    predicate = " ".join(token.text for token in sorted(set(predicate_tokens), key=lambda item: item.i))
    direct_object_token = next(
        (child for child in root.children if child.dep_.split(":", 1)[0] in {"obj", "dobj"}),
        None,
    )
    indirect_object_token = next((child for child in root.children if child.dep_.split(":", 1)[0] == "iobj"), None)
    complement_token = next(
        (child for child in root.children if child.dep_.split(":", 1)[0] in {"attr", "acomp", "oprd"}),
        None,
    )
    agent_prep = next((child for child in root.children if child.dep_.split(":", 1)[0] == "agent"), None)
    agent_token = None
    if agent_prep is not None:
        agent_token = next(
            (child for child in agent_prep.children if child.dep_.split(":", 1)[0] == "pobj"),
            None,
        )
    explicit_subject = any(
        child.dep_.split(":", 1)[0] in {"nsubj", "nsubjpass", "csubj"}
        for child in root.children
    )
    passive = any(
        child.dep_.split(":", 1)[0] in {"nsubjpass", "auxpass"}
        for child in root.children
    ) or (
        root.tag_ == "VBN"
        and root.dep_.split(":", 1)[0] in {"acl", "relcl", "advcl"}
        and not explicit_subject
    )
    modal_tokens = [
        child.text
        for child in auxiliary_tokens
        if child.dep_.split(":", 1)[0] == "aux" and child.lemma_.lower() in _MODALS
    ]
    negated = any(child.dep_.split(":", 1)[0] == "neg" for child in root.children)
    modal_lemmas = [child.lemma_.lower() for child in auxiliary_tokens if child.lemma_.lower() in _MODALS]
    if any(modal in {"shall", "must"} for modal in modal_lemmas):
        requirement_level = "prohibited" if negated else "mandatory"
    elif "should" in modal_lemmas:
        requirement_level = "recommended"
    elif any(modal in {"may", "can", "could"} for modal in modal_lemmas):
        requirement_level = "permitted"
    else:
        requirement_level = "unspecified"
    morph = root.morph
    tense = "/".join(morph.get("Tense"))
    aspect = "/".join(morph.get("Aspect"))
    mood = "/".join(morph.get("Mood"))
    clause_tokens = list(owned_tokens) if owned_tokens is not None else list(root.subtree)
    modifier_tokens = [
        child
        for child in clause_tokens
        if child.dep_.split(":", 1)[0] in {"advmod", "npadvmod", "obl"}
    ]
    prepositions = [child for child in clause_tokens if child.dep_.split(":", 1)[0] == "prep"]
    prepositional_phrases = [
        " ".join(token.text for token in sorted(child.subtree, key=lambda item: item.i))
        for child in prepositions
    ]
    coordination = [
        " ".join(token.text for token in sorted(child.subtree, key=lambda item: item.i))
        for child in root.children
        if child.dep_.split(":", 1)[0] == "conj"
    ]
    antecedent = _phrase(root.head, include_conjuncts=False) if root.dep_.split(":", 1)[0] in {"relcl", "acl"} and root.head.pos_ in {"NOUN", "PROPN"} else ""
    direct_object = _phrase(direct_object_token, include_prepositions=True)
    complement = _phrase(complement_token, include_prepositions=True)
    if (
        direct_object_token is not None
        and root.lemma_.lower() in {"change", "select"}
        and direct_object_token.i + 1 < len(root.doc)
        and root.doc[direct_object_token.i + 1].lower_ == "select"
    ):
        direct_object = f"{direct_object} {root.doc[direct_object_token.i + 1].text}".strip()
        complement = ""
    if not antecedent and root.dep_.split(":", 1)[0] in {"relcl", "acl"} and root.head.lower_ == "select":
        head = root.head
        start = head.i
        while start > 0 and head.i - start < 4 and root.doc[start - 1].pos_ in {"DET", "ADJ", "NOUN", "PROPN"}:
            start -= 1
        antecedent = root.doc[start : head.i + 1].text
    source_text = " ".join(token.text for token in sorted(clause_tokens, key=lambda item: item.i))
    rule_modal = re.search(r"\b(shall|must|should|may|might|can|could|will|would)\b", source_text, re.I)
    rule_negated = bool(re.search(r"\b(?:not|never|neither|nor)\b", source_text, re.I))
    rule_passive = bool(re.search(r"\b(?:is|are|was|were|be|been|being)\s+(?:\w+ly\s+)?\w+(?:ed|en)\b", source_text, re.I))
    checks = [rule_negated == negated, rule_passive == passive]
    if rule_modal:
        checks.append(rule_modal.group(1).lower() in modal_lemmas)
    agreement = "corroborated" if all(checks) else "conflict"
    # 缩略定语从句（无显式主语，回退到中心名词）的主语只是被修饰名词本身，
    # 不应把同位并列的另一主语（and the device）也算进该从句。
    reduced_relative = (
        root.dep_.split(":", 1)[0] in {"relcl", "acl"}
        and root.head.pos_ in {"NOUN", "PROPN"}
        and subject_token is not None
        and subject_token.i == root.head.i
    )
    return Grammar(
        subject=_phrase(subject_token, include_conjuncts=not reduced_relative),
        predicate=predicate,
        object=direct_object,
        agent=_phrase(agent_token),
        complement=complement,
        voice="passive" if passive else "active",
        negated=negated,
        modality=" ".join(modal_tokens),
        direct_object=direct_object,
        indirect_object=_phrase(indirect_object_token, include_prepositions=True),
        auxiliaries=[token.text for token in sorted(auxiliary_tokens, key=lambda item: item.i)],
        particles=[token.text for token in sorted(particle_tokens, key=lambda item: item.i)],
        tense=tense,
        aspect=aspect,
        mood=mood,
        requirement_level=requirement_level,
        modifiers=[_phrase(token, include_prepositions=True) for token in modifier_tokens],
        prepositional_phrases=prepositional_phrases,
        coordination=coordination,
        antecedent=antecedent,
        evidence_sources=["spacy-dependency", "spacy-morphology", "technical-rule"],
        agreement=agreement,
    )


def _repaired_relative(doc: Any, source: str, main_root: Any) -> dict[str, Any] | None:
    """修复小模型把“名词 + that 从句 + 被动主句”整体标成 relcl 的常见错误。"""
    from .clauser import Grammar

    if (
        main_root.dep_.split(":", 1)[0] not in {"relcl", "acl"}
        or main_root.head.dep_ != "ROOT"
        or main_root.head.pos_ not in {"NOUN", "PROPN"}
    ):
        return None
    predicate_start = min(
        (
            child.i
            for child in main_root.children
            if child.dep_.split(":", 1)[0] in {"aux", "auxpass", "neg"}
        ),
        default=main_root.i,
    )
    marker = next(
        (
            token
            for token in doc
            if main_root.head.i < token.i < predicate_start and token.lower_ in _REL_WORDS
        ),
        None,
    )
    if marker is None or marker.i + 1 >= predicate_start:
        return None
    predicate = doc[marker.i + 1]
    end_token = doc[predicate_start - 1]
    start = marker.idx
    end = end_token.idx + len(end_token.text)
    object_text = source[predicate.idx + len(predicate.text) : end].strip(" ,;")
    return {
        "start": start,
        "end": end,
        "order": marker.i,
        "marker": marker.text,
        "text": source[start:end].strip(" ,;"),
        "grammar": Grammar(
            subject=marker.text,
            predicate=predicate.text,
            object=object_text,
        ),
    }


def _build_tree(doc: Any, source: str, main_root: Any, strategy: str, ClauseNode: Any, ParsedSentence: Any) -> "ParsedSentence":
    """从同一份 doc 按给定策略构建分句树；策略只改变分句根集合，其余管线一致。"""
    roots = _clause_roots(doc, main_root, strategy)
    fronted_roots = _fronted_clause_roots(doc, main_root)
    elevated_main = _elevated_main_conjuncts(doc, main_root)
    elevated_indexes = {token.i for token in elevated_main}
    repaired_relative = _repaired_relative(doc, source, main_root)
    # 规则恢复的前置状语与依存从句共用同一套编号、排除与父子判定。
    all_roots = roots + [item[0] for item in fronted_roots]
    bounds = {root.i: _subtree_bounds(root) for root in all_roots}
    all_roots.sort(key=lambda token: bounds[token.i])
    root_ids = {main_root.i: "c0"}
    root_ids.update({root.i: f"c{index}" for index, root in enumerate(all_roots, start=1)})

    main_tokens = _own_tokens(doc, main_root, all_roots, main_root, elevated_main)
    for conjunct in elevated_main:
        main_tokens.extend(_elevated_tokens(doc, conjunct, all_roots, main_root, elevated_indexes))
    main_tokens = sorted({token.i: token for token in main_tokens}.values(), key=lambda token: token.i)
    if repaired_relative:
        main_tokens = [
            token
            for token in main_tokens
            if not (repaired_relative["start"] <= token.idx < repaired_relative["end"])
        ]
    main_segments = _segments(source, main_tokens)
    main_grammar = _grammar(main_root, main_root, main_tokens)
    if elevated_main:
        main_grammar.coordination = [
            _display_text(source, _segments(source, _elevated_tokens(doc, conjunct, all_roots, main_root, elevated_indexes)))
            for conjunct in elevated_main
        ]
    if repaired_relative and main_grammar.object.lower() == repaired_relative["marker"].lower():
        main_grammar.object = ""
    nodes = [
        ClauseNode(
            id="c0",
            parent_id=None,
            order=min((token.i for token in main_tokens), default=0),
            text=_display_text(source, main_segments) or source,
            start=0,
            end=len(source),
            segments=main_segments or [(0, len(source))],
            kind="main",
            relation="main",
            label=_LABELS["main"],
            grammar=main_grammar,
            confidence=0.95 if main_grammar.agreement == "corroborated" else 0.72,
            warnings=[] if main_grammar.agreement == "corroborated" else ["依存分析与技术规则对语态、否定或情态的判断存在差异。"],
        )
    ]

    fronted_by_index = {item[0].i: item for item in fronted_roots}
    for root in all_roots:
        start, end = bounds[root.i]
        own_tokens = _own_tokens(doc, root, all_roots, main_root, elevated_main)
        own_segments = _segments(source, own_tokens)
        if root.i in fronted_by_index:
            relation, marker, grammar_root, note = fronted_by_index[root.i][1:]
            clause_grammar = _grammar(grammar_root, main_root, own_tokens)
            next_token = doc[root.i + 1] if root.i + 1 < len(doc) else None
            if grammar_root is root and next_token is not None and next_token.lower_ in {"on", "to", "upon"}:
                # “Based on” 的谓语补上介词，避免只显示孤立的分词。
                clause_grammar.predicate = f"{root.text} {next_token.text}"
            nodes.append(
                ClauseNode(
                    id=root_ids[root.i],
                    parent_id="c0",
                    order=min((token.i for token in root.subtree), default=root.i),
                    text=_display_text(source, own_segments) or source[start:end].strip(" ,;"),
                    start=start,
                    end=end,
                    segments=own_segments or [(start, end)],
                    kind="advcl",
                    relation=relation,
                    label=_LABELS[relation],
                    marker=marker,
                    grammar=clause_grammar,
                    confidence=0.75,
                    warnings=[note],
                )
            )
            continue
        marker = _marker(root, source)
        relation, warnings = _relation(root, marker)
        parent_root = _nearest_clause_parent(root, all_roots, main_root, elevated_indexes)
        nodes.append(
            ClauseNode(
                id=root_ids[root.i],
                parent_id=root_ids.get(parent_root.i, "c0"),
                order=min((token.i for token in root.subtree), default=root.i),
                text=_display_text(source, own_segments) or source[start:end].strip(" ,;"),
                start=start,
                end=end,
                segments=own_segments or [(start, end)],
                kind=root.dep_.split(":", 1)[0],
                relation=relation,
                label=_LABELS[relation],
                marker=marker,
                grammar=(clause_grammar := _grammar(root, main_root, own_tokens)),
                confidence=(
                    0.68 if relation == "ambiguous"
                    else 0.92 if clause_grammar.agreement == "corroborated"
                    else 0.7
                ),
                warnings=warnings + ([] if clause_grammar.agreement == "corroborated" else ["依存分析与技术规则的语法判断存在差异。"]),
            )
        )

    if repaired_relative:
        nodes.append(
            ClauseNode(
                id=f"c{len(all_roots) + 1}",
                parent_id="c0",
                order=repaired_relative["order"],
                text=repaired_relative["text"],
                start=repaired_relative["start"],
                end=repaired_relative["end"],
                segments=[(repaired_relative["start"], repaired_relative["end"])],
                kind="relcl-repair",
                relation="relative",
                label=_LABELS["relative"],
                marker=repaired_relative["marker"],
                grammar=repaired_relative["grammar"],
                confidence=0.62,
                warnings=["该定语从句由小模型误标修复规则识别，请结合原句确认"],
            )
        )

    return ParsedSentence(
        text=source,
        clauses=nodes,
        main_clause_id="c0",
        engine="spacy",
        term_candidates=[
            (token.text, token.lemma_.lower())
            for token in doc
            if token.is_alpha and not token.is_space
        ],
        lemma_spans=[
            (token.idx, token.idx + len(token.text), token.lemma_.lower())
            for token in doc
            if token.is_alpha and not token.is_space
        ],
    )


def parse_spacy(text: str) -> "ParsedSentence" | None:
    """返回逻辑分句树；模型不可用时返回 ``None``。

    质检层先给基础树"判卷"；判为可疑时套用候选拆分策略（多重句根 /
    连接副词边界）重新构建，选择强信号更少的树；仍可疑则保留原树、
    标注 "解析存疑" 警告，并在 qa 字段记录信号供前端展示与反馈。
    """
    from .clauser import ClauseNode, ParsedSentence

    if not _SPACY_OK or _NLP is None:
        return None
    source = text.strip()
    if not source:
        return None
    doc = _NLP(source)
    main_root = _main_root(doc)
    if main_root is None:
        return None

    parsed = _build_tree(doc, source, main_root, "base", ClauseNode, ParsedSentence)
    qa = parse_qa.assess(source, parsed, doc)
    strategy = "base"
    if qa["suspicious"]:
        for candidate in ("multiroot", "conjadv", "auto"):
            candidate_root = (
                main_root
                if candidate == "conjadv"
                else _main_root(doc, prefer_first_root=True)
            )
            if candidate_root is None:
                continue
            alt = _build_tree(doc, source, candidate_root, candidate, ClauseNode, ParsedSentence)
            alt_qa = parse_qa.assess(source, alt, doc)
            if parse_qa.better(qa, alt_qa):
                parsed, qa, strategy = alt, alt_qa, candidate
    if qa["suspicious"]:
        still = "；".join([*qa["strong"], *qa["weak"]])
        parsed.warnings.append(f"解析存疑：{still}。请结合原句核对，或通过反馈确认")
    parsed.qa = {
        "suspicious": qa["suspicious"],
        "signals": [*qa["strong"], *qa["weak"]],
        "strategy": strategy,
    }
    return parsed
