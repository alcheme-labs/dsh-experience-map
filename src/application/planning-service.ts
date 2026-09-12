import { randomUUID } from 'node:crypto'
import type { TaskFingerprintLlm } from '../adapters/task-fingerprint-llm.js'
import type { PlanInteractionAnswer, PlanReviewInteraction } from '../adapters/plan-interaction.js'
import type { PlanningObservationRegistry } from '../adapters/observations.js'
import {
  applyExplicitOptionalSelection,
  composeUsagePlan,
  contributionsFor,
  endpointContributionIds,
  fingerprintTask,
  planDependency,
  preflightMatch,
  applyPlanningRelations,
  usageScopeDigest,
  type PlanningPolicy,
} from '../domain/planning.js'
import { brandedId } from '../ids.js'
import { assertInlineValue } from './content-policy.js'
import { ExperienceError } from '../errors.js'
import type { ExperienceRepository } from '../persistence/repository.js'
import type {
  ActorView,
  AdmissionAttemptView,
  DecidePlanCommandInput,
  ExperienceVersionView,
  PlanApprovalRequestView,
  PlanContributionView,
  PlanTaskCommandInput,
  PlanningCommandResult,
  PlanningResultView,
  PreflightRecordView,
  HistoryRankingApplyTicket,
} from '../types.js'
import type { RuntimeSettingsSnapshot } from '../runtime-settings.js'
import type { HybridRetrievalOperation } from '../domain/hybrid-retrieval.js'

export interface RecallPreparationPort {
  prepare(
    fingerprint: import('../types.js').TaskFingerprintView,
    runtime: RuntimeSettingsSnapshot,
    recallDecisionKey: string | null,
    signal?: AbortSignal,
  ): Promise<HybridRetrievalOperation>
}

/** Coordinates the M3 capability while leaving generic I/O and interaction with Harness. */
export class ExperiencePlanningService {
  /** Bind one canonical repository, observation registry, optional proposer, and standard interaction. */
  constructor(
    private readonly repository: ExperienceRepository,
    private readonly observations: PlanningObservationRegistry,
    private readonly interaction: PlanReviewInteraction,
    private readonly policy: PlanningPolicy,
    private readonly fingerprintProposalMode: 'deterministic' | 'model',
    private readonly fingerprintLlm?: TaskFingerprintLlm,
    private readonly recall?: RecallPreparationPort,
  ) {}

