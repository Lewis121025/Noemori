#!/usr/bin/env python3
"""将本机采集记录转换后交给同一 Rust 评测器；原始文件保持不变。

运行 python3 test/whiteboard/ink/capture/replay.py <记录.json>。
默认比较当前内核与三维 Kalman；可通过 --candidates 选择本轮已登记候选。
自动化检查数据必须显式加 --allow-automation，报告仍保留其自动化来源标记。
"""
import argparse
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile

from recording import convert

HERE=Path(__file__).resolve().parent
SPEC=importlib.util.spec_from_file_location('experiment_runner',HERE.parent/'evaluation/run_experiments.py')
runner=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(runner)


def replay(path,candidates,output,allow_automation=False):
    """用同一规范化记录评估各候选，保存原始来源哈希与数据质量报告。"""
    raw=path.read_bytes();record=json.loads(raw)
    normalized=convert(record,path.stem,allow_automation)
    normalized['source_sha256']=hashlib.sha256(raw).hexdigest()
    if not normalized['drawings']:raise ValueError('没有可回放的有效笔画')
    output.mkdir(parents=True,exist_ok=True)
    binary=runner.build()
    with tempfile.TemporaryDirectory(prefix='nous-device-replay-') as temporary:
        data=Path(temporary)/'normalized.json';data.write_text(json.dumps(normalized,ensure_ascii=False,allow_nan=False))
        for name in candidates:
            destination=output/f'{path.stem}-{name}.json.gz'
            if destination.exists():raise FileExistsError(destination)
            report=Path(temporary)/(name+'.json')
            env=dict(os.environ,NOUS_INK_DEVICE_CORPUS=str(data),NOUS_INK_EXPERIMENT=name,
                     NOUS_INK_EVALUATION_OUTPUT=str(report),NOUS_INK_ALLOW_AUTOMATION='1' if allow_automation else '0')
            result=subprocess.run([binary,'--ignored','--exact','evaluate_corpus'],env=env,cwd=runner.ROOT,capture_output=True,text=True)
            if result.returncode:raise RuntimeError(result.stdout+result.stderr)
            destination.write_bytes(gzip.compress(report.read_bytes(),mtime=0));print(destination)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('recording',type=Path)
    parser.add_argument('--output',type=Path,default=HERE.parent/'.artifacts/device-evaluation')
    parser.add_argument('--candidates',nargs='+',choices=['baseline','kalman32','kalman32_noise','kalman32_adaptive'],default=['baseline','kalman32'])
    parser.add_argument('--allow-automation',action='store_true')
    args=parser.parse_args();replay(args.recording,args.candidates,args.output,args.allow_automation)
