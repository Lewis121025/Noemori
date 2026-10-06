"""微调 MobileNetV3-Large；合成数据与显式复核补充分开溯源，不声称产品泛化。"""

import argparse
import hashlib
from importlib.metadata import version
import json
import math
from pathlib import Path
import random
import time

import numpy as np
import timm
import torch
from torch.utils.data import DataLoader

from ..dataset.classification.schema import LABELS
from .data import ImageDataset, RetentionDataset, ShapeDataset, balanced_sampler, image_transform, seed_worker
from .engine import reestimate_batch_norm, run_epoch, save_checkpoint
from .selection import selection_key, selection_report

MODEL = "mobilenetv3_large_100.ra_in1k"


def write_json(path: Path, value: dict) -> None:
    """写入可审查的 JSON；非有限指标拒绝序列化，不覆盖部分写入的旧文件。"""
    text = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    temporary = path.with_name(path.name + ".tmp")
    try:
        temporary.write_text(text)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def build_loaders(dataset: Path, mean: tuple, std: tuple, batch_size: int,
                  workers: int, seed: int, pin_memory: bool, supplement: dict | None = None,
                  gestures: dict | None = None, native_images: Path | None = None,
                  external: dict | None = None, retention: bool = False, contour: bool = False,
                  static_images: Path | None = None) -> dict:
    """建立三个独立加载器；仅训练启用增强，真实补充必须由复核入口提供。"""
    loaders, datasets = {}, {}
    for split in ("train", "val", "test"):
        extra = supplement.get(split) if supplement else None
        data = ShapeDataset(dataset, split, image_transform(mean, std, split == "train"), extra)
        if gestures:
            data = ImageDataset(data.records + gestures[split], data.transform,
                                data.sources + ["mmg"] * len(gestures[split]))
        datasets[split] = data
    accepted = {str(path.resolve()): (split, label, source)
                for split, data in datasets.items() for (path, label), source in zip(data.records, data.sources)}
    isolated_origins, native_origins = set(), {}
    if external and static_images:
        accepted.update(external["origins"])
    if static_images:
        caches = [native_images] if native_images else []
        if external and external.get("native"):
            caches.append(Path(external["native"]["directory"]))
        for cache in caches:
            for row in map(json.loads, (cache / "records.jsonl").read_text().splitlines()):
                origin = str(Path(row["original"]).resolve())
                native_origins[str((cache / row["image"]).resolve())] = origin
                if row["exclude_native"] or row["exclude_original"]:
                    isolated_origins.add(origin)
    if native_images:
        from .native_images import load_native_images
        native, details = load_native_images(native_images, datasets)
        isolated_origins.update(path for paths in details["exclude_original"].values() for path in paths)
        combined = {}
        for split, data in datasets.items():
            excluded = set(details["exclude_original"][split])
            retained = [(record, source) for record, source in zip(data.records, data.sources)
                        if str(record[0].resolve()) not in excluded]
            combined[split] = ImageDataset([record for record, _ in retained] + native[split], data.transform,
                                           [source for _, source in retained] + details["sources"][split])
        datasets = combined
    if external:
        from .external import merge_external
        reserved = set(json.loads((native_images / "manifest.json").read_text()).get("reserved_pixel_sha256", [])) if native_images else set()
        datasets, exclusions = merge_external(datasets, external, reserved)
        external["exclusions"] = exclusions
        isolated_origins.update(native_origins.get(str(Path(row["path"]).resolve()), str(Path(row["path"]).resolve()))
                                for row in exclusions["removed"])
        isolated_origins.update(row["path"] for row in external.get("native", {}).get("removed", []))
    if static_images:
        from .static_images import append_static_views
        datasets, static_metadata = append_static_views(datasets, static_images, accepted, isolated_origins)
        if external is not None:
            external["static_images"] = static_metadata
    for split, data in datasets.items():
        if split == "train" and contour:
            from .contour import ContourDataset
            data = ContourDataset(data.records, mean, std, data.sources, external.get("references", {}) if external else {})
        elif split == "train" and retention:
            data = RetentionDataset(data.records, data.transform, data.sources)
        if split == "train" and len(data) < batch_size:
            raise ValueError("训练集不足一个完整批次，请降低 batch-size")
        loaders[split] = DataLoader(
            data, batch_size=batch_size, sampler=balanced_sampler(data, seed) if split == "train" else None,
            num_workers=workers, drop_last=split == "train",
            pin_memory=pin_memory, persistent_workers=workers > 0, worker_init_fn=seed_worker,
            generator=torch.Generator().manual_seed(seed))
    if gestures:
        loaders["gesture_test"] = DataLoader(
            ImageDataset(gestures["test"], image_transform(mean, std, False)), batch_size=batch_size,
            num_workers=workers, pin_memory=pin_memory, worker_init_fn=seed_worker)
    if external:
        test = datasets["test"]
        for source in sorted(set(external["sources"]["test"])):
            records = [record for record, origin in zip(test.records, test.sources) if origin == source]
            if records:
                loaders["source_test/" + source] = DataLoader(
                    ImageDataset(records, test.transform, [source] * len(records)), batch_size=batch_size,
                    num_workers=workers, pin_memory=pin_memory, worker_init_fn=seed_worker)
    return loaders


