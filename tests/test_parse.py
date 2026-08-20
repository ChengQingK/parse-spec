# -*- coding: utf-8 -*-

import json
from pathlib import Path
import tempfile
import unittest

from parse.clauser import parse_sentence, split_sentences
from parse.glossary import Glossary
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


class ApiTests(unittest.TestCase):
    def setUp(self):
        server.app.config.update(TESTING=True)
        self.client = server.app.test_client()
        server._analyze_sentence.cache_clear()

    def test_analyze_contract_v2(self):
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
        self.assertEqual(result["schema_version"], 2)
        self.assertIsNone(result["translation"])
        self.assertEqual(result["clauses"][0]["id"], result["main_clause_id"])
        self.assertIn("grammar", result["clauses"][0])
        self.assertIn("segments", result["clauses"][0])

    def test_rejects_invalid_sentences(self):
        response = self.client.post("/api/analyze", json={"sentences": "not-a-list"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("error", response.get_json())

        response = self.client.post("/api/analyze", json=[])
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
