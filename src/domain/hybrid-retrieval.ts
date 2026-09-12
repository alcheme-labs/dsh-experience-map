import { randomUUID } from 'node:crypto'
import MiniSearch from 'minisearch'
import { TYPE_BEHAVIORS } from './behavior.js'
import type { ExperienceKind } from './kind.js'
import { projectExperienceVersion, type RetrievalTaskQueryView } from './retrieval-projector.js'
import {
  matchExperienceProjection,
  tokenizeRetrievalText,
  type ExperienceMatchProjection,
  type MatchingEligibility,
} from './planning.js'
import { brandedId } from '../ids.js'
import type {
  ExperienceRetrievalProjectionView,
  MatchCandidateView,
  MatchSetView,
} from '../types.js'

export const CONSERVATIVE_HYBRID_RETRIEVAL_VERSION = 'conservative-hybrid-v1' as const
export const CONSERVATIVE_HYBRID_POLICY_VERSION = 'conservative-hybrid-policy-v2' as const
export const AUTOMATIC_DENSE_APPLICABLE_KINDS = ['diagnostic', 'procedure'] as const satisfies readonly ExperienceKind[]
const LEXICAL_MINIMUM_OVERLAP = 2
const LEXICAL_RELATIVE_MARGIN = 0.1
const RRF_K = 60

export interface DenseApplicabilityProfile {
  readonly profileDigest: string
  readonly allowedKinds: readonly ExperienceKind[]
}

/** Immutable query-side operation prepared before the canonical SQLite read snapshot. */
export interface HybridRetrievalOperation {
  readonly query: RetrievalTaskQueryView
  readonly projection: ExperienceRetrievalProjectionView | null
  readonly vectors: ReadonlyMap<string, Float32Array>
  readonly queryVector: Float32Array | null
  readonly queryEmbeddingReceiptId: string | null
  readonly denseState: 'disabled' | 'ready' | 'unavailable' | 'stale_generation'
  readonly denseFailureCode: string | null
  readonly denseSimilarityThreshold: number
  readonly denseMargin: number
  /** Null means explicit/manual dense use, or no calibrated automatic dense profile. */
  readonly denseApplicabilityProfile: DenseApplicabilityProfile | null
  readonly recallDecisionKey: string | null
}

interface RankedProjection {
  readonly projection: ExperienceMatchProjection
  readonly baseline: MatchCandidateView
  readonly documentId: string
  readonly lexicalText: string
  readonly denseVector: Float32Array | null
  readonly focusDeferredToDense: boolean
  readonly hardRejected: boolean
  readonly hardReasons: readonly string[]
}

const BASELINE_NON_REJECTION_REASONS = new Set([
  'lexical_and_structural_match', 'lexical_match_only', 'structural_match_only',
  'independent_build_check_retained', 'exact_signal_match', 'alias_match',
  'automatic_focus_not_matched',
])

interface LexicalDocument {
  readonly id: string
  readonly title: string
  readonly text: string
}

/**
 * Run hard eligibility first, then independent BM25+ and exact dense scans, deterministic
 * RRF, type/evidence gates and top-one-or-abstain. Only the primary projection may flow
 * into authoritative Version readback and composition; runners remain explanation data.
 */
