import { suggestionDigest } from '../domain/automatic-suggestion.js'
import { TYPE_BEHAVIORS } from '../domain/behavior.js'
import {
  experienceComparisonSetDigest,
  experienceComponentIdentityClass,
  experienceHardScopeMatches,
  experienceKernelIdentity,
  normalizeKernelText,
} from '../domain/experience-kernel.js'
import { projectExperienceVersion } from '../domain/retrieval-projector.js'
import {
  isPolicyDerivedSuggestionComponentRole,
  mergeSuggestionDraftSources,
  suggestionDecisionDigests,
  suggestionSourceGroupIds,
} from '../domain/suggestion-materializer.js'
import type {
  ComponentRole,
  ExperienceCandidateDraft,
  ExperienceSuggestionGroupView,
  ExperienceVersionView,
  SuggestionMaterialDifferenceInput,
} from '../types.js'
import type { RuntimeSettingsSnapshot } from '../runtime-settings.js'
import type { RetrievalProjectionInternalView } from '../persistence/projection-store.js'
import type { LocalEmbeddingConfig } from '../adapters/local-embedding.js'
import {
  localEmbeddingConfig,
  sameModel,
  type EmbeddingProviderPort,
} from './retrieval-projection.js'
import {
  EQUIVALENCE_EVIDENCE_MANIFEST_SHA256,
  EXPERIENCE_EQUIVALENCE_ALGORITHM_VERSION,
  localEmbeddingModelIdentityDigest,
  semanticEquivalenceCalibrated,
} from './local-semantic-calibration.js'

export { EQUIVALENCE_EVIDENCE_MANIFEST_SHA256, EXPERIENCE_EQUIVALENCE_ALGORITHM_VERSION }
const MAX_EQUIVALENCE_GROUPS = 128
const MAX_RECENT_NEIGHBOURS = 3
const MAX_PUBLISHED_NEIGHBOURS = 3
const MIN_EQUIVALENCE_MARGIN = 0.03
const MIN_EQUIVALENCE_SHORTLIST_SIMILARITY = 0.88
const MIN_COMPONENT_EQUIVALENCE_SIMILARITY = 0.89

type Correspondence = NonNullable<ExperienceSuggestionGroupView['consolidationDetail']>['componentCorrespondence'][number]
type EquivalenceDecision = NonNullable<ExperienceSuggestionGroupView['consolidationDetail']>['decision']

interface PairDecision {
  readonly decision: EquivalenceDecision
  readonly reasonCodes: readonly string[]
  readonly correspondence: readonly Correspondence[]
  readonly materialDifferences: readonly SuggestionMaterialDifferenceInput[]
}

interface GroupProjection {
  readonly group: ExperienceSuggestionGroupView
  readonly vector: Float32Array
}

interface PublishedMatch {
  readonly version: ExperienceVersionView
  readonly similarity: number
}

/**
 * Consolidate bounded recent suggestions first, then compare their stable representatives
 * with an aligned canonical Version snapshot. Dense similarity only creates candidates;
 * the role-aware component gate is the sole authority for semantic `same`.
 */
export async function consolidatePublishedSuggestionDuplicates(
  groups: readonly ExperienceSuggestionGroupView[],
  retrieval: RetrievalProjectionInternalView,
  versions: readonly ExperienceVersionView[],
  runtime: RuntimeSettingsSnapshot,
  embedding: EmbeddingProviderPort,
  signal?: AbortSignal,
): Promise<ExperienceSuggestionGroupView[]> {
  if (groups.length === 0 || runtime.values.embeddingProvider !== 'transformers_js') return [...groups]
  const config = localEmbeddingConfig(runtime)
  if (!manifestMatches(retrieval, config)) return [...groups]

  const orderedGroups = [...groups]
    .sort((left, right) => left.suggestionGroupId.localeCompare(right.suggestionGroupId))
  const bounded = orderedGroups.slice(0, MAX_EQUIVALENCE_GROUPS)
  const overflow = orderedGroups.slice(MAX_EQUIVALENCE_GROUPS)
  const documents = bounded.map(group => ({
    group,
    document: projectExperienceVersion({
      experienceId: group.suggestionGroupId as never,
      experienceVersionId: group.suggestionGroupId as never,
      kind: group.kind,
      title: group.draft.title,
      intent: group.draft.intent,
      scope: group.draft.scope,
      validity: group.draft.validity,
      riskAndEffectSpec: group.draft.riskAndEffectSpec,
      contentDigest: group.kernelIdentity,
      components: group.draft.components,
    }),
  }))
  const groupResult = await embedding.embedBatch(
    `suggestion-equivalence:${retrieval.projection.manifest.generation}:${suggestionDigest(documents.map(item => item.group.revisionDigest))}`,
    documents.map(item => item.document.denseText),
    'query',
    config,
    signal,
  )
  if (!sameModel(groupResult, config, 'query') || groupResult.vectors.length !== documents.length) return [...groups]
  const projected: GroupProjection[] = documents.map((item, index) => ({
    group: item.group,
    vector: groupResult.vectors[index]!,
  }))

  const alignedVersions = alignedCanonicalVersions(retrieval, versions)
  const threshold = Math.max(MIN_EQUIVALENCE_SHORTLIST_SIMILARITY, runtime.values.equivalenceSimilarityThreshold)
  const recentCandidates = recentPairCandidates(projected, threshold)
  const publishedCandidates = publishedPairCandidates(
    projected,
    retrieval,
    alignedVersions,
    threshold,
  )
  const componentVectors = await embedComponentCandidates(
    projected,
    recentCandidates,
    publishedCandidates,
    config,
    embedding,
    retrieval.projection.manifest.generation,
    signal,
  )
  if (componentVectors === null) return [...groups]

  const recentDecisions = new Map<string, PairDecision>()
  for (const [left, right] of recentCandidates) {
    recentDecisions.set(pairKey(left.group.suggestionGroupId, right.group.suggestionGroupId), compareComponents(
      left.group.suggestionGroupId,
      left.group.draft,
      right.group.draft,
      null,
      componentVectors,
      MIN_COMPONENT_EQUIVALENCE_SIMILARITY,
    ))
  }
  const recent = consolidateRecentGroups(projected, recentDecisions, retrieval, alignedVersions, runtime, config)
  const result = recent.map(group => resolvePublishedDecision(
    group,
    publishedCandidates.get(representativeSourceGroupId(group)) ?? [],
    componentVectors,
    retrieval,
    alignedVersions,
    runtime,
    config,
  ))
  return [...result, ...overflow]
    .sort((left, right) => left.suggestionGroupId.localeCompare(right.suggestionGroupId))
}

