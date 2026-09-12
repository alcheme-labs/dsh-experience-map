import type { Context } from '@deepseek-ai/cordis'
import {
  clientRequestSchema,
  type ConnectionRpcHandler,
  type ConnectionRpcResult,
  type HostConnectionHandle,
} from '@deepseek-ai/dsh-client-connection'
import {
  parseCandidateCommandInput,
  parseCandidateDispositionInput,
  parseDecideCandidateFieldInput,
  parseProposeCandidateInput,
  parseProposalSourceInspectionInput,
  parsePlanTaskCommandInput,
  parseDecidePlanCommandInput,
  parseProgressUsageInput,
  parseVerifyUsageInput,
  parseSettleUsageInput,
  parseProposeRevisionInput,
  parseDecideRevisionChangeInput,
  parsePublishRevisionInput,
  parseForgetExperienceInput,
  parseDeclareExperienceRelationInput,
  parseCreateOverrideDecisionInput,
  parseExperienceRelationObjectRef,
  parseChangeAutomationLevelInput,
  parseEvaluateUnlockContractInput,
  parseRankingReviewInput,
  parseAuditQueryInput,
  parseExportMarkdownInput,
  parseProposeMarkdownRevisionInput,
  parseEvaluateInfrastructureReadinessInput,
  parseRecordEvaluationObservationInput,
  parseDismissExperienceSuggestionInput,
  parseSaveExperienceSuggestionInput,
} from '../application/input.js'
import { ExperienceError, publicFailure } from '../errors.js'
import { brandedId } from '../ids.js'
import { EXPERIENCE_RPC_ENDPOINT, EXPERIENCE_RPC_PATH } from '../rpc-channel.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    connection: HostConnectionHandle
  }
}

/** Attach the authenticated readback channel to the current Web Connection fiber. */
export function registerExperienceTransport(ctx: Context): void {
  const handler = createExperienceRpcHandler(ctx)
  ctx.effect(() => ctx.connection.fetch.register({
    path: EXPERIENCE_RPC_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => handleExperienceRpcRequest(request, handler),
  }), 'experience-map authenticated readback RPC route')
}

