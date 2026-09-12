import { createHash } from 'node:crypto'
import { parseExitStatus } from '@deepseek-ai/dsh-shell'
import { buildExtractionEvidencePacket, type ExtractionEvidenceConfig } from '../adapters/extraction-evidence.js'
import type { SessionTrajectorySlice } from '../adapters/session-source.js'
import type {
  ExperienceSuggestionSeedView,
  SuggestionEvidenceSignalView,
} from '../types.js'
import {
  parseAuthoritativeFact,
  parseCausalSignal,
  parseExplicitPreference,
  parseStrategySignal,
} from './suggestion-semantic-signals.js'

/** Identity version for exact Session turn cuts. */
export const TRAJECTORY_SEGMENTER_VERSION = 'session-turn-segmenter-v1'
/** Rule version for the six-kind, local-only evidence detector. */
export const SUGGESTION_DETECTOR_VERSION = 'six-kind-evidence-detector-v3'

interface ToolAttempt {
  readonly seq: number
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
}

interface ToolOutcome {
  readonly seq: number
  readonly callId: string
  readonly sourceRefId: string
  readonly failed: boolean
  readonly failureCode: string | null
}

/**
 * Detect a source-backed seed without a model call. Procedure/Diagnostic still
 * require a verifier; the other kinds have their own stricter evidence signals.
 */
export function detectSuggestionSeed(
  slice: SessionTrajectorySlice,
  workspaceRoot: string | null,
  ttlMs: number,
  evidenceConfig: ExtractionEvidenceConfig,
): ExperienceSuggestionSeedView | null {
  if (slice.blockedReason !== null) return null
  const packet = buildExtractionEvidencePacket([slice.episodeRef], slice.records, evidenceConfig)
  const attempts = toolAttempts(slice)
  const containsUngovernedTermination = attempts.some(isUngovernedProcessTermination)
  const attemptByCall = new Map(attempts.map(attempt => [attempt.callId, attempt]))
  const outcomes = toolOutcomes(slice, attemptByCall)
  const successfulVerifierOutcomes = outcomes.filter(outcome => {
    if (outcome.failed) return false
    const attempt = attemptByCall.get(outcome.callId)
    return attempt !== undefined && isVerifier(attempt)
  })
  const successfulOutcomes = outcomes.filter(outcome => !outcome.failed)
  const failures = outcomes.filter(outcome => outcome.failed)
  const goal = packet.items.find(item => item.evidenceRole === 'user_goal')?.content
  if (goal === undefined || goal.trim() === '') return null
  const hasVerifiedProcedure = !containsUngovernedTermination && successfulVerifierOutcomes.length > 0
  const latestVerifierSeq = successfulVerifierOutcomes.at(-1)?.seq ?? -1
  const hasResolvedFailure = hasVerifiedProcedure
    && failures.some(failure => successfulOutcomes.some(success => success.seq > failure.seq))
    && failures.some(failure => latestVerifierSeq > failure.seq)
  const verifierTools = [...new Set(successfulVerifierOutcomes
    .map(outcome => attemptByCall.get(outcome.callId)?.name)
    .filter((value): value is string => value !== undefined))]
  const outcomeByCall = new Map(outcomes.map(outcome => [outcome.callId, outcome]))
  const successfulTools = attempts.filter(attempt => outcomeByCall.get(attempt.callId)?.failed === false)
  const failedTools = attempts.filter(attempt => outcomeByCall.get(attempt.callId)?.failed === true)
  const lastFailureSeq = failures.reduce((latest, failure) => Math.max(latest, failure.seq), -1)
  const recoveryTools = hasResolvedFailure
    ? successfulTools.filter(attempt => attempt.seq > lastFailureSeq)
    : successfulTools
  const failureSourceRefs = new Set(failures.map(outcome => outcome.sourceRefId))
  const verifierSourceRefs = new Set(successfulVerifierOutcomes.map(outcome => outcome.sourceRefId))
  const evidenceSignals = packet.items.flatMap(item =>
    toSuggestionSignal(item, failureSourceRefs, verifierSourceRefs))
  const suggestedKinds: ExperienceSuggestionSeedView['suggestedKinds'] = [
    ...(hasVerifiedProcedure ? ['procedure' as const] : []),
    ...(hasResolvedFailure ? ['diagnostic' as const] : []),
    ...(parseExplicitPreference(goal) === null ? [] : ['preference_policy' as const]),
    ...(evidenceSignals.some(signal => signal.evidenceClass === 'observed_fact'
      && parseAuthoritativeFact(signal.content) !== null) ? ['fact' as const] : []),
    ...(parseStrategySignal(goal) === null ? [] : ['strategy' as const]),
    ...(successfulOutcomes.length > 0 && parseCausalSignal(goal) !== null ? ['causal' as const] : []),
  ]
  if (suggestedKinds.length === 0) return null
  const detectedAt = slice.episodeRef.occurredAt.end
  const expiresAt = new Date(new Date(detectedAt).getTime() + ttlMs).toISOString()
  return {
    occurrenceId: `occurrence:${sha256(canonicalJson({
      sessionId: slice.episodeRef.sessionOrRunId,
      startSeq: slice.episodeRef.eventStart,
      endSeq: slice.episodeRef.eventEnd,
      sourceDigest: slice.episodeRef.contentDigest,
      segmenterVersion: TRAJECTORY_SEGMENTER_VERSION,
    }))}`,
    sessionId: slice.episodeRef.sessionOrRunId,
    workspaceRoot,
    episodeRef: slice.episodeRef,
    suggestedKinds,
    triggerKind: triggerKind(suggestedKinds, hasResolvedFailure),
    stableKernel: {
      taskGoal: bounded(goal, 2_048),
      toolSequence: successfulTools.map(attempt => attempt.name),
      failedToolSequence: failedTools.map(attempt => attempt.name),
      recoveryToolSequence: recoveryTools.map(attempt => attempt.name),
      failureCodes: [...new Set(failures
        .map(outcome => outcome.failureCode)
        .filter((value): value is string => value !== null))].sort(),
      verifierTools,
    },
    evidenceSignals,
    detectorVersion: SUGGESTION_DETECTOR_VERSION,
    segmenterVersion: TRAJECTORY_SEGMENTER_VERSION,
    detectedAt,
    expiresAt,
  }
}