def configure(args) -> tuple:
    """校验数据后加载预训练骨干与新分类头；不在下载失败时偷偷改为随机训练。"""
    from ..dataset.classification.generate import validate_dataset
    validate_dataset(args.dataset)
    manifest_path = args.dataset / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if manifest["classes"] != list(LABELS):
        raise ValueError("数据类别顺序与模型输出契约不一致")
    if args.output.exists():
        raise ValueError("训练输出目录已存在，请使用新的运行目录")
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.set_num_threads(4)
    device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise ValueError("请求 GPU 训练但 CUDA 不可用")
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True
    # 目标端为 CPU FP32；训练、选模和导出验收应使用相同数值精度。
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.cuda.matmul.allow_tf32 = False
    initialization = None
    if args.initialize is not None:
        from .inference import load_classifier
        from ..dataset.classification.acquire import file_record
        model, _, parent = load_classifier(args.initialize, torch.device("cpu"))
        if parent.get("precision") != "fp32" or parent.get("tf32") is not False:
            raise ValueError("继续微调必须使用经过 CPU FP32 验证的初始权重")
        initialization = {"checkpoint": str(args.initialize.resolve()), "file": file_record(args.initialize),
                          "dataset_manifest_sha256": parent["dataset_manifest_sha256"]}
    else:
        model = timm.create_model(MODEL, pretrained=True, num_classes=len(LABELS))
    cfg = model.pretrained_cfg
    from .adapter import ClassifierAdapter
    adapter = bool(getattr(args, "classifier_adapter", False)) or isinstance(model.get_classifier(), ClassifierAdapter)
    if adapter:
        from .adapter import enable_adapter
        if not getattr(args, "retain_checkpoint", None):
            raise ValueError("残差分类头训练必须提供已验证的保留基线")
        if not getattr(args, "static_images", None) or not getattr(args, "product_validation", None):
            raise ValueError("两头训练必须提供已隔离的静态视图和产品验证")
        enable_adapter(model)
    mean, std = tuple(cfg["mean"]), tuple(cfg["std"])
    fingerprint = hashlib.sha256()
    for name, tensor in model.state_dict().items():
        fingerprint.update(name.encode())
        fingerprint.update(tensor.cpu().numpy().tobytes())
    supplement, supplement_metadata = None, None
    if args.reviewed_negatives is not None:
        from .supplement import load_negative_supplement
        supplement, supplement_metadata = load_negative_supplement(args.dataset, args.reviewed_negatives, args.heldout_review)
    gestures, gesture_metadata = None, None
    if args.gesture_dataset is not None:
        from .gestures import load_gesture_records
        gestures, gesture_metadata = load_gesture_records(args.gesture_dataset)
    external = None
    if getattr(args, "external_datasets", None):
        from .external import load_external_packages
        external = load_external_packages(args.external_datasets)
        if getattr(args, "external_native", None):
            from .external import load_external_native
            external = load_external_native(args.external_native, external)
    loaders = build_loaders(args.dataset, mean, std, args.batch_size, args.workers,
                            args.seed, device.type == "cuda", supplement, gestures, args.native_images, external,
                            bool(getattr(args, "retain_checkpoint", None)), bool(getattr(args, "contour_training", False)),
                            getattr(args, "static_images", None))
    teacher, retention_metadata = None, None
    if getattr(args, "retain_checkpoint", None):
        from .inference import load_classifier
        from ..dataset.classification.acquire import file_record
        teacher, _, parent = load_classifier(args.retain_checkpoint, device)
        teacher.requires_grad_(False)
        reference = run_epoch(teacher, loaders["val"], device, report_sources=True,
                              original_head=isinstance(teacher.get_classifier(), ClassifierAdapter))
        retention_metadata = {"checkpoint": str(args.retain_checkpoint.resolve()),
                              "file": file_record(args.retain_checkpoint), "reference_validation": reference,
                              "temperature": 2., "strength": .15,
                              "scope": "verified_teacher_correct_training_labels" if adapter else "legacy_training_sources_only"}
    from .external import source_counts
    metadata = {
        "model": MODEL, "labels": list(LABELS), "dataset": str(args.dataset.resolve()),
        "dataset_manifest_sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
        "initial_state_sha256": fingerprint.hexdigest(), "pretrained_reference": cfg.get("hf_hub_id"),
        "initialization": initialization,
        "parameters": sum(p.numel() for p in model.parameters()),
        "trainable_parameters": sum(p.numel() for p in model.parameters() if p.requires_grad),
        "classifier_head": "residual_64" if adapter else None,
        "deployment_heads": "original_and_refinement" if adapter else "single",
        "training_sources": {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                             for p in sorted(Path(__file__).parent.glob("*.py"))},
        "preprocessing": {"input_shape": [1, 3, 224, 224], "mean": mean, "std": std,
                          "aspect_ratio_preserved": True, "background": "white", "ink": "black"},
        "seed": args.seed, "epochs": args.epochs, "patience": args.patience,
        "batch_size": args.batch_size, "backbone_lr": args.learning_rate,
        "classifier_lr": args.learning_rate * 10, "weight_decay": 1e-4,
        "device": str(device), "device_name": torch.cuda.get_device_name(device) if device.type == "cuda" else "CPU",
        "precision": "fp32", "tf32": False,
        "versions": {name: version(name) for name in ("torch", "torchvision", "timm", "pillow", "numpy")},
        "counts": {split: loader.dataset.counts for split, loader in loaders.items()},
        "source_view_counts": {split: source_counts(loaders[split].dataset) for split in ("train", "val", "test")},
        "external_datasets": external["metadata"] if external else [],
        "external_exclusions": external.get("exclusions") if external else None,
        "external_native": external.get("native") if external else None,
        "static_images": external.get("static_images") if external else None,
        "retention": retention_metadata,
        "selection_protocol": "source_family_with_class_retention" if teacher is not None else "pooled_macro_f1",
        "evaluation_scope": ("synthetic_and_source_separated_real_packages" if external else
                             "synthetic_and_writer_isolated_mmg" if gestures else
                             "synthetic_with_ai_reviewed_negative_validation" if supplement else "synthetic_only"),
        "reviewed_negatives": supplement_metadata,
        "gesture_dataset": gesture_metadata,
        "native_images": ({"directory": str(args.native_images.resolve()),
                           "manifest_sha256": hashlib.sha256((args.native_images / "manifest.json").read_bytes()).hexdigest()}
                          if args.native_images else None),
        "sampling": "class_then_source_balanced_with_replacement",
        "contour_training": ({"views": ["original", "same_parent_reference", "coarse_64"],
                              "auxiliary_classification_weight": .25, "feature_agreement_weight": 0. if adapter else .05,
                              "weight": args.contour_weight,
                              "batch_norm": "frozen_statistics_and_affine" if adapter else "frozen_statistics_trainable_affine", "deployment_views": 1}
                             if getattr(args, "contour_training", False) else None),
        "drop_last_training": True, "drop_last_evaluation": False,
        "augmentation": "expanded_canvas_rotation_then_proportional_resize_and_affine",
        "limitations": ["合成保留测试集不代表真实手写准确率。", "QuickDraw 未复核提示标签不参与训练或模型选择。",
                        "other 仅覆盖本数据集负例，不构成未知输入拒绝能力保证。"],
    }
    return model.to(device), loaders, device, metadata, teacher


