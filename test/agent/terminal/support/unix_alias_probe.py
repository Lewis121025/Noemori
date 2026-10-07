"""原生验收：已授权别名被宿主替换后，冻结的权限不能扩大。"""
import socket
import sys

mode, path = sys.argv[1:]
if mode == "connect":
    stream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        stream.connect(path)
        raise AssertionError("别名重定向不能授权新的目标")
    except PermissionError:
        pass
    finally:
        stream.close()
elif mode == "file":
    for access in ("r", "w"):
        try:
            with open(path, access):
                raise AssertionError("符号链接解析权限不能成为普通文件授权")
        except PermissionError:
            pass
else:
    raise AssertionError("未知模式")
print("denied")
