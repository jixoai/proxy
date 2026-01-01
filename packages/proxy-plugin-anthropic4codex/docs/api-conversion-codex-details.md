# Codex 源码分析补充 - Responses API 精确类型定义

> 基于 codex-rs 源码分析
> 源码路径: `/Users/kingsword09/Documents/code/ai/codex`

---

## 一、核心类型定义

### 1.1 ResponseItem 枚举 (完整定义)

来源: `codex-rs/protocol/src/models.rs`

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ResponseItem {
    // 消息类型
    Message {
        id: Option<String>,
        role: String,  // "user" | "assistant"
        content: Vec<ContentItem>,
    },
    
    // 推理类型
    Reasoning {
        id: String,
        summary: Vec<ReasoningItemReasoningSummary>,
        content: Option<Vec<ReasoningItemContent>>,
        encrypted_content: Option<String>,
    },
    
    // 本地 Shell 调用
    LocalShellCall {
        id: Option<String>,
        call_id: Option<String>,
        status: LocalShellStatus,
        action: LocalShellAction,
    },
    
    // 函数调用
    FunctionCall {
        id: Option<String>,
        name: String,
        arguments: String,  // JSON string
        call_id: String,
    },
    
    // 函数调用输出
    FunctionCallOutput {
        call_id: String,
        output: FunctionCallOutputPayload,
    },
    
    // 自定义工具调用 (如 apply_patch)
    CustomToolCall {
        id: Option<String>,
        status: Option<String>,
        call_id: String,
        name: String,
        input: String,
    },
    
    // 自定义工具输出
    CustomToolCallOutput {
        call_id: String,
        output: String,
    },
    
    // Web 搜索调用
    WebSearchCall {
        id: Option<String>,
        status: Option<String>,
        action: WebSearchAction,
    },
    
    // Ghost 快照 (用于版本控制)
    GhostSnapshot {
        ghost_commit: GhostCommit,
    },
    
    // 压缩/总结
    Compaction {
        encrypted_content: String,
    },
    
    // 其他未知类型
    Other,
}
```

### 1.2 ContentItem 枚举

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentItem {
    InputText { text: String },
    InputImage { image_url: String },
    OutputText { text: String },
}
```

