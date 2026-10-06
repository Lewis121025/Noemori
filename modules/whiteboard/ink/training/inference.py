"""训练产物的统一推理入口，部署与离线诊断共用类别及预处理契约。"""

import math
from pathlib import Path

import timm
import torch

from ..dataset.classification.schema import LABELS
from .data import image_transform
from .train import MODEL


def load_classifier(checkpoint: Path, device: torch.device) -> tuple:
    """加载本项目 checkpoint 并返回模型、预处理和元数据；不兼容契约或权重报错。"""
    saved = torch.load(checkpoint, map_location="cpu", weights_only=True)
    metadata = saved["metadata"]
    if metadata["model"] != MODEL or metadata["labels"] != list(LABELS):
        raise ValueError("模型架构或类别顺序不兼容")
    preprocessing = metadata["preprocessing"]
    mean, std = preprocessing["mean"], preprocessing["std"]
    if (preprocessing["input_shape"] != [1, 3, 224, 224]
            or len(mean) != 3 or len(std) != 3
            or any(not math.isfinite(n) for n in [*mean, *std]) or min(std) <= 0
            or preprocessing["aspect_ratio_preserved"] is not True
            or preprocessing["background"] != "white" or preprocessing["ink"] != "black"):
        raise ValueError("模型预处理契约不兼容")
    model = timm.create_model(MODEL, pretrained=False, num_classes=len(LABELS))
    if metadata.get("classifier_head"):
        from .adapter import HEAD_VERSION, enable_adapter
        if metadata["classifier_head"] != HEAD_VERSION:
            raise ValueError("分类头版本不兼容")
        enable_adapter(model)
    model.load_state_dict(saved["model"], strict=True)
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.cuda.matmul.allow_tf32 = False
    return model.to(device).eval(), image_transform(tuple(mean), tuple(std), False), metadata


def _image_batch(transform, paths: list[Path], device: torch.device) -> torch.Tensor:
    from PIL import Image
    if not paths:
        raise ValueError("推理输入不能为空")
    tensors = []
    for path in paths:
        with Image.open(path) as image:
            if image.mode != "RGB" or image.size != (224, 224):
                raise ValueError("推理输入必须为 224×224 RGB")
            tensors.append(transform(image))
    return torch.stack(tensors).to(device)


def predict_images(model, transform, paths: list[Path], device: torch.device) -> torch.Tensor:
    """对一批规范RGB图片返回训练分类头概率；非法图片或非有限输出立即报错。"""
    images = _image_batch(transform, paths, device)
    with torch.inference_mode():
        logits = model(images)
        if logits.shape != (len(paths), len(LABELS)) or not torch.isfinite(logits).all():
            raise ValueError("模型输出违反类别或数值契约")
    return logits.softmax(dim=1).cpu()


def predict_heads(model, transform, paths: list[Path], device: torch.device) -> tuple[torch.Tensor, torch.Tensor | None]:
    """一次CNN前向得到独立两头概率；单头仅返回原候选，非法像素或输出抛ValueError。"""
    from .adapter import ClassifierAdapter
    images = _image_batch(transform, paths, device)
    with torch.inference_mode():
        head = model.get_classifier()
        if isinstance(head, ClassifierAdapter):
            features = model.forward_head(model.forward_features(images), pre_logits=True)
            primary, refinement = head.predictions(features)
        else:
            primary, refinement = model(images), None
        for logits in (primary, refinement):
            if logits is not None and (logits.shape != (len(paths), len(LABELS)) or not torch.isfinite(logits).all()):
                raise ValueError("模型输出违反类别或数值契约")
        return primary.softmax(dim=1).cpu(), refinement.softmax(dim=1).cpu() if refinement is not None else None
