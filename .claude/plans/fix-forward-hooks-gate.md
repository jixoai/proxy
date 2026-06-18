# 修复：forward 级 hook 被 instance 级总开关误跳过

## 根因（已确诊）

提交 `4ae9d96`（2026-06-17 21:16）为消除并发竞态，把 forward hooks 从「实例共享状态 `this.forwardHooksLoaded`」改成「请求级局部变量 `forwardHooksLoaded`」——方向正确。但配套的总开关 getter 漏改：

`src/lib/hooks-executor.ts:434-444`
```ts
get hasHooks() { return this.instanceHooksLoaded.length > 0; }   // forward 那半截被删
get hasRequestHooks() { return this.hasHooks; }
get hasResponseHooks() { return this.hasHooks; }
```

`src/proxy-server.ts` 用这俩 **实例级** getter 当 hook 执行总开关（5 处：705、959、977、1148、1391）。当 instance 顶层 `hooks` 为 `null`（如 `llm-lab`）时 → `hasRequestHooks/hasResponseHooks` 恒为 false → 哪怕本次请求已 `loadForwardHooks()` 加载好了 model-rewrite 等 forward 级插件，整个执行块都被跳过。

后果：请求 4842 走到了带 model-rewrite(glm-5.2) 的 anthropic forward，但 hook 没跑 → `claude-opus-4-8` 原样发往 elysiver → 403，且 `hook_layers` 无记录。该 instance 下所有 forward 级请求/响应 hook 全部静默失效。

`tests/model-rewrite-concurrency.test.ts:62-76` 把这个错误行为当成预期固化了（断言 forward-only executor `hasRequestHooks===false`）。

## 设计判断

用户的设计（每条 forward 独立挂 hook）是对的，无需改配置结构。问题纯粹是「判断本次请求要不要跑 hook」的依据用错了：新模型下这件事**无法由实例状态决定**，必须把本次请求实际加载的 `forwardHooksLoaded` 一起算进来。

## 实施方案

### 1. `src/lib/hooks-executor.ts`：getter 改为接受请求级 hooks 的方法
保留无参 getter（实例级，向后兼容），新增两个方法把 forward hooks 纳入判断：
```ts
hasRequestHooksFor(forwardHooksLoaded: LoadedHook[] = []): boolean {
  return [...this.instanceHooksLoaded, ...forwardHooksLoaded].some(h => h.plugin.onRequest);
}
hasResponseHooksFor(forwardHooksLoaded: LoadedHook[] = []): boolean {
  return [...this.instanceHooksLoaded, ...forwardHooksLoaded].some(h => h.plugin.onResponse);
}
```
（顺带比旧 getter 更精确：按 onRequest/onResponse 能力区分，避免无谓缓冲。）

### 2. `src/proxy-server.ts`：5 处门槛改用新方法
- 705：`hooksExecutor?.hasRequestHooks` → `hooksExecutor?.hasRequestHooksFor(forwardHooksLoaded)`
- 959、977、1148：`hasResponseHooks` → `hasResponseHooksFor(forwardHooksLoaded)`（均在候选循环内，变量在作用域）
- 1391：`hasResponseHooks` → `hasResponseHooksFor(forwardHooksLoadedForFinalResult)`

### 3. `tests/model-rewrite-concurrency.test.ts`：修正被固化的错误断言
把 "hasRequestHooks 应该只检查 instance hooks" 用例改为验证正确语义：
- instance-only：`hasRequestHooksFor([]) === true`
- forward-only：`hasRequestHooksFor(loadedForwardHooks) === true`（这正是 4842 的场景）
- 两者皆空：`hasRequestHooksFor([]) === false`

### 4. 新增回归测试
在 `tests/` 下加一个用例，直接复现 4842：instance hooks=null + forward 挂 model-rewrite，断言走 `hasRequestHooksFor` 判定为 true 且 `executeRequestHooksWithLayers` 把 model 改写成功。

## 验证
1. `bun ts`（类型检查）
2. `bun test tests/hooks-executor-config.test.ts tests/model-rewrite-concurrency.test.ts 及新增用例`
3. 复核 5 处调用点变量作用域无误

## Git 流程（按 CLAUDE.md）
当前已在 `feat-model-rewrite-1` 分支且 worktree 规则要求在 `.git-worktree/` 下开发。**待确认**：直接在当前分支改，还是按规范新建 worktree（如 `.git-worktree/fix-forward-hooks-gate`）。不主动 push / 建 PR。

## 不做的事
- 不改配置文件、不改 forward 数据结构、不引入组级/ target 级 hook 继承（用户已明确否定重构方向）。
- 不动 4254 之前的历史现象（那是配置当时确实没挂 hook，与本 bug 无关）。
