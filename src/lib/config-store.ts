import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { proxyConfigSchema, parseConfigFile, serializeConfigFile } from "./config-schema";
import type { ProxyConfigFile, ProxyForwardConfig, ProxyInstanceConfig } from "../types/proxy";
import { getConfigExample } from "./config-template.macro" with { type: "macro" };
import { normalizeForwardGroups } from "./forward-utils";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "proxy-config.json");

let configFilePath = process.env.PROXY_CONFIG_PATH?.length
  ? path.resolve(process.env.PROXY_CONFIG_PATH)
  : DEFAULT_CONFIG_PATH;

export function overrideConfigFilePathForTests(filePath: string) {
  configFilePath = path.resolve(filePath);
}

function ensureConfigDir(): void {
  const dir = path.dirname(configFilePath);
  fs.mkdirSync(dir, { recursive: true });
}

export function getConfigFilePath(): string {
  ensureConfigDir();
  return configFilePath;
}

export function loadConfig(): ProxyConfigFile {
  ensureConfigDir();
  if (!fs.existsSync(configFilePath)) {
    fs.writeFileSync(configFilePath, getConfigExample());
    // throw new Error(`[ConfigStore] Config file missing at ${configFilePath}`);
  }
  const content = fs.readFileSync(configFilePath, "utf-8");
  return parseConfigFile(content);
}

export function saveConfig(config: ProxyConfigFile): void {
  ensureConfigDir();
  const content = serializeConfigFile(proxyConfigSchema.parse(config));
  fs.writeFileSync(configFilePath, content, "utf-8");
}

