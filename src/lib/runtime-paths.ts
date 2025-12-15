/**
 * 运行时路径工具
 *
 * 处理 bun build --compile 单文件打包后的路径问题：
 * - 打包后 __dirname 指向虚拟文件系统 /$bunfs，不可写
 * - 需要使用真实的文件系统路径存储数据
 *
 * 数据目录结构：
 * - 默认：~/.jixo/.proxy/${version}/
 * - 可通过配置文件的 dbPath 字段或命令行参数覆盖
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { getPackageVersion } from "./version.macro" with { type: "macro" };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 获取版本号
 * 使用编译时宏，在打包时会内嵌版本号
 */
export function getVersion(): string {
  return getPackageVersion();
}

/** 检查是否在单文件打包模式下运行 */
export function isStandaloneBinary(): boolean {
  return __dirname.startsWith("/$bunfs");
}

/** 运行时设置的数据目录（可通过 CLI 或配置文件设置） */
let customDataDir: string | null = null;

/** 设置数据目录 */
export function setDataDir(dir: string): void {
  customDataDir = path.resolve(dir);
}

/**
 * 获取数据存储根目录
 *
 * 优先级：
 * 1. 运行时设置的 customDataDir
 * 2. 环境变量 PROXY_DATA_DIR
 * 3. 默认目录：
 *    - 打包模式：~/.jixo/.proxy/${version}/
 *    - 开发模式：项目目录下的 .tmp/
 */
export function getDataDir(): string {
  // 运行时设置优先
  if (customDataDir) {
    return customDataDir;
  }

  // 环境变量其次
  if (process.env.PROXY_DATA_DIR && process.env.PROXY_DATA_DIR.length > 0) {
    return path.resolve(process.env.PROXY_DATA_DIR);
  }

  if (isStandaloneBinary()) {
    // 打包模式：使用 ~/.jixo/.proxy/${version}/
    const version = getVersion();
    return path.join(os.homedir(), ".jixo", ".proxy", version);
  }

  // 开发模式：使用项目目录下的 .tmp
  return path.join(__dirname, "../.tmp");
}

/**
 * 获取默认数据目录（不考虑运行时设置）
 * 用于配置文件中 dbPath 的默认值
 */
export function getDefaultDataDir(): string {
  const version = getVersion();
  return path.join(os.homedir(), ".jixo", ".proxy", version);
}

/** 获取数据库文件路径 */
export function getDbPath(): string {
  if (process.env.PROXY_DB_PATH && process.env.PROXY_DB_PATH.length > 0) {
    return path.resolve(process.env.PROXY_DB_PATH);
  }
  return path.join(getDataDir(), "proxy.db");
}

/** 获取临时配置文件目录 */
export function getTempConfigDir(): string {
  return getDataDir();
}

/** 获取实例配置文件路径 */
export function getInstanceConfigPath(instanceName: string): string {
  return path.join(getTempConfigDir(), `instance-${instanceName}-config.json`);
}

/** 确保数据目录存在 */
export function ensureDataDir(): void {
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
}

/**
 * 清理数据目录
 * 删除数据库文件和实例配置文件
 */
export function clearDataDir(): void {
  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) return;

  // 删除数据库文件
  const dbPath = path.join(dataDir, "proxy.db");
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
  // 删除 WAL 文件
  const walPath = `${dbPath}-wal`;
  if (fs.existsSync(walPath)) {
    fs.unlinkSync(walPath);
  }
  // 删除 SHM 文件
  const shmPath = `${dbPath}-shm`;
  if (fs.existsSync(shmPath)) {
    fs.unlinkSync(shmPath);
  }

  // 删除实例配置文件
  const files = fs.readdirSync(dataDir);
  for (const file of files) {
    if (file.startsWith("instance-") && file.endsWith("-config.json")) {
      fs.unlinkSync(path.join(dataDir, file));
    }
  }
}

/** 获取 standalone 相关路径 */
export function getStandalonePaths() {
  if (isStandaloneBinary()) {
    throw new Error("Standalone build paths are not available in compiled binary");
  }
  return {
    baseDir: path.join(__dirname, "../standalone"),
    outDir: path.join(__dirname, "../.standalone"),
  };
}

/** 获取前端静态资源目录 */
export function getProxyStaticDir(): string {
  return path.join(getDataDir(), "proxy");
}
