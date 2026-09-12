import { describe, expect, it } from 'vitest'
import {
  composeUsagePlan,
  contributionsFor,
  fingerprintTask,
  matchExperiences,
  preflightMatch,
} from '../src/domain/planning.js'
import { brandedId } from '../src/ids.js'
import type {
  ActorView,
  ExperienceVersionView,
  PlanContributionView,
  PlanningObservationView,
  PlanningTaskInput,
} from '../src/types.js'

const now = '2026-09-02T01:00:00.000Z'
const later = '2026-09-02T01:05:00.000Z'

describe('M3 bounded matching and deterministic planning', () => {
  it('keeps explicit hard facts Host-owned while model fields widen discovery only', () => {
    const fingerprint = fingerprintTask(task(), actor(), now, {
      intent: 'Model supplied discovery intent',
      taskFamily: 'deployment',
      capabilities: ['web'],
    })
    expect(fingerprint).toMatchObject({
      targetExposure: 'local',
      riskClass: 'medium',
      intent: 'Model supplied discovery intent',
      fieldProvenance: {
        targetExposure: 'explicit_user_input',
        riskClass: 'explicit_user_input',
        intent: 'model_proposal',
      },
    })
    expect(fingerprint.hardConstraints).toContain('target_exposure:local')
  })

  it('rejects a local procedure for public deployment but retains its independent build check', () => {
    const fingerprint = fingerprintTask(task({ targetExposure: 'public' }), actor(), now)
    const match = matchExperiences(fingerprint, [version()], 32, now)
    expect(match.candidates).toHaveLength(1)
    expect(match.candidates[0]).toMatchObject({
      rejected: true,
      reasonCodes: ['local_procedure_rejected', 'independent_build_check_retained'],
    })
    expect(match.candidates[0]!.selectedComponentRevisionIds).toEqual(['revision-build'])
  })

  it('does not retain local build checks for an unrelated public task', () => {
    const fingerprint = fingerprintTask(task({
      text: 'Publish a short Japanese haiku on a public poetry page.',
      requiredCapabilities: [],
      targetExposure: 'public',
    }), actor(), now)
    const match = matchExperiences(fingerprint, [version()], 32, now)
    expect(match).toMatchObject({ candidates: [], noMatch: true })
  })

  it('keeps a single explicit structural signal eligible for bounded retrieval', () => {
    const fingerprint = fingerprintTask(task({
      text: 'build',
      requiredCapabilities: [],
    }), actor(), now)
    const match = matchExperiences(fingerprint, [version()], 32, now)
    expect(match.candidates).toHaveLength(1)
    expect(match.candidates[0]!.structuralScore).toBeGreaterThan(0)
    expect(match.candidates[0]!.reasonCodes).toEqual(['structural_match_only'])
  })

  it('reports a lexical-only match without claiming a structural signal', () => {
    const fingerprint = fingerprintTask(task({
      text: 'authenticated diagnosis',
      requiredCapabilities: [],
    }), actor(), now)
    const match = matchExperiences(fingerprint, [version()], 32, now)
    expect(match.candidates).toHaveLength(1)
    expect(match.candidates[0]).toMatchObject({
      structuralScore: 0,
      reasonCodes: ['lexical_match_only'],
    })
  })

  it('marks the anonymous-200 verifier adaptable under the current authenticated contract', () => {
    const fingerprint = fingerprintTask(task(), actor(), now)
    const match = matchExperiences(fingerprint, [version()], 32, now)
    const preflight = preflightMatch(fingerprint, match, version(), observations(true), now, later)
    expect(preflight.disposition).toBe('adaptable')
    expect(preflight.reasonCodes).toContain('condition_invalidated_by_current_auth_contract')
    const contributions = contributionsFor(version(), match.candidates[0]!, preflight)
    expect(contributions.some(item => /anonymous/iu.test(item.content))).toBe(false)
  })

  it('marks an expired or malformed Fact stale before it can contribute Context', () => {
    const fingerprint = fingerprintTask(task({
      text: 'Read the workspace runtime node version', requiredCapabilities: [], riskClass: 'standard',
    }), actor(), now)
    const expired = factVersion('2026-09-01T00:00:00.000Z')
    const expiredMatch = matchExperiences(fingerprint, [expired], 32, now)
    const expiredPreflight = preflightMatch(fingerprint, expiredMatch, expired, observations(false), now, later)
    expect(expiredPreflight).toMatchObject({
      disposition: 'stale', reasonCodes: expect.arrayContaining(['fact_freshness_expired']),
    })
    expect(contributionsFor(expired, expiredMatch.candidates[0]!, expiredPreflight)).toEqual([])

    const malformed = factVersion('not-a-date')
    const malformedMatch = matchExperiences(fingerprint, [malformed], 32, now)
    expect(preflightMatch(fingerprint, malformedMatch, malformed, observations(false), now, later))
      .toMatchObject({ disposition: 'stale', reasonCodes: expect.arrayContaining(['fact_freshness_expired']) })
  })

  it('produces the same semantic plan digest for every contribution permutation', () => {
    const fingerprint = fingerprintTask(task(), actor(), now)
    const match = matchExperiences(fingerprint, [version()], 32, now)
    const preflight = preflightMatch(fingerprint, match, version(), observations(false), now, later)
    const contributions = contributionsFor(version(), match.candidates[0]!, preflight)
    const first = composeUsagePlan(fingerprint, match, [preflight], contributions, now)
    const second = composeUsagePlan(fingerprint, match, [preflight], [...contributions].reverse(), now)
    expect(first.contentDigest).toBe(second.contentDigest)
    expect(first.orderedSteps).toEqual(second.orderedSteps)
  })

  it('emits the fixed diagnostic golden plan from current applicable evidence', () => {
    const fingerprint = fingerprintTask(task(), actor(), now)
    const match = matchExperiences(fingerprint, [version()], 32, now)
    const preflight = preflightMatch(fingerprint, match, version(), observations(false), now, later)
    const plan = composeUsagePlan(
      fingerprint,
      match,
      [preflight],
      contributionsFor(version(), match.candidates[0]!, preflight),
      now,
    )

    expect(plan).toMatchObject({
      planRevision: 1,
      orderedSteps: [{
        stepId: 'step-01',
        content: 'Run pnpm build to create the frontend dist artifact.',
        componentRevisionId: 'revision-build',
      }],
      constraints: [],
      premises: ['Frontend assets were absent before build.'],
      hypotheses: [],
      recovery: [],
      verification: [
        'Anonymous HTTP 200 proves the Web app is ready.',
        'Verify authenticated RPC readback after startup.',
      ],
      blockers: [],
      disposition: 'ready_for_approval',
      requiresApproval: true,
    })
  })

  it('retains one deterministic contribution when accepted Experiences contain equivalent content', () => {
    const fingerprint = fingerprintTask(task(), actor(), now)
    const match = matchExperiences(fingerprint, [version()], 32, now)
    const preflight = preflightMatch(fingerprint, match, version(), observations(false), now, later)
    const contributions = contributionsFor(version(), match.candidates[0]!, preflight)
    const duplicate = {
      ...contributions.find(item => item.componentRevisionId === 'revision-build')!,
      contributionId: 'revision-build-copy',
      componentRevisionId: brandedId<'ExperienceComponentRevisionId'>('revision-build-copy', 'componentRevisionId'),
      experienceVersionId: brandedId<'ExperienceVersionId'>('version-2', 'versionId'),
      content: '  RUN pnpm build to create the frontend dist artifact.  ',
    }
    const adaptable = { ...preflight, disposition: 'adaptable' as const }
    const applicable = {
      ...preflight,
      preflightId: brandedId<'ExperiencePreflightId'>('preflight-2', 'preflightId'),
      experienceVersionId: duplicate.experienceVersionId,
      disposition: 'applicable' as const,
    }

    const plan = composeUsagePlan(fingerprint, match, [adaptable, applicable], [...contributions, duplicate], now)

    expect(plan.orderedSteps).toHaveLength(1)
    expect(plan.discardedContributions).toContainEqual({
      contributionId: 'revision-build',
      reasonCode: 'equivalent_content',
    })
    expect(plan.selectedContributions).toContainEqual(duplicate)
  })

  it('resolves declared conflicts deterministically and rejects contribution cycles', () => {
    const fingerprint = fingerprintTask(task(), actor(), now)
    const match = matchExperiences(fingerprint, [version()], 32, now)
    const first = contribution('a', 400, { conflictsWith: ['b'] })
    const second = contribution('b', 401)
    const resolved = composeUsagePlan(fingerprint, match, [], [second, first], now)
    expect(resolved.selectedContributions.map(item => item.contributionId)).toEqual(['a'])
    expect(resolved.discardedContributions).toEqual([{
      contributionId: 'b', reasonCode: 'experience_conflict',
    }])

    expect(() => composeUsagePlan(fingerprint, match, [], [
      contribution('cycle-a', 400, { precedes: ['cycle-b'] }),
      contribution('cycle-b', 401, { precedes: ['cycle-a'] }),
    ], now)).toThrow('plan contribution dependencies must be acyclic')
  })

  it('blocks a medium-risk plan when required current observations are unknown', () => {
    const fingerprint = fingerprintTask(task(), actor(), now)
    const match = matchExperiences(fingerprint, [version()], 32, now)
    const current = observations(false)
    current[0] = observation('repository_state', {}, 'unknown')
    const preflight = preflightMatch(fingerprint, match, version(), current, now, later)
    expect(preflight).toMatchObject({
      disposition: 'blocked', blockers: ['required_observation_unknown'],
    })
    const plan = composeUsagePlan(fingerprint, match, [preflight], [], now)
    expect(plan).toMatchObject({ disposition: 'blocked', requiresApproval: false })
  })

  it('returns no-match without inventing Experience context', () => {
    const fingerprint = fingerprintTask(task({ text: 'translate a poem into Italian', requiredCapabilities: [] }), actor(), now)
    const match = matchExperiences(fingerprint, [version()], 32, now)
    expect(match.noMatch).toBe(true)
    const plan = composeUsagePlan(fingerprint, match, [], [], now)
    expect(plan).toMatchObject({ disposition: 'no_match', selectedContributions: [], requiresApproval: false })
  })
})

