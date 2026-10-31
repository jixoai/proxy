## MODIFIED Requirements

### Requirement: Optional Provider Model Capabilities

The proxy SHALL store model support, optional aliases, and API capabilities in unified per-model entries under `modelRouting`. Missing configuration SHALL accept all models without adding model rewrites or API restrictions. An explicit `all` mode SHALL preserve passthrough for unlisted models, while `listed` mode SHALL admit only listed names or aliases and SHALL require at least one entry.

#### Scenario: Mapping without mandatory whitelist

- **WHEN** the user adds a model with a client alias in the default all mode
- **THEN** the alias resolves to that target model
- **AND** unlisted models remain eligible with original names and unrestricted API

#### Scenario: Restrict to listed models

- **WHEN** the user explicitly selects listed mode
- **THEN** only configured target names and aliases are eligible
- **AND** deleting the final entry cannot silently restore unrestricted routing

### Requirement: Independent Optional Model Mapping

Each model entry SHALL allow optional client aliases resolving to its upstream name. API declarations SHALL apply identically to target-name and alias requests. Alias mapping SHALL be computed independently for each provider from the original client request, and ambiguous names or aliases SHALL be rejected.

#### Scenario: Target model and alias share capabilities

- **WHEN** a Messages-only model is requested by its upstream name or an alias
- **THEN** a Responses request skips this provider in either case
- **AND** a Messages request can use it with the target name

#### Scenario: Ambiguous alias

- **WHEN** an alias points to two models or conflicts with another model's target name
- **THEN** saving fails with a field-level validation error
- **AND** the saved configuration remains unchanged

#### Scenario: Original client name across distinct upstream names

- **WHEN** two providers map the same client model name to different upstream model names
- **THEN** each provider resolves and checks eligibility from the original client name independently
- **AND** fallback does not use the preceding provider's rewritten name to select the next provider

### Requirement: Optional API Compatibility Filtering

API capability declarations SHALL exist only on model entries. Missing or empty declarations SHALL impose no restriction on that model. The proxy SHALL NOT provide a provider-level API declaration, inherit another model's declaration, or perform a provider/model intersection. Protocol declarations SHALL NOT create protocol conversion.

#### Scenario: Different APIs within one provider

- **WHEN** a provider declares Responses for its full model and Anthropic Messages for its flash model
- **THEN** each request is checked only against the requested target model's API declaration
- **AND** no provider API toggle must be changed

#### Scenario: Removed legacy configuration

- **WHEN** a configuration contains legacy provider-level API or the former parallel model fields
- **THEN** validation reports the unsupported configuration explicitly
- **AND** the proxy does not silently discard restrictions or modify the user's file

### Requirement: Configuration Propagation And Optional Viewer Controls

Unified model routing SHALL survive JSON save/load, worker initialization, reload, copying, and configuration inspection. Existing providers SHALL expose compact model configuration directly in the rule list, without requiring the full provider edit dialog. Changes SHALL use an explicit provider-scoped draft, save, and cancel flow.

#### Scenario: Edit from the provider card

- **WHEN** the user adds a model, edits its aliases, or changes its API selection
- **THEN** the controls are available inline within that provider card
- **AND** runtime configuration remains unchanged until an explicit successful save

#### Scenario: Save after reordering

- **WHEN** a rule is reordered before its model draft is saved
- **THEN** saving locates the rule by stable ID and updates only its model configuration
- **AND** other rules, headers, enabled state, URLs, and ordering remain unchanged

#### Scenario: Concurrent edit conflict

- **WHEN** the saved model configuration changes externally while a local draft is being edited
- **THEN** saving returns a conflict instead of overwriting external changes
- **AND** the draft remains available with a reload/retry recovery path

#### Scenario: Collapse during editing

- **WHEN** a provider's group is collapsed and expanded with an unsaved model draft
- **THEN** its draft is restored on expansion without being saved automatically
- **AND** no other provider receives that draft

#### Scenario: Long lists and narrow screens

- **WHEN** a provider contains more than three model entries or the viewport is narrow
- **THEN** the viewer offers compact expansion and a stacked labelled row layout
- **AND** active edits and validation errors remain visible without full-page horizontal scrolling

#### Scenario: Collapsed model summary by default

- **WHEN** a provider card is initially displayed without a draft
- **THEN** model details are collapsed, showing a compact model-name summary and all/listed scope
- **AND** API, alias and editing controls are shown only after explicitly expanding the details
- **AND** closing the details never saves or discards a draft, and keeps its unsaved status and save/cancel actions visible
- **AND** a failed save reopens details to expose model validation errors
