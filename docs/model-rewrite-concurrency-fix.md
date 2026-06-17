# Model Override 插件并发竞态问题修复

## 问题描述

在使用 `proxy-plugin-model-rewrite` 插件时，发现一个严重的并发竞态条件（Race Condition）问题：

**现象：**
- 请求 A 配置了 `model-rewrite` 插件，将模型改写为 `glm-5.1`
- 请求 B 没有配置任何插件
- 但请求 B 的模型也被意外修改成了 `glm-5.1`
- 或者请求 A 的插件配置被请求 B 清空

## 根本原因

### 问题代码

在 `src/lib/hooks-executor.ts` 中：

```typescript
export class HooksExecutor {
  private instanceHooksLoaded: LoadedHook[] = [];
  private forwardHooksLoaded: LoadedHook[] = [];  // ← 所有请求共享！
  
  async setForwardHooks(forwardName: string, hooks: HooksConfig | null): Promise<void> {
    const configs = normalizeHooksConfig(hooks);
    this.forwardHooksLoaded = await loadHooks(configs);  // ← 直接覆盖
  }
}
```

在 `src/proxy-server.ts` 中：

```typescript
for (let i = 0; i < candidateAttempts.length; i++) {
  // 每个请求都会调用 setForwardHooks
  await hooksExecutor.setForwardHooks(hookRule.name, hookRule.hooks ?? null);
  
  // 使用 forwardHooksLoaded（但可能已经被其他请求覆盖了！）
  const hookResult = await hooksExecutor.executeRequestHooksWithLayers(...);
}
```

### 并发时间线

```
时间轴：
T1: 请求A 开始 → setForwardHooks({model-rewrite: "glm-5.1"})
    └─ forwardHooksLoaded = [model-rewrite 插件]
    
T2: 请求B 开始 → setForwardHooks(null)
    └─ forwardHooksLoaded = []  ← 覆盖了请求A的配置！
    
T3: 请求A 继续执行 → executeRequestHooksWithLayers()
    └─ 使用的是 forwardHooksLoaded = []  ← 插件丢失了！
    
T4: 请求B 执行 → executeRequestHooksWithLayers()
    └─ 如果请求A先执行完，可能会使用请求A的插件配置
```

## 解决方案

### 核心思路

**将 `forwardHooksLoaded` 从实例级别的共享状态改为请求级别的局部变量。**

### 修改内容

#### 1. hooks-executor.ts

```typescript
export class HooksExecutor {
  private instanceHooksLoaded: LoadedHook[] = [];
  // ✅ 移除了 forwardHooksLoaded 共享状态

  /**
   * 加载 forward hooks 并返回（请求级别，避免并发竞态）
   */
  async loadForwardHooks(hooks: HooksConfig | null): Promise<LoadedHook[]> {
    const configs = normalizeHooksConfig(hooks);
    return await loadHooks(configs);  // ✅ 返回而不是保存
  }

  async executeRequestHooksWithLayers(
    params: RequestHookParams,
    bodyToDataUrl: (body: Buffer) => string | null,
    forwardHooksLoaded: LoadedHook[] = [],  // ✅ 作为参数传入
  ): Promise<RequestHooksExecutionResult> {
    const allHooks = [...this.instanceHooksLoaded, ...forwardHooksLoaded];
    // ...
  }
}
```

#### 2. proxy-server.ts

```typescript
for (let i = 0; i < candidateAttempts.length; i++) {
  // ✅ 每个请求加载自己的 hooks，保存在局部变量中
  let forwardHooksLoaded: LoadedHook[] = [];
  if (hooksExecutor && (instanceHooks || hookRule.hooks)) {
    try {
      forwardHooksLoaded = await hooksExecutor.loadForwardHooks(hookRule.hooks ?? null);
    } catch (err) {
      console.error("[Hooks] Failed to load forward hooks:", err);
    }
  }

  // ✅ 传递局部的 forwardHooksLoaded
  if (hooksExecutor?.hasRequestHooks) {
    const hookResult = await hooksExecutor.executeRequestHooksWithLayers(
      params,
      bodyToDataUrl,
      forwardHooksLoaded,  // ✅ 传递局部变量
    );
  }
}
```

## 验证

### 测试用例

创建了 `tests/model-rewrite-concurrency.test.ts` 来验证修复：

```typescript
test("每个请求应独立加载 forward hooks，避免并发竞态", async () => {
  const executor = new HooksExecutor("test-instance", null);
  await executor.start();

  const hooks1 = { /* model-rewrite 配置 */ };
  const hooks2 = null;

  // 并发加载
  const [loaded1, loaded2] = await Promise.all([
    executor.loadForwardHooks(hooks1),
    executor.loadForwardHooks(hooks2),
  ]);

  // ✅ 结果独立，互不干扰
  expect(loaded1.length).toBe(1);
  expect(loaded2.length).toBe(0);
});
```

### 测试结果

```bash
✓ 每个请求应独立加载 forward hooks，避免并发竞态
✓ setForwardHooks 应该被废弃并且不影响状态
✓ hasRequestHooks 应该只检查 instance hooks

3 pass, 0 fail
```

## 影响范围

### 受影响的场景

1. **所有使用 forward-level hooks 的场景**
   - model-rewrite
   - openai4droid
   - anthropic4droid
   - gemini4droid
   - 其他任何在 forward 规则中配置的插件

2. **高并发场景**
   - 多个请求同时到达
   - 不同的请求使用不同的 forward 规则
   - 不同的 forward 规则配置了不同的插件

### 破坏性变更

**无破坏性变更！**

- `setForwardHooks` 方法被标记为 `@deprecated`，但保留了向后兼容的空实现
- 新增的 `loadForwardHooks` 方法是内部使用，不影响外部 API
- 所有公开接口保持不变

## 性能影响

### 之前

- 每个请求调用 `setForwardHooks`，修改共享状态
- 插件只加载一次（但会被覆盖）

### 之后

- 每个请求调用 `loadForwardHooks`，返回独立的插件列表
- 每个请求独立加载插件实例

**性能影响：** 几乎没有

- 插件加载是通过动态 `import()` 实现的，模块系统会缓存
- 只是创建了新的插件实例，开销很小
- 换来了正确性和并发安全

## 总结

这个修复解决了一个关键的并发安全问题，确保了：

1. ✅ 每个请求使用正确的插件配置
2. ✅ 请求之间互不干扰
3. ✅ 没有破坏性变更
4. ✅ 性能影响微乎其微
5. ✅ 代码更清晰、更易维护

**关键教训：** 在高并发环境中，避免使用可变的共享状态。应该让每个请求拥有自己的上下文。
