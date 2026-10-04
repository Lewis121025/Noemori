"""按固定类别顺序统计评测结果，避免总体准确率掩盖少数类别失败。"""

import math


def classification_report(confusion: list[list[int]], labels: tuple[str, ...],
                          loss: float) -> dict:
    """按真实类别为行、预测类别为列汇总指标；空集或非法矩阵抛 ValueError。"""
    size = len(labels)
    if (not size or len(set(labels)) != size or len(confusion) != size
            or any(len(row) != size for row in confusion)
            or any(type(n) is not int or n < 0 for row in confusion for n in row)
            or not math.isfinite(loss) or loss < 0):
        raise ValueError("评测矩阵、类别或损失无效")
    count = sum(map(sum, confusion))
    if not count:
        raise ValueError("不能报告空评测集")
    classes = {}
    for i, label in enumerate(labels):
        support = sum(confusion[i])
        predicted = sum(row[i] for row in confusion)
        correct = confusion[i][i]
        precision = correct / predicted if predicted else 0.0
        recall = correct / support if support else 0.0
        f1 = 2 * correct / (support + predicted) if support + predicted else 0.0
        classes[label] = {"support": support, "precision": precision, "recall": recall, "f1": f1}
    present = [item for item in classes.values() if item["support"]]
    return {"samples": count, "loss": loss,
            "accuracy": sum(confusion[i][i] for i in range(size)) / count,
            "macro_f1": sum(item["f1"] for item in classes.values()) / size,
            "macro_f1_present_classes": sum(item["f1"] for item in present) / len(present),
            "balanced_accuracy_present_classes": sum(item["recall"] for item in present) / len(present),
            "classes": classes, "confusion": confusion}
