import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { initDatabase } from "../src/lib/db";
import { clearDataDir, setDataDir } from "../src/lib/runtime-paths";
import {
  clearAllRequests,
  createProxyRequest,
  getProxyRequestById,
  getRequestsAfterId,
  type LoggedRequest,
} from "../src/lib/db-requests";

describe("db-requests logging pipeline", () => {
  const TEST_DATA_DIR = path.join(process.cwd(), ".tmp", "db-requests-tests", "data");

  beforeAll(() => {
    // Use an isolated data dir so local dev DB/schema won't break tests.
    setDataDir(TEST_DATA_DIR);
    clearDataDir();
    initDatabase();
  });

  beforeEach(() => {
    // Ensure a clean proxy_requests table for each test.
    clearAllRequests();
  });

  function makeRequestPayload(overrides: Partial<Omit<LoggedRequest, "id">> = {}) {
    const base: Omit<LoggedRequest, "id"> = {
      request_id: "req-1",
      timestamp: new Date().toISOString(),
      instance_name: "test-instance",
      forward_name: "test-forward",
      forward_id: "test-forward-id",
      group_name: "test-instance/test-forward",
      status: "pending",
      abort_reason: null,
      is_websocket: false,
      websocket_direction: null,
      error_message: null,
      request: {
        method: "GET",
        url: "http://localhost/test",
        headers: {},
        forwardedHeaders: {},
        bodyDataUrl: null,
        bodySize: 0,
      },
      response: undefined,
    };
    return { ...base, ...overrides };
  }

  test("createProxyRequest stores JSON and getRequestsAfterId retrieves in order", () => {
    const firstId = createProxyRequest(
      makeRequestPayload({ request_id: "req-1", status: "pending" }),
    );
    const secondId = createProxyRequest(
      makeRequestPayload({ request_id: "req-2", status: "completed" }),
    );

    expect(firstId).toBeLessThan(secondId);

    const allFromZero = getRequestsAfterId(0);
    expect(allFromZero.map((r) => r.id)).toEqual([firstId, secondId]);

    const afterFirst = getRequestsAfterId(firstId);
    expect(afterFirst.map((r) => r.id)).toEqual([secondId]);

    const fetched = getProxyRequestById(secondId);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(secondId);
    expect(fetched?.request_id).toBe("req-2");
    expect(fetched?.request.url).toBe("http://localhost/test");
    expect(fetched?.status).toBe("completed");
  });
});
