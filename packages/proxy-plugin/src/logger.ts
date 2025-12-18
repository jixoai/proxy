/**
 * 插件日志工具
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface PluginLogger {
  /** 记录调试信息到控制台 */
  debug(...args: unknown[]): void;
  /** 记录信息到控制台 */
  info(...args: unknown[]): void;
  /** 记录警告到控制台 */
  warn(...args: unknown[]): void;
  /** 记录错误到控制台 */
  error(...args: unknown[]): void;
  /** 记录数据到文件 */
  logToFile(prefix: string, data: unknown): void;
}

export interface LoggerOptions {
  /** 插件名称 */
  name: string;
  /** 日志目录（可选，默认为 .tmp/hook-logs） */
  logDir?: string;
  /** 是否启用调试日志 */
  debug?: boolean;
}

let globalRequestCounter = 0;

/**
 * 创建插件日志器
 */
export function createLogger(options: LoggerOptions): PluginLogger {
  const { name, logDir, debug } = options;

  const resolvedLogDir = logDir ?? path.join(process.cwd(), ".tmp/hook-logs");

  // 确保日志目录存在
  if (!fs.existsSync(resolvedLogDir)) {
    fs.mkdirSync(resolvedLogDir, { recursive: true });
  }

  const prefix = `[${name}]`;

  return {
    debug(...args: unknown[]) {
      if (debug) {
        console.log(prefix, ...args);
      }
    },

    info(...args: unknown[]) {
      console.log(prefix, ...args);
    },

    warn(...args: unknown[]) {
      console.warn(prefix, ...args);
    },

    error(...args: unknown[]) {
      console.error(prefix, ...args);
    },

    logToFile(filePrefix: string, data: unknown) {
      globalRequestCounter += 1;
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `${timestamp}_${globalRequestCounter}_${filePrefix}.json`;
      const filepath = path.join(resolvedLogDir, filename);
      fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
      if (debug) {
        console.log(prefix, `Logged to: ${filename}`);
      }
    },
  };
}