function task(overrides: Partial<PlanningTaskInput> = {}): PlanningTaskInput {
  return {
    text: 'Build and start the local DeepSeek Harness Web application with authenticated readback',
    workspaceRoot: '/workspace/deepseek-harness',
    targetExposure: 'local',
    mustUseExperience: false,
    riskClass: 'medium',
    requiredCapabilities: ['build', 'web'],
    requestedUseMode: 'guided',
    overrideDecisionIds: [],
    ...overrides,
  }
}

function actor(): ActorView {
  return {
    actorId: brandedId<'ExperienceActorId'>('actor-local', 'actorId'),
    principalId: brandedId<'ExperienceLocalOwnerPrincipalId'>('principal-local', 'principalId'),
    kind: 'management_local_owner',
    authority: 'owner',
  }
}

function observations(authRequired: boolean): PlanningObservationView[] {
  return [observation('repository_state', { packageManifestPresent: true }),
    observation('build_artifact', { 'apps/web/dist': true }),
    observation('web_contract', { authRequired }),
    observation('process_socket', {}, 'unknown'),
    observation('authenticated_http', {}, 'unknown')]
}

function observation(
  kind: PlanningObservationView['kind'],
  values: PlanningObservationView['values'],
  status: PlanningObservationView['status'] = 'observed',
): PlanningObservationView {
  return {
    observationId: `observation-${kind}`,
    kind,
    providerVersion: 'test-v1',
    status,
    summary: `${kind} test fact`,
    values,
    sourceRefs: [],
    observedAt: now,
    validUntil: later,
    contentDigest: `sha256:${kind}`,
    reasonCode: status === 'unknown' ? 'not_available' : null,
  }
}

