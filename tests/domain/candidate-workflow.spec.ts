import { describe, expect, it } from 'vitest'
import {
  acceptCandidateWorkflow,
  createCandidateWorkflow,
  decideCandidateWorkflowField,
  publishCandidateWorkflow,
  submitCandidateWorkflow,
  workflowFieldViews,
  workflowFields,
} from '../../src/domain/candidate-workflow.js'
import { brandedId } from '../../src/ids.js'
import type { CandidateWorkflowRecord } from '../../src/domain/candidate-workflow.js'
import { eligibleExtraction, episodeRef, proposalMetadata, sourceRef, workflowDraft } from '../fixtures/workflow.js'

describe('M2 Candidate field-governance lifecycle', () => {
  it('rejects guarded execution before Candidate persistence because M2 has no executor binding', () => {
    expect(() => createCandidateWorkflow(
      workflowDraft({ allowedUseModes: ['guarded_execute'] }),
      [episodeRef],
      [sourceRef],
      eligibleExtraction,
      proposalMetadata,
      brandedId<'ExperienceActorId'>('actor:owner', 'actorId'),
      allocation(),
      '2026-08-31T09:00:00.000Z',
      16_384,
    )).toThrow(/cannot exceed guided/i)
  })

  it('keeps model output proposed until every field receives an explicit owner decision', () => {
    let candidate = createCandidateWorkflow(
      workflowDraft(), [episodeRef], [sourceRef], eligibleExtraction, proposalMetadata,
      brandedId<'ExperienceActorId'>('actor:owner', 'actorId'), allocation(),
      '2026-08-31T09:00:00.000Z', 16_384,
    )
    expect(candidate).toMatchObject({ state: 'proposed', revision: 1, decisions: [] })
    candidate = submitCandidateWorkflow(candidate, 1)
    expect(candidate).toMatchObject({ state: 'in_review', revision: 2 })
    for (const [index, [field]] of workflowFields(candidate).entries()) {
      candidate = decideCandidateWorkflowField(
        candidate,
        { field, decision: 'accept', reason: 'owner_checked_source' },
        `decision-${String(index)}`,
        brandedId<'ExperienceActorId'>('actor:owner', 'actorId'),
        '2026-08-31T09:02:00.000Z',
        candidate.revision,
        16_384,
      )
    }
    candidate = acceptCandidateWorkflow(candidate, candidate.revision, 16_384)
    expect(candidate.state).toBe('accepted')
    candidate = publishCandidateWorkflow(
      candidate,
      candidate.revision,
      brandedId<'ExperienceVersionId'>('version-1', 'experienceVersionId'),
    )
    expect(candidate).toMatchObject({ state: 'published', publishedVersionId: 'version-1' })
  })

  it('rejects stale revisions, repeated decisions, unresolved fields, and secret inline content', () => {
    const proposed = createCandidateWorkflow(
      workflowDraft(), [episodeRef], [sourceRef], eligibleExtraction, proposalMetadata,
      brandedId<'ExperienceActorId'>('actor:owner', 'actorId'), allocation(),
      '2026-08-31T09:00:00.000Z', 16_384,
    )
    expect(() => submitCandidateWorkflow(proposed, 2)).toThrow(/revision/i)
    let reviewing = submitCandidateWorkflow(proposed, 1)
    reviewing = decideCandidateWorkflowField(
      reviewing,
      { field: 'title', decision: 'accept', reason: 'checked' },
      'decision-1',
      brandedId<'ExperienceActorId'>('actor:owner', 'actorId'),
      '2026-08-31T09:02:00.000Z',
      2,
      16_384,
    )
    const revised = decideCandidateWorkflowField(
      reviewing,
      {
        field: 'title',
        decision: 'edit',
        value: 'Corrected title',
        effectiveSourceRefs: [sourceRef.sourceRefId],
        reason: 'source requires a narrower title',
      },
      'decision-2',
      brandedId<'ExperienceActorId'>('actor:owner', 'actorId'),
      '2026-08-31T09:03:00.000Z',
      3,
      16_384,
    )
    expect(revised.decisions.at(-1)).toMatchObject({ supersedesDecisionId: 'decision-1' })
    expect(() => createCandidateWorkflow(
      workflowDraft({ privacyClass: 'secret_reference_only' }), [episodeRef], [sourceRef],
      eligibleExtraction, proposalMetadata,
      brandedId<'ExperienceActorId'>('actor:owner', 'actorId'), allocation(),
      '2026-08-31T09:00:00.000Z', 16_384,
    )).toThrow(/Governed Content is disabled/i)
    const unresolved = workflowDraft({
      fieldSourceRefs: { ...workflowDraft().fieldSourceRefs, title: [] },
      unresolvedFields: ['title'],
    })
    let unresolvedCandidate = createCandidateWorkflow(
      unresolved, [episodeRef], [sourceRef], eligibleExtraction, proposalMetadata,
      brandedId<'ExperienceActorId'>('actor:owner', 'actorId'), allocation('unresolved'),
      '2026-08-31T09:00:00.000Z', 16_384,
    )
    unresolvedCandidate = submitCandidateWorkflow(unresolvedCandidate, 1)
    for (const [index, [field]] of workflowFields(unresolvedCandidate).entries()) {
      unresolvedCandidate = decideCandidateWorkflowField(
        unresolvedCandidate,
        { field, decision: 'accept', reason: 'checked' },
        `unresolved-decision-${String(index)}`,
        brandedId<'ExperienceActorId'>('actor:owner', 'actorId'),
        '2026-08-31T09:02:00.000Z',
        unresolvedCandidate.revision,
        16_384,
      )
    }
    expect(() => acceptCandidateWorkflow(
      unresolvedCandidate, unresolvedCandidate.revision, 16_384,
    )).toThrow(/without sources/i)
    unresolvedCandidate = decideCandidateWorkflowField(
      unresolvedCandidate,
      {
        field: 'title',
        decision: 'edit',
        value: 'Source-backed title',
        effectiveSourceRefs: [sourceRef.sourceRefId],
        reason: 'selected the runtime source that supports the corrected title',
      },
      'unresolved-title-revision',
      brandedId<'ExperienceActorId'>('actor:owner', 'actorId'),
      '2026-08-31T09:04:00.000Z',
      unresolvedCandidate.revision,
      16_384,
    )
    expect(workflowFieldViews(unresolvedCandidate).find(field => field.field === 'title'))
      .toMatchObject({ unresolved: false, proposedSourceRefs: [], sourceRefs: [sourceRef.sourceRefId] })
    expect(acceptCandidateWorkflow(unresolvedCandidate, unresolvedCandidate.revision, 16_384).state)
      .toBe('accepted')
  })

  it('applies the inline body limit to Candidate content, not bounded SourceRef metadata', () => {
    const sourceRefs = [sourceRef, ...Array.from({ length: 95 }, (_, index) => ({
      ...sourceRef,
      sourceRefId: brandedId<'ExperienceSourceRefId'>(`source:bounded-${String(index)}`, 'sourceRefId'),
      locator: `dsh-session:session-test#${String(index)}`,
    }))]
    expect(JSON.stringify(sourceRefs).length).toBeGreaterThan(16_384)
    expect(() => createCandidateWorkflow(
      workflowDraft(), [episodeRef], sourceRefs, eligibleExtraction, proposalMetadata,
      brandedId<'ExperienceActorId'>('actor:owner', 'actorId'), allocation('bounded-sources'),
      '2026-08-31T09:00:00.000Z', 16_384,
    )).not.toThrow()
  })

  it('blocks review-only eligibility and missing evidence while deriving the evidence grade from Host sources', () => {
    const candidateOnly = reviewAll(createCandidateWorkflow(
      workflowDraft(), [episodeRef], [sourceRef], {
        ...eligibleExtraction,
        extractionTrigger: {
          ...eligibleExtraction.extractionTrigger,
          eligibilityStatus: 'candidate_only',
          eligibilityReasons: ['task_outcome_unverified'],
        },
      }, proposalMetadata,
      brandedId<'ExperienceActorId'>('actor:owner', 'actorId'), allocation('candidate-only'),
      '2026-08-31T09:00:00.000Z', 16_384,
    ))
    expect(() => acceptCandidateWorkflow(candidateOnly, candidateOnly.revision, 16_384)).toThrow(/eligible/i)

    const missingEvidence = reviewAll(createCandidateWorkflow(
      workflowDraft({ missingEvidence: ['authenticated readback is absent'] }),
      [episodeRef], [sourceRef], eligibleExtraction, proposalMetadata,
      brandedId<'ExperienceActorId'>('actor:owner', 'actorId'), allocation('missing-evidence'),
      '2026-08-31T09:00:00.000Z', 16_384,
    ))
    expect(() => acceptCandidateWorkflow(missingEvidence, missingEvidence.revision, 16_384)).toThrow(/missing evidence/i)

    const hostGraded = reviewAll(createCandidateWorkflow(
      workflowDraft({ evidenceGrade: 'mechanism_supported' }),
      [episodeRef], [sourceRef], eligibleExtraction, proposalMetadata,
      brandedId<'ExperienceActorId'>('actor:owner', 'actorId'), allocation('unsupported-grade'),
      '2026-08-31T09:00:00.000Z', 16_384,
    ))
    expect(hostGraded.draft.evidenceGrade).toBe('observation_supported')
    expect(hostGraded.draft.fieldSourceRefs).not.toHaveProperty('evidenceGrade')
    expect(() => acceptCandidateWorkflow(hostGraded, hostGraded.revision, 16_384)).not.toThrow()
  })

  it('keeps repeated semantic roles independently addressable by component key', () => {
    const base = workflowDraft()
    const repeated = {
      ...base.components.find(component => component.role === 'hypothesis')!,
      componentKey: 'hypothesis-independent',
      content: 'second independently reviewable hypothesis',
    }
    const draft = workflowDraft({
      components: [...base.components, repeated],
      fieldSourceRefs: {
        ...base.fieldSourceRefs,
        'component:hypothesis-independent': [sourceRef.sourceRefId],
      },
    })
    expect(() => createCandidateWorkflow(
      draft, [episodeRef], [sourceRef], eligibleExtraction, proposalMetadata,
      brandedId<'ExperienceActorId'>('actor:owner', 'actorId'), allocation('repeated-role', draft.components.length),
      '2026-08-31T09:00:00.000Z', 16_384,
    )).not.toThrow()
  })
})

