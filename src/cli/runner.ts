import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import {
  parseCandidateCommandInput,
  parseCandidateDispositionInput,
  parseDecideCandidateFieldInput,
  parsePlanTaskCommandInput,
  parseDecidePlanCommandInput,
  parseProgressUsageInput,
  parseVerifyUsageInput,
  parseSettleUsageInput,
  parseProposeRevisionInput,
  parseDecideRevisionChangeInput,
  parsePublishRevisionInput,
  parseForgetExperienceInput,
  parseAuditQueryInput,
  parseChangeAutomationLevelInput,
  parseCreateOverrideDecisionInput,
  parseDeclareExperienceRelationInput,
  parseExperienceRelationObjectRef,
  parseEvaluateInfrastructureReadinessInput,
  parseEvaluateUnlockContractInput,
  parseRecordEvaluationObservationInput,
  parseRankingReviewInput,
  parseDismissExperienceSuggestionInput,
  parseSaveExperienceSuggestionInput,
} from '../application/input.js'
import { markdownDigest } from '../domain/markdown.js'
import { publicFailure } from '../errors.js'
import { brandedId } from '../ids.js'
import type { ExperienceCliSpec } from './startup.js'

/** Stable Cordis plugin name. */
export const name = 'experience-map-cli-runner'
/** The runner starts only after parsing and Host service registration complete. */
export const inject = ['experiences', 'experienceCliSpec', 'fs']

/** Execute the frozen operation after the launcher commits successful startup. */
export function apply(ctx: Context): void {
  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  if (ready === undefined || exit === undefined) {
    throw new Error('experience-map CLI: the dsh launcher must provide appReady and appExit')
  }
  let active = true
  const cancel = ready.onReady(() => {
    if (!active) return
    void execute(ctx, ctx.experienceCliSpec).then((value) => {
      if (!active) return
      process.stdout.write(`${JSON.stringify({ ok: true, value })}\n`)
      exit(0)
    }, (error: unknown) => {
      if (!active) return
      process.stderr.write(`${JSON.stringify({ ok: false, error: publicFailure(error) })}\n`)
      exit(1)
    })
  })
  ctx.effect(() => () => {
    active = false
    cancel()
  }, 'experience-map management CLI readiness')
}

