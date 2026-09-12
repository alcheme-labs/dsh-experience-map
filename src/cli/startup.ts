import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { assertSupportedNodeVersion } from '../node-compatibility.js'

assertSupportedNodeVersion()

/** Frozen management operation produced synchronously from launcher argv. */
export type ExperienceCliSpec =
  | { readonly kind: 'status' }
  | { readonly kind: 'suggestions-show' }
  | { readonly kind: 'suggestion-save'; readonly inputPath: string }
  | { readonly kind: 'suggestion-dismiss'; readonly inputPath: string }
  | { readonly kind: 'retrieval-show' }
  | { readonly kind: 'automation-config-show' }
  | { readonly kind: 'learning-show' }
  | { readonly kind: 'learning-governance-show' }
  | { readonly kind: 'learning-evaluate'; readonly inputPath: string }
  | { readonly kind: 'learning-change-level'; readonly inputPath: string }
  | { readonly kind: 'learning-ranking-review'; readonly inputPath: string }
  | { readonly kind: 'learning-ranking-reviews-show' }
  | { readonly kind: 'relation-declare'; readonly inputPath: string }
  | { readonly kind: 'relation-show'; readonly relationId: string }
  | { readonly kind: 'relation-list'; readonly inputPath: string }
  | { readonly kind: 'override-create'; readonly inputPath: string }
  | { readonly kind: 'override-show'; readonly overrideDecisionId: string }
  | { readonly kind: 'audit-show'; readonly inputPath: string }
  | { readonly kind: 'markdown-export'; readonly experienceVersionId: string; readonly outputPath: string }
  | { readonly kind: 'markdown-import'; readonly markdownProjectionReceiptId: string; readonly inputPath: string }
  | { readonly kind: 'relation-map-show' }
  | { readonly kind: 'readiness-show' }
  | { readonly kind: 'readiness-evaluate'; readonly inputPath: string }
  | { readonly kind: 'evaluation-record'; readonly inputPath: string }
  | { readonly kind: 'evaluation-report'; readonly cohortId: string }
  | { readonly kind: 'candidate-list' }
  | { readonly kind: 'candidate-show'; readonly candidateId: string }
  | { readonly kind: 'candidate-submit'; readonly inputPath: string }
  | { readonly kind: 'candidate-review'; readonly inputPath: string }
  | { readonly kind: 'candidate-accept'; readonly inputPath: string }
  | { readonly kind: 'candidate-reject'; readonly inputPath: string }
  | { readonly kind: 'candidate-withdraw'; readonly inputPath: string }
  | { readonly kind: 'candidate-publish'; readonly inputPath: string }
  | { readonly kind: 'receipt-get'; readonly receiptId: string }
  | { readonly kind: 'version-get'; readonly experienceVersionId: string }
  | { readonly kind: 'plan-list' }
  | { readonly kind: 'plan-show'; readonly usageId: string }
  | { readonly kind: 'plan-create'; readonly inputPath: string }
  | { readonly kind: 'plan-decide'; readonly inputPath: string }
  | { readonly kind: 'context-show'; readonly usageId: string }
  | { readonly kind: 'usage-show'; readonly usageId: string }
  | { readonly kind: 'usage-progress'; readonly inputPath: string }
  | { readonly kind: 'usage-verify'; readonly inputPath: string }
  | { readonly kind: 'usage-settle'; readonly inputPath: string }
  | { readonly kind: 'revision-show'; readonly revisionProposalId: string }
  | { readonly kind: 'revision-propose'; readonly inputPath: string }
  | { readonly kind: 'revision-decide'; readonly inputPath: string }
  | { readonly kind: 'revision-publish'; readonly inputPath: string }
  | { readonly kind: 'forget-preview'; readonly experienceId: string }
  | { readonly kind: 'forget'; readonly inputPath: string }
  | { readonly kind: 'forget-show'; readonly forgetRequestId: string }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Immutable Experience management command selected by the launcher argv. */
    experienceCliSpec: ExperienceCliSpec
  }
}

/** Stable Cordis plugin name. */
export const name = 'experience-map-cli-startup'
/** This is the base-only management Profile's sole command-line parser. */
export const inject = ['cmdlineArgs']