export function selectHybridMatchingExperiences(
  fingerprint: Parameters<typeof matchExperienceProjection>[0],
  versions: Iterable<ExperienceMatchProjection>,
  candidateLimit: number,
  now: string,
  eligibility: MatchingEligibility,
  operation: HybridRetrievalOperation,
): { readonly matchSet: MatchSetView; readonly selectedProjections: ExperienceMatchProjection[] } {
  const sidecarDocuments = new Map((operation.projection?.documents ?? [])
    .map(document => [String(document.experienceVersionId), document]))
  const automatic = operation.recallDecisionKey !== null
  const ranked: RankedProjection[] = []
  for (const projection of versions) {
    const baseline = matchExperienceProjection(fingerprint, projection, eligibility)
    const projected = projectExperienceVersion(projection)
    const sidecar = sidecarDocuments.get(String(projection.experienceVersionId))
    const freshDocument = sidecar !== undefined
      && sidecar.versionContentDigest === projection.contentDigest
      && sidecar.contentDigest === projected.contentDigest
      && sidecar.projectionVersion === operation.query.projectionVersion
    const typeReasons = typeEvidenceRejections(projection)
    const automaticReasons = automaticEligibilityRejections(
      fingerprint.taskText,
      projection,
      projected.fields,
      automatic,
    )
    const denseApplicabilityReasons = operation.queryVector !== null
      && automatic && !automaticDenseKindAllowed(projection.kind, operation)
      ? ['dense_applicability_profile_not_calibrated'] : []
    const focusDeferredToDense = automatic
      && operation.queryVector !== null
      // Procedure goals are the only focus identity calibrated for paraphrase
      // deferral. Diagnostic symptom/authority distinctions must pass the
      // deterministic focus gate even when their vectors and words are close.
      && projection.kind === 'procedure'
      && automaticDenseKindAllowed(projection.kind, operation)
      && rejectedOnlyByAutomaticFocus(baseline)
    ranked.push({
      projection,
      baseline,
      documentId: projected.documentId,
      lexicalText: lexicalValues(projected.fields),
      denseVector: freshDocument ? operation.vectors.get(sidecar.documentId) ?? null : null,
      focusDeferredToDense,
      hardRejected: (baseline.rejected && !focusDeferredToDense)
        || typeReasons.length > 0 || automaticReasons.length > 0,
      hardReasons: unique([
        ...baseline.reasonCodes,
        ...typeReasons,
        ...automaticReasons,
        ...denseApplicabilityReasons,
        ...(freshDocument ? [] : ['retrieval_projection_stale']),
      ]),
    })
  }

  const eligible = ranked.filter(item => !item.hardRejected)
  const lexicalIndex = new MiniSearch<LexicalDocument>({
    fields: ['title', 'text'],
    storeFields: ['id'],
    tokenize: tokenizeRetrievalText,
    searchOptions: { combineWith: 'OR', prefix: false, fuzzy: false, boost: { title: 2 } },
  })
  lexicalIndex.addAll(eligible.map(item => ({
    id: String(item.projection.experienceVersionId),
    title: item.projection.title,
    text: item.lexicalText,
  })))
  const queryLexicalText = lexicalValues(operation.query.fields)
  // The durable explanation limit must not weaken the acceptance margin. Always
  // inspect one runner-up even when the configured output limit is one.
  const rankingLimit = Math.max(candidateLimit, 2)
  const lexicalResults = lexicalIndex.search(queryLexicalText).slice(0, rankingLimit)
  const lexicalRanks = new Map(lexicalResults.map((result, index) => [String(result.id), index + 1]))
  const lexicalScores = new Map(lexicalResults.map(result => [String(result.id), result.score]))
  const lexicalOverlaps = new Map(eligible.map(item => [
    String(item.projection.experienceVersionId),
    overlapCount(queryLexicalText, `${item.projection.title} ${item.lexicalText}`),
  ]))

  const denseResults = operation.queryVector === null ? [] : eligible.flatMap(item => {
    if (!automaticDenseKindAllowed(item.projection.kind, operation)) return []
    if (item.denseVector === null || item.denseVector.length !== operation.queryVector!.length) return []
    return [{ id: String(item.projection.experienceVersionId), score: dot(operation.queryVector!, item.denseVector) }]
  }).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).slice(0, rankingLimit)
  const semanticRanks = new Map(denseResults.map((result, index) => [result.id, index + 1]))
  const semanticScores = new Map(denseResults.map(result => [result.id, result.score]))
  const candidateIds = new Set([...lexicalRanks.keys(), ...semanticRanks.keys()])
  const fused = eligible.filter(item => candidateIds.has(String(item.projection.experienceVersionId)))
    .map(item => {
      const id = String(item.projection.experienceVersionId)
      const lexicalRank = lexicalRanks.get(id) ?? null
      const semanticRank = semanticRanks.get(id) ?? null
      const exact = item.baseline.reasonCodes.includes('exact_signal_match')
      const fusedScore = (lexicalRank === null ? 0 : 1 / (RRF_K + lexicalRank))
        + (semanticRank === null ? 0 : 1 / (RRF_K + semanticRank))
      return { item, lexicalRank, semanticRank, exact, fusedScore }
    }).sort((left, right) => Number(right.exact) - Number(left.exact)
      || right.fusedScore - left.fusedScore
      || (semanticScores.get(String(right.item.projection.experienceVersionId)) ?? -1)
        - (semanticScores.get(String(left.item.projection.experienceVersionId)) ?? -1)
      || (lexicalScores.get(String(right.item.projection.experienceVersionId)) ?? 0)
        - (lexicalScores.get(String(left.item.projection.experienceVersionId)) ?? 0)
      || String(left.item.projection.experienceVersionId).localeCompare(String(right.item.projection.experienceVersionId)))

  const first = fused[0]
  const firstId = first === undefined ? null : String(first.item.projection.experienceVersionId)
  const denseFirst = denseResults[0]
  const denseSecond = denseResults[1]
  const lexicalAccepted = first !== undefined
    && first.lexicalRank === 1
    && ((lexicalOverlaps.get(firstId!) ?? 0) >= LEXICAL_MINIMUM_OVERLAP || first.exact)
    && (lexicalResults[1] === undefined
      || relativeMargin(lexicalResults[0]!.score, lexicalResults[1]!.score) >= LEXICAL_RELATIVE_MARGIN
      || first.exact)
  const denseThresholdMet = first !== undefined
    && first.semanticRank === 1
    && (semanticScores.get(firstId!) ?? -1) >= operation.denseSimilarityThreshold
  const denseAccepted = denseThresholdMet
    && (denseSecond === undefined
      || (denseFirst!.score - denseSecond.score) >= operation.denseMargin
      || first.exact)
  // A failed automatic focus check may only be bridged by the calibrated dense
  // channel. A clear dense margin remains sufficient; when dense neighbours are
  // tightly clustered, an independent BM25 winner may corroborate the same
  // dense-first candidate. Lexical evidence can never bridge focus on its own.
  const focusCorroborated = first?.item.focusDeferredToDense === true
    && denseThresholdMet && lexicalAccepted
  const accepted = first !== undefined && (first.exact
    || (!first.item.focusDeferredToDense && lexicalAccepted)
    || denseAccepted
    || focusCorroborated)
  const primaryId = accepted ? firstId : null
  const candidates: MatchCandidateView[] = fused.slice(0, candidateLimit).map(entry => {
    const id = String(entry.item.projection.experienceVersionId)
    const primary = id === primaryId
    return {
      ...entry.item.baseline,
      rejected: primary ? false : entry.item.baseline.rejected,
      selectedComponentRevisionIds: primary ? entry.item.projection.componentRevisionIds : [],
      lexicalBm25Score: lexicalScores.get(id) ?? null,
      semanticScore: semanticScores.get(id) ?? null,
      fusedScore: entry.fusedScore,
      lexicalRank: entry.lexicalRank,
      semanticRank: entry.semanticRank,
      reasonCodes: unique([
        ...entry.item.hardReasons.filter(reason =>
          !(primary && entry.item.focusDeferredToDense && reason === 'automatic_focus_not_matched')),
        ...(primary && entry.item.focusDeferredToDense ? ['automatic_focus_satisfied_by_calibrated_dense'] : []),
        ...(primary ? ['primary_hybrid_match'] : ['not_primary_candidate']),
      ]),
    }
  })
  // Keep a bounded explanation for candidates rejected by hard/type gates without allowing
  // those rows to consume the eligible search window or enter Preflight/Composition.
  for (const item of ranked.filter(value => value.hardRejected)) {
    if (candidates.length >= candidateLimit) break
    if (item.baseline.lexicalScore === 0 && item.baseline.structuralScore === 0
      && !item.baseline.reasonCodes.includes('exact_signal_conflict')) continue
    candidates.push({
      ...item.baseline,
      selectedComponentRevisionIds: [],
      lexicalBm25Score: null,
      semanticScore: null,
      fusedScore: null,
      lexicalRank: null,
      semanticRank: null,
      rejected: true,
      reasonCodes: item.hardReasons,
    })
  }
  // An automatic dense candidate outside the calibrated kind set remains visible only as
  // bounded explanation data. It never enters RRF, selection, Preflight, or Composition.
  for (const item of ranked.filter(value => !value.hardRejected
    && value.hardReasons.includes('dense_applicability_profile_not_calibrated')
    && !candidates.some(candidate => candidate.experienceVersionId === value.projection.experienceVersionId))) {
    if (candidates.length >= candidateLimit) break
    if (item.baseline.lexicalScore === 0 && item.baseline.structuralScore === 0) continue
    candidates.push({
      ...item.baseline,
      selectedComponentRevisionIds: [],
      lexicalBm25Score: null,
      semanticScore: null,
      fusedScore: null,
      lexicalRank: null,
      semanticRank: null,
      rejected: true,
      reasonCodes: item.hardReasons,
    })
  }
  const hasUncalibratedDenseCandidate = ranked.some(item =>
    item.hardReasons.includes('dense_applicability_profile_not_calibrated'))
  const abstentionReasonCodes = accepted ? [] : abstentionReasons(
    first,
    lexicalAccepted,
    denseAccepted || focusCorroborated,
    operation,
    hasUncalibratedDenseCandidate,
  )
  const matchSet: MatchSetView = {
    matchSetId: brandedId<'ExperienceMatchSetId'>(randomUUID(), 'matchSetId'),
    fingerprintId: fingerprint.fingerprintId,
    retrievalVersion: CONSERVATIVE_HYBRID_RETRIEVAL_VERSION,
    candidateLimit,
    candidates,
    noMatch: !accepted,
    retrievalDecision: {
      policyVersion: CONSERVATIVE_HYBRID_POLICY_VERSION,
      projectionGeneration: operation.projection?.manifest.generation ?? null,
      projectionContentDigest: operation.projection?.manifest.contentDigest ?? null,
      queryProjectionDigest: operation.query.contentDigest,
      queryEmbeddingReceiptId: operation.queryEmbeddingReceiptId,
      denseState: operation.denseState,
      denseFailureCode: operation.denseFailureCode,
      denseApplicabilityProfileDigest: automatic
        ? operation.denseApplicabilityProfile?.profileDigest ?? null : null,
      denseApplicabilityAllowedKinds: automatic
        ? operation.denseApplicabilityProfile?.allowedKinds ?? [] : null,
      lexicalMinimumOverlap: LEXICAL_MINIMUM_OVERLAP,
      lexicalRelativeMargin: LEXICAL_RELATIVE_MARGIN,
      denseSimilarityThreshold: operation.denseSimilarityThreshold,
      denseMargin: operation.denseMargin,
      rrfK: RRF_K,
      primaryExperienceVersionId: accepted ? first!.item.projection.experienceVersionId : null,
      abstentionReasonCodes,
    },
    recallDecisionKey: operation.recallDecisionKey,
    createdAt: now,
  }
  return {
    matchSet,
    selectedProjections: accepted ? [first!.item.projection] : [],
  }
}

