# -*- coding: utf-8 -*-
"""parse-spec 服务端。

职责：接收前端发来的英文句子文本，做断句/成分/词义解析，返回结构化 JSON。
坐标与悬浮命中全部由前端(pdf.js)自行处理，因此本服务无需接收 PDF，
只需做"纯文本分析"，职责清晰、完全离线。

运行：python server.py。默认使用 http://127.0.0.1:5197，端口被系统保留时自动回退。
"""

from __future__ import annotations

import os
import json
import re
import socket
import threading
from dataclasses import asdict
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
import sys


try:
    from flask import Flask, jsonify, request, send_from_directory
except ModuleNotFoundError as exc:
    if exc.name != "flask" or __name__ != "__main__":
        raise
    project_root = Path(__file__).resolve().parent
    candidates = (
        project_root / ".venv" / "Scripts" / "python.exe",
        project_root / ".venv" / "bin" / "python",
    )
    project_python = next((path for path in candidates if path.exists()), None)
    if project_python is None:
        raise SystemExit(
            "缺少 Flask。请先执行：\n"
            "  uv venv --python 3.11 .venv\n"
            "  uv pip install --python .venv\\Scripts\\python.exe "
            "-r requirements.txt .\\vendor\\en_core_web_sm-3.8.0-py3-none-any.whl"
        ) from exc
    command = [str(project_python), str(Path(__file__).resolve()), *sys.argv[1:]]
    if os.name == "nt":
        # Windows 的商店版 Python 对 os.execv 的进程接管行为不稳定，显式等待子进程。
        import subprocess

        child = subprocess.Popen(command)
        try:
            raise SystemExit(child.wait())
        except KeyboardInterrupt:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
            raise SystemExit(130) from None
    os.execv(str(project_python), command)

from parse import spacy_worker
from parse.complex_words import BUILTIN as COMPLEX_WORD_BUILTIN, ComplexWordTable, extract_complex_words, lemma_for_word
from parse.glossary import BUILTIN as GLOSSARY_BUILTIN, Glossary
from parse.llm_refine import LlmRefiner
from parse.online_dict import OnlineDictionary
from parse.translation_corpus import default_corpus
from parse.translator import lookup_word_translation, translate_sentence

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")
DATA_DIR = Path(BASE) / "data"

# 历史版本把用户数据 JSON 散落在项目根目录；首次升级时统一搬入 data/ 管理。
_USER_DATA_FILES = (
    "bookmarks.json",
    "glossary.json",
    "complex_words.json",
    "translation_corpus.json",
    "word_cache.json",
    "parse_cache.json",
)


def _migrate_user_data_files() -> None:
    """根目录的历史用户数据 JSON 迁入 data/；新位置已存在时不覆盖。"""
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
    except OSError:
        return  # data/ 建不出来时保持旧路径行为，避免阻塞启动
    for name in _USER_DATA_FILES:
        legacy = Path(BASE) / name
        target = DATA_DIR / name
        if legacy.is_file() and not target.exists():
            try:
                legacy.replace(target)
            except OSError:
                pass  # 单个文件迁移失败不阻塞启动，旧文件留在根目录仍可读


_migrate_user_data_files()

app = Flask(__name__, static_folder=None)

_glossary_path = DATA_DIR / "glossary.json"
_glossary = Glossary(str(_glossary_path))  # 用户可自定义
_glossary_signature: tuple[int, int] | None = None
_glossary_backup_dir = Path(BASE) / "backups" / "glossary"
_complex_words_path = DATA_DIR / "complex_words.json"
_complex_words = ComplexWordTable(_complex_words_path)
_complex_words_signature: tuple[int, int] | None = None
_bookmarks_path = DATA_DIR / "bookmarks.json"
_word_cache_path = DATA_DIR / "word_cache.json"
_online_dict = OnlineDictionary(_word_cache_path)
_parse_cache_path = DATA_DIR / "parse_cache.json"
_llm_refiner = LlmRefiner(_parse_cache_path)
_feedback_path = DATA_DIR / "sentence_feedback.json"
MAX_SENTENCES = 32
MAX_SENTENCE_CHARS = 10_000
MAX_REQUEST_BYTES = 400_000
MAX_GLOSSARY_WORD_CHARS = 120
MAX_GLOSSARY_FIELD_CHARS = 800
MAX_BOOKMARK_DOCUMENT_KEY_CHARS = 500
MAX_BOOKMARKS_PER_DOCUMENT = 2_000
MAX_BOOKMARK_TEXT_CHARS = 10_000
MAX_BOOKMARK_NAME_CHARS = 200
MAX_GLOSSARY_BACKUPS = 30
MAX_FEEDBACK_NOTE_CHARS = 2_000
MAX_FEEDBACK_ITEMS = 2_000
MAX_FEEDBACK_SIGNALS = 10
MAX_FEEDBACK_RELATIONS = 32
DEFAULT_PORT = 5197
FALLBACK_PORTS = (5800, 5801, 5802, 8000, 8765)
app.config["MAX_CONTENT_LENGTH"] = MAX_REQUEST_BYTES


