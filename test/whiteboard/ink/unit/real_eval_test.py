"""真实评测的许可筛选、配对关系和 SVG 边界测试。"""

import csv
import io
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.real_eval.sources import available_candidates, inspect_svg, select_candidates


class RealSourceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.table = io.StringIO()
        writer = csv.writer(self.table)
        writer.writerow(["Name", "Author", "Preferred Attribution", "Author Homepage", "Copyright",
                         "Source", "Genre", "Background", "Cleaned"])
        writer.writerow(["Shape_01", "Artist", "Credit", "", "CC-BY-4.0", "source", "Art", "Paper", "Yes"])
        writer.writerow(["Shape_02", "Artist", "", "", "Academic Paper", "source", "Art", "Paper", "Yes"])
        self.page = (b'<a href="../Benchmark_Dataset/GT/Shape_01_Artist%20A_norm_cleaned.svg">a</a>'
                     b'<a href="../Benchmark_Dataset/GT/Shape_01_Artist%20B_norm_cleaned.svg">b</a>'
                     b'<a href="../Benchmark_Dataset/GT/Shape_01_Artist%20A_norm_full.svg">full</a>')

    def test_selects_explicit_license_and_retains_all_cleaned_references(self) -> None:
        selected = select_candidates(self.table.getvalue().encode(), self.page)
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]["attribution"], "Credit")
        self.assertEqual([r["artist"] for r in selected[0]["references"]], ["Artist A", "Artist B"])

    def test_missing_reference_is_an_error_instead_of_silent_selection_bias(self) -> None:
        with self.assertRaisesRegex(ValueError, "多参考"):
            select_candidates(self.table.getvalue().encode(), self.page.split(b'</a>')[0] + b'</a>')

    def test_external_reference_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "上游 GT"):
            select_candidates(self.table.getvalue().encode(), self.page + b'<a href="https://other.test/x_norm_cleaned.svg">x</a>')

    def test_missing_input_variant_is_reported_instead_of_inventing_a_url(self) -> None:
        selected = select_candidates(self.table.getvalue().encode(), self.page)
        missing = {**selected[0], "sketch_id": "missing", "rough_shape_url": "missing.svg"}
        page = (b'<a href="../Benchmark_Dataset/Rough/SVG/Shape_01_norm_rough.svg">shape</a>'
                b'<a href="../Benchmark_Dataset/Rough/SVG/Shape_01_norm_full.svg">full</a>')
        available, excluded = available_candidates([*selected, missing], page)
        self.assertEqual(available, selected)
        self.assertEqual(excluded[0]["sketch_id"], "missing")

    def test_svg_preserves_viewbox_and_ignores_metadata_as_geometry(self) -> None:
        result = inspect_svg(b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-5,0,100,80">'
                             b'<metadata>source</metadata><path d="M0 0L1 1"/></svg>')
        self.assertEqual(result, {"view_box": [-5.0, 0.0, 100.0, 80.0], "primitives": {"path": 1}})

    def test_svg_accepts_local_style_references_without_fetching_resources(self) -> None:
        result = inspect_svg(b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
                             b'<defs><rect id="box" width="5" height="5"/>'
                             b'<clipPath id="clip"><use href="#box"/></clipPath></defs>'
                             b'<style>.line{clip-path:url(#clip)}</style><path class="line" d="M0 0L5 5"/></svg>')
        self.assertEqual(result["primitives"]["path"], 1)

    def test_svg_rejects_nonfinite_frame_and_active_or_external_content(self) -> None:
        for body, frame in ((b'<path d="M0 0L1 1"/>', '0 0 nan 10'),
                            (b'<script>bad()</script><path/>', '0 0 10 10'),
                            (b'<image href="https://other.test/x.png"/>', '0 0 10 10'),
                            (b'<path onload="bad()"/>', '0 0 10 10'),
                            (b'<style>@import "a.css";</style><path/>', '0 0 10 10')):
            with self.subTest(body=body, frame=frame), self.assertRaises(ValueError):
                inspect_svg(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{frame}">'.encode() + body + b'</svg>')


if __name__ == "__main__":
    unittest.main()