function manifestMatches(retrieval: RetrievalProjectionInternalView, config: LocalEmbeddingConfig): boolean {
  const manifest = retrieval.projection.manifest
  return (manifest.providerState === 'ready' || manifest.providerState === 'configured')
    && manifest.modelId === config.modelId && manifest.modelRevision === config.revision
    && manifest.artifactSha256 === config.artifactSha256 && manifest.dimension === config.dimension
    && manifest.dtype === config.dtype && manifest.pooling === config.pooling
    && manifest.queryPrefix === config.queryPrefix && manifest.passagePrefix === config.passagePrefix
    && manifest.tokenizerConfigBundleSha256 === config.tokenizerConfigBundleSha256
    && manifest.normalization === config.normalization && manifest.maxInputTokens === config.maxInputTokens
    && manifest.truncationPolicy === config.truncationPolicy
}

function recentPairCandidates(
  groups: readonly GroupProjection[],
  threshold: number,
): Array<readonly [GroupProjection, GroupProjection]> {
  const candidates = new Map<string, readonly [GroupProjection, GroupProjection]>()
  for (const left of groups) {
    const neighbours = groups.filter(right => right.group.suggestionGroupId !== left.group.suggestionGroupId
      && right.group.kind === left.group.kind
      && experienceHardScopeMatches(left.group.draft.scope, right.group.draft.scope))
      .map(right => ({ right, similarity: cosine(left.vector, right.vector) }))
      .filter(item => Number.isFinite(item.similarity) && item.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity
        || a.right.group.suggestionGroupId.localeCompare(b.right.group.suggestionGroupId))
      .slice(0, MAX_RECENT_NEIGHBOURS)
    for (const { right } of neighbours) {
      const ordered = left.group.suggestionGroupId.localeCompare(right.group.suggestionGroupId) <= 0
        ? [left, right] as const : [right, left] as const
      candidates.set(pairKey(ordered[0].group.suggestionGroupId, ordered[1].group.suggestionGroupId), ordered)
    }
  }
  return [...candidates.values()].sort((left, right) =>
    pairKey(left[0].group.suggestionGroupId, left[1].group.suggestionGroupId)
      .localeCompare(pairKey(right[0].group.suggestionGroupId, right[1].group.suggestionGroupId)))
}

function publishedPairCandidates(
  groups: readonly GroupProjection[],
  retrieval: RetrievalProjectionInternalView,
  versions: ReadonlyMap<string, ExperienceVersionView>,
  threshold: number,
): ReadonlyMap<string, readonly PublishedMatch[]> {
  return new Map(groups.map(item => {
    const matches = retrieval.projection.documents
      .filter(document => document.kind === item.group.kind
        && experienceHardScopeMatches(item.group.draft.scope, scopeFromFields(document.fields.scope)))
      .flatMap(document => {
        const vector = retrieval.vectors.get(document.documentId)
        const version = versions.get(document.experienceVersionId)
        if (vector === undefined || version === undefined || version.contentDigest !== document.versionContentDigest) return []
        return [{ version, similarity: cosine(item.vector, vector) }]
      })
      .filter(match => Number.isFinite(match.similarity) && match.similarity >= threshold)
      .sort((left, right) => right.similarity - left.similarity
        || left.version.experienceVersionId.localeCompare(right.version.experienceVersionId))
      .slice(0, MAX_PUBLISHED_NEIGHBOURS)
    return [item.group.suggestionGroupId, matches] as const
  }))
}

async function embedComponentCandidates(
  groups: readonly GroupProjection[],
  recent: readonly (readonly [GroupProjection, GroupProjection])[],
  published: ReadonlyMap<string, readonly PublishedMatch[]>,
  config: LocalEmbeddingConfig,
  embedding: EmbeddingProviderPort,
  retrievalGeneration: number,
  signal: AbortSignal | undefined,
): Promise<ReadonlyMap<string, Float32Array> | null> {
  const texts = new Map<string, string>()
  const add = (kind: string, draft: Pick<ExperienceCandidateDraft, 'components'>): void => {
    for (const component of draft.components) {
      const key = componentVectorKey(kind, component.role, component.content)
      texts.set(key, `equivalence ${kind} ${component.role}: ${normalizeKernelText(component.content)}`)
    }
  }
  for (const [left, right] of recent) {
    add(left.group.kind, left.group.draft)
    add(right.group.kind, right.group.draft)
  }
  const groupById = new Map(groups.map(group => [group.group.suggestionGroupId, group] as const))
  for (const [groupId, matches] of published) {
    const source = groupById.get(groupId)
    if (source !== undefined) add(source.group.kind, source.group.draft)
    for (const match of matches) add(match.version.kind, { components: match.version.components })
  }
  if (texts.size === 0) return new Map()
  const entries = [...texts.entries()].sort(([left], [right]) => left.localeCompare(right))
  const result = await embedding.embedBatch(
    `suggestion-equivalence-components:${retrievalGeneration}:${suggestionDigest(entries.map(([key]) => key))}`,
    entries.map(([, text]) => text),
    'query',
    config,
    signal,
  )
  if (!sameModel(result, config, 'query') || result.vectors.length !== entries.length) return null
  return new Map(entries.map(([key], index) => [key, result.vectors[index]!] as const))
}

