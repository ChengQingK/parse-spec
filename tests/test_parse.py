# -*- coding: utf-8 -*-

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from parse.clauser import parse_sentence, split_sentences
from parse.glossary import Glossary
from parse.translator import translate_text
import parse.spacy_parser as spacy_parser
import server


class SentenceParserTests(unittest.TestCase):
    def test_split_sentences_keeps_abbreviation_and_decimal(self):
        text = "See Fig. 2 at 1.25 V. The register is valid."
        self.assertEqual(
            split_sentences(text),
            ["See Fig. 2 at 1.25 V.", "The register is valid."],
        )

    def test_builds_main_and_relative_clause_tree(self):
        parsed = parse_sentence(
            "The write data, which is driven by the controller, is latched into the destination register."
        )
        main = next(clause for clause in parsed.clauses if clause.id == parsed.main_clause_id)
        relative = next(clause for clause in parsed.clauses if clause.relation == "relative")
        self.assertEqual(main.grammar.subject.lower(), "the write data")
        self.assertEqual(main.grammar.predicate, "is latched")
        self.assertEqual(main.grammar.voice, "passive")
        self.assertEqual(relative.parent_id, main.id)
        self.assertEqual(relative.grammar.agent, "the controller")
        self.assertIn("spacy-dependency", main.grammar.evidence_sources)
        self.assertEqual(main.grammar.agreement, "corroborated")

    def test_repairs_small_model_noun_root_mistag(self):
        parsed = parse_sentence(
            "Each buffer that stores incoming data is flushed when the engine completes an operation."
        )
        main = next(clause for clause in parsed.clauses if clause.id == parsed.main_clause_id)
        time_clause = next(clause for clause in parsed.clauses if clause.relation == "time")
        relative_clause = next(clause for clause in parsed.clauses if clause.relation == "relative")
        self.assertEqual(main.grammar.subject.lower(), "each buffer")
        self.assertEqual(main.grammar.predicate, "is flushed")
        self.assertEqual(main.grammar.object, "")
        self.assertEqual(main.text, "Each buffer is flushed")
        self.assertEqual(relative_clause.text, "that stores incoming data")
        self.assertEqual(relative_clause.parent_id, main.id)
        self.assertEqual(time_clause.parent_id, main.id)
        self.assertEqual(time_clause.grammar.subject, "the engine")

    def test_concession_main_and_time_boundary(self):
        source = (
            "Although the transfer is initiated at the falling edge, the data is not sampled "
            "by the slave until the arbiter grants ownership of the bus to the requester."
        )
        parsed = parse_sentence(source)
        main = next(clause for clause in parsed.clauses if clause.id == parsed.main_clause_id)
        concession = next(clause for clause in parsed.clauses if clause.relation == "concession")
        time_clause = next(clause for clause in parsed.clauses if clause.relation == "time")

        self.assertEqual(main.grammar.subject, "the data")
        self.assertEqual(main.grammar.predicate, "is not sampled")
        self.assertTrue(main.grammar.negated)
        self.assertEqual(main.grammar.voice, "passive")
        self.assertEqual(main.grammar.agent, "the slave")
        self.assertEqual(concession.marker.lower(), "although")
        self.assertEqual(time_clause.marker.lower(), "until")
        self.assertEqual(concession.parent_id, main.id)
        self.assertEqual(time_clause.parent_id, main.id)
        self.assertEqual(concession.text.lower().count("although"), 1)
        self.assertEqual(time_clause.text.lower().count("until"), 1)
        for clause in parsed.clauses:
            for start, end in clause.segments:
                self.assertEqual(source[start:end], source[start:end].strip(" ,;.—"))

    def test_nested_cause_keeps_parent_relation(self):
        parsed = parse_sentence(
            "The controller must wait until the request is granted because the bus is busy."
        )
        time_clause = next(clause for clause in parsed.clauses if clause.relation == "time")
        cause_clause = next(clause for clause in parsed.clauses if clause.relation == "cause")
        self.assertEqual(cause_clause.parent_id, time_clause.id)

    def test_requirement_strength_and_rich_grammar(self):
        parsed = parse_sentence("The controller must not ignore the pending request during calibration.")
        main = next(clause for clause in parsed.clauses if clause.id == parsed.main_clause_id)
        self.assertEqual(main.grammar.requirement_level, "prohibited")
        self.assertTrue(main.grammar.negated)
        self.assertIn("must", main.grammar.auxiliaries)
        self.assertTrue(main.grammar.prepositional_phrases)

    def test_rule_fallback_uses_same_schema(self):
        old_ok = spacy_parser._SPACY_OK
        try:
            spacy_parser._SPACY_OK = False
            parsed = parse_sentence("Although the bus is busy, the controller must stall.")
        finally:
            spacy_parser._SPACY_OK = old_ok
        self.assertEqual(parsed.engine, "rule-fallback")
        self.assertEqual(parsed.main_clause_id, "c0")
        self.assertTrue(parsed.clauses)
        self.assertTrue(parsed.warnings)

    def test_spacy_runtime_error_is_visible_in_warning(self):
        with patch("parse.spacy_parser.parse_spacy", side_effect=RuntimeError("boom")):
            with self.assertLogs("parse.clauser", level="ERROR"):
                parsed = parse_sentence("The controller waits.")
        self.assertEqual(parsed.engine, "rule-fallback")
        self.assertIn("RuntimeError", parsed.warnings[0])


