"""导出和校验真实HDS栅格分类包；不会训练模型或修改原数据包。"""

import argparse
import json
from pathlib import Path

from .package import generate_dataset, validate_dataset


def main() -> None:
    """读取固定来源归档生成包，或验证已有包；数据错误返回非零状态。"""
    parser = argparse.ArgumentParser(description="准备可溯源的真实图形栅格数据")
    commands = parser.add_subparsers(dest="command", required=True)
    generate = commands.add_parser("generate-hds")
    generate.add_argument("--archive", type=Path, required=True)
    generate.add_argument("--output", type=Path, required=True)
    validate = commands.add_parser("validate")
    validate.add_argument("directory", type=Path)
    args = parser.parse_args()
    try:
        result = generate_dataset(args.archive, args.output)["counts"] if args.command == "generate-hds" else validate_dataset(args.directory)
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.error(str(error))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