def _can_bind_local(port: int) -> bool:
    """启动前探测本地端口，兼容 Windows 动态排除端口范围。"""
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        probe.close()


def _prefer_trf_model() -> str:
    """未显式指定解析模型时，若已安装 en_core_web_trf 则优先使用。

    只影响 server 进程及其解析工作子进程（经环境变量传递）；测试与直接
    导入 parse 的场景不受影响，仍然使用 en_core_web_sm 保证结果稳定。
    返回最终生效的模型名。
    """
    if os.environ.get("PARSE_SPEC_SPACY_MODEL", "").strip():
        return os.environ["PARSE_SPEC_SPACY_MODEL"].strip()
    try:
        import importlib.util

        if importlib.util.find_spec("en_core_web_trf") and importlib.util.find_spec("spacy_transformers"):
            os.environ["PARSE_SPEC_SPACY_MODEL"] = "en_core_web_trf"
            return "en_core_web_trf"
    except (ImportError, ValueError):
        pass
    return "en_core_web_sm"


def _select_local_port() -> int:
    configured = os.environ.get("PARSE_SPEC_PORT", "").strip()
    if configured:
        try:
            port = int(configured)
        except ValueError as exc:
            raise SystemExit("PARSE_SPEC_PORT 必须是 1–65535 的整数") from exc
        if not 1 <= port <= 65535:
            raise SystemExit("PARSE_SPEC_PORT 必须是 1–65535 的整数")
        if not _can_bind_local(port):
            raise SystemExit(f"指定端口 {port} 无法绑定，请更换 PARSE_SPEC_PORT")
        return port
    for port in (DEFAULT_PORT, *FALLBACK_PORTS):
        if _can_bind_local(port):
            return port
    raise SystemExit("常用本地端口均无法绑定，请设置 PARSE_SPEC_PORT 后重试")


def _build_result(ps) -> dict:
    """把 ParsedSentence 转为 schema v3 响应（/api/analyze 与 /api/refine 共用）。"""
    # 优先使用 spaCy 的原始词形与 lemma；规则降级结果也提供同构候选词。
    words_hit = {}
    for tok, lemma in ps.term_candidates:
        d = _glossary.lookup(tok)
        if d is None and lemma and lemma.lower() != tok.lower():
            d = _glossary.lookup(lemma)
            if d is not None:
                d = {**d, "word": tok, "variant": True}
        if d and tok.lower() not in words_hit:
            words_hit[tok.lower()] = d
    words = sorted(words_hit.values(), key=lambda x: (x["pos"], x["word"]))
    result = {
        "schema_version": 3,
        "text": ps.text,
        "engine": ps.engine,
        "main_clause_id": ps.main_clause_id,
        "clauses": [asdict(clause) for clause in ps.clauses],
        "terms": words,
        "complex_words": extract_complex_words(ps.text, _complex_words, ps.lemma_spans),
        "translation": translate_sentence(ps, _glossary),
        "warnings": ps.warnings,
    }
    if ps.refined_by:
        result["refined_by"] = ps.refined_by
    if ps.qa:
        result["qa"] = ps.qa
    return result


@lru_cache(maxsize=1024)
def _analyze_sentence(s: str) -> dict:
    sentence = s.strip()
    # 服务直接运行时解析在隔离工作进程中限时执行；测试与导入场景走同步路径。
    ps = spacy_worker.parse_isolated_or_direct(sentence)
    return _build_result(ps)


def _current_glossary_signature() -> tuple[int, int] | None:
    try:
        stat = _glossary_path.stat()
        return stat.st_mtime_ns, stat.st_size
    except OSError:
        return None


def _refresh_glossary_if_changed() -> None:
    """在用户保存词典后自动重载，并清除包含旧词义的分析缓存。"""
    global _glossary, _glossary_signature
    signature = _current_glossary_signature()
    if signature == _glossary_signature:
        return
    _glossary = Glossary(str(_glossary_path))
    _glossary_signature = signature
    _analyze_sentence.cache_clear()


def _current_complex_words_signature() -> tuple[int, int] | None:
    try:
        stat = _complex_words_path.stat()
        return stat.st_mtime_ns, stat.st_size
    except OSError:
        return None


def _refresh_translation_corpus_if_changed() -> None:
    """translation_corpus.json 变更后重载语料，并清除包含旧译文的缓存。"""
    if default_corpus().refresh_if_changed():
        _analyze_sentence.cache_clear()


def _refresh_complex_words_if_changed() -> None:
    """自动重载项目复杂词表，并使当前分析立即采用新内容。"""
    global _complex_words, _complex_words_signature
    signature = _current_complex_words_signature()
    if signature == _complex_words_signature:
        return
    _complex_words = ComplexWordTable(_complex_words_path)
    _complex_words_signature = signature
    _analyze_sentence.cache_clear()


def _read_user_glossary() -> dict[str, dict[str, str]]:
    if not _glossary_path.exists():
        return {}
    try:
        value = json.loads(_glossary_path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}
    if not isinstance(value, dict):
        return {}
    return {
        str(word).lower(): {
            "pos": str(entry.get("pos", "")),
            "zh": str(entry.get("zh", "")),
            "note": str(entry.get("note", "")),
        }
        for word, entry in value.items()
        if isinstance(entry, dict) and entry.get("zh")
    }


