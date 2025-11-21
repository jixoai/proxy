import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { proxyConfigSchema, parseConfigFile, serializeConfigFile } from "./config-schema";
import type { ProxyConfigFile, ProxyForwardConfig, ProxyInstanceConfig } from "../types/proxy";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_CONFIG_DIR = path.join(__dirname, "../../config");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_CONFIG_DIR, "proxy-config.json");

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
    throw new Error(`[ConfigStore] Config file missing at ${configFilePath}`);
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

export function reorderForwards(instanceName: string, orderedNames: string[]): void {
  const config = loadConfig();
  const instIdx = config.instances.findIndex((i) => i.name === instanceName);
  if (instIdx === -1) throw new Error(`Instance not found: ${instanceName}`);
  const instance = config.instances[instIdx];
  if (!instance) throw new Error(`Instance not found: ${instanceName}`);
  const forwards = instance.forwards;
  if (orderedNames.length !== forwards.length) {
    throw new Error("Order must include all forwards of the instance");
  }
  const nameSet = new Set(forwards.map((f) => f.name));
  if (!orderedNames.every((n) => nameSet.has(n))) {
    throw new Error("Order contains invalid forward names");
  }
  instance.forwards = orderedNames.map(
    (name) => forwards.find((f) => f.name === name)!,
  );
  saveConfig(config);
}
