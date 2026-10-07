import { NativeAgentSession } from "@noemori/agent-node";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type {
  AgentSnapshot,
  ApprovalReply,
  ModelSettingsUpdate,
  PublicModelSettings,
  TerminalPage,
} from "../shared/api";
import { parseSnapshot, parseTerminalPage, record, text } from "../shared/parse";
import { AgentSettingsStore } from "./settings";

/** 主进程拥有全部原生会话；窗口消息只能按宿主生成的标识访问。 */
export class AgentService {
  private readonly sessions = new Map<string, NativeAgentSession>();
  private readonly settings: AgentSettingsStore;
  private stopping: Promise<void> | null = null;

  /** 创建不启动模型的服务，launcher 来自应用构建资产。 */
  constructor(
    private readonly userData: string,
    private readonly launcher: string,
    private readonly changed: (id: string) => void,
  ) {
    this.settings = new AgentSettingsStore(userData);
  }
  /** 设置读取返回无密钥投影。 */
  settingsGet(): Promise<PublicModelSettings | null> {
    return this.settings.public();
  }
  /** 主进程校验后的设置采用安全存储。 */
  settingsSet(settings: ModelSettingsUpdate): Promise<PublicModelSettings> {
    this.ensureOpen();
    return this.settings.save(settings);
  }

  /** 由窗口的文件夹选择结果创建会话，不能由模型指定工作区。 */
  async create(workspace: string): Promise<AgentSnapshot> {
    this.ensureOpen();
    const model = await this.settings.load();
    if (model === null) throw new Error("请先配置模型接口");
    this.ensureOpen();
    const root = realpathSync(workspace);
    const readable_paths = [
      join(homedir(), ".cargo"),
      join(homedir(), ".rustup"),
      join(homedir(), ".local/share/pnpm"),
    ].filter(existsSync);
    const variables: Record<string, string> = {};
    for (const name of ["CARGO_HOME", "RUSTUP_HOME"]) {
      const value = process.env[name];
      if (value && existsSync(value)) {
        readable_paths.push(realpathSync(value));
        variables[name] = value;
      }
    }
    let id = "";
    const session = new NativeAgentSession(
      JSON.stringify({
        workspace: root,
        shell: process.env["SHELL"] ?? "/bin/sh",
        launcher: this.launcher,
        model,
        browser: this.browserConfiguration(),
        permission_store: join(this.userData, "permissions.json"),
        readable_paths,
        environment: { executable_paths: [], variables },
      }),
      () => {
        if (id !== "" && this.stopping === null) this.changed(id);
      },
    );
    const snapshot = parseSnapshot(session.snapshot());
    id = snapshot.id;
    this.sessions.set(id, session);
    return snapshot;
  }
  /** 枚举当前窗口拥有的对话，包括运行中状态。 */
  list(): AgentSnapshot[] {
    return [...this.sessions.values()].map((session) => parseSnapshot(session.snapshot()));
  }
  /** 恢复窗口重载后的状态，保持独立日志游标。 */
  snapshot(id: string): AgentSnapshot {
    return parseSnapshot(this.get(id).snapshot());
  }
  /** 创建一轮任务，原生层检查占用与闭合历史。 */
  start(id: string, text: string): string {
    return this.get(id).start(text);
  }
  /** 取消生成，不自动重放工具。 */
  cancel(id: string): void {
    this.get(id).cancel();
  }
  /**
   * 接管会取消当前运行；交还仅释放控制权，不自动恢复模型执行。
   * @param id 当前窗口持有的会话标识。
   * @param resume true 表示交还，false 表示接管。
   * @returns 原生回执确认为 executed 后完成。
   * @throws 会话不存在、原生控制失败或回执未确认执行。
   */
  async browserControl(id: string, resume: boolean): Promise<void> {
    const result = record(JSON.parse(await this.get(id).browserControl(resume)));
    if (result["outcome"] !== "executed")
      throw new Error(
        typeof result["error"] === "string" ? result["error"] : "浏览器控制权未能切换",
      );
  }

  private browserConfiguration(): {
    node: string;
    worker: string;
    executable: string;
    headless: boolean;
  } {
    const directory = join(dirname(this.launcher), "browser");
    const manifest = record(JSON.parse(readFileSync(join(directory, "browser.json"), "utf8")));
    const executable = resolve(directory, text(manifest, "executable"));
    if (!existsSync(executable)) throw new Error("应用浏览器运行材料不完整，请重新构建");
    return {
      node: process.execPath,
      worker: join(directory, "browser", "main.js"),
      executable,
      headless: false,
    };
  }
  /** 决定只能作用于仍有效的申请。 */
  approve(id: string, approval: string, reply: ApprovalReply): void {
    this.get(id).approve(approval, JSON.stringify(reply));
  }
  /** 读取不消费模型输出的原始日志页。 */
  async terminalRead(id: string, terminal: string, offset: string): Promise<TerminalPage> {
    return parseTerminalPage(await this.get(id).readTerminal(terminal, offset, 8192));
  }
  /** 用户终端输入保留二进制字节，不改写为 shell 命令。 */
  terminalInput(id: string, terminal: string, data: Uint8Array): Promise<void> {
    return this.get(id).sendInput(terminal, Buffer.from(data), false);
  }
  /** 排队停止终端，终态由快照确认。 */
  terminalStop(id: string, terminal: string): void {
    this.get(id).stopTerminal(terminal);
  }
  /** 明确的宿主终端动作仍使用原生参数及权限校验。 */
  async terminalAction(id: string, arguments_: unknown): Promise<unknown> {
    return JSON.parse(await this.get(id).terminalAction(JSON.stringify(arguments_)));
  }
  /** 关闭单条对话，成功后才移除资源句柄。 */
  async close(id: string): Promise<void> {
    const session = this.get(id);
    await session.close();
    this.sessions.delete(id);
    this.changed(id);
  }
  /** 渲染器离开时取消正在等待的生成和审批，背景终端仍可在重载后恢复。 */
  detach(): void {
    for (const session of this.sessions.values()) session.cancel();
  }
  /** 窗口关闭和应用退出等待所有真实关闭结果，错误不能被吞掉。 */
  shutdown(): Promise<void> {
    if (this.stopping !== null) return this.stopping;
    const active = [...this.sessions.values()];
    this.sessions.clear();
    this.stopping = Promise.allSettled(active.map((session) => session.close())).then((results) => {
      const errors = results
        .filter((result) => result.status === "rejected")
        .map((result) => String(result.reason));
      if (errors.length > 0) throw new Error(errors.join("；"));
    });
    return this.stopping;
  }
  private ensureOpen(): void {
    if (this.stopping !== null) throw new Error("Agent 服务正在关闭");
  }
  private get(id: string): NativeAgentSession {
    this.ensureOpen();
    const session = this.sessions.get(id);
    if (!session) throw new Error("此窗口不存在该 Agent 会话");
    return session;
  }
}
