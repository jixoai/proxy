## ADDED Requirements

### Requirement: Plugin-Scoped UI Headers
The system SHALL parse plugin-scoped UI headers from private headers using the `-x-jixo-proxy-<plugin-name>` namespace.

#### Scenario: Static JSON payload
- **WHEN** a request includes `-x-jixo-proxy-<plugin-name>` with a valid JSON object
- **THEN** the request metadata includes the parsed payload for that plugin

#### Scenario: Dynamic stream payload
- **WHEN** a request includes `-x-jixo-proxy-<plugin-name>-stream` with a valid URL
- **THEN** the request metadata includes the stream URL for that plugin

#### Scenario: Invalid payload
- **WHEN** a request includes malformed JSON in `-x-jixo-proxy-<plugin-name>`
- **THEN** the system ignores the invalid header and does not fail the request

### Requirement: Tray Preview
The viewer SHALL display up to 3 tray icons per request with hover descriptions.

#### Scenario: Emoji icon
- **WHEN** a tray icon contains an emoji
- **THEN** the UI renders the emoji

### Requirement: Plugin Remarks Tooltip
The viewer SHALL show a tooltip listing each plugin's tray and remark in markdown format.

#### Scenario: Multiple plugins
- **WHEN** a request includes multiple plugin payloads
- **THEN** the tooltip shows each plugin section in order, including tray items and remark

### Requirement: Static + Dynamic Merge
The viewer SHALL render static payloads first and replace or update them if dynamic stream data arrives.

#### Scenario: Dynamic update arrives
- **WHEN** the viewer receives SSE event-data containing a payload for the same plugin
- **THEN** the displayed tray/remark updates to the new payload

### Requirement: Response Overrides Request
If a plugin writes UI headers in both request and response, the response payload SHALL take precedence.

#### Scenario: Response overrides request
- **WHEN** request headers contain plugin UI payload
- **AND** response headers contain a payload for the same plugin
- **THEN** the response payload is used for display
