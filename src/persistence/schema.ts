import { EXPERIENCE_KINDS } from '../domain/kind.js'

/** ASCII “EXPM”, identifying only the canonical Experience Map database. */
export const EXPERIENCE_DB_APPLICATION_ID = 0x4558504d
/** Current canonical schema version. */
export const EXPERIENCE_DB_SCHEMA_VERSION = 8

/** SQL literal derived from the domain's sole six-kind vocabulary. */
export const EXPERIENCE_KIND_SQL = EXPERIENCE_KINDS.map(kind => `'${kind}'`).join(',')

/** Canonical tables with a real production owner in the implemented M1-M7 verticals. */
export const EXPERIENCE_DB_TABLES = [
  'admission_attempts',
  'admission_retry_bindings',
  'audit_events',
  'automation_capabilities',
  'candidate_field_decisions',
  'candidates',
  'command_deduplication',
  'commit_sequence',
  'component_revisions',
  'context_deliveries',
  'context_retirements',
  'context_snapshots',
  'criterion_results',
  'domain_receipts',
  'evidence_assessments',
  'evidence_statements',
  'evaluation_observations',
  'execution_correlations',
  'experience_components',
  'experience_relations',
  'experience_series',
  'experience_usages',
  'experience_version_components',
  'experience_versions',
  'forget_context_targets',
  'forget_requests',
  'forget_step_results',
  'forget_tombstones',
  'governance_decisions',
  'human_labels',
  'infrastructure_readiness_evaluations',
  'local_owner_principals',
  'markdown_projection_receipts',
  'match_sets',
  'observed_outcome_labels',
  'outbox_entries',
  'override_decisions',
  'outcome_reconciliations',
  'plan_approval_requests',
  'preference_validations',
  'preflight_records',
  'projection_checkpoints',
  'revision_changes',
  'revision_proposals',
  'shadow_predictions',
  'step_progress',
  'unlock_contracts',
  'unlock_contract_evaluations',
  'usage_plans',
  'usage_settlements',
  'verification_runs',
] as const