async function execute(ctx: Context, spec: ExperienceCliSpec): Promise<unknown> {
  const origin = { kind: 'management-cli' } as const
  switch (spec.kind) {
    case 'status':
      return ctx.experiences.getStatus(origin)
    case 'suggestions-show':
      return ctx.experiences.getSuggestionProjection(origin)
    case 'suggestion-save':
      return ctx.experiences.saveExperienceSuggestion(
        parseSaveExperienceSuggestionInput(await readJson(ctx, spec.inputPath)), origin)
    case 'suggestion-dismiss':
      return ctx.experiences.dismissSuggestion(
        parseDismissExperienceSuggestionInput(await readJson(ctx, spec.inputPath)), origin)
    case 'retrieval-show':
      return ctx.experiences.getRetrievalProjection(origin)
    case 'automation-config-show':
      return ctx.experiences.getAutomationConfiguration(origin)
    case 'learning-show':
      return ctx.experiences.getLearningProjection(origin)
    case 'learning-governance-show':
      return ctx.experiences.getLearningGovernance(origin)
    case 'learning-evaluate':
      return mutationReceipt(ctx, await ctx.experiences.evaluateUnlockContract(
        parseEvaluateUnlockContractInput(await readJson(ctx, spec.inputPath)), origin))
    case 'learning-change-level':
      return mutationReceipt(ctx, await ctx.experiences.changeAutomationLevel(
        parseChangeAutomationLevelInput(await readJson(ctx, spec.inputPath)), origin))
    case 'learning-ranking-review':
      return mutationReceipt(ctx, await ctx.experiences.reviewHistoryRanking(
        parseRankingReviewInput(await readJson(ctx, spec.inputPath)), origin))
    case 'learning-ranking-reviews-show':
      return ctx.experiences.readHistoryRankingReviews(origin)
    case 'relation-declare':
      return mutationReceipt(ctx, await ctx.experiences.declareRelation(
        parseDeclareExperienceRelationInput(await readJson(ctx, spec.inputPath)), origin))
    case 'relation-show':
      return ctx.experiences.getRelation(
        brandedId<'ExperienceRelationId'>(spec.relationId, 'relationId'), origin)
    case 'relation-list':
      return ctx.experiences.listRelations(
        parseExperienceRelationObjectRef(await readJson(ctx, spec.inputPath)), origin)
    case 'override-create':
      return mutationReceipt(ctx, await ctx.experiences.createOverride(
        parseCreateOverrideDecisionInput(await readJson(ctx, spec.inputPath)), origin))
    case 'override-show':
      return ctx.experiences.getOverride(
        brandedId<'ExperienceOverrideDecisionId'>(spec.overrideDecisionId, 'overrideDecisionId'), origin)
    case 'audit-show':
      return ctx.experiences.getAuditDossier(parseAuditQueryInput(await readJson(ctx, spec.inputPath)), origin)
    case 'markdown-export': {
      const projection = await ctx.experiences.exportMarkdown({
        ...commandEnvelope(),
        experienceVersionId: brandedId<'ExperienceVersionId'>(spec.experienceVersionId, 'experienceVersionId'),
      }, origin)
      await ctx.fs.writeText(await resolvePath(ctx, spec.outputPath), projection.markdown)
      return projection.receipt
    }
    case 'markdown-import': {
      const editedMarkdown = await ctx.fs.readText(await resolvePath(ctx, spec.inputPath))
      const receipt = await ctx.experiences.proposeMarkdownRevision({
        ...commandEnvelope(),
        markdownProjectionReceiptId: brandedId<'ExperienceMarkdownProjectionReceiptId'>(
          spec.markdownProjectionReceiptId, 'markdownProjectionReceiptId'),
        editedMarkdown,
        editedMarkdownDigest: markdownDigest(editedMarkdown),
      }, origin)
      return {
        receipt: ctx.experiences.getReceipt(receipt.receiptId, origin),
        revisionProposal: ctx.experiences.getRevisionProposal(String(receipt.revisionProposalId), origin),
      }
    }
    case 'relation-map-show':
      return ctx.experiences.getRelationMap(origin)
    case 'readiness-show':
      return ctx.experiences.getInfrastructureReadiness(origin)
    case 'readiness-evaluate':
      return mutationReceipt(ctx, await ctx.experiences.evaluateInfrastructureReadiness(
        parseEvaluateInfrastructureReadinessInput(await readJson(ctx, spec.inputPath)), origin))
    case 'evaluation-record':
      return mutationReceipt(ctx, await ctx.experiences.recordEvaluationObservation(
        parseRecordEvaluationObservationInput(await readJson(ctx, spec.inputPath)), origin))
    case 'evaluation-report':
      return ctx.experiences.getEvaluationReport(spec.cohortId, origin)
    case 'candidate-list':
      return ctx.experiences.listCandidates(origin)
    case 'candidate-show':
      return ctx.experiences.getCandidate(
        brandedId<'ExperienceCandidateId'>(spec.candidateId, 'candidateId'),
        origin,
      )
    case 'receipt-get':
      return ctx.experiences.getReceipt(
        brandedId<'ExperienceReceiptId'>(spec.receiptId, 'receiptId'),
        origin,
      )
    case 'version-get':
      return ctx.experiences.getVersion(
        brandedId<'ExperienceVersionId'>(spec.experienceVersionId, 'experienceVersionId'),
        origin,
      )
    case 'candidate-submit':
      return mutationResult(ctx, await ctx.experiences.submitCandidate(
        parseCandidateCommandInput(await readJson(ctx, spec.inputPath)), origin,
      ))
    case 'candidate-review':
      return mutationResult(ctx, await ctx.experiences.decideCandidateField(
        parseDecideCandidateFieldInput(await readJson(ctx, spec.inputPath)), origin,
      ))
    case 'candidate-accept':
      return mutationResult(ctx, await ctx.experiences.acceptCandidate(
        parseCandidateCommandInput(await readJson(ctx, spec.inputPath)), origin,
      ))
    case 'candidate-reject':
      return mutationResult(ctx, await ctx.experiences.rejectCandidate(
        parseCandidateDispositionInput(await readJson(ctx, spec.inputPath)), origin,
      ))
    case 'candidate-withdraw':
      return mutationResult(ctx, await ctx.experiences.withdrawCandidate(
        parseCandidateDispositionInput(await readJson(ctx, spec.inputPath)), origin,
      ))
    case 'candidate-publish':
      return mutationResult(ctx, await ctx.experiences.publishCandidate(
        parseCandidateCommandInput(await readJson(ctx, spec.inputPath)), origin,
      ))
    case 'plan-list':
      return ctx.experiences.listPlanningResults(origin)
    case 'plan-show':
      return ctx.experiences.getPlanningResult(spec.usageId, origin)
    case 'plan-create':
      return ctx.experiences.planTask(parsePlanTaskCommandInput(await readJson(ctx, spec.inputPath)), origin)
    case 'plan-decide':
      return ctx.experiences.decidePlan(parseDecidePlanCommandInput(await readJson(ctx, spec.inputPath)), origin)
    case 'context-show':
      return ctx.experiences.getContextUsage(spec.usageId, origin)
    case 'usage-show':
      return ctx.experiences.getUsageExecution(spec.usageId, origin)
    case 'usage-progress':
      return m5MutationResult(ctx, await ctx.experiences.progressUsage(
        parseProgressUsageInput(await readJson(ctx, spec.inputPath)), origin))
    case 'usage-verify':
      return m5MutationResult(ctx, await ctx.experiences.verifyUsage(
        parseVerifyUsageInput(await readJson(ctx, spec.inputPath)), origin))
    case 'usage-settle':
      return m5MutationResult(ctx, await ctx.experiences.settleUsage(
        parseSettleUsageInput(await readJson(ctx, spec.inputPath)), origin))
    case 'revision-show':
      return ctx.experiences.getRevisionProposal(spec.revisionProposalId, origin)
    case 'revision-propose':
      return m5MutationResult(ctx, await ctx.experiences.proposeRevision(
        parseProposeRevisionInput(await readJson(ctx, spec.inputPath)), origin))
    case 'revision-decide':
      return m5MutationResult(ctx, await ctx.experiences.decideRevisionChange(
        parseDecideRevisionChangeInput(await readJson(ctx, spec.inputPath)), origin))
    case 'revision-publish':
      return m5MutationResult(ctx, await ctx.experiences.publishRevision(
        parsePublishRevisionInput(await readJson(ctx, spec.inputPath)), origin))
    case 'forget-preview':
      return ctx.experiences.previewForget(
        brandedId<'ExperienceId'>(spec.experienceId, 'experienceId'),
        origin,
      )
    case 'forget': {
      const receipt = await ctx.experiences.forgetExperience(
        parseForgetExperienceInput(await readJson(ctx, spec.inputPath)), origin)
      const authoritative = ctx.experiences.getReceipt(receipt.receiptId, origin)
      if (authoritative.action !== 'experience.forget') throw new Error('Forget command returned another receipt')
      return {
        receipt: authoritative,
        forget: ctx.experiences.getForgetRequest(String(authoritative.forgetRequestId), origin),
      }
    }
    case 'forget-show':
      return ctx.experiences.getForgetRequest(spec.forgetRequestId, origin)
  }
}

