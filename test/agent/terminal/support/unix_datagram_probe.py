"""Unix 数据报验收：仅私有回复路径可绑定，远端仍须通过路径名单。"""
import os
import socket
import sys

allowed, blocked = sys.argv[1:]
source = os.path.join(os.environ["TMPDIR"], "client.sock")
client = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
client.settimeout(2)
client.bind(source)
client.connect(allowed)
payload = bytes([0, 255, 1, 2, 128, 3])
client.send(payload)
assert client.recv(65535) == payload
try:
    client.connect(blocked)
    raise AssertionError("拒绝目标不能获得数据报授权")
except PermissionError:
    pass
finally:
    client.close()
    os.unlink(source)

unapproved = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
try:
    unapproved.bind("unapproved.sock")
    raise AssertionError("Unix 目标授权不能开放工作区监听路径")
except PermissionError:
    pass
finally:
    unapproved.close()
print("unix-datagram")