/** Parse an explicit Experience management invocation without doing I/O. */
export function apply(ctx: Context): void {
  const program = new Command()
    .name('dsh --profile experience-management')
    .description('Manage the local Experience Map through its canonical Host service.')
    .helpOption('-h, --help', 'show this help')
  const experience = program.command('experience').description('Manage Experience records.')
  experience.command('status').action(() => {
    provide(ctx, { kind: 'status' })
  })
  experience.command('suggestions-show').description('read recent Session suggestion seeds').action(() => {
    provide(ctx, { kind: 'suggestions-show' })
  })
  addInputCommand(ctx, experience, program, 'suggestion-save', 'save one exact current Session suggestion')
  addInputCommand(ctx, experience, program, 'suggestion-dismiss', 'dismiss one exact current Session suggestion')
  experience.command('retrieval-show').description('read the active lexical/dense retrieval generation').action(() => {
    provide(ctx, { kind: 'retrieval-show' })
  })
  experience.command('automation-config-show')
    .description('read configured and effective Experience automation controls')
    .action(() => {
      provide(ctx, { kind: 'automation-config-show' })
    })
  experience.command('learning-show').description('read the rebuildable M6 learning projection').action(() => {
    provide(ctx, { kind: 'learning-show' })
  })
  experience.command('learning-governance-show').description('read unlock policies and current capability levels').action(() => {
    provide(ctx, { kind: 'learning-governance-show' })
  })
  addM7InputCommand(ctx, experience, program, 'learning-evaluate', 'evaluate one exact Unlock Contract')
  addM7InputCommand(ctx, experience, program, 'learning-change-level', 'apply one bounded automation-level decision')
  addM7InputCommand(ctx, experience, program, 'learning-ranking-review', 'record one owner review of a readable shadow history ranking')
  experience.command('learning-ranking-reviews-show').description('read immutable Owner history ranking reviews').action(() => {
    provide(ctx, { kind: 'learning-ranking-reviews-show' })
  })
  addM7InputCommand(ctx, experience, program, 'relation-declare', 'declare one canonical typed Experience relation')
  experience.command('relation-show')
    .requiredOption('--relation-id <id>', 'canonical Experience relation id')
    .action((options: { relationId: string }) => {
      if (options.relationId.trim() === '') program.error('error: --relation-id must not be empty')
      provide(ctx, { kind: 'relation-show', relationId: options.relationId })
    })
  addM7InputCommand(ctx, experience, program, 'relation-list', 'list relations touching one exact typed object')
  addM7InputCommand(ctx, experience, program, 'override-create', 'create one current-Usage conflict override')
  experience.command('override-show')
    .requiredOption('--override-id <id>', 'canonical Experience override decision id')
    .action((options: { overrideId: string }) => {
      if (options.overrideId.trim() === '') program.error('error: --override-id must not be empty')
      provide(ctx, { kind: 'override-show', overrideDecisionId: options.overrideId })
    })
  addM7InputCommand(ctx, experience, program, 'audit-show', 'read one paginated Experience domain dossier')
  experience.command('markdown-export')
    .description('export one immutable Version as receipt-bound Markdown')
    .requiredOption('--version-id <id>', 'immutable Experience Version id')
    .requiredOption('--output <path>', 'output Markdown path')
    .action((options: { versionId: string; output: string }) => {
      if (options.versionId.trim() === '' || options.output.trim() === '') program.error('error: Markdown export options must not be empty')
      provide(ctx, { kind: 'markdown-export', experienceVersionId: options.versionId, outputPath: options.output })
    })
  experience.command('markdown-import')
    .description('create a structured RevisionProposal from edited Markdown')
    .requiredOption('--receipt-id <id>', 'Markdown projection receipt id')
    .requiredOption('--input <path>', 'edited Markdown path')
    .action((options: { receiptId: string; input: string }) => {
      if (options.receiptId.trim() === '' || options.input.trim() === '') program.error('error: Markdown import options must not be empty')
      provide(ctx, { kind: 'markdown-import', markdownProjectionReceiptId: options.receiptId, inputPath: options.input })
    })
  experience.command('relation-map-show').description('read the rebuildable relation map').action(() => {
    provide(ctx, { kind: 'relation-map-show' })
  })
  experience.command('readiness-show').description('read graph-storage readiness').action(() => {
    provide(ctx, { kind: 'readiness-show' })
  })
  addM7InputCommand(ctx, experience, program, 'readiness-evaluate', 'evaluate current graph-storage evidence')
  addM7InputCommand(ctx, experience, program, 'evaluation-record', 'record one source-backed comparison observation')
  experience.command('evaluation-report')
    .requiredOption('--cohort-id <id>', 'frozen evaluation cohort id')
    .action((options: { cohortId: string }) => {
      if (options.cohortId.trim() === '') program.error('error: --cohort-id must not be empty')
      provide(ctx, { kind: 'evaluation-report', cohortId: options.cohortId })
    })
  experience.command('candidate-list').action(() => {
    provide(ctx, { kind: 'candidate-list' })
  })
  experience.command('candidate-show')
    .requiredOption('--candidate-id <id>', 'durable Candidate id')
    .action((options: { candidateId: string }) => {
      if (options.candidateId.trim() === '') program.error('error: --candidate-id must not be empty')
      provide(ctx, { kind: 'candidate-show', candidateId: options.candidateId })
    })
  addInputCommand(ctx, experience, program, 'candidate-submit', 'submit a proposed Candidate for review')
  addInputCommand(ctx, experience, program, 'candidate-review', 'record one Candidate field decision')
  addInputCommand(ctx, experience, program, 'candidate-accept', 'accept a fully reviewed Candidate')
  addInputCommand(ctx, experience, program, 'candidate-reject', 'reject an in-review Candidate')
  addInputCommand(ctx, experience, program, 'candidate-withdraw', 'withdraw an unpublished Candidate')
  addInputCommand(ctx, experience, program, 'candidate-publish', 'publish an accepted Candidate')
  experience.command('receipt-get')
    .requiredOption('--receipt-id <id>', 'durable receipt id')
    .action((options: { receiptId: string }) => {
      if (options.receiptId.trim() === '') program.error('error: --receipt-id must not be empty')
      provide(ctx, { kind: 'receipt-get', receiptId: options.receiptId })
    })
  experience.command('version-get')
    .requiredOption('--version-id <id>', 'immutable Experience version id')
    .action((options: { versionId: string }) => {
      if (options.versionId.trim() === '') program.error('error: --version-id must not be empty')
      provide(ctx, { kind: 'version-get', experienceVersionId: options.versionId })
    })
  experience.command('plan-list').description('list recent Experience usage plans').action(() => {
    provide(ctx, { kind: 'plan-list' })
  })
  experience.command('plan-show')
    .description('read one Host-authoritative planning result')
    .requiredOption('--usage-id <id>', 'durable ExperienceUsage id')
    .action((options: { usageId: string }) => {
      if (options.usageId.trim() === '') program.error('error: --usage-id must not be empty')
      provide(ctx, { kind: 'plan-show', usageId: options.usageId })
    })
  addPlanningInputCommand(ctx, experience, program, 'plan-create', 'create one exact deferred usage plan')
  addPlanningInputCommand(ctx, experience, program, 'plan-decide', 'decide one exact pending usage plan')
  experience.command('context-show')
    .description('read one ContextSnapshot, delivery, and retirement explanation')
    .requiredOption('--usage-id <id>', 'durable ExperienceUsage id')
    .action((options: { usageId: string }) => {
      if (options.usageId.trim() === '') program.error('error: --usage-id must not be empty')
      provide(ctx, { kind: 'context-show', usageId: options.usageId })
    })
  addUsageShowCommand(ctx, experience, program)
  addExecutionInputCommand(ctx, experience, program, 'usage-progress', 'advance or control one exact StepProgress')
  addExecutionInputCommand(ctx, experience, program, 'usage-verify', 'run the five Web authority verifiers')
  addExecutionInputCommand(ctx, experience, program, 'usage-settle', 'settle one Usage from an exact VerificationRun')
  experience.command('revision-show')
    .description('read one exact RevisionProposal')
    .requiredOption('--revision-proposal-id <id>', 'durable RevisionProposal id')
    .action((options: { revisionProposalId: string }) => {
      if (options.revisionProposalId.trim() === '') program.error('error: --revision-proposal-id must not be empty')
      provide(ctx, { kind: 'revision-show', revisionProposalId: options.revisionProposalId })
    })
  addExecutionInputCommand(ctx, experience, program, 'revision-propose', 'propose a minimal verifier revision')
  addExecutionInputCommand(ctx, experience, program, 'revision-decide', 'decide one exact RevisionProposal change')
  addExecutionInputCommand(ctx, experience, program, 'revision-publish', 'publish an accepted RevisionProposal')
  experience.command('forget-preview')
    .description('preview exact Forget impact before stopping future recall')
    .requiredOption('--experience-id <id>', 'durable Experience series id')
    .action((options: { experienceId: string }) => {
      if (options.experienceId.trim() === '') program.error('error: --experience-id must not be empty')
      provide(ctx, { kind: 'forget-preview', experienceId: options.experienceId })
    })
  addForgetInputCommand(ctx, experience, program)
  experience.command('forget-show')
    .description('read one durable Forget request and per-owner outcomes')
    .requiredOption('--forget-request-id <id>', 'durable Forget request id')
    .action((options: { forgetRequestId: string }) => {
      if (options.forgetRequestId.trim() === '') program.error('error: --forget-request-id must not be empty')
      provide(ctx, { kind: 'forget-show', forgetRequestId: options.forgetRequestId })
    })
  parseCmdline(ctx, program)
}