function triggerKind(
  kinds: ExperienceSuggestionSeedView['suggestedKinds'],
  hasResolvedFailure: boolean,
): ExperienceSuggestionSeedView['triggerKind'] {
  if (hasResolvedFailure) return 'high_cost_resolution'
  if (kinds.includes('procedure')) return 'terminal_success'
  if (kinds.includes('preference_policy')) return 'explicit_user_directive'
  if (kinds.includes('fact')) return 'authoritative_fact'
  if (kinds.includes('strategy')) return 'strategy_candidate'
  return 'causal_candidate'
}

/** Stable canonical JSON used only for projection identities and manifests. */
export function suggestionCanonicalJson(value: unknown): string {
  return canonicalJson(value)
}

/** Stable sha256 helper for projection identities. */
export function suggestionDigest(value: unknown): string {
  return `sha256:${sha256(canonicalJson(value))}`
}

function toSuggestionSignal(
  item: import('../types.js').ExtractionEvidenceItem,
  failureSourceRefs: ReadonlySet<string>,
  verifierSourceRefs: ReadonlySet<string>,
): SuggestionEvidenceSignalView[] {
  if (item.evidenceRole !== 'user_goal'
    && item.evidenceRole !== 'attempted_action'
    && item.evidenceRole !== 'symptom'
    && item.evidenceRole !== 'tool_observation'
    && item.evidenceRole !== 'terminal_readback'
    && item.evidenceRole !== 'model_claim'
    && item.evidenceRole !== 'terminal_outcome') return []
  if (item.evidenceClass !== 'user_instruction'
    && item.evidenceClass !== 'observed_fact'
    && item.evidenceClass !== 'model_claim') return []
  return [{
    itemId: item.itemId,
    sourceRef: item.sourceRef,
    eventType: item.eventType,
    role: failureSourceRefs.has(item.sourceRef.sourceRefId)
      ? 'symptom'
      : verifierSourceRefs.has(item.sourceRef.sourceRefId) ? 'terminal_readback' : item.evidenceRole,
    evidenceClass: item.evidenceClass,
    content: item.content,
    projectionDigest: item.projectionDigest,
    projectionTruncated: item.projectionTruncated,
  }]
}