def calibrated_validation(model, loaders, device, args, metadata) -> tuple[dict, dict]:
    """以未增强训练图估计当前候选的部署统计；只用验证集选择统计，不接触测试集。"""
    if metadata.get("classifier_head"):
        validation = run_epoch(model, loaders["val"], device, report_sources=True, fixed_features=True)
        return validation, {"selected_reestimation": False, "reason": "固定特征提取器的部署统计不可重估"}
    train = loaders["train"].dataset
    preprocessing = metadata["preprocessing"]
    native = ImageDataset(train.records, image_transform(tuple(preprocessing["mean"]),
                          tuple(preprocessing["std"]), False), train.sources)
    loader = DataLoader(native, batch_size=args.batch_size, num_workers=min(args.workers, 4),
                        sampler=balanced_sampler(native, args.seed, min(len(native), args.batch_size * 64)), drop_last=True)
    buffers = {name: value.clone() for name, value in model.named_buffers()}
    details = reestimate_batch_norm(model, loader, device)
    after = run_epoch(model, loaders["val"], device, report_sources=True)
    candidate_buffers = {name: value.clone() for name, value in model.named_buffers()}
    for name, value in model.named_buffers():
        value.copy_(buffers[name])
    before = run_epoch(model, loaders["val"], device, report_sources=True)
    reference = metadata["retention"]["reference_validation"]
    selected = selection_key(after, reference) > selection_key(before, reference)
    if selected:
        for name, value in model.named_buffers():
            value.copy_(candidate_buffers[name])
    return (after if selected else before), {"selected_reestimation": selected, "details": details,
                                             "before_selection": selection_report(before, reference),
                                             "after_selection": selection_report(after, reference)}


