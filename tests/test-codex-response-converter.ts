/**
 * Test: Codex response converter - verify encrypted_content is preserved
 */

import { convertSSEResponse } from "../packages/proxy-plugin-codex/src/response-converter";

// Sample Claude SSE response with thinking block
const claudeSSE = `event: message_start
data: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","model":"claude-opus-4-5-20251101","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":100,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":"EtECCkYICxgCKkDLb0a2CDEl9hlgwHqil7gKOpYFP5RO8desZzV/real_signature"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"I need to analyze this request..."}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_abc123","name":"Bash","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":": \\"ls -la\\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"input_tokens":100,"output_tokens":50}}

event: message_stop
data: {"type":"message_stop"}
`;

console.log("=== Testing Claude SSE to Codex SSE conversion ===\n");

const codexSSE = convertSSEResponse(claudeSSE);

console.log("--- Converted Codex SSE events ---\n");
console.log(codexSSE);

// Parse the events to check for encrypted_content
const events = codexSSE.split("\n\n").filter(e => e.trim());

console.log("\n--- Checking for encrypted_content in reasoning output items ---\n");

for (const eventBlock of events) {
  const lines = eventBlock.split("\n");
  const eventLine = lines.find(l => l.startsWith("event:"));
  const dataLine = lines.find(l => l.startsWith("data:"));
  
  if (!eventLine || !dataLine) continue;
  
  const eventType = eventLine.replace("event:", "").trim();
  const dataStr = dataLine.replace("data:", "").trim();
  
  try {
    const data = JSON.parse(dataStr);
    
    // Check output_item.added and output_item.done for reasoning items
    if (eventType === "response.output_item.added" || eventType === "response.output_item.done") {
      const item = data.item;
      if (item?.type === "reasoning") {
        console.log(`Event: ${eventType}`);
        console.log(`  - id: ${item.id}`);
        console.log(`  - type: ${item.type}`);
        console.log(`  - status: ${item.status}`);
        console.log(`  - encrypted_content: ${item.encrypted_content ? "PRESENT ✓" : "MISSING ✗"}`);
        if (item.encrypted_content) {
          console.log(`  - encrypted_content value: "${item.encrypted_content.substring(0, 50)}..."`);
        }
        console.log();
      }
    }
    
    // Check completed response
    if (eventType === "response.completed") {
      console.log(`Event: response.completed`);
      console.log(`  - output items count: ${data.response?.output?.length || 0}`);
      for (const item of data.response?.output || []) {
        if (item.type === "reasoning") {
          console.log(`  - reasoning item encrypted_content: ${item.encrypted_content ? "PRESENT ✓" : "MISSING ✗"}`);
        }
        if (item.type === "function_call") {
          console.log(`  - function_call item: name=${item.name}, call_id=${item.call_id}`);
        }
      }
    }
  } catch (e) {
    // Skip parse errors
  }
}
