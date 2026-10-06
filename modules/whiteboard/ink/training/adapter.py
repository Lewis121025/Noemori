"""保留固定骨干与原分类头，通过零初始化残差学习全部八类的修正。"""

import torch
from torch import nn

HEAD_VERSION = "residual_64"


class ClassifierAdapter(nn.Module):
    """64维残差分类头；初始输出与原头完全相同，原参数不接受优化器更新。"""

    def __init__(self, base: nn.Linear):
        """接收已验证的八类线性头；输出维度不符抛ValueError，初始残差为精确零。"""
        super().__init__()
        if not isinstance(base, nn.Linear) or base.out_features != 8:
            raise ValueError("残差分类头必须建立在已验证八类线性头上")
        self.base = base
        self.refine = nn.Sequential(nn.Linear(base.in_features, 64), nn.SiLU(), nn.Linear(64, 8))
        nn.init.zeros_(self.refine[-1].weight)
        nn.init.zeros_(self.refine[-1].bias)

    def forward(self, features: torch.Tensor) -> torch.Tensor:
        """输出原logits加学习残差；输入形状不符时由PyTorch抛错。"""
        return self.predictions(features)[1]

    def predictions(self, features: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """同一特征返回原logits与改进logits，训练仍使用改进输出，部署保护原候选。"""
        original = self.base(features)
        return original, original + self.refine(features)


class DeploymentHeads(nn.Module):
    """导出两头但共用一次CNN前向；原头用于优先几何验证，不增加第二个特征提取器。"""

    def __init__(self, adapter: ClassifierAdapter):
        """接收本项目残差头，非支持类型抛ValueError。"""
        super().__init__()
        if not isinstance(adapter, ClassifierAdapter):
            raise ValueError("两头部署必须使用保留原分类头的残差模型")
        self.adapter = adapter

    def forward(self, features: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """返回原头、改进头的固定八类logits；维度错误由PyTorch抛错。"""
        return self.adapter.predictions(features)


def verify_original(model: nn.Module, reference: nn.Module) -> None:
    """逐张量证明原参数及统计未改变；任何漂移抛ValueError，不能借原模型分数替候选验收。"""
    current = model.state_dict()
    reference_adapter = isinstance(reference.get_classifier(), ClassifierAdapter)
    for name, value in reference.state_dict().items():
        if reference_adapter and name.startswith("classifier.refine."):
            continue
        key = ("classifier.base." + name.removeprefix("classifier.")
               if name.startswith("classifier.") and not reference_adapter else name)
        if key not in current or not torch.equal(value, current[key]):
            raise ValueError("原分类参数或部署统计发生漂移：" + name)


def enable_adapter(model: nn.Module) -> None:
    """固定骨干与原头，仅开放残差参数；非支持的模型结构抛ValueError。"""
    head = model.get_classifier()
    if not isinstance(head, ClassifierAdapter):
        model.classifier = ClassifierAdapter(head)
    model.requires_grad_(False)
    model.get_classifier().refine.requires_grad_(True)