function consolidateRecentGroups(
  projected: readonly GroupProjection[],
  decisions: ReadonlyMap<string, PairDecision>,
  retrieval: RetrievalProjectionInternalView,
  versions: ReadonlyMap<string, ExperienceVersionView>,
  runtime: RuntimeSettingsSnapshot,
  config: LocalEmbeddingConfig,
): ExperienceSuggestionGroupView[] {
  const assigned = new Set<string>()
  const result: ExperienceSuggestionGroupView[] = []
  for (const representative of projected) {
    const representativeId = representative.group.suggestionGroupId
    if (assigned.has(representativeId) || !recentSemanticEligible(representative.group)
      || !semanticSameCalibrated(config, representative.group.kind)) continue
    const cluster = [representative]
    for (const candidate of projected) {
      if (candidate.group.suggestionGroupId <= representativeId || assigned.has(candidate.group.suggestionGroupId)
        || !recentSemanticEligible(candidate.group) || candidate.group.kind !== representative.group.kind) continue
      const compatibleWithEveryMember = cluster.every(member =>
        decisions.get(pairKey(member.group.suggestionGroupId, candidate.group.suggestionGroupId))?.decision === 'same')
      if (compatibleWithEveryMember) cluster.push(candidate)
    }
    if (cluster.length < 2) continue
    for (const member of cluster) assigned.add(member.group.suggestionGroupId)
    result.push(compositeRecentGroup(cluster, decisions, retrieval, versions, runtime, config))
  }
  const projectedById = new Map(projected.map(item => [item.group.suggestionGroupId, item] as const))
  const threshold = Math.max(
    MIN_EQUIVALENCE_SHORTLIST_SIMILARITY,
    runtime.values.equivalenceSimilarityThreshold,
  )
  for (const item of projected) {
    if (!assigned.has(item.group.suggestionGroupId)) {
      result.push(resolveProvisionalRecentDifference(item, projectedById, decisions, config, threshold))
    }
  }
  return result
}

function recentSemanticEligible(group: ExperienceSuggestionGroupView): boolean {
  if (group.saveReadiness === 'ready') return true
  return group.saveReadiness === 'needs_review'
    && group.missingFields.length === 0
    && group.relatedGroupIds.length > 0
    && group.readinessReasons.includes('possible_duplicate')
    && !group.readinessReasons.includes('exact_identity_component_conflict')
}

function resolveProvisionalRecentDifference(
  item: GroupProjection,
  projectedById: ReadonlyMap<string, GroupProjection>,
  decisions: ReadonlyMap<string, PairDecision>,
  config: LocalEmbeddingConfig,
  threshold: number,
): ExperienceSuggestionGroupView {
  const { group } = item
  if (!recentSemanticEligible(group) || !semanticSameCalibrated(config, group.kind)
    || !group.relatedGroupIds.every(relatedId => projectedById.has(relatedId))) return group
  const allDifferent = group.relatedGroupIds.every(relatedId => {
    const decision = decisions.get(pairKey(group.suggestionGroupId, relatedId))
    if (decision !== undefined) return decision.decision === 'different'
    const related = projectedById.get(relatedId)!
    const similarity = cosine(item.vector, related.vector)
    return Number.isFinite(similarity) && similarity < threshold
  })
  if (!allDifferent) return group
  const resolved: ExperienceSuggestionGroupView = {
    ...group,
    consolidation: 'distinct',
    saveReadiness: 'ready',
    readinessReasons: group.readinessReasons.filter(reason => reason !== 'possible_duplicate'),
    reviewDigest: null,
    relatedGroupIds: [],
  }
  return withDecisionDigests(resolved)
}

function compositeRecentGroup(
  cluster: readonly GroupProjection[],
  decisions: ReadonlyMap<string, PairDecision>,
  retrieval: RetrievalProjectionInternalView,
  versions: ReadonlyMap<string, ExperienceVersionView>,
  runtime: RuntimeSettingsSnapshot,
  config: LocalEmbeddingConfig,
): ExperienceSuggestionGroupView {
  const ordered = [...cluster].sort((left, right) =>
    left.group.suggestionGroupId.localeCompare(right.group.suggestionGroupId))
  const representative = ordered[0]!.group
  const sourceIds = ordered.map(item => item.group.suggestionGroupId)
  const mappings = ordered.slice(1).map(member => ({
    draft: member.group.draft,
    correspondence: decisions.get(pairKey(representative.suggestionGroupId, member.group.suggestionGroupId))!
      .correspondence.map(item => ({
        incomingComponentKey: item.incomingComponentKey,
        targetComponentKey: item.targetComponentKey,
      })),
  }))
  const draft = mergeSuggestionDraftSources(representative.draft, mappings)
  const occurrences = ordered.flatMap(item => item.group.occurrences)
    .sort((left, right) => left.occurrenceId.localeCompare(right.occurrenceId))
  const sessionIds = unique(occurrences.map(occurrence => occurrence.sessionId))
  const selfCorrespondence = representative.draft.components.map(component => ({
    incomingSuggestionGroupId: representative.suggestionGroupId,
    incomingComponentKey: component.componentKey,
    incomingRole: component.role,
    incomingContentDigest: suggestionDigest(normalizeKernelText(component.content)),
    targetComponentKey: component.componentKey,
    targetComponentRevisionId: null,
    targetRole: component.role,
    targetContentDigest: suggestionDigest(normalizeKernelText(component.content)),
    matchBasis: 'exact' as const,
  }))
  const memberCorrespondence = ordered.slice(1).flatMap(member =>
    decisions.get(pairKey(representative.suggestionGroupId, member.group.suggestionGroupId))!.correspondence
      .map(item => ({ ...item, incomingSuggestionGroupId: member.group.suggestionGroupId })))
  const groupId = `suggestion-group:semantic:${suggestionDigest(sourceIds).slice('sha256:'.length)}`
  const base: ExperienceSuggestionGroupView = {
    ...representative,
    suggestionGroupId: groupId,
    draft,
    sourceDigest: suggestionDigest(occurrences.map(occurrence => ({
      occurrenceId: occurrence.occurrenceId,
      episodeDigest: occurrence.episodeRef.contentDigest,
      sourceDigests: occurrence.sourceRefs.map(ref => ref.contentDigest).sort(),
    }))),
    reviewDigest: null,
    consolidation: 'semantic_consolidated',
    saveReadiness: 'ready',
    readinessReasons: representative.readinessReasons.filter(reason => reason !== 'possible_duplicate'),
    consolidationDetail: {
      algorithmVersion: EXPERIENCE_EQUIVALENCE_ALGORITHM_VERSION,
      decision: 'same',
      reasonCodes: ['recent_component_correspondence_complete'],
      sourceSuggestionGroupIds: sourceIds,
      sourceGroups: ordered.map(item => ({
        suggestionGroupId: item.group.suggestionGroupId,
        kernelIdentity: item.group.kernelIdentity,
        revisionDigest: item.group.revisionDigest,
        occurrenceIds: item.group.occurrences.map(occurrence => occurrence.occurrenceId).sort(),
      })),
      targetExperienceId: null,
      targetExperienceVersionId: null,
      targetVersionContentDigest: null,
      retrievalGeneration: retrieval.projection.manifest.generation,
      modelIdentityDigest: localEmbeddingModelIdentityDigest(config),
      operationSettingsDigest: equivalenceSettingsDigest(runtime, config),
      activeComparisonSetDigest: experienceComparisonSetDigest(
        { kind: representative.kind, scope: representative.draft.scope },
        [...versions.values()],
      ),
      allowedOwnerChoices: [],
      componentCorrespondence: [...selfCorrespondence, ...memberCorrespondence],
      materialDifferences: [],
    },
    relatedGroupIds: sourceIds,
    occurrences,
    occurrenceCount: occurrences.length,
    sessionIds,
    crossSession: sessionIds.length > 1,
    detectorVersions: unique(ordered.flatMap(item => item.group.detectorVersions)),
    segmenterVersions: unique(ordered.flatMap(item => item.group.segmenterVersions)),
    expiresAt: ordered.map(item => item.group.expiresAt).sort().at(-1)!,
  }
  return withDecisionDigests(base)
}

