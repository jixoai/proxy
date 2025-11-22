import { parseArgs } from "node:util";
import { initDatabase } from "./lib/db";
import { initConfigStore } from "./lib/config-store";
import { ProxyInstancesManager } from "./proxy-instances-manager";
import { startViewerServer } from "./viewer-server";
import { killPort } from "./lib/kill-port";

const args = parseArgs({
  options: {
    port: {
      type: "string",
      short: "p",
      default: "3001",
    },
  },
});

const PORT = parseInt(args.values.port!);

// 初始化数据库
console.log("[Init] Initializing database...");
initDatabase();

console.log("[Init] Initializing configuration store...");
initConfigStore();

// 创建代理实例管理器
console.log("[Init] Creating ProxyInstancesManager...");
const manager = new ProxyInstancesManager();

// 自动启动已启用的实例
await manager.autoStartEnabledInstances();

// 启动 Viewer Server
console.log(`[Init] Starting Viewer Server on port ${PORT}...`);
// killPort(PORT);
const server = startViewerServer(manager, PORT);

// 优雅退出处理
const shutdown = async () => {
  console.log(
    "\n\n[Shutdown] Received shutdown signal, gracefully shutting down...",
  );

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
