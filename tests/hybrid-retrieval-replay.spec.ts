import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TYPE_BEHAVIORS } from '../src/domain/behavior.js'
import {
  selectHybridMatchingExperiences,
  type HybridRetrievalOperation,
} from '../src/domain/hybrid-retrieval.js'
import { fingerprintTask, type ExperienceMatchProjection } from '../src/domain/planning.js'
import { projectExperienceVersion, projectTaskFingerprint } from '../src/domain/retrieval-projector.js'
import { brandedId } from '../src/ids.js'
import type { ActorView, ExperienceRetrievalProjectionView } from '../src/types.js'

interface ReplayExperience {
  readonly id: string
  readonly kind: 'procedure' | 'diagnostic'
  readonly taskFamily: string
  readonly targetExposure: 'local' | 'public'
  readonly errorCodes: readonly string[]
  readonly title: string
  readonly text: string
}

interface RecallCase {
  readonly id: string
  readonly query: string
  readonly taskFamily: string
  readonly targetExposure: 'local' | 'public'
  readonly expectedTop1: string | null
  readonly forbiddenIds: readonly string[]
}

const replay = JSON.parse(readFileSync('benchmarks/auto-e0/replay.json', 'utf8')) as {
  readonly experiences: readonly ReplayExperience[]
  readonly recallCases: readonly RecallCase[]
}

describe('E4a frozen bilingual and adversarial replay', () => {
  it('keeps every expected top-1 while producing zero harmful lexical fallback matches', () => {
    const versions = replay.experiences.map(projectReplayExperience)
    const idByVersion = new Map(versions.map((version, index) => [
      String(version.experienceVersionId), replay.experiences[index]!.id,
    ]))
    const failures: string[] = []
    const harmful: string[] = []
    for (const item of replay.recallCases) {
      const task = {
        text: item.query,
        workspaceRoot: null,
        targetExposure: item.targetExposure,
        mustUseExperience: false,
        riskClass: 'standard' as const,
        requiredCapabilities: [],
        requestedUseMode: 'guided' as const,
        overrideDecisionIds: [],
      }
      const fingerprint = fingerprintTask(task, actor(), '2026-09-10T12:00:00.000Z', {
        taskFamily: item.taskFamily,
      })
      const result = selectHybridMatchingExperiences(
        fingerprint,
        versions,
        32,
        '2026-09-10T12:00:00.000Z',
        { requestedUseMode: 'guided', workspaceRoot: null, requiredCapabilities: [] },
        lexicalOperation(fingerprint, versions),
      )
      const actualVersion = result.matchSet.retrievalDecision?.primaryExperienceVersionId
      const actual = actualVersion === null || actualVersion === undefined
        ? null : idByVersion.get(String(actualVersion)) ?? null
      if (actual !== item.expectedTop1) failures.push(`${item.id}:${String(actual)}`)
      if (actual !== null && item.forbiddenIds.includes(actual)) harmful.push(`${item.id}:${actual}`)
    }
    expect(harmful).toEqual([])
    expect(failures).toEqual([])
  })
})

function projectReplayExperience(item: ReplayExperience, index: number): ExperienceMatchProjection {
  const components = TYPE_BEHAVIORS[item.kind].requiredRoles.map((role, roleIndex) => ({
    componentId: brandedId<'ExperienceComponentId'>(`${item.id}:component:${roleIndex}`, 'componentId'),
    componentRevisionId: brandedId<'ExperienceComponentRevisionId'>(`${item.id}:revision:${roleIndex}`, 'componentRevisionId'),
    role,
    content: role === 'symptom_signature'
      ? `${item.errorCodes.join(' ')} ${item.text}`
      : `${role}: ${item.text}`,
  }))
  return {
    experienceVersionId: brandedId<'ExperienceVersionId'>(`${item.id}:version`, 'experienceVersionId'),
    experienceId: brandedId<'ExperienceId'>(item.id, 'experienceId'),
    kind: item.kind,
    title: item.title,
    intent: item.text,
    scope: { taskFamily: item.taskFamily, targetExposure: item.targetExposure },
    validity: {},
    riskAndEffectSpec: {},
    privacyClass: 'workspace',
    allowedUseModes: ['reference', 'suggest', 'guided'],
    evidenceGrade: 'observation_supported',
    contentDigest: `sha256:${index.toString(16).padStart(64, '0')}`,
    componentRevisionIds: components.map(component => component.componentRevisionId),
    components,
  }
}

function lexicalOperation(
  fingerprint: ReturnType<typeof fingerprintTask>,
  versions: readonly ExperienceMatchProjection[],
): HybridRetrievalOperation {
  const documents = versions.map(projectExperienceVersion)
  const projection: ExperienceRetrievalProjectionView = {
    projectionKey: 'experience-retrieval-v1',
    schemaVersion: 2,
    manifest: {
      schemaVersion: 'experience-retrieval-projection-manifest-v2',
      projectionVersion: 'experience-retrieval-projector-v2',
      generation: 1,
      state: 'lexical_ready',
      provider: 'disabled',
      providerState: 'disabled',
      modelId: null,
      modelRevision: null,
      artifactSha256: null,
      dimension: null,
      dtype: null,
      pooling: null,
      queryPrefix: null,
      passagePrefix: null,
      tokenizerConfigBundleSha256: null,
      normalization: null,
      maxInputTokens: null,
      truncationPolicy: null,
      operationSettingsRevision: null,
      operationSettingsDigest: `sha256:${'1'.repeat(64)}`,
      sourceWatermarkDigest: `sha256:${'2'.repeat(64)}`,
      contentDigest: `sha256:${'3'.repeat(64)}`,
      documentCount: documents.length,
      vectorCount: 0,
      failureCode: null,
      builtAt: '2026-09-10T12:00:00.000Z',
    },
    documents,
  }
  return {
    query: projectTaskFingerprint(fingerprint),
    projection,
    vectors: new Map(),
    queryVector: null,
    queryEmbeddingReceiptId: null,
    denseState: 'disabled',
    denseFailureCode: null,
    denseSimilarityThreshold: 0.76,
    denseMargin: 0.025,
    denseApplicabilityProfile: null,
    recallDecisionKey: null,
  }
}

function actor(): ActorView {
  return {
    actorId: brandedId<'ExperienceActorId'>('e4-replay-actor', 'actorId'),
    principalId: brandedId<'ExperienceLocalOwnerPrincipalId'>('e4-replay-principal', 'principalId'),
    kind: 'management_local_owner',
    authority: 'owner',
  }
}
