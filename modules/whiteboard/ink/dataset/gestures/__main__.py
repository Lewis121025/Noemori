"""从仓库根目录执行 MMG 分类数据导出或校验；不训练模型。"""

import argparse
import json
from pathlib import Path

from .generate import generate_dataset, validate_dataset


def main() -> None:
    """解析来源/输出路径并打印统计；来源损坏、许可或数据错误转为非零退出。"""
    parser = argparse.ArgumentParser(description="导出按真实书写者隔离的MMG分类数据")
    commands = parser.add_subparsers(dest="command", required=True)
    generate = commands.add_parser("generate")
    generate.add_argument("--sources", type=Path, required=True)
    generate.add_argument("--output", type=Path, required=True)
    validate = commands.add_parser("validate")
    validate.add_argument("directory", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "generate":
            result = generate_dataset(args.sources, args.output)["counts"]
        else:
            result = validate_dataset(args.directory)
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.error(str(error))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
