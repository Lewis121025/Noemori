"""完整真实笔画提取与固定复核队列契约，不把来源提示升级为监督。"""

import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.real_shapes.quickdraw import assigned_split, extract_paths, _review_queue


class RealQuickDrawTests(unittest.TestCase):
    """同原图始终同split，盲审对象的选择不读取规则结果。"""

    def test_raw_points_are_preserved_and_unrecognized_is_not_filtered(self):
        raw = {"key_id":"123", "word":"rainbow", "recognized":False,
               "drawing":[[[0,1,2],[0,2,0],[0,1,2]], [[0,1,2],[1,3,1],[3,4,5]]]}
        self.assertEqual(extract_paths(raw, "rainbow"), [[[0,0],[1,2],[2,0]], [[0,1],[1,3],[2,1]]])
        self.assertEqual(assigned_split("123"), assigned_split("123"))
        broken = copy.deepcopy(raw);broken["drawing"][0][2].pop()
        with self.assertRaises(ValueError):extract_paths(broken,"rainbow")

    def test_review_queue_uses_one_candidate_per_key_and_ignores_rules(self):
        records=[]
        for identifier,key,accepted in (("b","123",True),("a","123",False),("c","456",False)):
            records.append({"sample_id":identifier,"source_label":"rainbow","assigned_split":"val",
                            "annotation_status":"pending_visual_review","image":identifier+".png",
                            "rule_evidence":{"accepted":accepted},
                            "provenance":{"source_key_id":key,"record_sha256":"0"*64}})
        first=_review_queue(records)
        self.assertEqual(len(first),2)
        self.assertEqual({r["sample_id"] for r in first},{"a","c"})
        for record in records:record["rule_evidence"]["accepted"]=not record["rule_evidence"]["accepted"]
        self.assertEqual(first,_review_queue(records))


if __name__ == "__main__":
    unittest.main()
