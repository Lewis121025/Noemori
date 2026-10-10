import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Authentication, ModelSettings, PublicModelSettings } from "../shared/api";
import { parsePrivateJson, writePrivateJson } from "./private-json";
import {
  parseModelSelection,
  parseProviderUpdate,
  parseProviderConnection,
  type DiscoveredModel,
  type ProviderConnection,
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
import { discoverModels } from "./model-discovery";

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
   * 按对话选择读取下一轮配置；名称和未选模型修改不改变签名归属。
   * @param value 对话保存的选择；null 表示尚未选择。
   * @returns 配置及稳定连接指纹；空选择返回 null。
   * @throws 读取、解密、认证描述不一致或模型参数无效时拒绝。
   */
  async selected(value: ModelSelection | null): Promise<SelectedModel | null> {
    const selected = await this.current(value);
    if (!selected) return null;
    const parameters = modelParameters(selected);
    const authentication = this.authentication(selected.record);
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
   * 使用与私有构造一致的模型参数解析对话选择，不解密版本二的认证。
   * @param value 对话保存的选择；null 表示尚未选择。
   * @returns 公开模型配置；空选择返回 null。
   * @throws 目录引用、旧版认证或模型地址无效时拒绝。
   */
  async public(value: ModelSelection | null): Promise<PublicModelSettings | null> {
    const selected = await this.current(value);
    return selected
      ? { ...modelParameters(selected), authentication: selected.record.provider.authentication }
      : null;
  }

  /**
   * 为草稿发现模型；保留认证仅在同一供应商、同一来源的主进程中解密。
   * @param value 不含模型的连接草稿，null 认证引用已有材料。
   * @returns 接口返回的公开模型与能力，不写入配置或改变对话选择。
   * @throws 连接、保留目标、解密或模型接口失败时拒绝。
   */
  async discover(value: ProviderConnection): Promise<DiscoveredModel[]> {
    const input = parseProviderConnection(value);
    if (input.authentication === null) {
      await this.writing;
      const catalog = await this.read();
      const prior = catalog.providers.find((entry) => entry.provider.id === input.id);
      if (!prior) throw new Error("保留认证的供应商不存在");
      if (new URL(prior.provider.address.url).origin !== new URL(input.address.url).origin)
        throw new Error("接口来源已改变，请重新输入认证材料");
      input.authentication = this.authentication(prior);
    }
    return discoverModels(input);
  }

  /**
   * 接收调用时验证并复制输入，排队期间调用方的修改不改变本次保存。
   * @param value 独立供应商配置；null 认证仅保留该连接同一来源的材料。
   * @returns 保存成功后的公开目录；不会替对话选择模型。
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
      else catalog.providers.push(stored);
      const active = catalog.active;
      if (
        active?.providerId === stored.provider.id &&
        !stored.provider.models.some((model) => model.id === active.modelId)
      )
        catalog.active = null;
    });
  }

  /** 仅供旧版对话迁移读取已确认的全局选择，不解密或推断模型身份。 */
  async legacySelection(): Promise<ModelSelection | null> {
    await this.writing;
    const catalog = await this.read();
    if (!catalog.active) return null;
    const { model } = requireModelSelection(catalog, catalog.active);
    const effort = model.reasoningEffort;
    return {
      ...catalog.active,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    };
  }

  /**
   * 获取并原子更新已保存连接的完整模型目录，不选择任何模型。
   * @param id 已保存连接身份。
   * @returns 更新后的公开目录。
   * @throws 连接缺失、接口失败、连接在请求期间被修改或写盘失败时拒绝。
   */
  async refresh(id: string): Promise<ProviderCatalog> {
    await this.writing;
    const prior = (await this.read()).providers.find((entry) => entry.provider.id === id);
    if (!prior) throw new Error("供应商不存在");
    const identity = connectionIdentity(prior);
    const models = await discoverModels({
      ...prior.provider,
      authentication: this.authentication(prior),
    });
    return this.mutate((catalog) => {
      const current = catalog.providers.find((entry) => entry.provider.id === id);
      if (!current || connectionIdentity(current) !== identity)
        throw new Error("连接已改变，请重新获取模型");
      // 复用保存契约校验完整目录，避免发现结果绕过部署路径等约束。
      current.provider.models = parseProviderUpdate({
        ...current.provider,
        authentication: { type: "none" },
        models,
      }).models;
      if (
        catalog.active?.providerId === id &&
        !models.some((model) => model.id === catalog.active?.modelId)
      )
        catalog.active = null;
    });
  }

  /**
   * 删除连接与认证；引用该供应商的对话需要显式重选。
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

  private async current(value: ModelSelection | null): Promise<SelectedProvider | null> {
    const selection = value === null ? null : parseModelSelection(value);
    await this.writing;
    const catalog = await this.read();
    return selection ? requireModelSelection(catalog, selection) : null;
  }

  private authentication(stored: StoredProvider): Authentication {
    const authentication = decryptAuthentication(stored.encrypted);
    const actual = authenticationDescription(authentication),
      described = stored.provider.authentication;
    if (
      actual.type !== described.type ||
      actual.name !== described.name ||
      actual.region !== described.region ||
      actual.configured !== described.configured
    )
      throw new Error("认证描述与密文不一致");
    return authentication;
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
      await writePrivateJson(this.file, JSON.stringify({ version: 2, ...catalog }));
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

function connectionIdentity(stored: StoredProvider): string {
  return JSON.stringify([stored.provider.protocol, stored.provider.address, stored.encrypted]);
}
