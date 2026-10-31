# 模型级配置与原位编辑

## Existing Surface
- 保持现有 shadcn/Tailwind 卡片、色彩、字体、Lucide 图标及分组折叠，不重做整个控制台。
- `ForwardRuleItem` 当前只显示模型/API 摘要，模型表单在 `EditForwardDialog`；列表排序还使用原始下标，保存不能依赖旧下标。
- `ProviderRoutingDraft` 当前有四份平行数据；本次以模型条目取代它们，不只把原表单搬到列表。

## Data Model

```json
{
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
}
```

- `modelRouting` 不配置：全部模型、原名透传、API 不限制。
- `mode` 省略或 `all`：未在表中出现的模型依然原名透传，API 不限制；表内模型/别名使用该行配置。这样只配映射仍不要求列出所有模型。
- `mode: listed`：只接收表内上游名称或其别名，未列出的模型跳过这个 provider；至少保留一行才可保存。
- `name` 是上游目标模型名，同时可直接作为客户端模型名使用；必填，精确、区分大小写匹配，配置时 trim。
- `aliases` 是可选客户端名称，可多个；命中后改为该行 `name`。留空就无需配置映射；原名请求也使用同一行 API 能力。
- `apiFormats` 只在模型行上存在。未配置或空数组表示不限制，选择后只支持该行所选的客户端协议；与 provider/其他模型无继承或交集关系。
- 不同模型不能有相同 `name`；一个别名不能指向多个模型，也不能与其他行的上游名称冲突。当前模型自己的同名别名去重移除。
- 缺省空表仍是全支持；`listed` 空表报错，不通过删除最后一行静默变为全支持。用户切回 `all` 后可以保存空表。
- 旧 `models: string[]`、`modelMapping`、顶层 `apiFormats`、`modelApiFormats` 不静默忽略。迁移时旧非空白名单对应 `listed`，仅映射对应 `all`；有限模型上的非空旧 API 交集可转成逐行声明，全局 API-only 必须由用户补充具体模型。旧交集为空不能转为空 API 数组（那会变成不限），须明确诊断并由用户重设；无法无损表达的旧声明不得猜测或放宽。

## Inline Layout

默认显示紧凑的已保存模型行，而不是默认展开大表单：

```text
Provider A · https://provider.example                 [启用] [基础设置] …
接收模型  [ 全部（默认） ▾ ]                              [+ 添加模型]

上游模型               客户端别名（可选）     支持的 API             操作
glm-5.3                local-glm             Responses  Messages     编辑 删除
glm-5.3-flash          local-fast            Messages                编辑 删除

其他模型仍按原名透传，API 不限制。
```

编辑或新增一行后，直接在该行出现输入框和 API 多选，不再弹完整规则编辑窗口：

```text
[glm-5.3-flash      ]  [local-fast  ×] [+别名]  [API：Messages ▾] [删除]

未保存的模型配置                                  [取消更改] [保存模型配置]
```

- 模型和别名均有持久可见的列标题/移动端字段标签，不依赖 placeholder。
- API 摘要是可操作控件，点击后显示就地多选小浮层：Responses / Messages / Chat Completions；显示完整协议名和“不限制”状态，空选含义明确。模型/别名修改在行内进行；不使用第二个大弹窗。
- 空状态只占一小行：“全部模型 · 原名透传 · API 不限制”及“添加模型”，不要求先创建模型。
- 接收模式是路由白名单范围，不是 provider API 开关。`all` 模式下持续显示“其他模型仍透传”的简短提示，避免误以为配置了几行就限制了其余模型。
- 模型超过 3 行时默认展示前 3 行和“展开其余 N 个模型”；有新行、错误或草稿的行始终可见，不截掉正在编辑的内容。保留组级折叠，避免重新形成长列表。
- 输入框只在编辑时出现；静态状态突出模型名和 API 摘要，别名次要；不嵌套卡片、不增加彩色协议装饰或动画。
- 窄屏按模型堆叠为“上游模型 / 客户端别名 / API”三段，操作按钮随行；不靠整页横向滚动。保存条在当前 provider 内容流中，不遮挡其他规则。
- 禁用 provider 仍可编辑模型；禁用的是转发，不是配置能力。

## Draft And Save Lifecycle
- 单条 provider 为保存单位，任何修改后才显示保存条；不自动保存，也不在 API 多选每次点击时发请求。
- 草稿以实例名 + forward ID 管理在可折叠内容之外，避免分组收起卸载卡片或排序后误丢草稿、串到另一条规则。展开时恢复，关闭页面不自动保存。
- 保存中禁用该 provider 的模型操作；成功后更新摘要并清除草稿。失败保留输入和错误，提供重试，原运行配置不变。
- 外部 reload 或另一页面改动模型配置时，不用新 props 覆盖脏草稿；显示冲突并允许重新载入。取消恢复最新已保存值，而非最初页面快照。
- 使用定向保存端点，例如 `PATCH /api/config/instances/:name/forwards/:id/model-routing`，请求包含期望的旧模型配置和新的 `modelRouting`。服务端按最新配置查找 ID、比较并仅替换这一字段；规则消失返回 404，模型配置冲突返回 409。
- 不覆盖目标 URL、密钥、启用状态、Headers、Hooks、规则排序或其他实例；模型变更仍走原有配置通知/自动推送链路。排序后按 ID 找到同一条规则。
- 复制 provider 复制已保存模型配置，不复制未保存草稿。基础编辑表单必须保留最新模型配置，不能把打开弹窗时的旧模型数据写回去。
- 复用一套 schema/草稿验证；新建 provider 后原位添加模型，避免弹窗和外部各维护一套模型表单。

## Routing And Boundaries
- 每个候选以原始模型匹配该 provider 的名称/别名，然后判断该行的 API；不同 provider 同名模型可有不同别名和 API。
- 不再检查 provider API 或做两级交集。目标模型的 API 同时适用于原名和别名请求。
- 保持“协议声明 = 已有 hooks 结合后可接受的客户端协议”，不自动做协议/URL 转换。
- 保持原始请求隔离、优先顺序、旧 hook 重写优先级的既有约定、缺失模型/无兼容 provider 错误、HTTP/SSE、超时/取消及受限 WebSocket 的明确错误。
- `/droid` 专用回退使用来源转换 hooks，但模型、别名和 API 全取实际传输 provider 的目标模型条目，不继承来源 provider 的 API 声明。
- 对最终被旧 hook 改名的目标重新匹配目标模型条目并检查 API，防止用原模型的协议声明绕过最终模型限制；新别名映射仍优先。

## Acceptance Checks
- 两个同 provider 模型可各自配置 Responses-only / Messages-only；原名与别名请求都正确筛选。
- 空配置、新增别名、未知模型透传、`listed`、别名冲突、清空和最后一行删除语义均有测试。
- provider/API 顶层字段彻底移除，旧输入不静默放行；配置文件、worker 初始化/热更新/快照一致。
- 不开基础编辑弹窗即可新增模型、改名/别名、选择 API、移除、取消或保存。
- 保存失败/冲突保留草稿；折叠、重排、外部配置更新、复制和基础设置保存不误改目标或丢失其他字段。
- 浏览器完成桌面/390px、键盘、API 浮层焦点、长模型名、空/多行及错误状态验证；检查组折叠回归。
