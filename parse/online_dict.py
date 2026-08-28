# -*- coding: utf-8 -*-
"""在线免费词典查询（有道词典 → dictionaryapi.dev 多源回退），带磁盘缓存与优雅降级。

仅在用户右击单词查看详情或添加复杂词建议释义时，由 /api/word-info 与
/api/complex-words/suggest 调用；整句翻译路径（translator.py / /api/analyze）
不依赖本模块，保证翻译性能不受网络影响。
全部源都不可用、超时或未收录时返回 None，由调用方回退到本地词表。

多源说明：默认先查境内稳定可达的有道词典（youdao），未命中再查
dictionaryapi.dev（freeapi）；某源网络失败后会熔断跳过一段时间，避免每次
查询都白等超时。可用环境变量 PARSE_SPEC_DICT_SOURCES 调整顺序，例如
`PARSE_SPEC_DICT_SOURCES=freeapi,youdao`。
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from itertools import pairwise
from pathlib import Path
from typing import Any

API_URL = "https://api.dictionaryapi.dev/api/v2/entries/en/{word}"
YOUDAO_URL = "https://dict.youdao.com/jsonapi?q={word}&doctype=json"
TIMEOUT_SECONDS = 2.5
MAX_CACHE_ENTRIES = 2000
NOT_FOUND_TTL_SECONDS = 24 * 3600  # API 明确未收录：一天内不再重试
ERROR_TTL_SECONDS = 3600           # 网络错误：一小时后允许重试；命中缓存永久有效
BREAKER_COOLDOWN_SECONDS = 30 * 60  # 单源网络失败后熔断跳过的时长
SOURCE_ENV = "PARSE_SPEC_DICT_SOURCES"
DEFAULT_SOURCES = ("youdao", "freeapi")
MAX_POS_ENTRIES = 4
MAX_DEFINITIONS_PER_POS = 3
MAX_EXAMPLES_PER_POS = 2
MAX_EXAMPLES = 4
MAX_SYNONYMS = 8
MAX_COLLOCATIONS = 6
MAX_ZH_GLOSSES = 6
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


# ---------------------------------------------------------------------------
# 有道词典（youdao jsonapi）：境内稳定可达，提供音标、中文释义、WordNet
# 英文释义、同义词与双语例句；未收录时返回 200 但 ec/ee 为空。
# ---------------------------------------------------------------------------

def _youdao_zh_glosses(ec: dict) -> list[str]:
    """ec.word[].trs[].tr[].l.i 形如 “adv. 笼统地，大概；通常，普遍地”。"""
    glosses: list[str] = []
    for item in _as_list(ec.get("word")):
        if not isinstance(item, dict):
            continue
        for tr in _as_list(item.get("trs")):
            for sub in _as_list(tr.get("tr")) if isinstance(tr, dict) else []:
                value = ""
                if isinstance(sub, dict) and isinstance(sub.get("l"), dict):
                    inner = sub["l"].get("i")
                    value = "".join(inner) if isinstance(inner, list) else str(inner or "")
                text = _clip(value, 120)
                if text and text not in glosses:
                    glosses.append(text)
    return glosses[:MAX_ZH_GLOSSES]


def _youdao_pos_entries(ee: dict) -> list[dict[str, Any]]:
    """ee（WordNet）提供英文释义与同义词：ee.word.trs[].pos + tr[].l.i。"""
    word = ee.get("word") if isinstance(ee.get("word"), dict) else {}
    entries: list[dict[str, Any]] = []
    for tr in _as_list(word.get("trs")):
        if not isinstance(tr, dict) or len(entries) >= MAX_POS_ENTRIES:
            break
        definitions: list[str] = []
        synonyms: list[str] = []
        for sub in _as_list(tr.get("tr")):
            if not isinstance(sub, dict):
                continue
            label = sub.get("l") if isinstance(sub.get("l"), dict) else {}
            text = _clip(label.get("i"))
            if text and len(definitions) < MAX_DEFINITIONS_PER_POS:
                definitions.append(text)
            for similar in _as_list(sub.get("similar-words")):
                synonym = _clip(similar.get("similar"), 80) if isinstance(similar, dict) else ""
                if synonym and synonym not in synonyms:
                    synonyms.append(synonym)
        if definitions or synonyms:
            entries.append({
                "pos": _clip(tr.get("pos"), 40) or "unknown",
                "definitions": definitions,
                "examples": [],
                "synonyms": synonyms[:MAX_SYNONYMS],
            })
    return entries


def _youdao_examples(block: Any) -> list[str]:
    """blng_sents_part.sentence-pair[] 的双语例句，拼成 “英文（中文）”。"""
    pairs = _as_list(block.get("sentence-pair")) if isinstance(block, dict) else []
    examples: list[str] = []
    for pair in pairs[:MAX_EXAMPLES]:
        if not isinstance(pair, dict):
            continue
        sentence = _clip(pair.get("sentence"))
        if not sentence:
            continue
        translation = _clip(pair.get("sentence-translation"))
        examples.append(f"{sentence}（{translation}）" if translation else sentence)
    return examples


def _normalize_youdao(payload: Any, word: str) -> dict[str, Any] | None:
    """把有道 jsonapi 的响应裁剪为本项目的内部 schema，未收录时返回 None。"""
    if not isinstance(payload, dict):
        return None
    ec = payload.get("ec") if isinstance(payload.get("ec"), dict) else {}
    ee = payload.get("ee") if isinstance(payload.get("ee"), dict) else {}
    has_ec = bool(ec.get("word"))
    ee_word = ee.get("word") if isinstance(ee.get("word"), dict) else {}
    if not has_ec and not ee_word:
        return None  # 有道对未收录词返回 200 但无词典数据
    phonetic = ""
    for item in _as_list(ec.get("word")):
        if isinstance(item, dict) and (item.get("usphone") or item.get("ukphone")):
            phone = _clip(item.get("usphone") or item.get("ukphone"), 80)
            if phone:
                phonetic = f"/{phone}/"
            break
    pos_entries = _youdao_pos_entries(ee)
    examples = _youdao_examples(payload.get("blng_sents_part"))
    zh_gloss = _youdao_zh_glosses(ec)
    if not pos_entries and not examples and not zh_gloss:
        return None
    return {
        "word": word,
        "phonetic": phonetic,
        "pos_entries": pos_entries,
        "examples": examples,
        "collocations": _extract_collocations(examples, word),
        "zh_gloss": zh_gloss,
        "source": "youdao",
    }


def _fetch_youdao(word: str) -> tuple[str, dict[str, Any] | None]:
    """返回 (状态, 结果)：状态区分 hit / not_found / error，供缓存 TTL 使用。"""
    url = YOUDAO_URL.format(word=urllib.parse.quote(word))
    http_request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (parse-spec dictionary client)"})
    try:
        with urllib.request.urlopen(http_request, timeout=TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return ("not_found" if exc.code == 404 else "error"), None
    except (urllib.error.URLError, OSError, ValueError):
        return "error", None
    try:
        result = _normalize_youdao(payload, word)
    except Exception:
        return "error", None  # 畸形响应也按失败处理，不穿透到路由
    return ("hit", result) if result else ("not_found", None)


def _fetch_freeapi(word: str) -> tuple[str, dict[str, Any] | None]:
    """dictionaryapi.dev 源，行为与旧单源实现一致。"""
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
        return "error", None
    return ("hit", result) if result else ("not_found", None)


PROVIDERS = {"youdao": _fetch_youdao, "freeapi": _fetch_freeapi}


class OnlineDictionary:
    """内存 → 磁盘 → 多源网络 三级查询；网络等待不持锁，失败一律返回 None。"""

    def __init__(self, cache_path: str | Path, sources: list[str] | tuple[str, ...] | None = None):
        self.cache_path = Path(cache_path)
        if sources is None:
            raw = os.environ.get(SOURCE_ENV, "")
            sources = [name.strip() for name in raw.split(",") if name.strip()]
        self.sources = list(dict.fromkeys(name for name in sources if name in PROVIDERS)) or list(DEFAULT_SOURCES)
        self._cooldown: dict[str, float] = {}
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
        """按配置顺序查询各源：命中即返回；网络错误熔断该源后继续尝试下一个。"""
        saw_not_found = False
        saw_error = False
        for name in self.sources:
            fetch = PROVIDERS.get(name)
            if fetch is None:
                continue
            if self._cooldown.get(name, 0.0) > time.monotonic():
                saw_error = True  # 熔断中的源按失败计，整词稍后仍允许重试
                continue
            status, result = fetch(word)
            if status == "hit":
                self._clear_breaker(name)
                return status, result
            if status == "error":
                saw_error = True
                self._trip_breaker(name)
            else:
                saw_not_found = True
                self._clear_breaker(name)
        return ("not_found", None) if (saw_not_found and not saw_error) else ("error", None)

    def _trip_breaker(self, name: str) -> None:
        with self._lock:
            self._cooldown[name] = time.monotonic() + BREAKER_COOLDOWN_SECONDS

    def _clear_breaker(self, name: str) -> None:
        with self._lock:
            self._cooldown.pop(name, None)

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
