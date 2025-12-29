# Claude Code 源码分析 - Anthropic Messages API 精确类型定义

> 基于 @anthropic-ai/claude-code npm 包分析
> 版本: 2.0.76

---

## 一、Claude Code 工具定义

Claude Code 使用 Anthropic Messages API，以下是其工具的精确定义（来自 `sdk-tools.d.ts`）：

> 说明：本文件是 Claude Code（Anthropic）侧工具/协议的参考。`@jixo/proxy-plugin-codex` 当前实现默认**不做 Claude Code 工具名映射**（例如不把 `exec_command` 变成 `Bash`、不把 `update_plan` 变成 `TodoWrite`），而是尽量保持工具名/参数直通；仅对 Codex 内置 `web_search` 做 server-side 映射到 Anthropic `web_search_20250305`。

### 1.1 核心工具列表

| 工具名 | 对应/参考 | 说明 |
|--------|----------|------|
| `Bash` | `exec_command` / `shell_command`（参考） | 执行命令 |
| `FileRead` | - | 读取文件 |
| `FileWrite` | - | 写入文件 |
| `FileEdit` | `apply_patch`（参考） | 编辑文件 |
| `Glob` | - | 文件匹配 |
| `Grep` | - | 搜索内容 |
| `TodoWrite` | - | 任务列表 |
| `WebSearch` | `web_search`（参考） | 网页搜索 |
| `WebFetch` | - | 获取网页 |
| `Agent` | - | 子代理 |
| `TaskOutput` | - | 后台任务输出 |
| `NotebookEdit` | - | Jupyter 编辑 |
| `Mcp` | `mcp__*` | MCP 工具 |

### 1.2 Bash 工具定义

```typescript
interface BashInput {
  command: string;                    // 要执行的命令
  timeout?: number;                   // 超时 (最大 600000ms)
  description?: string;               // 命令描述 (5-10词)
  run_in_background?: boolean;        // 后台运行
  dangerouslyDisableSandbox?: boolean; // 禁用沙箱
}
```

**对应 Codex `exec_command`:**
```typescript
interface ExecCommandParams {
  cmd: string;
  yield_time_ms?: number;
  workdir?: string;
  sandbox_permissions?: 'use_default' | 'require_escalated';
  justification?: string;
}
```

### 1.3 FileEdit 工具定义

```typescript
interface FileEditInput {
  file_path: string;      // 绝对路径
  old_string: string;     // 要替换的文本
  new_string: string;     // 替换后的文本
  replace_all?: boolean;  // 替换所有匹配
}
```

**对应 Codex `apply_patch` (CustomToolCall):**
```
*** Begin Patch
*** Update File: /path/to/file
@@
 context line
-old_string
+new_string
 context line
*** End Patch
```

### 1.4 FileRead 工具定义

```typescript
interface FileReadInput {
  file_path: string;  // 绝对路径
  offset?: number;    // 起始行号
  limit?: number;     // 读取行数
}
```

### 1.5 Grep 工具定义

```typescript
interface GrepInput {
  pattern: string;                                    // 正则模式
  path?: string;                                      // 搜索路径
  glob?: string;                                      // 文件过滤
  output_mode?: 'content' | 'files_with_matches' | 'count';
  '-B'?: number;                                      // 前置上下文行
  '-A'?: number;                                      // 后置上下文行
  '-C'?: number;                                      // 上下文行
  '-n'?: boolean;                                     // 显示行号
  '-i'?: boolean;                                     // 忽略大小写
  type?: string;                                      // 文件类型
  head_limit?: number;                                // 限制输出
  offset?: number;                                    // 跳过行数
  multiline?: boolean;                                // 多行模式
}
```

### 1.6 WebSearch 工具定义

```typescript
interface WebSearchInput {
  query: string;                   // 搜索查询
  allowed_domains?: string[];      // 限定域名
  blocked_domains?: string[];      // 排除域名
}
```

### 1.7 TodoWrite 工具定义

```typescript
interface TodoWriteInput {
  todos: {
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
    activeForm: string;
  }[];
}
```

---

## 二、API 调用特性

### 2.1 Beta 特性

Claude Code 使用以下 beta 特性：

```javascript
// HTTP Header
"anthropic-beta": "interleaved-thinking-2025-05-14,claude-code-20250219"
```

- `interleaved-thinking-2025-05-14`: 交错思维模式
- `claude-code-20250219`: Claude Code 专属特性

### 2.2 Thinking 配置

```javascript
{
  thinking: {
    type: "enabled",
    budget_tokens: <dynamic>  // 根据上下文动态计算
  }
}
```

### 2.3 模型选择

Claude Code 支持的模型：
- `sonnet` - Claude Sonnet (默认)
- `opus` - Claude Opus  
- `haiku` - Claude Haiku (用于快速任务)

---

## 三、消息格式

### 3.1 请求消息结构

```typescript
interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

type ContentBlock = 
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageSource }
  | { type: 'tool_use'; id: string; name: string; input: object }
  | { type: 'tool_result'; tool_use_id: string; content: string | ContentBlock[] }
  | { type: 'thinking'; thinking: string; signature: string };
```

### 3.2 响应流事件

Claude Code 处理以下 SSE 事件：

| 事件类型 | 说明 |
|---------|------|
| `message_start` | 消息开始，包含初始 usage |
| `content_block_start` | 内容块开始 (thinking/text/tool_use) |
| `content_block_delta` | 内容增量 |
| `content_block_stop` | 内容块结束 |
| `message_delta` | 消息更新 (stop_reason, usage) |
| `message_stop` | 消息结束 |
| `ping` | 心跳 |

