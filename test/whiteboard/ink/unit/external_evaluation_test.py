"""真实来源评测保留监督边界，原矢量可以端侧渲染，栅格不能假装矢量。"""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

from modules.whiteboard.ink.training.evaluate_external import _native_inputs, summarize_sources


class ExternalEvaluationTests(unittest.TestCase):
    """来源指标不能混淆分类候选和最终修复，更不能从栅格恢复假轨迹。"""

    def test_negative_candidates_require_negative_truth_and_score_threshold(self):
        rows = [
            {"source": "reviewed", "label": "circle", "prediction": "circle", "score": .9,
             "probabilities": [0, .9, 0, 0, 0, 0, 0, .1]},
            {"source": "letters", "label": "other", "prediction": "circle", "score": .51,
             "probabilities": [0, .51, 0, 0, 0, 0, 0, .49]},
            {"source": "letters", "label": "other", "prediction": "circle", "score": .49,
             "probabilities": [.1, .49, 0, 0, 0, 0, 0, .41]},
        ]
        result = summarize_sources(rows)
        self.assertEqual(result["reviewed"]["negative_shape_candidates_at_0.5"], 0)
        self.assertEqual(result["letters"]["negative_shape_candidates_at_0.5"], 1)
        self.assertEqual(result["letters"]["samples"], 2)
        self.assertEqual(result["letters"]["accuracy"], 0)
        self.assertEqual(result["reviewed"]["classes"]["circle"]["recall"], 1)

    def test_native_evaluation_preserves_complete_vectors_and_raster_input(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            staging = root / "staging"
            staging.mkdir()
            paths = [[[0, 0], [1, 1]], [[2, 0], [3, 1]]]
            vector, raster = source / "vector.png", source / "raster.png"
            for path in (vector, raster):
                Image.new("RGB", (224, 224), "white").save(path)
            (source / "test.jsonl").write_text(json.dumps({"image": vector.name, "paths": paths}) + "\n" +
                                             json.dumps({"image": raster.name, "paths": None}) + "\n")
            renderer = root / "renderer"
            renderer.write_bytes(b"fixture")
            def render(args, input, text, check):
                request = json.loads(input)
                self.assertEqual(request["paths"], paths)
                Image.new("RGB", (224, 224), "white").save(request["output"])
            with patch("modules.whiteboard.ink.training.evaluate_external.subprocess.run", side_effect=render):
                result, details = _native_inputs([((vector, 1), "vectors"), ((raster, 7), "raster")], [source], renderer, staging)
            self.assertEqual(result[1], ((raster, 7), "raster"))
            self.assertNotEqual(result[0][0][0], vector)
            self.assertEqual(details["vector_images"], 1)
            self.assertEqual(details["raster_only_images"], 1)
            index = json.loads((staging / "native-inputs.jsonl").read_text())
            self.assertEqual(index["original"], str(vector))
            self.assertTrue((staging / index["image"]).exists())
