import { describe, expect, test } from "bun:test";
import {
  createConverterState,
  processCodexEvent,
  SSEStreamConverter,
  convertSSEResponse,
  convertErrorResponse,
  isCodexErrorResponse,
  isCodexSuccessResponse,
  convertSuccessResponse,
} from "../response-converter";
import type { CodexSSEResponseCreated, CodexSSEOutputTextDelta, CodexSSEResponseCompleted, CodexSSEOutputItemAdded, CodexSSEOutputItemDone, CodexSSEFunctionCallArgumentsDelta, CodexSSEError } from "../types";

describe("response-converter", () => {
  describe("createConverterState", () => {
    test("should create initial state", () => {
      const state = createConverterState();
      expect(state.messageId).toBe("");
      expect(state.contentBlockIndex).toBe(0);
      expect(state.currentBlockType).toBeNull();
      expect(state.messageStarted).toBe(false);
    });
  });

  describe("processCodexEvent", () => {
    test("should handle response.created event", () => {
      const state = createConverterState();
      const event: CodexSSEResponseCreated = {
        type: "response.created",
        sequence_number: 0,
        response: {
          id: "resp_abc123",
          object: "response",
          created_at: 1234567890,
          status: "in_progress",
          model: "codex-mini",
          output: [],
        },
      };

      const result = processCodexEvent(state, "response.created", event);

      expect(result.length).toBe(1);
      expect(result[0]).toContain("message_start");
      expect(state.messageId).toBe("msg_abc123");
      expect(state.model).toBe("codex-mini");
    });

    test("should handle response.output_text.delta event", () => {
      const state = createConverterState();
      state.messageStarted = true;
      
      const event: CodexSSEOutputTextDelta = {
        type: "response.output_text.delta",
        sequence_number: 1,
        item_id: "item_123",
        output_index: 0,
        content_index: 0,
        delta: "Hello",
      };

      const result = processCodexEvent(state, "response.output_text.delta", event);

      // Should contain content_block_start and content_block_delta
      expect(result.length).toBe(2);
      expect(result[0]).toContain("content_block_start");
      expect(result[1]).toContain("text_delta");
      expect(result[1]).toContain("Hello");
    });

    test("should handle response.completed event", () => {
      const state = createConverterState();
      state.messageStarted = true;
      
      const event: CodexSSEResponseCompleted = {
        type: "response.completed",
        sequence_number: 10,
        response: {
          id: "resp_abc123",
          status: "completed",
          model: "codex-mini",
          output: [],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
          },
        },
      };

      const result = processCodexEvent(state, "response.completed", event);

      expect(result.some(r => r.includes("message_delta"))).toBe(true);
      expect(result.some(r => r.includes("message_stop"))).toBe(true);
    });
  });

  describe("SSEStreamConverter", () => {
    test("should convert stream of events", () => {
      const converter = new SSEStreamConverter();
      
      const chunk1 = `event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_test","object":"response","created_at":1234567890,"status":"in_progress","model":"codex","output":[]}}

`;
      
      const result1 = converter.processChunk(chunk1);
      expect(result1).toContain("message_start");
      
      const chunk2 = `event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":1,"item_id":"item_1","output_index":0,"content_index":0,"delta":"Hi"}

`;
      
      const result2 = converter.processChunk(chunk2);
      expect(result2).toContain("text_delta");
    });

    test("should handle partial chunks", () => {
      const converter = new SSEStreamConverter();
      
      // Send partial chunk
      const result1 = converter.processChunk("event: response.cre");
      expect(result1).toBe("");
      
      // Complete the chunk
      const result2 = converter.processChunk(`ated
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_test","object":"response","created_at":1234567890,"status":"in_progress","model":"codex","output":[]}}

`);
      expect(result2).toContain("message_start");
    });
  });

  describe("convertSSEResponse", () => {
    test("should convert complete SSE response", () => {
      const codexSSE = `event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_123","object":"response","created_at":1234567890,"status":"in_progress","model":"codex","output":[]}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":1,"item_id":"item_1","output_index":0,"content_index":0,"delta":"Hello"}

event: response.completed
data: {"type":"response.completed","sequence_number":2,"response":{"id":"resp_123","status":"completed","model":"codex","output":[],"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}

`;
      
      const result = convertSSEResponse(codexSSE);
      
      expect(result).toContain("message_start");
      expect(result).toContain("text_delta");
      expect(result).toContain("message_stop");
    });
  });

  describe("error handling", () => {
    test("isCodexErrorResponse should detect error response with type:error", () => {
      expect(isCodexErrorResponse({
        type: "error",
        error: { type: "invalid_request", message: "Bad request" },
      })).toBe(true);

      expect(isCodexErrorResponse({ type: "success" })).toBe(false);
      expect(isCodexErrorResponse(null)).toBe(false);
    });

    test("isCodexErrorResponse should detect OpenAI-style error without top-level type", () => {
      // 标准 OpenAI 错误格式（没有顶层 type）
      expect(isCodexErrorResponse({
        error: { type: "rate_limit_error", message: "Rate limit exceeded" },
      })).toBe(true);

      expect(isCodexErrorResponse({
        error: { code: "insufficient_quota", message: "You exceeded your quota" },
      })).toBe(true);

      expect(isCodexErrorResponse({
        error: { message: "Something went wrong" },
      })).toBe(true);

      // 不应该匹配的情况
      expect(isCodexErrorResponse({
        error: {},  // 空 error 对象
      })).toBe(false);

      expect(isCodexErrorResponse({
        type: "response",  // 有其他顶层 type
        error: { message: "error" },
      })).toBe(false);
    });

    test("convertErrorResponse should convert Codex error format", () => {
      const codexError = {
        type: "error",
        error: {
          type: "rate_limit_exceeded",
          message: "Too many requests",
        },
      };

      const result = convertErrorResponse(codexError);

      expect(result).toEqual({
        type: "error",
        error: {
          type: "rate_limit_exceeded",
          message: "Too many requests",
        },
      });
    });

    test("convertErrorResponse should convert OpenAI-style error without top-level type", () => {
      // 标准 OpenAI 错误格式
      const openaiError = {
        error: {
          message: "Rate limit exceeded. Please try again in 10s.",
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
        },
      };

      const result = convertErrorResponse(openaiError);

      expect(result).toEqual({
        type: "error",
        error: {
          type: "rate_limit_error",
          message: "Rate limit exceeded. Please try again in 10s.",
        },
      });
    });

    test("convertErrorResponse should use code as type fallback", () => {
      const errorWithCode = {
        error: {
          code: "context_length_exceeded",
          message: "Maximum context length exceeded",
        },
      };

      const result = convertErrorResponse(errorWithCode);

      expect(result).toEqual({
        type: "error",
        error: {
          type: "context_length_exceeded",
          message: "Maximum context length exceeded",
        },
      });
    });

    test("should handle flattened SSE error event", () => {
      const converter = new SSEStreamConverter();

      const chunk = `event: error
data: {"code":"server_error","message":"OpenAI request failed","sequence_number":0,"type":"error"}

`;

      const result = converter.processChunk(chunk);

      expect(result).toContain("event:error");
      expect(result).toContain("\"type\":\"error\"");
      expect(result).toContain("\"server_error\"");
      expect(result).toContain("OpenAI request failed");
    });
  });

  describe("web_search_call handling", () => {
    test("should convert web_search_call to server_tool_use", () => {
      const state = createConverterState();
      state.messageStarted = true;

      const event: CodexSSEOutputItemAdded = {
        type: "response.output_item.added",
        sequence_number: 1,
        output_index: 0,
        item: {
          id: "ws_123",
          type: "web_search_call",
          status: "in_progress",
        },
      };

      // Add action with query manually (as the type doesn't include action)
      (event.item as unknown as { action: { type: string; query: string } }).action = {
        type: "search",
        query: "Claude API documentation",
      };

      const result = processCodexEvent(state, "response.output_item.added", event);

      expect(result.length).toBe(1);
      expect(result[0]).toContain("content_block_start");
      expect(result[0]).toContain("server_tool_use");
      expect(result[0]).toContain("web_search");
      expect(result[0]).toContain("Claude API documentation");
      expect(state.currentBlockType).toBe("server_tool_use");
      expect(state.webSearchCalls.length).toBe(1);
      expect(state.webSearchCalls[0]!.query).toBe("Claude API documentation");
    });

    test("should finish server_tool_use block on web_search_call done", () => {
      const state = createConverterState();
      state.messageStarted = true;
      state.currentBlockType = "server_tool_use";
      state.currentItemId = "ws_123";
      state.blockStarted = true;
      state.contentBlockIndex = 1;
      // 添加 web_search_call 状态
      state.webSearchCalls.push({
        itemId: "ws_123",
        toolUseId: "srvtoolu_test123",
        query: "test query",
        resultSent: false,
      });

      const event: CodexSSEOutputItemDone = {
        type: "response.output_item.done",
        sequence_number: 2,
        output_index: 0,
        item: {
          id: "ws_123",
          type: "web_search_call",
          status: "completed",
        },
      };

      const result = processCodexEvent(state, "response.output_item.done", event);

      // Should only have content_block_stop for server_tool_use
      // web_search_tool_result is deferred to response.completed
      expect(result.length).toBe(1);
      expect(result[0]).toContain("content_block_stop");

      // webSearchCalls should be preserved for response.completed to use
      expect(state.webSearchCalls[0]!.toolUseId).toBe("srvtoolu_test123");
      expect(state.webSearchCalls[0]!.resultSent).toBe(false);
    });

    test("should convert complete web search SSE response with url_citations", () => {
      const codexSSE = `event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_ws123","object":"response","created_at":1234567890,"status":"in_progress","model":"codex","output":[]}}

event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"ws_1","type":"web_search_call","status":"in_progress","action":{"type":"search","query":"latest news"}}}

event: response.output_item.done
data: {"type":"response.output_item.done","sequence_number":2,"output_index":0,"item":{"id":"ws_1","type":"web_search_call","status":"completed","action":{"type":"search","query":"latest news"}}}

event: response.output_text.annotation.added
data: {"type":"response.output_text.annotation.added","sequence_number":3,"item_id":"msg_1","output_index":1,"content_index":0,"annotation_index":0,"annotation":{"type":"url_citation","start_index":0,"end_index":50,"title":"Example News Site","url":"https://example.com/news"}}

event: response.completed
data: {"type":"response.completed","sequence_number":4,"response":{"id":"resp_ws123","status":"completed","model":"codex","output":[],"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}

`;

      const result = convertSSEResponse(codexSSE);

      expect(result).toContain("message_start");
      expect(result).toContain("server_tool_use");
      expect(result).toContain("web_search");
      expect(result).toContain("latest news");
      expect(result).toContain("web_search_tool_result");
      expect(result).toContain("https://example.com/news");
      expect(result).toContain("Example News Site");
      expect(result).toContain("message_stop");
    });

    test("should handle web search without url_citations", () => {
      const codexSSE = `event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_ws123","object":"response","created_at":1234567890,"status":"in_progress","model":"codex","output":[]}}

event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"ws_1","type":"web_search_call","status":"in_progress","action":{"type":"search","query":"test search"}}}

event: response.output_item.done
data: {"type":"response.output_item.done","sequence_number":2,"output_index":0,"item":{"id":"ws_1","type":"web_search_call","status":"completed"}}

event: response.completed
data: {"type":"response.completed","sequence_number":3,"response":{"id":"resp_ws123","status":"completed","model":"codex","output":[],"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}

`;

      const result = convertSSEResponse(codexSSE);

      expect(result).toContain("message_start");
      expect(result).toContain("server_tool_use");
      expect(result).toContain("web_search");
      expect(result).toContain("web_search_tool_result");
      expect(result).toContain("message_stop");
    });
  });

  describe("tool name mapping", () => {
    test("should map update_plan to TodoWrite in function_call", () => {
      const state = createConverterState();
      state.messageStarted = true;

      const event: CodexSSEOutputItemAdded = {
        type: "response.output_item.added",
        sequence_number: 1,
        output_index: 0,
        item: {
          id: "fc_123",
          type: "function_call",
          status: "in_progress",
          name: "update_plan",
          call_id: "call_abc123",
        },
      };

      const result = processCodexEvent(state, "response.output_item.added", event);

      expect(result.length).toBe(2); // content_block_start + empty input_json_delta
      expect(result[0]).toContain("content_block_start");
      expect(result[0]).toContain("tool_use");
      // Should be mapped from update_plan to TodoWrite
      expect(result[0]).toContain("TodoWrite");
      expect(result[0]).not.toContain("update_plan");
      expect(state.currentToolName).toBe("TodoWrite");
    });
  });

  describe("deferred function call handling", () => {
    test("should buffer function_call_arguments.delta when no output_item.added precedes", () => {
      const state = createConverterState();
      state.messageStarted = true;

      // Simulate receiving delta events without prior output_item.added
      const delta1 = {
        type: "response.function_call_arguments.delta" as const,
        sequence_number: 100,
        item_id: "fc_test123",
        output_index: 0,
        delta: '{"todos":',
      };

      const delta2 = {
        type: "response.function_call_arguments.delta" as const,
        sequence_number: 101,
        item_id: "fc_test123",
        output_index: 0,
        delta: '[]}',
      };

      // These should be buffered, not emitted immediately
      const result1 = processCodexEvent(state, "response.function_call_arguments.delta", delta1);
      const result2 = processCodexEvent(state, "response.function_call_arguments.delta", delta2);

      expect(result1.length).toBe(0);
      expect(result2.length).toBe(0);
      expect(state.pendingFunctionCalls.has("fc_test123")).toBe(true);
      expect(state.pendingFunctionCalls.get("fc_test123")!.arguments).toBe('{"todos":[]}');
    });

    test("should emit buffered function call on output_item.done", () => {
      const state = createConverterState();
      state.messageStarted = true;

      // Buffer some arguments first
      state.pendingFunctionCalls.set("fc_test456", {
        outputIndex: 0,
        arguments: '{"todos":[{"content":"Test","status":"pending","activeForm":"Testing"}]}',
      });

      // Now receive output_item.done with function details
      const doneEvent: CodexSSEOutputItemDone = {
        type: "response.output_item.done",
        sequence_number: 200,
        output_index: 0,
        item: {
          id: "fc_test456",
          type: "function_call",
          status: "completed",
          name: "update_plan",
          call_id: "call_xyz789",
        },
      };

      const result = processCodexEvent(state, "response.output_item.done", doneEvent);

      // Should emit content_block_start, content_block_delta, content_block_stop
      expect(result.length).toBe(3);
      expect(result[0]).toContain("content_block_start");
      expect(result[0]).toContain("tool_use");
      expect(result[0]).toContain("TodoWrite"); // Mapped from update_plan
      expect(result[1]).toContain("input_json_delta");
      expect(result[1]).toContain("todos");
      expect(result[2]).toContain("content_block_stop");
      expect(state.hasToolUse).toBe(true);
      expect(state.pendingFunctionCalls.has("fc_test456")).toBe(false);
    });

    test("should emit buffered function call on response.completed when no output_item.done", () => {
      const state = createConverterState();
      state.messageStarted = true;

      // Buffer some arguments first (simulating delta events without output_item.done)
      state.pendingFunctionCalls.set("fc_complete789", {
        outputIndex: 0,
        arguments: '{"todos":[{"content":"Complete test","status":"in_progress","activeForm":"Completing test"}]}',
      });

      // Now receive response.completed with function info in output array
      const completedEvent: CodexSSEResponseCompleted = {
        type: "response.completed",
        sequence_number: 500,
        response: {
          id: "resp_test",
          status: "completed",
          model: "gpt-5",
          output: [
            {
              id: "fc_complete789",
              type: "function_call",
              name: "update_plan",
              call_id: "call_complete123",
              status: "completed",
            },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
          },
        },
      };

      const result = processCodexEvent(state, "response.completed", completedEvent);

      // Should include: tool_use content_block_start, delta, stop, then message_delta, message_stop
      expect(result.some(r => r.includes("content_block_start") && r.includes("tool_use"))).toBe(true);
      expect(result.some(r => r.includes("TodoWrite"))).toBe(true);
      expect(result.some(r => r.includes("input_json_delta"))).toBe(true);
      expect(result.some(r => r.includes("content_block_stop"))).toBe(true);
      expect(result.some(r => r.includes("message_stop"))).toBe(true);
      expect(state.hasToolUse).toBe(true);
      expect(state.pendingFunctionCalls.has("fc_complete789")).toBe(false);
    });
  });

  describe("Error handling with context window", () => {
    test("should set large input_tokens for context window exceeded error", () => {
      const state = createConverterState();
      state.messageStarted = true;

      const errorEvent: CodexSSEError = {
        type: "error" as const,
        error: {
          type: "invalid_request_error",
          message: "Your input exceeds the context window of this model. Please adjust your input and try again.",
        },
      };

      const result = processCodexEvent(state, "error", errorEvent);

      // Should emit error, message_delta with usage, and message_stop
      expect(result.length).toBe(3);
      expect(result[0]).toContain("error");
      expect(result[0]).toContain("invalid_request_error");
      expect(result[1]).toContain("message_delta");
      expect(result[1]).toContain('"input_tokens":200000'); // Large value for context window error
      expect(result[2]).toContain("message_stop");
    });

    test("should keep input_tokens as 0 for non-context errors", () => {
      const state = createConverterState();
      state.messageStarted = true;

      const errorEvent: CodexSSEError = {
        type: "error" as const,
        error: {
          type: "server_error",
          message: "Internal server error",
        },
      };

      const result = processCodexEvent(state, "error", errorEvent);

      // Should emit error, message_delta, and message_stop
      expect(result.length).toBe(3);
      expect(result[0]).toContain("error");
      expect(result[1]).toContain("message_delta");
      expect(result[1]).toContain('"input_tokens":0'); // Keep as 0 for non-context errors
      expect(result[2]).toContain("message_stop");
    });

    test("should detect various context window error messages", () => {
      const contextWindowMessages = [
        "context window exceeded",
        "context length exceeded",
        "input exceeds the limit",
        "too many tokens in the request",
        "token limit exceeded",
      ];

      for (const message of contextWindowMessages) {
        const state = createConverterState();
        state.messageStarted = true;

        const errorEvent: CodexSSEError = {
          type: "error" as const,
          error: {
            type: "invalid_request_error",
            message,
          },
        };

        const result = processCodexEvent(state, "error", errorEvent);
        expect(result[1]).toContain('"input_tokens":200000');
      }
    });
  });

  describe("Stream interruption handling", () => {
    test("should generate message_stop when stream is interrupted (no response.completed)", () => {
      // 模拟上游流中断的情况：有 response.created 和一些 output_text.delta，但没有 response.completed
      const incompleteSSE = `event:response.created
data:{"type":"response.created","sequence_number":0,"response":{"id":"resp_abc123","object":"response","created_at":1700000000,"status":"in_progress","model":"gpt-5.2","output":[]}}

event:response.output_item.added
data:{"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"msg_xyz","type":"message","role":"assistant","content":[]}}

event:response.content_part.added
data:{"type":"response.content_part.added","sequence_number":2,"output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}

event:response.output_text.delta
data:{"type":"response.output_text.delta","sequence_number":3,"item_id":"msg_xyz","output_index":0,"content_index":0,"delta":"Hello"}

event:response.output_text.delta
data:{"type":"response.output_text.delta","sequence_number":4,"item_id":"msg_xyz","output_index":0,"content_index":0,"delta":" world"}

`;
      // 注意：没有 response.completed 事件，流在中途中断

      const result = convertSSEResponse(incompleteSSE);

      // 应该包含 message_start
      expect(result).toContain("event:message_start");
      // 应该包含文本内容
      expect(result).toContain("Hello");
      expect(result).toContain(" world");
      // 即使流中断，也应该生成 message_delta 和 message_stop
      expect(result).toContain("event:message_delta");
      expect(result).toContain("event:message_stop");
      expect(result).toContain('"stop_reason":"end_turn"');
    });

    test("should use stop_reason tool_use when stream is interrupted with pending tool calls", () => {
      // 模拟流中断时有工具调用的情况
      const incompleteSSEWithToolUse = `event:response.created
data:{"type":"response.created","sequence_number":0,"response":{"id":"resp_abc123","object":"response","created_at":1700000000,"status":"in_progress","model":"gpt-5.2","output":[]}}

event:response.output_item.added
data:{"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"fc_123","type":"function_call","name":"exec_command","call_id":"call_abc","status":"in_progress"}}

event:response.function_call_arguments.delta
data:{"type":"response.function_call_arguments.delta","sequence_number":2,"item_id":"fc_123","output_index":0,"delta":"{\\"cmd\\":"}

event:response.function_call_arguments.delta
data:{"type":"response.function_call_arguments.delta","sequence_number":3,"item_id":"fc_123","output_index":0,"delta":"\\"ls\\"}"}

`;
      // 注意：没有 response.completed 事件，流在工具调用后中断

      const result = convertSSEResponse(incompleteSSEWithToolUse);

      // 应该包含 message_start
      expect(result).toContain("event:message_start");
      // 应该包含 tool_use 块
      expect(result).toContain("content_block_start");
      expect(result).toContain('"type":"tool_use"');
      // 流中断时，如果有工具调用，stop_reason 应该是 tool_use
      expect(result).toContain("event:message_delta");
      expect(result).toContain("event:message_stop");
      expect(result).toContain('"stop_reason":"tool_use"');
      // 不应该是 end_turn
      expect(result).not.toContain('"stop_reason":"end_turn"');
    });

    test("should not duplicate message_stop when stream completes normally", () => {
      const completeSSE = `event:response.created
data:{"type":"response.created","sequence_number":0,"response":{"id":"resp_abc123","object":"response","created_at":1700000000,"status":"in_progress","model":"gpt-5.2","output":[]}}

event:response.output_item.added
data:{"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"msg_xyz","type":"message","role":"assistant","content":[]}}

event:response.content_part.added
data:{"type":"response.content_part.added","sequence_number":2,"output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}

event:response.output_text.delta
data:{"type":"response.output_text.delta","sequence_number":3,"item_id":"msg_xyz","output_index":0,"content_index":0,"delta":"Hi"}

event:response.completed
data:{"type":"response.completed","sequence_number":4,"response":{"id":"resp_abc123","object":"response","created_at":1700000000,"status":"completed","model":"gpt-5.2","output":[{"id":"msg_xyz","type":"message","role":"assistant","content":[{"type":"output_text","text":"Hi"}]}],"usage":{"input_tokens":10,"output_tokens":5}}}

`;

      const result = convertSSEResponse(completeSSE);

      // 应该只有一个 message_stop
      const messageStopCount = (result.match(/event:message_stop/g) || []).length;
      expect(messageStopCount).toBe(1);
    });
  });

  describe("non-streaming success response (stream: false)", () => {
    test("isCodexSuccessResponse should detect success response", () => {
      expect(isCodexSuccessResponse({
        id: "resp_abc123",
        object: "response",
        status: "completed",
        model: "gpt-5.2",
        output: [],
        usage: { input_tokens: 10, output_tokens: 5 },
      })).toBe(true);

      expect(isCodexSuccessResponse({
        object: "response",
        status: "in_progress",
        output: [],
      })).toBe(true);

      // 不应该匹配的情况
      expect(isCodexSuccessResponse({
        object: "response",
        status: "completed",
        // 缺少 output
      })).toBe(false);

      expect(isCodexSuccessResponse({
        type: "error",
        error: { message: "error" },
      })).toBe(false);

      expect(isCodexSuccessResponse(null)).toBe(false);
    });

    test("convertSuccessResponse should convert text message", () => {
      const codexResponse = {
        id: "resp_abc123",
        object: "response",
        status: "completed",
        model: "gpt-5.2",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "Hello, world!" },
            ],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      };

      const result = convertSuccessResponse(codexResponse) as {
        id: string;
        type: string;
        role: string;
        model: string;
        content: { type: string; text: string }[];
        stop_reason: string;
        usage: { input_tokens: number; output_tokens: number };
      };

      expect(result).not.toBeNull();
      expect(result.id).toBe("msg_abc123");
      expect(result.type).toBe("message");
      expect(result.role).toBe("assistant");
      expect(result.model).toBe("gpt-5.2");
      expect(result.content).toEqual([{ type: "text", text: "Hello, world!" }]);
      expect(result.stop_reason).toBe("end_turn");
      expect(result.usage.input_tokens).toBe(10);
      expect(result.usage.output_tokens).toBe(5);
    });

    test("convertSuccessResponse should convert function_call to tool_use", () => {
      const codexResponse = {
        id: "resp_abc123",
        object: "response",
        status: "completed",
        model: "gpt-5.2",
        output: [
          {
            type: "function_call",
            id: "fc_123",
            call_id: "call_xyz",
            name: "update_plan",
            arguments: '{"todos":[]}',
          },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
      };

      const result = convertSuccessResponse(codexResponse) as {
        content: { type: string; id: string; name: string; input: Record<string, unknown> }[];
        stop_reason: string;
      };

      expect(result).not.toBeNull();
      expect(result.content.length).toBe(1);
      expect(result.content[0]!.type).toBe("tool_use");
      expect(result.content[0]!.id).toBe("toolu_xyz");  // call_xyz -> toolu_xyz
      expect(result.content[0]!.name).toBe("TodoWrite");  // update_plan -> TodoWrite
      expect(result.content[0]!.input).toEqual({ todos: [] });
      expect(result.stop_reason).toBe("tool_use");
    });

    test("convertSuccessResponse should convert reasoning to thinking", () => {
      const codexResponse = {
        id: "resp_abc123",
        object: "response",
        status: "completed",
        model: "gpt-5.2",
        output: [
          {
            type: "reasoning",
            id: "rs_123",
            summary: [
              { type: "summary_text", text: "Let me think about this..." },
            ],
          },
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "Here is my answer." },
            ],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 30 },
      };

      const result = convertSuccessResponse(codexResponse) as {
        content: { type: string; thinking?: string; text?: string }[];
      };

      expect(result).not.toBeNull();
      expect(result.content.length).toBe(2);
      expect(result.content[0]!.type).toBe("thinking");
      expect(result.content[0]!.thinking).toBe("Let me think about this...");
      expect(result.content[1]!.type).toBe("text");
      expect(result.content[1]!.text).toBe("Here is my answer.");
    });

    test("convertSuccessResponse should return null for non-success response", () => {
      expect(convertSuccessResponse({
        type: "error",
        error: { message: "error" },
      })).toBeNull();

      expect(convertSuccessResponse(null)).toBeNull();
    });
  });
});