def fit(model, loaders, device, args, metadata, teacher=None) -> dict:
    """按验证集宏 F1 选择最佳权重；早停不查看测试集，失败保留已保存的完整权重。"""
    head_ids = {id(p) for p in model.get_classifier().parameters() if p.requires_grad}
    backbone = [p for p in model.parameters() if p.requires_grad and id(p) not in head_ids]
    optimizer = torch.optim.AdamW([
        {"params": backbone, "lr": args.learning_rate},
        {"params": [p for p in model.get_classifier().parameters() if p.requires_grad], "lr": args.learning_rate * 10}], weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)
    guarded = metadata.get("selection_protocol") == "source_family_with_class_retention"
    reference = metadata["retention"]["reference_validation"] if guarded else None
    initial = reference
    if guarded and (metadata.get("classifier_head") or
                    (metadata.get("initialization") or {}).get("file") != metadata["retention"]["file"]):
        initial = run_epoch(model, loaders["val"], device, report_sources=True)
    product = None
    product_reference = None
    initial_product = None
    if getattr(args, "product_validation", None):
        from .product_validation import ProductValidation
        from .adapter import verify_original
        verify_original(model, teacher)
        product = ProductValidation(args.product_validation, metadata["preprocessing"],
                                    {str(path.resolve()) for path, _ in loaders["val"].dataset.records},
                                    set(metadata["static_images"]["excluded_originals"]
                                        + metadata["static_images"]["excluded_pixel_conflicts"]))
        # 保留基线使用已验证教师的完整部署输出；不能丢掉其改进头，也不能让零残差扩大准入。
        product_reference = product.evaluate(teacher, device)
        initial_product = product.evaluate(model, device, product_reference)
        metadata["product_validation"] = product.metadata
        metadata["product_reference"] = product_reference
        write_json(args.output / "run.json", metadata)
    best_key = selection_key(reference if metadata.get("classifier_head") else initial, reference, initial_product) if guarded else None
    best_epoch = 0
    if guarded:
        save_checkpoint(args.output / "best.pt", {"model": {k: v.detach().cpu() for k, v in model.state_dict().items()},
                         "epoch": 0, "metadata": metadata, "validation": initial,
                         "product_validation": initial_product,
                         "normalization": {"selected_reestimation": False, "reason": "已验证初始权重保留基线"}})
    for epoch in range(1, args.epochs + 1):
        started = time.monotonic()
        train = run_epoch(model, loaders["train"], device, optimizer, teacher=teacher,
                          contour=metadata.get("contour_training") is not None,
                          contour_weight=metadata["contour_training"]["weight"] if metadata.get("contour_training") else 1.,
                          fixed_features=bool(metadata.get("classifier_head")),
                          retain_all_correct=bool(metadata.get("classifier_head")))
        normalization = None
        if guarded:
            validation, normalization = calibrated_validation(model, loaders, device, args, metadata)
        else:
            validation = run_epoch(model, loaders["val"], device)
        scheduler.step()
        product_result = product.evaluate(model, device, product_reference) if product else None
        if metadata.get("classifier_head"):
            from .adapter import verify_original
            verify_original(model, teacher)
        protected_validation = reference if metadata.get("classifier_head") else validation
        result = {"epoch": epoch, "seconds": time.monotonic() - started,
                  "train": train, "val": validation, "product_validation": product_result}
        with (args.output / "epochs.jsonl").open("a") as handle:
            handle.write(json.dumps(result, ensure_ascii=False, allow_nan=False) + "\n")
        checkpoint = {"model": {k: v.detach().cpu() for k, v in model.state_dict().items()},
                      "epoch": epoch, "metadata": metadata, "validation": validation,
                      "protected_validation": protected_validation,
                      "normalization": normalization, "product_validation": product_result}
        key = selection_key(protected_validation, reference, product_result) if guarded else (validation["macro_f1"], -validation["loss"])
        if best_key is None or key > best_key:
            best_key, best_epoch = key, epoch
            save_checkpoint(args.output / "best.pt", checkpoint)
        save_checkpoint(args.output / "last.pt", checkpoint)
        print(json.dumps({"epoch": epoch, "seconds": round(result["seconds"], 2),
                          "train_loss": train["loss"], "val_loss": validation["loss"],
                          "val_accuracy": validation["accuracy"], "val_macro_f1": validation["macro_f1"],
                          "best_epoch": best_epoch, "selection": selection_report(protected_validation, reference) if guarded else None,
                          "product_validation": ({k: v for k, v in product_result.items() if k != "records"}
                                                 if product_result else None)}), flush=True)
        write_json(args.output / "status.json", {"state": "training", "last_epoch": epoch,
                                                  "best_epoch": best_epoch, "last_result": result})
        if epoch - best_epoch >= args.patience:
            break
    return finalize(model, loaders, device, args, metadata, best_epoch, epoch)


