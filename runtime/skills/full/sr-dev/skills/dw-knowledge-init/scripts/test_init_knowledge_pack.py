#!/usr/bin/env python3
import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("init_knowledge_pack.py")


def load_module():
    spec = importlib.util.spec_from_file_location("init_knowledge_pack", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class InitKnowledgePackTest(unittest.TestCase):
    def setUp(self):
        self.module = load_module()
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.root = Path(self.tempdir.name)
        self.source = self.root / "source"
        self.output = self.root / "knowledge-pack"
        self.source.mkdir()
        (self.source / "02-核心表目录与字段.md").write_text("# 核心表目录与字段\n\nfox table", encoding="utf-8")
        (self.source / "notes.txt").write_text("plain notes", encoding="utf-8")

    def test_initializes_version_files_and_index(self):
        result = self.module.init_knowledge_pack(
            self.source,
            self.output,
            "fox",
            "贷后 FOX",
            "fox_2026070611X",
            "owenzhang",
            "unit test",
        )

        domain_root = self.output / "domains" / "fox"
        self.assertEqual("fox", result["domain"])
        self.assertTrue((domain_root / "manifest.yaml").is_file())
        self.assertTrue((domain_root / "versions.yaml").is_file())
        self.assertTrue((domain_root / "index.yaml").is_file())
        index = (domain_root / "index.yaml").read_text(encoding="utf-8")
        versions = (domain_root / "versions.yaml").read_text(encoding="utf-8")
        self.assertIn("domain_version: fox_2026070611X", index)
        self.assertIn("file_version: fox_2026070611X_001", index)
        self.assertIn("sha256:", index)
        self.assertIn("content_url: \"/api/knowledge/files?path=domains/fox/", index)
        self.assertIn("current_version: fox_2026070611X", versions)
        self.assertNotIn(".codex/skills", index)

    def test_rejects_skill_directory_as_output_root(self):
        with self.assertRaisesRegex(ValueError, "must not"):
            self.module.init_knowledge_pack(
                self.source,
                Path("/tmp/.codex/skills/warehouse-knowledge"),
                "fox",
                "贷后 FOX",
                "fox_2026070611X",
                "owenzhang",
                "unit test",
            )


if __name__ == "__main__":
    unittest.main()
