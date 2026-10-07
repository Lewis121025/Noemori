"""只供原生沙箱验收；验证 Unix 连接授权与普通文件权限相互独立。"""
import socket
import sys

allowed, blocked, secret = sys.argv[1:]
for mode in ("r", "w"):
    try:
        with open(secret, mode):
            raise AssertionError("Unix 连接授权不能扩大普通文件读写权限")
    except OSError:
        pass

stream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
stream.settimeout(2)
stream.connect(allowed)
payload = bytes([0, 255, 1, 2, 128, 3])
stream.sendall(payload)
data = b""
while len(data) < len(payload):
    part = stream.recv(len(payload) - len(data))
    assert part
    data += part
assert data == payload
stream.close()

for kind in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
    stream = socket.socket(socket.AF_UNIX, kind)
    stream.settimeout(0.15)
    try:
        stream.connect(blocked)
        raise AssertionError("拒绝的 Unix socket 不能连接")
    except OSError:
        pass
    finally:
        stream.close()
print("unix")