def finalize(model, loaders, device, args, metadata, best_epoch: int, last_epoch: int) -> dict:
    """验证选择部署统计后才做测试；重估失败或退步不能覆盖原始最佳权重。"""
    best = torch.load(args.output / "best.pt", map_location="cpu", weights_only=True)
    model.load_state_dict(best["model"])
    if metadata.get("selection_protocol") == "source_family_with_class_retention":
        metadata["normalization_selection"] = best["normalization"]
        reference = metadata["retention"]["reference_validation"]
        metadata["selected_validation"] = selection_report(reference if metadata.get("classifier_head") else best["validation"], reference)
        if best.get("product_validation"):
            metadata["selected_product_validation"] = best["product_validation"]
        best["metadata"] = metadata
        save_checkpoint(args.output / "best.pt", best)
        write_json(args.output / "run.json", metadata)
        return evaluate_selected(model, loaders, device, metadata, best["validation"], best_epoch, last_epoch)
    preprocessing = metadata["preprocessing"]
    train_data = loaders["train"].dataset
    native = ImageDataset(train_data.records, image_transform(tuple(preprocessing["mean"]),
                                                            tuple(preprocessing["std"]), False), train_data.sources)
    calibration_loader = DataLoader(native, batch_size=args.batch_size, num_workers=0,
                                    sampler=balanced_sampler(native, args.seed), drop_last=True)
    details = reestimate_batch_norm(model, calibration_loader, device)
    after = run_epoch(model, loaders["val"], device)
    before = best["validation"]
    selected = (after["macro_f1"], -after["loss"]) > (before["macro_f1"], -before["loss"])
    metadata["normalization_selection"] = {"selected_reestimation": selected, "before": before,
                                            "after": after, "details": details}
    if selected:
        best["model"] = {k: v.detach().cpu() for k, v in model.state_dict().items()}
        best["validation"] = after
    else:
        model.load_state_dict(best["model"])
    best["metadata"] = metadata
    save_checkpoint(args.output / "best.pt", best)
    write_json(args.output / "run.json", metadata)
    return evaluate_selected(model, loaders, device, metadata, best["validation"], best_epoch, last_epoch)


