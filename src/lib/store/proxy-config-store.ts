import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { BaseStore, type StoreOptions, type StoreChangeEvent } from "./base-store";
import { proxyConfigSchema, parseConfigFile, serializeConfigFile } from "../config-schema";
import type { ProxyConfigFile, ProxyInstanceConfig, ProxyForwardConfig } from "../../types/proxy";
import { getConfigExample } from "../config-template.macro" with { type: "macro" };

/** 生成 UUID */
function generateUUID(): string {
  return crypto.randomUUID();
}

/**
 * 确保所有 forwards 都有唯一的 id
 * - 为没有 id 的 forward 生成 UUID
 * - 处理 id 冲突：重复的 id 会被新 UUID 覆盖
 */
function ensureForwardIds(config: ProxyConfigFile): ProxyConfigFile {
  const usedIds = new Set<string>();

  for (const instance of config.instances) {
    for (const forward of instance.forwards) {
      if (!forward.id || usedIds.has(forward.id)) {
        // 没有 id 或 id 冲突，生成新的
        forward.id = generateUUID();
      }
      usedIds.add(forward.id);
    }
  }

  return config;
}

export interface InstanceChangeEvent {
  type: "create" | "update" | "delete";
  instanceName: string;
  instance?: ProxyInstanceConfig;
  previousInstance?: ProxyInstanceConfig;
}

export interface ForwardChangeEvent {
  type: "create" | "update" | "delete" | "reorder";
  instanceName: string;
  forwardIndex?: number;
  forward?: ProxyForwardConfig;
  previousForward?: ProxyForwardConfig;
}

export interface ProxyConfigStoreOptions extends StoreOptions {
  /** 配置文件路径 */
  filePath?: string;
  /** 是否在文件不存在时创建默认配置 */
  createIfMissing?: boolean;
}

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "proxy-config.json");

/**
 * 代理配置 Store
 * 管理 proxy-config.json 的读写和监听
 */
export class ProxyConfigStore extends BaseStore<ProxyConfigFile> {
  private static instance: ProxyConfigStore | null = null;
  private readonly createIfMissing: boolean;

  constructor(options: ProxyConfigStoreOptions = {}) {
    const filePath = options.filePath ?? process.env.PROXY_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
    const resolvedPath = path.resolve(filePath);

    // 确保目录存在
    const dir = path.dirname(resolvedPath);
    fs.mkdirSync(dir, { recursive: true });

    // 加载或创建初始配置
    let initialData: ProxyConfigFile;
    const createIfMissing = options.createIfMissing ?? true;
    let needsSave = false;

    if (fs.existsSync(resolvedPath)) {
      const content = fs.readFileSync(resolvedPath, "utf-8");
      const parsed = parseConfigFile(content);
      const beforeEnsureIds = JSON.stringify(parsed);
      // 确保所有 forwards 都有 id
      initialData = ensureForwardIds(parsed);
      // 检查是否有变更（生成了新 id）
      needsSave = beforeEnsureIds !== JSON.stringify(initialData);
    } else if (createIfMissing) {
      initialData = ensureForwardIds(ProxyConfigStore.createDefaultConfig());
      needsSave = true;
    } else {
      throw new Error(`Config file not found: ${resolvedPath}`);
    }

    super(initialData, resolvedPath, options);
    this.createIfMissing = createIfMissing;

    // 如果有新生成的 id，保存到文件
    if (needsSave) {
      this.saveToFileSync();
    }
  }

  /** 获取单例实例 */
  static getInstance(options?: ProxyConfigStoreOptions): ProxyConfigStore {
    if (!ProxyConfigStore.instance) {
      ProxyConfigStore.instance = new ProxyConfigStore(options);
    }
    return ProxyConfigStore.instance;
  }

  /** 重置单例（用于测试） */
  static resetInstance(): void {
    if (ProxyConfigStore.instance) {
      ProxyConfigStore.instance.destroy();
      ProxyConfigStore.instance = null;
    }
  }

  /** 创建默认配置 */
  private static createDefaultConfig(): ProxyConfigFile {
    return {
      instances: [
        {
          name: "AI",
          port: 27890,
          enabled: true,
          description: "默认创建的代理实例，可根据需要修改或删除",
          headers: null,
          forwards: [
            {
              name: "example",
              enabled: true,
              target: "https://httpbin.org",
              description: "示例转发规则，可作为配置参考",
              path: null,
              methods: ["*"],
              headers: {
                "X-Proxy-By": "Claude Code Proxy",
              },
            },
          ],
        },
      ],
    };
  }

  /** 获取配置文件路径 */
  getFilePath(): string {
    return this.filePath!;
  }

  /** 保存配置前确保所有 forwards 都有 id */
  private saveWithIds(config: ProxyConfigFile, changeType: "create" | "update" | "delete"): void {
    const configWithIds = ensureForwardIds(config);
    this.setData(configWithIds, changeType);
    this.saveToFileSync();
  }

  // ========== Instance 操作 ==========

  /** 获取所有实例 */
  getAllInstances(): ProxyInstanceConfig[] {
    return this.data.instances.map((i) => ({ ...i, forwards: [...i.forwards] }));
  }

  /** 根据名称获取实例 */
  getInstanceByName(name: string): ProxyInstanceConfig | null {
    const instance = this.data.instances.find((i) => i.name === name);
    return instance ? { ...instance, forwards: [...instance.forwards] } : null;
  }

