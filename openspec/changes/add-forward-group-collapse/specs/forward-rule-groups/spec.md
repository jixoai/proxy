## ADDED Requirements

### Requirement: Collapsible Forward Rule Groups
The viewer SHALL allow each forward rule group to be expanded or collapsed independently. Groups SHALL be expanded by default. Collapsed groups SHALL retain their name, rule count, and group drag handle without displaying their rules.

#### Scenario: Collapse and expand a group
- **WHEN** the user activates a group's disclosure button
- **THEN** only that group's rules are hidden or revealed
- **AND** the control exposes its expanded state and can be activated by keyboard
- **AND** no proxy configuration or runtime rule behavior changes

#### Scenario: Reorder a collapsed group
- **WHEN** the user drags a collapsed group using its group drag handle
- **THEN** group reordering continues to work without unintentionally toggling expansion
- **AND** the group's existing rule order is preserved

### Requirement: Bulk Expansion Controls
The viewer SHALL provide actions to expand all and collapse all forward rule groups in the current instance.

#### Scenario: Collapse all groups
- **WHEN** the user activates collapse all
- **THEN** every group in the current instance is collapsed
- **AND** the user can still expand an individual group or expand all groups

### Requirement: Instance-Scoped Presentation Preferences
The viewer SHALL remember collapsed groups in browser-local storage, keyed by instance name and group name. These preferences SHALL NOT be stored in proxy configuration.

#### Scenario: Restore preferences
- **WHEN** the user reloads the viewer or returns to an instance
- **THEN** that instance's saved collapsed groups are restored independently of other instances
- **AND** newly encountered groups are expanded by default

#### Scenario: Browser storage is unavailable or invalid
- **WHEN** stored preferences cannot be read, parsed, or written
- **THEN** the viewer remains usable and group expansion can still be changed for the current session

### Requirement: Reveal Focused Rules
The viewer SHALL reveal a rule requested by the existing rule-focus navigation even if its group is collapsed.

#### Scenario: Navigate to a rule in a collapsed group
- **WHEN** another viewer interaction requests focus on a rule in a collapsed group
- **THEN** the viewer expands that group before scrolling to and highlighting the target rule
- **AND** unrelated groups retain their expansion state