class GlossaryTests(unittest.TestCase):
    def test_variant_and_user_override(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "glossary.json"
            path.write_text(
                json.dumps({"latency": {"pos": "n.", "zh": "自定义延迟", "note": "用户优先"}}, ensure_ascii=False),
                encoding="utf-8",
            )
            glossary = Glossary(str(path))
            self.assertEqual(glossary.lookup("latency")["zh"], "自定义延迟")
            self.assertTrue(glossary.lookup("flushed")["variant"])
            self.assertIsNone(glossary.lookup("not_in_dictionary"))

    def test_structured_translation_preserves_identifiers_and_modality(self):
        translated = translate_text("The controller must not ignore MR28 OP[5].", Glossary())
        self.assertIn("控制器", translated)
        self.assertIn("不得", translated)
        self.assertIn("MR28", translated)
        self.assertIn("OP[5]", translated)


class ApiTests(unittest.TestCase):
    def setUp(self):
        server.app.config.update(TESTING=True)
        self.client = server.app.test_client()
        server._analyze_sentence.cache_clear()

    def test_local_port_selection_falls_back_when_default_is_reserved(self):
        with patch.dict("os.environ", {}, clear=False), patch(
            "server._can_bind_local", side_effect=lambda port: port == 5800
        ):
            self.assertEqual(server._select_local_port(), 5800)

    def test_local_port_selection_honors_environment_override(self):
        with patch.dict("os.environ", {"PARSE_SPEC_PORT": "6800"}), patch(
            "server._can_bind_local", return_value=True
        ) as can_bind:
            self.assertEqual(server._select_local_port(), 6800)
            can_bind.assert_called_once_with(6800)

    def test_analyze_contract_v3(self):
        response = self.client.post(
            "/api/analyze",
            json={"sentences": ["The data is latched into the register."]},
        )
        self.assertEqual(response.status_code, 200)
        result = response.get_json()["results"][0]
        self.assertEqual(
            set(result),
            {
                "schema_version",
                "text",
                "engine",
                "main_clause_id",
                "clauses",
                "terms",
                "translation",
                "warnings",
            },
        )
        self.assertEqual(result["schema_version"], 3)
        self.assertEqual(result["translation"]["engine"], "structured-local")
        self.assertTrue(result["translation"]["text"])
        self.assertTrue(result["translation"]["clauses"])
        self.assertEqual(result["clauses"][0]["id"], result["main_clause_id"])
        self.assertIn("grammar", result["clauses"][0])
        self.assertIn("evidence_sources", result["clauses"][0]["grammar"])
        self.assertIn("segments", result["clauses"][0])

    def test_uses_spacy_lemma_for_irregular_glossary_hit(self):
        response = self.client.post(
            "/api/analyze",
            json={"sentences": ["The signal is driven by the controller."]},
        )
        self.assertEqual(response.status_code, 200)
        terms = response.get_json()["results"][0]["terms"]
        driven = next(term for term in terms if term["word"].lower() == "driven")
        self.assertEqual(driven["zh"], "驱动")
        self.assertTrue(driven["variant"])

    def test_rejects_invalid_sentences(self):
        response = self.client.post("/api/analyze", json={"sentences": "not-a-list"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("error", response.get_json())

        response = self.client.post("/api/analyze", json=[])
        self.assertEqual(response.status_code, 400)

        response = self.client.post("/api/analyze", json={"sentences": ["   "]})
        self.assertEqual(response.status_code, 400)

    def test_request_size_limit_and_security_headers(self):
        response = self.client.post(
            "/api/analyze",
            data=b"x" * (server.MAX_REQUEST_BYTES + 1),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 413)
        self.assertIn("不能超过", response.get_json()["error"])

        index = self.client.get("/")
        self.assertEqual(index.status_code, 200)
        self.assertIn("default-src 'self'", index.headers["Content-Security-Policy"])
        self.assertEqual(index.headers["X-Content-Type-Options"], "nosniff")
        index.close()

    def test_user_glossary_hot_reload_invalidates_cache(self):
        old_path = server._glossary_path
        old_glossary = server._glossary
        old_signature = server._glossary_signature
        try:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "glossary.json"
                path.write_text(
                    json.dumps({"latency": {"pos": "n.", "zh": "第一版", "note": ""}}, ensure_ascii=False),
                    encoding="utf-8",
                )
                server._glossary_path = path
                server._glossary_signature = None
                first = self.client.post("/api/analyze", json={"sentences": ["Latency matters."]})
                self.assertEqual(first.get_json()["results"][0]["terms"][0]["zh"], "第一版")

                path.write_text(
                    json.dumps({"latency": {"pos": "n.", "zh": "更新后的第二版", "note": ""}}, ensure_ascii=False),
                    encoding="utf-8",
                )
                second = self.client.post("/api/analyze", json={"sentences": ["Latency matters."]})
                self.assertEqual(second.get_json()["results"][0]["terms"][0]["zh"], "更新后的第二版")
        finally:
            server._glossary_path = old_path
            server._glossary = old_glossary
            server._glossary_signature = old_signature
            server._analyze_sentence.cache_clear()

    def test_glossary_api_lists_and_saves_user_entries(self):
        old_path = server._glossary_path
        old_glossary = server._glossary
        old_signature = server._glossary_signature
        try:
            with tempfile.TemporaryDirectory() as directory:
                server._glossary_path = Path(directory) / "glossary.json"
                server._glossary_signature = None
                listed = self.client.get("/api/glossary")
                self.assertEqual(listed.status_code, 200)
                self.assertTrue(any(entry["word"] == "protocol" for entry in listed.get_json()["entries"]))

                saved = self.client.post(
                    "/api/glossary",
                    json={"word": "frequency", "pos": "n.", "zh": "频率", "note": "每秒周期数"},
                )
                self.assertEqual(saved.status_code, 200)
                self.assertEqual(saved.get_json()["entry"]["source"], "custom")
                stored = json.loads(server._glossary_path.read_text(encoding="utf-8"))
                self.assertEqual(stored["frequency"]["zh"], "频率")

                listed_again = self.client.get("/api/glossary").get_json()["entries"]
                frequency = next(entry for entry in listed_again if entry["word"] == "frequency")
                self.assertEqual(frequency["source"], "custom")
        finally:
            server._glossary_path = old_path
            server._glossary = old_glossary
            server._glossary_signature = old_signature
            server._analyze_sentence.cache_clear()

    def test_bookmark_api_reads_writes_and_removes_project_file_entries(self):
        old_path = server._bookmarks_path
        try:
            with tempfile.TemporaryDirectory() as directory:
                server._bookmarks_path = Path(directory) / "bookmarks.json"
                document_key = "spec.pdf:1234"
                listed = self.client.get("/api/bookmarks", query_string={"document_key": document_key})
                self.assertEqual(listed.status_code, 200)
                self.assertEqual(listed.get_json()["bookmarks"], [])

                bookmark = {
                    "id": "b1",
                    "pageNum": 8,
                    "sentenceIndex": 2,
                    "text": "The controller waits.",
                    "createdAt": "2026-08-23T00:00:00.000Z",
                }
                saved = self.client.post(
                    "/api/bookmarks",
                    json={"document_key": document_key, "bookmarks": [bookmark]},
                )
                self.assertEqual(saved.status_code, 200)
                stored = json.loads(server._bookmarks_path.read_text(encoding="utf-8"))
                self.assertEqual(stored[document_key][0]["pageNum"], 8)

                invalid = self.client.post(
                    "/api/bookmarks",
                    json={"document_key": document_key, "bookmarks": [{**bookmark, "pageNum": 0}]},
                )
                self.assertEqual(invalid.status_code, 400)

                removed = self.client.post(
                    "/api/bookmarks",
                    json={"document_key": document_key, "bookmarks": []},
                )
                self.assertEqual(removed.status_code, 200)
                self.assertNotIn(document_key, json.loads(server._bookmarks_path.read_text(encoding="utf-8")))
        finally:
            server._bookmarks_path = old_path


if __name__ == "__main__":
    unittest.main()
