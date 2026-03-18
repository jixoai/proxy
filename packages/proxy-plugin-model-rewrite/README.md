# @jixo/proxy-plugin-model-rewrite

轻量级请求 hook，用于重写 OpenAI 兼容请求中的 `model` 字段。

适用场景：

- `/codex` 接口想固定切到某个模型
- `/bub` 接口想按上游要求改模型名
- 不想把模型切换逻辑耦合进具体协议转换插件

## 配置

### 固定模型

```json
{
  "type": "http",
  "command": "bunx",
  "args": ["@jixo/proxy-plugin-model-rewrite"],
  "config": {
    "model": "gpt-5.4"
  }
}
```

### 映射模型

```json
{
  "type": "http",
  "command": "bunx",
  "args": ["@jixo/proxy-plugin-model-rewrite"],
  "config": {
    "model": {
      "gpt-4o-mini": "gpt-5.4-mini",
      "gpt-4.1": "gpt-5.4",
      "*": "gpt-5.4"
    }
  }
}
```

支持三种规则：

- 直接字符串：所有请求统一改成同一个模型
- 精确映射：`"旧模型": "新模型"`
- 正则映射：`"/^claude-/": "gpt-"`
- 通配回退：`"*": "gpt-5.4"`

## 可处理的请求体

- 顶层 `model`
- `type: "response.create"` 时的 `response.model`

## 示例

`/codex` 可以和 `@jixo/proxy-plugin-codex` 一起挂：

```json
"hooks": [
  {
    "type": "http",
    "command": "bunx",
    "args": ["@jixo/proxy-plugin-model-rewrite"],
    "config": { "model": "gpt-5.4" }
  },
  {
    "type": "http",
    "command": "bunx",
    "args": ["@jixo/proxy-plugin-codex"]
  }
]
```

`/bub` 通常只挂这个插件就够了：

```json
"hooks": [
  {
    "type": "http",
    "command": "bunx",
    "args": ["@jixo/proxy-plugin-model-rewrite"],
    "config": { "model": "gpt-5.4" }
  }
]
```
