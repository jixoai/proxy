/**
 * Test: Codex function_call conversion
 * 
 * Debug why second requests with function_call items fail
 */

import { rewriteRequest } from "../packages/proxy-plugin-codex/src/request-converter";

// Sample Codex request with function_call items (similar to failed request 4721)
const codexRequestWithFunctionCall = {
  model: "gpt-5.2",
  instructions: "You are GPT-5.2 running in the Codex CLI, a terminal-based coding assistant.\n\nSystem instructions here...",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "List files" }]
    },
    {
      type: "reasoning",
      id: "rs_123",
      summary: [{ type: "summary_text", text: "I'll list the files" }],
      encrypted_content: "EtECCkYICxgCKkDLb0a2CDEl9hlgwHqil7gKOpYFP5RO8desZzV/sample_signature_data"
    },
    {
      type: "function_call",
      call_id: "call_abc123",
      name: "exec_command",
      arguments: "{\"cmd\":\"ls -la\",\"yield_time_ms\":100000}"
    },
    {
      type: "function_call_output",
      call_id: "call_abc123",
      output: "total 64\ndrwxr-xr-x  15 user  staff   480 Dec 28 10:00 .\ndrwxr-xr-x   5 user  staff   160 Dec 28 09:00 ..\n-rw-r--r--   1 user  staff  1234 Dec 28 10:00 file1.txt"
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Here are the files..." }]
    },
    {
      type: "function_call",
      call_id: "call_def456",
      name: "exec_command",
      arguments: "{\"cmd\":\"cat file1.txt\",\"yield_time_ms\":100000}"
    },
    {
      type: "function_call_output",
      call_id: "call_def456",
      output: "This is the content of file1.txt\nLine 2\nLine 3"
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Now create a new file" }]
    }
  ],
  tools: [
    {
      type: "function",
      name: "exec_command",
      description: "Execute a command",
      parameters: {
        type: "object",
        properties: {
          cmd: { type: "string" },
          yield_time_ms: { type: "number" }
        }
      }
    }
  ],
  reasoning: { effort: "high", summary: "auto" },
  stream: true
};

const headers = {
  "content-type": "application/json",
  "authorization": "Bearer sk-xxx"
};

console.log("=== Testing Codex function_call conversion ===\n");

const result = rewriteRequest({
  headers,
  body: JSON.stringify(codexRequestWithFunctionCall)
});

if (result.body) {
  console.log("Body length:", result.body.length, "bytes");
  
  // Verify it's valid JSON
  try {
    const parsed = JSON.parse(result.body);
    console.log("JSON parse: OK");
    console.log("\n--- Parsed body structure ---");
    console.log("model:", parsed.model);
    console.log("max_tokens:", parsed.max_tokens);
    console.log("stream:", parsed.stream);
    console.log("system blocks:", parsed.system?.length);
    console.log("messages count:", parsed.messages?.length);
    console.log("tools count:", parsed.tools?.length);
    console.log("thinking:", JSON.stringify(parsed.thinking));
    console.log("metadata:", JSON.stringify(parsed.metadata));
    
    console.log("\n--- Messages ---");
    for (const msg of parsed.messages || []) {
      console.log(`  [${msg.role}] content blocks: ${msg.content?.length}`);
      for (const block of msg.content || []) {
        if (block.type === "text") {
          console.log(`    - text: "${block.text.substring(0, 50)}..."`);
        } else if (block.type === "tool_use") {
          console.log(`    - tool_use: id=${block.id}, name=${block.name}`);
        } else if (block.type === "tool_result") {
          console.log(`    - tool_result: tool_use_id=${block.tool_use_id}`);
        } else if (block.type === "thinking") {
          console.log(`    - thinking: "${block.thinking.substring(0, 50)}..."`);
        } else {
          console.log(`    - ${block.type}: ${JSON.stringify(block).substring(0, 80)}...`);
        }
      }
    }
    
    console.log("\n--- Full converted body ---");
    console.log(JSON.stringify(parsed, null, 2));
  } catch (e) {
    console.error("JSON parse FAILED:", e);
    console.log("\n--- Raw body (first 2000 chars) ---");
    console.log(result.body.substring(0, 2000));
    console.log("\n--- Raw body (last 500 chars) ---");
    console.log(result.body.substring(result.body.length - 500));
  }
} else {
  console.log("No body returned from conversion");
}

console.log("\n--- Headers ---");
console.log(JSON.stringify(result.headers, null, 2));
