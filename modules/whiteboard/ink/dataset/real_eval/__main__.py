"""独立真实整图评测集的获取与校验入口。"""

import argparse
import json
from pathlib import Path
import xml.etree.ElementTree as ET

from .package import acquire_dataset, validate_dataset


def main() -> None:
    """从固定公开来源获取或验证评测包；失败以非零状态退出并保留既有目录。"""
    parser = argparse.ArgumentParser(description="获取真实草图的多参考整图清理评测集")
    commands = parser.add_subparsers(dest="command", required=True)
    acquire = commands.add_parser("acquire")
    acquire.add_argument("--output", type=Path, required=True)
    validate = commands.add_parser("validate")
    validate.add_argument("directory", type=Path)
    args = parser.parse_args()
    try:
        result = (acquire_dataset(args.output)["counts"] if args.command == "acquire"
                  else validate_dataset(args.directory))
    except (OSError, ValueError, KeyError, TypeError, ET.ParseError) as error:
        parser.error(str(error))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
