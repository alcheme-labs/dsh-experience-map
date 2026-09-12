import { createHash } from 'node:crypto'
import { TYPE_BEHAVIORS } from '../../src/domain/behavior.js'
import { SessionId } from '@deepseek-ai/dsh-session'
import { brandedId } from '../../src/ids.js'
import type {
  CandidateProposalMetadata,
  DiagnosticCandidateDraft,
  ExperienceCandidateDraft,
  EpisodeRefView,
  ExtractionEvidencePacket,
  EpisodeOutcomeAssessmentView,
  ExtractionTriggerView,
  ProposeCandidateInput,
  SourceRefView,
} from '../../src/types.js'

export const episodeRef: EpisodeRefView = {
  episodeRefId: brandedId<'ExperienceEpisodeRefId'>('episode:test-terminal-session', 'episodeRefId'),
  sourceSystem: 'dsh-session',
  sessionOrRunId: 'session-test',
  eventStart: 0,
  eventEnd: 2,
  occurredAt: { start: '2026-08-31T08:00:00.000Z', end: '2026-08-31T08:01:00.000Z' },
  contentDigest: 'sha256:session-content',
  redactionState: 'bounded_excerpt',
}

export const sourceRef: SourceRefView = {
  sourceRefId: brandedId<'ExperienceSourceRefId'>('source:test-terminal-event', 'sourceRefId'),
  sourceSystem: 'dsh-session',
  sourceKind: 'tool_result',
  locator: 'dsh-session:session-test#1',
  ownerScope: 'session:session-test',
  accessScope: 'local_owner',
  occurredAt: '2026-08-31T08:00:30.000Z',
  observedAt: '2026-08-31T09:00:00.000Z',
  contentDigest: 'sha256:event-content',
  redactionState: 'bounded_excerpt',
}

/** Minimal observed-fact packet used by proposal adapter tests. */
export const evidencePacket: ExtractionEvidencePacket = {
  builderVersion: 'diagnostic-evidence-packet-v3',
  episodeRefs: [episodeRef],
  items: [{
    itemId: 'evidence:test-terminal-result',
    sourceRef,
    eventType: 'tool/result',
    evidenceRole: 'terminal_readback',
    evidenceClass: 'observed_fact',
    content: 'verified result',
    sourceContentDigest: sourceRef.contentDigest,
    projectionDigest: 'sha256:projection',
    projectionTruncated: false,
  }],
  omissions: [],
  sourceRecordCount: 1,
  sentSourceRecordCount: 1,
  fullyOmittedSourceRecordCount: 0,
  removedBlockCount: 0,
  omissionReasonCounts: {},
  sourceRecordBytes: 15,
  packetBytes: 512,
  packetDigest: 'sha256:evidence-packet',
}

/** Complete source-bound proposal used by M2 domain and persistence tests. */
export function workflowDraft(overrides: Partial<DiagnosticCandidateDraft> = {}): DiagnosticCandidateDraft {
  // A title override in these fixtures represents a genuinely different scenario,
  // not a cosmetic rename of the same stable kernel. Keep component text unchanged
  // (many ranking tests deliberately need equal reusable content), and distinguish
  // the declared fixture scope unless the caller supplies explicit components.
  const generatedScenario = overrides.components === undefined
    ? overrides.title ?? overrides.intent
    : undefined
  const generatedScenarioId = generatedScenario === undefined
    ? undefined
    : createHash('sha256').update(generatedScenario).digest('hex')
  const generatedScope = {
    ...(overrides.scope ?? { product: 'deepseek-harness', surface: 'web' }),
    ...(generatedScenarioId === undefined ? {} : { fixtureScenarioId: generatedScenarioId }),
  }
  const components = TYPE_BEHAVIORS.diagnostic.requiredRoles.map((role, index) => ({
    componentKey: `${role}-${String(index + 1)}`,
    role,
    content: `${role} evidence-bound content`,
    sourceRefs: [sourceRef.sourceRefId],
  }))
  const fields = [
    'proposedKind', 'title', 'intent', 'scope', 'validity', 'authoritySpec', 'privacyClass',
    'riskAndEffectSpec', 'allowedUseModes',
    ...components.map(component => `component:${component.componentKey}`),
  ]
  return {
    proposedKind: 'diagnostic',
    title: 'Verified Web startup diagnostic',
    intent: 'Reuse the verified startup diagnosis without repeating exploration.',
    validity: { node: '^22.19.0 || >=24.0.0' },
    authoritySpec: { owner: 'local-user', evidence: 'session-log' },
    privacyClass: 'workspace',
    riskAndEffectSpec: { risk: 'local-process', effect: 'starts-owned-web-process' },
    allowedUseModes: ['reference', 'suggest', 'guided'],
    components,
    evidenceGrade: 'observation_supported',
    fieldSourceRefs: Object.fromEntries(fields.map(field => [field, [sourceRef.sourceRefId]])),
    excludedSteps: [{
      summary: 'Starting before the frontend build',
      reason: 'The terminal Session observed the missing artifact failure.',
      sourceRefs: [sourceRef.sourceRefId],
    }],
    missingEvidence: [],
    unresolvedFields: [],
    ...overrides,
    scope: generatedScope,
  }
}

