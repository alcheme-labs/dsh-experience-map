import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { retrievalFixture, task, planInput, NOW } from './fixtures/retrieval-fixture.js'
import { publishReviewedWorkflow } from './fixtures/published-workflow.js'
import { typedWorkflowDraft, workflowDraft, sourceRef } from './fixtures/workflow.js'
import { TYPE_BEHAVIORS } from '../src/domain/behavior.js'
import { contextSections, materializeContextSnapshot, renderContext } from '../src/domain/context.js'
import { digest } from '../src/domain/planning.js'
import { createExperienceContextMessage } from '../src/adapters/context-message.js'
import { brandedId } from '../src/ids.js'
import type { ExperienceVersionId } from '../src/ids.js'
import type {
  ActorView,
  DeclareExperienceRelationInput,
  ExperienceCandidateDraft,
  ExperienceRelationObjectRef,
  ExperienceRelationType,
  PlanTaskCommandInput,
} from '../src/types.js'
import type { ExperienceRepository } from '../src/persistence/repository.js'

/** Build a diagnostic draft whose component content is seed-specific so versions never dedup. */
function distinctDraft(title: string, seed: string, allowedUseModes?: ExperienceCandidateDraft['allowedUseModes']): ExperienceCandidateDraft {
  const components = TYPE_BEHAVIORS.diagnostic.requiredRoles.map((role, index) => ({
    componentKey: `${role}-${String(index + 1)}`,
    role,
    content: `${seed} ${role} ${seed}-${String(index)} marker`,
    sourceRefs: ['source:test-terminal-event'],
  }))
  return workflowDraft({
    title,
    intent: title,
    components,
    ...(allowedUseModes === undefined ? {} : { allowedUseModes }),
  })
}

function relationInput(
  seed: number,
  relationType: ExperienceRelationType,
  sourceObjectRef: ExperienceRelationObjectRef,
  targetObjectRef: ExperienceRelationObjectRef,
): DeclareExperienceRelationInput {
  return {
    commandId: brandedId<'ExperienceCommandId'>(`opt-b-extra-${String(seed)}`, 'commandId'),
    relationType,
    sourceObjectRef,
    targetObjectRef,
    scope: { workspace: 'deepseek-harness' },
    qualifiers: {},
    validFrom: '2026-09-01T00:00:00.000Z',
    validTo: null,
    evidenceIds: [],
    correlationId: 'opt-b-extra',
    causationId: null,
    issuedAt: NOW,
  }
}

function inputTask(text: string, overrides: Partial<PlanTaskCommandInput['task']> = {}): PlanTaskCommandInput {
  return planInput(randomUUID(), task({ text, requiredCapabilities: [], ...overrides }))
}

async function retireVersion(repository: ExperienceRepository, actor: ActorView, versionId: ExperienceVersionId): Promise<void> {
  const experienceId = repository.getVersion(versionId, actor).experienceId
  const preview = repository.previewForget(experienceId, actor)
  await repository.forgetExperience({
    commandId: brandedId<'ExperienceCommandId'>(randomUUID(), 'commandId'),
    experienceId,
    expectedSeriesRevision: preview.expectedSeriesRevision,
    previewDigest: preview.previewDigest,
    reason: 'owner retired the required dependency',
    correlationId: 'opt-b-extra',
    causationId: null,
    issuedAt: new Date().toISOString(),
  }, actor)
}

