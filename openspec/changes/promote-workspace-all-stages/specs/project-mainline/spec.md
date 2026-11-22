## ADDED Requirements

### Requirement: Full lifecycle agents use scoped Mastra Workspaces

Mastra SHALL provide each product, development, testing, browser QA, and delivery stage with a Workspace bound to that Run's authorized input and current source version. A Workspace SHALL expose only the files required by its stage and SHALL be destroyed or detached when the bound step completes.

#### Scenario: Product agents read authorized project materials

- **WHEN** product manager or product reviewer analyzes or writes a product artifact
- **THEN** the Agent SHALL read authorized source materials and fixed-version product specifications through its Run-scoped read-only Workspace
- **AND** actual Workspace file-read receipts SHALL be attached to the product work evidence
- **AND** the Agent SHALL NOT receive Workspace write or arbitrary command execution tools

#### Scenario: Testing agent reads the exact development candidate

- **WHEN** the testing Agent prepares an independent test plan or browser QA executes approved cases
- **THEN** its Workspace SHALL be bound to the exact development checkpoint and approved case assets
- **AND** actual reads SHALL be recorded and results SHALL remain bound to source, case, method, and project identities
- **AND** fixed checks SHALL run only through registered Adapter commands in an isolated execution environment; supported Node/Python profiles use Workspace Sandbox, while HRM/CIP retain their registered Docker verifier

#### Scenario: Delivery verifies without acquiring write authority

- **WHEN** the delivery stage validates a QA-approved candidate and its formal specifications
- **THEN** it SHALL consume a read-only Workspace bound to the candidate and QA report versions
- **AND** repository mutation and merge-request operations SHALL remain host-owned registered operations
- **AND** no model-visible arbitrary repository write or command tool SHALL be created

#### Scenario: Workspace stage identity or source drifts

- **WHEN** a stage resumes with a different Run/project binding, source checkpoint, approved case set, or Workspace policy version
- **THEN** the system SHALL reject the old Workspace and its evidence and require a newly verified stage Workspace
- **AND** Mastra Store SHALL remain authoritative for approvals, Workflow checkpoints, and recovery facts

#### Scenario: Workspace is unavailable

- **WHEN** a stage requires Workspace materials but the authorized filesystem or required Sandbox cannot be initialized
- **THEN** the stage SHALL fail closed with a safe diagnostic and SHALL NOT silently fall back to direct untracked Agent filesystem access
