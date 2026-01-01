import { describe, expect, test } from "bun:test";
import {
  isClaudeRequest,
  convertSystemToInstructions,
  convertThinkingToReasoning,
  convertMessagesToInput,
  convertTools,
  convertRequest,
  rewriteRequest,
} from "../request-converter";
import type { ClaudeRequest, ClaudeMessage, ClaudeTool } from "../types";

describe("request-converter", () => {
  describe("isClaudeRequest", () => {
    test("should return true for valid Claude request", () => {
      const req = {
        model: "claude-3-opus-20240229",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hello" }],
      };
      expect(isClaudeRequest(req)).toBe(true);
    });

    test("should return false for invalid request", () => {
      expect(isClaudeRequest(null)).toBe(false);
      expect(isClaudeRequest({})).toBe(false);
      expect(isClaudeRequest({ model: "test" })).toBe(false);
    });
  });

  describe("convertSystemToInstructions", () => {
    test("should convert string system to instructions", () => {
      const result = convertSystemToInstructions("You are a helpful assistant.");
      expect(result).toContain("You are GPT-5.2 running in the Codex CLI");
    });

    test("should convert array system to instructions", () => {
      const system = [
        { type: "text" as const, text: "You are Claude Code." },
        { type: "text" as const, text: "Be helpful." },
      ];
      const result = convertSystemToInstructions(system);
      expect(result).toContain("You are GPT-5.2 running in the Codex CLI");
    });

    test("should handle undefined system", () => {
      expect(convertSystemToInstructions(undefined)).toContain("You are GPT-5.2 running in the Codex CLI");
    });

    test("should allow empty instructions via env override", () => {
      const prev = process.env.CLAUDE_CODE_INSTRUCTIONS_MODE;
      process.env.CLAUDE_CODE_INSTRUCTIONS_MODE = "empty";

      try {
        expect(convertSystemToInstructions("You are a helpful assistant.")).toBe("");
      } finally {
        if (prev === undefined) {
          delete process.env.CLAUDE_CODE_INSTRUCTIONS_MODE;
        } else {
          process.env.CLAUDE_CODE_INSTRUCTIONS_MODE = prev;
        }
      }
    });
  });

  describe("convertThinkingToReasoning", () => {
    test("should convert thinking config to reasoning", () => {
      const thinking = { type: "enabled" as const, budget_tokens: 8192 };
      const result = convertThinkingToReasoning(thinking);
      expect(result).toEqual({ effort: "high", summary: "auto" });
    });

    test("should return default medium for no thinking", () => {
      expect(convertThinkingToReasoning(undefined)).toEqual({ effort: "medium", summary: "auto" });
    });

    test("should handle different budget levels", () => {
      expect(convertThinkingToReasoning({ type: "enabled", budget_tokens: 1024 }))
        .toEqual({ effort: "minimal", summary: "auto" });
      expect(convertThinkingToReasoning({ type: "enabled", budget_tokens: 16384 }))
        .toEqual({ effort: "xhigh", summary: "auto" });
    });
  });

  describe("convertMessagesToInput", () => {
    test("should convert simple user message", () => {
      const messages: ClaudeMessage[] = [
        { role: "user", content: "Hello" },
      ];
      const result = convertMessagesToInput(messages);
      expect(result.length).toBe(1);
      expect(result[0]!.type).toBe("message");
      expect((result[0] as any).role).toBe("user");
      expect((result[0] as any).content[0].type).toBe("input_text");
      expect((result[0] as any).content[0].text).toBe("Hello");
    });

    test("should convert assistant message with text blocks", () => {
      const messages: ClaudeMessage[] = [
        {
          role: "assistant",
          content: [{ type: "text", text: "Hi there!" }],
        },
      ];
      const result = convertMessagesToInput(messages);
      expect(result.length).toBe(1);
      expect((result[0] as any).content[0].type).toBe("output_text");
    });

    test("should convert tool_use to function_call", () => {
      const messages: ClaudeMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_abc123",
              name: "exec_command",
              input: { cmd: "ls -la" },
            },
          ],
        },
      ];
      const result = convertMessagesToInput(messages);
      expect(result.length).toBe(1);
      expect(result[0]!.type).toBe("function_call");
      expect((result[0] as any).call_id).toBe("call_abc123");
      expect((result[0] as any).name).toBe("exec_command");
    });

    test("should convert web_search tool_use to web_search_call", () => {
      const messages: ClaudeMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_search123",
              name: "web_search",
              input: { query: "best audio transcription library" },
            },
          ],
        },
      ];
      const result = convertMessagesToInput(messages);
      expect(result.length).toBe(1);
      expect(result[0]!.type).toBe("web_search_call");
      expect((result[0] as any).status).toBe("completed");
      expect((result[0] as any).action).toEqual({ type: "search", query: "best audio transcription library" });
    });

    test("should convert tool_result to function_call_output", () => {
      const messages: ClaudeMessage[] = [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_abc123",
              content: "file1.txt\nfile2.txt",
            },
          ],
        },
      ];
      const result = convertMessagesToInput(messages);
      expect(result.length).toBe(1);
      expect(result[0]!.type).toBe("function_call_output");
      expect((result[0] as any).call_id).toBe("call_abc123");
    });

    test("should convert thinking to reasoning", () => {
      const messages: ClaudeMessage[] = [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Let me think about this...",
              signature: "sig_xyz",
            },
          ],
        },
      ];
      const result = convertMessagesToInput(messages);
      expect(result.length).toBe(1);
      expect(result[0]!.type).toBe("reasoning");
      expect((result[0] as any).summary[0].text).toBe("Let me think about this...");
      expect((result[0] as any).encrypted_content).toBeUndefined();
    });
  });

  describe("convertTools", () => {
    test("should convert client tools", () => {
      const tools: ClaudeTool[] = [
        {
          name: "exec_command",
          description: "Execute a command",
          input_schema: {
            type: "object",
            properties: { cmd: { type: "string" } },
          },
        },
      ];
      const result = convertTools(tools);
      expect(result).toBeDefined();
      expect(result!.length).toBe(1);
      expect(result![0]!.type).toBe("function");
      expect(result![0]!.name).toBe("exec_command");
    });

    test("should convert custom tools", () => {
      const tools: ClaudeTool[] = [
        {
          name: "apply_patch",
          description: "Apply a patch",
          input_schema: { type: "object", properties: {} },
        },
      ];
      const result = convertTools(tools);
      expect(result![0]!.type).toBe("custom");
      expect((result![0] as any).format).toBeDefined();
    });

    test("should convert web_search server tool", () => {
      const tools: ClaudeTool[] = [
        {
          type: "web_search_20250305",
          name: "web_search",
        },
      ];
      const result = convertTools(tools);
      expect(result![0]!.type).toBe("web_search");
    });

    test("should map TodoWrite to update_plan", () => {
      const tools: ClaudeTool[] = [
        {
          name: "TodoWrite",
          description: "Write todos to track progress",
          input_schema: {
            type: "object",
            properties: {
              todos: { type: "array" },
            },
          },
        },
      ];
      const result = convertTools(tools);
      expect(result).toBeDefined();
      expect(result!.length).toBe(1);
      expect(result![0]!.type).toBe("function");
      expect(result![0]!.name).toBe("update_plan");
    });
  });

  describe("convertRequest", () => {
    test("should convert full Claude request to Codex request", () => {
      const claude: ClaudeRequest = {
        model: "claude-3-opus-20240229",
        max_tokens: 4096,
        system: "You are a helpful assistant.",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      };
      
      const result = convertRequest(claude);
      
      expect(result.model).toBe("claude-3-opus-20240229");
      // 模型名称会被动态替换到 instructions 中（大写格式）
      expect(result.instructions).toContain("You are CLAUDE-3-OPUS-20240229 running in the Codex CLI");
      expect(result.input.length).toBe(1);
      expect(result.stream).toBe(true);
      // Note: max_output_tokens was removed from Codex API
    });

    test("should use target model from options", () => {
      const claude: ClaudeRequest = {
        model: "claude-3-opus-20240229",
        max_tokens: 1024,
        messages: [],
      };
      
      const result = convertRequest(claude, { targetModel: "gpt-4" });
      expect(result.model).toBe("gpt-4");
    });

    test("should degrade tool_choice tool to required and restrict tool list", () => {
      const claude: ClaudeRequest = {
        model: "claude-3-opus-20240229",
        max_tokens: 1024,
        stream: true,
        tool_choice: { type: "tool", name: "echo" },
        tools: [
          {
            name: "echo",
            description: "Echo input",
            input_schema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
          {
            name: "exec_command",
            description: "Execute a command",
            input_schema: {
              type: "object",
              properties: { cmd: { type: "string" } },
              required: ["cmd"],
            },
          },
        ],
        messages: [{ role: "user", content: "Hi" }],
      };

      const result = convertRequest(claude);
      expect(result.tool_choice).toBe("required");
      expect(result.tools?.length).toBe(1);
      expect((result.tools?.[0] as any)?.name).toBe("echo");
    });

    test("should handle tool_choice with mapped tool name (TodoWrite → update_plan)", () => {
      const claude: ClaudeRequest = {
        model: "claude-3-opus-20240229",
        max_tokens: 1024,
        stream: true,
        tool_choice: { type: "tool", name: "TodoWrite" },
        tools: [
          {
            name: "TodoWrite",
            description: "Write todos to track progress",
            input_schema: {
              type: "object",
              properties: {
                todos: { type: "array" },
              },
            },
          },
          {
            name: "exec_command",
            description: "Execute a command",
            input_schema: {
              type: "object",
              properties: { cmd: { type: "string" } },
              required: ["cmd"],
            },
          },
        ],
        messages: [{ role: "user", content: "Add a todo" }],
      };

      const result = convertRequest(claude);
      // 即使 TodoWrite 被映射为 update_plan，tool_choice 应该仍然有效
      expect(result.tool_choice).toBe("required");
      expect(result.tools?.length).toBe(1);
      // 工具名称应该已被映射为 update_plan
      expect((result.tools?.[0] as any)?.name).toBe("update_plan");
    });
  });

  describe("rewriteRequest", () => {
    test("should rewrite headers and body", () => {
      const headers = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-target-model": "codex-mini",
      };
      const body = JSON.stringify({
        model: "claude-3-opus-20240229",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hi" }],
      });
      
      const result = rewriteRequest({ headers, body });
      
      expect(result.body).toBeDefined();
      expect(result.headers).toBeDefined();
      
      const parsedBody = JSON.parse(result.body!);
      expect(parsedBody.model).toBe("codex-mini");
      // 模型名称会被动态替换到 instructions 中（大写格式）
      expect(parsedBody.instructions).toContain("You are CODEX-MINI running in the Codex CLI");
      expect(parsedBody.input.length).toBe(1);
    });

    test("should align request headers with Codex /responses style", () => {
      const headers = {
        "content-type": "application/json",
        "accept-encoding": "gzip, deflate, br, zstd",
        "anthropic-version": "2023-06-01",
        "user-agent": "claude-cli/2.0.75 (external, cli)",
        "x-target-model": "gpt-5.2",
      };
      const body = JSON.stringify({
        model: "claude-opus-4-5-20251101",
        max_tokens: 1024,
        metadata: {
          user_id: "user_xxx_account__session_5a68f501-e620-4ec6-858e-dba7a22bfe17",
        },
        messages: [{ role: "user", content: "Hi" }],
      });

      const result = rewriteRequest({ headers, body });
      const out = result.headers!;
      const parsedBody = JSON.parse(result.body!);

      expect(out["content-type"]).toBe("application/json");
      expect(out["accept"]).toBe("text/event-stream");

      // Align Codex identity headers for gateways/tooling.
      expect(out["user-agent"]).toBe("codex_cli_rs");
      expect(out["originator"]).toBe("codex_cli_rs");
      expect(out["x-codex-beta-features"]).toBe("unified_exec,shell_snapshot");
      expect(out["session_id"]).toBe("5a68f501-e620-4ec6-858e-dba7a22bfe17");
      expect(out["conversation_id"]).toBe("5a68f501-e620-4ec6-858e-dba7a22bfe17");

      // prompt_cache_key is now disabled to ensure accurate input_tokens reporting
      // When Codex uses prompt caching, it only reports new tokens, not cached ones
      // This breaks Claude Code's context management and summarization
      expect(parsedBody.prompt_cache_key).toBeUndefined();

      expect(out["anthropic-version"]).toBeUndefined();
      expect(out["accept-encoding"]).toBeUndefined();
      expect(out["x-target-model"]).toBeUndefined();
    });

    test("should set accept=application/json when stream is false", () => {
      const headers = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      };
      const body = JSON.stringify({
        model: "claude-opus-4-5-20251101",
        max_tokens: 128,
        stream: false,
        messages: [{ role: "user", content: "Hi" }],
      });

      const result = rewriteRequest({ headers, body });
      expect(result.headers?.["accept"]).toBe("application/json");

      const parsedBody = JSON.parse(result.body!);
      expect(parsedBody.stream).toBe(false);
    });

    test("should return empty for non-Claude request", () => {
      const result = rewriteRequest({
        headers: {},
        body: JSON.stringify({ foo: "bar" }),
      });
      expect(result.body).toBeUndefined();
    });
  });
});