def _read_user_complex_words() -> dict[str, dict[str, str]]:
    if not _complex_words_path.exists():
        return {}
    try:
        value = json.loads(_complex_words_path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}
    if not isinstance(value, dict):
        return {}
    return {
        str(word).strip().lower(): {
            "zh": str(entry.get("zh", "")).strip(),
            "level": str(entry.get("level", "较难")).strip() or "较难",
            "note": str(entry.get("note", "")).strip(),
        }
        for word, entry in value.items()
        if isinstance(entry, dict) and str(entry.get("zh", "")).strip()
    }


def _write_user_complex_words(value: dict[str, dict[str, str]]) -> None:
    temporary_path = _complex_words_path.with_suffix(_complex_words_path.suffix + ".tmp")
    temporary_path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary_path.replace(_complex_words_path)


def _normalize_user_glossary(value: object) -> dict[str, dict[str, str]]:
    if not isinstance(value, dict):
        raise ValueError("词典根节点必须是 JSON 对象")
    normalized: dict[str, dict[str, str]] = {}
    for raw_word, raw_entry in value.items():
        word = str(raw_word).strip().lower()
        if not isinstance(raw_entry, dict):
            raise ValueError(f"词条 {word or '(空)'} 必须是 JSON 对象")
        pos = str(raw_entry.get("pos", "")).strip()
        zh = str(raw_entry.get("zh", "")).strip()
        note = str(raw_entry.get("note", "")).strip()
        if not word or not zh:
            raise ValueError("每个词条都必须包含英文词条和中文释义")
        if len(word) > MAX_GLOSSARY_WORD_CHARS or any(len(field) > MAX_GLOSSARY_FIELD_CHARS for field in (pos, zh, note)):
            raise ValueError(f"词条 {word} 的字段过长")
        if any(ord(char) < 32 for char in word) or any(char in word for char in "\r\n\t"):
            raise ValueError(f"词条 {word} 包含无效字符")
        normalized[word] = {"pos": pos, "zh": zh, "note": note}
    return normalized


def _write_user_glossary(value: dict[str, dict[str, str]]) -> None:
    temporary_path = _glossary_path.with_suffix(_glossary_path.suffix + ".tmp")
    temporary_path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary_path.replace(_glossary_path)


