"""定时抖动必须保留完整行程，幅度/采样协议可由元数据精确重建。"""

from collections import Counter
import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.detail.geometry import clean_path, parent_specs
from modules.whiteboard.ink.dataset.tremor.package import quarantine_reasons
from modules.whiteboard.ink.dataset.tremor.variants import PROTOCOL, temporal_jitter, timed_path, variants


class TremorGeometryTests(unittest.TestCase):
    """单笔完整拓扑与径向位移是可观测契约，不使用模型输出来决定标签。"""

    def test_six_views_keep_original_parent_splits_and_cover_declared_parameters(self):
        parents = parent_specs(10)
        for parent in parents:
            views = variants(parent)
            self.assertEqual(len(views), 6)
            self.assertEqual(len({v["sample_id"] for v in views}), 6)
            self.assertEqual(Counter(v["variant"]["amplitude_relative_size"] for v in views), {.015: 2, .03: 2, .05: 2})
            for view, protocol in zip(views, PROTOCOL):
                definition = view["variant"]
                self.assertEqual((definition["sampling_hz"], definition["speed_css_px_s"], definition["frequency_hz"], definition["amplitude_relative_size"]), protocol)
                base, times = timed_path(clean_path(parent["parameters"]), protocol[0], protocol[1])
                self.assertEqual(view["timestamps_seconds"], times)
                self.assertTrue(all(math.dist(a, b) <= protocol[3]*parent["parameters"]["size"] + 1e-8 for a, b in zip(base, view["paths"][0])))
                self.assertEqual(view["paths"], [temporal_jitter(base, times, parent["parameters"]["size"], protocol[3], protocol[2], definition["phases"])])

    def test_fixed_rate_observations_include_true_corners_and_whole_reversals(self):
        path = [[0, 0], [100, 0], [35, -31], [100, 0], [35, 31]]
        points, times = timed_path(path, 60, 420)
        self.assertEqual(points[0], path[0])
        self.assertEqual(points[-1], path[-1])
        self.assertTrue(all(point in points for point in path))
        self.assertEqual(sum(point == [100, 0] for point in points), 2)
        self.assertTrue(all(0 < b-a <= 1/60 + 1e-12 for a, b in zip(times, times[1:])))
        self.assertAlmostEqual(times[-1]*420, sum(math.dist(a, b) for a, b in zip(path, path[1:])))

    def test_revisited_locations_do_not_reuse_spatial_noise(self):
        path = [[0, 0], [10, 0], [0, 0]]
        result = temporal_jitter(path, [0, .031, .061], 100, .05, 9, [.2, 1.1, 2.4, 3.])
        self.assertNotEqual(result[0], result[-1])
        self.assertTrue(all(math.dist(a, b) <= 5 for a, b in zip(path, result)))

    def test_same_split_clean_reuse_is_allowed_but_source_test_pixels_block_training_views(self):
        rows = [{"sample_id": "ok", "parent_id": "p", "assigned_split": "train", "pixel_sha256": "new", "clean_pixel_sha256": "clean"},
                {"sample_id": "leak", "parent_id": "p", "assigned_split": "train", "pixel_sha256": "test", "clean_pixel_sha256": "clean"}]
        reservation = {"source_pixels_by_split": {"train": ["clean"], "test": ["test"]}, "pixel_sha256": []}
        cleans = [{"parent_id": "p", "split": "train"}]
        self.assertEqual(set(quarantine_reasons(rows, cleans, reservation)), {"leak"})
        reservation["pixel_sha256"].append("clean")
        self.assertEqual(set(quarantine_reasons(rows, cleans, reservation)), {"ok", "leak"})
        reservation["pixel_sha256"] = []
        cleans[0]["split"] = "review"
        self.assertEqual(quarantine_reasons(rows, cleans, reservation)["ok"], {"kind": "source_parent_excluded"})

    def test_invalid_sampling_and_degenerate_source_are_rejected(self):
        for path, sampling, speed in (([[0, 0], [0, 0]], 60, 60), ([[0, 0], [1, 0]], 59, 60),
                                      ([[0, 0], [1, 0]], 60, 0)):
            with self.assertRaises(ValueError):
                timed_path(path, sampling, speed)


if __name__ == "__main__":
    unittest.main()
