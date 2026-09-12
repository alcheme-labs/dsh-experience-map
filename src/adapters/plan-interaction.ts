import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { PlanningResultView } from '../types.js'

/** Result of one standard Harness plan-review interaction. */
export type PlanInteractionAnswer =
  | { readonly kind: 'approve'; readonly reason: string }
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'adapt'; readonly reason: string }
  | { readonly kind: 'no_provider'; readonly reason: string }
  | { readonly kind: 'interrupted'; readonly reason: string }

/** Maps the exact immutable UsagePlan to the existing user-questions seam. */
export class PlanReviewInteraction {
  /** Bind live Agent lookup and user-questions without owning either lifecycle. */
  constructor(private readonly ctx: Context) {}

  /** Ask only the exact live root Agent; absence never becomes approval. */
  async ask(
    planning: PlanningResultView,
    sessionId: string | null,
    signal?: AbortSignal,
  ): Promise<PlanInteractionAnswer> {
    if (sessionId === null) return { kind: 'no_provider', reason: 'live_agent_not_supplied' }
    const agents = this.ctx.get('agents')
    const questions = this.ctx.get('userQuestions')
    const agent = agents?.get(SessionId(sessionId))
    if (agent === undefined || questions === undefined) {
      return { kind: 'no_provider', reason: 'interaction_answerer_unavailable' }
    }
    const approve = 'Approve exact plan'
    const deny = 'Refuse'
    try {
      const answer = await questions.ask({
        agent,
        ...(signal === undefined ? {} : { signal }),
        questions: [{
          id: String(planning.approvalRequest?.requestId ?? planning.plan.usagePlanId),
          header: 'Experience plan',
          question: 'Approve this exact Experience usage plan?',
          detail: renderPlanMarkdown(planning),
          options: [
            { label: approve, description: 'Approve only the displayed plan id, revision, and digest.' },
            { label: deny, description: 'Reject this plan without running it.' },
          ],
          multiSelect: false,
          intent: { kind: 'plan-review', approve },
        }],
      })
      const item = answer.answers.find(value => value.id === String(planning.approvalRequest?.requestId
        ?? planning.plan.usagePlanId))
      if (item?.custom !== undefined && item.custom.trim() !== '') {
        return { kind: 'adapt', reason: item.custom.trim() }
      }
      if (item?.selected.length === 1 && item.selected[0] === approve) {
        return { kind: 'approve', reason: 'approved through standard plan-review interaction' }
      }
      return { kind: 'deny', reason: 'refused through standard plan-review interaction' }
    } catch (error) {
      const code = userQuestionErrorCode(error)
      if (code === 'NO_PROVIDER') {
        return { kind: 'no_provider', reason: 'interaction_answerer_unavailable' }
      }
      if (code === 'ASK_ABORTED' || code === 'ASK_CANCELLED'
        || code === 'CALLER_NOT_LIVE' || code === 'DELEGATED_CALLER') {
        return { kind: 'interrupted', reason: code.toLowerCase() }
      }
      throw error
    }
  }
}

function userQuestionErrorCode(error: unknown): string | null {
  if (error instanceof UserQuestionError) return error.code
  if (typeof error === 'object' && error !== null
    && 'name' in error && error.name === 'UserQuestionError'
    && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return null
}

/** Exact plan detail used by both generic and plan-review-aware UIs. */
export function renderPlanMarkdown(planning: PlanningResultView): string {
  const plan = planning.plan
  return [
    `# Experience UsagePlan ${plan.usagePlanId}`,
    '',
    `Revision: ${String(plan.planRevision)}`,
    `Digest: ${plan.contentDigest}`,
    `Disposition: ${plan.disposition}`,
    '',
    '## Ordered steps',
    ...plan.orderedSteps.map((step, index) => `${String(index + 1)}. ${step.content}`),
    '',
    '## Constraints',
    ...plan.constraints.map(item => `- ${item}`),
    '',
    '## Verification',
    ...plan.verification.map(item => `- ${item}`),
    '',
    'Approval authorizes only this exact plan. M4 still rechecks current facts before context delivery.',
  ].join('\n')
}
