# -*- coding: utf-8 -*-

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from parse.clauser import parse_sentence, split_sentences
from parse.glossary import Glossary
from parse.complex_words import ComplexWordTable, extract_complex_words
from parse.translator import translate_sentence, translate_text
import parse.online_dict as online_dict
import parse.spacy_parser as spacy_parser
import server


class _NullOnlineDict:
    """suggest 测试用：本地未命中且不联网。"""

    def lookup(self, word):
        return None


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

    def test_timing_parameter_coordination_keeps_parallel_main_predicates(self):
        source = (
            "The t_phy_wrcsgap timing parameter specifies the minimum number of additional Data clocks "
            "required between commands when changing the target chip select driven on the dfi_wrdata_cs "
            "signal and defines a minimum additional delay between commands when changing the target chip "
            "select as required by the PHY."
        )
        parsed = parse_sentence(source)
        main = next(clause for clause in parsed.clauses if clause.id == parsed.main_clause_id)
        time_clauses = [clause for clause in parsed.clauses if clause.relation == "time"]
        basis = next(clause for clause in parsed.clauses if clause.relation == "basis")
        self.assertIn("timing parameter specifies", main.text)
        self.assertIn("and defines", main.text)
        self.assertEqual(len(time_clauses), 2)
        self.assertEqual(time_clauses[1].parent_id, main.id)
        self.assertEqual(basis.parent_id, time_clauses[1].id)
        self.assertEqual(basis.grammar.voice, "passive")

        translated = translate_sentence(parsed, Glossary())
        self.assertIn("t_phy_wrcsgap 时序参数", translated["text"])
        self.assertIn("最少附加数据时钟数", translated["text"])
        self.assertEqual([item["label"] for item in translated["clauses"]], ["第一项规定", "并列规定"])

    def test_complex_words_are_single_reading_words_not_phrases(self):
        hits = extract_complex_words("To ensure that updates do not interfere with other signals.", ComplexWordTable())
        by_lemma = {item["lemma"]: item for item in hits}
        self.assertEqual(by_lemma["ensure"]["zh"], "确保")
        self.assertEqual(by_lemma["interfere"]["zh"], "干扰；妨碍")
        self.assertTrue(all(" " not in item["word"] for item in hits))


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

    def test_update_sentence_translation_keeps_clickable_hard_words_in_readable_order(self):
        translated = translate_text(
            "To ensure that updates do not interfere with signals on the DRAM interface, "
            "the DFI supports update modes when the DFI bus is placed in an idle state.",
            Glossary(),
        )
        self.assertIn("为 ensure", translated)
        self.assertIn("发生 interfere", translated)
        self.assertIn("DRAM 接口上的信号", translated)
        self.assertIn("DFI 总线处于空闲状态", translated)


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
                "complex_words",
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
        old_backup_dir = server._glossary_backup_dir
        old_glossary = server._glossary
        old_signature = server._glossary_signature
        try:
            with tempfile.TemporaryDirectory() as directory:
                server._glossary_path = Path(directory) / "glossary.json"
                server._glossary_backup_dir = Path(directory) / "backups"
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

                deleted = self.client.delete("/api/glossary", json={"word": "frequency"})
                self.assertEqual(deleted.status_code, 200)
                self.assertNotIn("frequency", json.loads(server._glossary_path.read_text(encoding="utf-8")))
        finally:
            server._glossary_path = old_path
            server._glossary_backup_dir = old_backup_dir
            server._glossary = old_glossary
            server._glossary_signature = old_signature
            server._analyze_sentence.cache_clear()

    def test_glossary_backup_and_restore_round_trip(self):
        old_path = server._glossary_path
        old_backup_dir = server._glossary_backup_dir
        old_glossary = server._glossary
        old_signature = server._glossary_signature
        try:
            with tempfile.TemporaryDirectory() as directory:
                server._glossary_path = Path(directory) / "glossary.json"
                server._glossary_backup_dir = Path(directory) / "backups"
                server._glossary_path.write_text(
                    json.dumps({"latency": {"pos": "n.", "zh": "延迟", "note": ""}}, ensure_ascii=False),
                    encoding="utf-8",
                )
                created = self.client.post("/api/glossary/backups")
                self.assertEqual(created.status_code, 200)
                filename = created.get_json()["backup"]["filename"]
                self.assertEqual(created.get_json()["backup"]["entry_count"], 1)

                server._glossary_path.write_text("{}\n", encoding="utf-8")
                restored = self.client.post("/api/glossary/restore", json={"filename": filename})
                self.assertEqual(restored.status_code, 200)
                self.assertEqual(json.loads(server._glossary_path.read_text(encoding="utf-8"))["latency"]["zh"], "延迟")

                deleted = self.client.delete(f"/api/glossary/backups/{filename}")
                self.assertEqual(deleted.status_code, 200)
                self.assertFalse((server._glossary_backup_dir / filename).exists())
        finally:
            server._glossary_path = old_path
            server._glossary_backup_dir = old_backup_dir
            server._glossary = old_glossary
            server._glossary_signature = old_signature
            server._analyze_sentence.cache_clear()

    def test_complex_word_table_crud_and_analysis_refresh(self):
        old_path = server._complex_words_path
        old_table = server._complex_words
        old_signature = server._complex_words_signature
        old_online_dict = server._online_dict
        server._online_dict = _NullOnlineDict()
        try:
            with tempfile.TemporaryDirectory() as directory:
                server._complex_words_path = Path(directory) / "complex_words.json"
                server._complex_words = ComplexWordTable(server._complex_words_path)
                server._complex_words_signature = None

                listed = self.client.get("/api/complex-words")
                self.assertEqual(listed.status_code, 200)
                self.assertTrue(any(entry["word"] == "ensure" for entry in listed.get_json()["entries"]))

                suggested = self.client.get("/api/complex-words/suggest", query_string={"word": "latency"})
                self.assertEqual(suggested.status_code, 200)
                self.assertEqual(suggested.get_json()["suggestion"]["zh"], "延迟")
                missing = self.client.get("/api/complex-words/suggest", query_string={"word": "zzzzunknown"})
                self.assertEqual(missing.status_code, 404)

                saved = self.client.post(
                    "/api/complex-words",
                    json={"word": "intricate", "zh": "复杂的", "level": "较难", "note": "结构复杂"},
                )
                self.assertEqual(saved.status_code, 200)
                self.assertEqual(saved.get_json()["entry"]["source"], "custom")
                analyzed = self.client.post("/api/analyze", json={"sentences": ["An intricate sequence is required."]})
                hit = next(item for item in analyzed.get_json()["results"][0]["complex_words"] if item["lemma"] == "intricate")
                self.assertEqual(hit["zh"], "复杂的")

                rejected = self.client.post("/api/complex-words", json={"word": "two words", "zh": "两个词"})
                self.assertEqual(rejected.status_code, 400)
                deleted = self.client.delete("/api/complex-words", json={"word": "intricate"})
                self.assertEqual(deleted.status_code, 200)
                self.assertEqual(json.loads(server._complex_words_path.read_text(encoding="utf-8")), {})
        finally:
            server._complex_words_path = old_path
            server._complex_words = old_table
            server._complex_words_signature = old_signature
            server._online_dict = old_online_dict
            server._analyze_sentence.cache_clear()

    def test_complex_word_suggest_falls_back_to_online_zh_gloss(self):
        class YoudaoLikeOnlineDict:
            def lookup(self, word):
                if word == "generally":
                    return {
                        "word": "generally",
                        "phonetic": "/ˈdʒen(ə)rəli/",
                        "pos_entries": [],
                        "examples": [],
                        "collocations": [],
                        "zh_gloss": ["adv. 笼统地，大概；通常，普遍地"],
                        "source": "youdao",
                    }
                return None

        old_online_dict = server._online_dict
        server._online_dict = YoudaoLikeOnlineDict()
        try:
            suggested = self.client.get("/api/complex-words/suggest", query_string={"word": "generally"})
            self.assertEqual(suggested.status_code, 200)
            suggestion = suggested.get_json()["suggestion"]
            self.assertEqual(suggestion["zh"], "笼统地，大概；通常，普遍地")  # 去掉词性前缀
            self.assertEqual(suggestion["source"], "online")

            missing = self.client.get("/api/complex-words/suggest", query_string={"word": "zzzzunknown"})
            self.assertEqual(missing.status_code, 404)
        finally:
            server._online_dict = old_online_dict

    def test_word_info_validates_input_and_returns_details(self):
        class FakeOnlineDict:
            def lookup(self, word):
                if word == "interfere":
                    return {
                        "word": "interfere",
                        "phonetic": "/ˌɪntəˈfɪə(r)/",
                        "pos_entries": [{
                            "pos": "verb",
                            "definitions": ["Prevent from continuing."],
                            "examples": ["Noise may interfere with reception."],
                            "synonyms": ["disrupt"],
                        }],
                        "collocations": ["interfere with"],
                        "source": "dictionaryapi.dev",
                    }
                return None

        old_online_dict = server._online_dict
        server._online_dict = FakeOnlineDict()
        try:
            invalid = self.client.get("/api/word-info", query_string={"word": "two words"})
            self.assertEqual(invalid.status_code, 400)

            hit = self.client.get("/api/word-info", query_string={"word": "interfere"})
            self.assertEqual(hit.status_code, 200)
            info = hit.get_json()["info"]
            self.assertEqual(info["phonetic"], "/ˌɪntəˈfɪə(r)/")
            self.assertEqual(info["pos_entries"][0]["pos"], "verb")
            self.assertEqual(info["collocations"], ["interfere with"])

            missing = self.client.get("/api/word-info", query_string={"word": "zzzzunknown"})
            self.assertEqual(missing.status_code, 404)
        finally:
            server._online_dict = old_online_dict

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
                    "name": "校准时序要求",
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
                self.assertEqual(stored[document_key][0]["name"], "校准时序要求")

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