function typeEvidenceRejections(version: ExperienceMatchProjection): string[] {
  const roles = new Set(version.components.map(component => component.role))
  const reasons: string[] = []
  if (TYPE_BEHAVIORS[version.kind].validate(roles).length > 0) reasons.push('type_required_signal_missing')
  const minimumGrade = version.kind === 'procedure' || version.kind === 'diagnostic'
    ? 'observation_supported' as const : 'model_asserted' as const
  if (evidenceRank(version.evidenceGrade) < evidenceRank(minimumGrade)) {
    reasons.push('evidence_gate_not_met')
  }
  return reasons
}

function automaticDenseKindAllowed(kind: ExperienceKind, operation: HybridRetrievalOperation): boolean {
  if (operation.recallDecisionKey === null) return true
  return operation.denseApplicabilityProfile?.allowedKinds.includes(kind) === true
}

/** Only calibrated dense retrieval may replace the conservative lexical focus check. */
function rejectedOnlyByAutomaticFocus(candidate: MatchCandidateView): boolean {
  return candidate.rejected
    && candidate.reasonCodes.includes('automatic_focus_not_matched')
    // Fail closed when planning adds a new rejection reason: dense recall may
    // defer only the one named focus gate, never an unclassified future veto.
    && candidate.reasonCodes.every(reason => BASELINE_NON_REJECTION_REASONS.has(reason))
}