function resolvePublishedDecision(
  group: ExperienceSuggestionGroupView,
  matches: readonly PublishedMatch[],
  vectors: ReadonlyMap<string, Float32Array>,
  retrieval: RetrievalProjectionInternalView,
  versions: ReadonlyMap<string, ExperienceVersionView>,
  runtime: RuntimeSettingsSnapshot,
  config: LocalEmbeddingConfig,
): ExperienceSuggestionGroupView {
  const currentMatches = matches.filter(match => versions.has(match.version.experienceVersionId))
  const best = currentMatches[0]
  if (best === undefined) return group.consolidationDetail?.targetExperienceVersionId === null
    ? group
    : withDecisionDigests({
      ...group,
      consolidationDetail: {
        algorithmVersion: EXPERIENCE_EQUIVALENCE_ALGORITHM_VERSION,
        decision: 'different',
        reasonCodes: ['published_shortlist_empty'],
        sourceSuggestionGroupIds: [group.suggestionGroupId],
        sourceGroups: [{
          suggestionGroupId: group.suggestionGroupId,
          kernelIdentity: group.kernelIdentity,
          revisionDigest: group.revisionDigest,
          occurrenceIds: group.occurrences.map(occurrence => occurrence.occurrenceId).sort(),
        }],
        targetExperienceId: null,
        targetExperienceVersionId: null,
        targetVersionContentDigest: null,
        retrievalGeneration: retrieval.projection.manifest.generation,
        modelIdentityDigest: localEmbeddingModelIdentityDigest(config),
        operationSettingsDigest: equivalenceSettingsDigest(runtime, config),
        activeComparisonSetDigest: experienceComparisonSetDigest(
          { kind: group.kind, scope: group.draft.scope },
          [...versions.values()],
        ),
        allowedOwnerChoices: [],
        componentCorrespondence: [],
        materialDifferences: [],
      },
    })
  const pair = compareComponents(
    group.suggestionGroupId,
    group.draft,
    { components: best.version.components },
    best.version,
    vectors,
    MIN_COMPONENT_EQUIVALENCE_SIMILARITY,
  )
  const comparisonDigest = experienceComparisonSetDigest(
    { kind: group.kind, scope: group.draft.scope },
    [...versions.values()],
  )
  const detail = decisionDetail(group, best, pair, retrieval, runtime, config, comparisonDigest)
  const canonicalMatch = canonicalMatchFor(best, retrieval, config)
  if (group.saveReadiness !== 'ready') {
    return withDecisionDigests({
      ...group,
      readinessReasons: unique([...group.readinessReasons, 'semantic_duplicate_incomplete']),
      reviewDigest: null,
      consolidation: 'possible_duplicate',
      consolidationDetail: { ...detail, decision: 'ambiguous', reasonCodes: ['suggestion_fields_incomplete'] },
      relatedExperienceVersionIds: unique(currentMatches.map(match => match.version.experienceVersionId)),
    })
  }
  const exactKernelCollision = experienceKernelIdentity({
    kind: group.kind,
    scope: group.draft.scope,
    components: group.draft.components,
  }) === experienceKernelIdentity({
    kind: best.version.kind,
    scope: best.version.scope,
    components: best.version.components,
  })
  if (exactKernelCollision && pair.decision !== 'same') {
    return withDecisionDigests({
      ...group,
      saveReadiness: 'needs_review',
      readinessReasons: unique([...group.readinessReasons, 'exact_kernel_component_conflict']),
      reviewDigest: null,
      consolidation: 'possible_duplicate',
      canonicalMatch,
      consolidationDetail: {
        ...detail,
        decision: 'ambiguous',
        reasonCodes: unique(['exact_kernel_component_conflict', ...pair.reasonCodes]),
        allowedOwnerChoices: [],
      },
      relatedExperienceVersionIds: unique(currentMatches.map(match => match.version.experienceVersionId)),
    })
  }
  if (pair.decision === 'same' && !semanticSameCalibrated(config, group.kind)) {
    return withDecisionDigests({
      ...group,
      saveReadiness: group.saveReadiness === 'ready' ? 'needs_review' : group.saveReadiness,
      readinessReasons: unique([...group.readinessReasons, 'semantic_same_profile_not_calibrated']),
      reviewDigest: null,
      consolidation: 'possible_duplicate',
      consolidationDetail: { ...detail, decision: 'ambiguous', reasonCodes: ['model_kind_not_calibrated'] },
      relatedExperienceVersionIds: unique(currentMatches.map(match => match.version.experienceVersionId)),
    })
  }
  const runnerUp = currentMatches[1]
  const runnerDecision = runnerUp === undefined ? null : compareComponents(
    group.suggestionGroupId,
    group.draft,
    { components: runnerUp.version.components },
    runnerUp.version,
    vectors,
    MIN_COMPONENT_EQUIVALENCE_SIMILARITY,
  )
  const marginAmbiguous = pair.decision === 'same' && runnerUp !== undefined
    && best.similarity - runnerUp.similarity < Math.max(MIN_EQUIVALENCE_MARGIN, runtime.values.equivalenceMargin)
    && runnerDecision?.decision !== 'different'
  if (marginAmbiguous) {
    return withDecisionDigests({
      ...group,
      saveReadiness: group.saveReadiness === 'ready' ? 'needs_review' : group.saveReadiness,
      readinessReasons: unique([...group.readinessReasons, 'semantic_duplicate_ambiguous']),
      reviewDigest: null,
      consolidation: 'possible_duplicate',
      canonicalMatch,
      consolidationDetail: {
        ...detail,
        decision: 'ambiguous',
        reasonCodes: ['published_shortlist_margin_ambiguous'],
        allowedOwnerChoices: group.saveReadiness === 'ready' ? ['attach_existing'] : [],
      },
      relatedExperienceVersionIds: unique(currentMatches.map(match => match.version.experienceVersionId)),
    })
  }
  if (pair.decision === 'same') {
    return withDecisionDigests({
      ...group,
      consolidation: 'semantic_duplicate',
      canonicalMatch,
      consolidationDetail: detail,
      relatedExperienceVersionIds: unique(currentMatches.map(match => match.version.experienceVersionId)),
    })
  }
  if (pair.decision === 'specialization') {
    return withDecisionDigests({
      ...group,
      saveReadiness: group.saveReadiness === 'ready' ? 'needs_review' : group.saveReadiness,
      readinessReasons: unique([...group.readinessReasons, 'semantic_specialization_review']),
      reviewDigest: null,
      consolidation: 'specialization',
      canonicalMatch,
      consolidationDetail: {
        ...detail,
        allowedOwnerChoices: group.saveReadiness === 'ready' && group.kind !== 'strategy' && group.kind !== 'causal'
          ? ['keep_distinct'] : [],
      },
      relatedExperienceVersionIds: unique(currentMatches.map(match => match.version.experienceVersionId)),
    })
  }
  if (pair.decision === 'ambiguous') {
    return withDecisionDigests({
      ...group,
      saveReadiness: group.saveReadiness === 'ready' ? 'needs_review' : group.saveReadiness,
      readinessReasons: unique([...group.readinessReasons, 'semantic_duplicate_ambiguous']),
      reviewDigest: null,
      consolidation: 'possible_duplicate',
      consolidationDetail: detail,
      relatedExperienceVersionIds: unique(currentMatches.map(match => match.version.experienceVersionId)),
    })
  }
  return withDecisionDigests({
    ...group,
    consolidation: group.consolidation === 'semantic_consolidated' ? group.consolidation : 'distinct',
    consolidationDetail: detail,
    relatedExperienceVersionIds: unique(currentMatches.map(match => match.version.experienceVersionId)),
  })
}

