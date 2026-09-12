import { describe, expect, it } from 'vitest'
import { evaluateExtractionEligibility } from '../../src/domain/extraction-eligibility.js'
import { brandedId } from '../../src/ids.js'
import type { EpisodeInspectionView, SourceRefView, VerifiedOutcomeManifestConfig } from '../../src/types.js'

const terminalRef: SourceRefView = {
  sourceRefId: brandedId<'ExperienceSourceRefId'>('source:terminal', 'sourceRefId'),
  sourceSystem: 'dsh-session',
  sourceKind: 'session_event',
  locator: 'dsh-session:session-test#2',
  ownerScope: 'session:session-test',
  accessScope: 'local_owner',
  occurredAt: '2026-09-01T00:00:02.000Z',
  observedAt: '2026-09-01T00:01:00.000Z',
  contentDigest: 'sha256:terminal',
  redactionState: 'bounded_excerpt',
}

const inspection: EpisodeInspectionView = {
  episodeRef: {
    episodeRefId: brandedId<'ExperienceEpisodeRefId'>('episode:test', 'episodeRefId'),
    sourceSystem: 'dsh-session',
    sessionOrRunId: 'session-test',
    eventStart: 0,
    eventEnd: 2,
    occurredAt: { start: '2026-09-01T00:00:00.000Z', end: '2026-09-01T00:00:02.000Z' },
    contentDigest: 'sha256:episode',
    redactionState: 'bounded_excerpt',
  },
  sourceRefs: [terminalRef],
  records: [],
  termination: {
    state: 'terminated',
    reason: 'completed',
    terminalSourceRefId: terminalRef.sourceRefId,
  },
  recordCount: 1,
  omittedRecordCount: 0,
}

const manifest: VerifiedOutcomeManifestConfig = {
  episode: {
    sessionId: 'session-test',
    eventStart: 0,
    eventEnd: 2,
    contentDigest: 'sha256:episode',
  },
  policyVersion: 'm0-outcome-v1',
  criteria: [{
    criterionId: 'authenticated-readback',
    mandatory: true,
    result: 'pass',
    evidence: [{
      path: '/tmp/terminal-evidence.json',
      locator: terminalRef.locator,
      contentDigest: terminalRef.contentDigest,
      bytes: 1,
    }],
  }],
}

describe('M2 extraction eligibility', () => {
  it('never treats a completed turn without outcome evidence as terminal success', () => {
    const result = evaluateExtractionEligibility(inspection, [], 'terminal_success', undefined, '2026-09-01T00:02:00.000Z')
    expect(result.outcomeAssessment).toMatchObject({ outcome: 'unknown', method: 'none' })
    expect(result.extractionTrigger).toMatchObject({
      triggerKind: 'terminal_success',
      eligibilityStatus: 'candidate_only',
      eligibilityReasons: ['task_outcome_unverified'],
    })
    expect(result.publicationMode).toBe('review_only')
  })

  it('makes the exact criterion-backed M0 Episode eligible', () => {
    const result = evaluateExtractionEligibility(inspection, [], 'terminal_success', manifest, '2026-09-01T00:02:00.000Z')
    expect(result.outcomeAssessment).toMatchObject({
      outcome: 'success',
      method: 'criterion_manifest',
      criteria: [{ result: 'pass', evidenceRefIds: [terminalRef.sourceRefId] }],
    })
    expect(result.extractionTrigger).toMatchObject({
      eligibilityStatus: 'eligible',
      detectedBy: 'criterion_manifest',
    })
    expect(result.publicationMode).toBe('publishable_after_review')
  })

  it('fails closed when an abnormal termination contradicts terminal success', () => {
    const result = evaluateExtractionEligibility({
      ...inspection,
      termination: { ...inspection.termination, reason: 'aborted' },
    }, [], 'terminal_success', undefined, '2026-09-01T00:02:00.000Z')
    expect(result.extractionTrigger).toMatchObject({
      eligibilityStatus: 'ineligible',
      eligibilityReasons: ['termination_contradicts_success'],
    })
    expect(result.publicationMode).toBe('not_allowed')
  })

  it('fails closed when the exact outcome evidence changes', () => {
    const result = evaluateExtractionEligibility(inspection, [], 'terminal_success', {
      ...manifest,
      criteria: [{ ...manifest.criteria[0]!, evidence: [{ ...manifest.criteria[0]!.evidence[0]!, contentDigest: 'sha256:changed' }] }],
    }, '2026-09-01T00:02:00.000Z')
    expect(result.outcomeAssessment.outcome).toBe('unknown')
    expect(result.extractionTrigger).toMatchObject({
      eligibilityStatus: 'ineligible',
      eligibilityReasons: ['outcome_evidence_changed'],
    })
  })
})