function automaticEligibilityRejections(
  taskText: string,
  version: ExperienceMatchProjection,
  fields: RetrievalTaskQueryView['fields'],
  automatic: boolean,
): string[] {
  if (!automatic) return []
  const reasons: string[] = []
  if (version.privacyClass === 'restricted' || version.privacyClass === 'secret_reference_only') {
    reasons.push('automatic_context_privacy_not_allowed')
  }
  if (explicitlyForbiddenActionConflict(taskText, fields)) reasons.push('explicit_task_forbidden_action')
  return reasons
}

const NEGATION_STOP_TOKENS = new Set([
  'avoid', 'call', 'check', 'execute', 'inspect', 'run', 'use',
  '不要', '不得', '不用', '无需', '不应', '不能', '禁止', '明确', '别',
  '使用', '调用', '执行', '检查', '查看', '进行',
])

/** A deterministic safety veto; it is not a general natural-language entailment model. */
function explicitlyForbiddenActionConflict(
  taskText: string,
  fields: RetrievalTaskQueryView['fields'],
): boolean {
  const forbidden = negatedActionTokens(taskText)
  if (forbidden.size === 0) return false
  // These are the existing role-aware retrieval buckets produced by projectExperienceVersion.
  // Consuming them here avoids a second action/focus role ontology in the matcher.
  const positiveText = [...fields.goalOrIntent, ...fields.capabilitiesOrTools].join(' ')
  const positive = new Set(tokenizeRetrievalText(positiveText))
  for (const token of negatedActionTokens(positiveText)) positive.delete(token)
  return [...forbidden].some(token => positive.has(token))
}