function decisionDetail(
  group: ExperienceSuggestionGroupView,
  match: PublishedMatch,
  pair: PairDecision,
  retrieval: RetrievalProjectionInternalView,
  runtime: RuntimeSettingsSnapshot,
  config: LocalEmbeddingConfig,
  activeComparisonSetDigest: string,
): NonNullable<ExperienceSuggestionGroupView['consolidationDetail']> {
  return {
    algorithmVersion: EXPERIENCE_EQUIVALENCE_ALGORITHM_VERSION,
    decision: pair.decision,
    reasonCodes: pair.reasonCodes,
    sourceSuggestionGroupIds: suggestionSourceGroupIds(group),
    sourceGroups: group.consolidationDetail?.sourceGroups ?? [{
      suggestionGroupId: group.suggestionGroupId,
      kernelIdentity: group.kernelIdentity,
      revisionDigest: group.revisionDigest,
      occurrenceIds: group.occurrences.map(occurrence => occurrence.occurrenceId).sort(),
    }],
    targetExperienceId: match.version.experienceId,
    targetExperienceVersionId: match.version.experienceVersionId,
    targetVersionContentDigest: match.version.contentDigest,
    retrievalGeneration: retrieval.projection.manifest.generation,
    modelIdentityDigest: localEmbeddingModelIdentityDigest(config),
    operationSettingsDigest: equivalenceSettingsDigest(runtime, config),
    activeComparisonSetDigest,
    allowedOwnerChoices: [],
    componentCorrespondence: publishedCorrespondence(group, pair.correspondence),
    materialDifferences: pair.materialDifferences,
  }
}

function publishedCorrespondence(
  group: ExperienceSuggestionGroupView,
  target: readonly Correspondence[],
): readonly Correspondence[] {
  const recent = group.consolidationDetail
  if (recent === undefined || recent.targetExperienceVersionId !== null) return target
  return recent.componentCorrespondence.flatMap(source => {
    const mapped = target.find(candidate => candidate.incomingComponentKey === source.targetComponentKey)
    if (mapped === undefined) return []
    return [{
      ...mapped,
      incomingSuggestionGroupId: source.incomingSuggestionGroupId,
      incomingComponentKey: source.incomingComponentKey,
      incomingRole: source.incomingRole,
      incomingContentDigest: source.incomingContentDigest,
      matchBasis: source.matchBasis === 'semantic' || mapped.matchBasis === 'semantic' ? 'semantic' as const : 'exact' as const,
    }]
  })
}