def _create_glossary_backup(reason: str = "manual") -> Path:
    _glossary_backup_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    safe_reason = re.sub(r"[^a-z0-9-]+", "-", reason.lower()).strip("-") or "manual"
    destination = _glossary_backup_dir / f"glossary-{timestamp}-{safe_reason}.json"
    destination.write_text(
        json.dumps(_read_user_glossary(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    backups = sorted(_glossary_backup_dir.glob("glossary-*.json"), key=lambda path: path.stat().st_mtime_ns, reverse=True)
    for expired in backups[MAX_GLOSSARY_BACKUPS:]:
        expired.unlink(missing_ok=True)
    return destination


def _glossary_backups() -> list[dict[str, object]]:
    if not _glossary_backup_dir.exists():
        return []
    result = []
    for path in sorted(_glossary_backup_dir.glob("glossary-*.json"), key=lambda item: item.stat().st_mtime_ns, reverse=True):
        stat = path.stat()
        try:
            entries = json.loads(path.read_text(encoding="utf-8-sig"))
            entry_count = len(entries) if isinstance(entries, dict) else 0
        except (OSError, ValueError):
            entry_count = 0
        stem_parts = path.stem.split("-", 4)
        result.append({
            "filename": path.name,
            "size": stat.st_size,
            "created_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
            "entry_count": entry_count,
            "reason": stem_parts[4] if len(stem_parts) > 4 else "backup",
        })
    return result


def _glossary_entries() -> list[dict[str, str]]:
    user = _read_user_glossary()
    merged = {word: {**entry, "word": word, "source": "builtin"} for word, entry in GLOSSARY_BUILTIN.items()}
    for word, entry in user.items():
        merged[word] = {**entry, "word": word, "source": "custom"}
    return sorted(merged.values(), key=lambda entry: entry["word"])


def _read_bookmark_sets() -> dict[str, list[dict]]:
    """读取项目书签文件；文件不存在或损坏时按空书签处理。"""
    if not _bookmarks_path.exists():
        return {}
    try:
        value = json.loads(_bookmarks_path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}
    if not isinstance(value, dict):
        return {}
    return {
        str(document_key): bookmarks
        for document_key, bookmarks in value.items()
        if isinstance(bookmarks, list)
    }


def _normalize_bookmarks(value: object) -> list[dict]:
    if not isinstance(value, list):
        raise ValueError("bookmarks 必须是数组")
    if len(value) > MAX_BOOKMARKS_PER_DOCUMENT:
        raise ValueError(f"单份文档最多保存 {MAX_BOOKMARKS_PER_DOCUMENT} 个书签")
    normalized = []
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("每个书签必须是 JSON 对象")
        page_num = item.get("pageNum")
        sentence_index = item.get("sentenceIndex")
        if isinstance(page_num, bool) or not isinstance(page_num, int) or page_num < 1:
            raise ValueError("书签页码必须是正整数")
        if sentence_index is not None and (
            isinstance(sentence_index, bool) or not isinstance(sentence_index, int) or sentence_index < 0
        ):
            raise ValueError("书签句子序号必须是非负整数或 null")
        bookmark_id = str(item.get("id", "")).strip()
        name = str(item.get("name", "")).strip()
        text = str(item.get("text", "")).strip()
        created_at = str(item.get("createdAt", "")).strip()
        if not bookmark_id or len(bookmark_id) > 200:
            raise ValueError("书签 id 无效")
        if len(name) > MAX_BOOKMARK_NAME_CHARS or len(text) > MAX_BOOKMARK_TEXT_CHARS or len(created_at) > 100:
            raise ValueError("书签字段过长")
        normalized.append({
            "id": bookmark_id,
            "pageNum": page_num,
            "sentenceIndex": sentence_index,
            "name": name or f"第 {page_num} 页",
            "text": text or f"第 {page_num} 页",
            "createdAt": created_at,
        })
    return normalized


def _write_bookmark_sets(bookmark_sets: dict[str, list[dict]]) -> None:
    """原子写入 data/bookmarks.json，避免中断时留下半份 JSON。"""
    temporary_path = _bookmarks_path.with_suffix(_bookmarks_path.suffix + ".tmp")
    temporary_path.write_text(
        json.dumps(bookmark_sets, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(_bookmarks_path)


# 单词仅允许“字母段 + 可选的中间连字符/撇号”，拒绝 "word-" 这类残缺形态。
_WORD_PATTERN = r"[a-z]+(?:['-][a-z]+)*"


@app.before_request
def reject_unexpected_host():
    """仅接受本机 Host，阻断 DNS rebinding 把浏览器请求转发到本服务的尝试。"""
    hostname = (request.host or "").rsplit(":", 1)[0].strip("[]").lower()
    if hostname not in {"127.0.0.1", "localhost", "::1"}:
        return jsonify({"error": "服务仅允许通过 127.0.0.1 / localhost 访问"}), 403
    return None


@app.get("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.route("/static/<path:name>")
def static_files(name):
    response = send_from_directory(STATIC, name)
    # no-cache 强制每次用 ETag 协商（未变更返回 304）：本地传输成本可忽略，
    # 但保证前端 JS/CSS 更新立即生效，不会出现 24h 内看到旧脚本的情况。
    response.headers["Cache-Control"] = "no-cache"
    return response


@app.post("/api/analyze")
def analyze():
    if not request.is_json:
        return jsonify({"error": "请求体必须使用 application/json"}), 400
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "请求体必须是 JSON 对象"}), 400
    sentences = data.get("sentences", [])
    if not isinstance(sentences, list):
        return jsonify({"error": "sentences 必须是字符串数组"}), 400
    if len(sentences) > MAX_SENTENCES:
        return jsonify({"error": f"单次最多解析 {MAX_SENTENCES} 个句子"}), 400
    if any(not isinstance(sentence, str) for sentence in sentences):
        return jsonify({"error": "sentences 中的每一项都必须是字符串"}), 400
    if any(not sentence.strip() for sentence in sentences):
        return jsonify({"error": "sentences 中不能包含空句子"}), 400
    if any(len(sentence) > MAX_SENTENCE_CHARS for sentence in sentences):
        return jsonify({"error": f"单句不能超过 {MAX_SENTENCE_CHARS} 个字符"}), 400
    _refresh_glossary_if_changed()
    _refresh_complex_words_if_changed()
    _refresh_translation_corpus_if_changed()
    results = [_analyze_sentence(s.strip()) for s in sentences]
    return jsonify({"results": results})


@app.post("/api/refine")
def refine():
    """可选的在线分句树精修：由前端在本地结果渲染后异步调用，绝不阻塞主路径。"""
    if not request.is_json:
        return jsonify({"error": "请求体必须使用 application/json"}), 400
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "请求体必须是 JSON 对象"}), 400
    sentence = str(data.get("sentence", "")).strip()
    if not sentence:
        return jsonify({"error": "sentence 不能为空"}), 400
    if len(sentence) > MAX_SENTENCE_CHARS:
        return jsonify({"error": f"单句不能超过 {MAX_SENTENCE_CHARS} 个字符"}), 400
    if not _llm_refiner.enabled():
        return jsonify({"error": "未配置在线精修（PARSE_SPEC_LLM_BASE_URL / PARSE_SPEC_LLM_API_KEY）"}), 404
    _refresh_glossary_if_changed()
    _refresh_complex_words_if_changed()
    _refresh_translation_corpus_if_changed()
    local = spacy_worker.parse_isolated_or_direct(sentence)
    refined = _llm_refiner.refine(sentence, local)
    if refined is None:
        return jsonify({"error": "在线精修不可用，已保留本地解析结果"}), 404
    return jsonify({"result": _build_result(refined)})


@app.get("/api/glossary")
def get_glossary():
    """列出内置词条与用户覆盖，供前端搜索和维护。"""
    _refresh_glossary_if_changed()
    return jsonify({"entries": _glossary_entries(), "user_file": _glossary_path.name})


@app.post("/api/glossary")
def save_glossary_entry():
    """新增或覆盖一个用户词条，并立即使解析缓存失效。"""
    if not request.is_json:
        return jsonify({"error": "请求体必须使用 application/json"}), 400
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "请求体必须是 JSON 对象"}), 400
    word = str(data.get("word", "")).strip().lower()
    pos = str(data.get("pos", "")).strip()
    zh = str(data.get("zh", "")).strip()
    note = str(data.get("note", "")).strip()
    if not word or not zh:
        return jsonify({"error": "英文词条和中文释义不能为空"}), 400
    if len(word) > MAX_GLOSSARY_WORD_CHARS or any(len(field) > MAX_GLOSSARY_FIELD_CHARS for field in (pos, zh, note)):
        return jsonify({"error": "术语字段过长"}), 400
    if any(ord(char) < 32 for char in word) or any(char in word for char in "\r\n\t"):
        return jsonify({"error": "英文词条包含无效字符"}), 400
    user = _read_user_glossary()
    user[word] = {"pos": pos, "zh": zh, "note": note}
    try:
        _create_glossary_backup("before-edit")
        _write_user_glossary(user)
    except OSError as exc:
        return jsonify({"error": f"无法写入 data/glossary.json：{exc}"}), 500
    global _glossary_signature
    _glossary_signature = None
    _refresh_glossary_if_changed()
    return jsonify({"entry": {"word": word, "pos": pos, "zh": zh, "note": note, "source": "custom"}})