  /** Create one durable exact plan, then optionally ask the current root Agent to decide it. */
  async plan(
    input: PlanTaskCommandInput,
    actor: ActorView,
    signal?: AbortSignal,
    runtime?: RuntimeSettingsSnapshot,
    recallDecisionKey: string | null = null,
  ): Promise<PlanningCommandResult> {
    const policy = runtime === undefined ? this.policy : {
      retrievalCandidateLimit: runtime.values.retrievalCandidateLimit,
      observationFreshnessMs: runtime.values.observationFreshnessMs,
      planApprovalTtlMs: runtime.values.planApprovalTtlMs,
      maxPlanningTaskBytes: runtime.values.maxPlanningTaskBytes,
    }
    assertInlineValue(input.task, policy.maxPlanningTaskBytes, 'Planning task')
    if (this.fingerprintProposalMode === 'model' && !input.confirmExternalModelProcessing) {
      throw new ExperienceError(
        'sensitive_content_unauthorized',
        'model TaskFingerprint proposal requires explicit confirmation of the disclosed route and task input',
      )
    }
    const now = new Date().toISOString()
    const proposal = this.fingerprintProposalMode === 'model'
      ? await this.requiredFingerprintLlm().propose(input.task, signal, runtime === undefined ? undefined : {
          provider: runtime.values.provider,
          model: runtime.values.model,
          maxTokens: runtime.values.taskFingerprintMaxTokens,
        })
      : {}
    assertInlineValue(proposal, policy.maxPlanningTaskBytes, 'TaskFingerprint proposal')
    const fingerprint = fingerprintTask(input.task, actor, now, proposal)
    const retrieval = this.recall === undefined || runtime === undefined
      ? undefined
      : await this.recall.prepare(fingerprint, runtime, recallDecisionKey, signal)
    const matched = this.repository.matchPlanningVersions(
      actor,
      fingerprint,
      policy.retrievalCandidateLimit,
      now,
      input.task,
      retrieval,
    )
    const matchSet = recallDecisionKey === null || matched.matchSet.recallDecisionKey !== undefined
      ? matched.matchSet : { ...matched.matchSet, recallDecisionKey }
    const versions = matched.versions
    const currentObservations = await this.observations.observe(input.task, signal, policy.observationFreshnessMs)
    const validUntil = new Date(Date.parse(now) + policy.observationFreshnessMs).toISOString()
    let preflights: readonly PreflightRecordView[] = matchSet.candidates.flatMap(candidate => {
      const version = versions.find(item => item.experienceVersionId === candidate.experienceVersionId)
      return version === undefined ? [] : [preflightMatch(
        fingerprint,
        matchSet,
        version,
        currentObservations,
        now,
        validUntil,
      )]
    })
    let baseContributions: readonly PlanContributionView[] = preflights.flatMap(preflight => {
      const version = versions.find(item => item.experienceVersionId === preflight.experienceVersionId)
      const candidate = matchSet.candidates.find(item => item.experienceVersionId === preflight.experienceVersionId)
      return version === undefined || candidate === undefined ? [] : contributionsFor(version, candidate, preflight)
    })
    // OPT-C: consult the governed history-ranking gate. When the LocalOwner has reviewed, evaluated and
    // promoted the ranking predictor for this exact scope with quota remaining, history may readjust
    // the order of equally-relevant, available candidates before composition. Otherwise (closed gate,
    // demotion, quota exhausted) the ranking is advisory-only and the deterministic baseline order is
    // kept. The actual reorder is re-verified and quota-claimed in the same transaction as the Plan save.
    const historyRanking = this.applyHistoryRankingAuthorization(
      actor, preflights, matchSet, fingerprint, baseContributions,
    )
    if (historyRanking !== null) {
      baseContributions = historyRanking.orderedContributions
      preflights = historyRanking.orderedPreflights
    }
    // OPT-B: resolve the transitive `requires` closure and the H1 explicit-optional component
    // declaration from the versions that actually contribute, bypassing top-K. Every legal
    // dependency (whether already matched or fetched) is re-checked for permission, integrity,
    // applicability and safety; an unsatisfiable one blocks the Plan instead of being silently
    // skipped. A low-relevance dependency is never rejected just for being outside the window.
    const baseVersionIds = new Set(versions.map(version => version.experienceVersionId))
    const baseRelations = this.repository.listActivePlanningRelations(
      versions.map(version => version.experienceVersionId), actor, now,
    )
    const optionalSelection = applyExplicitOptionalSelection(
      baseContributions, versions, baseRelations, fingerprint, now,
    )
    const optionalPrunedIds = new Set(optionalSelection.prunes.map(prune => prune.optionalContributionId))

    const contributedVersionIds = new Set(baseContributions.map(contribution => contribution.experienceVersionId))
    const contributedVersions = versions.filter(version => contributedVersionIds.has(version.experienceVersionId))
    const closure = this.repository.loadRequiredDependencyClosure(actor, contributedVersions, now)

    // Evaluate every resolved required target (base-known and newly-fetched) exactly once.
    const contributedByTarget = new Map<string, PlanContributionView[]>()
    const newDependencyVersions: ExperienceVersionView[] = []
    const dependencyOnlyContributions = new Map<string, PlanContributionView>()
    const dependencyPreflightByVersion = new Map<string, PreflightRecordView>()
    const dependencyPlanByVersion = new Map<string, ReturnType<typeof planDependency>>()
    const dependencyUnsatisfiable = new Map<string, string>()
    const addTargetContributions = (versionId: string, list: readonly PlanContributionView[]): void => {
      const merged = [...(contributedByTarget.get(versionId) ?? [])]
      for (const contribution of list) {
        if (!merged.some(item => item.contributionId === contribution.contributionId)) merged.push(contribution)
      }
      contributedByTarget.set(versionId, merged)
    }
    const planDependencyOnce = (version: ExperienceVersionView): ReturnType<typeof planDependency> => {
      const versionId = String(version.experienceVersionId)
      const existing = dependencyPlanByVersion.get(versionId)
      if (existing !== undefined) return existing
      const planned = planDependency(fingerprint, version, currentObservations, now,
        validUntil, input.task, matchSet.matchSetId)
      dependencyPlanByVersion.set(versionId, planned)
      return planned
    }
    const retainDependencyPlan = (
      version: ExperienceVersionView,
      planned: ReturnType<typeof planDependency>,
    ): void => {
      addTargetContributions(version.experienceVersionId, planned.contributions)
      for (const contribution of planned.contributions) {
        dependencyOnlyContributions.set(contribution.contributionId, contribution)
      }
      if (planned.preflight !== null) {
        dependencyPreflightByVersion.set(String(version.experienceVersionId), planned.preflight)
      }
    }
    for (const requirement of closure.requirements) {
      if (requirement.targetVersion === null) {
        const reason = requirement.unsatisfiable?.reasonCode.startsWith('required_dependency_')
          ? requirement.unsatisfiable.reasonCode
          : `required_dependency_${requirement.unsatisfiable?.reasonCode ?? 'unresolvable'}`
        dependencyUnsatisfiable.set(String(requirement.relationId),
          `dependency ${requirement.targetObjectRef.kind}:${requirement.targetObjectRef.id} (${reason})`)
        continue
      }
      const targetVersion = requirement.targetVersion
      if (baseVersionIds.has(targetVersion.experienceVersionId)) {
        const existingBase = baseContributions.filter(contribution =>
          contribution.experienceVersionId === targetVersion.experienceVersionId)
        if (existingBase.length === 0) {
          const recheck = planDependencyOnce(targetVersion)
          if (recheck.unsatisfiableReason !== null) {
            dependencyUnsatisfiable.set(String(requirement.relationId),
              `dependency ${targetVersion.experienceVersionId} (${recheck.unsatisfiableReason})`)
            addTargetContributions(targetVersion.experienceVersionId, [])
          } else retainDependencyPlan(targetVersion, recheck)
        } else {
          addTargetContributions(targetVersion.experienceVersionId, existingBase)
        }
      } else {
        const recheck = planDependencyOnce(targetVersion)
        if (recheck.unsatisfiableReason !== null) {
          dependencyUnsatisfiable.set(String(requirement.relationId),
            `dependency ${targetVersion.experienceVersionId} (${recheck.unsatisfiableReason})`)
          addTargetContributions(targetVersion.experienceVersionId, [])
        } else {
          retainDependencyPlan(targetVersion, recheck)
          if (!newDependencyVersions.some(version => version.experienceVersionId === targetVersion.experienceVersionId)) {
            newDependencyVersions.push(targetVersion)
          }
        }
      }
    }
    const allVersions = [...versions, ...newDependencyVersions]
    const allContributions = [...baseContributions, ...dependencyOnlyContributions.values()]
    const importedDependencyContributionIds = [...dependencyOnlyContributions.keys()]
    const effectivePreflights = [
      ...preflights,
      ...dependencyPreflightByVersion.values(),
    ]
    const requiredDependencies = closure.requirements.map(requirement => ({
      relationId: requirement.relationId,
      sourceContributionIds: endpointContributionIds(requirement.sourceObjectRef, allContributions, allVersions),
      targetContributionIds: requirement.targetVersion === null
        ? []
        : (contributedByTarget.get(requirement.targetVersion.experienceVersionId) ?? []).map(item => item.contributionId),
      ...(dependencyUnsatisfiable.has(String(requirement.relationId))
        ? { unsatisfiableBlocker: dependencyUnsatisfiable.get(String(requirement.relationId))! }
        : {}),
    }))
    const overrides = this.repository.listActiveOverrides(input.task.overrideDecisionIds, actor, now)
    const related = applyPlanningRelations(allContributions, allVersions, closure.relations, overrides, input.task)
    // Apply the H1 explicit-optional selection after relations are annotated so the anchor keeps
    // its composes_with relation id and the relation appears in selectedRelationIds.
    const finalContributions = related.contributions.filter(contribution =>
      !optionalPrunedIds.has(contribution.contributionId))
    const plan = composeUsagePlan(fingerprint, matchSet, effectivePreflights, finalContributions, now, {
      useMode: input.task.requestedUseMode,
      selectedRelationIds: related.selectedRelationIds,
      overrideDecisionIds: related.overrideDecisionIds,
      preferenceEnforcements: related.preferenceEnforcements,
      requiredDependencies,
      importedDependencyContributionIds,
      dependencyPreflightIds: [...dependencyPreflightByVersion.values()].map(item => item.preflightId),
      optionalPrunes: optionalSelection.prunes,
      preDiscardedContributions: optionalSelection.discarded,
      additionalBlockers: optionalSelection.blockers,
      ...(historyRanking === null ? {} : { historyRankOrder: historyRanking.ticket.proposedVersionIds }),
    })
    const retainedPreflightIds = new Set(plan.preflightIds)
    const planningPreflights = effectivePreflights.filter(preflight => retainedPreflightIds.has(preflight.preflightId))
    const request = plan.requiresApproval
      ? approvalRequest(plan, input.task, fingerprint.riskClass, actor, policy, now)
      : null
    const noMatchContinue = plan.disposition === 'no_match' && !input.task.mustUseExperience
    const attempt: AdmissionAttemptView = {
      admissionAttemptId: brandedId<'ExperienceAdmissionAttemptId'>(randomUUID(), 'admissionAttemptId'),
      usageId: plan.usageId,
      requestId: request?.requestId ?? null,
      sessionId: input.sessionId,
      actorId: actor.actorId,
      state: request !== null ? 'pending_external_decision'
        : noMatchContinue ? 'no_answerer_continue' : 'not_required',
      reasonCode: request !== null ? 'exact_plan_decision_pending'
        : noMatchContinue ? 'no_match_continue_without_context' : 'plan_approval_not_required',
      createdAt: now,
    }
    const planning: PlanningResultView = {
      fingerprint,
      matchSet,
      preflights: planningPreflights,
      plan,
      approvalRequest: request,
      admissionAttempt: attempt,
      retryBinding: null,
      interactionOutcome: noMatchContinue ? 'no_answerer_continue' : 'not_requested',
    }
    const historyRankingTicket = historyRanking?.ticket
    let committed = await this.repository.createPlanningResult(input, planning, actor, historyRankingTicket)
    if (request === null || input.interaction === 'defer') return committed
    const answer = await this.interaction.ask(committed.planning, input.sessionId, signal)
    committed = await this.applyInteractionAnswer(committed, answer, input, actor, signal, true)
    return committed
  }

