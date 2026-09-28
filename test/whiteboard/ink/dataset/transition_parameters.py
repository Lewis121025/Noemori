#!/usr/bin/env python3
"""为固定合成语料导出解析参数，不改变输入、划分或原有查询标签，不读取保留集。

参数仅供评测器计算稠密未来真值和阶段标签，禁止提供给候选预测器。
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path

from prepare import ROOT, canonical
from synthetic import motion_parameters, motion_position, transform


def build(split):
    """核对原有标签后导出小型参数表，保证新评测与旧案例属于同一连续轨迹。"""
    folder=ROOT/'fixtures/synthetic-v1'
    manifest=json.loads((folder/'manifest.json').read_text())
    data=folder/manifest['splits'][split]['file']
    if hashlib.sha256(data.read_bytes()).hexdigest()!=manifest['splits'][split]['sha256']:
        raise ValueError('合成数据校验和不匹配')
    groups={}
    with gzip.open(data,'rt',encoding='utf-8') as source:
        for line in source:
            case=json.loads(line)
            if case['kind']!='motion' or case['family'] not in ('pause','stop','corner','reversal'):
                continue
            speed,angle,center=motion_parameters(case['group'])
            for index,horizon,x,y in case['queries']:
                t=case['samples'][index][2]+horizon
                expected=transform(*motion_position(case['family'],t,speed),angle,center)
                if max(abs(expected[0]-x),abs(expected[1]-y))>1e-10:
                    raise ValueError('稠密真值与原有标签不一致')
            groups[case['group']]={'speed':speed,'angle':angle,'center':center,'family':case['family']}
    output=ROOT/'fixtures'/f'transition-parameters-{split}.json'
    output.write_bytes(canonical({'schema_version':1,'split':split,'input_sha256':manifest['splits'][split]['sha256'],
                                 'duration_ms':400.0,'groups':groups})+b'\n')
    print(output,len(groups),'base scenes')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--split',choices=['development','validation'],default='development')
    build(parser.parse_args().split)
