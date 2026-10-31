# Change: Model-Centric Inline Routing Configuration

## Why
- 上一版将支持模型、模型映射、provider API、模型 API 分成四块，用户需要在多个位置维护同一个模型的信息。
- API 支持能力应归属具体模型，不应再由 provider 总开关与模型声明取交集。
- 模型设置位于完整编辑弹窗内，常见的改名、增删模型、切换 API 都需要离开列表语境。

## What Changes
- 用统一的模型条目维护上游模型名、可选客户端别名和该模型自己的 API 能力；移除 provider 级 API 配置。
- 在每条 provider 卡片内直接展示模型行，支持原位新增、编辑、移除和 API 多选，无需打开规则编辑弹窗。
- 保留未配置时支持全部模型、无映射时原名透传；增加明确的“全部模型 / 仅表内模型”接收模式，使添加别名或能力声明不会自动产生白名单。
- 编辑采用 provider 级草稿和明确保存/取消，不在每次键入或点击协议时更新运行配置。
- 基础编辑弹窗仅保留 URL、Headers、Hooks、超时等 provider 配置，不再提供重复的模型编辑入口。新增 provider 可先不配模型，创建后就在卡片配置。
- 为原位编辑提供按规则稳定 ID 定位、只更新模型配置的保存操作及冲突检测，避免排序后误改其他规则或整份配置覆盖。

## Impact
- Affected specs: provider-model-routing；变更并替代 `add-provider-model-routing` 中四字段模型及交互设计，不修改已完成变更的历史记录。
- Affected code: 路由 schema/types、候选模型解析、worker 序列化、配置保存 API、provider 卡片和模型编辑控件、复制与新增/编辑规则、相关测试和文档。
- **Breaking configuration change**：合并为 `modelRouting`；不保留旧四字段作为第二套真相。不自动清空或修改用户配置；旧字段明确报错，不静默忽略后放宽路由。实施时附迁移说明；provider 级 API-only 配置必须改为逐模型声明，无法凭空推断全部模型。
- 不增加协议转换，不扩展 HTTP/SSE 与 WebSocket 的既有边界，不改变失败回退、取消、超时策略。

## Approval
- 本提案待用户确认；当前只完成方案，未修改运行代码或真实配置。
