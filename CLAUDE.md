<coding_guidelines>
- 这是一个简单的可视化代理服务器，使用bun开发
- bun内置了bundle功能，所以我们用它来提供 html/ts 的编译服务，替代了vite
- 我们使用 shadcnui+tailwindcss+react 来做前端开发
- 充分使用 lucide-react 来绘制所需的图标
- 在项目目录下使用 `bun ts` 来做类型检查
- 因为这是一个工具型项目，所以默认情况下，不用考虑任何破坏性变更的向下兼容。如果有需要，我可以直接清空数据库。
- 临时的测试文件统一放到 `tests` 文件夹下
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
