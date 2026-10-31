# 模型路由、别名与逐模型 API

## 默认无需配置

转发规则（provider）不配置 `modelRouting`，或配置为 `null`，表示**接收所有模型、模型原名透传、API 不限制**。不需要为了使用代理先维护模型列表。

在“转发规则”页面，直接在 provider 卡片内配置：

- **接收模型**：`全部模型（默认）` 或 `仅表内模型`。
- **上游模型**：实际发给上游的名称，同时也接收客户端使用此名称的请求。
- **客户端别名**：可选，多个用逗号或换行分隔；命中后改写成同一行的上游模型名。
- **支持的 API**：只作用于当前模型和它的别名。全部取消表示不限制，不存在 provider 级 API 开关。

点击行内“编辑”可修改模型和别名；API 摘要可直接打开多选。新增、删除、切换模式和 API 选择都先保留为草稿，需点击“保存模型配置”才保存。禁用 provider 仍可编辑。

默认只显示前三个模型，其他模型可展开；编辑时显示完整草稿。分组折叠和排序不会丢失模型草稿。基础设置弹窗不再重复放置模型表单，保存基础设置不会覆盖最新模型配置。复制规则会复制已保存的模型配置，不会复制未保存草稿。

## JSON 示例

以下是 `instances[].forwards` 中的两条示例规则，不代表这些模型的真实上游能力：

```json
[
  {
    "name": "glm",
    "path": "/glm",
    "target": "https://provider-a.example",
    "enabled": true,
    "modelRouting": {
      "mode": "all",
      "models": [
        {
          "name": "glm-5.3",
          "aliases": ["local-glm"],
          "apiFormats": ["responses", "anthropic-messages"]
        },
        {
          "name": "glm-5.3-flash",
          "aliases": ["local-fast"],
          "apiFormats": ["anthropic-messages"]
        }
      ]
    }
  },
  {
    "name": "glm",
    "path": "/glm",
    "target": "https://provider-b.example",
    "enabled": true,
    "modelRouting": {
      "mode": "listed",
      "models": [
        {
          "name": "glm-5.3-flash",
          "aliases": ["local-fast"],
          "apiFormats": ["responses"]
        }
      ]
    }
  }
]
```

- `/glm/v1/messages` + `local-fast`：使用 A，发给上游的名称为 `glm-5.3-flash`。
- `/glm/v1/responses` + `local-fast`：A 的该模型不接收 Responses，跳过后使用 B。
- 使用上游原名 `glm-5.3-flash` 发起请求，得到相同的逐模型 API 筛选结果。
- A 的模式为 `all`，未列出的模型依然原名透传、API 不限制。只添加别名不会隐式形成白名单。
- B 的模式为 `listed`，仅接收表内上游名称或别名。该模式不允许保存空表；需要恢复默认时切回 `all`。

名称精确匹配、区分大小写；配置时去除两端空白。别名和 API 去重，同一行的同名别名移除。不同模型的名称和别名不得冲突，不做正则或通配映射。`all` 空表归一化为 `null`。

## API 声明与 hooks

逐模型 `apiFormats` 可选值：

- `responses`：Responses，含 `/responses/compact`。
- `anthropic-messages`：Anthropic Messages，含 `/messages/count_tokens`。
- `chat-completions`：Chat Completions。

省略、`null` 或空数组表示该模型 API 不限制。没有与其他模型、provider 全局设置的继承或交集。识别基于客户端原始路径及转发前缀，不根据模型名猜测。未知通用端点不做 API 筛选。

声明的是 **provider 结合现有 hooks 后可接收的客户端 API**，并不自动转换协议。例如已有 Responses → Messages 转换 hook 的模型可以声明 `responses`；仅勾选 Responses 不会转换请求、响应或目标 URL。转换插件的目标 URL 仍按原有方式配置。

命中新别名时，新映射优先于旧 `x-target-model` 和模型重写 hook，转换前提供目标名称，hooks 后确保映射不被覆盖。没有命中新别名时，旧 hooks 继续工作，并按 hooks 最终目标模型复核逐模型 API 和白名单。

`count_tokens` 等插件本地短路响应也需要满足模型/API 声明，按原始模型或新映射后的目标复核；不要依赖短路 hook 链中临时改名来绕过限制，建议使用直接别名配置。

