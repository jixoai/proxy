# Change: Migrate proxy workers to Bun-native IPC

## Why
- Node `worker_threads` BroadcastChannel cannot communicate across Bun workers, blocking multi-worker telemetry and config sync.
- Ad-hoc message shapes and switch-cases have no runtime validation, risking silent failures during reload/health-check.
- BroadcastChannel names are scattered magic strings, making it easy to drift between producers and listeners.

## What Changes
- Introduce a lightweight IPC layer (zod schemas + helpers) for worker messages and BroadcastChannel payloads.
- Replace Node `worker_threads` usage with Bun `Worker` API and a typed spawn/handshake flow.
- Centralize BroadcastChannel names and message contracts for DB notifications and forward stats.
- Update proxy manager/server and stats/db notifiers to use the new abstractions and validation.

## Impact
- Affected specs: `proxy-runtime` (new capability)
- Affected code: `src/lib/proxy-manager.ts`, `src/proxy-server.ts`, `src/lib/db-notifier.ts`, `src/lib/forward-stats-manager.ts`, new `src/lib/ipc/*`.
