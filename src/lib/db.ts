import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { getDbPath, ensureDataDir } from "./runtime-paths";

// 延迟初始化数据库实例
// 必须在 setDataDir() 调用之后才能访问
let _db: Database | null = null;

/**
 * 获取数据库实例
 * 必须在 initDatabase() 调用之后才能使用
 */
export function getDb(): Database {
  if (!_db) {
    throw new Error(
      "Database not initialized. Call initDatabase() first after setting data directory."
    );
  }
  return _db;
}

// 为了兼容现有代码，使用 getter 导出 db
// 注意：实际数据库实例在 initDatabase() 后才可用
export const db = {
  get instance(): Database {
    return getDb();
  },
  query(sql: string) {
    return getDb().query(sql);
  },
  run(sql: string, ...params: any[]) {
    return getDb().run(sql, ...params);
  },
  exec(sql: string) {
    return getDb().exec(sql);
  },
  prepare(sql: string) {
    return getDb().prepare(sql);
  },
};

export function initDatabase() {
  // 如果已经初始化，跳过
  if (_db) {
    return;
  }

  // 在这里才真正创建数据库，确保 setDataDir() 已经被调用
  const DB_PATH = getDbPath();

  ensureDataDir();
  mkdirSync(path.dirname(DB_PATH), { recursive: true });

  _db = new Database(DB_PATH, { create: true });

  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA synchronous = NORMAL");
  _db.run("PRAGMA busy_timeout = 5000");
  // destructive migration: drop legacy tables
  _db.run("DROP TABLE IF EXISTS proxy_requests_v2");
  _db.run("DROP TABLE IF EXISTS proxy_requests");
  _db.run("DROP TABLE IF EXISTS proxy_instances");
  _db.run("DROP TABLE IF EXISTS proxy_forwards");

  _db.run(`
    CREATE TABLE IF NOT EXISTS proxy_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp DATETIME NOT NULL,
      instance_name TEXT,
      forward_name TEXT,
      group_name TEXT,
      data TEXT NOT NULL
    )
  `);

  _db.run("CREATE INDEX IF NOT EXISTS idx_proxy_requests_time ON proxy_requests(timestamp DESC)");
  _db.run("CREATE INDEX IF NOT EXISTS idx_proxy_requests_group ON proxy_requests(group_name)");

  console.log("[Database] proxy_requests initialized");
}
