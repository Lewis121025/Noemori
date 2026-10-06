import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net, { type Socket } from "node:net";
import tls from "node:tls";
import { lookup } from "node:dns/promises";
import type { Proxy } from "./contract.js";

function publicAddress(address: string): boolean {
  if (net.isIP(address) === 6) {
    return /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:db8:/i.test(address);
  }
  const [a, b, c] = address.split(".").map(Number);
  return (
    a !== undefined &&
    b !== undefined &&
    c !== undefined &&
    a > 0 &&
    a < 224 &&
    a !== 10 &&
    a !== 127 &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || (b === 0 && c <= 2))) &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
    !(a === 203 && b === 0 && c === 113)
  );
}

async function target(source: string): Promise<{ url: URL; address: string }> {
  const url = new URL(source);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("浏览器仅允许无认证信息的公开 HTTP(S) URL");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
    throw new Error("浏览器目标是本地、内网或非公开地址");
  }
  const selected = addresses.find(({ address }) => net.isIP(address) === 4) || addresses[0];
  if (!selected) throw new Error("浏览器目标没有可连接地址");
  return { url, address: selected.address };
}

/**
 * 校验公开 URL；实际连接还必须使用网关解析并固定的地址。
 * @param source 请求 URL。
 * @throws 协议、认证或地址不符合公开资料范围时抛出明确原因。
 */
export async function assertPublicUrl(source: string): Promise<void> {
  await target(source);
}

/** 本次浏览器唯一网络出口，所有 HTTP 请求和 CONNECT 都在连接前校验并固定目标。 */
export type BrowserGateway = {
  url: string;
  errors: ReadonlySet<string>;
  close(): Promise<void>;
};

function authorization(proxy: Proxy): string | undefined {
  if (proxy.username === undefined) return undefined;
  return `Basic ${Buffer.from(`${proxy.username}:${proxy.password || ""}`).toString("base64")}`;
}

async function connect(host: string, port: number, secure = false): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    const event = secure ? "secureConnect" : "connect";
    const failed = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", failed);
    socket.setTimeout(15_000, () => socket.destroy(new Error("浏览器网络连接超时")));
    socket.once(event, () => {
      socket.removeListener("error", failed);
      resolve(socket);
    });
  });
}

function authority(address: string, port: number): string {
  return `${net.isIP(address) === 6 ? `[${address}]` : address}:${port}`;
}

async function proxySocket(proxy: Proxy): Promise<Socket> {
  const url = new URL(proxy.server);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("浏览器网络出口仅支持 HTTP(S) 上游代理");
  return connect(
    url.hostname.replace(/^\[|\]$/g, ""),
    Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    url.protocol === "https:",
  );
}

