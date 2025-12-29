import { describe, it, expect } from "bun:test";
import { convertRequest, convertInputToMessages } from "../request-converter";
import type { CodexRequest, CodexResponseItem, CodexTool } from "../types";

describe("request-converter", () => {
  it("converts tools: preserves tool names, maps web_search to Claude server tool, wraps custom tools with input:string", () => {
    const tools: CodexTool[] = [
      { type: "custom", name: "apply_patch", description: "Apply a patch" },
      { type: "web_search" },
      {
        type: "function",
        name: "update_plan",
        description: "Updates the task plan.",
        parameters: {
          type: "object",
          properties: {
            plan: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  step: { type: "string" },
                  status: { type: "string" },
                },
                required: ["step", "status"],
                additionalProperties: false,
              },
            },
          },
          required: ["plan"],
          additionalProperties: false,
        },
      },
    ];

    const codex: CodexRequest = {
      model: "gpt-5.2",
      instructions: "test",
      input: [],
      tools,
      tool_choice: "auto",
      stream: true,
    };

    const claude = convertRequest(codex);
    const toolNames = claude.tools?.map((t) => t.name) ?? [];

    expect(toolNames).toContain("apply_patch");
    expect(toolNames).toContain("update_plan");
    expect(toolNames).toContain("web_search");
    expect(toolNames).not.toContain("WebSearch");

    const webSearchTool = claude.tools?.find((t) => t.name === "web_search");
    expect(webSearchTool && "type" in webSearchTool).toBe(true);
    expect(webSearchTool && "type" in webSearchTool ? webSearchTool.type : null).toBe("web_search_20250305");

    const applyPatchTool = claude.tools?.find((t) => t.name === "apply_patch");
    expect(applyPatchTool && "input_schema" in applyPatchTool).toBe(true);
    expect(applyPatchTool && "input_schema" in applyPatchTool ? (applyPatchTool.input_schema as any)?.properties?.input : null).toBeDefined();
  });

  it("does not set tool_choice even for multi-step prompts", () => {
    const codex: CodexRequest = {
      model: "gpt-5.2",
      instructions: "test",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Please do these:\n1. step one\n2. step two\nThen run tests.",
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "update_plan",
          description: "Updates the task plan.",
          parameters: {
            type: "object",
            properties: {
              plan: { type: "array" },
            },
            required: ["plan"],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: "auto",
      stream: true,
    };

    const claude = convertRequest(codex);
    expect(claude.tool_choice).toBeUndefined();
  });

  it("does not set tool_choice when plan exists in history", () => {
    const codex: CodexRequest = {
      model: "gpt-5.2",
      instructions: "test",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Refactor this module." }],
        },
        {
          type: "function_call",
          name: "update_plan",
          arguments: "{\"plan\":[{\"step\":\"x\",\"status\":\"in_progress\"}]}",
          call_id: "call_plan",
        },
      ],
      tools: [
        {
          type: "function",
          name: "update_plan",
          description: "Updates the task plan.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
      tool_choice: "auto",
      stream: true,
    };

    const claude = convertRequest(codex);
    expect(claude.tool_choice).toBeUndefined();
  });

  it("converts input items: apply_patch → tool_use.input, web_search_call → text context", () => {
    const patch = "*** Begin Patch\n*** End Patch";

    const input: CodexResponseItem[] = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      },
      {
        type: "custom_tool_call",
        name: "apply_patch",
        call_id: "call_123",
        input: patch,
      },
      {
        type: "web_search_call",
        action: { type: "search", query: "bun test" },
      },
    ];

    const messages = convertInputToMessages(input);
    expect(messages[0]?.role).toBe("user");
    expect(messages[1]?.role).toBe("assistant");

    const toolUseBlocks = Array.isArray(messages[1]?.content) ? messages[1]!.content : [];
    const toolUse = toolUseBlocks.find((b) => b.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect((toolUse as { name?: string }).name).toBe("apply_patch");
    expect((toolUse as { input?: unknown }).input).toEqual({ input: patch });

    // web_search_call becomes an assistant text message (separate message, no merging)
    expect(messages[2]?.role).toBe("assistant");
    const webSearchBlocks = Array.isArray(messages[2]?.content) ? messages[2]!.content : [];
    const webSearchText = webSearchBlocks.find(
      (b) => b.type === "text" && "text" in b && b.text.includes("[web_search]")
    );
    expect(webSearchText).toBeDefined();
  });

  it("converts function_call_output content items (input_text + input_image) into Claude tool_result content blocks", () => {
    const input: CodexResponseItem[] = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      },
      {
        type: "function_call",
        name: "take_screenshot",
        arguments: "{}",
        call_id: "call_1",
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          { type: "input_text", text: "ok" },
          { type: "input_image", image_url: "data:image/png;base64,AA==" },
        ],
      },
    ];

    const messages = convertInputToMessages(input);
    expect(messages.length).toBe(3);

    // tool_result should be on the user side (tool output)
    expect(messages[2]?.role).toBe("user");
    const blocks = Array.isArray(messages[2]?.content) ? messages[2]!.content : [];
    const toolResult = blocks.find((b) => b.type === "tool_result") as any;
    expect(toolResult).toBeDefined();
    expect(toolResult.tool_use_id).toBe("toolu_1");

    const content = toolResult.content as any;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: "text", text: "ok" });
    expect(content[1]?.type).toBe("image");
    expect(content[1]?.source?.type).toBe("base64");
    expect(content[1]?.source?.media_type).toBe("image/png");
    expect(content[1]?.source?.data).toBe("AA==");
  });

  it("applies prompt caching like droid (system + up to 3 message breakpoints)", () => {
    const codex: CodexRequest = {
      model: "gpt-5.2",
      instructions: "test",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
        {
          type: "function_call",
          name: "exec_command",
          arguments: "{\"cmd\":\"ls\"}",
          call_id: "call_1",
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "ok",
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "next" }],
        },
      ],
      tool_choice: "auto",
      stream: true,
    };

    const claude = convertRequest(codex);

    // System cache breakpoint still exists
    expect(Array.isArray(claude.system)).toBe(true);
    if (Array.isArray(claude.system)) {
      expect(claude.system.some((b) => Boolean((b as any).cache_control))).toBe(true);
    }

    // Message breakpoints (like droid):
    // - last assistant tool_use
    // - last user tool_result
    // - last user text (warm cache for next turn)
    const cached: Array<{ role: string; type: string; text?: string }> = [];
    for (const m of claude.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (!(b as any).cache_control) continue;
        cached.push({ role: m.role, type: b.type, text: (b as any).text });
      }
    }

    expect(cached.some((c) => c.role === "assistant" && c.type === "tool_use")).toBe(true);
    expect(cached.some((c) => c.role === "user" && c.type === "tool_result")).toBe(true);
    expect(cached.some((c) => c.role === "user" && c.type === "text" && c.text === "next")).toBe(true);
  });
});