/** Build the endpoint dispatcher separately so domain authorization remains transport-independent. */
export function createExperienceRpcHandler(ctx: Context): ConnectionRpcHandler {
  return async (endpoint, payload, signal) => {
    try {
      if (endpoint === 'suggestions/query') {
        requireExactPayload(payload, [])
        return success(ctx.experiences.getSuggestionProjection({ kind: 'authenticated-browser' }))
      }
      if (endpoint === 'retrieval/query') {
        requireExactPayload(payload, [])
        return success(ctx.experiences.getRetrievalProjection({ kind: 'authenticated-browser' }))
      }
      if (endpoint === 'suggestions/dismiss') {
        const value = requireExactPayload(payload, ['input'])
        return success(ctx.experiences.dismissSuggestion(
          parseDismissExperienceSuggestionInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'suggestions/save') {
        const value = requireExactPayload(payload, ['input'])
        return receiptKey(await ctx.experiences.saveExperienceSuggestion(
          parseSaveExperienceSuggestionInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'status/query') {
        requireExactPayload(payload, [])
        return success(ctx.experiences.getStatus({ kind: 'authenticated-browser' }))
      }
      if (endpoint === 'learning/query') {
        requireExactPayload(payload, [])
        return success(await ctx.experiences.getLearningProjection({ kind: 'authenticated-browser' }))
      }
      if (endpoint === 'learning/governance') {
        requireExactPayload(payload, [])
        return success(ctx.experiences.getLearningGovernance({ kind: 'authenticated-browser' }))
      }
      if (endpoint === 'audit/query') {
        const value = requireExactPayload(payload, ['input'])
        return success(ctx.experiences.getAuditDossier(
          parseAuditQueryInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'markdown/export') {
        const value = requireExactPayload(payload, ['input'])
        return success(await ctx.experiences.exportMarkdown(
          parseExportMarkdownInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'markdown/get') {
        const value = requireExactPayload(payload, ['markdownProjectionReceiptId'])
        return success(ctx.experiences.getMarkdownProjection(
          requiredString(value.markdownProjectionReceiptId, 'markdownProjectionReceiptId'),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'markdown/propose-revision') {
        const value = requireExactPayload(payload, ['input'])
        return receiptKey(await ctx.experiences.proposeMarkdownRevision(
          parseProposeMarkdownRevisionInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'relation-map/query') {
        requireExactPayload(payload, [])
        return success(ctx.experiences.getRelationMap({ kind: 'authenticated-browser' }))
      }
      if (endpoint === 'infrastructure/readiness') {
        requireExactPayload(payload, [])
        return success(ctx.experiences.getInfrastructureReadiness({ kind: 'authenticated-browser' }))
      }
      if (endpoint === 'infrastructure/evaluate') {
        const value = requireExactPayload(payload, ['input'])
        return receiptKey(await ctx.experiences.evaluateInfrastructureReadiness(
          parseEvaluateInfrastructureReadinessInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'evaluation/observe') {
        const value = requireExactPayload(payload, ['input'])
        return receiptKey(await ctx.experiences.recordEvaluationObservation(
          parseRecordEvaluationObservationInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'evaluation/report') {
        const value = requireExactPayload(payload, ['cohortId'])
        return success(ctx.experiences.getEvaluationReport(
          requiredString(value.cohortId, 'cohortId'),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'learning/evaluate') {
        const value = requireExactPayload(payload, ['input'])
        return receiptKey(await ctx.experiences.evaluateUnlockContract(
          parseEvaluateUnlockContractInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'learning/change-level') {
        const value = requireExactPayload(payload, ['input'])
        return receiptKey(await ctx.experiences.changeAutomationLevel(
          parseChangeAutomationLevelInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'learning/ranking-review') {
        const value = requireExactPayload(payload, ['input'])
        return receiptKey(await ctx.experiences.reviewHistoryRanking(
          parseRankingReviewInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'forget/preview') {
        const value = requireExactPayload(payload, ['experienceId'])
        return success(ctx.experiences.previewForget(
          brandedId<'ExperienceId'>(requiredString(value.experienceId, 'experienceId'), 'experienceId'),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'forget/commit') {
        const value = requireExactPayload(payload, ['input'])
        return receiptKey(await ctx.experiences.forgetExperience(
          parseForgetExperienceInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'forget/get') {
        const value = requireExactPayload(payload, ['forgetRequestId'])
        return success(ctx.experiences.getForgetRequest(
          requiredString(value.forgetRequestId, 'forgetRequestId'),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'proposal-source/inspect') {
        const value = requireExactPayload(payload, ['episode', 'requestedKind', 'outputTokenLimit', 'requestedTriggerKind'])
        return success(await ctx.experiences.inspectProposalSource(
          parseProposalSourceInspectionInput(value),
          { kind: 'authenticated-browser' },
          signal,
        ))
      }
      if (endpoint === 'candidate/list') {
        requireExactPayload(payload, [])
        return success(ctx.experiences.listCandidates({ kind: 'authenticated-browser' }))
      }
      if (endpoint === 'plan/list') {
        const value = requireExactPayload(payload, isRecord(payload) && Object.hasOwn(payload, 'limit') ? ['limit'] : [])
        const limit = value.limit === undefined ? undefined : requiredPositiveInteger(value.limit, 'limit', 100)
        return success(ctx.experiences.listPlanningResults({ kind: 'authenticated-browser' }, limit))
      }
      if (endpoint === 'plan/config') {
        requireExactPayload(payload, [])
        return success(ctx.experiences.getPlanningConfiguration())
      }
      if (endpoint === 'automation/config') {
        requireExactPayload(payload, [])
        return success(ctx.experiences.getAutomationConfiguration({ kind: 'authenticated-browser' }))
      }
      if (endpoint === 'plan/get') {
        const value = requireExactPayload(payload, ['usageId'])
        return success(ctx.experiences.getPlanningResult(
          requiredString(value.usageId, 'usageId'),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'context/get') {
        const value = requireExactPayload(payload, ['usageId'])
        return success(ctx.experiences.getContextUsage(
          requiredString(value.usageId, 'usageId'),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'usage/get') {
        const value = requireExactPayload(payload, ['usageId'])
        return success(ctx.experiences.getUsageExecution(
          requiredString(value.usageId, 'usageId'),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'usage/progress') {
        const value = requireExactPayload(payload, ['input'])
        return success(await ctx.experiences.progressUsage(
          parseProgressUsageInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'usage/verify') {
        const value = requireExactPayload(payload, ['input'])
        return success(await ctx.experiences.verifyUsage(
          parseVerifyUsageInput(value.input),
          { kind: 'authenticated-browser' },
          signal,
        ))
      }
      if (endpoint === 'usage/settle') {
        const value = requireExactPayload(payload, ['input'])
        return success(await ctx.experiences.settleUsage(
          parseSettleUsageInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'revision/propose') {
        const value = requireExactPayload(payload, ['input'])
        return success(await ctx.experiences.proposeRevision(
          parseProposeRevisionInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'revision/decide') {
        const value = requireExactPayload(payload, ['input'])
        return success(await ctx.experiences.decideRevisionChange(
          parseDecideRevisionChangeInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'revision/publish') {
        const value = requireExactPayload(payload, ['input'])
        return success(await ctx.experiences.publishRevision(
          parsePublishRevisionInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'revision/get') {
        const value = requireExactPayload(payload, ['revisionProposalId'])
        return success(ctx.experiences.getRevisionProposal(
          requiredString(value.revisionProposalId, 'revisionProposalId'),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'plan/create') {
        const value = requireExactPayload(payload, ['input'])
        return success(await ctx.experiences.planTask(
          parsePlanTaskCommandInput(value.input),
          { kind: 'authenticated-browser' },
          signal,
        ))
      }
      if (endpoint === 'plan/decide') {
        const value = requireExactPayload(payload, ['input'])
        return success(await ctx.experiences.decidePlan(
          parseDecidePlanCommandInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'candidate/get') {
        const value = requireExactPayload(payload, ['candidateId'])
        return success(ctx.experiences.getCandidate(
          brandedId<'ExperienceCandidateId'>(requiredString(value.candidateId, 'candidateId'), 'candidateId'),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'candidate/propose') {
        const value = requireExactPayload(payload, ['input'])
        return receiptKey(await ctx.experiences.proposeCandidate(
          parseProposeCandidateInput(value.input),
          { kind: 'authenticated-browser' },
          signal,
        ))
      }
      if (endpoint === 'candidate/submit') {
        const value = requireExactPayload(payload, ['input'])
        return receiptKey(await ctx.experiences.submitCandidate(
          parseCandidateCommandInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'candidate/field-decide') {
        const value = requireExactPayload(payload, ['input'])
        return receiptKey(await ctx.experiences.decideCandidateField(
          parseDecideCandidateFieldInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'candidate/accept') {
        const value = requireExactPayload(payload, ['input'])
        return receiptKey(await ctx.experiences.acceptCandidate(
          parseCandidateCommandInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'candidate/reject') {
        const value = requireExactPayload(payload, ['input'])
        return receiptKey(await ctx.experiences.rejectCandidate(
          parseCandidateDispositionInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'candidate/withdraw') {
        const value = requireExactPayload(payload, ['input'])
        return receiptKey(await ctx.experiences.withdrawCandidate(
          parseCandidateDispositionInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'candidate/publish') {
        const value = requireExactPayload(payload, ['input'])
        return receiptKey(await ctx.experiences.publishCandidate(
          parseCandidateCommandInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'receipt/get') {
        const value = requireExactPayload(payload, ['receiptId'])
        return success(ctx.experiences.getReceipt(
          brandedId<'ExperienceReceiptId'>(requiredString(value.receiptId, 'receiptId'), 'receiptId'),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'version/get') {
        const value = requireExactPayload(payload, ['experienceVersionId'])
        return success(ctx.experiences.getVersion(
          brandedId<'ExperienceVersionId'>(
            requiredString(value.experienceVersionId, 'experienceVersionId'),
            'experienceVersionId',
          ),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'relation/declare') {
        const value = requireExactPayload(payload, ['input'])
        return receiptKey(await ctx.experiences.declareRelation(
          parseDeclareExperienceRelationInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'relation/get') {
        const value = requireExactPayload(payload, ['relationId'])
        return success(ctx.experiences.getRelation(
          brandedId<'ExperienceRelationId'>(requiredString(value.relationId, 'relationId'), 'relationId'),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'relation/list') {
        const value = requireExactPayload(payload, ['objectRef'])
        return success(ctx.experiences.listRelations(
          parseExperienceRelationObjectRef(value.objectRef),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'override/create') {
        const value = requireExactPayload(payload, ['input'])
        return receiptKey(await ctx.experiences.createOverride(
          parseCreateOverrideDecisionInput(value.input),
          { kind: 'authenticated-browser' },
        ))
      }
      if (endpoint === 'override/get') {
        const value = requireExactPayload(payload, ['overrideDecisionId'])
        return success(ctx.experiences.getOverride(
          brandedId<'ExperienceOverrideDecisionId'>(
            requiredString(value.overrideDecisionId, 'overrideDecisionId'), 'overrideDecisionId'),
          { kind: 'authenticated-browser' },
        ))
      }
      return failure('unknown-endpoint', `unknown Experience endpoint: ${endpoint}`)
    } catch (error) {
      const normalized = publicFailure(error)
      return failure(normalized.code, normalized.message, normalized.details)
    }
  }
}

async function handleExperienceRpcRequest(
  request: Request,
  handler: ConnectionRpcHandler,
): Promise<Response> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') return new Response('content type must be application/json', { status: 415 })
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response('body is not JSON', { status: 400 })
  }
  const envelope = clientRequestSchema.safeParse(body)
  if (!envelope.success) return new Response('invalid client-request message', { status: 400 })
  if (envelope.data.method !== EXPERIENCE_RPC_ENDPOINT) {
    return rpcResponse(envelope.data.rpcId, failure(
      'gateway/bad-request',
      `method ${JSON.stringify(envelope.data.method)} does not match Experience endpoint`,
    ))
  }
  let endpoint: string
  let payload: unknown
  try {
    const carrier = requireExactPayload(envelope.data.payload, ['endpoint', 'payload'])
    endpoint = requiredString(carrier.endpoint, 'endpoint')
    payload = carrier.payload
  } catch (error) {
    const normalized = publicFailure(error)
    return rpcResponse(envelope.data.rpcId, failure(normalized.code, normalized.message, normalized.details))
  }
  return rpcResponse(envelope.data.rpcId, await handler(endpoint, payload, request.signal))
}

function rpcResponse(rpcId: string, result: ConnectionRpcResult<unknown>): Response {
  return Response.json(
    { type: 'server-response', rpcId, result },
    { headers: { 'cache-control': 'no-store' } },
  )
}

function receiptKey(receipt: { readonly receiptId: string }): ConnectionRpcResult<unknown> {
  return success({ receiptId: receipt.receiptId })
}

function success(value: unknown): ConnectionRpcResult<unknown> {
  return { ok: true, value }
}

function failure(
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ConnectionRpcResult<never> {
  return { ok: false, error: { code, message, details } }
}

function requireExactPayload(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new ExperienceError('invalid_command', 'RPC payload must be an object')
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ExperienceError('invalid_command', `RPC payload must contain exactly: ${expected.join(', ')}`)
  }
  return value
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ExperienceError('invalid_command', `${field} must be a non-empty string`)
  }
  return value
}

function requiredPositiveInteger(value: unknown, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new ExperienceError('invalid_command', `${field} must be an integer from 1 through ${String(maximum)}`)
  }
  return value as number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
