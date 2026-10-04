"""官方字符代码、采集作者身份和保守几何负例映射契约。"""

import re

from ..classification.schema import content_hash

VERSION = "chinese-handwriting-negatives-v1"
CHARACTERS = tuple("零一二三四五六七八九十百千万亿")
ELIGIBLE_CHARACTERS = frozenset("零五六百万亿")
SOURCE_HASHES = {
    "Raw Dataset.7z": "cabdbf284b983d47f2c2666104577f29779cd11f9b2d1ff85345be93f7cc652f",
    "Preprocessing Code.zip": "6a729614ea13a33eeb88715f0b1ed8e71f474a5aa1a8b18ef119ebfb4f7c28f5",
    "READ ME.txt": "300fa227907074efd32c92c9ede291a984b835bea35975e09dac15838b6663ee",
    "source-metadata.json": "61c1082d372a75a77ed1e6b096666dc1c5aea36d1a15aec1170ff101f2d05370",
}
EXPECTED_IMAGES = 15000
EXPECTED_WRITERS = 100
_WRITERS = sorted(range(1, 101), key=lambda writer: content_hash(["newcastle-writer-split-v1", writer]))


def writer_split(writer: int) -> str:
    """按100个源student/suite固定哈希排序分80/10/10；全部页面和字符继承作者划分。"""
    if type(writer) is not int or not 1 <= writer <= 100:
        raise ValueError("Newcastle作者序号必须为1至100")
    rank = _WRITERS.index(writer)
    return "train" if rank < 80 else "val" if rank < 90 else "test"


def parse_member(name: str) -> tuple[int, int, int]:
    """读取官方Locate{student,page,code}.jpg身份；异常文件名或越界原始索引抛ValueError。"""
    match = re.fullmatch(r"Raw Dataset/Locate\{(\d+),(\d+),(\d+)\}\.jpg", name)
    if match is None:
        raise ValueError("中文来源成员名称非法")
    writer, page, code = map(int, match.groups())
    if not (1 <= writer <= 100 and 1 <= page <= 10 and 1 <= code <= 15):
        raise ValueError("中文作者/页面/字符代码越界")
    if name != f"Raw Dataset/Locate{{{writer},{page},{code}}}.jpg":
        raise ValueError("中文成员不能使用非规范数字身份")
    return writer, page, code


def source_identity(member: str, digest: str) -> str:
    """绑定完整原始成员与JPEG散列生成样本ID，归一化视图不会被计成新来源样本。"""
    parse_member(member)
    if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
        raise ValueError("原JPEG散列非法")
    return content_hash(["newcastle-chinese-raster-v1", member, digest])[:32]
