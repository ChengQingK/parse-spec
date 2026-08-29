#!/usr/bin/env python3
"""解析回归语料跑批：把 tests/corpus/spec_sentences.jsonl 逐句解析并比对期望结构。

用法：
  python scripts/parse_corpus.py                    # 使用默认模型链（sm）
  python scripts/parse_corpus.py --model en_core_web_trf
  python scripts/parse_corpus.py --strict           # 存在失败时退出码 1

每条语料字段：
  id / text                必填；text 为原句，分句文本必须是其精确子串
  model                    可选；指定该条目只在对应模型下验证（如 trf 专属回归）
  expect.relations         可选；期望的分句关系序列
  expect.markers           可选；期望的分句标记词序列（大小写不敏感）
  expect.qa_suspicious     可选；期望的质检可疑结论

新坏句子先追加为已知失败（放宽 expect 或标注 model），规则修复后收紧期望，
保证每次解析迭代的影响面在整份语料上可见。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

DEFAULT_CORPUS = Path(__file__).resolve().parent.parent / "tests" / "corpus" / "spec_sentences.jsonl"


def load_entries(path: Path) -> list[dict]:
    entries: list[dict] = []
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("#"):
                entries.append(json.loads(line))
    return entries


def evaluate(parsed, entry: dict) -> list[str]:
    """返回与期望的差异列表；空列表即通过。"""
    expect = entry.get("expect", {})
    diffs: list[str] = []
    clauses = parsed.clauses
    relations = [clause.relation for clause in clauses]
    markers = [(clause.marker or "").lower() for clause in clauses]
    expected_relations = expect.get("relations")
    if expected_relations is not None and relations != expected_relations:
        diffs.append(f"关系序列 {relations} != 期望 {expected_relations}")
    expected_markers = expect.get("markers")
    if expected_markers is not None and markers != [str(item).lower() for item in expected_markers]:
        diffs.append(f"标记序列 {markers} != 期望 {expected_markers}")
    if "qa_suspicious" in expect:
        actual = bool(parsed.qa and parsed.qa.get("suspicious"))
        if actual != expect["qa_suspicious"]:
            diffs.append(f"qa.suspicious={actual} != 期望 {expect['qa_suspicious']}")
    return diffs


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="解析回归语料跑批")
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS, help="语料 JSONL 路径")
    parser.add_argument("--model", default="", help="覆盖 PARSE_SPEC_SPACY_MODEL")
    parser.add_argument("--strict", action="store_true", help="存在失败时退出码 1")
    args = parser.parse_args(argv)
    if args.model:
        os.environ["PARSE_SPEC_SPACY_MODEL"] = args.model
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from parse import spacy_parser
    from parse.clauser import parse_sentence

    entries = load_entries(args.corpus)
    passed = skipped = failed = 0
    for entry in entries:
        required_model = entry.get("model") or ""
        if required_model and required_model != spacy_parser._MODEL_NAME:
            print(f"SKIP {entry['id']}（需要 {required_model}，当前 {spacy_parser._MODEL_NAME or '无模型'}）")
            skipped += 1
            continue
        parsed = parse_sentence(entry["text"])
        diffs = evaluate(parsed, entry)
        if diffs:
            failed += 1
            print(f"FAIL {entry['id']}")
            for diff in diffs:
                print(f"     - {diff}")
            for clause in parsed.clauses:
                print(f"     {clause.id}[{clause.relation}] marker={clause.marker!r} {clause.text[:60]!r}")
        else:
            strategy = parsed.qa["strategy"] if parsed.qa else "-"
            passed += 1
            print(f"PASS {entry['id']}（{len(parsed.clauses)} 分句, strategy={strategy}）")
    print(f"\n通过 {passed} / 失败 {failed} / 跳过 {skipped}（模型 {spacy_parser._MODEL_NAME or '无'}）")
    return 1 if args.strict and failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