/** Complete source-bound draft for any first-party Experience kind. */
export function typedWorkflowDraft(
  kind: import('../../src/domain/kind.js').ExperienceKind,
  overrides: Partial<ExperienceCandidateDraft> = {},
): ExperienceCandidateDraft {
  if (kind === 'diagnostic') return workflowDraft(overrides as Partial<DiagnosticCandidateDraft>)
  const behavior = TYPE_BEHAVIORS[kind]
  const roles = [...behavior.requiredRoles]
  if (kind === 'preference_policy') roles.push('positive_example', 'no_known_exception')
  const contentFor = (role: typeof roles[number]): string => {
    if (role === 'modality') return 'prefer'
    if (role === 'authority_source') return 'explicit_user_instruction'
    if (role === 'causal_grade') return 'observation_supported'
    if (role === 'allowed_use') return 'diagnostic_support'
    return `${role} evidence-bound content`
  }
  const components = roles.map((role, index) => ({
    componentKey: `${role}-${String(index + 1)}`,
    role,
    content: contentFor(role),
    sourceRefs: [sourceRef.sourceRefId],
  }))
  const fields = [
    'proposedKind', 'title', 'intent', 'scope', 'validity', 'authoritySpec', 'privacyClass',
    'riskAndEffectSpec', 'allowedUseModes',
    ...components.map(component => `component:${component.componentKey}`),
  ]
  return {
    proposedKind: kind,
    title: `${kind} source-bound Experience`,
    intent: `Reuse the source-bound ${kind} knowledge without repeating exploration.`,
    scope: { product: 'deepseek-harness', surface: 'web' },
    validity: { source: 'reviewed-session-evidence' },
    authoritySpec: { owner: 'local-user', evidence: 'session-log' },
    privacyClass: 'workspace',
    riskAndEffectSpec: { risk: 'advisory', effect: 'current-task-guidance' },
    allowedUseModes: ['reference', 'suggest', 'guided'],
    components,
    evidenceGrade: 'observation_supported',
    fieldSourceRefs: Object.fromEntries(fields.map(field => [field, [sourceRef.sourceRefId]])),
    excludedSteps: [],
    missingEvidence: [],
    unresolvedFields: [],
    ...overrides,
  }
}

export const proposalMetadata: CandidateProposalMetadata = {
  generator: 'model',
  proposalSessionId: SessionId('experience-proposal-test'),
  provider: 'test-provider',
  model: 'test-model',
  promptVersion: 'diagnostic-candidate-v9',
  schemaVersion: 'diagnostic-candidate-tool-schema-v7',
  policyVersion: 'source-secret-evidence-class-v3',
  sourceInputDigest: 'sha256:proposal-input',
  disclosureDigest: 'sha256:route-and-input',
  outputDigest: 'sha256:proposal-output',
  proposedAt: '2026-08-31T09:00:00.000Z',
}

export const eligibleExtraction: {
  readonly extractionTrigger: ExtractionTriggerView
  readonly outcomeAssessment: EpisodeOutcomeAssessmentView
  readonly eligibilityDigest: string
} = {
  extractionTrigger: {
    triggerKind: 'terminal_success',
    sourceRefIds: [sourceRef.sourceRefId],
    eligibilityStatus: 'eligible',
    eligibilityReasons: ['criterion_outcome_verified'],
    detectedBy: 'criterion_manifest',
    detectorVersion: 'm2-eligibility-v1',
    detectedAt: '2026-08-31T09:00:00.000Z',
  },
  outcomeAssessment: {
    outcome: 'success',
    method: 'criterion_manifest',
    policyVersion: 'm0-outcome-v1',
    manifestDigest: 'sha256:m0-outcome-manifest',
    criteria: [{
      criterionId: 'terminal-readback',
      mandatory: true,
      result: 'pass',
      evidenceRefIds: [sourceRef.sourceRefId],
    }],
    assessedAt: '2026-08-31T09:00:00.000Z',
  },
  eligibilityDigest: 'sha256:eligible-extraction',
}

export function proposeInput(
  commandId = '10000000-0000-4000-8000-000000000001',
  requestedKind: ProposeCandidateInput['requestedKind'] = 'diagnostic',
): ProposeCandidateInput {
  return {
    requestedKind,
    commandId: brandedId<'ExperienceCommandId'>(commandId, 'commandId'),
    correlationId: 'm2-workflow',
    causationId: null,
    issuedAt: '2026-08-31T09:01:00.000Z',
    episode: {
      sessionId: episodeRef.sessionOrRunId,
      eventStart: episodeRef.eventStart,
      eventEnd: episodeRef.eventEnd,
      contentDigest: episodeRef.contentDigest,
    },
    eligibilityDigest: eligibleExtraction.eligibilityDigest,
    outputTokenLimit: { mode: 'configured_default' },
    proposalDisclosureDigest: proposalMetadata.disclosureDigest,
    confirmedMaxOutputTokens: 8_192,
    confirmExternalModelProcessing: true,
  }
}
