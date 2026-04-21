from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from chapter_artifact_rebuild import rebuild_chapter_artifacts, resolve_default_enrichment_path


class ChapterArtifactRebuildTest(unittest.TestCase):
    def test_resolve_default_enrichment_path_uses_canonical_file(self) -> None:
        enrichment_path = resolve_default_enrichment_path("renjian-bailijin", "chapter-001")
        self.assertEqual(
            enrichment_path,
            ROOT / "data" / "translated" / "renjian-bailijin" / "chapter-001" / "full-chapter-enrichment.json",
        )

    def test_rebuild_chapter_artifacts_uses_existing_full_chapter_enrichment(self) -> None:
        rebuild_chapter_artifacts("renjian-bailijin", "chapter-001")

        read_model_path = ROOT / "data" / "processed" / "annotations" / "renjian-bailijin" / "chapter-001" / "read-model.json"
        refine_model_path = ROOT / "data" / "processed" / "annotations" / "renjian-bailijin" / "chapter-001" / "refine-model.json"

        read_model = json.loads(read_model_path.read_text(encoding="utf-8"))
        refine_model = json.loads(refine_model_path.read_text(encoding="utf-8"))

        self.assertEqual(read_model["series"], "renjian-bailijin")
        self.assertEqual(read_model["chapter"], "chapter-001")
        self.assertTrue(read_model["sentences"])
        self.assertTrue(read_model["words"])
        self.assertTrue(read_model["chapterNotes"])
        self.assertEqual(refine_model["series"], "renjian-bailijin")
        self.assertEqual(refine_model["chapter"], "chapter-001")
        self.assertTrue(refine_model["sentences"])
        self.assertIn("patches", refine_model)


if __name__ == "__main__":
    unittest.main()
