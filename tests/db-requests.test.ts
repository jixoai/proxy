import { beforeEach, describe, expect, test } from "bun:test";
import { initDatabase } from "../src/lib/db";
import {
  clearAllRequests,
  createProxyRequest,
  getProxyRequestById,
  getRequestsAfterId,
  type LoggedRequest,
} from "../src/lib/db-requests";

describe("db-requests logging pipeline", () => {
  beforeEach(() => {
    // destructive init to ensure a clean proxy_requests table
    initDatabase();
    clearAllRequests();
  });

  function makeRequestPayload(overrides: Partial<Omit<LoggedRequest, "id">> = {}) {
    const base: Omit<LoggedRequest, "id"> = {
      request_id: "req-1",
      timestamp: new Date().toISOString(),
      instance_name: "test-instance",
      forward_name: "test-forward",
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
