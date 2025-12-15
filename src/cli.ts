#!/usr/bin/env bun
/**
 * Jixo Proxy CLI
 * 可视化代理服务器命令行入口
 */

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import * as path from "node:path";
import * as net from "node:net";
import { initDatabase } from "./lib/db";
import { initConfigStore, loadConfig, saveConfig, getConfigFilePath } from "./lib/config-store";
import { ProxyInstancesManager } from "./proxy-instances-manager";
import { startViewerServer } from "./viewer-server";
import {
  getVersion,
  getDataDir,
  ensureDataDir,
  clearDataDir,
  setDataDir,
  getDefaultDataDir,
} from "./lib/runtime-paths";
import openBrowser from "react-dev-utils/openBrowser";

/** 默认前端端口 */
const DEFAULT_PORT = 33000;
/** 端口递增最大尝试次数 */
const PORT_INCREMENT_MAX = 10;

/** 检查端口是否可用 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port, "127.0.0.1");
  });
}

/** 查找可用端口 */
async function findAvailablePort(startPort: number, maxIncrement: number): Promise<number> {
  // 先尝试递增端口
  for (let i = 0; i <= maxIncrement; i++) {
    const port = startPort + i;
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  // 所有递增端口都不可用，使用随机端口
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close();
      resolve(port);
    });
    server.listen(0, "127.0.0.1");
  });
}

async function main() {
  const version = getVersion();

  const argv = await yargs(hideBin(process.argv))
    .scriptName("jixo-proxy")
    .usage("$0 [options]")
    .option("port", {
      alias: "p",
      type: "number",
      description: "Web UI port",
      default: DEFAULT_PORT,
    })
    .option("config", {
      alias: "c",
      type: "string",
      description: "Config file path",
    })
    .option("clear", {
      type: "boolean",
      description: "Clear database before starting",
      default: false,
    })
    .option("open", {
      alias: "o",
      type: "boolean",
      description: "Open browser on startup (reuses existing tab if possible)",
      default: true,
    })
    .version(version)
    .alias("version", "v")
    .help()
    .alias("help", "h")
    .parseAsync();

  // 设置配置文件路径
  if (argv.config) {
    process.env.PROXY_CONFIG_PATH = path.resolve(argv.config);
  }

  // 初始化配置
  console.log("[Init] Initializing configuration store...");
  initConfigStore();

  // 加载配置并处理 dbPath
  const config = loadConfig();

  // 如果配置中没有 dbPath，添加默认值
  if (!config.settings?.dbPath) {
    const defaultDbPath = getDefaultDataDir();
    if (!config.settings) {
      config.settings = { autoWatchConfig: false, dbPath: defaultDbPath };
    } else {
      config.settings.dbPath = defaultDbPath;
    }
    saveConfig(config);
    console.log(`[Init] Set default dbPath: ${defaultDbPath}`);
  }

  // 如果配置中指定了 dbPath，使用它设置数据目录
  if (config.settings?.dbPath) {
    setDataDir(config.settings.dbPath);
  }

  // 确保数据目录存在
  ensureDataDir();

  console.log(`[Init] Jixo Proxy v${version}`);
  console.log(`[Init] Data directory: ${getDataDir()}`);
  console.log(`[Init] Config file: ${getConfigFilePath()}`);

  // 清理数据库（如果指定了 --clear）
  if (argv.clear) {
    console.log("[Init] Clearing data directory...");
    clearDataDir();
    console.log("[Init] Data directory cleared");
  }

  // 初始化数据库
  console.log("[Init] Initializing database...");
  initDatabase();

  // 创建代理实例管理器
  console.log("[Init] Creating ProxyInstancesManager...");
  const manager = new ProxyInstancesManager();

  // 自动启动已启用的实例
  await manager.autoStartEnabledInstances();

  // 查找可用端口
  let port = argv.port;
  const availablePort = await findAvailablePort(port, PORT_INCREMENT_MAX);

  if (availablePort !== port) {
    if (availablePort === 0) {
      console.log(`[Init] Ports ${port}-${port + PORT_INCREMENT_MAX} are all in use, using random port...`);
    } else if (availablePort > port + PORT_INCREMENT_MAX) {
      console.log(`[Init] Ports ${port}-${port + PORT_INCREMENT_MAX} are all in use, using random port ${availablePort}`);
    } else {
      console.log(`[Init] Port ${port} is in use, using port ${availablePort} instead`);
    }
    port = availablePort;
  }

  // 启动 Viewer Server
  console.log(`[Init] Starting Viewer Server on port ${port}...`);
  const server = startViewerServer(manager, port);

  // 打开浏览器
  if (argv.open) {
    const url = `http://localhost:${port}`;
    openBrowser(url);
  }

  // 优雅退出处理
  const shutdown = async () => {
    console.log("\n\n[Shutdown] Received shutdown signal, gracefully shutting down...");

    try {
      // 停止所有代理实例
      await manager.stopAll();

      // 关闭 Viewer Server
      console.log("[Shutdown] Stopping Viewer Server...");
      server.stop();

      console.log("[Shutdown] Shutdown complete");
      process.exit(0);
    } catch (error) {
      console.error("[Shutdown] Error during shutdown:", error);
      process.exit(1);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
