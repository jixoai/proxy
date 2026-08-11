## ADDED Requirements

### Requirement: Locked forward slots

The system SHALL support an `orderLocked` flag on a forward rule. When automatic ordering evaluates a same-name group, a locked forward SHALL remain at its current group position while unlocked forwards are ordered by the normal health ranking and fill the remaining positions stably.

#### Scenario: A locked middle slot absorbs a rotation

- **WHEN** a three-forward group is ordered as `[A, B, C]`, `B` is locked, and health ranking produces `[C, A, B]`
- **THEN** the resulting group order SHALL be `[C, B, A]`
- **AND** `B` SHALL remain at index `1`

#### Scenario: Locked forwards still route and collect health samples

- **WHEN** a locked forward receives a request
- **THEN** the proxy SHALL still consider it as a normal routing candidate
- **AND** the request result SHALL still contribute to its health samples

#### Scenario: No lock preserves existing ordering behavior

- **WHEN** no forward in a group is locked
- **THEN** automatic ordering SHALL produce the same result as the existing health-based ordering

#### Scenario: Lock state persists through configuration reload

- **WHEN** a forward's `orderLocked` value is changed and configuration is saved or reloaded
- **THEN** the value SHALL remain associated with that forward by its stable `id`
