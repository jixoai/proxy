import { describe, it, expect } from "bun:test";
import {
  isDroidRequest,
  isNativeCompactionRequest,
  extractSystemText,
  normalizeContentArray,
  replaceSystemReminderSection,
  mergeDuplicateSystemReminders,
  rewriteRequestBody,
  rewriteHeaders,
  rewriteRequest,
} from "../rewriter";
import type { RequestBody, Message, TextBlock } from "../types";

describe("isDroidRequest", () => {
  it("should return true for requests with Droid in system", () => {
    const body: RequestBody = {
      system: "You are Droid, an AI assistant.",
    };
    expect(isDroidRequest(body)).toBe(true);
  });

  it("should return true for requests with Factory in system", () => {
    const body: RequestBody = {
      system: "Built by Factory AI.",
    };
    expect(isDroidRequest(body)).toBe(true);
  });

  it("should return true for requests with factory-droid in system", () => {
    const body: RequestBody = {
      system: [{ type: "text", text: "You are factory-droid." }],
    };
    expect(isDroidRequest(body)).toBe(true);
  });

  it("should return false for non-Droid requests", () => {
    const body: RequestBody = {
      system: "You are Claude, an AI assistant.",
    };
    expect(isDroidRequest(body)).toBe(false);
  });

  it("should return false for requests without system", () => {
    const body: RequestBody = {
      messages: [{ role: "user", content: "Hello" }],
    };
    expect(isDroidRequest(body)).toBe(false);
  });

  it("should return false for already rewritten requests (contains droid-system-context)", () => {
    // 这是重写后的格式，包含 <droid-system-context> 标签
    const body: RequestBody = {
      system: [
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
        {
          type: "text",
          text: "<droid-system-context>\nYou are Droid, an AI assistant built by Factory.\n</droid-system-context>",
          cache_control: { type: "ephemeral" },
        },
      ],
    };
    expect(isDroidRequest(body)).toBe(false);
  });
});

describe("isNativeCompactionRequest", () => {
  it("should detect native compaction requests", () => {
    const body: RequestBody & { thinking?: unknown } = {
      model: "claude-opus-4-1",
      max_tokens: 4000,
      system: "You are Droid, an AI assistant.",
      messages: [{ role: "user", content: "Summarize this conversation." }],
    };

    expect(isNativeCompactionRequest(body)).toBe(true);
  });

  it("should return false when tools are present", () => {
    const body: RequestBody & { thinking?: unknown } = {
      max_tokens: 4000,
      system: "You are Droid, an AI assistant.",
      messages: [{ role: "user", content: "Summarize this conversation." }],
      tools: [{ name: "shell" }],
    };

    expect(isNativeCompactionRequest(body)).toBe(false);
  });

  it("should return false when thinking is present", () => {
    const body: RequestBody & { thinking?: unknown } = {
      max_tokens: 4000,
      system: "You are Droid, an AI assistant.",
      messages: [{ role: "user", content: "Summarize this conversation." }],
      thinking: { type: "enabled" },
    };

    expect(isNativeCompactionRequest(body)).toBe(false);
  });
});

describe("extractSystemText", () => {
  it("should extract text from string system", () => {
    expect(extractSystemText("Hello world")).toBe("Hello world");
  });

  it("should extract text from array system", () => {
    const system: TextBlock[] = [
      { type: "text", text: "First" },
      { type: "text", text: "Second" },
    ];
    expect(extractSystemText(system)).toBe("First\n\nSecond");
  });

  it("should return empty string for undefined", () => {
    expect(extractSystemText(undefined)).toBe("");
  });
});

describe("normalizeContentArray", () => {
  it("should convert string content to array", () => {
    const message: Message = { role: "user", content: "Hello" };
    normalizeContentArray(message);
    expect(message.content).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("should keep array content as is", () => {
    const content: TextBlock[] = [{ type: "text", text: "Hello" }];
    const message: Message = { role: "user", content };
    normalizeContentArray(message);
    expect(message.content).toBe(content);
  });

  it("should handle undefined message", () => {
    expect(() => normalizeContentArray(undefined)).not.toThrow();
  });
});

describe("replaceSystemReminderSection", () => {
  it("should replace system-reminder section", () => {
    const original = "Before <system-reminder>old content</system-reminder> After";
    const result = replaceSystemReminderSection(original, "<system-reminder>new content</system-reminder>");
    expect(result).toBe("Before <system-reminder>new content</system-reminder> After");
  });

  it("should return null if no system-reminder tags", () => {
    const original = "No tags here";
    const result = replaceSystemReminderSection(original, "new content");
    expect(result).toBeNull();
  });

  it("should handle multiple system-reminder sections", () => {
    const original = "<system-reminder>first</system-reminder> middle <system-reminder>last</system-reminder>";
    const result = replaceSystemReminderSection(original, "<system-reminder>replaced</system-reminder>");
    expect(result).toBe("<system-reminder>replaced</system-reminder>");
  });
});

describe("mergeDuplicateSystemReminders", () => {
  it("should merge consecutive user messages with system-reminder", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello <system-reminder>first</system-reminder> world" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "<system-reminder>second</system-reminder>" }],
      },
    ];

    const merged = mergeDuplicateSystemReminders(messages);

    expect(merged).toBe(true);
    expect(messages.length).toBe(1);
    expect((messages[0]!.content as TextBlock[])[0]!.text).toContain("second");
  });

  it("should not merge non-consecutive messages", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "<system-reminder>first</system-reminder>" }],
      },
      {
        role: "assistant",
        content: "Response",
      },
      {
        role: "user",
        content: [{ type: "text", text: "<system-reminder>second</system-reminder>" }],
      },
    ];

    const merged = mergeDuplicateSystemReminders(messages);

    expect(merged).toBe(false);
    expect(messages.length).toBe(3);
  });

  it("should return false for undefined messages", () => {
    expect(mergeDuplicateSystemReminders(undefined)).toBe(false);
  });
});

