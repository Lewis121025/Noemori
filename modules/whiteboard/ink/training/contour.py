"""同母图与粗尺度一致性训练；部署仍使用原骨干和固定单图分类接口。"""

from pathlib import Path

from PIL import Image, ImageFilter
import torch
from torch import nn
from torchvision import transforms
from torchvision.transforms import functional as vision

from .data import ImageDataset
from .selection import legacy_source


class ContourTransform:
    """三张视图共享刚性增强；粗图只弱化细节，不填充闭合区域或移除内部笔画。"""

    def __init__(self, mean: tuple, std: tuple):
        """保存训练归一化契约；原图与干净参考必须已验证为RGB224。"""
        self.normalize = transforms.Compose([transforms.ToTensor(), transforms.Normalize(mean, std)])

    def __call__(self, image: Image.Image, reference: Image.Image) -> tuple:
        """返回原图、同母图参考及粗图张量；共享角度、位移和缩放，不改变两图的相对几何。"""
        angle = transforms.RandomRotation.get_params([-180, 180])
        _, translation, scale, _ = transforms.RandomAffine.get_params(
            [0, 0], [.025, .025], [.85, 1.], None, [224, 224])

        def spatial(value):
            rotated = vision.rotate(value, angle, interpolation=vision.InterpolationMode.BILINEAR,
                                    expand=True, fill=255)
            resized = vision.resize(rotated, [224, 224], interpolation=vision.InterpolationMode.BILINEAR)
            return vision.affine(resized, 0, translation, scale, [0., 0.],
                                 interpolation=vision.InterpolationMode.BILINEAR, fill=255)

        original, clean = spatial(image), spatial(reference)
        # 先保留细线可见性再降采样；不采用凸包、区域填充或强闭运算，避免抹掉箭翼/开口。
        coarse = original.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(.7))
        coarse = coarse.resize((64, 64), Image.Resampling.BOX).resize((224, 224), Image.Resampling.BILINEAR)
        return tuple(self.normalize(value) for value in (original, clean, coarse))


class ContourDataset(ImageDataset):
    """训练专用三视图；只有来源验证器提供的干净母图可作为参考，其余记录引用自身。"""

    def __init__(self, records: list, mean: tuple, std: tuple, sources: list[str], references: dict[str, Path]):
        """建立已校验原图到干净母图的映射；图像契约无效时在读取阶段抛ValueError。"""
        super().__init__(records, ContourTransform(mean, std), sources)
        self.references = references

    def __getitem__(self, index: int) -> dict:
        """返回三视图、真值和旧来源标记；新增细节样本不接受旧模型预测约束。"""
        path, label = self.records[index]
        reference = self.references.get(str(path), path)
        with Image.open(path) as image, Image.open(reference) as clean:
            if any(value.mode != "RGB" or value.size != (224, 224) for value in (image, clean)):
                raise ValueError("轮廓成对输入必须为224×224 RGB")
            original, clean_tensor, coarse = self.transform(image, clean)
        return {"image": original, "reference": clean_tensor, "coarse": coarse,
                "label": label, "retain": legacy_source(self.sources[index])}


def contour_forward(model: nn.Module, images: torch.Tensor, references: torch.Tensor,
                    coarse: torch.Tensor, targets: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """共享骨干计算三视图分类及特征约束；形状或非有限输出违约时抛ValueError。"""
    count = len(targets)
    if not count or images.shape != references.shape or images.shape != coarse.shape:
        raise ValueError("轮廓成对张量形状不符")
    features = model.forward_head(model.forward_features(torch.cat((images, references, coarse))), pre_logits=True)
    if features.ndim != 2 or len(features) != count * 3 or not torch.isfinite(features).all():
        raise ValueError("共享骨干特征违反轮廓训练契约")
    logits = model.get_classifier()(features)
    if logits.shape != (count * 3, 8) or not torch.isfinite(logits).all():
        raise ValueError("轮廓训练分类输出违反固定八类契约")
    original_features, clean_features, coarse_features = features.chunk(3)
    original_logits, clean_logits, coarse_logits = logits.chunk(3)
    classification = (nn.functional.cross_entropy(clean_logits, targets)
                      + nn.functional.cross_entropy(coarse_logits, targets)) * .25
    agreement = ((1 - nn.functional.cosine_similarity(original_features, clean_features)).mean()
                 + (1 - nn.functional.cosine_similarity(original_features, coarse_features)).mean()) * .05
    return original_logits, classification + agreement.clamp_min(0)