@app.delete("/api/glossary")
def delete_glossary_entry():
    """删除自定义词条；若它覆盖内置词条，删除后恢复显示内置释义。"""
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "请求体必须是 JSON 对象"}), 400
    word = str(data.get("word", "")).strip().lower()
    if not word or len(word) > MAX_GLOSSARY_WORD_CHARS:
        return jsonify({"error": "英文词条无效"}), 400
    user = _read_user_glossary()
    if word not in user:
        return jsonify({"error": "只能删除 data/glossary.json 中的自定义词条"}), 404
    try:
        _create_glossary_backup("before-delete")
        del user[word]
        _write_user_glossary(user)
    except OSError as exc:
        return jsonify({"error": f"无法更新 data/glossary.json：{exc}"}), 500
    global _glossary_signature
    _glossary_signature = None
    _refresh_glossary_if_changed()
    return jsonify({"deleted": word, "reverted_to_builtin": word in GLOSSARY_BUILTIN})


@app.get("/api/glossary/backups")
def list_glossary_backups():
    return jsonify({"backups": _glossary_backups(), "directory": str(_glossary_backup_dir.relative_to(Path(BASE)))})


@app.post("/api/glossary/backups")
def create_glossary_backup():
    try:
        backup = _create_glossary_backup("manual")
    except OSError as exc:
        return jsonify({"error": f"无法创建术语表备份：{exc}"}), 500
    return jsonify({"backup": next(item for item in _glossary_backups() if item["filename"] == backup.name)})


@app.get("/api/glossary/backups/<path:filename>")
def download_glossary_backup(filename: str):
    if Path(filename).name != filename or not re.fullmatch(r"glossary-[A-Za-z0-9-]+\.json", filename):
        return jsonify({"error": "备份文件名无效"}), 400
    if not (_glossary_backup_dir / filename).is_file():
        return jsonify({"error": "备份不存在"}), 404
    return send_from_directory(_glossary_backup_dir, filename, as_attachment=True)


@app.delete("/api/glossary/backups/<path:filename>")
def delete_glossary_backup(filename: str):
    if Path(filename).name != filename or not re.fullmatch(r"glossary-[A-Za-z0-9-]+\.json", filename):
        return jsonify({"error": "备份文件名无效"}), 400
    target = _glossary_backup_dir / filename
    if not target.is_file():
        return jsonify({"error": "备份不存在"}), 404
    try:
        target.unlink()
    except OSError as exc:
        return jsonify({"error": f"无法删除术语表备份：{exc}"}), 500
    return jsonify({"deleted": filename})


@app.post("/api/glossary/restore")
def restore_glossary_backup():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "请求体必须是 JSON 对象"}), 400
    filename = str(data.get("filename", "")).strip()
    if Path(filename).name != filename or not re.fullmatch(r"glossary-[A-Za-z0-9-]+\.json", filename):
        return jsonify({"error": "备份文件名无效"}), 400
    source = _glossary_backup_dir / filename
    if not source.is_file():
        return jsonify({"error": "备份不存在"}), 404
    try:
        restored = _normalize_user_glossary(json.loads(source.read_text(encoding="utf-8-sig")))
        _create_glossary_backup("before-restore")
        _write_user_glossary(restored)
    except (OSError, ValueError) as exc:
        return jsonify({"error": f"无法恢复术语表：{exc}"}), 400
    global _glossary_signature
    _glossary_signature = None
    _refresh_glossary_if_changed()
    return jsonify({"restored": filename, "entry_count": len(restored)})


