"""从仓库根目录启动分类数据下载、导出及核验；不训练模型。"""

import argparse
import json
from pathlib import Path

from .acquire import acquire_quickdraw
from .generate import generate_dataset, validate_dataset


def main() -> None:
    """解析 CLI 并打印统计；来源或数据异常转换为明确的非零退出状态。"""
    parser = argparse.ArgumentParser(description="准备 Noemori 静态图形分类数据")
    commands = parser.add_subparsers(dest="command", required=True)
    acquire = commands.add_parser("acquire-quickdraw")
    acquire.add_argument("--output", type=Path, required=True)
    acquire.add_argument("--count", type=int, default=200)
    generate = commands.add_parser("generate")
    generate.add_argument("--output", type=Path, required=True)
    generate.add_argument("--references", type=Path)
    generate.add_argument("--quickdraw", type=Path)
    generate.add_argument("--groups", type=int, default=160)
    generate.add_argument("--seed", type=int, default=20261004)
    validate = commands.add_parser("validate")
    validate.add_argument("directory", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "acquire-quickdraw":
            result = acquire_quickdraw(args.output, args.count)
        elif args.command == "generate":
            result = generate_dataset(args.output, args.seed, args.groups, args.references, args.quickdraw)["counts"]
        else:
            result = validate_dataset(args.directory)
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.error(str(error))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
