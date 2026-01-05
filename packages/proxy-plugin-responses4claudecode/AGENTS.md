# @jixo/proxy-plugin-responses4claudecode

Claude Messages API → OpenAI Responses API 转换插件。

## 项目定位

让 **Claude Code** 使用 **OpenAI Responses API 兼容后端**。

```
Claude Code (Anthropic Messages API)
    ↓
proxy-plugin-responses4claudecode
    ↓
OpenAI Backend (Responses API)
```

## 核心文件

| 文件 | 职责 |
|------|------|
| `src/plugin.ts` | 插件入口，处理 request/response hooks |
| `src/request-converter.ts` | Claude → Responses 请求转换 |
| `src/response-converter.ts` | Responses SSE → Claude SSE 响应转换 |
| `src/constants.ts` | ID 转换、工具映射、headers 处理 |
| `src/types.ts` | TypeScript 类型定义 |
| `src/count-tokens.ts` | 模拟 count_tokens 端点 |
| `src/codex-cli-instructions.ts` | CLI 指令模板 |

## 关键转换

### 请求转换

| Claude | Responses | 说明 |
|--------|-----------|------|
| `system[]` | `instructions` | 默认注入 CLI 指令模板（可用 `RESPONSES4CLAUDECODE_INSTRUCTIONS_MODE=empty` 置空）；同时从 system 抽取 Claude Code context 注入 input |
| `messages[]` | `input[]` | 展平消息，转换内容块类型 |
| `tools[]` | `tools[]` | function/custom/web_search 类型映射 |
| `thinking.budget_tokens` | `reasoning.effort` | 数值 → 级别映射 |
| `tool_choice: {type:"tool", name}` | `tool_choice: "required"` + 过滤工具列表 |
| `toolu_xxx` ID | `call_xxx` ID | 前缀转换 |

### 工具名称映射

| Claude | Responses |
|--------|-----------|
| `TodoWrite` | `update_plan` |

### 响应转换 (SSE)

| Responses Event | Claude Event |
|-----------------|--------------|
| `response.created` | `message_start` |
| `response.output_text.delta` | `content_block_delta` (text) |
| `response.function_call_arguments.delta` | `content_block_delta` (tool_use) |
| `response.output_item.done` | `content_block_stop` |
| `response.completed` | `message_delta` + `message_stop` |
| `web_search_call` | `server_tool_use` (web_search) |
| `url_citation` | `web_search_tool_result` |

### 特殊处理

1. **流中断处理**：上游流意外中断时，自动生成 `message_stop` 关闭流
2. **上下文窗口错误**：检测到上下文超限时，返回大 `input_tokens` 值触发 Claude Code 摘要
3. **count_tokens 端点**：后端无此端点，使用 tiktoken 本地估算
4. **prompt_cache_key**：已禁用，确保 `input_tokens` 报告完整值

## 开发命令

```bash
# 类型检查
bun ts

# 运行测试
bun test

# 启动插件
bun run src/index.ts
```

## 测试覆盖

- `__tests__/request-converter.test.ts` - 请求转换测试
- `__tests__/response-converter.test.ts` - 响应转换测试
- `__tests__/count-tokens.test.ts` - count_tokens 模拟测试

覆盖：
- 基本请求/响应转换
- 工具调用转换
- Web 搜索处理
- 错误处理
- 流中断处理
- 工具名称映射

## 状态机 (SSEStreamConverter)

```
Initial
    ↓ response.created
message_start (state.messageStarted = true)
    ↓ output_item.added
content_block_start (state.blockStarted = true)
    ↓ *_delta events
content_block_delta
    ↓ output_item.done
content_block_stop (state.blockStarted = false)
    ↓ response.completed
message_delta + message_stop (state.streamCompleted = true)
```

关键状态字段：
- `messageStarted` - 是否已发送 message_start
- `blockStarted` - 当前 block 是否已开始
- `streamCompleted` - 流是否正常完成
- `contentBlockIndex` - 当前 block 索引
- `currentBlockType` - text/tool_use/server_tool_use

## 配置

### 环境变量

| 变量 | 说明 |
|------|------|
| `DEBUG_RESPONSES4CLAUDECODE=1` | 启用调试日志 |
| `RESPONSES4CLAUDECODE_INSTRUCTIONS_MODE=empty` | 将 `instructions` 置空（用于兼容/实验） |
| `PLUGIN_PORT` | 插件服务端口（默认自动分配） |

### Headers

| Header | 说明 |
|--------|------|
| `x-target-model` | 覆盖请求中的模型名称 |

## 代码规范

- 使用 TypeScript 严格模式
- 函数优先使用纯函数
- SSE 转换器使用类封装状态
- 导出函数用于测试
