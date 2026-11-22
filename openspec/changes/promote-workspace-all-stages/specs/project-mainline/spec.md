## ADDED Requirements

### Requirement: Full lifecycle agents use scoped Mastra Workspaces

Mastra SHALL provide each product, development, testing, browser QA, and delivery stage with a Workspace bound to that Run's authorized input and current source version. A Workspace SHALL expose only the files required by its stage and SHALL be destroyed or detached when the bound step completes.

#### Scenario: Product agents read authorized project materials

- **WHEN** product manager or product reviewer analyzes or writes a product artifact
- **THEN** the Agent SHALL read authorized source materials and fixed-version product specifications through its Run-scoped read-only Workspace
- **AND** actual Workspace file-read receipts SHALL be attached to the product work evidence
- **AND** the Agent SHALL NOT receive Workspace write or arbitrary command execution tools

#### Scenario: Guided clarification records each assessment's source

- **WHEN** a configured product Run assesses a clarification round
- **THEN** its Agent SHALL read the Run's brief from a read-only Workspace before publishing the plan
- **AND** the saved plan and its version hash SHALL bind the actual read receipt and brief content hash
- **AND** prior snapshots without receipts SHALL retain their original hash and remain readable
- **AND** fixture plans SHALL remain explicitly identified as fixture behavior

#### Scenario: Product clarification and revision consume authorized materials

- **WHEN** a Run generates development blocker questions or revises an approved product
- **THEN** its Agent SHALL read the approved product through a read-only Workspace before publishing its result
- **AND** authorized materials SHALL include frozen product sources, fixed-version project specifications, predecessor specifications and verified Git handoff files applicable to the stage
- **AND** successful reads and complete source hashes SHALL be persisted with the question version or revised draft
- **AND** new Runs SHALL freeze legacy product source files in their initial Store snapshot so that later edits cannot change their authorized inputs

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

#### Scenario: Historical Sandbox policy is missing or differs during model rebase

- **WHEN** a suspended development Run lacks a Sandbox policy identity or its policy differs from the current policy
- **THEN** recovery and read-only model rebase SHALL reject the identity drift without changing the saved checkpoint
- **AND** the system SHALL NOT infer the historical policy or silently migrate the Run; any migration requires a separately specified and verified procedure

#### Scenario: Explicitly migrate a historical Run through a controlled restart

- **WHEN** an operator requests migration of a stable historical Run with a missing or outdated Sandbox policy
- **THEN** the server SHALL prepare a versioned migration plan from its Store checkpoint, approved product, project binding and verified existing candidate
- **AND** confirmation SHALL bind that plan hash and a fresh Run ID
- **AND** the new Run SHALL save migration lineage, frozen approved source material and inherited consumed development budgets, and SHALL repeat product and architecture approvals under the current policy
- **AND** the historical Run and candidate SHALL retain their original saved state
- **AND** source drift, candidate drift, incompatible project binding, duplicate target ownership or stale confirmation SHALL reject migration before starting execution

#### Scenario: Workspace is unavailable

- **WHEN** a stage requires Workspace materials but the authorized filesystem or required Sandbox cannot be initialized
- **THEN** the stage SHALL fail closed with a safe diagnostic and SHALL NOT silently fall back to direct untracked Agent filesystem access
