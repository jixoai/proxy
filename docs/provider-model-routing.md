# Provider 多模型路由

同一分组（同名转发规则）里的每条规则可以独立配置多个模型、名称映射和客户端 API 能力。JSON 仍是唯一配置来源，界面在新增和编辑转发规则时提供相同的“模型与 API（可选）”设置。

## 默认无需配置

| 设置 | 不填写、null 或清空后的含义 |
| --- | --- |
| `models` | 支持该组请求的全部模型 |
| `modelMapping` | 不额外改名，未命中的模型原名透传 |
| `apiFormats` | API 不限制 |
| `modelApiFormats` | 不增加单个模型的 API 限制 |

四项配置互相独立。只配置映射不代表只支持被映射的模型；只声明 API 不要求填写模型；删除最后一个支持模型会恢复全部支持。禁用 provider 仍使用 `enabled: false`。

如果仍保留旧模型重写 hook 或 `x-target-model`，没有命中新映射时，旧配置继续生效；“原名透传”指新路由层不额外改写，并不会自动删除旧设置。

## 多模型和映射示例

以下是一个实例的 `forwards` 片段，域名仅为示意：

```json
[
  {
    "name": "glm",
    "path": "/glm",
    "target": "https://provider-a.example",
    "enabled": true,
    "models": ["glm-5.3", "glm-5.3-flash"],
    "modelMapping": {
      "local-glm": "glm-5.3",
      "local-fast": "glm-5.3-flash"
    },
    "apiFormats": ["responses", "anthropic-messages"],
    "modelApiFormats": {
      "glm-5.3-flash": ["anthropic-messages"]
    }
  },
  {
    "name": "glm",
    "path": "/glm",
    "target": "https://provider-b.example",
    "enabled": true,
    "modelMapping": {
      "local-glm": "glm-5.3",
      "local-fast": "glm-5.3-flash"
    },
    "apiFormats": ["responses"]
  }
]
```

- `POST /glm/v1/messages` + `model: local-fast`：第一条规则可以接收，发送上游的模型为 `glm-5.3-flash`。
- `POST /glm/v1/responses` + `model: local-fast`：跳过第一条规则，选择第二条规则。
- 第二条没有 `models`，所以其他模型也可按原名发给它，不需要列出所有模型。
- 每个 provider 都可以给同一个客户端模型配置不同目标名称；失败回退时始终从原始客户端名称重新计算，不沿用上一条规则的改写结果。

名称精确匹配、区分大小写。配置名称两端空白会去除；支持列表和 API 选项会去重。此功能不做正则或通配映射；如继续使用旧重写插件，其规则语义保持原样。

## API 能力不等于协议转换

`apiFormats` 可选值：
- `responses`：Responses，包括 `/responses/compact`。
- `anthropic-messages`：Anthropic Messages，包括 `/messages/count_tokens`。
- `chat-completions`：Chat Completions。

识别基于客户端原始路径及转发路由前缀，不根据模型名称猜测协议。未知通用端点不应用 API 筛选。`modelApiFormats` 使用映射后的目标模型名作为键，与 provider API 限制取交集。

声明的是 **provider 结合现有 hooks 后可接受的客户端 API**。例如已经配置 Responses → Messages 转换 hook 的规则可以声明 `responses`；仅勾选 Responses 不会自动转换请求、响应或目标 URL。

转换插件的目标 URL 仍按原有方式配置。例如客户端路径 `/codex/v1/responses`、目标 URL `https://upstream.example/v1/messages`，搭配现有转换 hook；路由层不会凭 API 声明修改 URL。

旧的 `/droid` → `/anthropic` 专用别名回退仍保留来源规则的转换 hooks 和客户端 API 声明，模型支持和新映射则按实际传输 provider 判断；此特殊回退不会变成任意分组间的回退。

## 优先级、错误和边界

1. 按现有 method/path 规则选择分组，只考虑启用且匹配的候选。
2. 按 provider 映射后的目标模型、客户端 API 和按模型细分的 API 限制筛选，保持兼容候选的原顺序。
3. 新映射命中时优先于旧 `x-target-model` 和模型重写 hook；在协议转换前提供目标模型，并在 hooks 后确保映射结果有效。建议清理重复的固定重写配置。
4. 只有旧 hooks 改名的规则会在 hooks 后复核最终模型，确保显式支持列表不被绕过。
   对 count_tokens 等插件本地短路响应，按原始模型或新映射后的目标复核能力，不允许短路绕过限制；不要依赖旧 hook 在短路链中间临时改名来声明能力，建议改用直接映射。
5. 没有兼容 provider：HTTP 422，`error.code = no_compatible_provider`，附分组、请求模型、API 和简短原因，不发起不兼容的上游请求。
6. 模型请求缺少有效字符串 `model` 或 JSON 无效，且候选全部需要显式模型时：HTTP 400，`error.code = invalid_model_request`。
7. GET 模型列表、健康检查等通用非模型请求不要求填写模型。无新配置的旧代理继续透传，不新增强制协议校验。

保持现有失败回退、取消和 SSE 行为；开始返回流数据后不切换 provider。超时保持现有的整条请求中止语义，不向其他 provider 重放。

首期支持 HTTP JSON/SSE。匹配分组中只要有启用的规则配置了非空的新模型/API 限制或映射，WebSocket 升级就会返回 HTTP 422 和 `websocket_model_routing_not_supported`，避免静默绕过设置。未配置这些字段的旧 WebSocket 透传不受影响。

配置可通过既有热更新生效；若关闭了实例“自动推送”，保存后需点击“热更新”。不会自动重启实例，也不会查询第三方 `/models` 来猜测能力。

## 本地验证

```sh
bun ts
bun test tests/provider-routing.test.ts tests/provider-routing.integration.test.ts
```

集成测试使用 `tests` 下的隔离配置、数据库和本地 mock 上游，不访问真实模型 provider。
