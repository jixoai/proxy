import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as path from "node:path";
import * as fs from "node:fs";

// 测试数据库路径
const TEST_DB_PATH = path.join(__dirname, ".tmp/test-proxy-server.db");

// 清理测试数据库
function cleanupTestDb() {
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }
}

// 初始化测试数据库
function initTestDatabase(db: Database) {
  db.run("PRAGMA foreign_keys = ON");

  db.run(`
    CREATE TABLE IF NOT EXISTS proxy_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      port INTEGER NOT NULL UNIQUE,
      enabled BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS proxy_forwards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      target_url TEXT NOT NULL,
      enabled BOOLEAN DEFAULT 1,
      path TEXT,
      custom_headers TEXT,
      sort_index INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (instance_id) REFERENCES proxy_instances(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS proxy_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER NOT NULL,
      forward_id INTEGER,
      request_id TEXT NOT NULL,
      timestamp DATETIME NOT NULL,
      duration_ms INTEGER NOT NULL,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      request_headers TEXT NOT NULL,
      request_body TEXT,
      request_body_size INTEGER DEFAULT 0,
      status_code INTEGER NOT NULL,
      status_message TEXT,
      response_headers TEXT NOT NULL,
      response_body TEXT,
      response_body_size INTEGER DEFAULT 0,
      response_content_type TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (instance_id) REFERENCES proxy_instances(id) ON DELETE CASCADE,
      FOREIGN KEY (forward_id) REFERENCES proxy_forwards(id) ON DELETE SET NULL
    )
  `);
}

describe("Proxy Server Error Handling", () => {
  let testDb: Database;

  beforeAll(() => {
    cleanupTestDb();
    testDb = new Database(TEST_DB_PATH, { create: true });
    initTestDatabase(testDb);
  });

  afterAll(() => {
    if (testDb) {
      testDb.close();
    }
    cleanupTestDb();
  });

  test("should save failed request with ECONNREFUSED error", () => {
    // 创建实例
    const instanceQuery = testDb.query(`
      INSERT INTO proxy_instances (name, port, enabled)
      VALUES (?, ?, ?)
    `);
    const instanceResult = instanceQuery.run("Test Instance", 27002, 1);
    const instanceId = Number(instanceResult.lastInsertRowid);

    // 创建转发规则
    const forwardQuery = testDb.query(`
      INSERT INTO proxy_forwards (instance_id, name, target_url, enabled, custom_headers)
      VALUES (?, ?, ?, ?, ?)
    `);
    const customHeaders = JSON.stringify({ "x-api-key": "test-key" });
    const forwardResult = forwardQuery.run(
      instanceId,
      "Test Forward",
      "http://localhost:7860/",
      1,
      customHeaders
    );
    const forwardId = Number(forwardResult.lastInsertRowid);

    // 模拟保存失败的请求
    const requestQuery = testDb.query(`
      INSERT INTO proxy_requests (
        instance_id, forward_id, request_id, timestamp, duration_ms,
        method, url, request_headers, request_body, request_body_size,
        status_code, status_message, response_headers, response_body, response_body_size
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const requestId = "test-req-001";
    const timestamp = new Date().toISOString();
    const requestHeaders = JSON.stringify({ "user-agent": "test" });
    const responseBody = Buffer.from(JSON.stringify({
      error: "代理请求失败",
      message: "ECONNREFUSED",
    }));

    const result = requestQuery.run(
      instanceId,
      forwardId,
      requestId,
      timestamp,
      100, // duration_ms
      "GET",
      "/",
      requestHeaders,
      null, // request_body
      0, // request_body_size
      502, // status_code (Bad Gateway)
      "Bad Gateway",
      JSON.stringify({}),
      responseBody,
      responseBody.length
    );

    expect(Number(result.lastInsertRowid)).toBeGreaterThan(0);

    // 验证保存的数据
    const selectQuery = testDb.query("SELECT * FROM proxy_requests WHERE request_id = ?");
    const savedRequest = selectQuery.get(requestId) as any;

    expect(savedRequest).toBeDefined();
    expect(savedRequest.status_code).toBe(502);
    expect(savedRequest.status_message).toBe("Bad Gateway");
    expect(savedRequest.forward_id).toBe(forwardId);
  });

  test("should handle custom headers in forward rule", () => {
    // 创建实例
    const instanceQuery = testDb.query(`
      INSERT INTO proxy_instances (name, port, enabled)
      VALUES (?, ?, ?)
    `);
    const instanceResult = instanceQuery.run("Test Instance 2", 27003, 1);
    const instanceId = Number(instanceResult.lastInsertRowid);

    // 创建带自定义 header 的转发规则
    const forwardQuery = testDb.query(`
      INSERT INTO proxy_forwards (instance_id, name, target_url, enabled, custom_headers)
      VALUES (?, ?, ?, ?, ?)
    `);

    const customHeaders = JSON.stringify({
      "x-api-key": "secret-key",
      "Authorization": "Bearer token123",
    });

    const result = forwardQuery.run(
      instanceId,
      "API Forward",
      "http://api.example.com/",
      1,
      customHeaders
    );

    expect(Number(result.lastInsertRowid)).toBeGreaterThan(0);

    // 验证保存的数据
    const selectQuery = testDb.query("SELECT * FROM proxy_forwards WHERE id = ?");
    const forward = selectQuery.get(Number(result.lastInsertRowid)) as any;

    expect(forward.custom_headers).toBe(customHeaders);

    // 验证可以解析 JSON
    const parsed = JSON.parse(forward.custom_headers);
    expect(parsed["x-api-key"]).toBe("secret-key");
    expect(parsed["Authorization"]).toBe("Bearer token123");
  });

  test("should record connection refused errors", () => {
    // 创建实例
    const instanceQuery = testDb.query(`
      INSERT INTO proxy_instances (name, port, enabled)
      VALUES (?, ?, ?)
    `);
    const instanceResult = instanceQuery.run("Test Instance 3", 27004, 1);
    const instanceId = Number(instanceResult.lastInsertRowid);

    // 模拟多个失败的请求
    const requestQuery = testDb.query(`
      INSERT INTO proxy_requests (
        instance_id, forward_id, request_id, timestamp, duration_ms,
        method, url, request_headers, request_body_size,
        status_code, status_message, response_headers, response_body, response_body_size
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const errors = [
      { code: "ECONNREFUSED", message: "Connection refused" },
      { code: "ETIMEDOUT", message: "Connection timed out" },
      { code: "ENOTFOUND", message: "Host not found" },
    ];

    errors.forEach((error, index) => {
      const responseBody = Buffer.from(JSON.stringify({
        error: "代理请求失败",
        message: error.message,
      }));

      requestQuery.run(
        instanceId,
        null, // no forward rule
        `error-req-${index}`,
        new Date().toISOString(),
        50 + index * 10,
        "GET",
        "/test",
        JSON.stringify({}),
        0,
        502,
        "Bad Gateway",
        JSON.stringify({}),
        responseBody,
        responseBody.length
      );
    });

    // 验证所有错误请求都被保存
    const countQuery = testDb.query(
      "SELECT COUNT(*) as count FROM proxy_requests WHERE instance_id = ? AND status_code = 502"
    );
    const result = countQuery.get(instanceId) as any;

    expect(result.count).toBe(3);
  });
});
