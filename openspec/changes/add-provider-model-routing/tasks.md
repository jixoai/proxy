## 1. Approval
- [ ] 1.1 用户确认模型默认全支持、映射默认透传、可选 API 能力及首期 HTTP 范围后实施。

## 2. Configuration
- [ ] 2.1 增加可选模型、精确映射、provider API 和按模型细分 API 的类型、schema、归一化及配置测试。
- [ ] 2.2 贯穿实例管理、worker 配置消息、热更新、运行快照和配置一致性检查。

## 3. Routing
- [ ] 3.1 实现无副作用的模型提取、API 识别、目标映射与兼容性判断。
- [ ] 3.2 集成候选筛选与各尝试独立重写，保留原排序、失败回退、超时与取消。
- [ ] 3.3 处理旧模型重写和转换 hook 的优先级、特定别名回退与发送前最终模型复核。
- [ ] 3.4 提供无兼容 provider、无法提取模型及受限 WebSocket 的明确错误，避免静默绕过限制。

## 4. Viewer
- [ ] 4.1 新增和编辑 provider 支持模型、独立映射以及可选 provider / 模型 API 能力。
- [ ] 4.2 增加默认全支持/透传提示、重复旧配置提示及紧凑摘要；保留分组折叠交互。

## 5. Verification And Documentation
- [ ] 5.1 单元测试覆盖默认行为、独立配置、映射、API 交集与错误分支。
- [ ] 5.2 本地 mock 集成测试覆盖模型/API 路由、映射隔离、回退、取消、转换 hook 与零兼容候选。
- [ ] 5.3 验证配置 round-trip、热更新、WebSocket 边界与 SSE 回归。
- [ ] 5.4 浏览器验证编辑体验；执行 `bun ts`、相关测试、格式和 diff 检查。
- [ ] 5.5 更新配置文档与示例；执行 OpenSpec 严格验证（CLI 可用时），当前分支提交。

## Proposal Validation
- 本机没有 OpenSpec CLI，未执行严格验证；已按 ADDED Requirements / Scenario 格式编写，实施前在 CLI 可用时补跑。
