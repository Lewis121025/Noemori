"""几何数据契约与标签语义；不把生成器能记住自己的结果当作泛化测试。"""

import copy
from collections import Counter
import math
from pathlib import Path
import random
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.geometry import FAMILIES, make_geometry, perturb
from modules.whiteboard.ink.dataset.samples import generate_group, iter_samples, split_for_group
from modules.whiteboard.ink.dataset.schema import validate_sample


class DatasetContractTests(unittest.TestCase):
    """合法多路径目标与严格输入边界，防止训练特征泄漏。"""

    def setUp(self):
        self.sample = generate_group(41, 0)[1]

    def test_keep_replace_and_multiple_output_paths_are_valid(self):
        for sample in generate_group(41, 0):
            validate_sample(sample)
        sample = copy.deepcopy(self.sample)
        original = sample["target"]["strokes"][0]["points"]
        middle = len(original) // 2
        sample["target"]["strokes"] = [{"points": original[:middle + 1]}, {"points": original[middle:]}]
        validate_sample(sample)
        self.assertEqual(len(sample["target"]["source_stroke_ids"]), 1)
        self.assertEqual(len(sample["target"]["strokes"]), 2)

    def test_current_stroke_can_be_correct_while_only_an_old_stroke_changes(self):
        sample = copy.deepcopy(self.sample)
        sources = sample["target"]["source_stroke_ids"]
        sample["input"]["focus_stroke_id"] = next(stroke["id"] for stroke in sample["input"]["strokes"]
                                                    if stroke["id"] not in sources)
        validate_sample(sample)

    def test_unknown_fields_and_action_features_cannot_enter_input(self):
        for name in ("time", "pressure", "velocity", "family", "target", "corruption"):
            with self.subTest(name=name):
                sample = copy.deepcopy(self.sample)
                sample["input"][name] = 1
                with self.assertRaises(ValueError):
                    validate_sample(sample)
        sample = copy.deepcopy(self.sample)
        sample["input"]["strokes"][0]["pressure"] = .5
        with self.assertRaises(ValueError):
            validate_sample(sample)

    def test_invalid_coordinates_and_empty_paths_are_rejected(self):
        for value in (float("nan"), float("inf"), -float("inf"), 10 ** 1000, True, "0", None):
            with self.subTest(value=value):
                sample = copy.deepcopy(self.sample)
                sample["input"]["strokes"][0]["points"][0][0] = value
                with self.assertRaises(ValueError):
                    validate_sample(sample)
        for points in ([], [[1, 2, 3]], [[1]], "bad"):
            sample = copy.deepcopy(self.sample)
            sample["target"]["strokes"][0]["points"] = points
            with self.assertRaises(ValueError):
                validate_sample(sample)

    def test_id_references_and_label_provenance_are_checked(self):
        cases = []
        sample = copy.deepcopy(self.sample)
        sample["input"]["focus_stroke_id"] = "missing"
        cases.append(sample)
        sample = copy.deepcopy(self.sample)
        sample["input"]["strokes"][1]["id"] = sample["input"]["strokes"][0]["id"]
        cases.append(sample)
        for sources in ([], ["missing"], self.sample["target"]["source_stroke_ids"] * 2):
            sample = copy.deepcopy(self.sample)
            sample["target"]["source_stroke_ids"] = sources
            cases.append(sample)
        sample = copy.deepcopy(self.sample)
        sample["annotation"]["status"] = "confirmed"
        cases.append(sample)
        sample = copy.deepcopy(self.sample)
        sample["provenance"]["kind"] = "manual"
        cases.append(sample)
        sample = copy.deepcopy(self.sample)
        sample["schema_version"] = True
        cases.append(sample)
        sample = copy.deepcopy(self.sample)
        sample["target"] = {"action": "keep"}
        cases.append(sample)
        for index, sample in enumerate(cases):
            with self.subTest(index=index), self.assertRaises(ValueError):
                validate_sample(sample)


