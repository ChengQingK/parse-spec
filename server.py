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
import re
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
    os.execv(
        str(project_python),
        [str(project_python), str(Path(__file__).resolve()), *sys.argv[1:]],
    )

from parse.clauser import parse_sentence
from parse.glossary import Glossary

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")

app = Flask(__name__, static_folder=None)

_glossary = Glossary(os.path.join(BASE, "glossary.json"))  # 用户可自定义
MAX_SENTENCES = 32
MAX_SENTENCE_CHARS = 10_000


@lru_cache(maxsize=1024)
def _analyze_sentence(s: str) -> dict:
    sentence = s.strip()
    ps = parse_sentence(sentence)
    # 收集句中"复杂词"（词典命中的词）
    words_hit = {}
    for tok in re.findall(r"[A-Za-z]+(?:['-][A-Za-z]+)*", sentence):
        d = _glossary.lookup(tok)
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
    if any(len(sentence) > MAX_SENTENCE_CHARS for sentence in sentences):
        return jsonify({"error": f"单句不能超过 {MAX_SENTENCE_CHARS} 个字符"}), 400
    results = [_analyze_sentence(s) for s in sentences]
    return jsonify({"results": results})


if __name__ == "__main__":
    print("* 访问 http://127.0.0.1:5197  (本地仅离线使用)")
    app.run(host="127.0.0.1", port=5197, debug=False)