describe('OPT-B Host dependency closure (B1/B2)', () => {
  it('H1 retains necessary premises and verification and excludes an unrelated source', async () => {
    const f = await retrievalFixture(1)
    try {
      const source = await publishReviewedWorkflow(f.repository, f.actor, 8191, distinctDraft('certificate expired', 'CERT'))
      const unrelated = await publishReviewedWorkflow(f.repository, f.actor, 8192, distinctDraft('haiku poetry', 'HAIKU'))
      const sourceVersion = source.published.experienceVersionId!
      const unrelatedVersion = unrelated.published.experienceVersionId!
      const result = await f.service.plan(inputTask('certificate expired'), f.actor)
      const plan = f.repository.getPlanningResult(result.planning.plan.usageId, f.actor).plan
      // The matched source keeps necessary premises/constraints/verification (conservative retention).
      expect(plan.premises.length).toBeGreaterThan(0)
      expect(plan.verification.length).toBeGreaterThan(0)
      expect(plan.selectedContributions.some(c => c.experienceVersionId === sourceVersion)).toBe(true)
      // A relevant-only selection never invents an unrelated source.
      expect(plan.selectedContributions.some(c => c.experienceVersionId === unrelatedVersion)).toBe(false)
      expect(plan.blockers).toEqual([])
    } finally { await f.close() }
  })

  it('H2 completes a legal dependency outside top-K and approves it', async () => {
    const f = await retrievalFixture(1)
    try {
      const source = await publishReviewedWorkflow(f.repository, f.actor, 8201, distinctDraft('certificate expired', 'CERT'))
      const target = await publishReviewedWorkflow(f.repository, f.actor, 8202, distinctDraft('molecular trajectory', 'MOL'))
      const sourceVersion = source.published.experienceVersionId!
      const targetVersion = target.published.experienceVersionId!
      await f.repository.declareRelation(relationInput(201, 'requires',
        { kind: 'version', id: sourceVersion }, { kind: 'version', id: targetVersion }), f.actor)

      const result = await f.service.plan(inputTask('certificate expired'), f.actor)
      const plan = f.repository.getPlanningResult(result.planning.plan.usageId, f.actor).plan

      expect(plan.disposition).toBe('ready_for_approval')
      expect(plan.blockers).toEqual([])
      expect(plan.selectedContributions.some(c => c.experienceVersionId === sourceVersion)).toBe(true)
      // The required version was omitted by top-K (limit 1) yet was retrieved and contributed.
      expect(plan.selectedContributions.some(c => c.experienceVersionId === targetVersion)).toBe(true)
      // It is a mandatory dependency: its selected contribution carries the requires relation.
      const required = plan.selectedContributions.find(c => c.experienceVersionId === targetVersion)!
      expect(required.relationIds.length).toBeGreaterThan(0)
      expect(plan.requiresApproval).toBe(true)
    } finally { await f.close() }
  })

  it('H2 blocks an unsatisfiable dependency instead of continuing without it', async () => {
    const f = await retrievalFixture(1)
    try {
      const source = await publishReviewedWorkflow(f.repository, f.actor, 8211, distinctDraft('certificate expired', 'CERT'))
      const target = await publishReviewedWorkflow(f.repository, f.actor, 8212, distinctDraft('molecular trajectory', 'MOL'))
      const sourceVersion = source.published.experienceVersionId!
      const targetVersion = target.published.experienceVersionId!
      await f.repository.declareRelation(relationInput(211, 'requires',
        { kind: 'version', id: sourceVersion }, { kind: 'version', id: targetVersion }), f.actor)
      await retireVersion(f.repository, f.actor, targetVersion)

      const result = await f.service.plan(inputTask('certificate expired'), f.actor)
      const plan = f.repository.getPlanningResult(result.planning.plan.usageId, f.actor).plan
      expect(plan.disposition).toBe('blocked')
      expect(plan.requiresApproval).toBe(false)
      expect(plan.blockers.some(reason => reason.includes('required_dependency'))).toBe(true)
    } finally { await f.close() }
  })

  it('H2 ignores an unsatisfiable dependency whose source component is not retained', async () => {
    const f = await retrievalFixture(1)
    try {
      const base = workflowDraft({
        title: 'build artifact inspection',
        intent: 'inspect the build artifact without starting a local service',
        scope: { product: 'deepseek-harness', exposure: 'local-loopback' },
      })
      const source = await publishReviewedWorkflow(f.repository, f.actor, 8213, {
        ...base,
        components: base.components.map(component => {
          if (component.role === 'resolution_candidate') {
            return { ...component, content: 'Start the local Web service' }
          }
          if (component.role === 'recovery_verifier') {
            return { ...component, content: 'Verify the public build artifact digest' }
          }
          return component
        }),
      })
      const target = await publishReviewedWorkflow(f.repository, f.actor, 8214,
        distinctDraft('molecular trajectory', 'MOL'))
      const sourceVersion = f.repository.getVersion(source.published.experienceVersionId!, f.actor)
      const localAction = sourceVersion.components.find(component => component.role === 'resolution_candidate')!
      const targetVersion = target.published.experienceVersionId!
      await f.repository.declareRelation(relationInput(213, 'requires',
        { kind: 'component', id: localAction.componentId }, { kind: 'version', id: targetVersion }), f.actor)
      await retireVersion(f.repository, f.actor, targetVersion)

      const result = await f.service.plan(inputTask('build artifact inspection', {
        targetExposure: 'public',
      }), f.actor)
      const plan = f.repository.getPlanningResult(result.planning.plan.usageId, f.actor).plan
      expect(plan.selectedContributions.some(contribution =>
        contribution.experienceVersionId === sourceVersion.experienceVersionId)).toBe(true)
      expect(plan.selectedContributions.some(contribution =>
        contribution.componentRevisionId === localAction.componentRevisionId)).toBe(false)
      expect(plan.blockers.some(reason => reason.includes('required_dependency'))).toBe(false)
      expect(plan.disposition).not.toBe('blocked')
    } finally { await f.close() }
  })

  it('H2 does not import a satisfiable dependency whose source component is not retained', async () => {
    const f = await retrievalFixture(1)
    try {
      const base = workflowDraft({
        title: 'build artifact inspection',
        intent: 'inspect the build artifact without starting a local service',
        scope: { product: 'deepseek-harness', exposure: 'local-loopback' },
      })
      const source = await publishReviewedWorkflow(f.repository, f.actor, 8215, {
        ...base,
        components: base.components.map(component => {
          if (component.role === 'resolution_candidate') {
            return { ...component, content: 'Start the local Web service' }
          }
          if (component.role === 'recovery_verifier') {
            return { ...component, content: 'Verify the public build artifact digest' }
          }
          return component
        }),
      })
      const target = await publishReviewedWorkflow(f.repository, f.actor, 8216,
        typedWorkflowDraft('preference_policy', {
          title: 'Molecular rendering preference',
          intent: 'Prefer a molecular trajectory rendering convention.',
        }))
      const sourceVersion = f.repository.getVersion(source.published.experienceVersionId!, f.actor)
      const localAction = sourceVersion.components.find(component => component.role === 'resolution_candidate')!
      const targetVersion = target.published.experienceVersionId!
      await f.repository.declareRelation(relationInput(215, 'requires',
        { kind: 'component', id: localAction.componentId }, { kind: 'version', id: targetVersion }), f.actor)

      const result = await f.service.plan(inputTask('build artifact inspection', {
        targetExposure: 'public',
      }), f.actor)
      const plan = f.repository.getPlanningResult(result.planning.plan.usageId, f.actor).plan
      expect(plan.selectedContributions.some(contribution =>
        contribution.experienceVersionId === sourceVersion.experienceVersionId)).toBe(true)
      expect(plan.selectedContributions.some(contribution =>
        contribution.componentRevisionId === localAction.componentRevisionId)).toBe(false)
      expect(plan.selectedContributions.some(contribution =>
        contribution.experienceVersionId === targetVersion)).toBe(false)
      expect(plan.preferenceEnforcements.map(item => item.experienceVersionId)).not.toContain(targetVersion)
      expect(plan.discardedContributions.some(item =>
        item.reasonCode === 'required_dependency_source_not_retained')).toBe(true)
      expect(result.planning.preflights.some(preflight =>
        preflight.experienceVersionId === targetVersion)).toBe(false)
      expect(plan.blockers.some(reason => reason.includes('required_dependency'))).toBe(false)
    } finally { await f.close() }
  })

  it('H2 promotes an in-window rejected target when a retained source requires it', async () => {
    const f = await retrievalFixture(2)
    try {
      const source = await publishReviewedWorkflow(f.repository, f.actor, 8217,
        distinctDraft('certificate expired kubernetes', 'CERT KUBERNETES'))
      const target = await publishReviewedWorkflow(f.repository, f.actor, 8218,
        typedWorkflowDraft('preference_policy', {
          title: 'Expired response preference',
          intent: 'Prefer a response convention after expiry.',
        }))
      const sourceVersion = source.published.experienceVersionId!
      const targetVersion = target.published.experienceVersionId!
      await f.repository.declareRelation(relationInput(217, 'requires',
        { kind: 'version', id: sourceVersion }, { kind: 'version', id: targetVersion }), f.actor)

      const result = await f.service.plan(inputTask('certificate expired response convention', {
        requiredCapabilities: ['kubernetes'],
      }), f.actor)
      const targetCandidate = result.planning.matchSet.candidates.find(candidate =>
        candidate.experienceVersionId === targetVersion)
      expect(targetCandidate).toMatchObject({ rejected: true, selectedComponentRevisionIds: [] })
      const targetPreflights = result.planning.preflights.filter(preflight =>
        preflight.experienceVersionId === targetVersion)
      expect(targetPreflights).toHaveLength(1)
      expect(targetPreflights[0]!.disposition).not.toBe('blocked')
      expect(targetPreflights[0]!.reasonCodes).toEqual(expect.arrayContaining(['required_dependency']))

      const plan = f.repository.getPlanningResult(result.planning.plan.usageId, f.actor).plan
      expect(plan.disposition).toBe('ready_for_approval')
      expect(plan.blockers).toEqual([])
      expect(plan.selectedContributions.some(contribution =>
        contribution.experienceVersionId === targetVersion)).toBe(true)
      expect(plan.preferenceEnforcements.map(item => item.experienceVersionId)).toContain(targetVersion)
    } finally { await f.close() }
  })

  it('H2 blocks when a required dependency does not allow the requested use mode', async () => {
    const f = await retrievalFixture(1)
    try {
      const source = await publishReviewedWorkflow(f.repository, f.actor, 8221, distinctDraft('certificate expired', 'CERT'))
      const target = await publishReviewedWorkflow(f.repository, f.actor, 8222, distinctDraft('molecular trajectory', 'MOL', ['reference']))
      const sourceVersion = source.published.experienceVersionId!
      const targetVersion = target.published.experienceVersionId!
      await f.repository.declareRelation(relationInput(221, 'requires',
        { kind: 'version', id: sourceVersion }, { kind: 'version', id: targetVersion }), f.actor)

      const result = await f.service.plan(inputTask('certificate expired'), f.actor)
      const plan = f.repository.getPlanningResult(result.planning.plan.usageId, f.actor).plan
      expect(plan.disposition).toBe('blocked')
      expect(plan.blockers.some(reason => reason.includes('required_dependency_use_mode_not_allowed'))).toBe(true)
    } finally { await f.close() }
  })

  it('H3 resolves a transitive A -> B -> C requires closure', async () => {
    const f = await retrievalFixture(1)
    try {
      const a = await publishReviewedWorkflow(f.repository, f.actor, 8231, distinctDraft('certificate expired', 'A'))
      const b = await publishReviewedWorkflow(f.repository, f.actor, 8232, distinctDraft('molecular trajectory', 'B'))
      const c = await publishReviewedWorkflow(f.repository, f.actor, 8233, distinctDraft('monte carlo sampling', 'C'))
      const av = a.published.experienceVersionId!
      const bv = b.published.experienceVersionId!
      const cv = c.published.experienceVersionId!
      await f.repository.declareRelation(relationInput(231, 'requires',
        { kind: 'version', id: av }, { kind: 'version', id: bv }), f.actor)
      await f.repository.declareRelation(relationInput(232, 'requires',
        { kind: 'version', id: bv }, { kind: 'version', id: cv }), f.actor)

      const result = await f.service.plan(inputTask('certificate expired'), f.actor)
      const plan = f.repository.getPlanningResult(result.planning.plan.usageId, f.actor).plan
      expect(plan.disposition).toBe('ready_for_approval')
      expect(plan.selectedContributions.some(c => c.experienceVersionId === av)).toBe(true)
      expect(plan.selectedContributions.some(c => c.experienceVersionId === bv)).toBe(true)
      expect(plan.selectedContributions.some(c => c.experienceVersionId === cv)).toBe(true)
    } finally { await f.close() }
  })

  it('H3 resolves a component-endpoint requires to its exact current version', async () => {
    const f = await retrievalFixture(1)
    try {
      const source = await publishReviewedWorkflow(f.repository, f.actor, 8241, distinctDraft('certificate expired', 'CERT'))
      const target = await publishReviewedWorkflow(f.repository, f.actor, 8242, distinctDraft('molecular trajectory', 'MOL'))
      const sourceVersion = f.repository.getVersion(source.published.experienceVersionId!, f.actor)
      const targetVersion = f.repository.getVersion(target.published.experienceVersionId!, f.actor)
      const targetComponent = targetVersion.components[0]!
      await f.repository.declareRelation(relationInput(241, 'requires',
        { kind: 'version', id: sourceVersion.experienceVersionId },
        { kind: 'component', id: targetComponent.componentId }), f.actor)

      const result = await f.service.plan(inputTask('certificate expired'), f.actor)
      const plan = f.repository.getPlanningResult(result.planning.plan.usageId, f.actor).plan
      expect(plan.disposition).toBe('ready_for_approval')
      expect(plan.selectedContributions.some(c => c.experienceVersionId === targetVersion.experienceVersionId)).toBe(true)
    } finally { await f.close() }
  })

  it('H3 blocks a required component that has no current active version', async () => {
    const f = await retrievalFixture(1)
    try {
      const source = await publishReviewedWorkflow(f.repository, f.actor, 8251, distinctDraft('certificate expired', 'CERT'))
      const target = await publishReviewedWorkflow(f.repository, f.actor, 8252, distinctDraft('molecular trajectory', 'MOL'))
      const targetVersion = f.repository.getVersion(target.published.experienceVersionId!, f.actor)
      const targetComponent = targetVersion.components[0]!
      await f.repository.declareRelation(relationInput(251, 'requires',
        { kind: 'version', id: source.published.experienceVersionId! },
        { kind: 'component', id: targetComponent.componentId }), f.actor)
      await retireVersion(f.repository, f.actor, targetVersion.experienceVersionId)

      const result = await f.service.plan(inputTask('certificate expired'), f.actor)
      const plan = f.repository.getPlanningResult(result.planning.plan.usageId, f.actor).plan
      expect(plan.disposition).toBe('blocked')
      expect(plan.blockers.some(reason => reason.includes('required_dependency'))).toBe(true)
    } finally { await f.close() }
  })

  it('H4 processes a conflict unrelated to a required dependency and keeps the dependency', async () => {
    const f = await retrievalFixture(2)
    try {
      const source = await publishReviewedWorkflow(f.repository, f.actor, 8261, distinctDraft('certificate expired', 'CERT'))
      const target = await publishReviewedWorkflow(f.repository, f.actor, 8262, distinctDraft('molecular trajectory', 'MOL'))
      const distractor = await publishReviewedWorkflow(f.repository, f.actor, 8263, distinctDraft('certificate expiry log', 'LOG'))
      const sv = f.repository.getVersion(source.published.experienceVersionId!, f.actor)
      const tv = f.repository.getVersion(target.published.experienceVersionId!, f.actor)
      const dv = f.repository.getVersion(distractor.published.experienceVersionId!, f.actor)
      await f.repository.declareRelation(relationInput(261, 'requires',
        { kind: 'version', id: sv.experienceVersionId }, { kind: 'version', id: tv.experienceVersionId }), f.actor)
      // A legal conflict strictly between two matched contributions, not touching the dependency.
      const sourceComponent = sv.components[0]!
      const distractorComponent = dv.components[0]!
      await f.repository.declareRelation(relationInput(262, 'conflicts_with',
        { kind: 'component', id: sourceComponent.componentId },
        { kind: 'component', id: distractorComponent.componentId }), f.actor)

      const result = await f.service.plan(inputTask('certificate expired'), f.actor)
      const plan = f.repository.getPlanningResult(result.planning.plan.usageId, f.actor).plan
      // The unrelated conflict is resolved normally without disturbing the required dependency.
      expect(plan.disposition).toBe('ready_for_approval')
      expect(plan.blockers).toEqual([])
      expect(plan.selectedContributions.some(c => c.experienceVersionId === tv.experienceVersionId)).toBe(true)
    } finally { await f.close() }
  })

  it('H4 blocks a required dependency that loses a conflict instead of silently dropping it', async () => {
    const f = await retrievalFixture(2)
    try {
      const source = await publishReviewedWorkflow(f.repository, f.actor, 8271, distinctDraft('certificate expired', 'CERT'))
      const target = await publishReviewedWorkflow(f.repository, f.actor, 8272, distinctDraft('molecular trajectory', 'MOL'))
      const higher = await publishReviewedWorkflow(f.repository, f.actor, 8273, distinctDraft('certificate expired detailed', 'HIGH'))
      const sv = f.repository.getVersion(source.published.experienceVersionId!, f.actor)
      const tv = f.repository.getVersion(target.published.experienceVersionId!, f.actor)
      const hv = f.repository.getVersion(higher.published.experienceVersionId!, f.actor)
      await f.repository.declareRelation(relationInput(271, 'requires',
        { kind: 'version', id: sv.experienceVersionId }, { kind: 'version', id: tv.experienceVersionId }), f.actor)
      await f.repository.declareRelation(relationInput(272, 'conflicts_with',
        { kind: 'version', id: hv.experienceVersionId }, { kind: 'version', id: tv.experienceVersionId }), f.actor)

      const result = await f.service.plan(inputTask('certificate expired'), f.actor)
      const plan = f.repository.getPlanningResult(result.planning.plan.usageId, f.actor).plan
      // The required dependency loses the conflict to a higher-fit contribution and is not a
      // same-dependency substitute, so the closure is broken and the Plan must block.
      expect(plan.selectedContributions.some(c => c.experienceVersionId === sv.experienceVersionId)).toBe(true)
      expect(plan.selectedContributions.some(c => c.experienceVersionId === tv.experienceVersionId)).toBe(false)
      expect(plan.disposition).toBe('blocked')
      expect(plan.blockers).toContain('required_dependency_eliminated')
    } finally { await f.close() }
  })

  it('H5 renders approved Context exactly from selected and ordered dependency content', async () => {
    const f = await retrievalFixture(1)
    try {
      const source = await publishReviewedWorkflow(f.repository, f.actor, 8281, distinctDraft('certificate expired', 'CERT'))
      const target = await publishReviewedWorkflow(f.repository, f.actor, 8282, distinctDraft('molecular trajectory', 'MOL'))
      const sv = f.repository.getVersion(source.published.experienceVersionId!, f.actor)
      const tv = f.repository.getVersion(target.published.experienceVersionId!, f.actor)
      await f.repository.declareRelation(relationInput(281, 'requires',
        { kind: 'version', id: sv.experienceVersionId }, { kind: 'version', id: tv.experienceVersionId }), f.actor)
      const result = await f.service.plan(inputTask('certificate expired', { targetExposure: 'local' }), f.actor)
      const request = result.planning.approvalRequest!
      const approved = await f.repository.decidePlan({
        commandId: brandedId<'ExperienceCommandId'>(randomUUID(), 'commandId'),
        requestId: request.requestId,
        usagePlanId: request.usagePlanId,
        expectedPlanRevision: request.planRevision,
        decision: 'approve',
        reason: 'approved exact dependency plan',
        correlationId: 'opt-b-extra',
        causationId: result.receipt.receiptId,
        issuedAt: new Date().toISOString(),
      }, f.actor)
      const planning = approved.planning
      const sections = contextSections(planning)
      const content = renderContext(sections)

      const selected = new Set(planning.plan.selectedContributions.map(c => c.content))
      const mandatorySteps = planning.plan.orderedSteps.map(step => step.content)
      const verification = planning.plan.verification
      expect(planning.plan.selectedContributions.some(c => c.experienceVersionId === tv.experienceVersionId)).toBe(true)
      // Every ordered step is drawn from the actual selected contributions (exact delivery).
      expect(mandatorySteps.every(step => selected.has(step))).toBe(true)
      // The mandatory dependency content and verification obligations are present in Context.
      const targetContents = planning.plan.selectedContributions
        .filter(c => c.experienceVersionId === tv.experienceVersionId).map(c => c.content)
      for (const text of targetContents) expect(content).toContain(text)
      expect(content).toContain('验收与权威读回')
      expect(verification.length).toBeGreaterThan(0)
    } finally { await f.close() }
  })

  it('H5 rejects an approval that does not name the exact current dependency plan revision', async () => {
    const f = await retrievalFixture(1)
    try {
      const source = await publishReviewedWorkflow(f.repository, f.actor, 8291, distinctDraft('certificate expired', 'CERT'))
      const target = await publishReviewedWorkflow(f.repository, f.actor, 8292, distinctDraft('molecular trajectory', 'MOL'))
      const sv = f.repository.getVersion(source.published.experienceVersionId!, f.actor)
      const tv = f.repository.getVersion(target.published.experienceVersionId!, f.actor)
      await f.repository.declareRelation(relationInput(291, 'requires',
        { kind: 'version', id: sv.experienceVersionId }, { kind: 'version', id: tv.experienceVersionId }), f.actor)
      const result = await f.service.plan(inputTask('certificate expired'), f.actor)
      const request = result.planning.approvalRequest!
      // A stale plan revision must be rejected.
      await expect(f.repository.decidePlan({
        commandId: brandedId<'ExperienceCommandId'>(randomUUID(), 'commandId'),
        requestId: request.requestId,
        usagePlanId: request.usagePlanId,
        expectedPlanRevision: request.planRevision + 1,
        decision: 'approve',
        reason: 'wrong revision',
        correlationId: 'opt-b-extra',
        causationId: null,
        issuedAt: new Date().toISOString(),
      }, f.actor)).rejects.toMatchObject({ code: 'stale_revision' })
    } finally { await f.close() }
  })

  it('H6 keeps mandatory verification content (no hard truncation) and is deterministic', async () => {
    const f = await retrievalFixture(1)
    try {
      const source = await publishReviewedWorkflow(f.repository, f.actor, 8301, distinctDraft('certificate expired', 'CERT'))
      const target = await publishReviewedWorkflow(f.repository, f.actor, 8302, distinctDraft('molecular trajectory', 'MOL'))
      const sv = f.repository.getVersion(source.published.experienceVersionId!, f.actor)
      const tv = f.repository.getVersion(target.published.experienceVersionId!, f.actor)
      await f.repository.declareRelation(relationInput(301, 'requires',
        { kind: 'version', id: sv.experienceVersionId }, { kind: 'version', id: tv.experienceVersionId }), f.actor)

      const first = await f.service.plan(inputTask('certificate expired'), f.actor)
      const second = await f.service.plan(inputTask('certificate expired'), f.actor)
      const firstPlan = f.repository.getPlanningResult(first.planning.plan.usageId, f.actor).plan
      const secondPlan = f.repository.getPlanningResult(second.planning.plan.usageId, f.actor).plan
      expect(firstPlan.contentDigest).toBe(secondPlan.contentDigest)
      expect(firstPlan.orderedSteps).toEqual(secondPlan.orderedSteps)
      // No verifier/verification component is hard-truncated by the composition.
      const sourceVerification = firstPlan.selectedContributions.filter(c => c.contributionType === 'verification')
      expect(sourceVerification.length).toBeGreaterThan(0)
      expect(firstPlan.verification.length).toBe(firstPlan.selectedContributions
        .filter(c => c.contributionType === 'verification').length)
    } finally { await f.close() }
  })
})

