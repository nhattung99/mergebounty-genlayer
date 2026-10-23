import unittest
from pathlib import Path


REQUIRED = "MergeBounty demo note: this file was added for the studionet bounty."


class BountyDemoTest(unittest.TestCase):
    def test_file_contains_the_required_sentence(self):
        text = Path("docs/bounty-demo.md").read_text(encoding="utf-8").strip()
        self.assertEqual(text, REQUIRED)


if __name__ == "__main__":
    unittest.main()