function version(): ExperienceVersionView {
  return {
    experienceVersionId: brandedId<'ExperienceVersionId'>('version-1', 'versionId'),
    experienceId: brandedId<'ExperienceId'>('experience-1', 'experienceId'),
    versionNumber: 1,
    previousVersionId: null,
    kind: 'diagnostic',
    title: 'Harness Web startup diagnosis',
    intent: 'Build Web assets before starting the local authenticated application',
    scope: { product: 'deepseek-harness', exposure: 'local-loopback' },
    validity: { node: '>=24' },
    authoritySpec: { owner: 'local-user' },
    privacyClass: 'workspace',
    riskAndEffectSpec: { risk: 'local-process' },
    allowedUseModes: ['reference', 'suggest', 'guided'],
    components: [
      component('component-fact', 'revision-fact', 'observed_fact', 'Frontend assets were absent before build.'),
      component('component-build', 'revision-build', 'resolution_candidate', 'Run pnpm build to create the frontend dist artifact.'),
      component('component-old', 'revision-old', 'recovery_verifier', 'Anonymous HTTP 200 proves the Web app is ready.'),
      component('component-current', 'revision-current', 'recovery_verifier', 'Verify authenticated RPC readback after startup.'),
    ],
    componentRevisionIds: ['revision-fact', 'revision-build', 'revision-old', 'revision-current']
      .map(value => brandedId<'ExperienceComponentRevisionId'>(value, 'componentRevisionId')),
    initialAssessmentId: brandedId<'ExperienceAssessmentId'>('assessment-1', 'assessmentId'),
    relationIds: [],
    createdByDecisionId: 'decision-1',
    evidenceGrade: 'observation_supported',
    governanceState: 'accepted',
    operationalState: 'conditional',
    legacyWarnings: [],
    contentDigest: 'sha256:version-1',
    createdAt: now,
  }
}

