# @jixo/proxy-plugin-claude-code

将 Claude Messages API 请求转换为 Codex Responses API 格式的代理插件。

## 概述

让 **Claude Code** 使用 **Codex 兼容后端**（如 OpenAI Responses API、GPT-5 等）。

```
Claude Code ─── Messages API ───→ Proxy ───→ Responses API ───→ Codex Backend
```

## 快速开始

### 1. 安装依赖

```bash
bun install
```

### 2. 启动代理

配置 `proxy-config.json`：

```json
{
  "instances": [{
    "name": "claude-code",
    "enabled": true,
    "target": "https://your-codex-backend.com/v1/responses",
    "port": 20003,
    "path": "/v1/messages",
    "methods": ["POST"],
    "hooks": [{
      "type": "http",
      "command": "bun",
      "args": ["run", "packages/proxy-plugin-claude-code/src/index.ts"]
    }]
  }]
}
```

```bash
bun run dev
```

### 3. 配置 Claude Code

```bash
export ANTHROPIC_BASE_URL=http://localhost:20003
claude
```

## 核心功能

### 请求转换

| Claude | Codex | 说明 |
|--------|-------|------|
| `system[]` | `instructions` | 默认注入 Codex CLI 指令模板（可用 `CLAUDE_CODE_INSTRUCTIONS_MODE=empty` 置空）；同时从 system 抽取 Claude Code context 注入 input |
| `messages[]` | `input[]` | 展平并转换类型 |
| `tools[]` | `tools[]` | function/custom/web_search |
| `thinking.budget_tokens` | `reasoning.effort` | 数值映射 |
| `toolu_xxx` | `call_xxx` | ID 转换 |
| `TodoWrite` | `update_plan` | 工具名称映射 |

### 响应转换 (SSE)

| Codex Event | Claude Event |
|-------------|--------------|
| `response.created` | `message_start` |
| `response.output_text.delta` | `content_block_delta` |
| `response.function_call_arguments.delta` | `content_block_delta` (tool_use) |
| `response.completed` | `message_delta` + `message_stop` |

### 特殊处理

- **流中断恢复**：上游流中断时自动生成结束事件
- **上下文超限检测**：返回大 `input_tokens` 值触发摘要
- **count_tokens 模拟**：本地 tiktoken 估算
- **Web 搜索支持**：转换 `web_search_call` 和 `url_citation`

## 配置选项

### 目标模型

使用 `x-target-model` header 覆盖模型：

```bash
curl -X POST http://localhost:20003/v1/messages \
  -H "x-target-model: gpt-5.2" \
  -d '{"model": "claude-opus-4-5", ...}'
```

### 环境变量

| 变量 | 说明 |
|------|------|
| `DEBUG_CLAUDE_CODE=1` | 启用调试日志 |
| `CLAUDE_CODE_INSTRUCTIONS_MODE=empty` | 将 Codex `instructions` 置空（用于兼容/实验） |
| `PLUGIN_PORT` | 插件端口（默认自动） |

## 开发

```bash
# 类型检查
bun ts

# 运行测试
bun test

# 启动插件
bun run src/index.ts
```

## 项目结构

```
src/
├── index.ts              # 入口
├── plugin.ts             # 插件实现
├── request-converter.ts  # 请求转换
├── response-converter.ts # 响应转换
├── constants.ts          # 常量和工具函数
├── types.ts              # 类型定义
├── count-tokens.ts       # Token 估算
└── __tests__/            # 测试
```

## 已知限制

1. **Thinking 兼容性**：Claude `thinking.signature` 不传递到 Codex（避免后端不兼容）
2. **整块转换**：响应是整块处理，非真正流式（代理框架限制）

## 相关项目

- [@jixo/proxy-plugin-codex](../proxy-plugin-codex) - Codex CLI → Claude API
- [@jixo/proxy-plugin](../proxy-plugin) - 代理插件框架

## 许可证

MIT
