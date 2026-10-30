# Change: Add Provider Model Routing

## Why
- 同名转发规则中的每条规则实际承担一个 provider 的职责，但目前仅按启用状态、路径和方法确定候选，无法跳过不支持所请求模型或 API 的 provider。
- 模型重写插件已经支持对象形式的多条映射，但规则编辑界面缺少模型能力与映射的直接配置；单一固定重写和人工关闭 provider 的配置成本较高。
- 用户明确要求模型能力和映射均非必填：未配置模型列表视为支持组内请求的全部模型，没有映射时保持请求模型名，不要求列出所有模型。

## What Changes
- 每条 provider 规则增加可选的模型支持列表 `models`、精确名称映射 `modelMapping`、API 能力 `apiFormats` 和按模型细分的 API 能力 `modelApiFormats`。
- 模型列表未填写或为空时，不限制模型；映射未填写、为空或未命中时不改名，且配置映射本身不等于配置模型白名单。
- API 未填写或为空时不限制；推荐支持 Responses、Anthropic Messages、Chat Completions 的可选筛选，而不是要求所有 provider 手工声明。
- 按请求模型及 API 筛选启用的兼容 provider，保留既有优先顺序及失败回退；每次回退从原始请求独立计算映射。
- 可视化编辑提供模型行、可选别名及 API 多选，并清晰展示“全部模型 / API 不限制 / 原名透传”的默认含义。
- 对没有兼容 provider 的请求返回可诊断的结构化错误，不盲目发送到不兼容或不相关的规则。

## Impact
- Affected specs: provider-model-routing (new)
- Affected code: JSON schema/types、配置编辑/摘要、worker 配置序列化与热更新、HTTP 代理候选与重写逻辑、相关测试及文档。
- API 能力表示该 provider 结合现有 hooks 后能够接受的客户端协议，不声明或自动引入协议转换。
- 不改变现有分组折叠行为、不自动访问第三方模型列表、不为用户猜测模型名称或能力。
- 首期覆盖 HTTP JSON 与 SSE 请求。WebSocket 尚不能按消息里的模型选择 provider；存在显式模型/API 限制或新映射的 WebSocket 路由必须明确拒绝，不能静默忽略配置；完全未配置这些字段的旧 WebSocket 透传保持原样。

## Approval
- 待用户确认本提案后实施。之前的“按照建议实施”对应分组折叠，不视为已经批准本次路由变更。
