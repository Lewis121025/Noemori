import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ModelSettings, PublicModelSettings } from "../shared/api";
import { parsePrivateJson } from "./private-json";
import {
  parseModelSelection,
  parseProviderUpdate,
  type ModelSelection,
  type ProviderCatalog,
  type ProviderUpdate,
} from "../shared/providers";
import {
  authenticationDescription,
  decryptAuthentication,
  encryptAuthentication,
} from "./settings";
import {
  modelParameters,
  parseStoredCatalog,
  projectCatalog,
  requireModelSelection,
  type SelectedProvider,
  type StoredCatalog,
  type StoredProvider,
} from "./provider-catalog";

/** 每轮开始时读取的私有配置；binding 是连接与模型的指纹，不含认证原文或密文。 */
export type SelectedModel = { settings: ModelSettings; binding: string };

/** 全局目录通过串行原子替换提交；解码与选择引用的约束由目录契约统一处理。 */
export class AgentProviderStore {
  private readonly file: string;
  private writing: Promise<void> = Promise.resolve();
  /**
   * @param directory 应用私有数据目录；构造时不读写文件，也不解密。
   */
  constructor(private readonly directory: string) {
    this.file = join(directory, "agent-model.json");
  }

  /**
   * 等待此前变更后读取界面目录，版本二无需系统解密即可读取。
   * @returns 无密钥投影；尚无配置时返回空目录。
   * @throws 文件、目录契约或旧版认证解码失败时拒绝。
   */
  async catalog(): Promise<ProviderCatalog> {
    await this.writing;
    return projectCatalog(await this.read());
  }

  /**
   * 为下一轮读取最新配置；名称和未选模型修改不改变签名归属。
   * @returns 配置及稳定连接指纹；空选择返回 null。
   * @throws 读取、解密、认证描述不一致或模型参数无效时拒绝。
   */
  async selected(): Promise<SelectedModel | null> {
    const selected = await this.current();
    if (!selected) return null;
    const parameters = modelParameters(selected);
    const authentication = decryptAuthentication(selected.record.encrypted);
    const actual = authenticationDescription(authentication),
      described = selected.record.provider.authentication;
    if (
      actual.type !== described.type ||
      actual.name !== described.name ||
      actual.region !== described.region ||
      actual.configured !== described.configured
    )
      throw new Error("认证描述与密文不一致");
    // 绑定实际路由与认证材料，不能让磁盘修订号或无关编辑决定供应商签名的归属。
    const binding = createHash("sha256")
      .update(
        JSON.stringify([
          selected.record.provider.id,
          parameters.protocol,
          parameters.endpoint,
          parameters.model,
          selected.record.encrypted,
        ]),
      )
      .digest("hex");
    return { settings: { ...parameters, authentication }, binding };
  }

  /**
   * 使用与私有构造一致的模型参数返回默认配置，不解密版本二的认证。
   * @returns 公开默认配置；空选择返回 null。
   * @throws 目录引用、旧版认证或模型地址无效时拒绝。
   */
  async public(): Promise<PublicModelSettings | null> {
    const selected = await this.current();
    return selected
      ? { ...modelParameters(selected), authentication: selected.record.provider.authentication }
      : null;
  }

  /**
   * 接收调用时验证并复制输入，排队期间调用方的修改不改变本次保存。
   * @param value 独立供应商配置；null 认证仅保留该连接同一来源的材料。
   * @returns 保存成功后的公开目录；首次添加自动选择首个模型。
   * @throws 输入、保留认证目标、加密或写盘失败时拒绝并保持旧文件。
   */
  async save(value: ProviderUpdate): Promise<ProviderCatalog> {
    const input = parseProviderUpdate(value);
    return this.mutate((catalog) => {
      const prior = catalog.providers.find((entry) => entry.provider.id === input.id);
      if (input.id !== null && !prior) throw new Error("供应商不存在，请重新加载");
      if (!prior && catalog.providers.length >= 128) throw new Error("最多保存 128 个供应商");
      let encrypted: string | null;
      let authentication: PublicModelSettings["authentication"];
      if (input.authentication === null) {
        if (!prior) throw new Error("保留认证的供应商不存在");
        if (new URL(prior.provider.address.url).origin !== new URL(input.address.url).origin)
          throw new Error("接口来源已改变，请重新输入认证材料");
        encrypted = prior.encrypted;
        authentication = prior.provider.authentication;
      } else {
        encrypted = encryptAuthentication(input.authentication);
        authentication = authenticationDescription(input.authentication);
      }
      const id = input.id;
      const stored: StoredProvider = {
        provider: {
          id: id ?? randomUUID(),
          name: input.name,
          protocol: input.protocol,
          address: input.address,
          models: input.models,
          authentication,
        },
        encrypted,
      };
      if (prior) catalog.providers[catalog.providers.indexOf(prior)] = stored;
      else {
        if (catalog.providers.length === 0)
          catalog.active = {
            providerId: stored.provider.id,
            modelId: stored.provider.models[0].id,
          };
        catalog.providers.push(stored);
      }
      const active = catalog.active;
      if (
        active?.providerId === stored.provider.id &&
        !stored.provider.models.some((model) => model.id === active.modelId)
      )
        catalog.active = null;
    });
  }

  /**
   * 接收时固定选择身份，只有保存成功的模型才能成为全局默认。
   * @param value 用户确认的供应商与模型。
   * @returns 选择提交后的公开目录。
   * @throws 选择无效、引用缺失或写盘失败时拒绝，不选择替代目标。
   */
  async select(value: ModelSelection): Promise<ProviderCatalog> {
    const selection = parseModelSelection(value);
    return this.mutate((catalog) => {
      requireModelSelection(catalog, selection);
      catalog.active = selection;
    });
  }

  /**
   * 删除连接与认证；删除当前默认供应商后等待用户重新选择。
   * @param id 已保存供应商身份。
   * @returns 删除提交后的公开目录。
   * @throws 供应商不存在或写盘失败时拒绝；不会删除会话历史。
   */
  remove(id: string): Promise<ProviderCatalog> {
    return this.mutate((catalog) => {
      if (!catalog.providers.some((entry) => entry.provider.id === id))
        throw new Error("供应商不存在");
      catalog.providers = catalog.providers.filter((entry) => entry.provider.id !== id);
      if (catalog.active?.providerId === id) catalog.active = null;
    });
  }

  /** 等待已接收操作结算；返回队列完成 Promise，操作失败由原调用 Promise 交付。 */
  flush(): Promise<void> {
    return this.writing;
  }

  private async current(): Promise<SelectedProvider | null> {
    await this.writing;
    const catalog = await this.read();
    return catalog.active ? requireModelSelection(catalog, catalog.active) : null;
  }

  private async read(): Promise<StoredCatalog> {
    let content: string;
    try {
      content = await readFile(this.file, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { providers: [], active: null };
      throw error;
    }
    return parseStoredCatalog(parsePrivateJson(content, "供应商配置"));
  }

  private mutate(change: (catalog: StoredCatalog) => void): Promise<ProviderCatalog> {
    const operation = this.writing.then(async () => {
      const catalog = await this.read();
      change(catalog);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = join(this.directory, `.agent-model-${randomUUID()}`);
      try {
        await writeFile(temporary, JSON.stringify({ version: 2, ...catalog }), {
          flag: "wx",
          mode: 0o600,
        });
        await rename(temporary, this.file);
      } finally {
        await rm(temporary, { force: true });
      }
      return projectCatalog(catalog);
    });
    // 队列恢复仅用于后续操作排序；原调用的拒绝仍完整交付，不能吞掉保存错误。
    this.writing = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
