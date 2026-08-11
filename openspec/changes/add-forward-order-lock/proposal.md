# Change: Add locked slots for automatic forward ordering

## Why

Automatic ordering can move every forward in a same-name failover group. Operators need to keep a selected forward at a fixed group position while still allowing the remaining forwards to rotate around it.

## What Changes

- Add a persisted `orderLocked` flag to forward rules.
- Add a lock control to each forward in the viewer.
- Apply health-based ordering first, then preserve locked group slots and stably fill the remaining slots.
- Keep locked forwards active for request routing and health measurement.

## Impact

- Affected specs: forward-ordering
- Affected code: forward stats evaluation, proxy configuration schema/types, viewer forward controls, automatic reorder orchestration
