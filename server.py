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
import socket
from dataclasses import asdict
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

from parse.clauser import parse_sentence
from parse.glossary import BUILTIN, Glossary
from parse.translator import translate_sentence

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")

app = Flask(__name__, static_folder=None)

_glossary_path = Path(BASE) / "glossary.json"
_glossary = Glossary(str(_glossary_path))  # 用户可自定义
_glossary_signature: tuple[int, int] | None = None
_bookmarks_path = Path(BASE) / "bookmarks.json"
MAX_SENTENCES = 32
MAX_SENTENCE_CHARS = 10_000
MAX_REQUEST_BYTES = 400_000
MAX_GLOSSARY_WORD_CHARS = 120
MAX_GLOSSARY_FIELD_CHARS = 800
MAX_BOOKMARK_DOCUMENT_KEY_CHARS = 500
MAX_BOOKMARKS_PER_DOCUMENT = 2_000
MAX_BOOKMARK_TEXT_CHARS = 10_000
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


@lru_cache(maxsize=1024)
def _analyze_sentence(s: str) -> dict:
    sentence = s.strip()
    ps = parse_sentence(sentence)
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
    return {
        "schema_version": 3,
        "text": ps.text,
        "engine": ps.engine,
        "main_clause_id": ps.main_clause_id,
        "clauses": [asdict(clause) for clause in ps.clauses],
        "terms": words,
        "translation": translate_sentence(ps, _glossary),
        "warnings": ps.warnings,
    }


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


def _glossary_entries() -> list[dict[str, str]]:
    user = _read_user_glossary()
    merged = {word: {**entry, "word": word, "source": "builtin"} for word, entry in BUILTIN.items()}
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
        text = str(item.get("text", "")).strip()
        created_at = str(item.get("createdAt", "")).strip()
        if not bookmark_id or len(bookmark_id) > 200:
            raise ValueError("书签 id 无效")
        if len(text) > MAX_BOOKMARK_TEXT_CHARS or len(created_at) > 100:
            raise ValueError("书签字段过长")
        normalized.append({
            "id": bookmark_id,
            "pageNum": page_num,
            "sentenceIndex": sentence_index,
            "text": text or f"第 {page_num} 页",
            "createdAt": created_at,
        })
    return normalized


def _write_bookmark_sets(bookmark_sets: dict[str, list[dict]]) -> None:
    """原子写入项目根目录，避免中断时留下半份 JSON。"""
    temporary_path = _bookmarks_path.with_suffix(_bookmarks_path.suffix + ".tmp")
    temporary_path.write_text(
        json.dumps(bookmark_sets, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary_path.replace(_bookmarks_path)


@app.get("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.route("/static/<path:name>")
def static_files(name):
    return send_from_directory(STATIC, name)


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
    results = [_analyze_sentence(s.strip()) for s in sentences]
    return jsonify({"results": results})


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
        temporary_path = _glossary_path.with_suffix(_glossary_path.suffix + ".tmp")
        temporary_path.write_text(json.dumps(user, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary_path.replace(_glossary_path)
    except OSError as exc:
        return jsonify({"error": f"无法写入 glossary.json：{exc}"}), 500
    global _glossary_signature
    _glossary_signature = None
    _refresh_glossary_if_changed()
    return jsonify({"entry": {"word": word, "pos": pos, "zh": zh, "note": note, "source": "custom"}})


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
        return jsonify({"error": f"无法写入 bookmarks.json：{exc}"}), 500
    return jsonify({"bookmarks": bookmarks, "user_file": _bookmarks_path.name})


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify({"error": f"请求体不能超过 {MAX_REQUEST_BYTES} 字节"}), 413


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
    if selected_port != DEFAULT_PORT:
        print(f"* 默认端口 {DEFAULT_PORT} 不可用，已自动切换到 {selected_port}")
    print(f"* 访问 http://127.0.0.1:{selected_port}  (本地仅离线使用)")
    app.run(host="127.0.0.1", port=selected_port, debug=False)
