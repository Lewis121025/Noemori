#!/usr/bin/env python3
"""按预先固定的计划运行候选，保存带来源校验和的压缩报告，不允许打开保留集。

默认在开发集运行计划中全部候选。验证阶段用 --split validation --candidates 指定入选模型。
输出已存在时拒绝覆盖；失败报告和进程输出会明确显示，不把失败候选静默排除。
"""
import argparse
import concurrent.futures
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parents[4]
HERE=Path(__file__).resolve().parent
MANIFEST=ROOT/'modules/whiteboard/packages/ink/Cargo.toml'


def build():
    """只编译一次，再执行 Cargo 返回的精确测试程序路径，避免通过 glob 误用旧二进制。"""
    result=subprocess.run(['cargo','test','--manifest-path',str(MANIFEST),'--release','--locked','--offline',
                           '--test','ink_evaluation_corpus','--no-run','--message-format=json'],capture_output=True,text=True)
    if result.returncode:
        raise RuntimeError(result.stdout+result.stderr)
    for line in result.stdout.splitlines():
        value=json.loads(line)
        if value.get('reason')=='compiler-artifact' and value.get('executable'):
            return value['executable']
    raise RuntimeError('Cargo 未返回测试程序')


def run(binary,name,split,output,plan_path):
    """每个候选独立进程，临时未压缩报告用后清理；只公开完整且来源可追溯的结果。"""
    path=output/f'{split}-{name}.json.gz'
    if path.exists():
        raise FileExistsError(path)
    with tempfile.TemporaryDirectory(prefix='nous-ink-experiment-') as temporary:
        report=Path(temporary)/'report.json'
        plan=json.loads(plan_path.read_text())
        env=dict(os.environ,NOUS_INK_EXPERIMENT=name,NOUS_INK_CORPUS_SPLIT=split,NOUS_INK_EVALUATION_OUTPUT=str(report),
                 NOUS_INK_TRANSITIONS='1' if plan.get('transition_evaluation',False) else '0')
        result=subprocess.run([binary,'--ignored','--nocapture','--exact','evaluate_corpus'],env=env,cwd=ROOT,capture_output=True,text=True)
        if result.returncode:
            raise RuntimeError(name+'\n'+result.stdout+result.stderr)
        data=json.loads(report.read_text())
        if data['experiment']!=name or data['split']!=split:
            raise ValueError('候选或集合身份不一致')
        for filename in ['androidx-provenance.json']:
            data[filename+'_sha256']=hashlib.sha256((HERE/filename).read_bytes()).hexdigest()
        data['experiment_plan_file']=plan_path.name
        data['experiment_plan_sha256']=hashlib.sha256(plan_path.read_bytes()).hexdigest()
        raw=json.dumps(data,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode()
        compressed=gzip.compress(raw,mtime=0)
        path.write_bytes(compressed)
    print(f'{split}/{name}: {len(compressed)} bytes',flush=True)
    return name


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--split',choices=['development','validation'],default='development')
    parser.add_argument('--candidates',nargs='+')
    parser.add_argument('--output',type=Path,default=HERE.parent/'.artifacts/prediction-experiments')
    parser.add_argument('--plan',type=Path,default=HERE/'prediction-experiment-plan.json')
    args=parser.parse_args()
    plan=json.loads(args.plan.read_text())
    candidates=args.candidates or plan['candidates']
    if args.split=='validation' and not args.candidates:
        raise ValueError('验证集只允许显式指定已入选的候选')
    if len(set(candidates))!=len(candidates) or not set(candidates)<=set(plan['candidates']):
        raise ValueError('候选未在预先固定的计划中')
    args.output.mkdir(parents=True,exist_ok=True)
    binary=build()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda name:run(binary,name,args.split,args.output,args.plan),candidates))