class DatasetGenerationTests(unittest.TestCase):
    """可复现性、空间扰动和监督作用范围。"""

    def test_same_seed_reproduces_all_fields_without_shared_mutable_state(self):
        first = generate_group(57, 7)
        second = generate_group(57, 7)
        self.assertEqual(first, second)
        first[0]["input"]["strokes"][0]["points"][0][0] += 123
        self.assertEqual(second, generate_group(57, 7))
        self.assertNotEqual(second, generate_group(58, 7))

    def test_all_groups_stay_in_one_split_as_dataset_grows(self):
        memberships = {}
        sample_ids = set()
        counts = {}
        for split, sample in iter_samples(57, 100):
            group = sample["group_id"]
            self.assertEqual(memberships.setdefault(group, split), split)
            self.assertNotIn(sample["sample_id"], sample_ids)
            sample_ids.add(sample["sample_id"])
            counts[group] = counts.get(group, 0) + 1
            self.assertEqual(split_for_group(group), split)
        self.assertEqual(set(memberships.values()), {"train", "val", "test"})
        self.assertEqual(set(counts.values()), {8})
        for split, sample in iter_samples(57, 120):
            if sample["group_id"] in memberships:
                self.assertEqual(split, memberships[sample["group_id"]])

    def test_keep_includes_intentional_double_lines_sharp_corners_and_free_curves(self):
        for index, family in enumerate(FAMILIES):
            group = generate_group(29, index)
            keeps = [sample for sample in group if sample["target"]["action"] == "keep"]
            self.assertEqual(len(keeps), 2)
            self.assertEqual({sample["provenance"]["family"] for sample in keeps}, {family})
            for sample in keeps:
                self.assertEqual(sample["target"], {"action": "keep"})
        double = make_geometry("double_line", random.Random(3)).paths
        self.assertEqual(len(double), 2)
        self.assertNotEqual(double[0][0], double[1][0])

    def test_exact_circles_and_squares_have_measured_quarter_coverage(self):
        counts = Counter()
        for group_index in range(160):
            if group_index % 10 in (2, 8):
                counts[generate_group(17, group_index)[0]["provenance"]["primitive"]] += 1
        self.assertEqual(counts, {"circle": 4, "ellipse": 12, "square": 4, "rectangle": 12})
        circle = make_geometry("ellipse", random.Random(7), regular=True)
        self.assertTrue(all(abs(math.hypot(x, y) - 1) < 1e-12 for x, y in circle.paths[0]))
        square = make_geometry("frame", random.Random(7), regular=True)
        self.assertTrue(all(math.dist(path[0], path[-1]) == 2 for path in square.paths))

    def test_merge_targets_cover_full_existing_paths_without_touching_context(self):
        # 极远上下文使范围错误可从几何结果发现，而不依赖生成器的内部选中列表。
        context = [[(10000.0, 10000.0), (10001.0, 10000.0)]]
        with patch("modules.whiteboard.ink.dataset.samples._context", return_value=context):
            group = generate_group(73, 0)
        for sample in group:
            if sample["target"]["action"] == "keep":
                continue
            target = sample["target"]
            sources = set(target["source_stroke_ids"])
            context_strokes = [stroke for stroke in sample["input"]["strokes"]
                               if max(abs(value) for point in stroke["points"] for value in point) > 100000]
            self.assertEqual(len(context_strokes), 1)
            self.assertTrue(all(stroke["id"] not in sources for stroke in context_strokes))
            self.assertTrue(all(abs(value) < 1000 for stroke in target["strokes"]
                                for point in stroke["points"] for value in point))
            self.assertIn(sample["input"]["focus_stroke_id"], sources)
            if sample["provenance"]["corruption"] in ("retrace", "fragment"):
                self.assertGreater(len(sources), len(target["strokes"]))
                self.assertEqual(len(target["strokes"]), 1)

    def test_ids_and_presentation_do_not_encode_selection_or_drawing_order(self):
        focus_positions = set()
        nonmatching_retrace_lengths = 0
        for index in range(60):
            sample = generate_group(91, index)[5]
            identifiers = [stroke["id"] for stroke in sample["input"]["strokes"]]
            focus_positions.add(identifiers.index(sample["input"]["focus_stroke_id"]))
            self.assertTrue(all(identifier.startswith("s-") and len(identifier) == 10 for identifier in identifiers))
            lengths = {len(stroke["points"]) for stroke in sample["input"]["strokes"]
                       if stroke["id"] in sample["target"]["source_stroke_ids"]}
            nonmatching_retrace_lengths += len(lengths) > 1
        self.assertGreater(len(focus_positions), 4)
        self.assertGreater(nonmatching_retrace_lengths, 40)

    def test_spatial_noise_is_invariant_to_extra_collinear_samples(self):
        sparse = [(0.0, 0.0), (.1, 0.0), (2.0, 0.0)]
        dense = [(0.0, 0.0), (.1, 0.0), (1.0, 0.0), (2.0, 0.0)]
        for kind in ("jitter", "drift", "endpoint", "mixed"):
            a = perturb(sparse, kind, .02, random.Random(13))
            b = perturb(dense, kind, .02, random.Random(13))
            self.assertEqual(a, [b[0], b[1], b[3]])
            self.assertTrue(all(math.dist(original, modified) < .16 for original, modified in zip(sparse, a)))

    def test_invalid_generator_parameters_are_rejected(self):
        for seed, group in ((-1, 0), (0, -1), (True, 0), (0, 1.5)):
            with self.assertRaises(ValueError):
                generate_group(seed, group)
        with self.assertRaises(ValueError):
            list(iter_samples(0, 0))


if __name__ == "__main__":
    unittest.main()