  /** 创建或更新实例 */
  upsertInstance(instance: ProxyInstanceConfig): void {
    const config = this.cloneData(this.data);
    const idx = config.instances.findIndex((i) => i.name === instance.name);
    const previousInstance = idx >= 0 ? config.instances[idx] : undefined;

    if (idx >= 0) {
      config.instances[idx] = instance;
    } else {
      config.instances.push(instance);
    }

    this.saveWithIds(config, idx >= 0 ? "update" : "create");

    const event: InstanceChangeEvent = {
      type: idx >= 0 ? "update" : "create",
      instanceName: instance.name,
      instance,
      previousInstance,
    };
    this.emit("instance-change", event);
  }

  /** 删除实例 */
  deleteInstance(name: string): boolean {
    const config = this.cloneData(this.data);
    const idx = config.instances.findIndex((i) => i.name === name);
    if (idx === -1) return false;

    const previousInstance = config.instances[idx];
    config.instances.splice(idx, 1);

    this.saveWithIds(config, "delete");

    const event: InstanceChangeEvent = {
      type: "delete",
      instanceName: name,
      previousInstance,
    };
    this.emit("instance-change", event);

    return true;
  }

  // ========== Settings 操作 ==========

  /** 获取全局设置 */
  getSettings(): ProxyConfigFile["settings"] {
    return this.data.settings ? { ...this.data.settings } : undefined;
  }

  /** 更新全局设置 */
  updateSettings(settings: ProxyConfigFile["settings"]): void {
    const config = this.cloneData(this.data);
    config.settings = settings;
    this.saveWithIds(config, "update");
  }

  // ========== Forward 操作 ==========

  /** 获取实例的所有转发规则 */
  getForwardsByInstanceName(instanceName: string): ProxyForwardConfig[] {
    const instance = this.data.instances.find((i) => i.name === instanceName);
    return instance ? [...instance.forwards] : [];
  }

  /** 添加转发规则 */
  addForward(instanceName: string, forward: ProxyForwardConfig): void {
    const config = this.cloneData(this.data);
    const instance = config.instances.find((i) => i.name === instanceName);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceName}`);
    }

    instance.forwards.push(forward);
    this.saveWithIds(config, "update");

    // 获取保存后的 forward（可能已生成 id）
    const savedInstance = this.data.instances.find((i) => i.name === instanceName);
    const savedForward = savedInstance?.forwards[savedInstance.forwards.length - 1];

    const event: ForwardChangeEvent = {
      type: "create",
      instanceName,
      forwardIndex: instance.forwards.length - 1,
      forward: savedForward ?? forward,
    };
    this.emit("forward-change", event);
  }

  /** 更新指定索引的转发规则 */
  updateForwardByIndex(
    instanceName: string,
    forwardIndex: number,
    forward: ProxyForwardConfig,
  ): void {
    const config = this.cloneData(this.data);
    const instance = config.instances.find((i) => i.name === instanceName);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceName}`);
    }
    if (forwardIndex < 0 || forwardIndex >= instance.forwards.length) {
      throw new Error(`Forward index out of range: ${forwardIndex}`);
    }

    const previousForward = instance.forwards[forwardIndex];
    // 保留原有的 id（如果更新的 forward 没有提供 id）
    if (!forward.id && previousForward?.id) {
      forward.id = previousForward.id;
    }
    instance.forwards[forwardIndex] = forward;

    this.saveWithIds(config, "update");

    const event: ForwardChangeEvent = {
      type: "update",
      instanceName,
      forwardIndex,
      forward,
      previousForward,
    };
    this.emit("forward-change", event);
  }

  /** 删除指定索引的转发规则 */
  deleteForwardByIndex(instanceName: string, forwardIndex: number): boolean {
    const config = this.cloneData(this.data);
    const instance = config.instances.find((i) => i.name === instanceName);
    if (!instance) return false;
    if (forwardIndex < 0 || forwardIndex >= instance.forwards.length) return false;

    const previousForward = instance.forwards[forwardIndex];
    instance.forwards.splice(forwardIndex, 1);

    this.saveWithIds(config, "update");

    const event: ForwardChangeEvent = {
      type: "delete",
      instanceName,
      forwardIndex,
      previousForward,
    };
    this.emit("forward-change", event);

    return true;
  }

  /** 重排转发规则 */
  reorderForwardsByIndexes(instanceName: string, orderedIndexes: number[]): void {
    const config = this.cloneData(this.data);
    const instance = config.instances.find((i) => i.name === instanceName);
    if (!instance) {
      throw new Error(`Instance not found: ${instanceName}`);
    }

    const forwards = instance.forwards;
    if (orderedIndexes.length !== forwards.length) {
      throw new Error("Order must include all forwards of the instance");
    }

    const unique = new Set(orderedIndexes);
    if (unique.size !== orderedIndexes.length) {
      throw new Error("Order contains duplicate indexes");
    }
    if ([...unique].some((idx) => idx < 0 || idx >= forwards.length)) {
      throw new Error("Order contains invalid forward indexes");
    }

    instance.forwards = orderedIndexes.map((idx) => forwards[idx]!);

    this.saveWithIds(config, "update");

    const event: ForwardChangeEvent = {
      type: "reorder",
      instanceName,
    };
    this.emit("forward-change", event);
  }

  // ========== BaseStore 抽象方法实现 ==========

  protected parseFileContent(content: string): ProxyConfigFile {
    return parseConfigFile(content);
  }

  protected serializeData(data: ProxyConfigFile): string {
    return serializeConfigFile(proxyConfigSchema.parse(data));
  }

  protected cloneData(data: ProxyConfigFile): ProxyConfigFile {
    return JSON.parse(JSON.stringify(data));
  }

  protected isDataEqual(a: ProxyConfigFile, b: ProxyConfigFile): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }
}
