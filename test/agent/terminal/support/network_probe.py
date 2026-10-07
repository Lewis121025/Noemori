"""只供真实沙箱验收的标准库网络客户端；凭据从自己的代理环境取得，不输出凭据。"""
import base64
import http.client
import json
import os
import socket
import sys
import time
import urllib.parse


def receive(stream, size):
    result = b""
    while len(result) < size:
        piece = stream.recv(size - len(result))
        if not piece:
            raise RuntimeError("网络流提前结束")
        result += piece
    return result


def proxy():
    address = urllib.parse.urlsplit(os.environ["HTTP_PROXY"])
    credential = f"{address.username}:{address.password}".encode()
    return address, "Basic " + base64.b64encode(credential).decode()


def headers(stream):
    data = b""
    while not data.endswith(b"\r\n\r\n"):
        data += receive(stream, 1)
        if len(data) > 32768:
            raise RuntimeError("代理响应标头超预算")
    return data


mode = sys.argv[1]
if mode in ("socks", "udp", "udp-denied"):
    address, _ = proxy()
    stream = socket.create_connection((address.hostname, address.port), timeout=5)
    stream.sendall(b"\x05\x01\x02")
    assert receive(stream, 2) == b"\x05\x02"
    user, password = address.username.encode(), address.password.encode()
    stream.sendall(bytes([1, len(user)]) + user + bytes([len(password)]) + password)
    assert receive(stream, 2) == b"\x01\x00"
    port = int(sys.argv[2])
    if mode in ("udp", "udp-denied"):
        datagrams = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        datagrams.connect((address.hostname, address.port))
        local_port = datagrams.getsockname()[1]
        stream.sendall(b"\x05\x03\x00\x01\x7f\x00\x00\x01" + local_port.to_bytes(2, "big"))
        reply = receive(stream, 10)
        assert reply[:2] == b"\x05\x00", reply
        datagrams.connect((socket.inet_ntoa(reply[4:8]), int.from_bytes(reply[8:10], "big")))
        datagrams.settimeout(5)
        payload = bytes.fromhex(sys.argv[3])
        packet = b"\x00\x00\x00\x01\x7f\x00\x00\x01" + port.to_bytes(2, "big") + payload
        unauthorized = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        unauthorized.connect((address.hostname, address.port))
        unauthorized.settimeout(0.15)
        unauthorized.send(packet)
        try:
            unauthorized.recv(65535)
            raise AssertionError("未认证来源不能借用其他 UDP 关联")
        except socket.timeout:
            pass
        unauthorized.close()
        datagrams.settimeout(0.15)
        fragmented = packet[:2] + b"\x01" + packet[3:]
        datagrams.send(fragmented)
        try:
            datagrams.recv(65535)
            raise AssertionError("分片不能绕过完整目标检查")
        except socket.timeout:
            pass
        if len(sys.argv) > 4:
            blocked_port = int(sys.argv[4])
            datagrams.send(packet[:8] + blocked_port.to_bytes(2, "big") + payload)
            try:
                datagrams.recv(65535)
                raise AssertionError("未获准 UDP 目标不能得到响应")
            except socket.timeout:
                pass
        datagrams.settimeout(5)
        datagrams.send(packet)
        if mode == "udp-denied":
            datagrams.settimeout(0.15)
            try:
                datagrams.recv(65535)
                raise AssertionError("不支持 UDP 的上游不能回退为直连")
            except socket.timeout:
                pass
            stream.close()
            datagrams.close()
            print(mode)
            sys.exit(0)
        response = datagrams.recv(65535)
        assert response[:10] == packet[:10]
        assert response[10:] == payload
        stream.close()
        time.sleep(0.1)
        datagrams.settimeout(0.15)
        datagrams.send(packet)
        try:
            datagrams.recv(65535)
            raise AssertionError("控制连接关闭后不能继续转发数据报")
        except socket.timeout:
            pass
        datagrams.close()
        print("udp")
        sys.exit(0)
    stream.sendall(b"\x05\x01\x00\x01\x7f\x00\x00\x01" + port.to_bytes(2, "big"))
    assert receive(stream, 10)[:2] == b"\x05\x00"
    payload = bytes.fromhex(sys.argv[3])
    stream.sendall(payload)
    assert receive(stream, len(payload)) == payload
    print("socks")
    stream.close()
elif mode in ("connect", "websocket"):
    address, credential = proxy()
    stream = socket.create_connection((address.hostname, address.port), timeout=5)
    port = int(sys.argv[2])
    if mode == "connect":
        request = f"CONNECT 127.0.0.1:{port} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nProxy-Authorization: {credential}\r\n\r\n"
        stream.sendall(request.encode())
        assert headers(stream).startswith(b"HTTP/1.1 200")
        payload = bytes.fromhex(sys.argv[3])
        stream.sendall(payload)
        assert receive(stream, len(payload)) == payload
    else:
        request = f"GET http://127.0.0.1:{port}/ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nProxy-Authorization: {credential}\r\n\r\n"
        stream.sendall(request.encode())
        assert headers(stream).startswith(b"HTTP/1.1 101")
        assert receive(stream, 5) == b"early"
        stream.sendall(b"later")
        assert receive(stream, 5) == b"later"
    print(mode)
    stream.close()
elif mode == "reuse":
    address, credential = proxy()
    client = http.client.HTTPConnection(address.hostname, address.port, timeout=5)
    client.request("GET", f"http://127.0.0.1:{sys.argv[2]}/allowed", headers={"Proxy-Authorization": credential})
    response = client.getresponse()
    assert response.status == 200
    assert response.read() == b"allowed"
    first_socket = client.sock
    client.request("GET", f"http://127.0.0.1:{sys.argv[3]}/blocked", headers={"Proxy-Authorization": credential})
    response = client.getresponse()
    assert response.status == 403
    response.read()
    assert client.sock is first_socket
    print("reuse")
    client.close()
elif mode == "bypass":
    outcomes = {}
    for label, family, kind, destination in [
        ("tcp4", socket.AF_INET, socket.SOCK_STREAM, ("127.0.0.1", int(sys.argv[2]))),
        ("tcp6", socket.AF_INET6, socket.SOCK_STREAM, ("::1", int(sys.argv[2]))),
        ("unix", socket.AF_UNIX, socket.SOCK_STREAM, "host.sock"),
    ]:
        stream = None
        try:
            stream = socket.socket(family, kind)
            stream.settimeout(1)
            stream.connect(destination)
            outcomes[label] = "connected"
        except OSError as error:
            outcomes[label] = error.errno
        finally:
            if stream is not None:
                stream.close()
    try:
        first, second = socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)
        first.connect("host-datagram.sock")
        first.send(b"escaped")
        outcomes["unix-pair"] = "connected"
        first.close()
        second.close()
    except OSError as error:
        outcomes["unix-pair"] = error.errno
    assert all(value != "connected" for value in outcomes.values()), outcomes
    if sys.platform.startswith("linux"):
        import asyncio
        asyncio.run(asyncio.sleep(0))
    print(json.dumps(outcomes))
else:
    raise RuntimeError("未知验收模式")