function allocation(suffix = 'primary', count = workflowDraft().components.length) {
  return {
    candidateId: brandedId<'ExperienceCandidateId'>(`candidate-${suffix}`, 'candidateId'),
    componentIds: Array.from({ length: count }, (_, index) =>
      brandedId<'ExperienceComponentId'>(`component-${suffix}-${String(index)}`, 'componentId')),
    componentRevisionIds: Array.from({ length: count }, (_, index) =>
      brandedId<'ExperienceComponentRevisionId'>(`component-revision-${suffix}-${String(index)}`, 'componentRevisionId')),
    evidenceIds: Array.from({ length: count }, (_, index) =>
      brandedId<'ExperienceEvidenceId'>(`evidence-${suffix}-${String(index)}`, 'evidenceId')),
  }
}

function reviewAll(proposed: CandidateWorkflowRecord): CandidateWorkflowRecord {
  let candidate = submitCandidateWorkflow(proposed, proposed.revision)
  for (const [index, [field]] of workflowFields(candidate).entries()) {
    candidate = decideCandidateWorkflowField(
      candidate,
      { field, decision: 'accept', reason: 'checked against source' },
      `decision-${candidate.candidateId}-${String(index)}`,
      brandedId<'ExperienceActorId'>('actor:owner', 'actorId'),
      '2026-08-31T09:02:00.000Z',
      candidate.revision,
      16_384,
    )
  }
  return candidate
}
