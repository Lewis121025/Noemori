"""本地采集 API 的持久化契约：失败不能留下损坏记录，也不能影响后续读取。"""
import http.client
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


recording=load('capture_recording',ROOT/'capture/recording.py')
with patch.dict('sys.modules',{'recording':recording}):
    server_module=load('capture_server',ROOT/'capture/serve.py')


def payload():
    return {'schema_version':1,'provenance':'automation_test','device_label':'HTTP fixture','frames':[],
        'strokes':[{'pointer_type':'mouse','task':'free','events':[
            {'kind':'pointerdown','received_ms':1,'main':{'x':0,'y':0,'time_ms':0,'pressure':.5,'is_trusted':True},'coalesced':[]}
        ]}]}


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.output=Path(self.temporary.name)
        self.server=server_module.CaptureServer(0,self.output)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()

    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join();self.temporary.cleanup()

    def request(self,method,path,value=None,headers=None):
        connection=http.client.HTTPConnection('127.0.0.1',self.server.server_port)
        try:
            connection.request(method,path,body=None if value is None else json.dumps(value),
                               headers=headers or {'Content-Type':'application/json'})
            response=connection.getresponse();return response.status,json.loads(response.read())
        finally:connection.close()

    def test_invalid_unicode_never_publishes_a_partial_file(self):
        value=payload();value['device_label']='bad\ud800'
        status,_=self.request('POST','/api/recordings',value)
        self.assertEqual(status,400)
        self.assertEqual(list(self.output.iterdir()),[])
        self.assertEqual(self.request('GET','/api/recordings'),(200,[]))

    def test_roundtrip_preserves_provenance_and_rejects_invalid_input(self):
        status,saved=self.request('POST','/api/recordings',payload())
        self.assertEqual(status,201)
        status,raw=self.request('GET','/api/recordings/'+saved['file'])
        self.assertEqual(status,200);self.assertEqual(raw['provenance'],'automation_test')
        self.assertEqual(self.request('POST','/api/recordings',[])[0],400)
        self.assertEqual(self.request('GET','/api/recordings/../../AGENTS.md')[0],404)

    def test_failed_disk_sync_does_not_publish_or_leave_partial_records(self):
        with patch.object(server_module.os,'fsync',side_effect=OSError('simulated disk failure')):
            self.assertEqual(self.request('POST','/api/recordings',payload())[0],500)
        self.assertEqual(list(self.output.iterdir()),[])


if __name__=='__main__':unittest.main()
