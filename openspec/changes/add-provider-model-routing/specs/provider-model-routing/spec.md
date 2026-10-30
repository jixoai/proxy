## ADDED Requirements

### Requirement: Optional Provider Model Capabilities
Each forward provider SHALL allow an optional supported-model list. Omitted, null, or empty lists SHALL support all models requested in the matched group. Explicit lists SHALL match exact provider target names after provider-specific mapping.

#### Scenario: No model configuration
- **WHEN** an enabled provider has no supported-model list or mapping
- **THEN** any requested model is eligible for that provider
- **AND** the router does not add a model rewrite

#### Scenario: Two supported models
- **WHEN** a provider lists `glm-5.3` and `glm-5.3-flash`
- **THEN** requests resolving to either target model can use that provider
- **AND** requests resolving to an unlisted model skip that provider

### Requirement: Independent Optional Model Mapping
Each provider SHALL allow multiple exact client-to-target model mappings independently of its supported-model list. Missing mappings and unmatched names SHALL NOT add a rewrite or implicitly restrict other models.

#### Scenario: Mapping without a whitelist
- **WHEN** a provider maps `local-fast` to `glm-5.3-flash` but has no supported-model list
- **THEN** `local-fast` is rewritten to `glm-5.3-flash`
- **AND** other models remain eligible and retain their names unless existing hooks explicitly rewrite them

#### Scenario: Different mappings during fallback
- **WHEN** two compatible providers map the same original model to different target names and the first attempt fails
- **THEN** each attempt derives its mapping from the original client request independently
- **AND** the second provider never receives a name left over from the first provider's rewrite

### Requirement: Optional API Compatibility Filtering
Providers SHALL allow optional client-facing API capability declarations for Responses, Anthropic Messages, and Chat Completions, including optional restrictions per target model. Empty or omitted declarations SHALL impose no additional restriction. Effective support SHALL satisfy both provider and per-model restrictions when present.

#### Scenario: Skip an incompatible API
- **WHEN** a Responses request targets a group with a Messages-only provider followed by a Responses-capable provider
- **THEN** the request skips the Messages-only provider without sending an upstream request to it
- **AND** the compatible enabled provider is selected without manually disabling the other provider

#### Scenario: Protocol conversion is configured
- **WHEN** a provider's existing hooks accept Responses requests and convert them to an upstream protocol
- **THEN** its configured client-facing Responses capability can make it eligible
- **AND** declaring a capability alone does not create protocol conversion

#### Scenario: Per-model restrictions
- **WHEN** a provider permits both Responses and Messages but its target flash model permits only Messages
- **THEN** Responses requests for that target model skip this provider
- **AND** Messages requests for that target model remain eligible

### Requirement: Ordered Compatible Attempts And Diagnostic Errors
The proxy SHALL preserve compatible providers' configured order and existing retry, streaming, timeout, and cancellation behavior. No compatible provider SHALL produce a structured error rather than an incompatible upstream attempt or unrelated group fallback.

#### Scenario: No compatible provider
- **WHEN** all enabled providers in the matched group are excluded by model or API capability
- **THEN** the proxy returns HTTP 422 with error code `no_compatible_provider` and safe diagnostic context
- **AND** no upstream request is sent and no unrelated group is selected

#### Scenario: Missing model with explicit restrictions
- **WHEN** a model request cannot provide a valid string model and every available provider requires an explicit supported model
- **THEN** the proxy returns HTTP 400 with a diagnostic error
- **AND** an unparseable request does not bypass model restrictions

#### Scenario: Existing generic traffic
- **WHEN** a generic non-model request such as a model-list GET is forwarded
- **THEN** it is not rejected merely because a provider has a supported-model list
- **AND** its body is not rewritten

### Requirement: Configuration Propagation And Optional Viewer Controls
Capability and mapping fields SHALL survive JSON save/load, worker initialization, reload, and configuration inspection. Viewer controls SHALL make all capability and mapping configuration optional and explain unrestricted and passthrough defaults.

#### Scenario: Save and hot reload
- **WHEN** a provider's mappings or capabilities are edited and saved
- **THEN** the next runtime reload receives all configured fields without truncation
- **AND** subsequent requests use the new configuration without restarting unrelated instances

#### Scenario: Clear optional configuration
- **WHEN** the user clears the supported-model list, API declarations, and mappings
- **THEN** the provider returns to unrestricted model/API eligibility and no additional model rewrite
- **AND** the viewer clearly describes this default rather than requiring a placeholder model

### Requirement: Explicit WebSocket Scope
The initial feature SHALL implement HTTP model routing and SHALL NOT silently bypass explicit model, API, or mapping configuration for WebSocket upgrades.

#### Scenario: WebSocket with new restrictions
- **WHEN** a WebSocket request matches a group containing explicit nonempty new model/API restrictions or mappings
- **THEN** the upgrade is rejected with a clear unsupported-routing explanation
- **AND** it is not forwarded as if the HTTP routing feature applied to its later frames

#### Scenario: Existing unrestricted WebSocket
- **WHEN** no new model/API restrictions or mappings are configured for the matched group
- **THEN** existing WebSocket passthrough behavior remains unchanged