def evaluate_selected(model, loaders, device, metadata, validation, best_epoch: int, last_epoch: int) -> dict:
    """候选固定后才评估测试来源；结果用于验收，不回流训练或权重排序。"""
    # 测试集只在验证选择结束后评估一次，不用于阈值、轮次或超参数选择。
    original = bool(metadata.get("classifier_head"))
    test = run_epoch(model, loaders["test"], device, original_head=True) if original else run_epoch(model, loaders["test"], device)
    result = {"state": "completed", "best_epoch": best_epoch, "last_epoch": last_epoch,
            "validation": validation, "test": test,
            "evaluation_scope": metadata["evaluation_scope"],
            "test_scope": metadata["evaluation_scope"]}
    if "gesture_test" in loaders:
        result["gesture_test"] = run_epoch(model, loaders["gesture_test"], device, original_head=True) if original else run_epoch(model, loaders["gesture_test"], device)
    source_tests = {name.removeprefix("source_test/"): (run_epoch(model, loader, device, original_head=True) if original else run_epoch(model, loader, device))
                    for name, loader in loaders.items() if name.startswith("source_test/")}
    if source_tests:
        result["source_tests"] = source_tests
    if original:
        result["refinement_test"] = run_epoch(model, loaders["test"], device)
    return result


def main() -> None:
    """运行分类训练；无效超参数、数据或依赖直接报错，输出目录不覆盖。"""
    parser = argparse.ArgumentParser(description="MobileNetV3-Large 几何分类基线")
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--patience", type=int, default=6)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--learning-rate", type=float, default=1e-4)
    parser.add_argument("--seed", type=int, default=20261004)
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--reviewed-negatives", type=Path)
    parser.add_argument("--heldout-review", type=Path)
    parser.add_argument("--gesture-dataset", type=Path)
    parser.add_argument("--native-images", type=Path)
    parser.add_argument("--external-datasets", type=Path, nargs="+")
    parser.add_argument("--external-native", type=Path)
    parser.add_argument("--retain-checkpoint", type=Path)
    parser.add_argument("--initialize", type=Path)
    parser.add_argument("--contour-training", action="store_true")
    parser.add_argument("--classifier-adapter", action="store_true")
    parser.add_argument("--static-images", type=Path)
    parser.add_argument("--product-validation", type=Path)
    parser.add_argument("--contour-weight", type=float, default=1.)
    args = parser.parse_args()
    if (args.reviewed_negatives is None) != (args.heldout_review is None):
        parser.error("真实负例复核包与固定盲审对照包必须同时提供")
    if (min(args.epochs, args.patience, args.batch_size) < 1 or args.workers < 0
            or not 0 <= args.seed < 2 ** 32 or not math.isfinite(args.learning_rate)
            or args.learning_rate <= 0):
        parser.error("训练轮数、批量和学习率必须为正，随机种子与进程数须在有效范围")
    if args.external_native and not args.external_datasets:
        parser.error("外部端侧视图必须同时提供其来源数据包")
    if args.classifier_adapter and (args.initialize is None or args.retain_checkpoint is None):
        parser.error("固定特征的残差训练必须提供已验证初始权重及同一保留基线")
    if args.classifier_adapter and (not args.static_images or not args.product_validation):
        parser.error("两头残差训练必须同时提供已隔离的静态视图及最终修复验证")
    if args.static_images and not args.external_datasets:
        parser.error("停笔静态视图必须同时提供全部外部监督来源")
    if args.product_validation and not args.classifier_adapter:
        parser.error("逐样本产品保留验证必须与固定特征残差训练同时启用")
    if args.product_validation and not args.static_images:
        parser.error("产品回放必须使用已隔离的停笔静态视图")
    if args.classifier_adapter and args.initialize.resolve() != args.retain_checkpoint.resolve():
        parser.error("零残差的初始权重与保留基线必须一致")
    if not math.isfinite(args.contour_weight) or args.contour_weight < 0:
        parser.error("轮廓一致性权重必须为非负有限数")
    model, loaders, device, metadata, teacher = configure(args)
    args.output.mkdir(parents=True)
    write_json(args.output / "run.json", metadata)
    write_json(args.output / "status.json", {"state": "training", "last_epoch": 0})
    try:
        result = fit(model, loaders, device, args, metadata, teacher)
        write_json(args.output / "metrics.json", result)
        write_json(args.output / "status.json", result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
    except BaseException as error:
        write_json(args.output / "status.json", {"state": "failed", "error": str(error)})
        raise
