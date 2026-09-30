"""独立 CLI：获取来源、生成扩展数据和核验已有产物。"""

import argparse
import json
from pathlib import Path

from .sources import acquire_sources


def main() -> None:
    """执行扩展数据命令；用户配置和数据错误以非零退出码报告，下载失败清单保留在产物中。"""
    parser = argparse.ArgumentParser(description="Tabler 固定素材与几何合成数据")
    commands = parser.add_subparsers(dest="command", required=True)
    acquire = commands.add_parser("acquire")
    acquire.add_argument("--catalog", type=Path, required=True)
    acquire.add_argument("--output", type=Path, required=True)
    generate = commands.add_parser("generate")
    generate.add_argument("--sources", type=Path, required=True)
    generate.add_argument("--output", type=Path, required=True)
    generate.add_argument("--seed", type=int, default=20260929)
    generate.add_argument("--augmentations", type=int, default=20)
    validate = commands.add_parser("validate")
    validate.add_argument("directory", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "acquire":
            result = acquire_sources(args.catalog, args.output)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            if result["failures"]:
                parser.exit(1, "部分来源下载失败，已保存具体原因。\n")
            return
        from .generate import generate_dataset, validate_dataset
        if args.command == "generate":
            result = generate_dataset(args.sources, args.output, args.seed, args.augmentations)["counts"]
        else:
            result = validate_dataset(args.directory)
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.error(str(error))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
