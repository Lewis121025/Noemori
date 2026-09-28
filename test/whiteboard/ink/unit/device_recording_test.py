"""采集转换保持原始事件，明确区分自动化数据、坏时序与有效人工输入。"""
import copy
import importlib.util
from pathlib import Path
import unittest

PATH=Path(__file__).resolve().parents[1]/'capture/recording.py'
SPEC=importlib.util.spec_from_file_location('device_recording',PATH)
recording=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(recording)


def point(x,t):
    return {'x':x,'y':0,'time_ms':t,'pressure':.5,'is_trusted':True}


def record():
    return {'schema_version':1,'provenance':'manual','device_label':'test-device','frames':[],
        'strokes':[{'pointer_type':'mouse','task':'free','events':[
            {'kind':'pointerdown','received_ms':101,'main':point(1,100),'coalesced':[]},
            {'kind':'pointermove','received_ms':109,'main':point(3,108),'coalesced':[point(2,104),point(3,108)]},
            {'kind':'pointerup','received_ms':111,'main':point(4,110),'coalesced':[]}
        ]}]}


class RecordingTests(unittest.TestCase):
    def test_merged_events_and_main_endpoint_are_not_double_counted(self):
        raw=record();original=copy.deepcopy(raw)
        result=recording.convert(raw,'id')
        self.assertEqual(result['drawings'][0]['strokes'][0],[[1,0,0],[2,0,4],[3,0,8],[4,0,10]])
        self.assertEqual(raw,original)

    def test_parent_event_is_not_added_as_an_extra_coalesced_measurement(self):
        raw=record();raw['strokes'][0]['events'][1]['main']=point(99,109)
        points=recording.convert(raw,'id')['drawings'][0]['strokes'][0]
        self.assertEqual(points,[[1,0,0],[2,0,4],[3,0,8],[4,0,10]])

    def test_bad_time_is_reported_without_sorting_or_losing_original(self):
        raw=record();raw['strokes'][0]['events'][1]['coalesced'][0]['time_ms']=99
        result=recording.convert(raw,'id')
        self.assertEqual(result['drawings'],[])
        self.assertEqual(len(result['quality']['invalid_strokes']),1)
        self.assertEqual(raw['strokes'][0]['events'][1]['coalesced'][0]['time_ms'],99)

    def test_automation_and_untrusted_events_cannot_be_presented_as_manual(self):
        raw=record();raw['provenance']='automation_test'
        with self.assertRaises(ValueError):recording.convert(raw,'id')
        self.assertEqual(recording.convert(raw,'id',True)['provenance'],'automation_test')
        raw['provenance']='manual';raw['strokes'][0]['events'][0]['main']['is_trusted']=False
        with self.assertRaises(ValueError):recording.convert(raw,'id')

    def test_cancel_coordinates_are_not_mistaken_for_actual_movement(self):
        raw=record();raw['strokes'][0]['events'].append({'kind':'pointercancel','received_ms':120,'main':point(999,119),'coalesced':[]})
        result=recording.convert(raw,'id')
        self.assertEqual(result['drawings'][0]['strokes'][0][-1],[4,0,10])

    def test_invalid_structures_and_nonfinite_coordinates_are_rejected(self):
        for invalid in [[],{'schema_version':1,'provenance':'manual','device_label':'x','strokes':[None]}]:
            with self.assertRaises(ValueError):recording.validate(invalid)
        raw=record();raw['strokes'][0]['events'][0]['main']['x']=float('nan')
        with self.assertRaises(ValueError):recording.validate(raw)

    def test_late_conflicting_timestamp_is_not_rewritten_into_earlier_frames(self):
        raw=record();raw['strokes'][0]['events'][-1]['main']=point(40,108)
        result=recording.convert(raw,'id')
        self.assertFalse(result['delivery']['strokes'][0]['eligible'])
        self.assertEqual(len(result['quality']['causal_exclusions']),1)

    def test_frame_cannot_reference_events_not_in_the_recording(self):
        raw=record();raw['frames']=[{'callback_ms':110,'raf_ms':109,'latest_event_ms':108,'observed_batches':99}]
        with self.assertRaises(ValueError):recording.convert(raw,'id')


if __name__=='__main__':unittest.main()
