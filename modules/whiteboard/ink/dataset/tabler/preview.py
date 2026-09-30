"""外部素材扩展的离线图形审阅，预览中明确区分来源和合成标签。"""

import html
from pathlib import Path

from ..schema import Input, KeepTarget, ReplaceTarget
from ..preview import CORRUPTION_LABELS
from .schema import TablerSample


def _svg(features: Input, target: KeepTarget | ReplaceTarget, output: bool) -> str:
    selected = set(target["source_stroke_ids"]) if target["action"] == "replace" else set()
    all_points = [point for stroke in features["strokes"] for point in stroke["points"]]
    if target["action"] == "replace":
        all_points.extend(point for stroke in target["strokes"] for point in stroke["points"])
    xs, ys = [point[0] for point in all_points], [point[1] for point in all_points]
    extent = max(max(xs) - min(xs), max(ys) - min(ys), 1)
    margin = extent * .08
    viewbox = f"{min(xs)-margin} {min(ys)-margin} {max(xs)-min(xs)+2*margin} {max(ys)-min(ys)+2*margin}"
    paths: list[str] = []
    for stroke in features["strokes"]:
        if output and stroke["id"] in selected:
            continue
        color = "#83909e"
        if not output and stroke["id"] in selected:
            color = "#d46b17"
        if not output and stroke["id"] == features["focus_stroke_id"]:
            color = "#874cbd"
        points = " ".join(f"{x},{y}" for x, y in stroke["points"])
        paths.append(f'<polyline stroke="{color}" points="{points}"/>')
    if output and target["action"] == "replace":
        for stroke in target["strokes"]:
            points = " ".join(f"{x},{y}" for x, y in stroke["points"])
            paths.append(f'<polyline stroke="#087f9e" points="{points}"/>')
    return (f'<svg viewBox="{viewbox}"><g fill="none" stroke-width="{extent*.005}" '
            f'stroke-linecap="round" stroke-linejoin="round">{"".join(paths)}</g></svg>')


def write_preview(samples: list[TablerSample], destination: Path) -> None:
    """保存可筛选的无依赖 HTML 样本预览；I/O 错误原样传播。"""
    cards: list[str] = []
    for sample in samples:
        provenance = sample["provenance"]
        filename, corruption = provenance["source_file"], provenance["corruption"]
        cards.append(f'<article data-source="{html.escape(filename)}" data-kind="{corruption}">'
                     f'<h2>{html.escape(filename)} · {CORRUPTION_LABELS[corruption]}</h2>'
                     '<div class="pair"><figure>' + _svg(sample["input"], sample["target"], False) +
                     '<figcaption>输入</figcaption></figure><figure>' + _svg(sample["input"], sample["target"], True) +
                     f'<figcaption>应用标签后</figcaption></figure></div><p>{sample["sample_id"]}</p></article>')
    options = ''.join(f'<option value="{html.escape(name)}">{html.escape(name)}</option>'
                      for name in sorted({sample["provenance"]["source_file"] for sample in samples}))
    kinds = ''.join(f'<option value="{key}">{label}</option>' for key, label in CORRUPTION_LABELS.items())
    page = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tabler 几何合成数据预览</title><style>body{font:15px system-ui,sans-serif;background:#f4f6f8;color:#243144;margin:24px}
h1{font-size:25px}h2{font-size:16px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(410px,1fr));gap:16px;margin-top:20px}
article{background:white;border:1px solid #dfe5ec;border-radius:10px;padding:15px}.pair{display:flex;gap:10px}figure{width:50%;margin:0;text-align:center}
svg{width:100%;height:220px;background:#fbfcfd}article p{font:11px monospace;color:#667585}select{padding:8px;margin-right:18px}[hidden]{display:none}</style>
<h1>Tabler 矢量素材 · 合成几何修正</h1><p>紫色为本次新增笔画，橙色为其他待替换笔画，蓝色为目标，灰色上下文保持。
来源为固定版本的 MIT 图标，偏差和答案由生成器构造，并非真实手绘配对。</p>
<label>来源 <select id="source"><option value="">全部</option>OPTIONS</select></label>
<label>偏差 <select id="kind"><option value="">全部</option>KINDS</select></label><span id="count"></span><main>CARDS</main>
<script>const source=document.querySelector('#source'),kind=document.querySelector('#kind');function filter(){let n=0;
document.querySelectorAll('article').forEach(c=>{c.hidden=!!((source.value&&c.dataset.source!==source.value)||(kind.value&&c.dataset.kind!==kind.value));if(!c.hidden)n++});
document.querySelector('#count').textContent=n+' 条样本'}source.addEventListener('change',filter);kind.addEventListener('change',filter);filter();</script></html>'''
    destination.write_text(page.replace("OPTIONS", options).replace("KINDS", kinds).replace("CARDS", ''.join(cards)), encoding="utf-8")