  /** Apply one management CLI or already-normalized interaction decision. */
  decide(input: DecidePlanCommandInput, actor: ActorView): Promise<PlanningCommandResult> {
    return this.repository.decidePlan(input, actor)
  }

  private async applyInteractionAnswer(
    committed: PlanningCommandResult,
    answer: PlanInteractionAnswer,
    input: PlanTaskCommandInput,
    actor: ActorView,
    signal: AbortSignal | undefined,
    allowAdaptation: boolean,
  ): Promise<PlanningCommandResult> {
    const request = committed.planning.approvalRequest
    if (request === null) return committed
    if (answer.kind === 'no_provider') {
      const state = input.task.mustUseExperience ? 'pending_external_decision' : 'no_answerer_continue'
      const planning = await this.repository.recordPlanInteractionOutcome(
        committed.planning.plan.usageId,
        state,
        'interaction_answerer_unavailable',
        input.task.mustUseExperience ? 'interaction_answerer_unavailable' : 'no_answerer_continue',
        actor,
      )
      return { ...committed, planning }
    }
    if (answer.kind === 'adapt' && allowAdaptation) {
      const adapted = await this.repository.adaptPlan(committed.planning.plan.usageId, answer.reason, actor)
      const secondAnswer = await this.interaction.ask(adapted, input.sessionId, signal)
      return this.applyInteractionAnswer(
        { ...committed, planning: adapted },
        secondAnswer,
        input,
        actor,
        signal,
        false,
      )
    }
    if (answer.kind === 'interrupted' || answer.kind === 'adapt') {
      const planning = await this.repository.recordPlanInteractionOutcome(
        committed.planning.plan.usageId,
        'interaction_interrupted',
        answer.kind === 'adapt' ? 'plan_adaptation_requested' : answer.reason,
        answer.kind === 'adapt' ? 'adaptation_requested' : 'interaction_interrupted',
        actor,
      )
      return { ...committed, planning }
    }
    return this.repository.decidePlan({
      commandId: brandedId<'ExperienceCommandId'>(randomUUID(), 'commandId'),
      requestId: request.requestId,
      usagePlanId: request.usagePlanId,
      expectedPlanRevision: request.planRevision,
      decision: answer.kind === 'approve' ? 'approve' : 'deny',
      reason: answer.reason,
      correlationId: input.correlationId,
      causationId: committed.receipt.receiptId,
      issuedAt: new Date().toISOString(),
    }, actor)
  }

