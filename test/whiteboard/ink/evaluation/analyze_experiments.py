#!/usr/bin/env python3
"""比较同条件实验，按绘图/基础场景进行配对 bootstrap，避免把相关帧当作独立样本。

需要 NumPy；运行本脚本指定 --reports 和 --split，输出默认写入实验目录的 summary.json。
区间是给定语料分布下的重采样描述，不代表跨作者或跨设备的泛化保证。
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import sys

import numpy as np


def load(path):
    """读取已冻结的压缩报告，保留文件哈希以便追溯。"""
    with gzip.open(path, 'rt', encoding='utf-8') as source:
        value=json.load(source)
    value['report_sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
    return value


def pooled(groups):
    """只合并相同参考定义的误差，不将插值参考与真实观测混合。"""
    count=sum(g['position_error']['count'] for g in groups.values())
    return {'queries':count,
            'rms':float(np.sqrt(sum(g['position_error']['rms']**2*g['position_error']['count'] for g in groups.values())/count)),
            'prediction_fraction':sum(g['predictions'] for g in groups.values())/count,
            'algorithm_errors':sum(g['algorithm_errors'] for g in groups.values())}


def paired_values(report,kind):
    """真实数据每幅绘图等权；合成数据先在基础场景内合并变体，防止增强数据扩大样本量。"""
    if kind=='real':
        return {r['id']:r['relative_rms'] for r in report['real']['paired_drawings']}
    grouped={}
    for row in report['synthetic']['paired_motion_cases']:
        grouped.setdefault(row['group'],[]).append(row['rms']**2)
    return {key:float(np.sqrt(np.mean(values))) for key,values in grouped.items()}


def paired_change(before,after):
    """采用固定种子的 2,000 次成对重采样，计算均值相对变化的百分位区间。"""
    if before.keys()!=after.keys():
        raise ValueError('配对样本身份不一致')
    keys=sorted(before)
    a=np.array([before[k] for k in keys]);b=np.array([after[k] for k in keys])
    if a.mean()<=0:
        raise ValueError('基线均值为零，不能使用相对变化')
    rng=np.random.default_rng(20260928)
    results=[]
    for start in range(0,2000,50):
        indices=rng.integers(0,len(a),size=(min(50,2000-start),len(a)))
        results.extend(((b[indices].mean(axis=1)/a[indices].mean(axis=1)-1.0)*100.0).tolist())
    return {'paired_units':len(keys),'before_mean':float(a.mean()),'after_mean':float(b.mean()),
            'change_percent':float((b.mean()/a.mean()-1.0)*100.0),
            'bootstrap_95_percentile_interval':np.quantile(results,[.025,.975]).tolist()}


def subgroup_comparison(before,after):
    """列出绝对退化最大的子组，同时保留尾部误差，不能只展示总体均值。"""
    if before.keys()!=after.keys():
        raise ValueError('分组不一致')
    rows=[]
    for key in before:
        a,b=before[key]['position_error'],after[key]['position_error']
        if a['count']!=b['count']:
            raise ValueError('参考覆盖率变化')
        rows.append({'group':key,'before_rms':a['rms'],'after_rms':b['rms'],
                     'absolute_change':b['rms']-a['rms'],'before_p99':a['p99'],'after_p99':b['p99'],
                     'change_percent':(b['rms']/a['rms']-1)*100 if a['rms']>1e-9 else None})
    return {'improved_groups':sum(r['absolute_change'] < -1e-10 for r in rows),
            'worsened_groups':sum(r['absolute_change'] > 1e-10 for r in rows),
            'largest_absolute_regressions':sorted((r for r in rows if r['absolute_change']>1e-10),key=lambda r:r['absolute_change'],reverse=True)[:10]}


def analyze(directory,split):
    """使用同一份基线与数据快照比较全部已完成候选；缺基线、混用源码或数据时失败。"""
    reports={r['experiment']:r for r in (load(p) for p in sorted(directory.glob(f'{split}-*.json.gz')))}
    baseline=reports['baseline']
    results={}
    for name,r in reports.items():
        for key in ['corpus_manifest_sha256','kernel_source_sha256','evaluation_source_sha256','experimental_predictors_sha256']:
            if r[key]!=baseline[key]:
                raise ValueError('混用了不同来源的报告：'+key)
        real=r['real']['groups'];motion=r['synthetic']['motion']
        results[name]={'report_sha256':r['report_sha256'],
            'observed_next':pooled({k:v for k,v in real.items() if k.startswith('observed_next/')}),
            'interpolated':pooled({k:v for k,v in real.items() if k.startswith('interpolated/')}),
            'synthetic':pooled(motion),
            'real_per_drawing':paired_change(paired_values(baseline,'real'),paired_values(r,'real')),
            'synthetic_per_base_scene':paired_change(paired_values(baseline,'synthetic'),paired_values(r,'synthetic')),
            'real_subgroups':subgroup_comparison(baseline['real']['groups'],real),
            'synthetic_subgroups':subgroup_comparison(baseline['synthetic']['motion'],motion),
            'real_reforecast_change':r['real']['reforecast_change_same_target_4ms']}
        if r.get('transitions') is not None:
            original=baseline['transitions']['groups'];current=r['transitions']['groups']
            if r['transitions']['parameters_sha256']!=baseline['transitions']['parameters_sha256']:
                raise ValueError('状态切换真值不一致')
            results[name]['transition_subgroups']=subgroup_comparison(original,current)
            results[name]['transition_profile_500Hz_16ms']={key:{'queries':value['position_error']['count'],
                'before_rms':original[key]['position_error']['rms'],'after_rms':value['position_error']['rms'],
                'before_p95':original[key]['position_error']['p95'],'after_p95':value['position_error']['p95']}
                for key,value in current.items() if '/500Hz/' in key and key.endswith('/16ms')}
        row=results[name]
        print(name,'real-next',round(row['observed_next']['rms'],5),'synthetic',round(row['synthetic']['rms'],5),
              'real mean change %',round(row['real_per_drawing']['change_percent'],3),flush=True)
    return {'split':split,'holdout_evaluated':False,'python':sys.version.split()[0],'numpy':np.__version__,
            'bootstrap_repetitions':2000,'bootstrap_seed':20260928,'kernel_source_sha256':baseline['kernel_source_sha256'],
            'experimental_predictors_sha256':baseline['experimental_predictors_sha256'],
            'interval_scope':'Exploratory paired percentile bootstrap by drawing/base scene; not author/device-independent and not simultaneous intervals across candidates.',
            'candidates':results}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reports',type=Path,required=True)
    parser.add_argument('--split',choices=['development','validation'],default='development')
    args=parser.parse_args()
    summary=analyze(args.reports,args.split)
    (args.reports/f'{args.split}-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