async function tunnel(address: string, port: number, proxy?: Proxy): Promise<Socket> {
  if (!proxy) return connect(address, port);
  const socket = await proxySocket(proxy);
  try {
    return await new Promise((resolve, reject) => {
      let header = Buffer.alloc(0);
      const failed = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      const received = (chunk: Buffer) => {
        header = Buffer.concat([header, chunk]);
        if (header.length > 16_384) {
          failed(new Error("上游代理响应头超过上限"));
          return;
        }
        const end = header.indexOf("\r\n\r\n");
        if (end < 0) return;
        socket.removeListener("data", received);
        socket.removeListener("error", failed);
        const status = header.subarray(0, end).toString("latin1").split("\r\n")[0];
        if (!status?.match(/^HTTP\/1\.[01] 200(?: |$)/)) {
          failed(new Error(`上游代理 CONNECT 失败：${status}`));
          return;
        }
        const remainder = header.subarray(end + 4);
        socket.pause();
        if (remainder.length) socket.unshift(remainder);
        resolve(socket);
      };
      socket.on("data", received);
      socket.once("error", failed);
      const auth = authorization(proxy);
      socket.write(
        `CONNECT ${authority(address, port)} HTTP/1.1\r\nHost: ${authority(address, port)}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`,
      );
    });
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/** 网络连接的所有权和累计预算只属于当前读取，不跨操作共享。 */
class NetworkState {
  readonly errors = new Set<string>();
  private readonly sockets = new Set<Socket>();
  private total = 0;
  private closed = false;
  constructor(private readonly maximum: number) {}
  // 监听器关闭前仍可能接受排队连接；事件回调必须只释放资源，不能同步抛出异常。
  accept(socket: Socket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    this.track(socket);
  }
  track(socket: Socket, incoming = false): Socket {
    if (this.closed) {
      socket.destroy();
      throw new Error("浏览器网络出口已关闭");
    }
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.on("error", (error: Error) => this.errors.add(`浏览器网络失败：${error.message}`));
    if (incoming)
      socket.on("data", (chunk: Buffer) => {
        this.total += chunk.length;
        if (this.total > this.maximum) {
          this.errors.add("浏览器网络接收超过配置的字节上限");
          this.close();
        }
      });
    return socket;
  }
  close(): void {
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
  }
}

async function forwardHttp(
  request: IncomingMessage,
  response: ServerResponse,
  proxy: Proxy | undefined,
  state: NetworkState,
): Promise<void> {
  const checked = await target(request.url || "");
  if (checked.url.protocol !== "http:") throw new Error("HTTPS 请求必须使用受控 CONNECT 隧道");
  const port = Number(checked.url.port || 80);
  const httpProxy =
    proxy && ["http:", "https:"].includes(new URL(proxy.server).protocol) ? proxy : undefined;
  const socket = state.track(
    proxy ? await proxySocket(proxy) : await connect(checked.address, port),
    true,
  );
  const destination = new URL(checked.url);
  destination.hostname = net.isIP(checked.address) === 6 ? `[${checked.address}]` : checked.address;
  const headers: http.OutgoingHttpHeaders = { ...request.headers, host: checked.url.host };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  if (httpProxy) {
    const auth = authorization(httpProxy);
    if (auth) headers["proxy-authorization"] = auth;
  }
  const upstream = http.request(
    {
      method: request.method,
      path: proxy ? destination.href : checked.url.pathname + checked.url.search,
      headers,
      createConnection: () => socket,
    },
    (received) => {
      response.writeHead(received.statusCode || 502, received.headers);
      received.pipe(response);
    },
  );
  upstream.on("error", (error: Error) => {
    state.errors.add(error.message);
    response.destroy(error);
  });
  request.on("aborted", () => upstream.destroy());
  response.on("close", () => upstream.destroy());
  request.pipe(upstream);
}

async function forwardConnect(
  request: IncomingMessage,
  client: import("node:stream").Duplex,
  head: Buffer,
  proxy: Proxy | undefined,
  state: NetworkState,
): Promise<void> {
  const checked = await target(`https://${request.url || ""}`);
  const remote = state.track(
    await tunnel(checked.address, Number(checked.url.port || 443), proxy),
    true,
  );
  client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head.length) remote.write(head);
  remote.pipe(client);
  client.pipe(remote);
  remote.resume();
  client.once("close", () => remote.destroy());
  remote.once("close", () => client.destroy());
}

/**
 * 为一个匿名浏览器建立受控网络出口，关闭时释放全部连接。
 * @param proxy 宿主提供的上游代理及认证。
 * @param maximum 本次浏览器接收的网络字节上限。
 * @returns 本地出口、已发生的明确错误与关闭入口。
 * @throws 出口监听或网络配置无效时抛出明确原因。
 */
export async function createGateway(
  proxy: Proxy | undefined,
  maximum: number,
): Promise<BrowserGateway> {
  const state = new NetworkState(maximum);
  const server = http.createServer((request, response) => {
    response.on("error", (error: Error) =>
      state.errors.add(`浏览器响应转发失败：${error.message}`),
    );
    void forwardHttp(request, response, proxy, state).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      state.errors.add(reason);
      if (!response.destroyed) {
        if (!response.headersSent) response.writeHead(502);
        response.end(reason);
      }
    });
  });
  server.on("connection", (socket) => state.accept(socket));
  server.on("connect", (request, client, head) => {
    void forwardConnect(request, client, head, proxy, state).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      state.errors.add(reason);
      client.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n${reason}`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("浏览器网络出口没有有效监听地址");
  return {
    url: `http://127.0.0.1:${address.port}`,
    errors: state.errors,
    async close() {
      state.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
