import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { getDbPath, ensureDataDir } from "./runtime-paths";

// Schema 版本号 - 每次数据库结构变更时递增
// v2: 添加虚拟列索引优化 + streaming 专用列
const SCHEMA_VERSION = 2;

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

export class DatabaseSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseSchemaError";
  }
}

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

  // 创建 schema_meta 表（如果不存在）
  _db.run(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // 检查数据库 schema 版本
  const versionRow = _db.query("SELECT value FROM schema_meta WHERE key = 'version'").get() as
    | { value: string }
    | null;
  const dbVersion = versionRow ? parseInt(versionRow.value, 10) : 0;

  if (dbVersion === 0) {
    // 新数据库，初始化 schema v2
    _db.run(`
      CREATE TABLE IF NOT EXISTS proxy_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME NOT NULL,
        instance_name TEXT,
        forward_name TEXT,
        group_name TEXT,
        -- 实体列：用于快速更新 streaming 进度
        status TEXT NOT NULL DEFAULT 'pending',
        response_body_size INTEGER NOT NULL DEFAULT 0,
        -- JSON 数据
        data TEXT NOT NULL,
        -- 虚拟列：从 JSON 提取，用于索引加速查询
        method TEXT GENERATED ALWAYS AS (JSON_EXTRACT(data, '$.request.method')) STORED,
        status_code INTEGER GENERATED ALWAYS AS (JSON_EXTRACT(data, '$.response.statusCode')) STORED,
        request_url TEXT GENERATED ALWAYS AS (JSON_EXTRACT(data, '$.request.url')) STORED
      )
    `);

    // 索引：时间倒序（主要查询模式）
    _db.run("CREATE INDEX IF NOT EXISTS idx_proxy_requests_time ON proxy_requests(timestamp DESC)");
    // 索引：分组过滤
    _db.run("CREATE INDEX IF NOT EXISTS idx_proxy_requests_group ON proxy_requests(group_name)");
    // 索引：实例过滤
    _db.run("CREATE INDEX IF NOT EXISTS idx_proxy_requests_instance ON proxy_requests(instance_name)");
    // 索引：转发规则过滤
    _db.run("CREATE INDEX IF NOT EXISTS idx_proxy_requests_forward ON proxy_requests(forward_name)");
    // 索引：方法过滤
    _db.run("CREATE INDEX IF NOT EXISTS idx_proxy_requests_method ON proxy_requests(method)");
    // 索引：状态码过滤
    _db.run("CREATE INDEX IF NOT EXISTS idx_proxy_requests_status_code ON proxy_requests(status_code)");
    // 索引：请求状态（用于清理孤儿 streaming）
    _db.run("CREATE INDEX IF NOT EXISTS idx_proxy_requests_status ON proxy_requests(status)");

    // 记录版本号
    _db.run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)", [
      String(SCHEMA_VERSION),
    ]);

    console.log("[Database] Initialized with schema version", SCHEMA_VERSION);
  } else if (dbVersion !== SCHEMA_VERSION) {
    // 版本不匹配
    throw new DatabaseSchemaError(
      `Database schema version mismatch: expected ${SCHEMA_VERSION}, found ${dbVersion}. ` +
        `Please use --clear to reset the database.`
    );
  } else {
    console.log("[Database] Schema version", dbVersion, "OK");
  }
}