### 3.3 Content Block 类型

```typescript
// thinking block
{
  type: 'thinking',
  thinking: '',
  signature: ''
}

// text block  
{
  type: 'text',
  text: ''
}

// NOTE:
// Claude 可能会把最终回答拆成很多个 text blocks（段落级切分）。
// 在 Codex CLI 侧如果逐块映射成独立 message，会导致输出被切成很多段，破坏 Markdown 可读性。
// proxy-plugin-codex 会把连续的 text blocks 合并为同一个 Codex message output item。

// tool_use block
{
  type: 'tool_use',
  id: 'toolu_xxx',
  name: 'Bash',
  input: {}
}
```

---

## 四、proxy-plugin-codex 的工具策略（当前实现）

- 工具名：默认透传（不做 `Bash` / `FileEdit` / `TodoWrite` 等 Claude Code 工具名映射）。
- `function` 工具：`parameters` → Claude `input_schema`（保持 `name` 不变）。
- `custom` 工具（含 `apply_patch`）：默认包装为 `{ input: string }`（保持 `name` 不变）。
- Codex 内置 `web_search`：映射为 Anthropic server-side `web_search`（`type: web_search_20250305`）。

---

## 五、Codex ↔ Claude Code 完整转换

### 5.1 请求转换流程

```
Codex Responses API Request
         │
         ▼
┌─────────────────────────────────────┐
│  1. 模型映射                         │
│     gpt-5.2 → claude-opus-4-5-*     │
├─────────────────────────────────────┤
│  2. instructions → system           │
├─────────────────────────────────────┤
│  3. input[] → messages[]            │
│     - message → user/assistant msg  │
│     - reasoning → thinking block    │
│     - function_call → tool_use      │
│     - function_call_output → result │
├─────────────────────────────────────┤
│  4. tools 格式转换                   │
│     - parameters → input_schema     │
│     - 工具名默认透传                 │
│     - web_search → web_search_20250305 │
├─────────────────────────────────────┤
│  5. reasoning → thinking            │
│     effort: xhigh → budget: 32768   │
└─────────────────────────────────────┘
         │
         ▼
Anthropic Messages API Request
```

### 5.2 响应转换流程

```
Anthropic SSE Stream
         │
         ▼
┌─────────────────────────────────────┐
│  message_start                       │
│    → response.created               │
│    → response.in_progress           │
├─────────────────────────────────────┤
│  content_block_start (thinking)      │
│    → (内部状态)                      │
├─────────────────────────────────────┤
│  content_block_delta (thinking)      │
│    → response.reasoning_summary_*    │
├─────────────────────────────────────┤
│  content_block_start (tool_use)      │
│    → response.output_item.added      │
├─────────────────────────────────────┤
│  content_block_delta (input_json)    │
│    → response.function_call_args.*   │
├─────────────────────────────────────┤
│  content_block_stop                  │
│    → response.output_item.done       │
├─────────────────────────────────────┤
│  message_stop                        │
│    → response.completed              │
└─────────────────────────────────────┘
         │
         ▼
Codex Responses API SSE Stream
```

---

## 六、关键差异总结

### 6.1 工具调用格式

| 特性 | Codex | Claude Code |
|------|-------|-------------|
| 参数格式 | JSON string | object |
| ID 前缀 | `call_` | `toolu_` |
| 输出格式 | `output` string | `content` string/array |

### 6.2 消息结构

| 特性 | Codex | Claude Code |
|------|-------|-------------|
| 历史格式 | `input[]` 扁平数组 | `messages[]` 交替结构 |
| 推理 | `reasoning` item | `thinking` block |
| 系统提示 | `instructions` | `system` |

### 6.3 特殊功能

| 功能 | Codex | Claude Code |
|------|-------|-------------|
| 并行工具 | `parallel_tool_calls` | 默认支持 |
| 推理等级 | `reasoning.effort` | `thinking.budget_tokens` |
| 缓存 | `prompt_cache_key` | 自动缓存 |
| 子代理 | - | `Agent` 工具 |
| 后台任务 | - | `run_in_background` |

---

## 七、实现建议

### 7.1 转换器架构

```typescript
class CodexToClaudeConverter {
  // 请求转换
  convertRequest(codexReq: ResponsesApiRequest): MessagesRequest {
    return {
      model: this.mapModel(codexReq.model),
      max_tokens: 32000,
      system: codexReq.instructions,
      messages: this.convertInput(codexReq.input),
      tools: this.convertTools(codexReq.tools),
      thinking: this.convertReasoning(codexReq.reasoning),
      stream: true
    };
  }

  // 工具转换
  convertTools(tools: CodexTool[]): ClaudeTool[] {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters
    }));
  }

  // 消息合并
  convertInput(input: ResponseItem[]): Message[] {
    // 需要合并连续的同角色消息
    // 需要将 function_call + output 转换为 tool_use + tool_result
  }
}

class ClaudeToCodexConverter {
  // SSE 事件转换
  convertEvent(event: ClaudeSSE): CodexSSE[] {
    switch (event.type) {
      case 'message_start':
        return [createResponseCreated(), createResponseInProgress()];
      case 'content_block_start':
        if (event.content_block.type === 'tool_use') {
          return [createOutputItemAdded(event)];
        }
        break;
      // ...
    }
  }
}
```

### 7.2 工具名映射表

```typescript
// 备注：当前 @jixo/proxy-plugin-codex 不再维护工具名映射表，尽量保持工具名直通。
```

---

*分析完成*
