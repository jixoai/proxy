# Hooks Implementation & Architecture Audit

**Date**: 2025-12-12
**Project**: jixoai-labs/proxy
**Tags**: hooks, architecture, Worker, hooksPool

---

## 1. Current Hooks Implementation Status

### Protocol Version: HTTP (not stdio)

The hooks system uses **HTTP-based protocol** exclusively:
- **Type**: `HttpHookConfig` (defined in `src/types/proxy.ts:6-10`)
- **Hook execution**: Spawns external process via `bun spawn()` with HTTP server
- **Callback mechanism**: Subprocess establishes callback HTTP server (port 0, bind 127.0.0.1)
- **Communication**: Binary envelope protocol (4-byte length header + JSON metadata + binary body)

### Key Files
- **Main Implementation**: `/src/lib/hooks-executor.ts` (494 lines)
- **Types Definition**: `/src/types/proxy.ts:5-19`
- **Integration Tests**: `/tests/test-hooks-integration.ts`

---

## 2. HooksPool Implementation

### Architecture Pattern: Reference-Counted Pool

**Location**: `/src/lib/hooks-executor.ts:309-341`

The `HooksPool` class implements a **reference-counted object pool**:

```typescript
class HooksPool {
  private pool = new Map<string, HookProcess>();

  async acquire(config: HookConfig): Promise<HookProcess>
  async release(hook: HookProcess): Promise<void>
  async stopAll(): Promise<void>
  get size(): number
}
```

### Pool Mechanics

1. **Deduplication by Hash**:
   - Config is normalized and hashed (SHA256, first 16 chars)
   - Same config → reuses same process instance
   - Hash function: `computeConfigHash()` (lines 75-82)

2. **Reference Counting**:
   - `addRef()`: Increment ref counter when acquired
   - `release()`: Decrement; returns true if refCount <= 0
   - Auto-cleanup: Process killed when all references released

3. **Global Instance**:
   - Single global `globalHooksPool` instance (line 343)
   - Managed by `HooksExecutor` per instance

### HookProcess Lifecycle

Each `HookProcess` (lines 84-307) manages:

1. **Startup Phase**:
   - Creates ephemeral HTTP callback server (ephemeral port)
   - Spawns subprocess with `__CALLBACK_URL__` env var
   - Subprocess must POST its listen URL back to callback
   - Timeout: 15 seconds (CALLBACK_TIMEOUT_MS)

2. **Communication**:
   - Binary envelope protocol for request/response
   - Two endpoints: `hook-req-requestBody`, `hook-res-requestBody`
   - Fetch-based HTTP calls to subprocess

3. **Cleanup**:
   - Process killed via `.kill()`
   - Callback server closed
   - Vars reset to null

---

## 3. HooksExecutor Pattern

**Location**: `/src/lib/hooks-executor.ts:345-485`

### Instance-Level Hook Management

Each proxy instance has its own `HooksExecutor`:

```typescript
class HooksExecutor {
  private instanceRequestHooks: HookProcess[] = [];
  private instanceResponseHooks: HookProcess[] = [];
  private forwardRequestHooks: HookProcess[] = [];
  private forwardResponseHooks: HookProcess[] = [];
}
```

### Hook Phases

1. **Instance Hooks** (static):
   - Acquired during `.start()`
   - One per forward rule (if configured)
   - Released during `.stop()`

2. **Forward Hooks** (dynamic):
   - Set via `.setForwardHooks()` method
   - Can be updated without restarting instance
   - Applied after instance hooks in execution chain

### Execution Order

**Request Phase** (lines 446-460):
1. Instance request hooks (in order)
2. Forward request hooks (in order)
3. Patches applied sequentially

**Response Phase** (lines 462-476):
1. Forward response hooks (in order) — **reversed!**
2. Instance response hooks (in order)

---

## 4. Worker Architecture in proxy-server

### Worker Pattern

**Location**: `/src/lib/proxy-manager.ts` (creates Worker)
**Worker Implementation**: `/src/proxy-server.ts` (Worker thread code)

### Parent-Worker Communication

```typescript
// Parent (proxy-manager.ts:90)
this.worker = new Worker(proxyServerPath, {
  workerData: { /* config */ }
});

// Worker (proxy-server.ts:8, 44, 160)
import { parentPort } from "node:worker_threads";
if (parentPort) {
  // Receive WorkerMessage
  parentPort.on("message", async (message: WorkerMessage) => {
    // Process and send WorkerResponse
    parentPort?.postMessage(response);
  });
}
```

### Message Types

**Defined in**: `/src/types/worker-messages.ts`

