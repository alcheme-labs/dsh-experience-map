import { createHash } from 'node:crypto'
import type {
  EpisodeInspectionView,
  EpisodeOutcomeAssessmentView,
  ExtractionTriggerKind,
  ExtractionTriggerView,
  ProposalSourceInspectionView,
  SourceRefView,
  VerifiedOutcomeManifestConfig,
} from '../types.js'

/** Current internal policy revision for M2 extraction eligibility. */
export const EXTRACTION_ELIGIBILITY_VERSION = 'm2-eligibility-v1'

/** Complete Host-owned eligibility result shared by inspection and proposal. */
export interface ExtractionEligibilityResult {
  readonly outcomeAssessment: EpisodeOutcomeAssessmentView
  readonly extractionTrigger: ExtractionTriggerView
  readonly eligibilityDigest: string
  readonly publicationMode: ProposalSourceInspectionView['publicationMode']
}

/** Evaluate a requested extraction trigger without treating turn completion as task success. */
export function evaluateExtractionEligibility(
  episode: EpisodeInspectionView,
  additionalSourceRefs: readonly SourceRefView[],
  requestedTriggerKind: ExtractionTriggerKind,
  manifest: VerifiedOutcomeManifestConfig | undefined,
  evaluatedAt = new Date().toISOString(),
): ExtractionEligibilityResult {
  const sourceRefs = [...episode.sourceRefs, ...additionalSourceRefs]
  const assessment = assessOutcome(episode, sourceRefs, manifest, evaluatedAt)
  const evidenceChanged = assessment.method === 'criterion_manifest'
    && assessment.criteria.some(criterion => criterion.result !== 'unknown' && criterion.evidenceRefIds.length === 0)
  const abnormalTermination = episode.termination.reason !== 'completed'
  let eligibilityStatus: ExtractionTriggerView['eligibilityStatus']
  let eligibilityReasons: ExtractionTriggerView['eligibilityReasons']

  if (evidenceChanged) {
    eligibilityStatus = 'ineligible'
    eligibilityReasons = ['outcome_evidence_changed']
  } else if (requestedTriggerKind === 'terminal_success' && abnormalTermination) {
    eligibilityStatus = 'ineligible'
    eligibilityReasons = ['termination_contradicts_success']
  } else if (requestedTriggerKind === 'terminal_success' && assessment.outcome === 'success') {
    eligibilityStatus = 'eligible'
    eligibilityReasons = ['criterion_outcome_verified']
  } else if (requestedTriggerKind === 'terminal_success') {
    eligibilityStatus = 'candidate_only'
    eligibilityReasons = ['task_outcome_unverified']
  } else {
    eligibilityStatus = 'candidate_only'
    eligibilityReasons = ['review_requested_without_verified_outcome']
  }

  const extractionTrigger: ExtractionTriggerView = {
    triggerKind: requestedTriggerKind,
    sourceRefIds: uniqueSourceIds(assessment.criteria.flatMap(criterion => criterion.evidenceRefIds).length > 0
      ? assessment.criteria.flatMap(criterion => criterion.evidenceRefIds)
      : episode.termination.terminalSourceRefId === null ? [] : [episode.termination.terminalSourceRefId]),
    eligibilityStatus,
    eligibilityReasons,
    detectedBy: assessment.method === 'criterion_manifest' ? 'criterion_manifest' : 'user_request',
    detectorVersion: EXTRACTION_ELIGIBILITY_VERSION,
    detectedAt: evaluatedAt,
  }
  const digestPayload = {
    episodeRef: episode.episodeRef,
    termination: episode.termination,
    outcomeAssessment: {
      ...assessment,
      assessedAt: undefined,
    },
    extractionTrigger: {
      ...extractionTrigger,
      detectedAt: undefined,
    },
  }
  return {
    outcomeAssessment: assessment,
    extractionTrigger,
    eligibilityDigest: `sha256:${sha256(canonicalJson(digestPayload))}`,
    publicationMode: eligibilityStatus === 'eligible'
      ? 'publishable_after_review'
      : eligibilityStatus === 'candidate_only' ? 'review_only' : 'not_allowed',
  }
}

function assessOutcome(
  episode: EpisodeInspectionView,
  sourceRefs: readonly SourceRefView[],
  manifest: VerifiedOutcomeManifestConfig | undefined,
  assessedAt: string,
): EpisodeOutcomeAssessmentView {
  if (manifest === undefined || !sameEpisode(episode, manifest)) {
    return {
      outcome: episode.termination.reason === 'aborted' ? 'aborted' : 'unknown',
      method: 'none',
      policyVersion: EXTRACTION_ELIGIBILITY_VERSION,
      manifestDigest: null,
      criteria: [],
      assessedAt,
    }
  }
  const criteria = manifest.criteria.map(criterion => ({
    criterionId: criterion.criterionId,
    mandatory: criterion.mandatory,
    result: criterion.result,
    evidenceRefIds: criterion.result === 'unknown' ? [] : criterion.evidence
      .map(expected => sourceRefs.find(ref => ref.locator === expected.locator && ref.contentDigest === expected.contentDigest)?.sourceRefId)
      .filter((value): value is SourceRefView['sourceRefId'] => value !== undefined),
  }))
  const changed = criteria.some((criterion, index) => criterion.result !== 'unknown'
    && criterion.evidenceRefIds.length !== manifest.criteria[index]!.evidence.length)
  const mandatory = criteria.filter(criterion => criterion.mandatory)
  const outcome = changed || mandatory.some(criterion => criterion.result === 'unknown')
    ? 'unknown'
    : mandatory.some(criterion => criterion.result === 'fail') ? 'failure'
      : mandatory.every(criterion => criterion.result === 'pass') ? 'success' : 'partial'
  return {
    outcome,
    method: 'criterion_manifest',
    policyVersion: manifest.policyVersion,
    manifestDigest: `sha256:${sha256(canonicalJson(manifest))}`,
    criteria,
    assessedAt,
  }
}

function sameEpisode(episode: EpisodeInspectionView, manifest: VerifiedOutcomeManifestConfig): boolean {
  const expected = manifest.episode
  const actual = episode.episodeRef
  return expected.sessionId === actual.sessionOrRunId
    && expected.eventStart === actual.eventStart
    && expected.eventEnd === actual.eventEnd
    && expected.contentDigest === actual.contentDigest
}

function uniqueSourceIds(values: readonly SourceRefView['sourceRefId'][]): SourceRefView['sourceRefId'][] {
  return [...new Set(values)]
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  const json = JSON.stringify(value)
  if (json === undefined) throw new TypeError('eligibility digest contains a non-JSON value')
  return json
}
