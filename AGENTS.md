<!-- OPENSPEC:START -->
# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->

<coding_guidelines>
- 这是一个简单的可视化代理服务器，使用bun开发
- bun内置了bundle功能，所以我们用它来提供 html/ts 的编译服务，替代了vite
- 我们使用 shadcnui+tailwindcss+react 来做前端开发
- 充分使用 lucide-react 来绘制所需的图标
- 在项目目录下使用 `bun ts` 来做类型检查
- 因为这是一个工具型项目，所以默认情况下，不用考虑任何破坏性变更的向下兼容。如果有需要，我可以直接清空数据库。
- 临时的测试文件统一放到 `tests` 文件夹下
- 当前迭代目标：以 JSON 为唯一配置真相（name 作为唯一标识，实例内嵌转发规则），彻底移除旧的 SQLite 配置/自增 id；日志存储改为单表 JSON（无需兼容旧结构）；实现"配置 reload + 文件监听 + UI 开关"，保证 Proxy Viewer 可热更新配置并实时显示 20002 等新实例的请求。
</coding_guidelines>

<git_workflow>
- main 分支受保护，禁止直接 push，必须通过 PR 合并
- 本地开发必须使用 git worktree，在 `.git-worktree/<branch-name>` 目录下工作
- 工作流程：
  1. `git worktree add .git-worktree/feat-xxx -b feat/xxx` 创建工作树
  2. 在 `.git-worktree/feat-xxx` 目录下开发
  3. 完成后 push 分支并创建 PR
  4. PR 合并后清理：`git worktree remove .git-worktree/feat-xxx`
</git_workflow>

<architecture_notes>
- 2026-08-12 原始需求：同名 forward 组会自动轮换；需要为单个节点提供“锁”开关，使其在自动排序时保持当前组内 index。
- 同名 forward 的健康度排序先生成完整排名，再将 `orderLocked` 节点放回当前槽位，其他节点按排名稳定填充空槽位。锁不影响请求候选资格或健康度采样。
- 2026-08-12 原始需求：在本机先排查 `aiweb.xin` 直连异常。直连同一 IP `39.107.213.167` 时，Node TLS 1.3 可得到 HTTP 401，Bun 1.3.14 与 macOS LibreSSL 在 ClientHello 后收到 `ECONNRESET`；清除所有代理环境变量后结论不变。该失败发生在 HTTPS 建连前，与 Proxy 路由和 new-api HTTP 应用层无关；本地兼容策略是仅在 Bun TLS reset 后使用 Node TLS bridge 重试。
</architecture_notes>