function compareComponents(
  incomingGroupId: string,
  incoming: ExperienceCandidateDraft,
  target: Pick<ExperienceCandidateDraft, 'components'>,
  published: ExperienceVersionView | null,
  vectors: ReadonlyMap<string, Float32Array>,
  threshold: number,
): PairDecision {
  const required = TYPE_BEHAVIORS[incoming.proposedKind]
  const incomingMissing = required.validate(new Set(incoming.components.map(component => component.role)))
  const targetMissing = required.validate(new Set(target.components.map(component => component.role)))
  if (incomingMissing.length > 0 || targetMissing.length > 0) {
    return {
      decision: 'ambiguous',
      reasonCodes: ['required_component_missing'],
      correspondence: [],
      materialDifferences: [],
    }
  }
  const targetByRole = componentsByRole(target.components)
  const incomingByRole = componentsByRole(incoming.components)
  const roles = unique([...incomingByRole.keys(), ...targetByRole.keys()]) as ComponentRole[]
  const correspondence: Correspondence[] = []
  const differences: SuggestionMaterialDifferenceInput[] = []
  const reasons: string[] = []
  let ambiguous = false
  let specialization = false
  for (const role of roles) {
    const left = incomingByRole.get(role) ?? []
    const right = targetByRole.get(role) ?? []
    if (left.length !== right.length) {
      reasons.push('component_cardinality_mismatch')
      if (conditionRole(role) && (left.length === 0 || right.length === 0)) specialization = true
      else ambiguous = true
      continue
    }
    for (let index = 0; index < left.length; index += 1) {
      const source = left[index]!
      const destination = right[index]!
      const incomingDigest = suggestionDigest(normalizeKernelText(source.content))
      const targetDigest = suggestionDigest(normalizeKernelText(destination.content))
      const exact = incomingDigest === targetDigest
      if (!exact) {
        const incompatibility = deterministicIncompatibility(role, source.content, destination.content)
        if (incompatibility !== null) {
          reasons.push(incompatibility)
          differences.push(materialDifference(role, source, destination, published, incomingDigest, targetDigest, incompatibility))
          continue
        }
        if (conditionRole(role) && strictContainment(source.content, destination.content)) {
          specialization = true
          reasons.push('condition_scope_specialization')
          differences.push(materialDifference(role, source, destination, published, incomingDigest, targetDigest, 'condition_scope_specialization'))
          continue
        }
        if (!semanticCorrespondenceRole(role, source.content, destination.content, published, destination.componentKey)) {
          ambiguous = true
          reasons.push('comparison_component_changed')
          continue
        }
        const leftVector = vectors.get(componentVectorKey(incoming.proposedKind, role, source.content))
        const rightVector = vectors.get(componentVectorKey(incoming.proposedKind, role, destination.content))
        const similarity = leftVector === undefined || rightVector === undefined
          ? Number.NaN : cosine(leftVector, rightVector)
        if (!Number.isFinite(similarity) || similarity < threshold) {
          ambiguous = true
          reasons.push('semantic_component_below_threshold')
          continue
        }
      }
      correspondence.push({
        incomingSuggestionGroupId: incomingGroupId,
        incomingComponentKey: source.componentKey,
        incomingRole: role,
        incomingContentDigest: incomingDigest,
        targetComponentKey: destination.componentKey,
        targetComponentRevisionId: published === null
          ? null : published.components.find(component => component.componentKey === destination.componentKey)!
            .componentRevisionId,
        targetRole: role,
        targetContentDigest: targetDigest,
        matchBasis: exact ? 'exact' : 'semantic',
      })
    }
  }
  const complete = correspondence.length === incoming.components.length
    && correspondence.length === target.components.length
  if (differences.some(difference => difference.reasonCode !== 'condition_scope_specialization')) {
    return { decision: 'different', reasonCodes: unique(reasons), correspondence, materialDifferences: differences }
  }
  if (specialization && !ambiguous) {
    return { decision: 'specialization', reasonCodes: unique(reasons), correspondence, materialDifferences: differences }
  }
  if (ambiguous || !complete) {
    return {
      decision: 'ambiguous',
      reasonCodes: unique([...reasons, ...(!complete ? ['component_correspondence_incomplete'] : [])]),
      correspondence,
      materialDifferences: differences,
    }
  }
  return { decision: 'same', reasonCodes: ['component_correspondence_complete'], correspondence, materialDifferences: [] }
}

function deterministicIncompatibility(role: ComponentRole, left: string, right: string): string | null {
  if (conditionRole(role) && negativePolarity(left) !== negativePolarity(right)) {
    return 'condition_polarity_conflict'
  }
  if (actionRole(role) && negatedOperationSignature(left).join(':') !== negatedOperationSignature(right).join(':')) {
    return 'condition_polarity_conflict'
  }
  if (role === 'side_effect_policy' && sideEffectPolicyConflict(left, right)) {
    return 'condition_polarity_conflict'
  }
  const leftScope = exclusiveScope(left)
  const rightScope = exclusiveScope(right)
  if (leftScope !== 'none' && rightScope !== 'none' && leftScope !== rightScope) {
    return 'scope_constraint_conflict'
  }
  if (explicitSemanticAnchorsConflict(left, right)) return 'semantic_anchor_conflict'
  if (role === 'modality' && normalizeKernelText(left).toLowerCase() !== normalizeKernelText(right).toLowerCase()) {
    return 'modality_conflict'
  }
  if (role === 'object_or_value') return 'fact_value_conflict'
  if (role === 'authority_source' || role === 'override_policy') return 'authority_conflict'
  if (role === 'causal_grade' || role === 'allowed_use') return 'causal_authority_conflict'
  if (actionRole(role)) {
    const leftActions = operationSignature(left)
    const rightActions = operationSignature(right)
    if (leftActions.length === 0 || rightActions.length === 0 || leftActions.join(':') !== rightActions.join(':')) {
      return 'action_capability_conflict'
    }
  }
  if (verifierRole(role)) {
    const leftVerifier = verifierSignature(left)
    const rightVerifier = verifierSignature(right)
    if (leftVerifier.length === 0 || rightVerifier.length === 0
      || leftVerifier.join(':') !== rightVerifier.join(':')) return 'outcome_verifier_conflict'
  }
  return null
}

function explicitSemanticAnchorsConflict(left: string, right: string): boolean {
  const leftAnchors = explicitSemanticAnchors(left)
  const rightAnchors = explicitSemanticAnchors(right)
  return Object.keys(leftAnchors).some(key => {
    const leftValues = leftAnchors[key] ?? []
    const rightValues = rightAnchors[key] ?? []
    if (leftValues.length === 0 || rightValues.length === 0) return false
    const leftSet = new Set(leftValues)
    const rightSet = new Set(rightValues)
    const overlap = leftValues.some(value => rightSet.has(value))
    const leftSubset = leftValues.every(value => rightSet.has(value))
    const rightSubset = rightValues.every(value => leftSet.has(value))
    return !overlap || (!leftSubset && !rightSubset)
  })
}

