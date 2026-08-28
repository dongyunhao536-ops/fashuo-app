# [gpt] 2026-08-28: Regression tests for reviewed lecture-box extraction.
import copy
import hashlib
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "extractor", Path(__file__).with_name("extract-jiangyi-xinde.py"))
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)


class ReviewedBoxTests(unittest.TestCase):
    def setUp(self):
        self.source = "\n".join([
            "===== 第19页 =====", "［老马识途］", "1.第一个完整知识点。",
            "14", "===== 第20页 =====", "第一章 宪法基本理论",
            "2.跨页的第二个知识点。", "［注意］框内的完整提示。",
            "3.不能因嵌套提示丢失的后续点。", "典型真题", "A.不应进入心得的选项。",
        ]).encode("utf-8")
        self.manifest = {
            "subject": "宪法", "sourceSha256": hashlib.sha256(self.source).hexdigest(),
            "boxes": [{"id": "XF-test", "marker": "老马识途", "anchorLine": 2,
                       "anchorText": "［老马识途］", "pdfPages": [19, 20], "bookPages": [14, 15],
                       "segments": [{"startLine": 3, "endLine": 3}, {"startLine": 7, "endLine": 9}]}],
        }

    def test_keeps_cross_page_lists_and_nested_notes_without_exam_or_headers(self):
        boxes = extractor.extract_manifest_boxes(self.source, self.manifest, "宪法")
        body = boxes[0][2]
        self.assertIn("PDF第19–20页；书页14–15", body)
        self.assertIn("1.第一个完整知识点。2.跨页的第二个知识点。", body)
        self.assertIn("［注意］框内的完整提示。3.不能因嵌套提示丢失的后续点。", body)
        self.assertNotIn("典型真题", body)
        self.assertNotIn("第一章", body)

    def test_stale_source_rejected(self):
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            extractor.extract_manifest_boxes(self.source + b"\n", self.manifest, "宪法")

    def test_bad_ranges_pages_anchor_and_subject_rejected(self):
        for change in [
            {"segments": [{"startLine": 0, "endLine": 3}]},
            {"segments": [{"startLine": 7, "endLine": 9}, {"startLine": 8, "endLine": 9}]},
            {"segments": [{"startLine": 3, "endLine": 7}]},
            {"segments": []}, {"pdfPages": [19]}, {"anchorText": "假标题"},
        ]:
            with self.subTest(change=change):
                manifest = copy.deepcopy(self.manifest)
                manifest["boxes"][0].update(change)
                with self.assertRaises(ValueError):
                    extractor.extract_manifest_boxes(self.source, manifest, "宪法")
        with self.assertRaisesRegex(ValueError, "科目"):
            extractor.extract_manifest_boxes(self.source, self.manifest, "民法")

    def test_inline_marker_stripped_once(self):
        manifest = copy.deepcopy(self.manifest)
        manifest["boxes"] = [{"id": "note", "marker": "注意", "anchorLine": 8,
                              "anchorText": "［注意］框内的完整提示。", "pdfPages": [20],
                              "bookPages": [15, 15], "segments": [{"startLine": 8, "endLine": 8}]}]
        body = extractor.extract_manifest_boxes(self.source, manifest, "宪法")[0][2]
        self.assertTrue(body.endswith("框内的完整提示。"))
        self.assertNotIn("［注意］", body)

    def test_missing_ocr_title_keeps_first_body_line(self):
        manifest = copy.deepcopy(self.manifest)
        entry = manifest["boxes"][0]
        entry.update(anchorLine=3, anchorText="1.第一个完整知识点。", markerOcrMissing=True)
        self.assertIn("1.第一个完整知识点。", extractor.extract_manifest_boxes(
            self.source, manifest, "宪法")[0][2])


if __name__ == "__main__":
    unittest.main()