  /**
   * Consult the governed history-ranking gate and, when authorized, legally readjust the order of the
   * equally-relevant available candidates before composition. Returns the reordered contributions /
   * preflights plus the apply ticket to be re-verified and quota-claimed at the Plan save, or null when
   * the gate is closed (advisory-only, deterministic baseline kept).
   */
  private applyHistoryRankingAuthorization(
    actor: ActorView,
    preflights: readonly PreflightRecordView[],
    matchSet: PlanningResultView['matchSet'],
    fingerprint: PlanningResultView['fingerprint'],
    baseContributions: readonly PlanContributionView[],
  ): { readonly orderedContributions: readonly PlanContributionView[]; readonly orderedPreflights: readonly PreflightRecordView[]; readonly ticket: HistoryRankingApplyTicket } | null {
    if (preflights.length === 0 || baseContributions.length === 0) return null
    const candidateById = new Map(matchSet.candidates.map(candidate => [String(candidate.experienceVersionId), candidate]))
    const candidates = preflights.map(preflight => {
      const match = candidateById.get(String(preflight.experienceVersionId))
      return {
        versionId: String(preflight.experienceVersionId),
        disposition: preflight.disposition,
        structuralScore: match?.structuralScore ?? null,
        lexicalScore: match?.lexicalScore ?? null,
        rejected: match?.rejected ?? false,
      }
    })
    const environmentKey = fingerprint.environmentRefs[0] ?? 'local'
    const gate = this.repository.readHistoryRankingGate({
      workspaceRoot: fingerprint.environmentRefs[0] ?? null,
      targetExposure: fingerprint.targetExposure,
      riskClass: fingerprint.riskClass,
      environmentKey,
      taskInputDigest: fingerprint.taskInputDigest,
      candidates,
    }, actor)
    if (!gate.authorized) return null
    const rank = new Map(gate.proposedVersionIds.map((versionId, index) => [versionId, index]))
    const versionOrder = (versionId: string): number => rank.get(versionId) ?? Number.MAX_SAFE_INTEGER
    const orderedContributions = [...baseContributions].sort((left, right) =>
      versionOrder(String(left.experienceVersionId)) - versionOrder(String(right.experienceVersionId))
      || left.contributionId.localeCompare(right.contributionId))
    const orderedPreflights = [...preflights].sort((left, right) =>
      versionOrder(String(left.experienceVersionId)) - versionOrder(String(right.experienceVersionId))
      || String(left.preflightId).localeCompare(String(right.preflightId)))
    const ticket: HistoryRankingApplyTicket = {
      authorized: true,
      taskInputDigest: fingerprint.taskInputDigest,
      environmentKey,
      scope: {
        workspaceRoot: fingerprint.environmentRefs[0] ?? null,
        targetExposure: fingerprint.targetExposure,
        riskClass: fingerprint.riskClass,
      },
      baselineVersionIds: gate.baselineVersionIds,
      proposedVersionIds: gate.proposedVersionIds,
      governanceDecisionId: gate.governanceDecisionId,
      evaluationId: gate.evaluationId,
      policyRevision: gate.policyRevision,
      contractRevision: gate.contractRevision,
    }
    return { orderedContributions, orderedPreflights, ticket }
  }

  private requiredFingerprintLlm(): TaskFingerprintLlm {
    if (this.fingerprintLlm === undefined) {
      throw new Error('model TaskFingerprint proposal is configured without an LLM adapter')
    }
    return this.fingerprintLlm
  }
}

function approvalRequest(
  plan: PlanningResultView['plan'],
  task: PlanTaskCommandInput['task'],
  riskClass: PlanningResultView['fingerprint']['riskClass'],
  actor: ActorView,
  policy: PlanningPolicy,
  now: string,
): PlanApprovalRequestView {
  return {
    requestId: brandedId<'ExperiencePlanApprovalRequestId'>(randomUUID(), 'requestId'),
    usagePlanId: plan.usagePlanId,
    usageId: plan.usageId,
    planRevision: plan.planRevision,
    actorId: actor.actorId,
    principalId: actor.principalId,
    status: 'pending',
    riskClass,
    scopeDigest: usageScopeDigest(task),
    createdAt: now,
    expiresAt: new Date(Date.parse(now) + policy.planApprovalTtlMs).toISOString(),
    decidedAt: null,
    decisionId: null,
    reason: null,
  }
}
