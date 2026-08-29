# -*- coding: utf-8 -*-
"""可选的在线 LLM 分句树精修层。

本地解析始终即时返回；本层供后台异步调用：把句子交给可配置的
OpenAI 兼容大模型重排逻辑分句树，经严格校验（每个分句文本必须是
原句的精确子串）后构建 ParsedSentence，结果写入磁盘缓存，命中后
不再联网。未配置环境变量时整层静默关闭；网络连续失败会熔断，
绝不阻塞或拖慢主解析路径。
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse

LOGGER = logging.getLogger(__name__)

BASE_URL_ENV = "PARSE_SPEC_LLM_BASE_URL"
API_KEY_ENV = "PARSE_SPEC_LLM_API_KEY"
MODEL_ENV = "PARSE_SPEC_LLM_MODEL"
TIMEOUT_ENV = "PARSE_SPEC_LLM_TIMEOUT"

DEFAULT_MODEL = "glm-4-flash"
DEFAULT_TIMEOUT_SECONDS = 6.0
MAX_SENTENCE_CHARS = 10_000
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_CACHE_ENTRIES = 2000
ERROR_TTL_SECONDS = 3600            # 网络错误负缓存：一小时后允许重试；命中缓存永久有效
BREAKER_THRESHOLD = 3               # 连续网络失败次数达到阈值后熔断
BREAKER_COOLDOWN_SECONDS = 30 * 60

# 调整提示词后递增版本号，使旧缓存自然失效。
PROMPT_VERSION = 1

MAX_CLAUSES = 16
ALLOWED_RELATIONS = frozenset({
    "main", "concession", "condition", "time", "cause", "purpose",
    "result", "relative", "content", "complement", "basis", "means", "ambiguous",
})

_SYSTEM_PROMPT = """你是英文技术规格文档的句法分析器。分析用户给出的英文句子，输出它的逻辑分句树。
只输出一个 JSON 对象，不要解释，不要 Markdown 代码块标记。
格式：
{"clauses": [{
  "id": "c0",
  "parent_id": null,
  "relation": "main",
  "marker": "",
  "text": "原句的精确子串",
  "subject": "", "predicate": "", "object": "", "complement": "", "agent": "",
  "voice": "active",
  "negated": false
}]}
硬性要求：
1. 主句 id 必须是 c0 且 relation 为 main、parent_id 为 null；其余分句的 parent_id 指向直接包含它的分句。
2. 每个分句的 text 必须逐字符取自原句（含原有标点），不得改写、增删或合并；所有分句的 text 连起来应覆盖整句。
3. relation 只能取：main/concession/condition/time/cause/purpose/result/relative/content/complement/basis/means/ambiguous。
4. marker 是引导词（如 although、to、by、when、that），没有就填空字符串。
5. subject/predicate/object/complement/agent 从该分句自身（不含子分句）提取，找不到就填空字符串。
6. voice 只能是 active 或 passive；分句含 not/never 等否定时 negated 为 true。
7. 逻辑关系拿不准时用 ambiguous。"""


def _now() -> datetime:
    return datetime.now()


def _configured_timeout() -> float:
    raw = os.environ.get(TIMEOUT_ENV, "").strip()
    if not raw:
        return DEFAULT_TIMEOUT_SECONDS
    try:
        value = float(raw)
    except ValueError:
        return DEFAULT_TIMEOUT_SECONDS
    return value if value > 0 else DEFAULT_TIMEOUT_SECONDS


def _configured_model() -> str:
    model = os.environ.get(MODEL_ENV, "").strip()
    return model or DEFAULT_MODEL


def _is_loopback(host: str) -> bool:
    return host in {"127.0.0.1", "localhost", "::1"}


def _is_allowed_endpoint(url: str) -> bool:
    """只允许 https 公网端点，或本地回环 http（本地开发代理）。"""
    parsed = urlparse(url)
    if parsed.scheme not in {"https", "http"} or not parsed.hostname:
        return False
    if parsed.scheme == "http":
        return _is_loopback(parsed.hostname)
    return True


class _BlockRedirects(urllib.request.HTTPRedirectHandler):
    """LLM 端点不接受重定向，防止 key 经由跳转外泄。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(newurl, code, "LLM 端点不允许重定向", headers, fp)


def _extract_json(content: str) -> dict | None:
    text = content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        payload = json.loads(text[start : end + 1])
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None