@app.get("/api/complex-words/suggest")
def suggest_complex_word():
    """为右击添加的单词查询本地释义，避免要求用户自行解释陌生词。"""
    word = request.args.get("word", "").strip().lower()
    if not re.fullmatch(_WORD_PATTERN, word):
        return jsonify({"error": "复杂词必须是单个英文单词"}), 400
    _refresh_glossary_if_changed()
    _refresh_complex_words_if_changed()
    lemma = lemma_for_word(word) or word
    candidates = list(dict.fromkeys((word, lemma)))

    for candidate in candidates:
        entry = _complex_words.lookup(candidate)
        if entry:
            return jsonify({"suggestion": {
                "word": word, "lemma": candidate, "zh": entry["zh"],
                "level": entry.get("level", "较难"), "note": entry.get("note", ""),
                "source": f"complex-{entry.get('source', 'builtin')}",
            }})
    for candidate in candidates:
        entry = _glossary.lookup(candidate)
        if entry and entry.get("zh"):
            note = str(entry.get("note", "")).strip()
            return jsonify({"suggestion": {
                "word": word, "lemma": candidate, "zh": str(entry["zh"]),
                "level": "较难", "note": note or "自动取自本地术语表",
                "source": "glossary",
            }})
    for candidate in candidates:
        translated = lookup_word_translation(candidate, _glossary)
        if translated:
            return jsonify({"suggestion": {
                "word": word, "lemma": candidate, "zh": translated,
                "level": "较难", "note": "自动取自本地结构翻译词库",
                "source": "translator",
            }})
    # 本地三级源都未命中时，用在线词典的中文释义兜底（有道中文释义更适合人工确认）。
    for candidate in candidates:
        info = _online_dict.lookup(candidate)
        glosses = info.get("zh_gloss") if isinstance(info, dict) else None
        if glosses:
            zh = re.sub(r"^[a-z]+\.\s*", "", str(glosses[0])).strip() or str(glosses[0])
            return jsonify({"suggestion": {
                "word": word, "lemma": candidate, "zh": zh,
                "level": "较难", "note": "自动取自在线词典，请确认后保存",
                "source": "online",
            }})
    return jsonify({"error": "本地词典与在线词典均未收录该单词，请手动填写释义"}), 404


@app.get("/api/word-info")
def word_info():
    """查询在线词典详情（音标/词性/英文释义/例句/同义词/搭配）。

    联网只发生在本端点，带磁盘缓存与短超时；整句翻译路径不经过这里。
    """
    word = request.args.get("word", "").strip().lower()
    if not re.fullmatch(_WORD_PATTERN, word):
        return jsonify({"error": "必须是单个英文单词"}), 400
    lemma = lemma_for_word(word) or word
    for candidate in dict.fromkeys((word, lemma)):
        info = _online_dict.lookup(candidate)
        if info:
            return jsonify({"info": info})
    return jsonify({"error": "在线词典暂未收录该单词或网络不可用"}), 404


@app.get("/api/complex-words")
def get_complex_words():
    """列出内置和项目自定义复杂词，供前端统一维护。"""
    _refresh_complex_words_if_changed()
    return jsonify({"entries": _complex_words.entries(), "user_file": _complex_words_path.name})


@app.post("/api/complex-words")
def save_complex_word():
    if not request.is_json:
        return jsonify({"error": "请求体必须使用 application/json"}), 400
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "请求体必须是 JSON 对象"}), 400
    word = str(data.get("word", "")).strip().lower()
    zh = str(data.get("zh", "")).strip()
    level = str(data.get("level", "较难")).strip() or "较难"
    note = str(data.get("note", "")).strip()
    if not re.fullmatch(_WORD_PATTERN, word):
        return jsonify({"error": "复杂词必须是单个英文单词"}), 400
    if not zh:
        return jsonify({"error": "中文释义不能为空"}), 400
    if len(word) > MAX_GLOSSARY_WORD_CHARS or any(len(field) > MAX_GLOSSARY_FIELD_CHARS for field in (zh, level, note)):
        return jsonify({"error": "复杂词字段过长"}), 400
    user = _read_user_complex_words()
    user[word] = {"zh": zh, "level": level, "note": note}
    try:
        _write_user_complex_words(user)
    except OSError as exc:
        return jsonify({"error": f"无法写入 data/complex_words.json：{exc}"}), 500
    global _complex_words_signature
    _complex_words_signature = None
    _refresh_complex_words_if_changed()
    return jsonify({"entry": {"word": word, "zh": zh, "level": level, "note": note, "source": "custom"}})


