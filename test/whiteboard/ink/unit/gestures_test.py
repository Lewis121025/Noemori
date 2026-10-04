"""真实手势 XML 的安全解析、标签映射及书写者隔离契约。"""

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from modules.whiteboard.ink.dataset.gestures.schema import (
    LABEL_MAP, WRITER_DEVICES, parse_mmg_xml, writer_assignments,
)


def xml(points='''<Point X="0" Y="0" T="1"/><Point X="10" Y="5" T="2"/>''', count="2"):
    return (f'<Gesture Name="arrowhead~01" Subject="10" InputType="stylus" Speed="FAST" NumPts="{count}">'
            f'<Stroke index="1">{points}</Stroke></Gesture>').encode()


class GestureContractTests(unittest.TestCase):
    """输入时间不参与分类，但原始来源与统计契约必须准确。"""

    def test_xml_preserves_complete_geometry_and_provenance(self):
        gesture = parse_mmg_xml(xml(), "10-stylus-FAST/10-stylus-fast-arrowhead-01.xml")
        self.assertEqual(gesture.paths, [[[0.0, 0.0], [10.0, 5.0]]])
        self.assertEqual((gesture.writer_id, gesture.source_label, gesture.speed), ("10", "arrowhead", "FAST"))
        self.assertEqual(gesture.repetition, 1)
        self.assertEqual(len(gesture.source_sha256), 64)

    def test_wrong_counts_nonfinite_coordinates_and_empty_strokes_fail(self):
        invalid = [xml(count="3"), xml(points="", count="0"),
                   xml().replace(b'X="10"', b'X="NaN"'), xml().replace(b'X="10"', b'X="inf"'),
                   xml().replace(b'index="1"', b'index="2"'),
                   xml().replace(b'Subject="10"', b'Subject="11"')]
        for body in invalid:
            with self.subTest(body=body), self.assertRaises(ValueError):
                parse_mmg_xml(body, "10-stylus-FAST/10-stylus-fast-arrowhead-01.xml")

    def test_entities_and_unsafe_paths_are_rejected(self):
        malicious = b'<!DOCTYPE Gesture [<!ENTITY a "123">]>' + xml()
        with self.assertRaises(ValueError):
            parse_mmg_xml(malicious, "10-stylus-FAST/10-stylus-fast-arrowhead-01.xml")
        for path in ("../evil.xml", "/absolute.xml", "folder\\evil.xml", "10-stylus-FAST/../evil.xml"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                parse_mmg_xml(xml(), path)

    def test_utf16_cannot_bypass_entity_rejection(self):
        text = '<!DOCTYPE Gesture [<!ENTITY a "123">]>' + xml().decode().replace('X="10"', 'X="&a;"')
        with self.assertRaises(ValueError):
            parse_mmg_xml(text.encode("utf-16"), "10-stylus-FAST/10-stylus-fast-arrowhead-01.xml")

    def test_ambiguous_symbol_names_are_not_forced_into_other(self):
        self.assertEqual(LABEL_MAP["arrowhead"], "arrow")
        self.assertEqual(LABEL_MAP["line"], "line")
        for source in ("I", "exclamation_point", "D", "P", "half_note"):
            self.assertNotIn(source, LABEL_MAP)
        for source in ("T", "H", "X", "N"):
            self.assertEqual(LABEL_MAP[source], "other")

    def test_writer_splits_are_device_balanced_and_independent_of_speed(self):
        assignments = writer_assignments()
        self.assertEqual(assignments, writer_assignments())
        self.assertEqual(set(assignments), set(WRITER_DEVICES))
        for device in ("finger", "stylus"):
            actual = {split: sum(assigned == split and WRITER_DEVICES[writer] == device
                                 for writer, assigned in assignments.items())
                      for split in ("train", "val", "test")}
            self.assertEqual(actual, {"train": 6, "val": 2, "test": 2})


if __name__ == "__main__":
    unittest.main()