async function readJson(ctx: Context, path: string): Promise<unknown> {
  return JSON.parse(await ctx.fs.readText(await resolvePath(ctx, path))) as unknown
}

function resolvePath(ctx: Context, path: string): Promise<FsTarget> {
  return ctx.fs.resolve(path)
}

function commandEnvelope(): {
  commandId: import('../ids.js').CommandId
  correlationId: string
  causationId: null
  issuedAt: string
} {
  return {
    commandId: brandedId<'ExperienceCommandId'>(randomUUID(), 'commandId'),
    correlationId: randomUUID(),
    causationId: null,
    issuedAt: new Date().toISOString(),
  }
}

function mutationReceipt(ctx: Context, receipt: import('../types.js').ExperienceDomainReceipt): unknown {
  return ctx.experiences.getReceipt(receipt.receiptId, { kind: 'management-cli' })
}

function mutationResult(
  ctx: Context,
  receipt: Awaited<ReturnType<Context['experiences']['submitCandidate']>>,
): unknown {
  const origin = { kind: 'management-cli' } as const
  const authoritative = ctx.experiences.getReceipt(receipt.receiptId, origin)
  if (!('candidateId' in authoritative)) throw new Error('Candidate mutation returned another domain receipt')
  const candidate = ctx.experiences.getCandidate(authoritative.candidateId, origin)
  return {
    receipt: authoritative,
    candidate,
    ...(authoritative.action === 'candidate.publish'
      && authoritative.experienceVersionId !== null
      ? { version: ctx.experiences.getVersion(authoritative.experienceVersionId, origin) }
      : {}),
  }
}

function m5MutationResult(ctx: Context, receipt: import('../types.js').M5DomainReceipt): unknown {
  const origin = { kind: 'management-cli' } as const
  const authoritative = ctx.experiences.getReceipt(receipt.receiptId, origin)
  if (!('usageId' in authoritative)) throw new Error('M5 command returned a non-M5 receipt')
  const usage = authoritative.usageId === null ? null
    : ctx.experiences.getUsageExecution(authoritative.usageId, origin)
  return {
    receipt: authoritative,
    ...(usage === null ? {} : { usage }),
    ...(authoritative.revisionProposalId === null ? {} : {
      revisionProposal: ctx.experiences.getRevisionProposal(authoritative.revisionProposalId, origin),
    }),
    ...(authoritative.experienceVersionId === null ? {} : {
      version: ctx.experiences.getVersion(authoritative.experienceVersionId, origin),
    }),
  }
}