function negatedActionTokens(text: string): Set<string> {
  const segments: string[] = []
  const patterns = [
    /(?:不要|不得|不用|无需|不应|不能|禁止)\s*([^，,。！？；;\n]+)/giu,
    // `别` is a standalone imperative only at a clause boundary. Matching it
    // anywhere would misread words such as `分别` and `区别` as prohibitions.
    /(?:^|[，,。！？；;\n])\s*别\s*([^，,。！？；;\n]+)/giu,
    /(?:不检查|不查看|不使用|不调用|不执行|不运行|不访问|不修改|不删除|不写入|不读取)\s*([^，,。！？；;\n]+)/giu,
    /(?:do\s+not|don't|must\s+not|never|avoid)\s+([^,.!?;\n]+)/giu,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) if (match[1] !== undefined) segments.push(match[1])
  }
  const tokens = unique(segments.flatMap(tokenizeRetrievalText))
  const specific = tokens.filter(token => !NEGATION_STOP_TOKENS.has(token))
  return new Set(specific.length > 0 ? specific : tokens)
}

function evidenceRank(value: ExperienceMatchProjection['evidenceGrade']): number {
  switch (value) {
    case 'model_asserted': return 0
    case 'observation_supported': return 1
    case 'mechanism_supported': return 2
    case 'intervention_supported': return 3
    case 'counterfactual_supported': return 4
  }
}

function lexicalValues(fields: RetrievalTaskQueryView['fields']): string {
  return Object.values(fields).flat().join(' ')
}

function overlapCount(left: string, right: string): number {
  const rightTokens = new Set(tokenizeRetrievalText(right))
  return new Set(tokenizeRetrievalText(left).filter(token => rightTokens.has(token))).size
}

function dot(left: Float32Array, right: Float32Array): number {
  let total = 0
  for (let index = 0; index < left.length; index += 1) total += left[index]! * right[index]!
  return total
}

function relativeMargin(first: number, second: number): number {
  return first <= 0 ? 0 : (first - second) / first
}

function abstentionReasons(
  first: { readonly exact: boolean } | undefined,
  lexicalAccepted: boolean,
  denseAccepted: boolean,
  operation: HybridRetrievalOperation,
  hasUncalibratedDenseCandidate: boolean,
): string[] {
  if (first === undefined) return unique([
    'no_hard_eligible_candidate',
    ...(hasUncalibratedDenseCandidate ? ['dense_applicability_profile_not_calibrated'] : []),
    ...(operation.denseFailureCode === 'embedding_applicability_not_calibrated'
      ? ['dense_applicability_profile_not_calibrated'] : []),
  ])
  const reasons: string[] = []
  if (!lexicalAccepted) reasons.push('lexical_threshold_not_met')
  if (hasUncalibratedDenseCandidate) reasons.push('dense_applicability_profile_not_calibrated')
  if (!denseAccepted) reasons.push(operation.denseFailureCode === 'embedding_applicability_not_calibrated'
    ? 'dense_applicability_profile_not_calibrated'
    : operation.queryVector === null ? 'dense_unavailable' : 'dense_threshold_or_margin_not_met')
  return unique(reasons)
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}
