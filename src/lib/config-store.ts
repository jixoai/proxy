/**
 * 配置存储模块 - 向后兼容的适配器
 * 内部使用 ProxyConfigStore 实现，对外保持原有接口
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ProxyConfigStore } from "./store/proxy-config-store";
import type { ProxyConfigFile, ProxyForwardConfig, ProxyInstanceConfig } from "../types/proxy";
import { normalizeForwardGroups } from "./forward-utils";

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "proxy-config.json");

let configFilePathOverride: string | null = null;

let store: ProxyConfigStore | null = null;

function resolveConfigFilePath(): string {
  if (configFilePathOverride) return configFilePathOverride;

  const envPath = process.env.PROXY_CONFIG_PATH;
  if (typeof envPath === "string" && envPath.trim().length > 0) {
    return path.resolve(envPath);
  }

  return DEFAULT_CONFIG_PATH;
}

function getStore(): ProxyConfigStore {
  if (!store) {
    store = new ProxyConfigStore({ filePath: resolveConfigFilePath(), createIfMissing: true });
  }
  return store;
}

export function overrideConfigFilePathForTests(filePath: string): void {
  configFilePathOverride = path.resolve(filePath);
  // Reset store to use new path
  if (store) {
    store.destroy();
    store = null;
  }
}

export function getConfigFilePath(): string {
  return getStore().getFilePath();
}

export function loadConfig(): ProxyConfigFile {
  return getStore().getData();
}

export function saveConfig(config: ProxyConfigFile): void {
  // For backward compatibility, we need to update the store's data and save
  const currentStore = getStore();

  // Update settings if provided
  if (config.settings !== undefined) {
    currentStore.updateSettings(config.settings);
  }

  // Update each instance
  const currentInstances = new Set(currentStore.getAllInstances().map((i) => i.name));
  const newInstances = new Set(config.instances.map((i) => i.name));

  // Delete removed instances
  for (const name of currentInstances) {
    if (!newInstances.has(name)) {
      currentStore.deleteInstance(name);
    }
  }

  // Upsert all new/updated instances
  for (const instance of config.instances) {
    currentStore.upsertInstance(instance);
  }
}

export function initConfigStore(): void {
  // Just ensure the store is initialized
  getStore();
  console.log(`[ConfigStore] Configuration loaded from ${getConfigFilePath()}`);
}

// ---------- Query helpers ----------

export function getAllInstances(): ProxyInstanceConfig[] {
  return getStore().getAllInstances();
}

export function getInstanceByName(name: string): ProxyInstanceConfig | null {
  return getStore().getInstanceByName(name);
}

export function upsertInstance(instance: ProxyInstanceConfig): void {
  getStore().upsertInstance(instance);
}

export function deleteInstance(name: string): boolean {
  return getStore().deleteInstance(name);
}

export function getForwardsByInstanceName(instanceName: string): ProxyForwardConfig[] {
  return getStore().getForwardsByInstanceName(instanceName);
}

/**
 * 追加一条转发规则（允许同名）。
 */
export function addForward(instanceName: string, forward: ProxyForwardConfig): void {
  getStore().addForward(instanceName, forward);
}

/**
 * 根据索引更新指定转发规则。
 */
export function updateForwardByIndex(
  instanceName: string,
  forwardIndex: number,
  forward: ProxyForwardConfig,
): void {
  getStore().updateForwardByIndex(instanceName, forwardIndex, forward);
}

/**
 * 根据索引删除转发规则。
 */
export function deleteForwardByIndex(instanceName: string, forwardIndex: number): boolean {
  return getStore().deleteForwardByIndex(instanceName, forwardIndex);
}

/**
 * 保留旧行为：按 name upsert，但不用于允许同名的场景。
 */
export function upsertForward(instanceName: string, forward: ProxyForwardConfig): void {
  const instance = getStore().getInstanceByName(instanceName);
  if (!instance) {
    throw new Error(`Instance not found: ${instanceName}`);
  }
  const forwards = instance.forwards;
  const fIdx = forwards.findIndex((f) => f.name === forward.name);
  if (fIdx >= 0) {
    getStore().updateForwardByIndex(instanceName, fIdx, forward);
  } else {
    getStore().addForward(instanceName, forward);
  }
}

export function deleteForward(instanceName: string, forwardName: string): boolean {
  const forwards = getStore().getForwardsByInstanceName(instanceName);
  const idx = forwards.findIndex((f) => f.name === forwardName);
  if (idx === -1) return false;
  return getStore().deleteForwardByIndex(instanceName, idx);
}

/**
 * 按索引顺序重排转发规则。索引基于当前顺序，调用方需确保无重复且覆盖全部。
 */
export function reorderForwardsByIndexes(instanceName: string, orderedIndexes: number[]): void {
  getStore().reorderForwardsByIndexes(instanceName, orderedIndexes);
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

// ---------- 文件监听控制 ----------

/**
 * 启用配置文件监听
 */
export function enableConfigWatch(): void {
  getStore().startWatch();
}

/**
 * 禁用配置文件监听
 */
export function disableConfigWatch(): void {
  getStore().stopWatch();
}

/**
 * 检查配置文件监听是否启用
 */
export function isConfigWatchEnabled(): boolean {
  return getStore().isWatching();
}

// ---------- Store 事件订阅 ----------

/**
 * 获取底层 Store 实例，用于订阅事件
 */
export function getProxyConfigStore(): ProxyConfigStore {
  return getStore();
}

/**
 * 订阅配置变更事件
 */
export function onConfigChange(
  callback: (event: { type: string; data: ProxyConfigFile }) => void,
): () => void {
  const store = getStore();
  store.on("change", callback);
  return () => store.off("change", callback);
}

/**
 * 订阅实例变更事件
 */
export function onInstanceChange(
  callback: (event: {
    type: "create" | "update" | "delete";
    instanceName: string;
    instance?: ProxyInstanceConfig;
  }) => void,
): () => void {
  const store = getStore();
  store.on("instance-change", callback);
  return () => store.off("instance-change", callback);
}

/**
 * 订阅转发规则变更事件
 */
export function onForwardChange(
  callback: (event: {
    type: "create" | "update" | "delete" | "reorder";
    instanceName: string;
    forwardIndex?: number;
    forward?: ProxyForwardConfig;
  }) => void,
): () => void {
  const store = getStore();
  store.on("forward-change", callback);
  return () => store.off("forward-change", callback);
}