function addForgetInputCommand(ctx: Context, experience: Command, program: Command): void {
  experience.command('forget')
    .description('stop future recall after an exact Forget impact preview')
    .requiredOption('--input <path>', 'path to one schema-valid Forget command')
    .action((options: { input: string }) => {
      if (options.input.trim() === '') program.error('error: --input must not be empty')
      provide(ctx, { kind: 'forget', inputPath: options.input })
    })
}

function addUsageShowCommand(ctx: Context, experience: Command, program: Command): void {
  experience.command('usage-show')
    .description('read one Host-authoritative M5 execution result')
    .requiredOption('--usage-id <id>', 'durable ExperienceUsage id')
    .action((options: { usageId: string }) => {
      if (options.usageId.trim() === '') program.error('error: --usage-id must not be empty')
      provide(ctx, { kind: 'usage-show', usageId: options.usageId })
    })
}

function addExecutionInputCommand(
  ctx: Context,
  experience: Command,
  program: Command,
  name: 'usage-progress' | 'usage-verify' | 'usage-settle'
    | 'revision-propose' | 'revision-decide' | 'revision-publish',
  description: string,
): void {
  experience.command(name)
    .description(description)
    .requiredOption('--input <path>', 'path to one schema-valid JSON command')
    .action((options: { input: string }) => {
      if (options.input.trim() === '') program.error('error: --input must not be empty')
      provide(ctx, { kind: name, inputPath: options.input })
    })
}

