# -*- coding: utf-8 -*-
"""parse-spec 服务端。

职责：接收前端发来的英文句子文本，做断句/成分/词义解析，返回结构化 JSON。
坐标与悬浮命中全部由前端(pdf.js)自行处理，因此本服务无需接收 PDF，
只需做"纯文本分析"，职责清晰、完全离线。

运行：python server.py  ->  http://127.0.0.1:5197
"""

from __future__ import annotations

import os

from flask import Flask, jsonify, request, send_from_directory

from parse.clauser import parse_sentence
from parse.glossary import Glossary

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")

app = Flask(__name__, static_folder=None)

_glossary = Glossary(os.path.join(BASE, "glossary.json"))  # 用户可自定义


def _analyze_sentence(s: str) -> dict:
    sentence = s.strip()
    ps = parse_sentence(sentence)
    # 收集句中"复杂词"（词典命中的词）
    words_hit = {}
    import re
    for tok in re.findall(r"[A-Za-z]+(?:['-][A-Za-z]+)*", sentence):
        d = _glossary.lookup(tok)
        if d and tok.lower() not in words_hit:
            words_hit[tok.lower()] = d
    words = sorted(words_hit.values(), key=lambda x: (x["pos"], x["word"]))
    return {
        "text": ps.text,
        "chunks": [
            {"text": c.text, "kind": c.kind, "marker": c.marker, "note": c.note}
            for c in ps.chunks
        ],
        "main_verb": ps.main_verb,
        "subject_hint": ps.subject_hint,
        "words": words,
    }


@app.get("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.route("/static/<path:name>")
def static_files(name):
    return send_from_directory(STATIC, name)


@app.post("/api/analyze")
def analyze():
    data = request.get_json(silent=True) or {}
    sentences = data.get("sentences") or []
    results = [_analyze_sentence(s) for s in sentences]
    return jsonify({"results": results})


if __name__ == "__main__":
    print("* 访问 http://127.0.0.1:5197  (本地仅离线使用)")
    app.run(host="127.0.0.1", port=5197, debug=False)
