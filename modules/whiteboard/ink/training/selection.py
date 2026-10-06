"""按来源和类别选择权重，原有能力的回退不能被大来源的高分掩盖。"""

import math

from ..dataset.classification.schema import LABELS
from .metrics import classification_report

LEGACY_SOURCES = frozenset(("synthetic", "mmg", "ai_reviewed_quickdraw"))
FAMILIES = ("line", "oval", "arc", "rectangle", "triangle", "arrow", "other")
FAMILY_INDICES = (0, 1, 1, 2, 3, 4, 5, 6)


def canonical_source(source: str) -> str:
    """把同一来源的原图和端侧视图合并为评价来源，不把渲染表示当作新人群。"""
    return source.removesuffix("_native")


def legacy_source(source: str) -> bool:
    """仅原有监督来源可接受旧模型训练约束；新增数据必须学习独立复核标签。"""
    return canonical_source(source) in LEGACY_SOURCES


def family_report(report: dict) -> dict:
    """汇总固定八类的拟合族；圆/椭圆的最终子类型由几何验收，非法矩阵抛ValueError。"""
    matrix = report["confusion"]
    if len(matrix) != 8 or any(len(row) != 8 for row in matrix):
        raise ValueError("拟合族评价需要完整八类矩阵")
    if (set(report["classes"]) != set(LABELS)
            or any(report["classes"][label]["support"] != sum(matrix[i]) for i, label in enumerate(LABELS))):
        raise ValueError("拟合族评价的类别支持与矩阵不符")
    grouped = [[0] * len(FAMILIES) for _ in FAMILIES]
    for i, row in enumerate(matrix):
        for j, count in enumerate(row):
            if type(count) is not int or count < 0:
                raise ValueError("拟合族评价计数无效")
            grouped[FAMILY_INDICES[i]][FAMILY_INDICES[j]] += count
    return classification_report(grouped, FAMILIES, report["loss"])


def selection_report(validation: dict, reference: dict | None = None) -> dict:
    """逐来源逐拟合族计分；任何来源的精确率或召回回退都失败，支持漂移抛ValueError。"""
    sources = validation.get("sources")
    if not sources:
        raise ValueError("选模需要完整的逐来源验证报告")
    sources = {source: family_report(report) for source, report in sources.items()}
    pairs = [(source, label, metrics) for source, report in sorted(sources.items())
             for label, metrics in report["classes"].items() if metrics["support"]]
    if not pairs or any(not math.isfinite(m["f1"]) or not 0 <= m["f1"] <= 1 for _, _, m in pairs):
        raise ValueError("来源类别指标无效")
    regressions = []
    if reference:
        for source, raw in reference["sources"].items():
            report = family_report(raw)
            current = sources.get(source)
            if current is None:
                raise ValueError("参考验证来源缺失")
            for label, before in report["classes"].items():
                if not before["support"]:
                    continue
                after = current["classes"][label]
                if after["support"] != before["support"]:
                    raise ValueError("参考验证样本数量变化")
                for metric in ("precision", "recall"):
                    drop = before[metric] - after[metric]
                    if drop > 1e-12:
                        regressions.append({"source": source, "family": label, "metric": metric,
                                            "before": before[metric], "after": after[metric], "drop": drop})
    return {"source_family_macro_f1": sum(m["f1"] for _, _, m in pairs) / len(pairs),
            "source_family_pairs": len(pairs), "retention_tolerance": 0.,
            "passes_class_retention": not regressions, "class_regressions": regressions,
            "worst_drop": max((r["drop"] for r in regressions), default=0.)}


def selection_key(validation: dict, reference: dict | None = None, product: dict | None = None) -> tuple:
    """优先满足旧能力约束，再比较来源均衡F1；测试结果不得进入该排序。"""
    result = selection_report(validation, reference)
    passed = result["passes_class_retention"] and (not product or product["passes_product_retention"])
    return (passed, -result["worst_drop"], product["correct"] if product else 0,
            result["source_family_macro_f1"], -validation["loss"])
