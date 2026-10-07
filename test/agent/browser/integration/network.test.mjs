import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createGateway } from "../../../../modules/agent/web-runtime/dist/network.js";

test("内网授权只放行精确来源，WebSocket 升级经过同一连接校验", async () => {
  let reached = 0;
  const connections = new Set();
  const site = http.createServer();
  site.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });
  site.on("upgrade", (_request, socket) => {
    reached++;
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const allowed = [];
  const gateway = await createGateway(undefined, 1048576, allowed);
  async function upgrade(destination) {
    return new Promise((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port: new URL(gateway.url).port,
        path: destination,
        headers: { Connection: "Upgrade", Upgrade: "websocket" },
      });
      request.on("upgrade", (response, socket) => {
        socket.destroy();
        resolve(response.statusCode);
      });
      request.on("response", (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      request.on("error", reject);
      request.end();
    });
  }
  try {
    assert.equal(await upgrade(`${origin}/ws`), 502);
    assert.equal(reached, 0);
    allowed.push(origin);
    assert.equal(await upgrade(`${origin}/ws`), 101);
    assert.equal(reached, 1);
    assert.equal(await upgrade("http://127.0.0.1:1/ws"), 502);
    assert.equal(reached, 1);
  } finally {
    await gateway.close();
    for (const socket of connections) socket.destroy();
    await new Promise((resolve) => site.close(resolve));
  }
});
