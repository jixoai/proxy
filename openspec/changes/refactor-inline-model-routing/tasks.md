## 1. Approval

- [x] 1.1 用户确认模型级统一配置、卡片内编辑和默认全支持语义。

## 2. Configuration And Routing

- [x] 2.1 实现 `modelRouting` 模型条目、all/listed 模式和别名冲突验证，删除旧四字段。
- [x] 2.2 更新模型/别名解析和逐模型 API 筛选，移除 provider API；保留回退和 hooks 边界。
- [x] 2.3 更新配置启动/序列化/reload/快照，提供明确的旧配置诊断及迁移文档。

## 3. Targeted Save And Inline UI

- [x] 3.1 实现按稳定规则 ID 的定向保存、模型配置冲突检测及原配置通知。
- [x] 3.2 实现紧凑模型行、行内编辑、API 多选、空状态和超过 3 行的展开行为。
- [x] 3.3 实现明确保存/取消、错误/冲突、跨折叠/排序保留草稿及窄屏布局。
- [x] 3.4 删除基础弹窗中重复的模型表单；新增/复制及基础配置保存正确保留已保存模型。

## 4. Verification

- [x] 4.1 覆盖默认透传、显式白名单、模型/别名 API 区分、冲突和热更新的单元/集成测试。
- [x] 4.2 覆盖定向保存、配置冲突、并发更新和稳定 ID 排序后的保存测试。
- [x] 4.3 隔离浏览器验证桌面/390px、键盘、编辑/取消/保存、失败、折叠和列表高度。
- [x] 4.4 执行 `bun ts`、相关回归、格式/diff 检查和 OpenSpec 验证（CLI 可用时），当前分支提交。

## Verification Results

- `bun ts` 通过；相关 21 个测试文件共 228 项通过，0 失败（包含三个模型/协议转换插件回归）。
- 覆盖同 provider 两模型不同 API、原名/别名等价、未知模型透传、legacy hook 最终模型 API、Droid 实际传输模型 API、SSE/取消/超时/WebSocket 边界、worker 快照/reload。
- 保存测试覆盖稳定 ID/重排、并发 CAS 409、缺失 404、严格字段校验、基础设置保留最新模型，以及旧字段校验失败时不产生部分写入。
- 完整隔离 Viewer API 手动验证 200/400/404/409，包括无效 JSON、空 listed、基础设置不得覆盖模型。未启动或修改用户真实实例。
- Ego Browser 使用同一隔离任务空间验证桌面/390px、API 键盘开关/Escape 焦点返回、行内编辑/新增/校验/删除草稿、取消/保存、默认三行/展开、折叠保留、重排按 ID 保存、断网保留与重试、外部冲突和载入最新。
- 已检查两轮桌面/窄屏截图；390px 下模型区域 clientWidth/scrollWidth 均为 285px，无模型输入或按钮越界。页面原有顶部实例工具栏仍使整页宽度达到 487px，本次未修改范围外布局。
- UI detector 已运行；修改的组件、配置/表单 helper、测试和文档通过 Prettier 检查，`git diff --check` 通过。隔离 Viewer、任务空间和临时文件均已清理。

## Proposal Validation

- 本机 OpenSpec CLI 不可用，`bunx --no-install @fission-ai/openspec list` 报缺少二进制。未执行严格验证；仅对 delta Requirement/Scenario 结构进行本地检查。
- 本次本地结构检查通过：4 个 Requirement 均包含 Scenario / WHEN / THEN；不等同于 OpenSpec 严格验证。