function addPlanningInputCommand(
  ctx: Context,
  experience: Command,
  program: Command,
  name: 'plan-create' | 'plan-decide',
  description: string,
): void {
  experience.command(name)
    .description(description)
    .requiredOption('--input <path>', 'path to one schema-valid JSON command')
    .action((options: { input: string }) => {
      if (options.input.trim() === '') program.error('error: --input must not be empty')
      provide(ctx, { kind: name, inputPath: options.input })
    })
}

function addInputCommand(
  ctx: Context,
  experience: Command,
  program: Command,
  name: Extract<ExperienceCliSpec['kind'], `candidate-${string}` | `suggestion-${string}`>,
  description: string,
): void {
  experience.command(name)
    .description(description)
    .requiredOption('--input <path>', 'path to one schema-valid JSON command')
    .action((options: { input: string }) => {
      if (options.input.trim() === '') program.error('error: --input must not be empty')
      provide(ctx, { kind: name, inputPath: options.input } as ExperienceCliSpec)
    })
}

function addM7InputCommand(
  ctx: Context,
  experience: Command,
  program: Command,
  name: Extract<ExperienceCliSpec['kind'],
    'learning-evaluate' | 'learning-change-level' | 'learning-ranking-review' | 'relation-declare'
    | 'relation-list' | 'override-create'
    | 'audit-show' | 'readiness-evaluate' | 'evaluation-record'>,
  description: string,
): void {
  experience.command(name)
    .description(description)
    .requiredOption('--input <path>', 'path to one schema-valid JSON command or query')
    .action((options: { input: string }) => {
      if (options.input.trim() === '') program.error('error: --input must not be empty')
      provide(ctx, { kind: name, inputPath: options.input } as ExperienceCliSpec)
    })
}

function provide(ctx: Context, spec: ExperienceCliSpec): void {
  ctx.provide('experienceCliSpec', Object.freeze(spec))
}