/** A diagnostic with two independent resolution_candidate actions plus necessary premise/verification. */
function h1Draft(): ExperienceCandidateDraft {
  const base = workflowDraft({ title: 'build artifact inspection', intent: 'build artifact inspection' })
  const components = base.components.map(component => component.role === 'resolution_candidate'
    ? { ...component, content: 'Inspect existing build artifacts without starting services' }
    : component)
  components.push({
    componentKey: 'optional-start',
    role: 'resolution_candidate',
    content: 'Start local Web service',
    sourceRefs: [sourceRef.sourceRefId],
  })
  return {
    ...base,
    components,
    fieldSourceRefs: { ...base.fieldSourceRefs, 'component:optional-start': [sourceRef.sourceRefId] },
  }
}

function h1RelationBase(
  seed: number,
  anchorComponentId: string,
  anchorRevision: string,
  optionalComponentId: string,
  optionalRevision: string,
  taskInputDigest: string,
): DeclareExperienceRelationInput {
  return {
    commandId: brandedId<'ExperienceCommandId'>(`opt-b-h1-${String(seed)}`, 'commandId'),
    relationType: 'composes_with',
    sourceObjectRef: { kind: 'component', id: anchorComponentId },
    targetObjectRef: { kind: 'component', id: optionalComponentId },
    scope: { taskInputDigest },
    qualifiers: {
      selectionPolicy: 'explicit_optional_component',
      anchorComponentRevisionId: anchorRevision,
      optionalComponentRevisionId: optionalRevision,
      independenceReason: 'Owner reviewed that artifact inspection has no startup dependency',
    },
    validFrom: '2026-09-02T00:00:00.000Z',
    validTo: null,
    evidenceIds: [],
    correlationId: 'opt-b-h1',
    causationId: null,
    issuedAt: NOW,
  }
}

