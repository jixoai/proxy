import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { getDbPath, ensureDataDir } from "./runtime-paths";

// Schema 版本号 - 每次数据库结构变更时递增
// v2: 添加虚拟列索引优化 + streaming 专用列
// v3: status_code 虚拟列优先使用 hookedResponse.statusCode
// v4: 添加 request_url/path 的持久化小写列（用于前缀搜索索引）
const SCHEMA_VERSION = 4;

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
    // 新数据库，初始化 schema v4
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
        -- 实体列：用于 URL 前缀查询（避免 LIKE '%...%' 全表扫）
        request_url_lc TEXT,
        request_path_lc TEXT,
        -- JSON 数据
        data TEXT NOT NULL,
        -- 虚拟列：从 JSON 提取，用于索引加速查询
        method TEXT GENERATED ALWAYS AS (JSON_EXTRACT(data, '$.request.method')) STORED,
        -- status_code 优先使用 hookedResponse（插件修改后的响应）
        status_code INTEGER GENERATED ALWAYS AS (
          COALESCE(
            JSON_EXTRACT(data, '$.hookedResponse.statusCode'),
            JSON_EXTRACT(data, '$.response.statusCode')
          )
        ) STORED,
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
    // 索引：URL/Path 前缀过滤
    _db.run("CREATE INDEX IF NOT EXISTS idx_proxy_requests_request_url_lc ON proxy_requests(request_url_lc)");
    _db.run("CREATE INDEX IF NOT EXISTS idx_proxy_requests_request_path_lc ON proxy_requests(request_path_lc)");

    // 记录版本号
    _db.run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)", [
      String(SCHEMA_VERSION),
    ]);

    console.log("[Database] Initialized with schema version", SCHEMA_VERSION);
  } else if (dbVersion === 2) {
    // 从 v2 升级到 v4：重建 status_code 虚拟列 + 添加 URL 前缀查询列
    console.log("[Database] Upgrading from v2 to v4...");

    // SQLite 不支持直接修改虚拟列，需要重建表
    _db.exec(`
      -- 创建新表
      CREATE TABLE proxy_requests_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME NOT NULL,
        instance_name TEXT,
        forward_name TEXT,
        group_name TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        response_body_size INTEGER NOT NULL DEFAULT 0,
        request_url_lc TEXT,
        request_path_lc TEXT,
        data TEXT NOT NULL,
        method TEXT GENERATED ALWAYS AS (JSON_EXTRACT(data, '$.request.method')) STORED,
        status_code INTEGER GENERATED ALWAYS AS (
          COALESCE(
            JSON_EXTRACT(data, '$.hookedResponse.statusCode'),
            JSON_EXTRACT(data, '$.response.statusCode')
          )
        ) STORED,
        request_url TEXT GENERATED ALWAYS AS (JSON_EXTRACT(data, '$.request.url')) STORED
      );

      -- 复制数据（不包括虚拟列，它们会自动计算）
      INSERT INTO proxy_requests_new (id, timestamp, instance_name, forward_name, group_name, status, response_body_size, request_url_lc, request_path_lc, data)
      SELECT id, timestamp, instance_name, forward_name, group_name, status, response_body_size, NULL, NULL, data
      FROM proxy_requests;

      -- 删除旧表
      DROP TABLE proxy_requests;

      -- 重命名新表
      ALTER TABLE proxy_requests_new RENAME TO proxy_requests;

      -- 重建索引
      CREATE INDEX idx_proxy_requests_time ON proxy_requests(timestamp DESC);
      CREATE INDEX idx_proxy_requests_group ON proxy_requests(group_name);
      CREATE INDEX idx_proxy_requests_instance ON proxy_requests(instance_name);
      CREATE INDEX idx_proxy_requests_forward ON proxy_requests(forward_name);
      CREATE INDEX idx_proxy_requests_method ON proxy_requests(method);
      CREATE INDEX idx_proxy_requests_status_code ON proxy_requests(status_code);
      CREATE INDEX idx_proxy_requests_status ON proxy_requests(status);
      CREATE INDEX idx_proxy_requests_request_url_lc ON proxy_requests(request_url_lc);
      CREATE INDEX idx_proxy_requests_request_path_lc ON proxy_requests(request_path_lc);
    `);

    // 回填（JS 解析 URL.pathname）
    const select = _db.query("SELECT id, request_url FROM proxy_requests ORDER BY id ASC");
    const update = _db.query(
      "UPDATE proxy_requests SET request_url_lc = ?, request_path_lc = ? WHERE id = ?",
    );

    try {
      _db.exec("BEGIN");
      for (const row of select.iterate() as IterableIterator<{ id: number; request_url: string | null }>) {
        const rawUrl = row.request_url;
        const urlLc = typeof rawUrl === "string" ? rawUrl.toLowerCase() : null;
        let pathLc: string | null = null;
        if (typeof rawUrl === "string") {
          try {
            pathLc = new URL(rawUrl).pathname.toLowerCase();
          } catch {
            pathLc = null;
          }
        }
        update.run(urlLc, pathLc, row.id);
      }
      _db.exec("COMMIT");
    } catch (error) {
      try {
        _db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw error;
    }

    // 更新版本号
    _db.run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)", [
      String(SCHEMA_VERSION),
    ]);

    console.log("[Database] Upgraded to schema version", SCHEMA_VERSION);
  } else if (dbVersion === 3) {
    // 从 v3 升级到 v4：新增 url/path 小写实体列 + 回填 + 索引
    console.log("[Database] Upgrading from v3 to v4...");

    _db.exec(`
      ALTER TABLE proxy_requests ADD COLUMN request_url_lc TEXT;
      ALTER TABLE proxy_requests ADD COLUMN request_path_lc TEXT;
    `);

    // 回填（JS 解析 URL.pathname）
    const select = _db.query("SELECT id, request_url FROM proxy_requests ORDER BY id ASC");
    const update = _db.query(
      "UPDATE proxy_requests SET request_url_lc = ?, request_path_lc = ? WHERE id = ?",
    );

    try {
      _db.exec("BEGIN");
      for (const row of select.iterate() as IterableIterator<{ id: number; request_url: string | null }>) {
        const rawUrl = row.request_url;
        const urlLc = typeof rawUrl === "string" ? rawUrl.toLowerCase() : null;
        let pathLc: string | null = null;
        if (typeof rawUrl === "string") {
          try {
            pathLc = new URL(rawUrl).pathname.toLowerCase();
          } catch {
            pathLc = null;
          }
        }
        update.run(urlLc, pathLc, row.id);
      }
      _db.exec("COMMIT");
    } catch (error) {
      try {
        _db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw error;
    }

    _db.exec(`
      CREATE INDEX IF NOT EXISTS idx_proxy_requests_request_url_lc ON proxy_requests(request_url_lc);
      CREATE INDEX IF NOT EXISTS idx_proxy_requests_request_path_lc ON proxy_requests(request_path_lc);
    `);

    // 更新版本号
    _db.run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)", [
      String(SCHEMA_VERSION),
    ]);

    console.log("[Database] Upgraded to schema version", SCHEMA_VERSION);
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