### 1.3 Reasoning 相关类型

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReasoningItemReasoningSummary {
    SummaryText { text: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ReasoningItemContent {
    ReasoningText { text: String },
    Text { text: String },
}
```

### 1.4 LocalShellAction 类型

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
#[serde(rename_all = "snake_case")]
pub enum LocalShellStatus {
    Completed,
    InProgress,
    Incomplete,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LocalShellAction {
    Exec(LocalShellExecAction),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
pub struct LocalShellExecAction {
    pub command: Vec<String>,
    pub timeout_ms: Option<u64>,
    pub working_directory: Option<String>,
    pub env: Option<HashMap<String, String>>,
    pub user: Option<String>,
}
```

### 1.5 WebSearchAction 类型

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WebSearchAction {
    Search {
        query: Option<String>,
    },
    OpenPage {
        url: Option<String>,
    },
    FindInPage {
        url: Option<String>,
        pattern: Option<String>,
    },
    Other,
}
```

### 1.6 FunctionCallOutputPayload

```rust
#[derive(Debug, Default, Clone, PartialEq, JsonSchema, TS)]
pub struct FunctionCallOutputPayload {
    pub content: String,
    pub content_items: Option<Vec<FunctionCallOutputContentItem>>,
    pub success: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FunctionCallOutputContentItem {
    InputText { text: String },
    InputImage { image_url: String },
}
```

---

## 二、请求格式定义

### 2.1 ResponsesApiRequest

来源: `codex-rs/codex-api/src/common.rs`

```rust
#[derive(Debug, Serialize)]
pub struct ResponsesApiRequest<'a> {
    pub model: &'a str,
    pub instructions: &'a str,
    pub input: &'a [ResponseItem],
    pub tools: &'a [serde_json::Value],
    pub tool_choice: &'static str,        // 固定为 "auto"
    pub parallel_tool_calls: bool,
    pub reasoning: Option<Reasoning>,
    pub store: bool,
    pub stream: bool,
    pub include: Vec<String>,
    pub prompt_cache_key: Option<String>,
    pub text: Option<TextControls>,
}
```

### 2.2 Reasoning 配置

```rust
#[derive(Debug, Serialize, Clone)]
pub struct Reasoning {
    pub effort: Option<ReasoningEffort>,
    pub summary: Option<ReasoningSummary>,
}

// ReasoningEffort 枚举
#[derive(Debug, Serialize, Deserialize, Default, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    None,
    Minimal,
    Low,
    #[default]
    Medium,
    High,
    XHigh,
}
```

### 2.3 TextControls

```rust
#[derive(Debug, Serialize, Default, Clone)]
pub struct TextControls {
    pub verbosity: Option<OpenAiVerbosity>,
    pub format: Option<TextFormat>,
}

#[derive(Debug, Serialize, Default, Clone)]
#[serde(rename_all = "lowercase")]
pub enum OpenAiVerbosity {
    Low,
    #[default]
    Medium,
    High,
}

#[derive(Debug, Serialize, Default, Clone)]
pub struct TextFormat {
    pub r#type: TextFormatType,  // "json_schema"
    pub strict: bool,
    pub schema: Value,
    pub name: String,
}
```

---

## 三、SSE 响应事件处理

### 3.1 ResponseEvent 枚举

来源: `codex-rs/codex-api/src/common.rs`

```rust
#[derive(Debug)]
pub enum ResponseEvent {
    Created,
    
    OutputItemDone(ResponseItem),
    
    OutputItemAdded(ResponseItem),
    
    Completed {
        response_id: String,
        token_usage: Option<TokenUsage>,
    },
    
    OutputTextDelta(String),
    
    ReasoningSummaryDelta {
        delta: String,
        summary_index: i64,
    },
    
    ReasoningContentDelta {
        delta: String,
        content_index: i64,
    },
    
    ReasoningSummaryPartAdded {
        summary_index: i64,
    },
    
    RateLimits(RateLimitSnapshot),
}
```

### 3.2 SSE 事件类型映射

来源: `codex-rs/codex-api/src/sse/responses.rs`

| SSE 事件类型 | 处理逻辑 | 输出 |
|-------------|---------|------|
| `response.created` | 检查 response 存在 | `ResponseEvent::Created` |
| `response.output_item.done` | 解析 item 为 ResponseItem | `ResponseEvent::OutputItemDone(item)` |
| `response.output_item.added` | 解析 item 为 ResponseItem | `ResponseEvent::OutputItemAdded(item)` |
| `response.output_text.delta` | 提取 delta 字符串 | `ResponseEvent::OutputTextDelta(delta)` |
| `response.reasoning_summary_text.delta` | 提取 delta + summary_index | `ResponseEvent::ReasoningSummaryDelta` |
| `response.reasoning_text.delta` | 提取 delta + content_index | `ResponseEvent::ReasoningContentDelta` |
| `response.reasoning_summary_part.added` | 提取 summary_index | `ResponseEvent::ReasoningSummaryPartAdded` |
| `response.completed` | 解析 response.id + usage | `ResponseEvent::Completed` |
| `response.failed` | 解析错误类型 | 各种 `ApiError` |

### 3.3 SSE 事件解析结构

```rust
#[derive(Deserialize, Debug)]
struct SseEvent {
    #[serde(rename = "type")]
    kind: String,
    response: Option<Value>,
    item: Option<Value>,
    delta: Option<String>,
    summary_index: Option<i64>,
    content_index: Option<i64>,
}
```

### 3.4 response.completed 使用统计

```rust
#[derive(Debug, Deserialize)]
struct ResponseCompletedUsage {
    input_tokens: i64,
    input_tokens_details: Option<ResponseCompletedInputTokensDetails>,
    output_tokens: i64,
    output_tokens_details: Option<ResponseCompletedOutputTokensDetails>,
    total_tokens: i64,
}

#[derive(Debug, Deserialize)]
struct ResponseCompletedInputTokensDetails {
    cached_tokens: i64,
}

#[derive(Debug, Deserialize)]
struct ResponseCompletedOutputTokensDetails {
    reasoning_tokens: i64,
}
```

---

## 四、工具定义格式

### 4.1 Shell 工具参数

```rust
// exec_command / shell 工具
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct ShellToolCallParams {
    pub command: Vec<String>,
    pub workdir: Option<String>,
    pub timeout_ms: Option<u64>,
    pub sandbox_permissions: Option<SandboxPermissions>,
    pub justification: Option<String>,
}

// shell_command 工具 (单命令字符串)
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct ShellCommandToolCallParams {
    pub command: String,
    pub workdir: Option<String>,
    pub login: Option<bool>,
    pub timeout_ms: Option<u64>,
    pub sandbox_permissions: Option<SandboxPermissions>,
    pub justification: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Eq, Hash, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SandboxPermissions {
    #[default]
    UseDefault,
    RequireEscalated,
}
```

---

## 五、错误处理

### 5.1 错误类型识别

```rust
fn is_context_window_error(error: &Error) -> bool {
    error.code.as_deref() == Some("context_length_exceeded")
}

fn is_quota_exceeded_error(error: &Error) -> bool {
    error.code.as_deref() == Some("insufficient_quota")
}

fn is_usage_not_included(error: &Error) -> bool {
    error.code.as_deref() == Some("usage_not_included")
}
```

### 5.2 Rate Limit 重试解析

```rust
// 从错误消息中解析重试延迟
// 支持格式: "try again in 11.054s", "try again in 28ms"
fn try_parse_retry_after(err: &Error) -> Option<Duration> {
    if err.code.as_deref() != Some("rate_limit_exceeded") {
        return None;
    }
    // 正则匹配: try again in (\d+(?:\.\d+)?)\s*(s|ms|seconds?)
    ...
}
```

---

## 六、与 Anthropic 转换对照

### 6.1 ResponseItem → Anthropic ContentBlock

| ResponseItem 类型 | Anthropic 等价 | 转换说明 |
|------------------|---------------|---------|
| `Message { role: "user" }` | `user` message | 直接映射 |
| `Message { role: "assistant" }` | `assistant` message | 直接映射 |
| `Reasoning` | `thinking` block | summary → thinking, encrypted_content → signature |
| `FunctionCall` | `tool_use` block | arguments JSON.parse, call_id → id |
| `FunctionCallOutput` | `tool_result` block | call_id → tool_use_id |
| `CustomToolCall` | `tool_use` (特殊处理) | apply_patch 需要解析 |
| `CustomToolCallOutput` | `tool_result` | 直接映射 |
| `WebSearchCall` | 自定义 tool_use | 需要特殊处理 |
| `LocalShellCall` | `tool_use` (exec) | 转换 action 结构 |

### 6.2 ReasoningEffort → Anthropic thinking.budget_tokens

| Responses API | Anthropic 建议值 |
|--------------|-----------------|
| `none` | 不启用 thinking |
| `minimal` | 4096 |
| `low` | 8192 |
| `medium` | 16384 |
| `high` | 24576 |
| `xhigh` | 32768+ |

### 6.3 SSE 事件转换

| Responses API 事件 | Anthropic 等价 |
|-------------------|---------------|
| `response.created` | `message_start` |
| `response.output_item.added` | `content_block_start` |
| `response.output_text.delta` | `content_block_delta (text_delta)` |
| `response.reasoning_summary_text.delta` | `content_block_delta (thinking_delta)` |
| `response.output_item.done` | `content_block_stop` |
| `response.completed` | `message_stop` + `message_delta` |

---

## 七、关键实现细节

### 7.1 parallel_tool_calls 处理

Codex 默认启用 `parallel_tool_calls: true`，允许模型在单个响应中返回多个工具调用。在转换时：

- Responses API: 多个 `FunctionCall` items 在 output 数组中
- Anthropic: 多个 `tool_use` blocks 在同一个 assistant message content 中

### 7.2 encrypted_content / signature 保留

Reasoning 中的 `encrypted_content` 对应 Anthropic thinking 的 `signature`，这是加密的原始推理内容，必须在往返转换中保留，否则后续请求可能失败。

### 7.3 store 参数

Azure 端点需要 `store: true`，其他端点默认 `store: false`。转换器需要根据目标提供商调整。

### 7.4 prompt_cache_key

用于 OpenAI 的提示缓存优化，转换到 Anthropic 时可以忽略（Anthropic 使用不同的缓存机制）。

---

## 八、TypeScript 类型定义

基于 Rust 类型生成的 TypeScript 定义（通过 ts-rs）：

```typescript
interface ResponseItem {
  type: 'message' | 'reasoning' | 'function_call' | 'function_call_output' | 
        'custom_tool_call' | 'custom_tool_call_output' | 'web_search_call' |
        'local_shell_call' | 'ghost_snapshot' | 'compaction';
  // ... 各类型特有字段
}

interface ContentItem {
  type: 'input_text' | 'input_image' | 'output_text';
  text?: string;
  image_url?: string;
}

interface FunctionCall {
  type: 'function_call';
  id?: string;
  name: string;
  arguments: string;  // JSON string
  call_id: string;
}

interface Reasoning {
  type: 'reasoning';
  id: string;
  summary: Array<{ type: 'summary_text'; text: string }>;
  content?: Array<{ type: 'reasoning_text' | 'text'; text: string }>;
  encrypted_content?: string;
}
```

---

*分析完成*
