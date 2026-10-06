"""独立母图、可观测时间采样、有界噪声及全局保留冲突的几何契约。"""

from collections import Counter
from copy import deepcopy
import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.detail.geometry import parent_specs as old_parents
from modules.whiteboard.ink.dataset.motion.geometry import clean_path, parent_specs
from modules.whiteboard.ink.dataset.motion.reservation import quarantine_reasons
from modules.whiteboard.ink.dataset.motion.variants import PROTOCOL, _detail_path, bounded_noise, path_times, sample_motion, variants


class MotionGeometryTests(unittest.TestCase):
    """标签来自独立解析目标；低采样率及抖动不能隐式删角点、箭翼或回折。"""

    def test_independent_parents_fixed_splits_and_ellipse_coverage(self):
        parents = parent_specs()
        self.assertEqual(len(parents), 1920)
        self.assertFalse({p["parent_id"] for p in parents} & {p["parent_id"] for p in old_parents()})
        for label in ("line", "circle", "ellipse", "arc", "rectangle", "triangle", "arrow", "other"):
            self.assertEqual(Counter(p["assigned_split"] for p in parents if p["label"] == label), {"train": 192, "val": 24, "test": 24})
        ellipses = [p["parameters"]["axis_ratio"] for p in parents if p["label"] == "ellipse"]
        self.assertEqual(sum(.7 <= ratio <= .8 for ratio in ellipses), 144)
        self.assertTrue(all(.4 <= ratio <= .8 for ratio in ellipses))
        self.assertEqual(Counter(p["parameters"]["family"] for p in parents if p["label"] == "other"),
                         {family: 48 for family in ("pentagon", "trapezoid", "spiral", "wave", "figure_eight")})

    def test_variable_speed_sampling_preserves_arrow_branches_and_maximum_observation_gap(self):
        path = [[0, 0], [100, 0], [35, -31], [100, 0], [35, 31]]
        times = path_times(path, 100, .4)
        segment_speeds = [math.dist(a, b)/(end-start) for a, b, start, end in zip(path, path[1:], times, times[1:])]
        self.assertTrue(all(55 <= speed <= 145 for speed in segment_speeds))
        self.assertGreater(max(segment_speeds)-min(segment_speeds), 20)
        for sampling in (24, 60, 120, 240):
            points, observed = sample_motion(path, sampling, 100, .4)
            self.assertTrue(all(p in points for p in path))
            self.assertEqual(sum(p == [100, 0] for p in points), 2)
            self.assertEqual(points[0], path[0])
            self.assertEqual(points[-1], path[-1])
            self.assertTrue(all(0 < b-a <= 1/sampling + 1e-12 for a, b in zip(observed, observed[1:])))

    def test_motion_field_is_radially_bounded_and_same_time_is_independent_of_sampling_rate(self):
        phases = [i*.37 for i in range(16)]
        times = [i/240 for i in range(1201)]
        path = [[0., 0.] for _ in times]
        for amplitude in (.03, .05):
            fine = bounded_noise(path, times, 100, amplitude, phases)
            coarse = bounded_noise(path[::10], times[::10], 100, amplitude, phases)
            self.assertEqual(fine[::10], coarse)
            self.assertTrue(all(math.hypot(*p) <= amplitude*100 + 1e-8 for p in fine))
            self.assertNotEqual(fine[0], fine[-1])

    def test_nine_views_cover_protocol_and_keep_local_detail_contracts(self):
        parents = parent_specs(10)
        for label in ("line", "circle", "ellipse", "arc", "rectangle", "triangle", "arrow", "other"):
            parent = next(p for p in parents if p["label"] == label)
            views = variants(parent)
            self.assertEqual(len(views), 9)
            self.assertEqual(views[0]["paths"], [clean_path(parent["parameters"])])
            self.assertEqual(Counter(v["variant"]["sampling_hz"] for v in views[1:]), {rate: 2 for rate in (24, 60, 120, 240)})
            for view, protocol in zip(views[1:], PROTOCOL):
                definition = view["variant"]
                self.assertEqual((definition["sampling_hz"], definition["amplitude_relative_size"], definition["speed_css_px_s"]), protocol)
                original, _ = _detail_path(views[0]["paths"][0], parent, views.index(view)-1)
                base, _ = sample_motion(original, protocol[0], protocol[2], definition["phases"][14])
                self.assertTrue(all(math.dist(a, b) <= protocol[1]*parent["parameters"]["size"] + 1e-8 for a, b in zip(base, view["paths"][0])))
            clean = views[0]["paths"][0]
            retrace, kind = _detail_path(clean, parent, 4)
            if label == "other":
                self.assertEqual(kind, "none")
            else:
                self.assertTrue(all(p in retrace for p in clean))
                tail, _ = _detail_path(clean, parent, 5)
                self.assertEqual(tail[:len(clean)], clean)
                length = sum(math.dist(a, b) for a, b in zip(tail[len(clean)-1:], tail[len(clean):]))
                self.assertAlmostEqual(length/parent["parameters"]["size"], .02)

    def test_new_conflicts_quarantine_pairs_without_mutating_any_old_reservation(self):
        def row(identifier, parent, split, label, digest, geometry, clean=False):
            return {"sample_id": identifier, "parent_id": parent, "group_id": f"g-{parent}", "assigned_split": split,
                    "source_label": label, "pixel_sha256": digest,
                    "provenance": {"geometry_sha256": geometry, "variant": {"kind": "clean" if clean else "variable_motion"}}}
        reservation = {"pixels": {"old-test": [["test", "circle"]], "same-train": [["train", "line"]]},
                       "geometries": {"old-geometry": [["train", "line"]]}, "parent_identities": ["old-parent"],
                       "protected_pixels": [], "protected_geometry": []}
        original = deepcopy(reservation)
        rows = [row("clean-a", "a", "train", "circle", "old-test", "new-a", True),
                row("view-a", "a", "train", "circle", "a-view", "a-view"),
                row("clean-b", "b", "train", "line", "same-train", "new-b", True),
                row("view-b", "b", "train", "line", "b-view", "old-geometry"),
                row("clean-c", "c", "train", "other", "same-train", "new-c", True),
                row("view-c", "c", "train", "other", "c-view", "c-view")]
        reasons = quarantine_reasons(rows, reservation)
        self.assertEqual(set(reasons), {"clean-a", "view-a", "clean-b", "view-b", "clean-c", "view-c"})
        self.assertTrue(all(r["kind"] == "clean_pair_conflict" for r in reasons.values()))
        self.assertEqual(reservation, original)
        solo = [row("ok", "p", "train", "line", "same-train", "new", True)]
        self.assertFalse(quarantine_reasons(solo, reservation))

    def test_invalid_input_and_nonfinite_parameters_are_rejected(self):
        with self.assertRaises(ValueError):
            path_times([[0, 0], [0, 0]], 100, 0)
        with self.assertRaises(ValueError):
            sample_motion([[0, 0], [1, 0]], 25, 100, 0)
        with self.assertRaises(ValueError):
            bounded_noise([[0, 0], [1, 0]], [0, 1], 100, .05, [float("nan")]*16)


if __name__ == "__main__":
    unittest.main()
