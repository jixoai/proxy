## 1. Approval
- [x] 1.1 用户确认模型默认全支持、映射默认透传、可选 API 能力及首期 HTTP 范围后实施。

## 2. Configuration
- [x] 2.1 增加可选模型、精确映射、provider API 和按模型细分 API 的类型、schema、归一化及配置测试。
- [x] 2.2 贯穿实例管理、worker 配置消息、热更新、运行快照和配置一致性检查。

## 3. Routing
- [x] 3.1 实现无副作用的模型提取、API 识别、目标映射与兼容性判断。
- [x] 3.2 集成候选筛选与各尝试独立重写，保留原排序、失败回退、超时与取消。
- [x] 3.3 处理旧模型重写和转换 hook 的优先级、特定别名回退与发送前最终模型复核。
- [x] 3.4 提供无兼容 provider、无法提取模型及受限 WebSocket 的明确错误，避免静默绕过限制。

## 4. Viewer
- [x] 4.1 新增和编辑 provider 支持模型、独立映射以及可选 provider / 模型 API 能力。
- [x] 4.2 增加默认全支持/透传提示、重复旧配置提示及紧凑摘要；保留分组折叠交互。

## 5. Verification And Documentation
- [x] 5.1 单元测试覆盖默认行为、独立配置、映射、API 交集与错误分支。
- [x] 5.2 本地 mock 集成测试覆盖模型/API 路由、映射隔离、回退、取消、转换 hook 与零兼容候选。
- [x] 5.3 验证配置 round-trip、热更新、WebSocket 边界与 SSE 回归。
- [x] 5.4 浏览器验证编辑体验；执行 `bun ts`、相关测试、格式和 diff 检查。
- [x] 5.5 更新配置文档与示例；执行 OpenSpec 严格验证（CLI 可用时），当前分支提交。

## Proposal Validation
- 本机没有 OpenSpec CLI，未执行严格验证；已按 ADDED Requirements / Scenario 格式编写，实施前在 CLI 可用时补跑。

## Implementation Verification
- 新增 17 项单元测试、22 项隔离 mock 集成测试，覆盖启动快照、热更新、并发、协议过滤、映射隔离、转换插件、本地短路限制、SSE、取消、超时和 WebSocket 边界。
- `bun ts`、Prettier 和 `git diff --check` 通过；相关回归共 218 项通过、0 失败（20 个测试文件），包含 worker 恢复、配置存储、折叠偏好、hooks 与已有转换插件测试。
- 实际浏览器验证新增映射（不填写支持列表）、不完整映射报错、编辑/保存/重新打开、清空恢复默认、复制配置和折叠刷新；390px 下新增控件无横向溢出，桌面/窄屏截图已检查。
- 所有浏览器和集成验证使用 `tests` 下的独立配置和数据；临时预览已停止并清理，未操作真实 provider。
- OpenSpec CLI 仍不可用，`bunx --no-install @fission-ai/openspec validate add-provider-model-routing --strict` 报缺少二进制；未冒充严格验证成功。
- 补齐 hooks 加载器对现有 `createCodexPlugin` 工厂的支持，使 Responses → Messages 集成可执行；不改变转换插件自身规则。
- 超时继续中止整条请求，不新增超时重放；普通上游错误仍按现有顺序回退。
