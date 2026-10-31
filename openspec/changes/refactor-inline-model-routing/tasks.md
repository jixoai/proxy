## 1. Approval
- [ ] 1.1 用户确认模型级统一配置、卡片内编辑和默认全支持语义。

## 2. Configuration And Routing
- [ ] 2.1 实现 `modelRouting` 模型条目、all/listed 模式和别名冲突验证，删除旧四字段。
- [ ] 2.2 更新模型/别名解析和逐模型 API 筛选，移除 provider API；保留回退和 hooks 边界。
- [ ] 2.3 更新配置启动/序列化/reload/快照，提供明确的旧配置诊断及迁移文档。

## 3. Targeted Save And Inline UI
- [ ] 3.1 实现按稳定规则 ID 的定向保存、模型配置冲突检测及原配置通知。
- [ ] 3.2 实现紧凑模型行、行内编辑、API 多选、空状态和超过 3 行的展开行为。
- [ ] 3.3 实现明确保存/取消、错误/冲突、跨折叠/排序保留草稿及窄屏布局。
- [ ] 3.4 删除基础弹窗中重复的模型表单；新增/复制及基础配置保存正确保留已保存模型。

## 4. Verification
- [ ] 4.1 覆盖默认透传、显式白名单、模型/别名 API 区分、冲突和热更新的单元/集成测试。
- [ ] 4.2 覆盖定向保存、配置冲突、并发更新和稳定 ID 排序后的保存测试。
- [ ] 4.3 隔离浏览器验证桌面/390px、键盘、编辑/取消/保存、失败、折叠和列表高度。
- [ ] 4.4 执行 `bun ts`、相关回归、格式/diff 检查和 OpenSpec 验证（CLI 可用时），当前分支提交。

## Proposal Validation
- 本机 OpenSpec CLI 不可用，`bunx --no-install @fission-ai/openspec list` 报缺少二进制。未执行严格验证；仅对 delta Requirement/Scenario 结构进行本地检查。