function explicitSemanticAnchors(value: string): Readonly<Record<string, readonly string[]>> {
  const normalized = normalizeKernelText(value)
  const collect = (pattern: RegExp): string[] => [...normalized.matchAll(pattern)]
    .map(match => match[0]!.toUpperCase()).filter((item, index, values) => values.indexOf(item) === index).sort()
  const collectGroup = (pattern: RegExp): string[] => [...normalized.matchAll(pattern)]
    .map(match => match[1]!.toUpperCase()).filter((item, index, values) => values.indexOf(item) === index).sort()
  const exposure = [
    ...(/(?:\b(?:localhost|loopback)\b|本地回环|本地服务)/iu.test(normalized) ? ['local'] : []),
    ...(/(?:\b(?:public|tls|cdn)\b|公网|外网)/iu.test(normalized) ? ['public'] : []),
  ]
  return {
    systemError: collect(/\bE[A-Z][A-Z0-9_]{2,}\b/gu),
    httpStatus: collect(/\b[1-5]\d{2}\b/gu),
    ipv4: collect(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu),
    version: collect(/(?<![\d.])v?\d+\.\d+(?:\.\d+)?(?![\d.])/giu),
    port: collectGroup(/(?:\bport\b|端口)\s*[:=#]?\s*(\d{2,5})\b/giu),
    exposure: [...new Set(exposure)].sort(),
  }
}

function materialDifference(
  role: ComponentRole,
  incoming: ExperienceCandidateDraft['components'][number],
  target: ExperienceCandidateDraft['components'][number],
  published: ExperienceVersionView | null,
  incomingContentDigest: string,
  targetContentDigest: string,
  reasonCode: string,
): SuggestionMaterialDifferenceInput {
  const revision = published?.components.find(component => component.componentKey === target.componentKey)
    ?.componentRevisionId
  return {
    facet: facetForRole(role),
    incomingComponentKey: incoming.componentKey,
    targetComponentRevisionId: revision ?? `recent:${target.componentKey}`,
    incomingContentDigest,
    targetContentDigest,
    reasonCode,
  }
}

function facetForRole(role: ComponentRole): SuggestionMaterialDifferenceInput['facet'] {
  if (conditionRole(role)) return 'condition'
  if (actionRole(role)) return 'action'
  if (verifierRole(role)) return role.includes('verifier') ? 'verifier' : 'outcome'
  if (role === 'object_or_value') return 'value'
  if (role.includes('authority') || role === 'modality' || role === 'override_policy') return 'authority'
  return 'scope'
}

function semanticSameCalibrated(config: LocalEmbeddingConfig, kind: ExperienceSuggestionGroupView['kind']): boolean {
  return semanticEquivalenceCalibrated(config, kind)
}

function alignedCanonicalVersions(
  retrieval: RetrievalProjectionInternalView,
  versions: readonly ExperienceVersionView[],
): ReadonlyMap<string, ExperienceVersionView> {
  const documents = new Map(retrieval.projection.documents.map(document =>
    [document.experienceVersionId, document] as const))
  return new Map(versions.filter(version => {
    const document = documents.get(version.experienceVersionId)
    return document !== undefined && document.versionContentDigest === version.contentDigest
  }).map(version => [version.experienceVersionId, version] as const))
}

function canonicalMatchFor(
  match: PublishedMatch,
  retrieval: RetrievalProjectionInternalView,
  config: LocalEmbeddingConfig,
): NonNullable<ExperienceSuggestionGroupView['canonicalMatch']> {
  return {
    experienceId: match.version.experienceId,
    experienceVersionId: match.version.experienceVersionId,
    versionContentDigest: match.version.contentDigest,
    title: match.version.title,
    intent: match.version.intent,
    similarity: match.similarity,
    retrievalGeneration: retrieval.projection.manifest.generation,
    modelId: config.modelId,
    modelRevision: config.revision,
  }
}

function equivalenceSettingsDigest(runtime: RuntimeSettingsSnapshot, config: LocalEmbeddingConfig): string {
  return suggestionDigest({
    algorithmVersion: EXPERIENCE_EQUIVALENCE_ALGORITHM_VERSION,
    evidenceManifestSha256: EQUIVALENCE_EVIDENCE_MANIFEST_SHA256,
    modelIdentityDigest: localEmbeddingModelIdentityDigest(config),
    similarityThreshold: runtime.values.equivalenceSimilarityThreshold,
    margin: runtime.values.equivalenceMargin,
  })
}

function representativeSourceGroupId(group: ExperienceSuggestionGroupView): string {
  return suggestionSourceGroupIds(group)[0]!
}

function withDecisionDigests(group: ExperienceSuggestionGroupView): ExperienceSuggestionGroupView {
  return { ...group, ...suggestionDecisionDigests(group) }
}

function pairKey(left: string, right: string): string {
  return left.localeCompare(right) <= 0 ? `${left}\u0000${right}` : `${right}\u0000${left}`
}

function componentVectorKey(kind: string, role: ComponentRole, content: string): string {
  return `${kind}\u0000${role}\u0000${normalizeKernelText(content)}`
}

function componentsByRole(
  components: readonly ExperienceCandidateDraft['components'][number][],
): ReadonlyMap<ComponentRole, readonly ExperienceCandidateDraft['components'][number][]> {
  const result = new Map<ComponentRole, ExperienceCandidateDraft['components'][number][]>()
  for (const component of components) {
    const current = result.get(component.role) ?? []
    current.push(component)
    result.set(component.role, current)
  }
  return result
}

function scopeFromFields(values: readonly string[]): Readonly<Record<string, string>> {
  return Object.fromEntries(values.flatMap(value => {
    const index = value.indexOf(': ')
    return index < 1 ? [] : [[value.slice(0, index), value.slice(index + 2)]]
  }))
}

function cosine(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || left.length === 0) return Number.NaN
  let value = 0
  for (let index = 0; index < left.length; index += 1) value += left[index]! * right[index]!
  return value
}

function negativePolarity(value: string): boolean {
  const normalized = normalizeKernelText(value)
    .replace(/(?:能不能|可不可以|是否|能否|不只|不仅|\bnot only\b)/giu, '')
  return /(?:\bnot\b|\bnever\b|\bno\b|\bmissing\b|\blacks?\b|must_not|do not|don't|禁止|不得|不要|不能|不允许|无权|缺少|没有|无(?:需|须)|不(?:检查|查看|使用|调用|执行|运行|访问|修改|删除|写入|读取|适用|满足|具备|支持|存在|可用|启用|配置|授权|通过)|未(?:附带|满足|具备|通过|启用|配置|授权|完成))/iu
    .test(normalized)
}

function exclusiveScope(value: string): 'only' | 'not_only' | 'none' {
  const normalized = normalizeKernelText(value)
  if (/(?:\bnot only\b|不只|不仅)/iu.test(normalized)) return 'not_only'
  if (/(?:\bonly\b|仅仅|仅需|只需|只读取|只检查|只看)/iu.test(normalized)) return 'only'
  return 'none'
}

const ACTION_MARKERS: readonly (readonly [string, RegExp])[] = [
  ['read', /\b(?:read|inspect|query|show|check)\b|读取|查看|检查|核对|查询/iu],
  ['write', /\b(?:write|edit|modify|update|add)\b|写入|编辑|修改|更新|添加|改(?:文件|配置|代码|内容)/iu],
  ['delete', /\b(?:delete|remove)\b|删除|移除/iu],
  ['enable', /\b(?:enable|activate)\b|启用|开启/iu],
  ['disable', /\b(?:disable|deactivate)\b|禁用|关闭/iu],
  ['start', /\b(?:start|launch|restart|retry)\b|启动|重启|重新启动|重试/iu],
  ['stop', /\b(?:stop|kill|terminate)\b|停止|结束|终止/iu],
  ['install', /\binstall\b|安装/iu],
  ['build', /\b(?:build|compile)\b|构建|编译/iu],
  ['test', /\b(?:test|verify)\b|测试|验证/iu],
]

function operationSignature(value: string): string[] {
  const command = serializedToolCommand(value)
  const semanticText = command ?? value
  return ACTION_MARKERS.filter(([, pattern]) => pattern.test(semanticText)).map(([marker]) => marker)
}

function serializedToolCommand(value: string): string | null {
  const match = /"command"\s*:\s*"((?:\\.|[^"\\])*)"/u.exec(value)
  if (match?.[1] === undefined) return null
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return match[1]
  }
}

