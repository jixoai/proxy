## ADDED Requirements
### Requirement: Bun worker lifecycle handshake
Proxy instances SHALL run in Bun `Worker`s created through a helper that sends an `init` message (port, instanceName, config) and waits for a typed `ready`/`started` or `error` response before marking the instance running.

#### Scenario: Worker starts successfully
- **WHEN** proxy-manager spawns a worker with the init payload
- **THEN** the worker responds with `ready` (or `started` including the listening port) within a bounded timeout
- **AND** the manager records the instance as running only after the response arrives

#### Scenario: Worker fails to bind port
- **WHEN** the worker cannot start (e.g., port in use)
- **THEN** it returns a typed `error` response and terminates
- **AND** the manager tears down the worker and surfaces the error without leaking the thread

### Requirement: Typed worker IPC validation
All worker request/response messages SHALL be defined in zod schemas in `src/lib/ipc/types.ts`. Incoming messages MUST be validated before routing; unknown or invalid message types MUST trigger an error path rather than falling through silently.

#### Scenario: Valid message routed
- **WHEN** a `reload-config` or `get-config` message matches the schema
- **THEN** the router invokes the associated handler with typed data and returns a typed response

#### Scenario: Invalid or unknown message rejected
- **WHEN** a message fails schema validation or has an unrecognized `type`
- **THEN** the router logs/returns a typed `error` response and the default handler throws to prevent silent drops

### Requirement: Shared broadcast channel contracts
BroadcastChannel names SHALL be centralized in `src/lib/ipc/broadcast-channels.ts`, and channel payloads (DB change, forward stats) SHALL be validated against shared zod schemas before being emitted to application code.

#### Scenario: Database change notification delivered
- **WHEN** the proxy worker publishes a DB change event using `DB_NOTIFIER_CHANNEL`
- **THEN** the viewer-side listener receives it after schema validation and emits the typed change event

#### Scenario: Forward stats broadcast
- **WHEN** a worker reports forward stats on `STATS_CHANNEL`
- **THEN** the stats manager ingests the message after validation and updates in-memory stats for the matching instance/forward

### Requirement: Worker bus utilities
The IPC layer SHALL provide helpers (`spawnWorker`, `createMessageRouter`, `setupWorkerHandler`) that encapsulate Bun Worker creation, handshake, request/response posting, and default-case error handling to remove manual switch/case duplication across workers.

#### Scenario: Worker-side handler setup
- **WHEN** a proxy worker registers handlers via `setupWorkerHandler`
- **THEN** it automatically validates incoming messages, routes them to registered handlers, and throws on unhandled message types

#### Scenario: Manager sends typed request
- **WHEN** proxy-manager uses the bus wrapper to send `reload-config` or `stop`
- **THEN** the helper performs validation, awaits the typed response, and surfaces timeouts/errors with structured errors
