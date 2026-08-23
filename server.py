# -*- coding: utf-8 -*-
"""parse-spec 服务端。

职责：接收前端发来的英文句子文本，做断句/成分/词义解析，返回结构化 JSON。
坐标与悬浮命中全部由前端(pdf.js)自行处理，因此本服务无需接收 PDF，
只需做"纯文本分析"，职责清晰、完全离线。

运行：python server.py  ->  http://127.0.0.1:5197
"""

from __future__ import annotations

import os
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
from parse.glossary import Glossary

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")

app = Flask(__name__, static_folder=None)

_glossary_path = Path(BASE) / "glossary.json"
_glossary = Glossary(str(_glossary_path))  # 用户可自定义
_glossary_signature: tuple[int, int] | None = None
MAX_SENTENCES = 32
MAX_SENTENCE_CHARS = 10_000
MAX_REQUEST_BYTES = 400_000
app.config["MAX_CONTENT_LENGTH"] = MAX_REQUEST_BYTES


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
        "schema_version": 2,
        "text": ps.text,
        "engine": ps.engine,
        "main_clause_id": ps.main_clause_id,
        "clauses": [asdict(clause) for clause in ps.clauses],
        "terms": words,
        # 翻译能力通过独立本地适配器接入；未配置时明确返回 null。
        "translation": None,
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
    print("* 访问 http://127.0.0.1:5197  (本地仅离线使用)")
    app.run(host="127.0.0.1", port=5197, debug=False)
