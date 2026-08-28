# -*- coding: utf-8 -*-
"""在线免费词典查询（dictionaryapi.dev），带磁盘缓存与优雅降级。

仅在用户右击单词查看详情时由 /api/word-info 调用；整句翻译路径
（translator.py / /api/analyze）不依赖本模块，保证翻译性能不受网络影响。
网络不可用、超时或 API 未收录时返回 None，由调用方回退到本地词表。
"""

from __future__ import annotations

import json
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from itertools import pairwise
from pathlib import Path
from typing import Any

API_URL = "https://api.dictionaryapi.dev/api/v2/entries/en/{word}"
TIMEOUT_SECONDS = 2.5
MAX_CACHE_ENTRIES = 2000
NOT_FOUND_TTL_SECONDS = 24 * 3600  # API 明确未收录：一天内不再重试
ERROR_TTL_SECONDS = 3600           # 网络错误：一小时后允许重试；命中缓存永久有效
MAX_POS_ENTRIES = 4
MAX_DEFINITIONS_PER_POS = 3
MAX_EXAMPLES_PER_POS = 2
MAX_SYNONYMS = 8
MAX_COLLOCATIONS = 6
MAX_FIELD_CHARS = 300

_WORD_RE = re.compile(r"[a-z][a-z'-]*")
# 动词/名词后接介词是最常见的搭配形态，从例句中轻量抽取。
_FOLLOW_PREPOSITIONS = {
    "in", "on", "at", "with", "to", "for", "from", "of", "by", "between",
    "into", "over", "under", "against", "across", "within",
}
_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z'-]*")