@app.delete("/api/complex-words")
def delete_complex_word():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "请求体必须是 JSON 对象"}), 400
    word = str(data.get("word", "")).strip().lower()
    user = _read_user_complex_words()
    if word not in user:
        return jsonify({"error": "只能删除 data/complex_words.json 中的自定义复杂词"}), 404
    try:
        del user[word]
        _write_user_complex_words(user)
    except OSError as exc:
        return jsonify({"error": f"无法更新 data/complex_words.json：{exc}"}), 500
    global _complex_words_signature
    _complex_words_signature = None
    _refresh_complex_words_if_changed()
    return jsonify({"deleted": word, "reverted_to_builtin": word in COMPLEX_WORD_BUILTIN})


@app.get("/api/bookmarks")
def get_bookmarks():
    """读取一份 PDF 在项目文件中的书签。"""
    document_key = request.args.get("document_key", "").strip()
    if not document_key or len(document_key) > MAX_BOOKMARK_DOCUMENT_KEY_CHARS:
        return jsonify({"error": "document_key 无效"}), 400
    bookmarks = _read_bookmark_sets().get(document_key, [])
    return jsonify({"bookmarks": bookmarks, "user_file": _bookmarks_path.name})


@app.post("/api/bookmarks")
def save_bookmarks():
    """整体替换一份 PDF 的书签，并原子写入 bookmarks.json。"""
    if not request.is_json:
        return jsonify({"error": "请求体必须使用 application/json"}), 400
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "请求体必须是 JSON 对象"}), 400
    document_key = str(data.get("document_key", "")).strip()
    if not document_key or len(document_key) > MAX_BOOKMARK_DOCUMENT_KEY_CHARS:
        return jsonify({"error": "document_key 无效"}), 400
    try:
        bookmarks = _normalize_bookmarks(data.get("bookmarks"))
        bookmark_sets = _read_bookmark_sets()
        if bookmarks:
            bookmark_sets[document_key] = bookmarks
        else:
            bookmark_sets.pop(document_key, None)
        _write_bookmark_sets(bookmark_sets)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except OSError as exc:
        return jsonify({"error": f"无法写入 data/bookmarks.json：{exc}"}), 500
    return jsonify({"bookmarks": bookmarks, "user_file": _bookmarks_path.name})


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify({"error": f"请求体不能超过 {MAX_REQUEST_BYTES} 字节"}), 413


# ---------------------------------------------------------------------------
# 异常句子标注：读者在分析栏一键标记“读不通/解析可疑”的句子并附注意见，
# 统一存入 data/sentence_feedback.json，供离线批量分析改进解析与译文。
# ---------------------------------------------------------------------------

