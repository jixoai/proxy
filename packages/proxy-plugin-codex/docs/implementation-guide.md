# Codex → Claude 转换实现指南

> 完整记录 `@jixo/proxy-plugin-codex` 的实现过程、问题解决和技术细节

---

## 目录

1. [项目概述](#1-项目概述)
2. [核心转换逻辑](#2-核心转换逻辑)
3. [请求转换详解](#3-请求转换详解)
4. [响应转换详解](#4-响应转换详解)
5. [遇到的问题与解决方案](#5-遇到的问题与解决方案)
6. [Headers 伪装](#6-headers-伪装)
7. [工具映射](#7-工具映射)
8. [配置说明](#8-配置说明)
9. [调试技巧](#9-调试技巧)

---

## 1. 项目概述

### 1.1 目标

将 OpenAI Codex CLI 的 Responses API 请求转换为 Anthropic Claude Messages API，使 Codex CLI 能够使用 Claude 模型作为后端。

### 1.2 架构

```
Codex CLI
    ↓ (Responses API)
Proxy Server (port 20002)
    ↓ (hook: proxy-plugin-codex)
Request Converter (Codex → Claude)
    ↓ (Messages API)
Claude API (88code.wu.ren)
    ↓ (SSE Response)
Response Converter (Claude → Codex)
    ↓ (Responses SSE)
Codex CLI
```

### 1.3 关键文件

| 文件 | 作用 |
|-----|------|
| `src/plugin.ts` | 插件入口，处理 request/response hooks |
| `src/request-converter.ts` | 请求转换逻辑 |
| `src/response-converter.ts` | SSE 响应转换逻辑 |
| `src/constants.ts` | 常量定义（工具映射、headers 等） |
| `src/types.ts` | TypeScript 类型定义 |

---

## 2. 核心转换逻辑

### 2.1 请求结构对比

**Codex Responses API 请求：**
```json
{
  "model": "gpt-5.2",
  "instructions": "You are GPT-5.2 running in the Codex CLI...",
  "input": [
    { "type": "message", "role": "user", "content": [...] },
    { "type": "reasoning", "summary": [...], "encrypted_content": "..." },
    { "type": "function_call", "name": "exec_command", "arguments": "...", "call_id": "..." },
    { "type": "function_call_output", "call_id": "...", "output": "..." }
  ],
  "tools": [...],
  "reasoning": { "effort": "xhigh", "summary": "auto" },
  "stream": true
}
```

**Claude Messages API 请求：**
```json
{
  "model": "claude-opus-4-5-20251101",
  "max_tokens": 32000,
  "system": [
    { "type": "text", "text": "You are Claude Code..." },
    { "type": "text", "text": "<codex-system-context>...</codex-system-context>", "cache_control": { "type": "ephemeral" } }
  ],
  "messages": [
    { "role": "user", "content": [{ "type": "text", "text": "..." }] },
    { "role": "assistant", "content": [{ "type": "thinking", ... }, { "type": "tool_use", ... }] },
    { "role": "user", "content": [{ "type": "tool_result", ... }] }
  ],
  "tools": [...],
  "thinking": { "type": "enabled", "budget_tokens": 32768 },
  "stream": true,
  "metadata": { "user_id": "..." }
}
```

### 2.2 响应结构对比

**Claude SSE 事件：**
```
event: message_start
event: content_block_start (thinking/tool_use/text)
event: content_block_delta (thinking_delta/input_json_delta/text_delta/signature_delta)
event: content_block_stop
event: message_delta
event: message_stop
```

**Codex SSE 事件：**
```
event: response.created
event: response.in_progress
event: response.output_item.added
event: response.reasoning_summary_text.delta
event: response.function_call_arguments.delta
event: response.output_text.delta
event: response.output_item.done
event: response.completed
```

---

## 3. 请求转换详解

### 3.1 模型选择

**不使用硬编码映射**，模型通过 proxy 配置的 `x-target-model` header 指定：

```typescript
export function mapModel(model: string, targetModelFromHeader?: string): string {
  // 优先使用 header 指定的模型
  if (targetModelFromHeader) {
    return targetModelFromHeader;
  }
  // 直接透传请求中的 model
  return model;
}
```

**配置示例：**
```json
{
  "headers": {
    "x-target-model": "claude-opus-4-5-20251101"
  }
}
```

### 3.2 Instructions 转换

将 Codex 的 GPT 身份描述替换为 Claude Code 身份：

```typescript
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

export function convertInstructions(instructions: string): string {
  let result = instructions;
  
  // 移除 GPT 身份描述（包括整个句子）
  result = result.replace(
    /You are GPT-[\d.]+ running in the Codex CLI[^.]*\.\s*/g,
    ""
  );
  
  // 替换 OpenAI 相关描述
  result = result.replace(
    /Codex CLI is an open source project led by OpenAI/g,
    "Codex CLI is an open source project"
  );
  
  return result.trim();
}
```

### 3.3 System Blocks 构建

使用两个 system block，第二个启用 ephemeral cache：

```typescript
export function buildSystemBlocks(instructions: string): SystemBlock[] {
  return [
    {
      type: "text",
      text: CLAUDE_CODE_IDENTITY,  // 短文本，不缓存
    },
    {
      type: "text",
      text: `<codex-system-context>\n${convertedInstructions}\n</codex-system-context>`,
      cache_control: { type: "ephemeral" },  // 长文本，使用缓存
    },
  ];
}
```

### 3.4 Input Items 转换

#### 角色推断

```typescript
function inferRole(item: CodexResponseItem): "user" | "assistant" {
  switch (item.type) {
    case "message":
      return item.role as "user" | "assistant";
    case "reasoning":
    case "function_call":
    case "custom_tool_call":
    case "web_search_call":
    case "local_shell_call":
    case "compaction":
      return "assistant";
    case "function_call_output":
    case "custom_tool_call_output":
    case "local_shell_call_output":
      return "user";
    case "ghost_snapshot":
      return "user";  // 元数据，忽略
    default:
      return "user";
  }
}
```

#### Content Block 转换

| Codex 类型 | Claude 类型 | 说明 |
|-----------|------------|------|
| `message` | `text` | 提取 input_text/output_text |
| `reasoning` (有 signature) | `thinking` | 保留 signature |
| `reasoning` (无 signature) | `text` | 转为 `[Reasoning: ...]` |
| `function_call` | `tool_use` | 解析 arguments JSON |
| `function_call_output` | `tool_result` | 直接映射 |
| `custom_tool_call` | `tool_use` | apply_patch 等 |
| `local_shell_call` | `tool_use` (exec_command) | command 数组 join |
| `compaction` | `thinking` | 保留 encrypted_content |
| `ghost_snapshot` | (忽略) | 版本控制元数据 |

### 3.5 Reasoning/Thinking 转换

**关键点：signature 必须保留**

```typescript
case "reasoning": {
  // 无 signature 时转为 text，避免 Claude 拒绝
  if (!item.encrypted_content) {
    const thinkingText = item.summary.map((s) => s.text).join("\n");
    if (!thinkingText) return null;
    return {
      type: "text",
      text: `[Reasoning: ${thinkingText}]`,
    };
  }
  
  // 有 signature 时正常转换
  return {
    type: "thinking",
    thinking: item.summary.map((s) => s.text).join("\n"),
    signature: item.encrypted_content,
  };
}
```

### 3.6 工具输入处理

为避免与 Codex CLI 的系统提示/工具定义产生不一致，本插件 **保留 Codex 工具名与参数结构**：

- `function_call.arguments` (JSON string) → `tool_use.input` (object): `JSON.parse` 直通
- `custom_tool_call`（`apply_patch`） → `tool_use.input`: `{ patch: "<freeform patch>" }`
- OpenAI 内置 `web_search_call` 不是本地可执行工具：转换为文本块保留上下文（不暴露为 tool）

### 3.7 ID 格式转换

```typescript
// call_xxx → toolu_xxx
export function convertCallId(callId: string): string {
  if (callId.startsWith("call_")) {
    return "toolu_" + callId.slice(5);
  }
  return callId;
}
```

### 3.8 Metadata 添加

Claude Code 必需 `metadata.user_id`：

```typescript
metadata: {
  user_id: "user_8affcbe039c1380bd8de140015ef63dd4936d02ecd7d5a0f78af6ed95967c5c0_account__session_dffce60e-e7a0-4bc3-b847-4e25f13d3c66",
}
```

---

## 4. 响应转换详解

### 4.1 SSE 事件映射

| Claude 事件 | Codex 事件 |
|------------|-----------|
| `message_start` | `response.created`, `response.in_progress` |
| `content_block_start` (thinking) | `response.output_item.added` (reasoning) |
| `content_block_start` (tool_use) | `response.output_item.added` (function_call / custom_tool_call) |
| `content_block_start` (text) | `response.output_item.added` (message) |
| `content_block_delta` (thinking_delta) | `response.reasoning_summary_text.delta` |
| `content_block_delta` (input_json_delta) | `response.function_call_arguments.delta`（部分工具在 stop 阶段生成一致的 delta/done） |
| `content_block_delta` (text_delta) | `response.output_text.delta` |
| `content_block_delta` (signature_delta) | (内部保存，不输出事件) |
| `content_block_stop` | `response.output_item.done` + (arguments/input done events) |
| `message_stop` | `response.completed` |

### 4.2 Signature 处理（关键！）

**Claude 在 streaming 模式下，signature 不在 `content_block_start` 中，而是在最后通过 `signature_delta` 事件发送：**

```
content_block_start  → signature: ""（空）
thinking_delta       → thinking 内容
signature_delta      → signature: "EqQD..."（真正的签名）
content_block_stop
```

**必须处理 `signature_delta`：**

```typescript
// Handle signature_delta - Claude sends signature at the end of thinking block
if ((delta as { type: string; signature?: string }).type === "signature_delta") {
  const signatureDelta = delta as { type: string; signature: string };
  state.thinkingSignature += signatureDelta.signature;
  
  // Update the reasoning item's encrypted_content
  const reasoningItem = state.outputItems.find(
    (item) => (item as { id?: string }).id === state.currentReasoningId
  ) as { encrypted_content?: string } | undefined;
  
  if (reasoningItem) {
    reasoningItem.encrypted_content = state.thinkingSignature;
  }
  
  return [];
}
```

### 4.3 Reasoning Output Item 结构

```typescript
// content_block_start 时创建
const reasoningItem = {
  id: state.currentReasoningId,
  type: "reasoning",
  status: "in_progress",
  summary: [],
  encrypted_content: state.thinkingSignature,  // 初始为空
};

// content_block_stop 时更新
reasoningItem.summary = [{ type: "summary_text", text: state.thinkingContent }];
reasoningItem.status = "completed";
reasoningItem.encrypted_content = state.thinkingSignature;  // 此时有值
```

### 4.4 工具名处理

- 默认 **不做工具名重写**（保持与 Codex CLI tools 定义一致）
- 仅支持 `TodoWrite` → `update_plan` 的别名映射（便于 Claude 生态模型产出计划工具调用）
- `apply_patch` 在 Codex 侧以 `custom_tool_call` 输出（通过 `custom_tool_call_input.*` 事件流传输 patch）

### 4.5 ID 反向转换

```typescript
// toolu_xxx → call_xxx
function convertToolId(toolId: string): string {
  if (toolId.startsWith("toolu_")) {
    return "call_" + toolId.slice(6);
  }
  return toolId;
}
```

### 4.6 错误处理

将 Claude 错误转换为 Codex 能识别的格式（触发 auto-compact）：

```typescript
export function shouldConvertToContextLengthError(body: unknown): boolean {
  // 上下文过长错误
  if (isContextLengthError(body)) return true;
  // 上游请求失败错误（也转换为 context_length_exceeded）
  if (isUpstreamRequestFailedError(body)) return true;
  return false;
}

export function buildCodexContextLengthError(originalMessage?: string): object {
  return {
    type: "error",
    error: {
      type: "invalid_request_error",
      code: "context_length_exceeded",
      message: originalMessage || "context length exceeded",
    },
  };
}
```

---

## 5. 遇到的问题与解决方案

### 5.1 "暂不支持非 claude code 请求" 错误

**原因：** 请求 headers 暴露了 Codex 身份

**解决：** 移除 Codex 特有 headers，添加 Claude Code headers

```typescript
// 需要删除的 headers
const excludeHeaders = [
  "user-agent",
  "x-app",
  "originator",           // Codex 特有
  "x-codex-beta-features", // Codex 特有
  "session_id",
  "conversation_id",
];

// 需要添加的 headers
newHeaders["user-agent"] = "claude-cli/2.0.58 (external, cli)";
newHeaders["x-app"] = "cli";
newHeaders["anthropic-dangerous-direct-browser-access"] = "true";
newHeaders["x-stainless-arch"] = "arm64";
newHeaders["x-stainless-helper-method"] = "stream";
// ... 更多 x-stainless-* headers
```

### 5.2 第二个请求失败（tool_use.input 为空）

**原因：** Codex 使用 `command` 字段，但代码只检查 `cmd` 字段

**解决：**
```typescript
if (args.cmd) result.command = args.cmd;
else if (args.command) result.command = args.command;
```

### 5.3 第二个请求失败（thinking signature 为空）

**原因：** Claude streaming 模式下 signature 通过 `signature_delta` 事件发送，而不是在 `content_block_start` 中

**解决：** 添加 `signature_delta` 事件处理：

```typescript
if (delta.type === "signature_delta") {
  state.thinkingSignature += signatureDelta.signature;
  // 更新 reasoning item 的 encrypted_content
}
```

### 5.4 Reasoning 转换后被 Claude 拒绝

**原因：** 没有 `encrypted_content` 的 reasoning 被转换为空 signature 的 thinking block

**解决：** 无 signature 时转换为普通 text block：

```typescript
if (!item.encrypted_content) {
  return {
    type: "text",
    text: `[Reasoning: ${thinkingText}]`,
  };
}
```

### 5.5 Instructions 中残留 GPT 描述

**原因：** 正则表达式只匹配了部分句子

**解决：** 改进正则，匹配整个句子：
```typescript
/You are GPT-[\d.]+ running in the Codex CLI[^.]*\.\s*/g
```

### 5.6 Missing metadata.user_id

**原因：** Claude Code 要求请求中包含 `metadata.user_id`

**解决：** 在 `convertRequest` 中添加固定的 user_id

---

## 6. Headers 伪装

### 6.1 完整 Headers 列表

```typescript
// Anthropic 标准 headers
newHeaders["anthropic-version"] = "2023-06-01";
newHeaders["anthropic-beta"] = "claude-code-20250219,interleaved-thinking-2025-05-14";
newHeaders["content-type"] = "application/json";
newHeaders["accept"] = "application/json";
newHeaders["accept-encoding"] = "gzip, deflate, br, zstd";

// Claude Code 必需 headers
newHeaders["user-agent"] = "claude-cli/2.0.58 (external, cli)";
newHeaders["x-app"] = "cli";
newHeaders["anthropic-dangerous-direct-browser-access"] = "true";

// x-stainless-* headers (Claude SDK 标识)
newHeaders["x-stainless-arch"] = "arm64";
newHeaders["x-stainless-helper-method"] = "stream";
newHeaders["x-stainless-lang"] = "js";
newHeaders["x-stainless-os"] = "MacOS";
newHeaders["x-stainless-package-version"] = "0.70.0";
newHeaders["x-stainless-retry-count"] = "0";
newHeaders["x-stainless-runtime"] = "node";
newHeaders["x-stainless-runtime-version"] = "v24.3.0";
newHeaders["x-stainless-timeout"] = "600";
```

### 6.2 anthropic-beta 顺序

**必须与 Claude Code 一致：**
```
claude-code-20250219,interleaved-thinking-2025-05-14
```

---

## 7. 工具处理

- Codex `function` 工具：工具名/参数 schema 直通到 Claude tools
- Codex `custom` 工具 `apply_patch`：在 Claude tools 中暴露为 `{ patch: string }`；响应侧输出为 `custom_tool_call` + `custom_tool_call_input.*`
- Claude `TodoWrite`：响应侧映射为 Codex `update_plan`，并将 `todos` 文本解析为 `plan[]`
- OpenAI 内置 `web_search`：不作为工具暴露；`web_search_call` 历史转换为文本上下文

---

## 8. 配置说明

### 8.1 Proxy 配置示例

```json
{
  "name": "88code-anthropic",
  "enabled": true,
  "target": "https://88code.wu.ren/api/v1/messages",
  "path": "/codex-anthropic/responses",
  "headers": {
    "authorization": "Bearer YOUR_API_KEY",
    "x-api-key": "/DELETE",
    "x-target-model": "claude-opus-4-5-20251101"
  },
  "hooks": [
    {
      "type": "http",
      "command": "bun",
      "args": ["run", "packages/proxy-plugin-codex/src/index.ts"]
    }
  ]
}
```

### 8.2 Codex CLI 配置

在 `~/.codex/config.toml` 中配置：

```toml
[model]
default = "gpt-5.2"

[api]
base_url = "http://127.0.0.1:20002/codex-anthropic"
```

---

## 9. 调试技巧

### 9.1 查看数据库日志

```bash
# 最近的请求
sqlite3 ~/.jixo/.proxy/0.5.0/proxy.db \
  "SELECT id, timestamp, forward_name, status_code FROM proxy_requests ORDER BY id DESC LIMIT 10;"

# 查看请求详情
sqlite3 ~/.jixo/.proxy/0.5.0/proxy.db \
  "SELECT data FROM proxy_requests WHERE id = XXX;" | jq '.hookedRequest'

# 解码 body
sqlite3 ~/.jixo/.proxy/0.5.0/proxy.db \
  "SELECT data FROM proxy_requests WHERE id = XXX;" | \
  jq -r '.hookedRequest.bodyDataUrl' | \
  sed 's/data:application\/json;base64,//' | \
  base64 -d | jq '.'
```

### 9.2 查看响应中的 encrypted_content

```bash
sqlite3 ~/.jixo/.proxy/0.5.0/proxy.db \
  "SELECT data FROM proxy_requests WHERE id = XXX;" | \
  jq -r '.hookedResponse.bodyDataUrl' | \
  sed 's/data:[^;]*;base64,//' | \
  base64 -d | grep "encrypted_content"
```

### 9.3 启用调试日志

```typescript
definePlugin(createCodexPlugin({ debug: true }), { debug: true });
```

日志会写入 `.tmp/hook-logs/` 目录。

### 9.4 测试转换

```typescript
import { rewriteRequest } from "./packages/proxy-plugin-codex/src/request-converter";
import { convertSSEResponse } from "./packages/proxy-plugin-codex/src/response-converter";

// 测试请求转换
const result = rewriteRequest({ headers: {...}, body: JSON.stringify(codexRequest) });
console.log(JSON.parse(result.body));

// 测试响应转换
const codexSSE = convertSSEResponse(claudeSSE);
console.log(codexSSE);
```

---

## 附录：完整类型定义

### Codex ResponseItem 类型

```typescript
type CodexResponseItem =
  | { type: "message"; role: "user" | "assistant"; content: CodexContentItem[] }
  | { type: "reasoning"; summary: CodexReasoningSummary[]; encrypted_content?: string }
  | { type: "function_call"; name: string; arguments: string; call_id: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "custom_tool_call"; name: string; input: string; call_id: string }
  | { type: "custom_tool_call_output"; call_id: string; output: string }
  | { type: "web_search_call"; action: { type: "search"; query?: string } }
  | { type: "local_shell_call"; call_id?: string; action: { command: string[] } }
  | { type: "local_shell_call_output"; call_id: string; output: string }
  | { type: "ghost_snapshot"; ghost_commit: unknown }
  | { type: "compaction"; encrypted_content: string };
```

### Claude ContentBlock 类型

```typescript
type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };
```

---

*文档版本: 1.0.0*
*最后更新: 2025-12-28*