describe("rewriteRequestBody", () => {
  it("should rewrite Droid request body", () => {
    const body: RequestBody = {
      model: "claude-3-opus",
      system: "You are Droid, an AI assistant built by Factory.",
      messages: [{ role: "user", content: "Hello" }],
    };

    const result = rewriteRequestBody(body);

    expect(result).not.toBeNull();
    expect(Array.isArray(result!.system)).toBe(true);
    const system = result!.system as TextBlock[];
    expect(system[0]!.text).toContain("Claude Code");
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(system[1]!.text).toContain("<droid-system-context>");
    expect(system[1]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("should preserve native compaction request bodies", () => {
    const body: RequestBody & { thinking?: unknown } = {
      model: "claude-opus-4-5-20251101",
      max_tokens: 4000,
      system: "You are Droid, an AI assistant built by Factory.",
      messages: [{ role: "user", content: "Summarize the conversation so far." }],
    };
    const original = structuredClone(body);

    const result = rewriteRequestBody(body);

    expect(result).toEqual(original);
    expect(result!.metadata).toBeUndefined();
    expect(result!.system).toBe(original.system);
    expect(result!.messages).toEqual(original.messages);
    expect(result!.max_tokens).toBe(4000);
  });

  it("should return null for non-Droid request", () => {
    const body: RequestBody = {
      system: "You are Claude.",
      messages: [],
    };

    const result = rewriteRequestBody(body);

    expect(result).toBeNull();
  });

  it("should add metadata if missing", () => {
    const body: RequestBody = {
      system: "You are Droid.",
    };

    const result = rewriteRequestBody(body);

    expect(result!.metadata).toBeDefined();
    expect(result!.metadata!.user_id).toBeDefined();
  });

  it("should preserve existing metadata", () => {
    const body: RequestBody = {
      system: "You are Droid.",
      metadata: { custom: "value" },
    };

    const result = rewriteRequestBody(body);

    expect(result!.metadata).toEqual({ custom: "value" });
  });

  it("should not rewrite model by default", () => {
    const body: RequestBody = {
      model: "claude-opus-4-5-20251101",
      system: "You are Droid.",
      messages: [],
    };

    const result = rewriteRequestBody(body);

    expect(result!.model).toBe("claude-opus-4-5-20251101");
  });

  it("should rewrite model via exact match", () => {
    const body: RequestBody = {
      model: "claude-opus-4-5-20251101",
      system: "You are Droid.",
      messages: [],
    };

    const result = rewriteRequestBody(body, {
      model: { "claude-opus-4-5-20251101": "gemini-claude-opus-4-5-thinking" },
    });

    expect(result!.model).toBe("gemini-claude-opus-4-5-thinking");
  });

  it("should rewrite model via regex rule", () => {
    const body: RequestBody = {
      model: "claude-opus-4-5-20251101",
      system: "You are Droid.",
      messages: [],
    };

    const result = rewriteRequestBody(body, {
      model: { "/claude-(opus)-4-5-(\\d{8})/": "gemini-claude-$1-4-5-$2-thinking" },
    });

    expect(result!.model).toBe("gemini-claude-opus-4-5-20251101-thinking");
  });
});

describe("rewriteHeaders", () => {
  it("should add anthropic-beta header", () => {
    const headers = { "content-type": "application/json" };
    const result = rewriteHeaders(headers);
    expect(result["anthropic-beta"]).toBe(
      "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,effort-2025-11-24",
    );
  });

  it("should preserve incoming beta flags after adding Claude Code defaults", () => {
    const headers = {
      "content-type": "application/json",
      "anthropic-beta":
        "fast-mode-2026-02-01,context-1m-2025-08-07,interleaved-thinking-2025-05-14",
    };
    const result = rewriteHeaders(headers);
    expect(result["anthropic-beta"]).toBe(
      "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,effort-2025-11-24,fast-mode-2026-02-01",
    );
  });

  it("should convert x-api-key to authorization", () => {
    const headers = { "x-api-key": "sk-ant-123" };
    const result = rewriteHeaders(headers);
    expect(result["authorization"]).toBe("Bearer sk-ant-123");
    expect(result["x-api-key"]).toBeUndefined();
  });

  it("should not override existing authorization", () => {
    const headers = {
      "x-api-key": "sk-ant-123",
      authorization: "Bearer existing",
    };
    const result = rewriteHeaders(headers);
    expect(result["authorization"]).toBe("Bearer existing");
  });

  it("should add required headers", () => {
    const result = rewriteHeaders({});
    expect(result["x-app"]).toBe("cli");
    expect(result["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(result["user-agent"]).toBe("claude-cli/2.1.86 (external, cli)");
  });

  it("should set Claude Code session header when provided", () => {
    const result = rewriteHeaders({}, { sessionId: "session-123" });
    expect(result["x-claude-code-session-id"]).toBe("session-123");
  });
});

describe("rewriteRequest", () => {
  it("should rewrite Droid request", () => {
    const body: RequestBody = {
      model: "claude-3-opus",
      system: "You are Droid.",
      messages: [],
    };

    const result = rewriteRequest({
      headers: { "content-type": "application/json" },
      url: "https://api.anthropic.com/v1/messages",
      body: JSON.stringify(body),
    });

    expect(result.headers).toBeDefined();
    expect(result.body).toBeDefined();
    expect(result.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    const parsedBody = JSON.parse(result.body!);
    expect(Array.isArray(parsedBody.system)).toBe(true);
  });

  it("should preserve compaction bodies while applying transport rewrites", () => {
    const body: RequestBody = {
      model: "claude-opus-4-6",
      max_tokens: 4000,
      system: "You are Droid.",
      messages: [{ role: "user", content: "Summarize the conversation so far." }],
    };

    const result = rewriteRequest({
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-123",
        "anthropic-beta": "fast-mode-2026-02-01",
      },
      url: "https://api.anthropic.com/v1/messages",
      body: JSON.stringify(body),
    });

    expect(result.headers?.["authorization"]).toBe("Bearer sk-ant-123");
    expect(result.headers?.["anthropic-beta"]).toBe(
      "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,effort-2025-11-24,fast-mode-2026-02-01",
    );
    expect(result.headers?.["x-claude-code-session-id"]).toBeUndefined();
    expect(result.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(JSON.parse(result.body!)).toEqual(body);
  });

  it("should preserve compaction bodies and forward session headers when available", () => {
    const body: RequestBody = {
      model: "claude-opus-4-6",
      max_tokens: 4000,
      system: "You are Droid.",
      messages: [{ role: "user", content: "Summarize the conversation so far." }],
      metadata: {
        user_id: JSON.stringify({ session_id: "session-123" }),
      },
    };

    const result = rewriteRequest({
      headers: {
        "content-type": "application/json",
      },
      url: "https://api.anthropic.com/v1/messages",
      body: JSON.stringify(body),
    });

    expect(result.headers?.["x-claude-code-session-id"]).toBe("session-123");
    expect(JSON.parse(result.body!)).toEqual(body);
  });

  it("should preserve Droid beta headers in rewritten requests", () => {
    const body: RequestBody = {
      model: "claude-opus-4-6",
      system: "You are Droid.",
      messages: [],
    };

    const result = rewriteRequest({
      headers: {
        "content-type": "application/json",
        "anthropic-beta": "fast-mode-2026-02-01",
      },
      url: "https://api.anthropic.com/v1/messages",
      body: JSON.stringify(body),
    });

    expect(result.headers?.["anthropic-beta"]).toBe(
      "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,effort-2025-11-24,fast-mode-2026-02-01",
    );
    expect(result.headers?.["x-claude-code-session-id"]).toBe(
      "dffce60e-e7a0-4bc3-b847-4e25f13d3c66",
    );
  });

  it("should return empty object for non-Droid request", () => {
    const body: RequestBody = {
      system: "You are Claude.",
    };

    const result = rewriteRequest({
      headers: {},
      body: JSON.stringify(body),
    });

    expect(result).toEqual({});
  });

  it("should return empty object for empty body", () => {
    const result = rewriteRequest({
      headers: {},
      body: "",
    });

    expect(result).toEqual({});
  });

  it("should return empty object for invalid JSON", () => {
    const result = rewriteRequest({
      headers: {},
      body: "not json",
    });

    expect(result).toEqual({});
  });
});
