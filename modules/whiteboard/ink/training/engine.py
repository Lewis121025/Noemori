"""单轮训练与评测共用 FP32，避免混合精度验证掩盖 CPU 部署时的数值漂移。"""

import math
import os
from pathlib import Path

import torch
from torch import nn

from ..dataset.classification.schema import LABELS
from .metrics import classification_report


def run_epoch(model: nn.Module, loader, device: torch.device,
              optimizer: torch.optim.Optimizer | None = None) -> dict:
    """遍历一个划分并返回损失与混淆矩阵；非有限损失或空数据集立即报错。"""
    training = optimizer is not None
    model.train(training)
    size = len(LABELS)
    confusion = torch.zeros(size, size, dtype=torch.int64, device=device)
    total_loss = torch.zeros((), device=device)
    count = 0
    with torch.set_grad_enabled(training):
        for images, targets in loader:
            images = images.to(device, non_blocking=True)
            targets = targets.to(device, non_blocking=True)
            if optimizer is not None:
                optimizer.zero_grad(set_to_none=True)
            logits = model(images)
            if logits.shape != (len(targets), size):
                raise ValueError("模型输出与固定类别契约不符")
            loss = nn.functional.cross_entropy(logits, targets)
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
    return classification_report(confusion.cpu().tolist(), LABELS,
                                 total_loss.item() / count if count else math.nan)


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
