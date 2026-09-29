#!/usr/bin/env python3
"""仅在 127.0.0.1 提供独立采集页面；只有页面上的保存操作会写入原始记录。

运行 python3 test/whiteboard/ink/capture/serve.py。API 只访问 UUID 记录和固定静态资源，
不暴露仓库其他目录；原始记录可下载，不自动计入测试集。
"""
import argparse
from datetime import datetime,timezone
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import urlparse
import uuid

from recording import summarize,validate

HERE=Path(__file__).resolve().parent


class CaptureServer(ThreadingHTTPServer):
    """记录输出目录显式传入，测试可使用临时目录，避免污染人工实测数据。"""
    def __init__(self,port,output):
        self.output=output
        super().__init__(('127.0.0.1',port),Handler)

    def store(self,body):
        """完整写入并同步后原子发布；失败清理临时文件，硬链接发布不会覆盖既有记录。"""
        self.output.mkdir(parents=True,exist_ok=True)
        filename=uuid.uuid4().hex+'.json'
        pending=None
        try:
            with tempfile.NamedTemporaryFile(dir=self.output,prefix='.pending-',delete=False) as stream:
                pending=Path(stream.name);stream.write(body);stream.flush();os.fsync(stream.fileno())
            os.link(pending,self.output/filename)
        finally:
            if pending is not None:pending.unlink(missing_ok=True)
        return filename


class Handler(BaseHTTPRequestHandler):
    """处理页面、记录列表和显式保存；错误返回 JSON，调用方保留未保存的采集内容。"""
    def log_message(self,*args):
        pass

    def reply(self,value,status=200):
        """写出结构化结果，禁止浏览器缓存采集列表。"""
        body=json.dumps(value,ensure_ascii=False,allow_nan=False).encode()
        self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(body)))
        self.end_headers();self.wfile.write(body)

    def do_GET(self):
        """只读取固定页面资源或合法 UUID 数据文件。"""
        path=urlparse(self.path).path
        if path in ('/','/capture.mjs'):
            file=HERE/('index.html' if path=='/' else 'capture.mjs')
            body=file.read_bytes();self.send_response(200)
            self.send_header('Content-Type','text/html; charset=utf-8' if path=='/' else 'text/javascript; charset=utf-8')
            self.send_header('Content-Length',str(len(body)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(body)
        elif path=='/api/recordings':
            rows=[]
            for file in sorted(self.server.output.glob('*.json'),key=lambda p:p.name):
                value=json.loads(file.read_text())
                rows.append({'file':file.name,'device_label':value['device_label'],'provenance':value['provenance'],
                             'strokes':len(value['strokes']),'saved_at':value['saved_at']})
            self.reply(rows)
        elif re.fullmatch(r'/api/recordings/[0-9a-f]{32}\.json',path):
            file=self.server.output/path.rsplit('/',1)[1]
            self.reply(json.loads(file.read_text())) if file.exists() else self.reply({'error':'记录不存在'},404)
        else:self.reply({'error':'路径不存在'},404)

    def do_POST(self):
        """验证后以唯一文件名保存；不会覆盖既有记录。"""
        if self.path!='/api/recordings':return self.reply({'error':'路径不存在'},404)
        allowed=f'http://127.0.0.1:{self.server.server_port}'
        if self.headers.get('Origin') not in (None,allowed):return self.reply({'error':'来源不匹配'},403)
        if self.headers.get('Content-Type','').split(';')[0]!='application/json':return self.reply({'error':'需要 JSON'},415)
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=32*1024*1024:return self.reply({'error':'记录大小超限'},413)
            record=json.loads(self.rfile.read(length));validate(record)
            quality=summarize(record)
            record['saved_at']=datetime.now(timezone.utc).isoformat()
            record['quality']=quality
            body=json.dumps(record,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode('utf-8')
        except (ValueError,KeyError,TypeError) as error:
            return self.reply({'error':str(error)},400)
        try:filename=self.server.store(body)
        except OSError as error:return self.reply({'error':str(error)},500)
        self.reply({'file':filename,'quality':quality},201)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int,default=8765)
    parser.add_argument('--output',type=Path,default=HERE.parent/'.artifacts/device-recordings')
    args=parser.parse_args();server=CaptureServer(args.port,args.output)
    print(f'http://127.0.0.1:{server.server_port}',flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:server.server_close()