class OnlineDictionaryTests(unittest.TestCase):
    PAYLOAD = [{
        "word": "interfere",
        "phonetics": [{"text": "/ˌɪntəˈfɪə(r)/", "audio": ""}],
        "meanings": [{
            "partOfSpeech": "verb",
            "synonyms": ["hinder"],
            "definitions": [
                {
                    "definition": "Prevent (a process or activity) from continuing or being carried out properly.",
                    "example": "Noise may interfere with reception.",
                    "synonyms": ["disrupt"],
                },
                {"definition": "Intervene in a situation without invitation or necessity."},
            ],
        }],
    }]

    def test_normalize_collects_phonetic_pos_synonyms_and_collocations(self):
        info = online_dict._normalize(self.PAYLOAD, "interfere")
        self.assertEqual(info["phonetic"], "/ˌɪntəˈfɪə(r)/")
        self.assertEqual(info["pos_entries"][0]["pos"], "verb")
        self.assertEqual(len(info["pos_entries"][0]["definitions"]), 2)
        self.assertIn("disrupt", info["pos_entries"][0]["synonyms"])
        self.assertIn("hinder", info["pos_entries"][0]["synonyms"])
        self.assertEqual(info["collocations"], ["interfere with"])
        self.assertEqual(info["source"], "dictionaryapi.dev")

    def test_normalize_rejects_empty_payload(self):
        self.assertIsNone(online_dict._normalize([], "void"))
        self.assertIsNone(online_dict._normalize([{"meanings": []}], "void"))

    def test_lookup_caches_positive_and_negative_results_on_disk(self):
        with tempfile.TemporaryDirectory() as directory:
            cache_path = Path(directory) / "word_cache.json"
            dictionary = online_dict.OnlineDictionary(cache_path)
            calls = []

            def fake_fetch(word):
                calls.append(word)
                if word == "interfere":
                    return "hit", online_dict._normalize(self.PAYLOAD, word)
                return "not_found", None

            dictionary._fetch = fake_fetch
            self.assertIsNotNone(dictionary.lookup("interfere"))
            self.assertIsNone(dictionary.lookup("zzzzunknown"))
            dictionary.lookup("interfere")
            dictionary.lookup("zzzzunknown")
            self.assertEqual(calls, ["interfere", "zzzzunknown"])  # 命中缓存后不再联网

            reloaded = online_dict.OnlineDictionary(cache_path)
            reloaded._fetch = fake_fetch
            self.assertIsNotNone(reloaded.lookup("interfere"))
            self.assertIsNone(reloaded.lookup("zzzzunknown"))  # 磁盘负缓存同样生效
            self.assertEqual(calls, ["interfere", "zzzzunknown"])

    def test_expired_semantics_distinguish_hit_not_found_and_error(self):
        from datetime import timedelta
        now = online_dict._now()
        recent = (now - timedelta(minutes=5)).isoformat()
        two_hours_ago = (now - timedelta(hours=2)).isoformat()
        two_days_ago = (now - timedelta(days=2)).isoformat()
        hit_record = {"fetched_at": two_days_ago, "status": "hit", "result": {"word": "x"}}
        self.assertFalse(online_dict.OnlineDictionary._expired(hit_record))  # 命中永久有效
        self.assertFalse(online_dict.OnlineDictionary._expired({"fetched_at": recent, "status": "not_found", "result": None}))
        self.assertTrue(online_dict.OnlineDictionary._expired({"fetched_at": two_days_ago, "status": "not_found", "result": None}))
        self.assertFalse(online_dict.OnlineDictionary._expired({"fetched_at": recent, "status": "error", "result": None}))
        self.assertTrue(online_dict.OnlineDictionary._expired({"fetched_at": two_hours_ago, "status": "error", "result": None}))
        # 旧格式缓存（无 status 字段）按 result 推断
        self.assertFalse(online_dict.OnlineDictionary._expired({"fetched_at": two_days_ago, "result": {"word": "x"}}))

    def test_normalize_survives_malformed_fields(self):
        malformed = [{
            "phonetics": "not-a-list",
            "meanings": 42,
        }, {
            "meanings": [{"partOfSpeech": "noun", "synonyms": "oops", "definitions": [{"definition": "ok"}]}],
        }]
        info = online_dict._normalize(malformed, "word")
        self.assertEqual(info["pos_entries"][0]["definitions"], ["ok"])
        self.assertEqual(info["pos_entries"][0]["synonyms"], [])

    def test_lookup_rejects_invalid_words_without_fetching(self):
        dictionary = online_dict.OnlineDictionary(Path(tempfile.mkdtemp()) / "cache.json")
        dictionary._fetch = lambda word: self.fail("非法单词不应触发网络请求")
        self.assertIsNone(dictionary.lookup("two words"))
        self.assertIsNone(dictionary.lookup(""))

    YOUDAO_PAYLOAD = {
        "ec": {
            "word": [{
                "usphone": "ˈdʒen(ə)rəli",
                "ukphone": "ˈdʒen(ə)rəli",
                "trs": [{"tr": [{"l": {"i": "adv. 笼统地，大概；通常，普遍地"}}]}],
                "return-phrase": {"l": {"i": "generally"}},
            }],
        },
        "ee": {
            "source": {"name": "WordNet", "url": "https://wordnet.princeton.edu"},
            "word": {
                "trs": [{
                    "pos": "adv.",
                    "tr": [
                        {
                            "l": {"i": "usually; as a rule"},
                            "similar-words": [{"similar": "by and large"}, {"similar": "mostly"}],
                        },
                        {"l": {"i": "without distinction of one from others"}},
                    ],
                }],
                "phone": "'dʒenərəli",
            },
        },
        "blng_sents_part": {
            "sentence-count": 1,
            "sentence-pair": [{
                "sentence": "The plan was generally welcomed.",
                "sentence-eng": "The plan was <b>generally</b> welcomed.",
                "sentence-translation": "这个计划受到普遍的欢迎。",
            }],
        },
    }

    def test_normalize_youdao_collects_zh_gloss_definitions_and_examples(self):
        info = online_dict._normalize_youdao(self.YOUDAO_PAYLOAD, "generally")
        self.assertEqual(info["phonetic"], "/ˈdʒen(ə)rəli/")
        self.assertEqual(info["source"], "youdao")
        self.assertEqual(info["zh_gloss"], ["adv. 笼统地，大概；通常，普遍地"])
        self.assertEqual(info["pos_entries"][0]["pos"], "adv.")
        self.assertEqual(info["pos_entries"][0]["definitions"], ["usually; as a rule", "without distinction of one from others"])
        self.assertIn("mostly", info["pos_entries"][0]["synonyms"])
        self.assertEqual(info["examples"], ["The plan was generally welcomed.（这个计划受到普遍的欢迎。）"])

    def test_normalize_youdao_rejects_missing_or_malformed_payload(self):
        self.assertIsNone(online_dict._normalize_youdao({"input": "zzz", "lang": "en"}, "zzz"))  # 未收录
        self.assertIsNone(online_dict._normalize_youdao(None, "zzz"))

    def test_fetch_tries_sources_in_order_until_hit(self):
        calls = []

        def youdao_miss(word):
            calls.append(("youdao", word))
            return "not_found", None

        def freeapi_hit(word):
            calls.append(("freeapi", word))
            return "hit", {"word": word, "phonetic": "/x/", "pos_entries": [{"pos": "noun", "definitions": ["ok"], "examples": [], "synonyms": []}], "collocations": [], "source": "dictionaryapi.dev"}

        with tempfile.TemporaryDirectory() as directory:
            dictionary = online_dict.OnlineDictionary(Path(directory) / "cache.json", sources=("youdao", "freeapi"))
            with patch.dict(online_dict.PROVIDERS, {"youdao": youdao_miss, "freeapi": freeapi_hit}):
                self.assertIsNotNone(dictionary.lookup("party"))
        self.assertEqual(calls, [("youdao", "party"), ("freeapi", "party")])

    def test_fetch_breaker_skips_recently_failed_source(self):
        calls = []

        def youdao_error(word):
            calls.append(("youdao", word))
            return "error", None

        def freeapi_hit(word):
            calls.append(("freeapi", word))
            return "hit", {"word": word, "phonetic": "/x/", "pos_entries": [{"pos": "noun", "definitions": ["ok"], "examples": [], "synonyms": []}], "collocations": [], "source": "dictionaryapi.dev"}

        with tempfile.TemporaryDirectory() as directory:
            dictionary = online_dict.OnlineDictionary(Path(directory) / "cache.json", sources=("youdao", "freeapi"))
            with patch.dict(online_dict.PROVIDERS, {"youdao": youdao_error, "freeapi": freeapi_hit}):
                self.assertIsNotNone(dictionary.lookup("party"))       # 首次：youdao 失败并熔断，freeapi 兜底
                self.assertIsNotNone(dictionary.lookup("evaluation"))  # 熔断期内 youdao 被跳过
        self.assertEqual(
            calls,
            [("youdao", "party"), ("freeapi", "party"), ("freeapi", "evaluation")],
        )

    def test_fetch_reports_error_when_all_sources_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            dictionary = online_dict.OnlineDictionary(Path(directory) / "cache.json", sources=("youdao",))
            with patch.dict(online_dict.PROVIDERS, {"youdao": lambda word: ("error", None)}):
                self.assertIsNone(dictionary.lookup("party"))
            self.assertEqual(dictionary.sources, ["youdao"])

    def test_unknown_source_names_fall_back_to_defaults(self):
        dictionary = online_dict.OnlineDictionary(Path(tempfile.mkdtemp()) / "cache.json", sources=("nope", "freeapi"))
        self.assertEqual(dictionary.sources, ["freeapi"])


if __name__ == "__main__":
    unittest.main()