describe('OPT-B Host rework (H-R1/R2/R3 + H1 explicit optional policy)', () => {
  it('H-R1 blocks a required target rejected inside the existing candidate set', async () => {
    const f = await retrievalFixture(10)
    try {
      const a = await publishReviewedWorkflow(f.repository, f.actor, 9501, distinctDraft('certificate expired', 'SOURCE'))
      const b = await publishReviewedWorkflow(f.repository, f.actor, 9502, distinctDraft('certificate expired', 'TARGET', ['suggest']))
      await f.repository.declareRelation(relationInput(9501, 'requires',
        { kind: 'version', id: a.published.experienceVersionId! },
        { kind: 'version', id: b.published.experienceVersionId! }), f.actor)
      const r = await f.service.plan(inputTask('certificate expired'), f.actor)
      const p = f.repository.getPlanningResult(r.planning.plan.usageId, f.actor)
      expect(p.matchSet.candidates.some(x => x.experienceVersionId === b.published.experienceVersionId && x.rejected)).toBe(true)
      expect(p.plan.selectedContributions.some(x => x.experienceVersionId === a.published.experienceVersionId)).toBe(true)
      expect(p.plan.disposition).toBe('blocked')
      expect(p.plan.blockers.some(reason => reason.includes('required_dependency'))).toBe(true)
    } finally { await f.close() }
  })

  it('H-R2 rechecks required targets already matched after conflict elimination', async () => {
    const f = await retrievalFixture(10)
    try {
      for (let i = 0; i < 3; i++) {
        await publishReviewedWorkflow(f.repository, f.actor, 9520 + i, distinctDraft('certificate expired', `UNIQUE${String(i)}`))
      }
      const before = await f.service.plan(inputTask('certificate expired'), f.actor)
      const ids = before.planning.matchSet.candidates.map(x => x.experienceVersionId)
      expect(ids).toHaveLength(3)
      const [winner, source, target] = ids as unknown as [string, string, string]
      await f.repository.declareRelation(relationInput(9521, 'requires',
        { kind: 'version', id: source }, { kind: 'version', id: target }), f.actor)
      await f.repository.declareRelation(relationInput(9522, 'conflicts_with',
        { kind: 'version', id: winner }, { kind: 'version', id: target }), f.actor)
      const r = await f.service.plan(inputTask('certificate expired'), f.actor)
      const p = f.repository.getPlanningResult(r.planning.plan.usageId, f.actor).plan
      expect(p.selectedContributions.some(x => x.experienceVersionId === source)).toBe(true)
      expect(p.selectedContributions.some(x => x.experienceVersionId === target)).toBe(false)
      expect(p.disposition).toBe('blocked')
      expect(p.blockers).toContain('required_dependency_eliminated')
    } finally { await f.close() }
  })

  it('H-R3 persists every dependency preflight named by the Plan', async () => {
    const f = await retrievalFixture(1)
    try {
      const a = await publishReviewedWorkflow(f.repository, f.actor, 9511, distinctDraft('certificate expired', 'SOURCE'))
      const b = await publishReviewedWorkflow(f.repository, f.actor, 9512, distinctDraft('molecular trajectory', 'TARGET'))
      await f.repository.declareRelation(relationInput(9511, 'requires',
        { kind: 'version', id: a.published.experienceVersionId! },
        { kind: 'version', id: b.published.experienceVersionId! }), f.actor)
      const r = await f.service.plan(inputTask('certificate expired'), f.actor)
      const p = f.repository.getPlanningResult(r.planning.plan.usageId, f.actor)
      expect(p.plan.disposition).toBe('ready_for_approval')
      expect(p.plan.preflightIds.filter(id => !p.preflights.some(x => x.preflightId === id))).toEqual([])
    } finally { await f.close() }
  })

  it('H1 prunes an explicitly optional same-version action for the exact task only', async () => {
    const f = await retrievalFixture(5)
    try {
      const pub = await publishReviewedWorkflow(f.repository, f.actor, 9701, h1Draft())
      const version = f.repository.getVersion(pub.published.experienceVersionId!, f.actor)
      const anchor = version.components.find(c => c.role === 'resolution_candidate' && c.componentKey !== 'optional-start')!
      const optional = version.components.find(c => c.componentKey === 'optional-start')!
      const t = task({ text: 'Only inspect build artifacts', requiredCapabilities: [] })
      const before = (await f.service.plan(planInput(randomUUID(), t), f.actor)).planning
      expect(before.plan.selectedContributions.some(c => c.componentRevisionId === optional.componentRevisionId)).toBe(true)
      await f.repository.declareRelation(h1RelationBase(9701,
        anchor.componentId, String(anchor.componentRevisionId), optional.componentId, String(optional.componentRevisionId),
        before.fingerprint.taskInputDigest), f.actor)
      const after = (await f.service.plan(planInput(randomUUID(), t), f.actor)).planning
      const read = f.repository.getPlanningResult(after.plan.usageId, f.actor)
      expect(read.plan.selectedContributions.some(c => c.componentRevisionId === anchor.componentRevisionId)).toBe(true)
      expect(read.plan.selectedContributions.some(c => c.componentRevisionId === optional.componentRevisionId)).toBe(false)
      expect(read.plan.discardedContributions.some(c => c.contributionId === String(optional.componentRevisionId))).toBe(true)
      expect(read.plan.verification).toEqual(before.plan.verification)
      expect(read.plan.premises).toEqual(before.plan.premises)
      const other = (await f.service.plan(planInput(randomUUID(), { ...t, text: 'Inspect build artifacts and start Web' }), f.actor)).planning
      expect(other.plan.selectedContributions.some(c => c.componentRevisionId === optional.componentRevisionId)).toBe(true)
    } finally { await f.close() }
  })

  it('H1 does not prune without a valid declaration, across task digest, or after expiry', async () => {
    const f = await retrievalFixture(5)
    try {
      const pub = await publishReviewedWorkflow(f.repository, f.actor, 9702, h1Draft())
      const version = f.repository.getVersion(pub.published.experienceVersionId!, f.actor)
      const anchor = version.components.find(c => c.role === 'resolution_candidate' && c.componentKey !== 'optional-start')!
      const optional = version.components.find(c => c.componentKey === 'optional-start')!
      const t = task({ text: 'Only inspect build artifacts', requiredCapabilities: [] })
      // No declaration: optional is retained.
      const noDeclaration = (await f.service.plan(planInput(randomUUID(), t), f.actor)).planning
      expect(noDeclaration.plan.selectedContributions.some(c => c.componentRevisionId === optional.componentRevisionId)).toBe(true)
      // A declaration scoped to a different taskInputDigest: accepted at write, no pruning.
      const wrongDigest = h1RelationBase(9712,
        anchor.componentId, String(anchor.componentRevisionId), optional.componentId, String(optional.componentRevisionId),
        `sha256:${'9'.repeat(64)}`)
      await f.repository.declareRelation(wrongDigest, f.actor)
      const afterWrongDigest = (await f.service.plan(planInput(randomUUID(), t), f.actor)).planning
      expect(afterWrongDigest.plan.selectedContributions.some(c => c.componentRevisionId === optional.componentRevisionId)).toBe(true)
      // An expired declaration: no pruning.
      const expired = { ...h1RelationBase(9713,
        anchor.componentId, String(anchor.componentRevisionId), optional.componentId, String(optional.componentRevisionId),
        noDeclaration.fingerprint.taskInputDigest), validFrom: '2020-09-01T00:00:00.000Z', validTo: '2020-09-02T00:00:00.000Z' }
      await f.repository.declareRelation(expired, f.actor)
      const afterExpired = (await f.service.plan(planInput(randomUUID(), t), f.actor)).planning
      expect(afterExpired.plan.selectedContributions.some(c => c.componentRevisionId === optional.componentRevisionId)).toBe(true)
    } finally { await f.close() }
  })

  it('H1 rejects a wrong-revision and an illegal verifier explicit-optional declaration at the write entry', async () => {
    const f = await retrievalFixture(5)
    try {
      const pub = await publishReviewedWorkflow(f.repository, f.actor, 9703, h1Draft())
      const version = f.repository.getVersion(pub.published.experienceVersionId!, f.actor)
      const anchor = version.components.find(c => c.role === 'resolution_candidate' && c.componentKey !== 'optional-start')!
      const optional = version.components.find(c => c.componentKey === 'optional-start')!
      const verifier = version.components.find(c => c.role === 'recovery_verifier')!
      const digest = `sha256:${'a'.repeat(64)}`
      // Wrong optional revision must be rejected (does not match the component endpoint).
      await expect(f.repository.declareRelation(h1RelationBase(9703,
        anchor.componentId, String(anchor.componentRevisionId), optional.componentId, `sha256:${'0'.repeat(64)}`, digest), f.actor))
        .rejects.toMatchObject({ code: 'invalid_command' })
      // A verifier (non-step/resolution_candidate) must not be declared optional.
      await expect(f.repository.declareRelation(h1RelationBase(9703,
        anchor.componentId, String(anchor.componentRevisionId), verifier.componentId, String(verifier.componentRevisionId), digest), f.actor))
        .rejects.toMatchObject({ code: 'invalid_command' })
    } finally { await f.close() }
  })

  it('H1 keeps a required dependency even when it was also declared optional (dependency wins)', async () => {
    const f = await retrievalFixture(5)
    try {
      const a = await publishReviewedWorkflow(f.repository, f.actor, 9704, distinctDraft('certificate expired', 'CERT'))
      const b = await publishReviewedWorkflow(f.repository, f.actor, 9705, h1Draft())
      const source = f.repository.getVersion(a.published.experienceVersionId!, f.actor)
      const target = f.repository.getVersion(b.published.experienceVersionId!, f.actor)
      const anchor = target.components.find(c => c.role === 'resolution_candidate' && c.componentKey !== 'optional-start')!
      const optional = target.components.find(c => c.componentKey === 'optional-start')!
      const t = task({ text: 'certificate expired', requiredCapabilities: [] })
      const before = (await f.service.plan(planInput(randomUUID(), t), f.actor)).planning
      await f.repository.declareRelation(relationInput(9704, 'requires',
        { kind: 'version', id: source.experienceVersionId }, { kind: 'version', id: target.experienceVersionId }), f.actor)
      await f.repository.declareRelation(h1RelationBase(9705,
        anchor.componentId, String(anchor.componentRevisionId), optional.componentId, String(optional.componentRevisionId),
        before.fingerprint.taskInputDigest), f.actor)
      const after = (await f.service.plan(planInput(randomUUID(), t), f.actor)).planning
      // The required dependency target version is fetched; its content is retained even though
      // it also carries an optional declaration, because the requires obligation takes priority.
      const read = f.repository.getPlanningResult(after.plan.usageId, f.actor)
      expect(read.plan.selectedContributions.some(c => c.experienceVersionId === source.experienceVersionId)).toBe(true)
      expect(read.plan.selectedContributions.some(c => c.experienceVersionId === target.experienceVersionId)).toBe(true)
      expect(read.plan.disposition).toBe('ready_for_approval')
    } finally { await f.close() }
  })

  it('H1-S accepts reversed symmetric complicates_with endpoints with exact named revisions', async () => {
    const f = await retrievalFixture(5)
    try {
      const pub = await publishReviewedWorkflow(f.repository, f.actor, 9710, h1Draft())
      const version = f.repository.getVersion(pub.published.experienceVersionId!, f.actor)
      const anchor = version.components.find(c => c.role === 'resolution_candidate' && c.componentKey !== 'optional-start')!
      const optional = version.components.find(c => c.componentKey === 'optional-start')!
      const t = task({ text: 'Only inspect build artifacts', requiredCapabilities: [] })
      const before = (await f.service.plan(planInput(randomUUID(), t), f.actor)).planning
      expect(before.plan.selectedContributions.some(c => c.componentRevisionId === optional.componentRevisionId)).toBe(true)
      // Source/target are swapped but the anchor/optional qualifiers name the exact revisions.
      const reversed = { ...h1RelationBase(9710,
        anchor.componentId, String(anchor.componentRevisionId), optional.componentId, String(optional.componentRevisionId),
        before.fingerprint.taskInputDigest), sourceObjectRef: { kind: 'component' as const, id: optional.componentId },
        targetObjectRef: { kind: 'component' as const, id: anchor.componentId } }
      await f.repository.declareRelation(reversed, f.actor)
      const after = (await f.service.plan(planInput(randomUUID(), t), f.actor)).planning
      const read = f.repository.getPlanningResult(after.plan.usageId, f.actor)
      expect(read.plan.selectedContributions.some(c => c.componentRevisionId === anchor.componentRevisionId)).toBe(true)
      expect(read.plan.selectedContributions.some(c => c.componentRevisionId === optional.componentRevisionId)).toBe(false)
      expect(read.plan.discardedContributions.some(c => c.contributionId === String(optional.componentRevisionId))).toBe(true)
      expect(read.plan.verification).toEqual(before.plan.verification)
      expect(read.plan.premises).toEqual(before.plan.premises)
    } finally { await f.close() }
  })

  it('H1-O retains the optional action when a precedes ordering dependency is unresolved', async () => {
    const f = await retrievalFixture(5)
    try {
      const pub = await publishReviewedWorkflow(f.repository, f.actor, 9711, h1Draft())
      const version = f.repository.getVersion(pub.published.experienceVersionId!, f.actor)
      const anchor = version.components.find(c => c.role === 'resolution_candidate' && c.componentKey !== 'optional-start')!
      const optional = version.components.find(c => c.componentKey === 'optional-start')!
      const t = task({ text: 'Only inspect build artifacts', requiredCapabilities: [] })
      const before = (await f.service.plan(planInput(randomUUID(), t), f.actor)).planning
      expect(before.plan.selectedContributions.some(c => c.componentRevisionId === optional.componentRevisionId)).toBe(true)
      await f.repository.declareRelation(h1RelationBase(9711,
        anchor.componentId, String(anchor.componentRevisionId), optional.componentId, String(optional.componentRevisionId),
        before.fingerprint.taskInputDigest), f.actor)
      await f.repository.declareRelation({
        commandId: brandedId<'ExperienceCommandId'>('opt-b-h1-order', 'commandId'),
        relationType: 'precedes',
        sourceObjectRef: { kind: 'component', id: optional.componentId },
        targetObjectRef: { kind: 'component', id: anchor.componentId },
        scope: { taskInputDigest: before.fingerprint.taskInputDigest },
        qualifiers: {},
        validFrom: '2026-09-01T00:00:00.000Z',
        validTo: null,
        evidenceIds: [],
        correlationId: 'opt-b-h1',
        causationId: null,
        issuedAt: NOW,
      }, f.actor)
      const after = (await f.service.plan(planInput(randomUUID(), t), f.actor)).planning
      const read = f.repository.getPlanningResult(after.plan.usageId, f.actor)
      // The optional action's order/check dependency is unresolved, so it is conservatively retained.
      expect(read.plan.selectedContributions.some(c => c.componentRevisionId === anchor.componentRevisionId)).toBe(true)
      expect(read.plan.selectedContributions.some(c => c.componentRevisionId === optional.componentRevisionId)).toBe(true)
      expect(read.plan.discardedContributions.some(c => c.contributionId === String(optional.componentRevisionId))).toBe(false)
      expect(read.plan.verification).toEqual(before.plan.verification)
      expect(read.plan.premises).toEqual(before.plan.premises)
    } finally { await f.close() }
  })

  it('H1 approved Context readback (real Session consumer) excludes the optional and stays consistent', async () => {
    const f = await retrievalFixture(5)
    try {
      const pub = await publishReviewedWorkflow(f.repository, f.actor, 9712, h1Draft())
      const version = f.repository.getVersion(pub.published.experienceVersionId!, f.actor)
      const anchor = version.components.find(c => c.role === 'resolution_candidate' && c.componentKey !== 'optional-start')!
      const optional = version.components.find(c => c.componentKey === 'optional-start')!
      const t = task({ text: 'Only inspect build artifacts', requiredCapabilities: [], targetExposure: 'local' })
      const before = (await f.service.plan(planInput(randomUUID(), t), f.actor)).planning
      await f.repository.declareRelation(h1RelationBase(9712,
        anchor.componentId, String(anchor.componentRevisionId), optional.componentId, String(optional.componentRevisionId),
        before.fingerprint.taskInputDigest), f.actor)
      const after = await f.service.plan(planInput(randomUUID(), t), f.actor)
      const request = after.planning.approvalRequest!
      const approved = await f.repository.decidePlan({
        commandId: brandedId<'ExperienceCommandId'>(randomUUID(), 'commandId'),
        requestId: request.requestId,
        usagePlanId: request.usagePlanId,
        expectedPlanRevision: request.planRevision,
        decision: 'approve',
        reason: 'approved explicit-optional H1 plan',
        correlationId: 'opt-b-h1',
        causationId: after.receipt.receiptId,
        issuedAt: new Date().toISOString(),
      }, f.actor)
      // Authority readback of the approved Plan.
      const read = f.repository.getPlanningResult(approved.planning.plan.usageId, f.actor)
      expect(read.plan.selectedContributions.some(c => c.componentRevisionId === anchor.componentRevisionId)).toBe(true)
      expect(read.plan.selectedContributions.some(c => c.componentRevisionId === optional.componentRevisionId)).toBe(false)
      // Materialize the Context exactly like the Session consumer (the actual appended message).
      const sections = contextSections(approved.planning)
      const content = renderContext(sections)
      const contextSnapshotId = brandedId<'ExperienceContextSnapshotId'>(randomUUID(), 'contextSnapshotId')
      const contextDeliveryId = brandedId<'ExperienceContextDeliveryId'>(randomUUID(), 'contextDeliveryId')
      const message = createExperienceContextMessage(content, {
        usageId: approved.planning.plan.usageId,
        contextSnapshotId,
        contentDigest: digest(content),
        sections,
      }, contextDeliveryId)
      const snapshot = materializeContextSnapshot(
        approved.planning, sections, contextSnapshotId, String(message.id), new Date().toISOString())
      // The delivered Context message excludes the optional action and keeps necessary obligations.
      expect(message.content.some(block => block.type === 'text' && block.text.includes('Start local Web service'))).toBe(false)
      expect(message.content.some(block => block.type === 'text' && block.text.includes('Inspect existing build artifacts without starting services'))).toBe(true)
      expect(content).toContain('验收与权威读回')
      expect(content).toContain('已确认前提')
      // The immutable snapshot digest matches the delivered content and is authority-consistent.
      expect(snapshot.contentDigest).toBe(digest(content))
      expect(snapshot.planRevision).toBe(read.plan.planRevision)
      expect(snapshot.usagePlanId).toBe(read.plan.usagePlanId)
    } finally { await f.close() }
  })
})
