"""数据边界、分组与可复现性契约；不访问网络，不按预测模型结果选择样本。"""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / "dataset" / "prepare.py"
SPEC = importlib.util.spec_from_file_location("ink_dataset", MODULE)
dataset = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dataset)
SYNTHETIC_SPEC = importlib.util.spec_from_file_location("ink_synthetic", MODULE.with_name("synthetic.py"))
synthetic = importlib.util.module_from_spec(SYNTHETIC_SPEC)
with patch.dict("sys.modules", {"prepare": dataset}):
    SYNTHETIC_SPEC.loader.exec_module(synthetic)


class DatasetTests(unittest.TestCase):
    def test_window_keeps_whole_record_starting_inside_even_when_it_ends_outside(self):
        self.assertEqual(list(dataset.extract_lines(b"partial\nlong-record\nnext\n", 5, 15, 100)),
                         [(13, b"long-record")])
        self.assertEqual(list(dataset.extract_lines(b"first\nlast", 0, 10, 10)),
                         [(0, b"first"), (6, b"last")])

    def test_incomplete_response_is_not_silently_used(self):
        with self.assertRaises(ValueError):
            list(dataset.extract_lines(b"partial\nunfinished", 10, 40, 100))

    def test_raw_times_coordinates_and_unrecognized_drawings_are_preserved(self):
        raw = {"key_id": "123", "word": "circle", "recognized": False,
               "drawing": [[[100, 101, 102], [200, 201, 202], [3, 3, 8]]]}
        record = dataset.normalize_record(json.dumps(raw), "circle")
        self.assertEqual(record["strokes"], [[[100, 200, 3], [101, 201, 3], [102, 202, 8]]])
        self.assertFalse(record["recognized"])
        raw["key_id"] = "456"
        duplicate = dataset.normalize_record(json.dumps(raw), "circle")
        self.assertEqual(record["content_sha256"], duplicate["content_sha256"])
        self.assertEqual(dataset.split_for(record["content_sha256"]),
                         dataset.split_for(duplicate["content_sha256"]))

    def test_invalid_numeric_and_temporal_data_are_rejected(self):
        for xs, ys, ts in [([1, 2], [1], [0, 1]), ([1, float("nan")], [1, 2], [0, 1]),
                           ([1, 2], [1, 2], [2, 1]), ([1, 2], [1, 2], [-1, 0])]:
            with self.assertRaises(ValueError):
                dataset.normalize_record(json.dumps({"key_id": "123", "word": "circle",
                    "recognized": True, "drawing": [[xs, ys, ts]]}), "circle")

    def test_compression_is_reproducible_independently_of_output_filename(self):
        with tempfile.TemporaryDirectory() as temporary:
            first, second = Path(temporary) / "a.gz", Path(temporary) / "b.gz"
            records = [{"id": "one", "strokes": [[[1, 2, 0]]]}]
            dataset.write_gzip(first, records)
            dataset.write_gzip(second, records)
            self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_insufficient_category_is_a_failure_not_a_smaller_silent_corpus(self):
        with self.assertRaisesRegex(ValueError, "样本不足"):
            dataset.select_category({"category": "circle"}, [], set(), set())

    def test_constant_motion_future_labels_agree_with_observed_velocity(self):
        record = next(synthetic.motions())
        self.assertEqual(record["noise_bound"], 0.0)
        first, second = record["samples"][:2]
        velocity = [(second[i]-first[i])/(second[2]-first[2]) for i in (0,1)]
        for index, horizon, x, y in record["queries"]:
            observed = record["samples"][index]
            for axis, expected in enumerate((x,y)):
                self.assertAlmostEqual(observed[axis]+velocity[axis]*horizon, expected, places=9)

    def test_stop_pause_corner_and_reversal_have_the_intended_boundaries(self):
        stopped = synthetic.motion_position("stop", 240.0, 1.0)
        self.assertEqual(stopped, synthetic.motion_position("stop", 400.0, 1.0))
        self.assertEqual(synthetic.motion_position("pause", 150.0, 1.0),
                         synthetic.motion_position("pause", 250.0, 1.0))
        self.assertEqual(synthetic.motion_position("corner", 200.0, 1.0), (200.0,0.0))
        self.assertEqual(synthetic.motion_position("corner", 201.0, 1.0), (200.0,1.0))
        self.assertEqual(synthetic.motion_position("reversal", 0.0, 1.0),
                         synthetic.motion_position("reversal", 400.0, 1.0))


if __name__ == "__main__":
    unittest.main()