function toolAttempts(slice: SessionTrajectorySlice): ToolAttempt[] {
  return slice.records.flatMap(record => {
    if (record.eventType !== 'tool/call') return []
    const root = asRecord(parseJson(record.excerpt))
    const data = asRecord(root?.data)
    if (typeof data?.callId !== 'string' || typeof data.name !== 'string') return []
    return [{ seq: number(root?.seq), callId: data.callId, name: data.name, arguments: data.arguments }]
  })
}

function toolOutcomes(
  slice: SessionTrajectorySlice,
  attemptByCall: ReadonlyMap<string, ToolAttempt>,
): ToolOutcome[] {
  return slice.records.flatMap(record => {
    if (record.eventType !== 'tool/result') return []
    const root = asRecord(parseJson(record.excerpt))
    const data = asRecord(root?.data)
    const message = asRecord(data?.message)
    const source = asRecord(message?.source)
    const callId = typeof source?.callId === 'string'
      ? source.callId
      : typeof data?.toolCallId === 'string' ? data.toolCallId : null
    if (callId === null) return []
    const error = asRecord(data?.error)
    const legacyFailed = data?.isError === true
    const attempt = attemptByCall.get(callId)
    const shellStatus = attempt !== undefined && isShellTool(attempt.name)
      ? parseExitStatus(toolResultText(data)) : null
    const shellFailed = shellStatus !== null
      && ('signal' in shellStatus || shellStatus.exitCode !== 0)
    const failed = error !== undefined || legacyFailed || shellFailed
    const failureCode = failed
      ? stringValue(error?.code) ?? stringValue(error?.name)
        ?? (shellStatus !== null && 'signal' in shellStatus
          ? `signal_${shellStatus.signal}`
          : shellStatus !== null && shellStatus.exitCode !== 0 ? `exit_code_${String(shellStatus.exitCode)}` : null)
        ?? 'tool_error'
      : null
    return [{
      seq: number(root?.seq),
      callId,
      sourceRefId: record.sourceRef.sourceRefId,
      failed,
      failureCode,
    }]
  })
}

function isVerifier(attempt: ToolAttempt): boolean {
  if (/(?:^|[./:_-])(?:verify|check|test|health|curl|playwright|browser|job_output)(?:$|[./:_-])/iu.test(attempt.name)) {
    return true
  }
  if (!isShellTool(attempt.name)) return false
  const parsed = parseJson(typeof attempt.arguments === 'string' ? attempt.arguments : '')
  const command = stringValue(asRecord(parsed)?.command)
  return command !== null && /(?:^|\s)(?:pnpm|npm|yarn|cargo)?\s*(?:test|check|build)|curl\b|playwright\b|health(?:check)?\b/iu.test(command)
}

function isShellTool(name: string): boolean {
  return /(?:bash|shell|exec|terminal|command)/iu.test(name)
}

/** An explicit raw PID/name termination command cannot be rebound to a current owned job during later reuse. */
function isUngovernedProcessTermination(attempt: ToolAttempt): boolean {
  if (!isShellTool(attempt.name)) return false
  const parsed = parseJson(typeof attempt.arguments === 'string' ? attempt.arguments : '')
  const command = stringValue(asRecord(parsed)?.command)
  return command !== null
    && /(?:^|[;&|()\n]\s*)(?:(?:then|do|else|sudo|command)\s+)*(?:kill|killall|pkill)(?=\s|$)/u.test(command)
}

function toolResultText(data: Record<string, unknown> | undefined): string {
  const content = asRecord(data?.message)?.content
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => {
    const value = asRecord(block)
    return value?.type === 'text' && typeof value.text === 'string' ? [value.text] : []
  }).join('\n')
}

function bounded(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function number(value: unknown): number {
  return Number.isSafeInteger(value) ? value as number : -1
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
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  const json = JSON.stringify(value)
  if (json === undefined) throw new TypeError('suggestion digest contains a non-JSON value')
  return json
}
