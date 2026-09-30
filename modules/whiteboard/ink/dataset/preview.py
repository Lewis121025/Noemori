"""生成可离线审阅的配对预览；颜色标出修改范围和保持的上下文。"""

import html
from pathlib import Path

from .schema import Sample

FAMILY_LABELS = {"line": "线段", "arc": "弧", "ellipse": "圆与椭圆", "rounded_loop": "非对称闭合曲线",
                 "polyline": "尖角折线", "free_curve": "自由曲线", "wave": "波浪线", "arrow": "箭头",
                 "frame": "多笔框", "double_line": "独立双线"}
CORRUPTION_LABELS = {"keep": "保持原样", "jitter": "连续抖动", "drift": "缓慢漂移", "endpoint": "端点偏差",
                     "mixed": "复合形变", "retrace": "重复描画合并", "fragment": "分段表示合并"}


def _svg(sample: Sample, output: bool) -> str:
    target = sample["target"]
    selected = set(target["source_stroke_ids"]) if target["action"] == "replace" else set()
    points = [point for stroke in sample["input"]["strokes"] for point in stroke["points"]]
    if target["action"] == "replace":
        points.extend(point for stroke in target["strokes"] for point in stroke["points"])
    min_x, max_x = min(p[0] for p in points), max(p[0] for p in points)
    min_y, max_y = min(p[1] for p in points), max(p[1] for p in points)
    extent = max(max_x - min_x, max_y - min_y, 1)
    margin = extent * .08
    viewbox = f"{min_x - margin} {min_y - margin} {max_x - min_x + 2 * margin} {max_y - min_y + 2 * margin}"
    lines: list[str] = []
    for stroke in sample["input"]["strokes"]:
        if output and stroke["id"] in selected:
            continue
        color = "#84909d"
        if not output and stroke["id"] in selected:
            color = "#d26c16"
        if not output and stroke["id"] == sample["input"]["focus_stroke_id"]:
            color = "#874cbd"
        vertices = " ".join(f"{x},{y}" for x, y in stroke["points"])
        lines.append(f'<polyline points="{vertices}" stroke="{color}"/>')
    if output and target["action"] == "replace":
        for stroke in target["strokes"]:
            vertices = " ".join(f"{x},{y}" for x, y in stroke["points"])
            lines.append(f'<polyline points="{vertices}" stroke="#067a9b"/>')
    return (f'<svg viewBox="{viewbox}" role="img" aria-label="{"目标" if output else "输入"}">'
            f'<g fill="none" stroke-width="{extent * .006}" stroke-linecap="round" '
            f'stroke-linejoin="round">{"".join(lines)}</g></svg>')


def write_preview(samples: list[Sample], destination: Path) -> None:
    """把代表样本写成无外部依赖的 HTML；文件系统写入错误按原异常传播。"""
    cards: list[str] = []
    for sample in samples:
        provenance = sample["provenance"]
        family, corruption = provenance["family"], provenance["corruption"]
        primitive = {"circle": "圆", "ellipse": "椭圆", "square": "正方形", "rectangle": "矩形"}.get(
            provenance["primitive"], FAMILY_LABELS[family])
        title = f"{primitive} · {CORRUPTION_LABELS[corruption]}"
        cards.append(f'<article data-family="{family}" data-corruption="{corruption}">'
                     f'<h2>{title}</h2><div class="pair"><figure>{_svg(sample, False)}'
                     f'<figcaption>输入</figcaption></figure><figure>{_svg(sample, True)}'
                     '<figcaption>应用标签后</figcaption></figure></div>'
                     f'<p class="id">{html.escape(sample["sample_id"])}</p>'
                     f'<p>相对偏差尺度：{provenance["severity"]:.4f}</p></article>')
    options = lambda labels: ''.join(f'<option value="{key}">{value}</option>' for key, value in labels.items())
    page = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>白板几何合成样本</title>
<style>body{font:15px system-ui,sans-serif;background:#f4f6f8;color:#243144;margin:24px}
h1{font-size:25px}header{max-width:1100px}label{margin-right:18px}select{padding:7px}
main{display:grid;grid-template-columns:repeat(auto-fit,minmax(410px,1fr));gap:18px;margin-top:22px}
article{background:white;border:1px solid #dfe5ec;border-radius:10px;padding:16px}h2{font-size:17px;margin:0 0 12px}
.pair{display:flex;gap:12px}figure{margin:0;width:50%;text-align:center}svg{width:100%;height:210px;background:#fbfcfd}
figcaption{margin-top:6px}.id{font:11px monospace;color:#687586;overflow-wrap:anywhere}p{line-height:1.6}
[hidden]{display:none}button{padding:7px}@media(max-width:500px){main{grid-template-columns:1fr}body{margin:12px}}</style>
<header><h1>白板几何合成样本 · 第一批</h1>
<p>每个图形家族展示七种处理情形。左侧：紫色为本次新增笔画，橙色为其他待替换笔画；
右侧：蓝色为目标路径。灰色上下文按原值保留。输入与结果使用相同视野。</p>
<p>这些标签来自合成规则，尚未经真实用户确认；重复描画与分段合并仍可能有多种合理解释。
本批不包含文字、公式、笔画拆分、缺失图形补全或真实设备噪声分布。</p>
<label>图形 <select id="family"><option value="">全部</option>FAMILY_OPTIONS</select></label>
<label>偏差 <select id="corruption"><option value="">全部</option>CORRUPTION_OPTIONS</select></label>
<span id="count"></span></header><main>CARDS</main>
<script>const family=document.querySelector('#family'),corruption=document.querySelector('#corruption');
function filter(){let n=0;document.querySelectorAll('article').forEach(card=>{card.hidden=
!!((family.value&&family.value!==card.dataset.family)||(corruption.value&&corruption.value!==card.dataset.corruption));
if(!card.hidden)n++});document.querySelector('#count').textContent=n+' 条样本'}
family.addEventListener('change',filter);corruption.addEventListener('change',filter);filter();</script></html>'''
    destination.write_text(page.replace("FAMILY_OPTIONS", options(FAMILY_LABELS))
                           .replace("CORRUPTION_OPTIONS", options(CORRUPTION_LABELS))
                           .replace("CARDS", "".join(cards)), encoding="utf-8")
