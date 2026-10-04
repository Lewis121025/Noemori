"""真实字符负例包命令入口。"""

import argparse
import json
from pathlib import Path

from .package import generate_dataset, validate_dataset


def main() -> None:
    """生成或完整核验字符包；来源不符、损坏或目标已存在时失败退出。"""
    parser = argparse.ArgumentParser(description="发布真实字符负样本")
    parser.add_argument("--uci-sources", type=Path)
    parser.add_argument("--kanji-sources", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--validate", type=Path)
    parser.add_argument("--kanji-per-class", type=int, default=60)
    args = parser.parse_args()
    if args.validate:
        result = validate_dataset(args.validate)
    else:
        if not all((args.uci_sources, args.kanji_sources, args.output)):
            parser.error("生成需要两个来源目录与输出目录")
        result = generate_dataset(args.uci_sources, args.kanji_sources, args.output, args.kanji_per_class)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
