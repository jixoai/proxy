## Context
The proxy runtime currently relies on Node `worker_threads` for running per-instance proxy servers. Bun's runtime ships with its own `Worker` and `BroadcastChannel` implementations; Bun does not support cross-worker `BroadcastChannel` for Node's worker threads, so stats and DB notifications cannot flow between instances. Message handling is ad-hoc (untyped switch-cases) with no runtime validation, making reload/health-check brittle.

## Goals / Non-Goals
- Goals: use Bun-native workers; add a minimal IPC layer that enforces typed messages and centralized channel names; support broadcast-based telemetry across workers; keep abstractions small and composable.
- Non-Goals: build a full RPC framework; change proxy business logic; introduce persistence migrations.

## Decisions
- Adopt Bun `Worker` for proxy instances and wrap spawn/handshake in `spawnWorker(file, initPayload)` to guarantee `ready`/`started`/`error` responses before marking an instance running.
- Define message contracts (worker requests/responses and broadcast payloads) in `src/lib/ipc/types.ts` using zod; expose type guards to enforce runtime validation at boundaries.
- Centralize channel names in `src/lib/ipc/broadcast-channels.ts` to eliminate magic strings and align producers/consumers.
- Provide `createMessageRouter` and `setupWorkerHandler` helpers that validate payloads, route by `type`, and throw/log on unknown messages (default-case protection) to remove per-worker switch duplication.

## Alternatives considered
- Keep Node `worker_threads` and polyfill BroadcastChannel: rejected because cross-worker support remains incomplete and adds complexity.
- Introduce a heavier RPC layer (e.g., Comlink-like): rejected per YAGNI; simple message routing suffices.

## Risks / Trade-offs
- Bun Worker API differences could surface at runtime; mitigated by zod validation and explicit handshake timeouts.
- Validation overhead on hot paths; mitigated by constraining schemas to small payloads and reusing parsers.

## Migration Plan
1) Land IPC scaffolding (`types.ts`, `broadcast-channels.ts`, `worker-bus.ts`).
2) Refactor proxy manager/server to Bun Worker + typed router and remove Node imports.
3) Update db notifier and forward stats to shared channel constants and schemas.
4) Add minimal routing tests and run `bun ts`; smoke-test reload/startup with multiple instances to confirm broadcast flow.

## Open Questions
- Do we need graceful shutdown messaging beyond `stop`? (default to hard terminate for now).
- Should worker logs surface through the same typed channel or remain direct `postMessage`? (keep direct for now; revisit after validation).
