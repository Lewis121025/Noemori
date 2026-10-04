"""按来源和类别选择权重，原有能力的回退不能被大来源的高分掩盖。"""

import math

LEGACY_SOURCES = frozenset(("synthetic", "mmg", "ai_reviewed_quickdraw"))
RECALL_TOLERANCE = .02


def canonical_source(source: str) -> str:
    """把同一来源的原图和端侧视图合并为评价来源，不把渲染表示当作新人群。"""
    return source.removesuffix("_native")


def legacy_source(source: str) -> bool:
    """仅原有监督来源可接受旧模型训练约束；新增数据必须学习独立复核标签。"""
    return canonical_source(source) in LEGACY_SOURCES


def selection_report(validation: dict, reference: dict | None = None) -> dict:
    """逐来源逐类别均衡计分，并检查旧验证召回；缺失来源、非法指标直接报错。"""
    sources = validation.get("sources")
    if not sources:
        raise ValueError("选模需要完整的逐来源验证报告")
    pairs = [(source, label, metrics) for source, report in sorted(sources.items())
             for label, metrics in report["classes"].items() if metrics["support"]]
    if not pairs or any(not math.isfinite(m["f1"]) or not 0 <= m["f1"] <= 1 for _, _, m in pairs):
        raise ValueError("来源类别指标无效")
    regressions = []
    if reference:
        for source, report in reference["sources"].items():
            if not legacy_source(source):
                continue
            current = sources.get(source)
            if current is None:
                raise ValueError("原有验证来源缺失")
            for label, before in report["classes"].items():
                if not before["support"]:
                    continue
                after = current["classes"][label]
                if after["support"] != before["support"]:
                    raise ValueError("原有验证样本数量变化")
                drop = before["recall"] - after["recall"]
                if drop > RECALL_TOLERANCE + 1e-12:
                    regressions.append({"source": source, "label": label, "before_recall": before["recall"],
                                        "after_recall": after["recall"], "excess_drop": drop - RECALL_TOLERANCE})
    return {"source_class_macro_f1": sum(m["f1"] for _, _, m in pairs) / len(pairs),
            "source_class_pairs": len(pairs), "legacy_recall_tolerance": RECALL_TOLERANCE,
            "passes_legacy_retention": not regressions, "legacy_regressions": regressions,
            "worst_excess_drop": max((r["excess_drop"] for r in regressions), default=0.)}


def selection_key(validation: dict, reference: dict | None = None) -> tuple:
    """优先满足旧能力约束，再比较来源均衡F1；测试结果不得进入该排序。"""
    result = selection_report(validation, reference)
    return (result["passes_legacy_retention"], -result["worst_excess_drop"],
            result["source_class_macro_f1"], validation["macro_f1"], -validation["loss"])