function writeDefaultConfig(): ProxyConfigFile {
  const defaultConfig: ProxyConfigFile = {
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
  saveConfig(defaultConfig);
  return defaultConfig;
}

export function initConfigStore(): void {
  ensureConfigDir();
  if (!fs.existsSync(configFilePath)) {
    writeDefaultConfig();
    console.log(`[ConfigStore] Created configuration file at ${configFilePath}`);
    return;
  }
  // Validate existing file
  loadConfig();
}

// ---------- Query helpers ----------

export function getAllInstances(): ProxyInstanceConfig[] {
  return loadConfig().instances;
}

export function getInstanceByName(name: string): ProxyInstanceConfig | null {
  return loadConfig().instances.find((inst) => inst.name === name) ?? null;
}

export function upsertInstance(instance: ProxyInstanceConfig): void {
  const config = loadConfig();
  const idx = config.instances.findIndex((i) => i.name === instance.name);
  if (idx >= 0) {
    config.instances[idx] = instance;
  } else {
    config.instances.push(instance);
  }
  saveConfig(config);
}

export function deleteInstance(name: string): boolean {
  const config = loadConfig();
  const before = config.instances.length;
  config.instances = config.instances.filter((i) => i.name !== name);
  if (config.instances.length === before) return false;
  saveConfig(config);
  return true;
}

export function getForwardsByInstanceName(instanceName: string): ProxyForwardConfig[] {
  return getInstanceByName(instanceName)?.forwards ?? [];
}

/**
 * 追加一条转发规则（允许同名）。
 */
export function addForward(instanceName: string, forward: ProxyForwardConfig): void {
  const config = loadConfig();
  const instance = config.instances.find((i) => i.name === instanceName);
  if (!instance) {
    throw new Error(`Instance not found: ${instanceName}`);
  }
  instance.forwards.push(forward);
  saveConfig(config);
}

/**
 * 根据索引更新指定转发规则。
 */
export function updateForwardByIndex(
  instanceName: string,
  forwardIndex: number,
  forward: ProxyForwardConfig,
): void {
  const config = loadConfig();
  const instance = config.instances.find((i) => i.name === instanceName);
  if (!instance) {
    throw new Error(`Instance not found: ${instanceName}`);
  }
  if (forwardIndex < 0 || forwardIndex >= instance.forwards.length) {
    throw new Error(`Forward index out of range: ${forwardIndex}`);
  }
  instance.forwards[forwardIndex] = forward;
  saveConfig(config);
}

/**
 * 根据索引删除转发规则。
 */
export function deleteForwardByIndex(instanceName: string, forwardIndex: number): boolean {
  const config = loadConfig();
  const instance = config.instances.find((i) => i.name === instanceName);
  if (!instance) return false;
  if (forwardIndex < 0 || forwardIndex >= instance.forwards.length) return false;
  instance.forwards.splice(forwardIndex, 1);
  saveConfig(config);
  return true;
}

/**
 * 保留旧行为：按 name upsert，但不用于允许同名的场景。
 */
export function upsertForward(instanceName: string, forward: ProxyForwardConfig): void {
  const config = loadConfig();
  const idx = config.instances.findIndex((i) => i.name === instanceName);
  if (idx === -1) {
    throw new Error(`Instance not found: ${instanceName}`);
  }
  const instance = config.instances[idx];
  if (!instance) {
    throw new Error(`Instance not found: ${instanceName}`);
  }
  const forwards = instance.forwards;
  const fIdx = forwards.findIndex((f) => f.name === forward.name);
  if (fIdx >= 0) {
    forwards[fIdx] = forward;
  } else {
    forwards.push(forward);
  }
  instance.forwards = forwards;
  saveConfig(config);
}

export function deleteForward(instanceName: string, forwardName: string): boolean {
  const config = loadConfig();
  const idx = config.instances.findIndex((i) => i.name === instanceName);
  if (idx === -1) return false;
  const instance = config.instances[idx];
  if (!instance) return false;
  const forwards = instance.forwards;
  const before = forwards.length;
  instance.forwards = forwards.filter((f) => f.name !== forwardName);
  if (instance.forwards.length === before) return false;
  saveConfig(config);
  return true;
}

/**
 * 按索引顺序重排转发规则。索引基于当前顺序，调用方需确保无重复且覆盖全部。
 */
export function reorderForwardsByIndexes(instanceName: string, orderedIndexes: number[]): void {
  const config = loadConfig();
  const instIdx = config.instances.findIndex((i) => i.name === instanceName);
  if (instIdx === -1) throw new Error(`Instance not found: ${instanceName}`);
  const instance = config.instances[instIdx];
  if (!instance) throw new Error(`Instance not found: ${instanceName}`);

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
  saveConfig(config);
}

/**
 * 兼容旧接口：按名字重排。若存在同名规则，则按出现顺序依次匹配。
 */
export function reorderForwards(instanceName: string, orderedNames: string[]): void {
  const forwards = getForwardsByInstanceName(instanceName);
  if (orderedNames.length !== forwards.length) {
    throw new Error("Order must include all forwards of the instance");
  }

  const nameToIndexes = new Map<string, number[]>();
  forwards.forEach((f, idx) => {
    const list = nameToIndexes.get(f.name) ?? [];
    list.push(idx);
    nameToIndexes.set(f.name, list);
  });

  const usedCounts = new Map<string, number>();
  const indexes = orderedNames.map((name) => {
    const list = nameToIndexes.get(name);
    if (!list || list.length === 0) {
      throw new Error(`Order contains invalid forward name: ${name}`);
    }
    const used = usedCounts.get(name) ?? 0;
    if (used >= list.length) {
      throw new Error(`Order contains too many occurrences of ${name}`);
    }
    usedCounts.set(name, used + 1);
    return list[used]!;
  });

  reorderForwardsByIndexes(instanceName, indexes);
}

/**
 * 同名规则聚合并按路由长度排序，用于运行时的预处理。不会写回配置文件。
 */
export function getNormalizedForwards(instanceName: string): ProxyForwardConfig[] {
  const forwards = getForwardsByInstanceName(instanceName);
  return normalizeForwardGroups(forwards);
}
