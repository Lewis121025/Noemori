import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createGateway } from "../../../../modules/agent/web-runtime/dist/network.js";

function connectThrough(gateway, destination) {
  const url = new URL(gateway.url);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      method: "CONNECT",
      path: destination,
    });
    request.once("connect", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode);
    });
    request.once("response", (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
}

test("CONNECT 在连接前拒绝内网，公开隧道保留上游认证并使用固定地址", async () => {
  const destinations = [];
  const sockets = new Set();
  const proxy = http.createServer();
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  proxy.on("connect", (request, socket) => {
    destinations.push({ url: request.url, auth: request.headers["proxy-authorization"] });
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const gateway = await createGateway(
    {
      server: `http://127.0.0.1:${proxy.address().port}`,
      username: "tester",
      password: "fixture:password",
    },
    1024 * 1024,
  );
  try {
    assert.equal(await connectThrough(gateway, "127.0.0.1:443"), 502);
    assert.equal(destinations.length, 0);
    assert.equal(await connectThrough(gateway, "93.184.215.14:443"), 200);
    assert.deepEqual(destinations, [
      {
        url: "93.184.215.14:443",
        auth: `Basic ${Buffer.from("tester:fixture:password").toString("base64")}`,
      },
    ]);
    assert.match([...gateway.errors].join("；"), /非公开/);
  } finally {
    await gateway.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => proxy.close(resolve));
  }
});

test("网络预算耗尽后到达的新连接被关闭，不能让辅助进程抛出未捕获异常", async () => {
  const proxy = http.createServer((_, response) => response.end("超过一字节的受控内容"));
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const gateway = await createGateway({ server: `http://127.0.0.1:${proxy.address().port}` }, 1);
  const url = new URL(gateway.url);
  try {
    await new Promise((resolve) => {
      const request = http.get(
        { hostname: url.hostname, port: url.port, path: "http://93.184.215.14/" },
        (response) => {
          response.resume();
          response.once("close", resolve);
        },
      );
      request.once("error", resolve);
    });
    assert.match([...gateway.errors].join("；"), /超过配置的字节上限/);
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host: url.hostname, port: url.port });
      socket.setTimeout(1000, () => socket.destroy(new Error("预算耗尽后连接未关闭")));
      socket.once("error", reject);
      socket.once("close", resolve);
    });
  } finally {
    await gateway.close();
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
});