function negatedOperationSignature(value: string): string[] {
  const normalized = normalizeKernelText(value)
    .replace(/(?:\bnot only\b|不只|不仅)/giu, '')
  const clauses = [
    ...[...normalized.matchAll(/\b(?:do\s+not|don't|must\s+not|not|never|avoid|no)\b\s+([^,.!?;\n]{1,48})/giu)]
      .map(match => match[1]!),
    ...[...normalized.matchAll(/(?:禁止|不得|不要|不能|不允许|无需|无须|不)([^，,。！？；;\n]{1,24})/giu)]
      .map(match => match[1]!),
  ]
  const text = clauses.join(' ')
  const markers = ACTION_MARKERS.filter(([, pattern]) => pattern.test(text)).map(([marker]) => marker)
  if (/(?:\brun\b|运行)/iu.test(text) && !markers.includes('start')) markers.push('start')
  return markers
}

function sideEffectPolicyConflict(left: string, right: string): boolean {
  const leftNegated = new Set(negatedOperationSignature(left))
  const rightNegated = new Set(negatedOperationSignature(right))
  const leftPositive = operationSignature(left)
  const rightPositive = operationSignature(right)
  return leftPositive.some(action => rightNegated.has(action))
    || rightPositive.some(action => leftNegated.has(action))
}

const VERIFIER_MARKERS: readonly (readonly [string, RegExp])[] = [
  ['http', /\b(?:http|rpc|api)\b|接口|响应/iu],
  ['success_status', /\b2\d\d\b|\b(?:success|successful|succeed(?:ed|s)?)\b|成功/iu],
  ['shell', /\b(?:bash|shell)\b|终端/iu],
  ['socket', /\b(?:socket|port|listen)\b|端口|监听/iu],
  ['file', /\b(?:file|path)\b|文件|路径/iu],
  ['process', /\b(?:process|pid)\b|进程/iu],
  ['tests', /\b(?:test|spec)\b|测试|用例/iu],
  ['exit_zero', /exit\s*0|退出码\s*0/iu],
]

function verifierSignature(value: string): string[] {
  return VERIFIER_MARKERS.filter(([, pattern]) => pattern.test(value)).map(([marker]) => marker)
}

function actionRole(role: ComponentRole): boolean {
  return role === 'step' || role === 'resolution_candidate' || role === 'branch' || role === 'candidate_option'
    || role === 'cause_or_intervention'
}

function verifierRole(role: ComponentRole): boolean {
  return role === 'verifier' || role === 'recovery_verifier' || role === 'checkpoint'
    || role === 'outcome_measure' || role === 'effect_or_metric'
}

function conditionRole(role: ComponentRole): boolean {
  return role === 'entry_condition' || role === 'forbidden_condition' || role === 'environment_scope'
    || role === 'subject_scope' || role === 'task_or_output_scope' || role === 'hard_constraint'
    || role === 'applicability_condition'
}

function semanticCorrespondenceRole(
  role: ComponentRole,
  left: string,
  right: string,
  published: ExperienceVersionView | null,
  targetComponentKey: string,
): boolean {
  if (experienceComponentIdentityClass(role) === 'series') return true
  if (isPolicyDerivedSuggestionComponentRole(role)) {
    return published === null || published.components.find(component => component.componentKey === targetComponentKey)
      ?.evidenceIds.length === 0
  }
  return role === 'failure_branch' && genericProcedureFailureBranch(left) && genericProcedureFailureBranch(right)
}

function genericProcedureFailureBranch(value: string): boolean {
  const normalized = normalizeKernelText(value)
  return /(?:any step|任一步骤)/iu.test(normalized)
    && /(?:final verifier|最终验证)/iu.test(normalized)
    && /(?:stop reuse|停止复用)/iu.test(normalized)
    && /(?:diagnos|诊断)/iu.test(normalized)
}

function strictContainment(left: string, right: string): boolean {
  const a = normalizeKernelText(left).toLowerCase()
  const b = normalizeKernelText(right).toLowerCase()
  return a !== b && (a.includes(b) || b.includes(a))
}

function unique<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort()
}