function factVersion(validUntil: string): ExperienceVersionView {
  const subject = component('component-subject', 'revision-subject', 'subject', 'workspace runtime')
  const predicate = component('component-predicate', 'revision-predicate', 'predicate', 'node version')
  const value = component('component-value', 'revision-value', 'object_or_value', 'v22.23.1')
  return {
    ...version(),
    experienceVersionId: brandedId<'ExperienceVersionId'>('version-fact', 'versionId'),
    experienceId: brandedId<'ExperienceId'>('experience-fact', 'experienceId'),
    kind: 'fact',
    title: 'workspace runtime node version',
    intent: 'Read workspace runtime node version',
    validity: { validFrom: '2026-08-01T00:00:00.000Z', validUntil },
    components: [subject, predicate, value],
    componentRevisionIds: [subject.componentRevisionId, predicate.componentRevisionId, value.componentRevisionId],
  }
}

function component(
  componentId: string,
  revisionId: string,
  role: import('../src/types.js').ComponentRole,
  content: string,
): import('../src/types.js').PublishedComponentView {
  return {
    componentKey: componentId,
    componentId: brandedId<'ExperienceComponentId'>(componentId, 'componentId'),
    componentRevisionId: brandedId<'ExperienceComponentRevisionId'>(revisionId, 'componentRevisionId'),
    evidenceIds: [brandedId<'ExperienceEvidenceId'>(`evidence-${componentId}`, 'evidenceId')],
    role,
    content,
    sourceRefs: ['source-1'],
  }
}

function contribution(
  id: string,
  priority: number,
  overrides: Partial<Pick<PlanContributionView, 'precedes' | 'conflictsWith'>> = {},
): PlanContributionView {
  return {
    contributionId: id,
    experienceVersionId: brandedId<'ExperienceVersionId'>('version-1', 'versionId'),
    componentRevisionId: brandedId<'ExperienceComponentRevisionId'>(`revision-${id}`, 'componentRevisionId'),
    role: 'resolution_candidate',
    content: `Run distinct step ${id}.`,
    contributionType: 'step',
    priority,
    precedes: overrides.precedes ?? [],
    conflictsWith: overrides.conflictsWith ?? [],
    relationIds: [],
  }
}
