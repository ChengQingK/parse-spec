# -*- coding: utf-8 -*-
"""基于 spaCy 依存关系生成面向阅读的英文逻辑分句树。"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .clauser import Grammar, ParsedSentence


try:
    import spacy

    _NLP = spacy.load("en_core_web_sm", disable=["ner"])
    _SPACY_OK = True
    _SPACY_ERROR = ""
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
    "ambiguous": "关系待确认",
}


def _main_root(doc: Any) -> Any | None:
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


def _clause_roots(doc: Any, main_root: Any) -> list[Any]:
    return [
        token
        for token in doc
        if token.i != main_root.i and token.dep_.split(":", 1)[0] in _CLAUSE_DEPS
    ]


def _subtree_bounds(token: Any) -> tuple[int, int]:
    subtree = list(token.subtree)
    first = min(subtree, key=lambda item: item.i)
    last = max(subtree, key=lambda item: item.i)
    return first.idx, last.idx + len(last.text)


def _marker(token: Any, source: str) -> str:
    subtree = sorted(token.subtree, key=lambda item: item.i)
    candidates = [
        child
        for child in subtree
        if child.dep_.split(":", 1)[0] == "mark" or child.lower_ in _REL_WORDS
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
    if lower in {"since", "while", "as"}:
        return "ambiguous", [f"{marker} 可能表达多种逻辑关系，需要结合语境确认"]
    return "ambiguous", ["未能从连接词确定该分句的逻辑关系"]


def _nearest_clause_parent(token: Any, roots: list[Any], main_root: Any) -> Any:
    root_by_index = {item.i: item for item in roots}
    current = token.head
    seen: set[int] = set()
    while current.i not in seen:
        if current.i == main_root.i:
            return main_root
        if current.i in root_by_index:
            return root_by_index[current.i]
        seen.add(current.i)
        if current.head is current:
            break
        current = current.head
    return main_root


def _is_descendant(root: Any, possible_ancestor: Any, roots: list[Any], main_root: Any) -> bool:
    current = _nearest_clause_parent(root, roots, main_root)
    seen: set[int] = set()
    while current.i not in seen:
        if current.i == possible_ancestor.i:
            return True
        if current.i == main_root.i:
            return possible_ancestor.i == main_root.i
        seen.add(current.i)
        current = _nearest_clause_parent(current, roots, main_root)
    return False


def _own_tokens(doc: Any, root: Any, clause_roots: list[Any], main_root: Any) -> list[Any]:
    candidates = list(doc) if root.i == main_root.i else list(root.subtree)
    excluded: set[int] = set()
    for child_root in clause_roots:
        if child_root.i == root.i:
            continue
        if _is_descendant(child_root, root, clause_roots, main_root):
            excluded.update(token.i for token in child_root.subtree)
    return [token for token in candidates if token.i not in excluded]


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


def _phrase(head: Any | None, include_prepositions: bool = False) -> str:
    if head is None:
        return ""
    allowed = {"det", "amod", "compound", "nummod", "poss", "case", "quantmod"}
    if include_prepositions:
        allowed |= {"prep", "pobj", "dative"}
    tokens = [head]
    pending = [head]
    while pending:
        parent = pending.pop()
        for child in parent.children:
            if child.dep_.split(":", 1)[0] not in allowed:
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


def _grammar(root: Any, main_root: Any) -> Grammar:
    from .clauser import Grammar

    subject_token = _subject(root, main_root)
    predicate_tokens = [
        child
        for child in root.children
        if child.dep_.split(":", 1)[0] in {"aux", "auxpass", "neg", "prt"}
    ] + [root]
    predicate = " ".join(token.text for token in sorted(set(predicate_tokens), key=lambda item: item.i))
    object_token = next(
        (child for child in root.children if child.dep_.split(":", 1)[0] in {"obj", "dobj", "iobj"}),
        None,
    )
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
    passive = any(
        child.dep_.split(":", 1)[0] in {"nsubjpass", "auxpass"}
        for child in root.children
    )
    modal_tokens = [
        child.text
        for child in root.children
        if child.dep_.split(":", 1)[0] == "aux" and child.lemma_.lower() in _MODALS
    ]
    return Grammar(
        subject=_phrase(subject_token),
        predicate=predicate,
        object=_phrase(object_token, include_prepositions=True),
        agent=_phrase(agent_token),
        complement=_phrase(complement_token, include_prepositions=True),
        voice="passive" if passive else "active",
        negated=any(child.dep_.split(":", 1)[0] == "neg" for child in root.children),
        modality=" ".join(modal_tokens),
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


def parse_spacy(text: str) -> ParsedSentence | None:
    """返回逻辑分句树；模型不可用时返回 ``None``。"""
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

    roots = _clause_roots(doc, main_root)
    repaired_relative = _repaired_relative(doc, source, main_root)
    bounds = {root.i: _subtree_bounds(root) for root in roots}
    roots.sort(key=lambda token: bounds[token.i])
    root_ids = {main_root.i: "c0"}
    root_ids.update({root.i: f"c{index}" for index, root in enumerate(roots, start=1)})

    main_tokens = _own_tokens(doc, main_root, roots, main_root)
    if repaired_relative:
        main_tokens = [
            token
            for token in main_tokens
            if not (repaired_relative["start"] <= token.idx < repaired_relative["end"])
        ]
    main_segments = _segments(source, main_tokens)
    main_grammar = _grammar(main_root, main_root)
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
            confidence=0.96,
        )
    ]

    for root in roots:
        start, end = bounds[root.i]
        marker = _marker(root, source)
        relation, warnings = _relation(root, marker)
        parent_root = _nearest_clause_parent(root, roots, main_root)
        own_segments = _segments(source, _own_tokens(doc, root, roots, main_root))
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
                grammar=_grammar(root, main_root),
                confidence=0.72 if relation == "ambiguous" else 0.93,
                warnings=warnings,
            )
        )

    if repaired_relative:
        nodes.append(
            ClauseNode(
                id=f"c{len(roots) + 1}",
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
    )
