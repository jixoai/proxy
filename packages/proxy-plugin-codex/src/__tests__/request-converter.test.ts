import { describe, it, expect } from "bun:test";
import { convertRequest, mergeInputToMessages } from "../request-converter";
import type { CodexRequest, CodexResponseItem, CodexTool } from "../types";

describe("request-converter", () => {
  it("converts tools: wraps apply_patch, adds TodoWrite alias, omits web_search", () => {
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
    expect(toolNames).toContain("TodoWrite");
    expect(toolNames).not.toContain("WebSearch");

    const applyPatchTool = claude.tools?.find((t) => t.name === "apply_patch");
    expect((applyPatchTool?.input_schema as any)?.properties?.patch).toBeDefined();
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

  it("converts input items: apply_patch → tool_use.patch, web_search_call → text context", () => {
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

    const messages = mergeInputToMessages(input);
    expect(messages[0]?.role).toBe("user");
    expect(messages[1]?.role).toBe("assistant");

    const assistantBlocks = Array.isArray(messages[1]?.content) ? messages[1]!.content : [];
    const toolUse = assistantBlocks.find((b) => b.type === "tool_use");
    expect(toolUse).toBeDefined();
    expect((toolUse as { name?: string }).name).toBe("apply_patch");
    expect((toolUse as { input?: unknown }).input).toEqual({ patch });

    const webSearchText = assistantBlocks.find((b) => b.type === "text" && "text" in b && b.text.includes("[web_search]"));
    expect(webSearchText).toBeDefined();
  });
});