def _clip(value: Any, limit: int = MAX_FIELD_CHARS) -> str:
    text = " ".join(str(value or "").split())
    return text[:limit].rstrip()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_time(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _as_list(value: Any) -> list:
    return value if isinstance(value, list) else []


def _append_synonyms(raw_synonyms: Any, synonyms: list[str]) -> None:
    for raw_synonym in _as_list(raw_synonyms):
        text = _clip(raw_synonym, 80)
        if text and text not in synonyms:
            synonyms.append(text)


def _entry_phonetic(entry: dict) -> str:
    phonetic = _clip(entry.get("phonetic"), 80)
    if phonetic:
        return phonetic
    for item in _as_list(entry.get("phonetics")):
        if isinstance(item, dict) and item.get("text"):
            return _clip(item["text"], 80)
    return ""


def _normalize_meaning(meaning: Any) -> dict[str, Any] | None:
    if not isinstance(meaning, dict):
        return None
    definitions: list[str] = []
    examples: list[str] = []
    synonyms: list[str] = []
    _append_synonyms(meaning.get("synonyms"), synonyms)
    for definition in _as_list(meaning.get("definitions")):
        if not isinstance(definition, dict):
            continue
        text = _clip(definition.get("definition"))
        if text and len(definitions) < MAX_DEFINITIONS_PER_POS:
            definitions.append(text)
        example = _clip(definition.get("example"))
        if example and len(examples) < MAX_EXAMPLES_PER_POS:
            examples.append(example)
        _append_synonyms(definition.get("synonyms"), synonyms)
    if not definitions and not examples:
        return None
    return {
        "pos": _clip(meaning.get("partOfSpeech"), 40) or "unknown",
        "definitions": definitions,
        "examples": examples,
        "synonyms": synonyms[:MAX_SYNONYMS],
    }


def _normalize(payload: Any, word: str) -> dict[str, Any] | None:
    """把 dictionaryapi.dev 的响应裁剪为本项目的内部 schema。"""
    if not isinstance(payload, list) or not payload:
        return None
    phonetic = ""
    pos_entries: list[dict[str, Any]] = []
    for entry in payload:
        if not isinstance(entry, dict):
            continue
        if not phonetic:
            phonetic = _entry_phonetic(entry)
        for meaning in _as_list(entry.get("meanings")):
            normalized = _normalize_meaning(meaning)
            if normalized:
                pos_entries.append(normalized)
    if not pos_entries:
        return None
    pos_entries = pos_entries[:MAX_POS_ENTRIES]
    collocations = _extract_collocations(
        (example for entry in pos_entries for example in entry["examples"]), word,
    )
    return {
        "word": word,
        "phonetic": phonetic,
        "pos_entries": pos_entries,
        "collocations": collocations,
        "source": "dictionaryapi.dev",
    }


def _extract_collocations(examples: Any, word: str) -> list[str]:
    """从例句中抽取“目标词 + 后续介词”形式的常见搭配，查不到时留空。"""
    found: list[str] = []
    for example in examples:
        lowered = [token.lower() for token in _TOKEN_RE.findall(str(example))]
        for token, following in pairwise(lowered):
            if token != word:
                continue
            if following in _FOLLOW_PREPOSITIONS:
                pair = f"{word} {following}"
                if pair not in found:
                    found.append(pair)
            if len(found) >= MAX_COLLOCATIONS:
                return found
    return found


class OnlineDictionary:
    """内存 → 磁盘 → 网络 三级查询；网络等待不持锁，失败一律返回 None。"""

    def __init__(self, cache_path: str | Path):
        self.cache_path = Path(cache_path)
        self._mem: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._load_cache()

    def lookup(self, word: str) -> dict[str, Any] | None:
        key = str(word or "").strip().lower()
        if not _WORD_RE.fullmatch(key):
            return None
        with self._lock:
            cached = self._mem.get(key)
        if cached and not self._expired(cached):
            return cached.get("result")
        status, result = self._fetch(key)
        record = {"fetched_at": _now().isoformat(), "status": status, "result": result}
        with self._lock:
            self._mem[key] = record
            while len(self._mem) > MAX_CACHE_ENTRIES:
                del self._mem[next(iter(self._mem))]  # FIFO：dict 保持插入序
            try:
                self._save_cache()
            except OSError:
                pass  # 缓存写失败不影响本次查询结果
        return result

    @staticmethod
    def _expired(record: dict[str, Any]) -> bool:
        status = record.get("status") or ("hit" if record.get("result") else "error")
        if status == "hit":
            return False  # 词典数据几乎不变，命中缓存永久有效
        fetched = _parse_time(str(record.get("fetched_at", "")))
        if fetched is None:
            return True
        ttl = NOT_FOUND_TTL_SECONDS if status == "not_found" else ERROR_TTL_SECONDS
        return (_now() - fetched).total_seconds() > ttl

    def _fetch(self, word: str) -> tuple[str, dict[str, Any] | None]:
        """返回 (状态, 结果)：状态区分 hit / not_found / error，供缓存 TTL 使用。"""
        url = API_URL.format(word=urllib.parse.quote(word))
        http_request = urllib.request.Request(url, headers={"User-Agent": "parse-spec/1.0"})
        try:
            with urllib.request.urlopen(http_request, timeout=TIMEOUT_SECONDS) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            return ("not_found" if exc.code == 404 else "error"), None
        except (urllib.error.URLError, OSError, ValueError):
            return "error", None
        try:
            result = _normalize(payload, word)
        except Exception:
            return "error", None  # 畸形响应也按失败处理，不穿透到路由
        return ("hit", result) if result else ("not_found", None)

    def _load_cache(self) -> None:
        if not self.cache_path.exists():
            return
        try:
            value = json.loads(self.cache_path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError):
            return
        if not isinstance(value, dict):
            return
        for key, record in value.items():
            if isinstance(record, dict) and "result" in record:
                self._mem[str(key)] = record

    def _save_cache(self) -> None:
        temporary_path = self.cache_path.with_suffix(self.cache_path.suffix + ".tmp")
        temporary_path.write_text(
            json.dumps(self._mem, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
        )
        temporary_path.replace(self.cache_path)