- `ping` → `pong`: Heartbeat check
- `reload`: Update forward rules config
- `get-config`: Query current runtime config
- `log`: Async log transmission (from worker to parent)

### Key Design Points

1. **Single Worker Per Instance**:
   - Each proxy instance runs in dedicated Worker thread
   - Parallel instance isolation guaranteed by OS

2. **Lazy Port Binding**:
   - Worker reports port ready via WorkerResponse
   - Parent waits for `ready` message before returning from `start()`

3. **Hook Process Integration**:
   - Hooks spawned as **child processes of Worker thread**
   - Each Worker has its own HooksExecutor instance (line 76 in proxy-server.ts)
   - Hooks share same globalHooksPool across all Workers (singleton)

---

## 5. Hook Process Spawning Details

### Subprocess Environment

**Location**: `/src/lib/hooks-executor.ts:177-182`

```typescript
this.process = spawn(args, {
  cwd: this.config.cwd,
  stdin: "ignore",
  stdout: "inherit",    // Direct to parent console
  stderr: "inherit",
  env: { ...process.env, __CALLBACK_URL__: callback.url },
});
```

### Hook Discovery Protocol

1. Parent creates ephemeral callback server → gets URL
2. Parent spawns subprocess, passes `__CALLBACK_URL__` env var
3. Subprocess must POST plain text (its listen URL) to callback
4. Parent receives URL → stores in `listenUrl`
5. Parent closes callback server → begins hook calls

**Timeout**: 15 seconds to receive callback

---

## 6. Binary Communication Protocol

### Envelope Format

```
[4 bytes: BE uint32 metadata length]
[N bytes: UTF-8 JSON metadata]
[M bytes: binary body]
```

### Request Metadata

```json
{
  "method": "POST",
  "url": "https://...",
  "headers": { "content-type": "..." },
  "bodyLength": 1024
}
```

### Response Metadata

```json
{
  "statusCode": 200,
  "statusMessage": "OK",
  "headers": { "content-type": "..." },
  "bodyLength": 2048
}
```

### Header Normalization

`normalizeHeaders()` (lines 62-73):
- Accepts `Record<string, string | string[]>`
- Filters out invalid entries
- Returns undefined if no valid headers

---

## 7. Configuration & Types

### Hook Config Types

**In `src/types/proxy.ts`**:

```typescript
interface HttpHookConfig {
  type: "http";
  command: string;        // executable (e.g., "bun")
  args?: string[];        // command args
  cwd?: string;          // working directory
}

interface HooksConfig {
  request?: HookConfig | HookConfig[] | null;
  response?: HookConfig | HookConfig[] | null;
}
```

### Hook Config at Forward Level

```typescript
interface ProxyForwardConfig {
  // ...other fields...
  hooks?: HooksConfig | null;
}
```

---

## 8. Known Limitations & Design Notes

### Current Limitations

1. **No stdio version**: Only HTTP-based hooks supported
2. **No hook timeout per-call**: Uses 15-second callback startup, but no per-hook-call timeout
3. **Process reuse**: Process pool is global; can't have instance-specific hook versions
4. **No hook chains across forwards**: Hooks are per-forward, not chained across multiple forwards

### Design Principles

1. **Zero-loss message handling**: Binary envelope ensures no truncation
2. **Subprocess stdout/stderr**: Inherited (flows to parent output)
3. **Graceful degradation**: Hook failure → request continues with original params
4. **Reference counting**: Prevents orphaned subprocesses

---

## 9. Testing Infrastructure

### Test Files

- `/tests/test-hooks-integration.ts`: Full HooksExecutor → HTTP subprocess roundtrip
- `/tests/test-hook-http.ts`: Example HTTP hook subprocess (listener)
- `/tests/test-droid-plugin.ts`: Plugin-level hook tests

### Running Tests

```bash
bun tests/test-hooks-integration.ts
```

---

## 10. Recent Related Commits

- `6eb5f3d`: "🐛 修复plugins/droid-to-claude-rewrite可能引发400（cache_control使用超过4个）的问题"
- `0aa622c`: "🔌 新增插件： droid-to-claude-rewrite"

---

## Key Takeaways

| Aspect | Current State |
|--------|--------------|
| **Protocol** | HTTP (spawn subprocess with callback discovery) |
| **Pool Strategy** | Reference-counted, config-hash-based deduplication |
| **Worker Architecture** | Each instance = 1 Worker thread; hooks as child procs |
| **Hook Lifecycle** | Per-instance static + per-forward dynamic |
| **Message Format** | Binary envelope (4-byte length + JSON + body) |
| **Backward Compat** | No breaking changes concern (tool project) |

