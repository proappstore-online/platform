"""Regression checks for the actual Zensical metadata and duplicate guard (#557)."""
import importlib.util
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("metadata", ROOT / "scripts/verify-docs-metadata.py")
metadata = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metadata)


class VerificationMetadataTests(unittest.TestCase):
    def test_verification_pages_render_distinct_accurate_descriptions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            docs = root / "docs"
            docs.mkdir()
            pages = {
                "windows-verification": "supported Linux runner",
                "promoter-funnel-verification": "referral attribution",
            }
            for slug in pages:
                shutil.copyfile(ROOT / "docs" / f"{slug}.md", docs / f"{slug}.md")
            (root / "mkdocs.yml").write_text(
                "site_name: Metadata regression\n"
                "site_url: https://docs.proappstore.online/\n"
                "site_description: Generic fallback must not be inherited.\n"
                "docs_dir: docs\n", encoding="utf-8")
            subprocess.run([sys.executable, "-m", "zensical", "build"], cwd=root,
                           check=True, capture_output=True, text=True)
            site = root / "site"
            metadata.verify(site)
            descriptions = []
            for slug, subject in pages.items():
                parsed = metadata.Metadata()
                parsed.feed((site / slug / "index.html").read_text(encoding="utf-8"))
                self.assertEqual(len(parsed.descriptions), 1)
                self.assertIn(subject, parsed.descriptions[0])
                descriptions.append(parsed.descriptions[0])
            self.assertNotEqual(*descriptions)

            # Mutating the generated HTML back to the original defect must fail.
            page = site / "promoter-funnel-verification/index.html"
            page.write_text(page.read_text(encoding="utf-8").replace(
                descriptions[1], descriptions[0]), encoding="utf-8")
            with self.assertRaisesRegex(AssertionError, "Duplicate description"):
                metadata.verify(site)


if __name__ == "__main__":
    unittest.main()
