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

- 这是一个简单的可视化代理服务器，使用bun开发
- bun内置了bundle功能，所以我们用它来提供 html/ts 的编译服务，替代了vite
- 我们使用 shadcnui+tailwindcss+react 来做前端开发
- 充分使用 lucide-react 来绘制所需的图标
- 在项目目录下使用 `bun ts` 来做类型检查
- 因为这是一个工具型项目，所以默认情况下，不用考虑任何破坏性变更的向下兼容。如果有需要，我可以直接清空数据库。
- 临时的测试文件统一放到 `tests` 文件夹下
- 当前迭代目标：以 JSON 为唯一配置真相（name 作为唯一标识，实例内嵌转发规则），彻底移除旧的 SQLite 配置/自增 id；日志存储改为单表 JSON（无需兼容旧结构）；实现“配置 reload + 文件监听 + UI 开关”，保证 Proxy Viewer 可热更新配置并实时显示 20002 等新实例的请求。
