"""单轮训练与评测共用 FP32，避免混合精度验证掩盖 CPU 部署时的数值漂移。"""

import math
import os
from pathlib import Path

import torch
from torch import nn
from torch.utils.data import SequentialSampler

from ..dataset.classification.schema import LABELS
from .metrics import classification_report
from .selection import canonical_source


def retention_loss(student: torch.Tensor, teacher: torch.Tensor, temperature: float = 2.) -> torch.Tensor:
    """比较旧训练样本的概率结构；教师不提供真值，新增监督仍以独立标签计算交叉熵。"""
    if (student.shape != teacher.shape or student.ndim != 2 or not len(student)
            or not math.isfinite(temperature) or temperature <= 0):
        raise ValueError("保留约束的模型输出不符")
    return nn.functional.kl_div(nn.functional.log_softmax(student / temperature, dim=1),
                               nn.functional.softmax(teacher.detach() / temperature, dim=1),
                               reduction="batchmean").clamp_min(0) * temperature ** 2


class SourceMetrics:
    """仅顺序评价可按位置映射来源；训练的随机采样不能借此制造来源指标。"""

    def __init__(self, loader, device: torch.device):
        """建立来源索引；非顺序、丢尾或无来源的数据加载器拒绝。"""
        if (not isinstance(loader.sampler, SequentialSampler) or loader.drop_last
                or not hasattr(loader.dataset, "sources") or len(loader.dataset.sources) != len(loader.dataset)):
            raise ValueError("逐来源评价需要完整顺序数据及来源索引")
        self.names = [canonical_source(source) for source in loader.dataset.sources]
        self.position = 0
        self.confusions = {name: torch.zeros(8, 8, dtype=torch.int64, device=device) for name in set(self.names)}
        self.losses = {name: torch.zeros((), device=device) for name in self.confusions}
        self.counts = {name: 0 for name in self.confusions}

    def update(self, indices: torch.Tensor, losses: torch.Tensor) -> None:
        """同步累积同批的来源矩阵和损失；不重跑模型，也不依赖预测选择样本。"""
        batch = self.names[self.position:self.position + len(indices)]
        for name in set(batch):
            mask = torch.tensor([source == name for source in batch], device=indices.device)
            self.confusions[name] += torch.bincount(indices[mask], minlength=64).reshape(8, 8)
            self.losses[name] += losses.detach()[mask].sum()
            self.counts[name] += batch.count(name)
        self.position += len(indices)

    def report(self) -> dict:
        """输出独立的来源报告；输入未遍历完整时拒绝不完整评价。"""
        if self.position != len(self.names):
            raise ValueError("逐来源评价未遍历完整输入")
        return {name: classification_report(self.confusions[name].cpu().tolist(), LABELS,
                                             self.losses[name].item() / self.counts[name]) for name in sorted(self.confusions)}


def run_epoch(model: nn.Module, loader, device: torch.device,
              optimizer: torch.optim.Optimizer | None = None, *,
              teacher: nn.Module | None = None, report_sources: bool = False, contour: bool = False,
              contour_weight: float = 1.) -> dict:
    """遍历一个划分并返回损失与混淆矩阵；非有限损失或空数据集立即报错。"""
    training = optimizer is not None
    if not math.isfinite(contour_weight) or contour_weight < 0:
        raise ValueError("轮廓训练权重必须为非负有限数")
    if (teacher is not None and not training) or (report_sources and training) or (contour and not training):
        raise ValueError("旧模型约束仅训练使用，来源位置统计仅顺序评价使用")
    model.train(training)
    if contour:
        # 三视图不能把部署统计改成粗图/原图混合分布；仿射参数仍参与梯度更新。
        for module in model.modules():
            if isinstance(module, (nn.BatchNorm1d, nn.BatchNorm2d, nn.BatchNorm3d)):
                module.eval()
    source_metrics = SourceMetrics(loader, device) if report_sources else None
    if teacher is not None:
        teacher.eval()
    size = len(LABELS)
    confusion = torch.zeros(size, size, dtype=torch.int64, device=device)
    total_loss = torch.zeros((), device=device)
    count = 0
    with torch.set_grad_enabled(training):
        for batch in loader:
            if contour:
                images, targets, retained = batch["image"], batch["label"], batch["retain"]
                retained = retained.to(device) if teacher is not None else None
            elif teacher is None:
                images, targets = batch
                retained = None
            else:
                images, targets, retained = batch
                retained = retained.to(device)
            images = images.to(device, non_blocking=True)
            targets = targets.to(device, non_blocking=True)
            if optimizer is not None:
                optimizer.zero_grad(set_to_none=True)
            auxiliary = None
            if contour:
                from .contour import contour_forward
                logits, auxiliary = contour_forward(model, images, batch["reference"].to(device),
                                                     batch["coarse"].to(device), targets)
            else:
                logits = model(images)
            if logits.shape != (len(targets), size):
                raise ValueError("模型输出与固定类别契约不符")
            losses = nn.functional.cross_entropy(logits, targets, reduction="none")
            loss = losses.mean()
            if auxiliary is not None:
                loss = loss + contour_weight * auxiliary
            if retained is not None and retained.any():
                with torch.no_grad():
                    old_logits = teacher(images[retained])
                loss = loss + .15 * retention_loss(logits[retained], old_logits)
            if not torch.isfinite(loss).item():
                raise ValueError("训练损失非有限，停止以保留故障现场")
            if optimizer is not None:
                loss.backward()
                nn.utils.clip_grad_norm_(model.parameters(), max_norm=5.0, error_if_nonfinite=True)
                optimizer.step()
            total_loss += loss.detach().float() * len(targets)
            count += len(targets)
            indices = targets * size + logits.detach().argmax(dim=1)
            confusion += torch.bincount(indices, minlength=size * size).reshape(size, size)
            if source_metrics:
                source_metrics.update(indices, losses)
    result = classification_report(confusion.cpu().tolist(), LABELS,
                                   total_loss.item() / count if count else math.nan)
    if source_metrics:
        result["sources"] = source_metrics.report()
    return result


def save_checkpoint(path: Path, value: dict) -> None:
    """在同目录原子替换权重；写入失败时清理临时文件并保留先前完整 checkpoint。"""
    temporary = path.with_name(path.name + ".tmp")
    try:
        with temporary.open("wb") as handle:
            torch.save(value, handle)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def reestimate_batch_norm(model: nn.Module, loader, device: torch.device) -> dict:
    """仅用未增强的训练输入重估归一化缓冲区；参数不更新，空集或非有限输出报错。"""
    norms = [module for module in model.modules() if isinstance(module, (nn.BatchNorm1d, nn.BatchNorm2d, nn.BatchNorm3d))]
    if not norms:
        raise ValueError("模型没有可重估的 BatchNorm")
    model.eval()
    momentums = [module.momentum for module in norms]
    count = 0
    try:
        for module in norms:
            module.reset_running_stats()
            module.momentum = None
            module.train()
        with torch.no_grad():
            for images, _ in loader:
                logits = model(images.to(device, non_blocking=True))
                if not torch.isfinite(logits).all():
                    raise ValueError("重估统计时出现非有限输出")
                count += len(images)
        if not count:
            raise ValueError("不能用空训练集重估统计")
    finally:
        for module, momentum in zip(norms, momentums):
            module.momentum = momentum
        model.eval()
    return {"samples": count, "batch_norm_layers": len(norms), "parameter_updates": 0,
            "input": "unaugmented_training_images", "sampling": "class_then_source_balanced"}