def _read_feedback_items() -> list[dict]:
    """读取标注列表；文件缺失或损坏时按空列表处理。"""
    if not _feedback_path.exists():
        return []
    try:
        value = json.loads(_feedback_path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return []
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _write_feedback_items(items: list[dict]) -> None:
    temporary_path = _feedback_path.with_suffix(_feedback_path.suffix + ".tmp")
    temporary_path.write_text(
        json.dumps(items, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(_feedback_path)


def _feedback_item_key(document_key: str, page_num: int, sentence_index: int) -> str:
    return f"{document_key}|{page_num}|{sentence_index}"


def _feedback_qa_snapshot(value: object) -> dict[str, object] | None:
    """前端回传的质检结论摘要：只保留小体积字段，控制标注文件体积。"""
    if not isinstance(value, dict):
        return None
    signals_raw = value.get("signals")
    signals = (
        [str(item)[:200] for item in signals_raw[:MAX_FEEDBACK_SIGNALS]]
        if isinstance(signals_raw, list)
        else []
    )
    return {
        "suspicious": bool(value.get("suspicious")),
        "signals": signals,
        "strategy": str(value.get("strategy", ""))[:40],
    }


def _feedback_parse_snapshot(value: object) -> list[dict[str, str]] | None:
    if not isinstance(value, list):
        return None
    result: list[dict[str, str]] = []
    for entry in value[:MAX_FEEDBACK_RELATIONS]:
        if not isinstance(entry, dict):
            continue
        result.append({
            "relation": str(entry.get("relation", ""))[:40],
            "marker": str(entry.get("marker", ""))[:40],
        })
    return result


@app.get("/api/sentence-feedback")
def list_sentence_feedback():
    """列出一份文档的异常句子标注，供前端回显“已标注”状态。"""
    document_key = request.args.get("document_key", "").strip()
    if not document_key or len(document_key) > MAX_BOOKMARK_DOCUMENT_KEY_CHARS:
        return jsonify({"error": "document_key 无效"}), 400
    items = [item for item in _read_feedback_items() if item.get("document_key") == document_key]
    return jsonify({"feedbacks": items})


@app.post("/api/sentence-feedback")
def save_sentence_feedback():
    """新增或更新一条标注（同文档同句覆盖），原句文本与质检快照一并保存。"""
    if not request.is_json:
        return jsonify({"error": "请求体必须使用 application/json"}), 400
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "请求体必须是 JSON 对象"}), 400
    document_key = str(data.get("document_key", "")).strip()
    if not document_key or len(document_key) > MAX_BOOKMARK_DOCUMENT_KEY_CHARS:
        return jsonify({"error": "document_key 无效"}), 400
    page_num = data.get("page_num")
    sentence_index = data.get("sentence_index")
    if isinstance(page_num, bool) or not isinstance(page_num, int) or page_num < 1:
        return jsonify({"error": "page_num 必须是正整数"}), 400
    if isinstance(sentence_index, bool) or not isinstance(sentence_index, int) or sentence_index < 0:
        return jsonify({"error": "sentence_index 必须是非负整数"}), 400
    text = str(data.get("text", "")).strip()
    note = str(data.get("note", "")).strip()
    if not text:
        return jsonify({"error": "text 不能为空"}), 400
    if len(text) > MAX_BOOKMARK_TEXT_CHARS:
        return jsonify({"error": f"原句文本不能超过 {MAX_BOOKMARK_TEXT_CHARS} 字符"}), 400
    if len(note) > MAX_FEEDBACK_NOTE_CHARS:
        return jsonify({"error": f"意见不能超过 {MAX_FEEDBACK_NOTE_CHARS} 字符"}), 400
    now = datetime.now(timezone.utc).isoformat()
    items = _read_feedback_items()
    key = _feedback_item_key(document_key, page_num, sentence_index)
    existing = next((entry for entry in items if entry.get("id") == key), None)
    item = {
        "id": key,
        "document_key": document_key,
        "page_num": page_num,
        "sentence_index": sentence_index,
        "text": text,
        "note": note,
        "qa": _feedback_qa_snapshot(data.get("qa")),
        "parse": _feedback_parse_snapshot(data.get("parse")),
        "created_at": existing.get("created_at", now) if existing else now,
        "updated_at": now,
    }
    if existing:
        items = [item if entry.get("id") == key else entry for entry in items]
    else:
        if len(items) >= MAX_FEEDBACK_ITEMS:
            return jsonify({"error": f"标注数量已达上限 {MAX_FEEDBACK_ITEMS}，请先清理旧标注"}), 400
        items.append(item)
    try:
        _write_feedback_items(items)
    except OSError as exc:
        return jsonify({"error": f"无法写入 sentence_feedback.json：{exc}"}), 500
    return jsonify({"feedback": item})


@app.delete("/api/sentence-feedback")
def delete_sentence_feedback():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "请求体必须是 JSON 对象"}), 400
    document_key = str(data.get("document_key", "")).strip()
    page_num = data.get("page_num")
    sentence_index = data.get("sentence_index")
    if not document_key or len(document_key) > MAX_BOOKMARK_DOCUMENT_KEY_CHARS:
        return jsonify({"error": "document_key 无效"}), 400
    if isinstance(page_num, bool) or not isinstance(page_num, int) or page_num < 1:
        return jsonify({"error": "page_num 必须是正整数"}), 400
    if isinstance(sentence_index, bool) or not isinstance(sentence_index, int) or sentence_index < 0:
        return jsonify({"error": "sentence_index 必须是非负整数"}), 400
    key = _feedback_item_key(document_key, page_num, sentence_index)
    items = _read_feedback_items()
    remaining = [entry for entry in items if entry.get("id") != key]
    if len(remaining) == len(items):
        return jsonify({"error": "标注不存在"}), 404
    try:
        _write_feedback_items(remaining)
    except OSError as exc:
        return jsonify({"error": f"无法更新 sentence_feedback.json：{exc}"}), 500
    return jsonify({"deleted": key})


@app.after_request
def add_security_headers(response):
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; worker-src 'self' blob:; "
        "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
        "font-src 'self' data: blob:; connect-src 'self'; object-src 'none'; "
        "base-uri 'none'; frame-ancestors 'none'"
    )
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


if __name__ == "__main__":
    selected_port = _select_local_port()
    active_model = _prefer_trf_model()
    spacy_worker.enable_isolation()  # 解析移入可超时的工作进程；超时/崩溃自动降级到规则引擎
    threading.Thread(
        target=spacy_worker.warmup,
        name="parse-warmup",
        daemon=True,
    ).start()  # 后台加载解析模型，避免首次点击承担 trf 模型加载耗时

    def _open_browser_when_ready() -> None:
        # start.bat 一键启动时打开浏览器；服务在独立线程里再等端口真正可用
        import socket
        import time
        import webbrowser

        url = f"http://127.0.0.1:{selected_port}"
        for _ in range(40):
            probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                probe.settimeout(0.25)
                if probe.connect_ex(("127.0.0.1", selected_port)) == 0:
                    webbrowser.open(url)
                    return
            finally:
                probe.close()
            time.sleep(0.25)

    if os.environ.get("PARSE_SPEC_OPEN_BROWSER", "").strip() == "1":
        threading.Thread(target=_open_browser_when_ready, name="open-browser", daemon=True).start()
    if selected_port != DEFAULT_PORT:
        print(f"* 默认端口 {DEFAULT_PORT} 不可用，已自动切换到 {selected_port}")
    print(f"* 解析模型 {active_model}（可用 PARSE_SPEC_SPACY_MODEL 覆盖）")
    print(f"* 访问 http://127.0.0.1:{selected_port}  (服务只监听本机回环地址)")
    app.run(host="127.0.0.1", port=selected_port, debug=False)