/** Canonical strict schema, installed atomically at bootstrap. */
export const EXPERIENCE_DB_SCHEMA_SQL = `
  CREATE TABLE local_owner_principals (
    principal_id   TEXT PRIMARY KEY,
    policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
    created_at     TEXT NOT NULL
  ) STRICT;

  CREATE TABLE commit_sequence (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    next_value INTEGER NOT NULL CHECK (next_value >= 1)
  ) STRICT;

  CREATE TABLE candidates (
    candidate_id TEXT PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind IN (${EXPERIENCE_KIND_SQL})),
    protocol_version TEXT NOT NULL,
    trigger_kind TEXT NOT NULL,
    eligibility_status TEXT NOT NULL CHECK (eligibility_status IN ('eligible','candidate_only','ineligible')),
    eligibility_digest TEXT NOT NULL,
    revision     INTEGER NOT NULL CHECK (revision >= 1),
    state        TEXT NOT NULL CHECK (state IN ('proposed','in_review','accepted','published','rejected','withdrawn')),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at   TEXT NOT NULL,
    published_version_id TEXT
  ) STRICT;

  CREATE TABLE candidate_field_decisions (
    decision_id  TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE RESTRICT,
    field_name   TEXT NOT NULL,
    decision     TEXT NOT NULL CHECK (decision IN ('accept','reject','edit')),
    value_json   TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
    actor_id     TEXT NOT NULL,
    reason       TEXT NOT NULL,
    decided_at   TEXT NOT NULL,
    effective_source_refs_json TEXT NOT NULL CHECK (json_valid(effective_source_refs_json)),
    supersedes_decision_id TEXT UNIQUE REFERENCES candidate_field_decisions(decision_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE experience_series (
    experience_id TEXT PRIMARY KEY,
    kind          TEXT NOT NULL CHECK (kind IN (${EXPERIENCE_KIND_SQL})),
    current_version_id TEXT NOT NULL REFERENCES experience_versions(experience_version_id)
      DEFERRABLE INITIALLY DEFERRED,
    series_revision INTEGER NOT NULL CHECK (series_revision >= 1),
    lifecycle_projection TEXT NOT NULL CHECK (lifecycle_projection IN ('active','retired')),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE experience_versions (
    experience_version_id TEXT PRIMARY KEY,
    experience_id TEXT NOT NULL REFERENCES experience_series(experience_id)
      DEFERRABLE INITIALLY DEFERRED,
    version_number INTEGER NOT NULL CHECK (version_number >= 1),
    previous_version_id TEXT REFERENCES experience_versions(experience_version_id),
    title TEXT NOT NULL,
    intent TEXT NOT NULL,
    scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
    privacy_class TEXT NOT NULL CHECK (privacy_class IN ('public','workspace','restricted','secret_reference_only')),
    allowed_use_modes_json TEXT NOT NULL CHECK (json_valid(allowed_use_modes_json)),
    evidence_grade TEXT NOT NULL CHECK (evidence_grade IN ('model_asserted','observation_supported','mechanism_supported','intervention_supported','counterfactual_supported')),
    initial_assessment_id TEXT NOT NULL REFERENCES evidence_assessments(assessment_id)
      DEFERRABLE INITIALLY DEFERRED,
    created_by_decision_id TEXT NOT NULL REFERENCES governance_decisions(decision_id)
      DEFERRABLE INITIALLY DEFERRED,
    content_digest TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    UNIQUE(experience_id, version_number),
    UNIQUE(experience_id, content_digest)
  ) STRICT;

  CREATE TABLE experience_components (
    component_id TEXT PRIMARY KEY,
    experience_id TEXT NOT NULL REFERENCES experience_series(experience_id),
    semantic_role TEXT NOT NULL,
    current_revision_id TEXT NOT NULL REFERENCES component_revisions(component_revision_id)
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT;

  CREATE TABLE component_revisions (
    component_revision_id TEXT PRIMARY KEY,
    component_id TEXT NOT NULL REFERENCES experience_components(component_id)
      DEFERRABLE INITIALLY DEFERRED,
    content_text TEXT NOT NULL,
    source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE evidence_statements (
    evidence_id TEXT PRIMARY KEY,
    component_revision_id TEXT NOT NULL REFERENCES component_revisions(component_revision_id),
    claim_text TEXT NOT NULL,
    source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
    direction TEXT NOT NULL CHECK (direction IN ('supports','contradicts','qualifies'))
  ) STRICT;

  CREATE TABLE evidence_assessments (
    assessment_id TEXT PRIMARY KEY,
    experience_version_id TEXT NOT NULL REFERENCES experience_versions(experience_version_id),
    grade TEXT NOT NULL,
    governance_state TEXT NOT NULL CHECK (governance_state IN ('accepted','contested','rejected')),
    operational_state TEXT NOT NULL CHECK (operational_state IN ('active','conditional','stale','superseded','retired')),
    evidence_ids_json TEXT NOT NULL CHECK (json_valid(evidence_ids_json)),
    decided_by TEXT NOT NULL,
    decided_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE experience_relations (
    relation_id TEXT PRIMARY KEY,
    relation_type TEXT NOT NULL CHECK (relation_type IN (
      'derived_from','evidence_for','contradicts','applies_to','requires','precedes',
      'conflicts_with','specializes','composes_with','supersedes','invalidated_by',
      'failed_under','causal_candidate','causally_influences'
    )),
    source_kind TEXT NOT NULL CHECK (source_kind IN (
      'experience','version','component','evidence','episode','condition','claim','usage','scope','entity'
    )),
    source_id TEXT NOT NULL,
    target_kind TEXT NOT NULL CHECK (target_kind IN (
      'experience','version','component','evidence','episode','condition','claim','usage','scope','entity'
    )),
    target_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active','contested','invalidated')),
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    CHECK (source_kind <> target_kind OR source_id <> target_id)
  ) STRICT;

  CREATE TABLE override_decisions (
    override_decision_id TEXT PRIMARY KEY,
    target_relation_id TEXT NOT NULL REFERENCES experience_relations(relation_id),
    actor_id TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE experience_version_components (
    experience_version_id TEXT NOT NULL REFERENCES experience_versions(experience_version_id),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    component_revision_id TEXT NOT NULL REFERENCES component_revisions(component_revision_id),
    PRIMARY KEY (experience_version_id, ordinal),
    UNIQUE (experience_version_id, component_revision_id)
  ) STRICT;

  CREATE TABLE domain_receipts (
    receipt_id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL UNIQUE,
    action TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    causation_id TEXT,
    issued_at TEXT NOT NULL,
    commit_sequence INTEGER NOT NULL UNIQUE,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE command_deduplication (
    command_id TEXT PRIMARY KEY,
    payload_digest TEXT NOT NULL,
    receipt_id TEXT NOT NULL REFERENCES domain_receipts(receipt_id),
    completed_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE audit_events (
    audit_id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    action TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    causation_id TEXT,
    issued_at TEXT NOT NULL,
    object_refs_json TEXT NOT NULL CHECK (json_valid(object_refs_json)),
    payload_digest TEXT NOT NULL,
    source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE outbox_entries (
    outbox_id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    state TEXT NOT NULL CHECK (state IN ('pending','claimed','completed','failed')),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    next_attempt_at TEXT NOT NULL,
    lease_until TEXT,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE match_sets (
    match_set_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE preflight_records (
    preflight_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE usage_plans (
    usage_plan_id TEXT PRIMARY KEY,
    usage_id TEXT NOT NULL,
    plan_revision INTEGER NOT NULL CHECK (plan_revision >= 1),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    UNIQUE(usage_id, plan_revision)
  ) STRICT;
  CREATE TABLE plan_approval_requests (
    request_id TEXT PRIMARY KEY,
    usage_plan_id TEXT NOT NULL REFERENCES usage_plans(usage_plan_id),
    status TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE governance_decisions (
    decision_id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE experience_usages (
    usage_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    state TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE context_snapshots (
    context_snapshot_id TEXT PRIMARY KEY,
    usage_id TEXT NOT NULL REFERENCES experience_usages(usage_id),
    content_digest TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE context_deliveries (
    context_delivery_id TEXT PRIMARY KEY,
    context_snapshot_id TEXT NOT NULL REFERENCES context_snapshots(context_snapshot_id),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE context_retirements (
    context_retirement_id TEXT PRIMARY KEY,
    context_delivery_id TEXT NOT NULL REFERENCES context_deliveries(context_delivery_id),
    state TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE step_progress (
    step_progress_id TEXT PRIMARY KEY,
    usage_id TEXT NOT NULL REFERENCES experience_usages(usage_id),
    controller_revision INTEGER NOT NULL CHECK (controller_revision >= 1),
    state TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    UNIQUE(usage_id, controller_revision)
  ) STRICT;
  CREATE TABLE usage_settlements (
    settlement_id TEXT PRIMARY KEY,
    usage_id TEXT NOT NULL REFERENCES experience_usages(usage_id) UNIQUE,
    outcome TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE criterion_results (
    criterion_result_id TEXT PRIMARY KEY,
    settlement_id TEXT NOT NULL REFERENCES usage_settlements(settlement_id),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
  ) STRICT;
  CREATE TABLE outcome_reconciliations (
    reconciliation_id TEXT PRIMARY KEY,
    settlement_id TEXT NOT NULL REFERENCES usage_settlements(settlement_id),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE revision_proposals (
    revision_proposal_id TEXT PRIMARY KEY,
    experience_id TEXT NOT NULL REFERENCES experience_series(experience_id),
    base_version_id TEXT NOT NULL REFERENCES experience_versions(experience_version_id),
    state TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE revision_changes (
    revision_change_id TEXT PRIMARY KEY,
    revision_proposal_id TEXT NOT NULL REFERENCES revision_proposals(revision_proposal_id),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
  ) STRICT;

  CREATE TABLE markdown_projection_receipts (
    projection_receipt_id TEXT PRIMARY KEY,
    experience_id TEXT NOT NULL REFERENCES experience_series(experience_id),
    experience_version_id TEXT NOT NULL REFERENCES experience_versions(experience_version_id),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    markdown_text TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE admission_attempts (
    admission_attempt_id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    state TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE admission_retry_bindings (
    binding_id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    task_input_digest TEXT NOT NULL,
    state TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    lease_until TEXT,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE projection_checkpoints (
    projection_key TEXT PRIMARY KEY,
    source_offset INTEGER NOT NULL CHECK (source_offset >= 0),
    generation INTEGER NOT NULL CHECK (generation >= 0),
    builder_version TEXT NOT NULL
  ) STRICT;
  CREATE TABLE execution_correlations (
    correlation_id TEXT PRIMARY KEY,
    usage_id TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE verification_runs (
    verification_run_id TEXT PRIMARY KEY,
    usage_id TEXT NOT NULL REFERENCES experience_usages(usage_id),
    controller_revision INTEGER NOT NULL CHECK (controller_revision >= 1),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX verification_runs_usage ON verification_runs(usage_id, created_at, verification_run_id);

  CREATE TABLE preference_validations (
    preference_validation_id TEXT PRIMARY KEY,
    usage_id TEXT NOT NULL REFERENCES experience_usages(usage_id),
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    UNIQUE(usage_id, message_id)
  ) STRICT;

  CREATE TABLE shadow_predictions (
    prediction_id TEXT PRIMARY KEY,
    capability TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE human_labels (
    label_id TEXT PRIMARY KEY,
    prediction_id TEXT NOT NULL REFERENCES shadow_predictions(prediction_id),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE observed_outcome_labels (
    label_id TEXT PRIMARY KEY,
    prediction_id TEXT NOT NULL REFERENCES shadow_predictions(prediction_id),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE unlock_contract_evaluations (
    evaluation_id TEXT PRIMARY KEY,
    capability TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE unlock_contracts (
    unlock_contract_id TEXT PRIMARY KEY,
    capability TEXT NOT NULL,
    contract_version INTEGER NOT NULL CHECK (contract_version >= 1),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    UNIQUE(capability, contract_version)
  ) STRICT;
  CREATE TABLE automation_capabilities (
    capability TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    policy_revision INTEGER NOT NULL CHECK (policy_revision >= 1),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE infrastructure_readiness_evaluations (
    evaluation_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE evaluation_observations (
    evaluation_observation_id TEXT PRIMARY KEY,
    cohort_id TEXT NOT NULL,
    comparison_arm TEXT NOT NULL CHECK (comparison_arm IN ('no_memory','retrieval_only','experience_map')),
    task_case_id TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    UNIQUE(cohort_id, comparison_arm, task_case_id)
  ) STRICT;

  CREATE TABLE forget_requests (
    forget_request_id TEXT PRIMARY KEY,
    experience_id TEXT NOT NULL REFERENCES experience_series(experience_id),
    state TEXT NOT NULL CHECK (state IN ('processing','completed','partial')),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE forget_step_results (
    step_result_id TEXT PRIMARY KEY,
    forget_request_id TEXT NOT NULL REFERENCES forget_requests(forget_request_id),
    phase TEXT NOT NULL CHECK (phase IN ('recall_stop','context_retirement','vault_content','projection_invalidation','tombstone')),
    status TEXT NOT NULL CHECK (status IN ('pending','completed','partial','failed','unknown','not_applicable')),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    updated_at TEXT NOT NULL,
    UNIQUE(forget_request_id, phase)
  ) STRICT;
  CREATE TABLE forget_context_targets (
    forget_request_id TEXT NOT NULL REFERENCES forget_requests(forget_request_id),
    context_delivery_id TEXT NOT NULL REFERENCES context_deliveries(context_delivery_id),
    state TEXT NOT NULL CHECK (state IN ('pending','retired','unknown','failed')),
    context_retirement_id TEXT REFERENCES context_retirements(context_retirement_id),
    reason_code TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (forget_request_id, context_delivery_id)
  ) STRICT;
  CREATE TABLE forget_tombstones (
    experience_id TEXT PRIMARY KEY REFERENCES experience_series(experience_id),
    forget_request_id TEXT NOT NULL UNIQUE REFERENCES forget_requests(forget_request_id),
    forgotten_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX candidate_decisions_candidate ON candidate_field_decisions(candidate_id);
  CREATE INDEX versions_series ON experience_versions(experience_id, version_number);
  CREATE INDEX relations_source ON experience_relations(source_kind, source_id, status, valid_from);
  CREATE INDEX relations_target ON experience_relations(target_kind, target_id, status, valid_from);
  CREATE INDEX overrides_relation ON override_decisions(target_relation_id, valid_until);
  CREATE INDEX components_series ON experience_components(experience_id);
  CREATE INDEX receipts_created ON domain_receipts(commit_sequence DESC);
  CREATE INDEX outbox_claim ON outbox_entries(state, next_attempt_at);
  CREATE INDEX forget_requests_experience ON forget_requests(experience_id, created_at);
  CREATE INDEX markdown_projection_version ON markdown_projection_receipts(experience_version_id, created_at);
  CREATE INDEX evaluation_observations_cohort ON evaluation_observations(cohort_id, comparison_arm, task_case_id);
  CREATE UNIQUE INDEX admission_retry_active_key ON admission_retry_bindings (
    json_extract(payload_json, '$.principalId'),
    json_extract(payload_json, '$.scopeDigest'),
    task_input_digest
  ) WHERE state IN ('active', 'claimed');
`
