#!/usr/bin/env python3
"""SPEC 目录句料批量扫描：把真实规格书句子过一遍解析器，产出质量问题清单。

用途（迭代解析逻辑的素材收集，配合 tests/corpus/spec_sentences.jsonl）：
  python scripts/scan_spec_corpus.py                 # 默认模型链（sm）
  python scripts/scan_spec_corpus.py --model en_core_web_trf
  python scripts/scan_spec_corpus.py --out report.jsonl

每份 PDF 用 pypdf 抽文本后按 clauser.split_sentences 断句（与前端同源口径），
逐句 parse_sentence 并记录：分句关系/标记、质检结论、警告、engine。
输出 JSONL 每行一句（仅“值得人工审阅”的句子：质检可疑 / 有 ambiguous /
带警告 / 解析降级），并在结尾打印统计摘要。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

DEFAULT_SPEC_DIR = Path(r"C:\myWork\LPDDR_PHY\01_shared_resources\doc\SPEC")
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "test-results" / "spec_scan.jsonl"


def extract_sentences(pdf_path: Path) -> list[str]:
    """抽取 PDF 文本并断句；过滤非英文句（中文协议文档仅取其英文段落）。"""
    from pypdf import PdfReader

    from parse.clauser import split_sentences

    reader = PdfReader(str(pdf_path))
    raw_lines: list[str] = []
    for page in reader.pages:
        try:
            text = page.extract_text() or ""
        except Exception:
            continue
        for line in text.splitlines():
            line = line.strip()
            if line:
                raw_lines.append(line)
    # 断句以“整篇拼接文本”为单位，跨行句子才能合并
    joined = " ".join(raw_lines)
    sentences = []
    for sentence in split_sentences(joined):
        stripped = sentence.strip()
        letters = sum(1 for ch in stripped if ch.isascii() and ch.isalpha())
        if len(stripped) < 24 or letters < len(stripped) * 0.55:
            continue  # 过短或以中文/符号为主的片段
        sentences.append(stripped)
    return sentences


def assess_sentence(sentence: str) -> dict | None:
    """解析一句并返回记录；无任何异常信号时返回 None（不写入报告）。"""
    from parse.clauser import parse_sentence

    started = time.perf_counter()
    try:
        parsed = parse_sentence(sentence)
    except Exception as exc:
        return {"text": sentence, "problem": "parse-exception", "detail": f"{type(exc).__name__}: {exc}"}
    elapsed = time.perf_counter() - started
    relations = [clause.relation for clause in parsed.clauses]
    ambiguous = relations.count("ambiguous")
    reasons = []
    if parsed.engine != "spacy":
        reasons.append("rule-fallback")
    reasons.extend(parsed.warnings)
    qa = parsed.qa or {}
    if qa.get("suspicious"):
        reasons.append("qa-suspicious")
    if ambiguous:
        reasons.append(f"ambiguous×{ambiguous}")
    if not reasons:
        return None
    return {
        "text": sentence,
        "problem": ";".join(dict.fromkeys(reasons)),
        "elapsed": round(elapsed, 3),
        "relations": relations,
        "markers": [clause.marker for clause in parsed.clauses],
        "clauses": [clause.text for clause in parsed.clauses],
        "engine": parsed.engine,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="SPEC 句料解析质量扫描")
    parser.add_argument("--dir", type=Path, default=DEFAULT_SPEC_DIR, help="SPEC PDF 目录")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="报告 JSONL 输出路径")
    parser.add_argument("--model", default="", help="覆盖 PARSE_SPEC_SPACY_MODEL")
    parser.add_argument("--limit", type=int, default=0, help="每份 PDF 最多扫描句数（0=不限）")
    args = parser.parse_args(argv)
    if args.model:
        os.environ["PARSE_SPEC_SPACY_MODEL"] = args.model

    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    pdfs = sorted(args.dir.glob("*.pdf"))
    if not pdfs:
        print(f"未找到 PDF：{args.dir}")
        return 1

    args.out.parent.mkdir(parents=True, exist_ok=True)
    total = flagged = 0
    started = time.perf_counter()
    with args.out.open("w", encoding="utf-8") as sink:
        for pdf_path in pdfs:
            sentences = extract_sentences(pdf_path)
            if args.limit:
                sentences = sentences[: args.limit]
            doc_flagged = 0
            for sentence in sentences:
                total += 1
                record = assess_sentence(sentence)
                if record is None:
                    continue
                record["doc"] = pdf_path.name
                flagged += 1
                doc_flagged += 1
                sink.write(json.dumps(record, ensure_ascii=False) + "\n")
                sink.flush()
            print(f"[scan] {pdf_path.name}: {len(sentences)} 句，{doc_flagged} 句待审", flush=True)
    elapsed = time.perf_counter() - started
    print(f"[scan] 完成：{total} 句 / 待审 {flagged}，用时 {elapsed:.0f}s → {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