`/droid` → `/anthropic` 的专用回退仍保留来源转换 hooks，但模型、别名和逐模型 API 均使用实际传输 provider 的配置，不形成任意分组间的回退。

## 保存、热更新与错误

模型保存使用稳定的 forward ID，不依赖列表下标。保存只替换该规则的 `modelRouting`，保留最新名称、地址、启用状态、headers、hooks、超时和排序。保存时比较编辑开始的模型快照；其他操作已修改同一模型配置则返回 409，不覆盖他人修改，草稿仍保留，可载入最新配置后重编。

保存接口：`PATCH /api/config/instances/:name/forwards/:id/model-routing`，请求为 `{ "expected": null, "modelRouting": { ... } }`；`expected` 必须是编辑开始时的模型配置（无配置用 `null`）。删除/不存在的规则返回 404，校验错误返回 400。基础设置使用同一路径去掉 `/model-routing` 的 PATCH，只允许基础字段，不接受 `modelRouting`、`id` 或 `enabled`。

保存通过现有配置通知和热更新机制生效；关闭实例“自动推送”时需要手动“热更新”。不会重启实例或查询第三方 `/models` 猜测能力。

转发仍按同组启用且匹配 method/path 的候选顺序进行：

- 没有兼容 provider：422，`error.code = no_compatible_provider`，不向不兼容上游发送请求。
- 模型缺失/无效或 JSON 无效，且候选都要求有效模型：400，`error.code = invalid_model_request`。
- GET 模型列表和无模型的健康检查等通用请求不要求填写模型。
- 失败回退按每个 provider 从原始客户端名称重新映射；保留 SSE 和取消行为，开始返回流后不切换 provider。
- 超时保持整条请求中止语义，不向其他 provider 重放。
- 当前支持 HTTP JSON/SSE。匹配组里只要有启用规则配置非空模型路由，WebSocket 升级返回 422 / `websocket_model_routing_not_supported`，避免绕过设置；完全无模型配置的 WebSocket 仍透传。

## 从旧四字段迁移

旧字段 `models`、`modelMapping`、provider 顶层 `apiFormats`、`modelApiFormats` 已移除，**即使填空值也会明确报错**，不能与新字段并存。系统不会自动改写实际配置文件。

迁移时手动合并成 `modelRouting.models`，检查完成后删除所有旧四字段：

1. 旧非空 `models` 是目标模型白名单，对应 `mode: "listed"`；为每个目标模型建立 `name` 行。
2. 旧 `modelMapping` 中每个客户端名称放入对应上游行的 `aliases`。仅有映射而无白名单时使用 `mode: "all"`，继续允许其他模型透传。
3. 旧白名单与映射同时存在时，只为白名单内的目标创建可接收行；映射到白名单外的目标原本不可接收，不能直接添加进新白名单而静默放开。
4. 有限模型上的旧全局 API 与旧逐模型 API，原来是取非空限制的交集；将最终允许值逐行填入 `apiFormats`，不直接复制两份独立设置。
5. 如果旧交集为空，**不能写成空数组**，因为新空数组表示不限制。应明确决定该模型要允许哪些 API，或从 `listed` 中移除该模型；不要静默扩大权限。
6. 旧配置只有全局 API 限制、没有有限模型名单时，新结构无法无损表示“任意未知模型都只支持某 API”。请补充具体模型并使用 `listed`，或明确接受 `all` 下未知模型不限制的行为；不能猜测模型名单或静默放宽。
7. 全部为空的旧声明可以移除，不填 `modelRouting` 即恢复默认全支持。

例如原先 `models: ["glm-5.3"]`、`modelMapping: { "local-glm": "glm-5.3" }`，且最终只允许 Responses，可改为：

```json
{
  "modelRouting": {
    "mode": "listed",
    "models": [{ "name": "glm-5.3", "aliases": ["local-glm"], "apiFormats": ["responses"] }]
  }
}
```

## 本地验证

```sh
bun ts
bun test tests/provider-routing.test.ts tests/provider-routing.integration.test.ts tests/model-routing-update.test.ts
```

集成测试使用 `tests` 下的隔离配置、数据库和本地 mock 上游，不访问真实 provider。
