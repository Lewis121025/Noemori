"""配对统计的单位与分母必须正确；此测试需要 evaluation/requirements.txt 中的 NumPy。"""
import importlib.util
from pathlib import Path
import unittest

PATH=Path(__file__).resolve().parents[1]/'evaluation/analyze_experiments.py'
SPEC=importlib.util.spec_from_file_location('experiment_analysis',PATH)
analysis=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(analysis)


class ExperimentAnalysisTests(unittest.TestCase):
    def test_constant_relative_change_has_degenerate_paired_interval(self):
        before={'a':1.0,'b':2.0,'c':4.0,'d':8.0}
        result=analysis.paired_change(before,{key:value*.8 for key,value in before.items()})
        self.assertEqual(result['paired_units'],4)
        self.assertAlmostEqual(result['change_percent'],-20.0)
        for bound in result['bootstrap_95_percentile_interval']:
            self.assertAlmostEqual(bound,-20.0)

    def test_unpaired_samples_are_rejected(self):
        with self.assertRaises(ValueError):
            analysis.paired_change({'a':1.0},{'b':1.0})

    def test_repeating_variants_does_not_increase_number_of_base_scenes(self):
        rows=[{'group':'a','rms':1.0},{'group':'b','rms':3.0}]
        once=analysis.paired_values({'synthetic':{'paired_motion_cases':rows}},'synthetic')
        repeated=analysis.paired_values({'synthetic':{'paired_motion_cases':rows*10}},'synthetic')
        self.assertEqual(once,repeated)
        self.assertEqual(len(repeated),2)

    def test_subgroup_report_preserves_regressions_and_coverage(self):
        before={'a':{'position_error':{'count':3,'rms':1.0,'p99':2.0}}}
        after={'a':{'position_error':{'count':3,'rms':2.0,'p99':5.0}}}
        result=analysis.subgroup_comparison(before,after)
        self.assertEqual(result['worsened_groups'],1)
        self.assertEqual(result['largest_absolute_regressions'][0]['after_p99'],5.0)
        after['a']['position_error']['count']=2
        with self.assertRaises(ValueError):
            analysis.subgroup_comparison(before,after)


if __name__=='__main__':
    unittest.main()
