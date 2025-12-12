## 1. IPC infrastructure
- [ ] 1.1 Define worker and channel message schemas with zod in `src/lib/ipc/types.ts` (requests/responses + validation helpers).
- [ ] 1.2 Centralize BroadcastChannel names in `src/lib/ipc/broadcast-channels.ts` and export typed payload helpers.
- [ ] 1.3 Implement `src/lib/ipc/worker-bus.ts` with Bun Worker spawn/handshake, message router, and worker-side setup utilities (default-case error handling).

## 2. Migration to Bun Worker
- [ ] 2.1 Refactor `src/lib/proxy-manager.ts` to use `spawnWorker` and typed message posting/awaiting; remove `node:worker_threads`.
- [ ] 2.2 Refactor `src/proxy-server.ts` to use `setupWorkerHandler`, Bun Worker postMessage/onmessage, and init handshake.
- [ ] 2.3 Update `src/lib/db-notifier.ts` to consume shared channel constants and typed channel messages (Bun `BroadcastChannel`).
- [ ] 2.4 Update `src/lib/forward-stats-manager.ts` to use shared channel constants and typed channel messages.

## 3. Verification
- [ ] 3.1 Add/adjust unit coverage for message routing/validation (at least worker handler happy/invalid cases).
- [ ] 3.2 Run `bun ts` to ensure type safety across worker boundaries.
- [ ] 3.3 Smoke-test startup/reload paths to confirm BroadcastChannel messages flow across workers.