class LlmRefiner:
    """带磁盘缓存与熔断的在线分句树精修器。"""

    def __init__(self, cache_path: str | Path):
        self._cache_path = Path(cache_path)
        self._mem: dict[str, dict] = {}
        self._load_cache()
        self._consecutive_errors = 0
        self._breaker_until: float | None = None

    # ---- 配置 ----

    def enabled(self) -> bool:
        return bool(
            os.environ.get(BASE_URL_ENV, "").strip()
            and os.environ.get(API_KEY_ENV, "").strip()
        )

    def model_name(self) -> str:
        return _configured_model()

    def breaker_active(self) -> bool:
        return self._breaker_until is not None and time.monotonic() < self._breaker_until

    # ---- 对外入口 ----

    def refine(self, sentence: str, local):
        """返回精修后的 ParsedSentence；不可用时返回 None（调用方保留本地结果）。"""
        from .clauser import ParsedSentence

        text = sentence.strip()
        if not text or len(text) > MAX_SENTENCE_CHARS or not self.enabled():
            return None
        if self.breaker_active():
            return None
        key = self._cache_key(text)
        record = self._mem.get(key)
        if record is not None and not self._expired(record):
            if record.get("status") == "hit":
                return self._build_parsed(text, record.get("payload"), local, self.model_name())
            return None

        status, payload = self._call_api(text)
        record = {"fetched_at": _now().isoformat(), "status": status}
        if status == "hit":
            record["payload"] = payload
            self._consecutive_errors = 0
        else:
            self._note_failure()
        self._mem[key] = record
        self._trim()
        self._save()
        if status != "hit":
            return None
        return self._build_parsed(text, payload, local, self.model_name())

    # ---- 网络请求 ----

    def _call_api(self, text: str) -> tuple[str, dict | None]:
        base = os.environ.get(BASE_URL_ENV, "").strip().rstrip("/")
        key = os.environ.get(API_KEY_ENV, "").strip()
        url = f"{base}/chat/completions"
        if not _is_allowed_endpoint(url):
            LOGGER.warning("PARSE_SPEC_LLM_BASE_URL 非法（仅允许 https 公网或回环 http），已忽略精修请求")
            return "error", None
        body = json.dumps({
            "model": _configured_model(),
            "messages": [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ],
            "temperature": 0,
        }).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {key}",
                "User-Agent": "parse-spec-refine/1",
            },
        )
        try:
            opener = urllib.request.build_opener(_BlockRedirects)
            with opener.open(request, timeout=_configured_timeout()) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                LOGGER.warning("LLM 精修响应超过大小上限")
                return "error", None
            data = json.loads(raw.decode("utf-8", "replace"))
            content = data["choices"][0]["message"]["content"]
            if not isinstance(content, str):
                LOGGER.warning("LLM 精修返回的 content 不是字符串")
                return "error", None
        except (OSError, urllib.error.HTTPError, KeyError, IndexError, TypeError, ValueError) as exc:
            LOGGER.warning("LLM 精修请求失败：%s", f"{type(exc).__name__}: {exc}")
            return "error", None
        payload = _extract_json(content)
        if payload is None:
            LOGGER.warning("LLM 精修返回内容不是有效 JSON")
            return "error", None
        return "hit", payload

    def _note_failure(self) -> None:
        self._consecutive_errors += 1
        if self._consecutive_errors >= BREAKER_THRESHOLD:
            self._breaker_until = time.monotonic() + BREAKER_COOLDOWN_SECONDS
            self._consecutive_errors = 0
            LOGGER.warning("LLM 精修连续失败，熔断 %d 分钟", BREAKER_COOLDOWN_SECONDS // 60)

    # ---- 结果构建与校验 ----

    def _build_parsed(self, sentence: str, payload: dict | None, local, model: str):
        """把 LLM 输出严格校验后转为 ParsedSentence；任何一步不符即整体弃用。"""
        from .clauser import ClauseNode, ParsedSentence, _RELATION_LABELS

        if not isinstance(payload, dict):
            return None
        clauses_payload = payload.get("clauses")
        if not isinstance(clauses_payload, list) or not 1 <= len(clauses_payload) <= MAX_CLAUSES:
            return None
        source = sentence.strip()
        located: list[tuple[str, dict, tuple[int, int]]] = []
        seen_ids: set[str] = set()
        for item in clauses_payload:
            if not isinstance(item, dict):
                return None
            cid = str(item.get("id", "")).strip()
            clause_text = str(item.get("text", "")).strip()
            if not cid or cid in seen_ids or not clause_text:
                return None
            start = source.find(clause_text)
            if start < 0:
                return None  # 精确子串校验失败：疑似幻觉，整体弃用
            seen_ids.add(cid)
            located.append((cid, item, (start, start + len(clause_text))))
        if "c0" not in seen_ids:
            return None
        by_id = {cid: (item, span) for cid, item, span in located}
        c0_item, c0_span = by_id["c0"]
        if str(c0_item.get("relation", "")) != "main":
            return None

        warnings = [f"分句结构由在线模型 {model} 精修，请结合原文确认关键判断"]
        nodes: list[ClauseNode] = []
        for order, (cid, item, span) in enumerate(located):
            start, end = span
            clause_text = source[start:end]
            relation = str(item.get("relation", "")).strip()
            if relation not in ALLOWED_RELATIONS:
                relation = "ambiguous"
            parent_id = str(item.get("parent_id") or "").strip() or None
            if cid == "c0":
                parent_id = None
            elif parent_id not in by_id:
                parent_id = "c0"
            else:
                parent_span = by_id[parent_id][1]
                # 子分句必须落在父分句范围内，否则退回挂在主句上。
                if start < parent_span[0] or end > parent_span[1]:
                    parent_id = "c0"
            marker = str(item.get("marker", "")).strip()
            grammar = self._grammar_for(clause_text, item)
            nodes.append(
                ClauseNode(
                    id=cid,
                    parent_id=parent_id,
                    order=start,
                    text=clause_text,
                    start=start,
                    end=end,
                    segments=[(start, end)],
                    kind="main" if cid == "c0" else "advcl",
                    relation=relation,
                    label=_RELATION_LABELS.get(relation, relation),
                    marker=marker,
                    grammar=grammar,
                    confidence=0.85 if relation != "ambiguous" else 0.7,
                    warnings=[],
                )
            )
        nodes.sort(key=lambda node: (node.parent_id is not None, node.order))
        return ParsedSentence(
            text=source,
            clauses=nodes,
            main_clause_id="c0",
            engine="spacy",
            warnings=warnings,
            term_candidates=list(local.term_candidates) if local is not None else [],
            lemma_spans=list(local.lemma_spans) if local is not None else [],
            refined_by=model,
        )

    def _grammar_for(self, clause_text: str, item: dict):
        from .clauser import Grammar, _rule_grammar

        subject = str(item.get("subject", "")).strip()
        predicate = str(item.get("predicate", "")).strip()
        obj = str(item.get("object", "")).strip()
        complement = str(item.get("complement", "")).strip()
        agent = str(item.get("agent", "")).strip()
        rule = _rule_grammar(clause_text, subject, predicate)
        voice = "passive" if str(item.get("voice", "")).strip().lower() == "passive" else rule.voice
        return Grammar(
            subject=subject,
            predicate=predicate,
            object=obj,
            direct_object=obj,
            complement=complement,
            agent=agent,
            voice=voice,
            negated=bool(item.get("negated")) or rule.negated,
            modality=rule.modality,
            auxiliaries=rule.auxiliaries,
            requirement_level=rule.requirement_level,
            evidence_sources=["llm", "technical-rule"],
            agreement="llm-rule",
        )

    # ---- 磁盘缓存 ----

    def _cache_key(self, text: str) -> str:
        material = json.dumps(
            {"v": PROMPT_VERSION, "model": _configured_model(), "text": text},
            ensure_ascii=False,
            sort_keys=True,
        )
        return hashlib.sha256(material.encode("utf-8")).hexdigest()

    @staticmethod
    def _expired(record: dict) -> bool:
        if record.get("status") == "hit":
            return False
        fetched = record.get("fetched_at", "")
        try:
            moment = datetime.fromisoformat(fetched)
        except ValueError:
            return True
        return _now() - moment > timedelta(seconds=ERROR_TTL_SECONDS)

    def _load_cache(self) -> None:
        try:
            raw = json.loads(self._cache_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if isinstance(raw, dict):
            self._mem = {str(k): v for k, v in raw.items() if isinstance(v, dict)}

    def _trim(self) -> None:
        if len(self._mem) <= MAX_CACHE_ENTRIES:
            return
        keep = sorted(
            self._mem.items(),
            key=lambda item: item[1].get("fetched_at", ""),
            reverse=True,
        )[:MAX_CACHE_ENTRIES]
        self._mem = dict(keep)

    def _save(self) -> None:
        if not self._mem:
            return
        temp_path = self._cache_path.with_suffix(".json.tmp")
        try:
            temp_path.write_text(
                json.dumps(self._mem, ensure_ascii=False, sort_keys=True),
                encoding="utf-8",
            )
            temp_path.replace(self._cache_path)
        except OSError as exc:
            LOGGER.warning("精修缓存写入失败：%s", exc)
