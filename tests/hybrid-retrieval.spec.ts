import { describe, expect, it, vi } from 'vitest'
import { ConservativeRecall } from '../src/application/conservative-recall.js'
import { automaticDenseApplicabilityProfile } from '../src/application/local-semantic-calibration.js'
import { embeddingSettings, localEmbeddingConfig } from '../src/application/retrieval-projection.js'
import { suggestionDigest } from '../src/domain/automatic-suggestion.js'
import { TYPE_BEHAVIORS } from '../src/domain/behavior.js'
import {
  selectHybridMatchingExperiences,
  type HybridRetrievalOperation,
} from '../src/domain/hybrid-retrieval.js'
import { fingerprintTask, matchExperienceProjection, type ExperienceMatchProjection } from '../src/domain/planning.js'
import { projectExperienceVersion, projectTaskFingerprint } from '../src/domain/retrieval-projector.js'
import { brandedId } from '../src/ids.js'
import type { ActorView, ExperienceRetrievalProjectionView, PlanningTaskInput } from '../src/types.js'
import { RuntimeSettingsSchema, type RuntimeSettings } from '../src/runtime-settings-schema.js'
import { seedVersion } from './fixtures/store-seed.js'
import {
  diagnosticSpec,
  makePlanningService,
  planInput,
  retrievalFixture,
  task as planningTask,
} from './fixtures/retrieval-fixture.js'

const NOW = '2026-09-10T12:00:00.000Z'

describe('E4a conservative hybrid retrieval', () => {
  it('selects only one lexical primary and retains channel explanations for runners', () => {
    const primary = projection('local-start', 'procedure', 'dsh_web_startup',
      'Start local DSH Web with authenticated RPC and owned cleanup')
    const runner = projection('auth-check', 'procedure', 'dsh_web_startup',
      'Check authenticated RPC after starting the local web process')
    const fingerprint = fingerprintFor(
      'Start local DSH Web, verify authenticated RPC, then clean up the owned process',
      'dsh_web_startup',
    )
    const result = selectHybridMatchingExperiences(
      fingerprint,
      [runner, primary],
      32,
      NOW,
      eligibility(),
      operation(fingerprint, [primary, runner]),
    )

    expect(result.matchSet).toMatchObject({
      retrievalVersion: 'conservative-hybrid-v1',
      noMatch: false,
      retrievalDecision: {
        denseState: 'disabled',
        primaryExperienceVersionId: primary.experienceVersionId,
      },
    })
    expect(result.selectedProjections.map(item => item.experienceVersionId)).toEqual([primary.experienceVersionId])
    expect(result.matchSet.candidates.filter(item => item.selectedComponentRevisionIds.length > 0)).toHaveLength(1)
    expect(result.matchSet.candidates[0]).toMatchObject({ lexicalRank: 1, semanticRank: null })
    expect(result.matchSet.candidates[1]?.reasonCodes).toContain('not_primary_candidate')
  })

  it('hard-rejects an exact HTTP symptom conflict before semantic or lexical ranking', () => {
    const notFound = projection('http-404', 'diagnostic', 'dsh_web_startup',
      'Authenticated root HTTP 404 means the dist artifact is missing', 'HTTP 404')
    const unauthorized = projection('http-401', 'diagnostic', 'dsh_web_startup',
      'HTTP 401 means launch token or cookie authorization is missing', 'HTTP 401')
    const fingerprint = fingerprintFor(
      'Authenticated DSH root returns HTTP 404 and dist/index.html is absent',
      'dsh_web_startup',
    )
    const result = selectHybridMatchingExperiences(
      fingerprint,
      [unauthorized, notFound],
      32,
      NOW,
      eligibility(),
      operation(fingerprint, [notFound, unauthorized], {
        queryVector: new Float32Array([1, 0]),
        vectors: new Map([
          [projectExperienceVersion(notFound).documentId, new Float32Array([0.8, 0.6])],
          [projectExperienceVersion(unauthorized).documentId, new Float32Array([1, 0])],
        ]),
      }),
    )

    expect(result.matchSet.retrievalDecision?.primaryExperienceVersionId).toBe(notFound.experienceVersionId)
    const rejected = result.matchSet.candidates.find(item => item.experienceVersionId === unauthorized.experienceVersionId)
    expect(rejected).toMatchObject({ rejected: true, selectedComponentRevisionIds: [] })
    expect(rejected?.reasonCodes).toContain('exact_signal_conflict')
  })

  it('bridges a registered Chinese failure phrase to its canonical error signature', () => {
    const base = projection('connection-refused', 'diagnostic', 'general',
      'ECONNREFUSED requires checking listener readiness', 'ECONNREFUSED')
    const refused = { ...base, validity: { source: 'completed_dsh_session_turn' } }
    const fingerprint = fingerprintFor('连接被拒绝，确认服务是否监听', 'general')
    const result = selectHybridMatchingExperiences(
      fingerprint,
      [refused],
      32,
      NOW,
      eligibility(),
      operation(fingerprint, [refused]),
    )

    expect(result.matchSet.retrievalDecision?.primaryExperienceVersionId).toBe(refused.experienceVersionId)
    expect(result.matchSet.candidates[0]?.reasonCodes).toContain('exact_signal_match')
  })

  it('hard-rejects automatic candidates when their kind-specific focus is absent from the task', () => {
    const procedureBase = projection('procedure-profile', 'procedure', 'general',
      'Check the installed Experience Map profile with a local verification command')
    const procedure = { ...procedureBase,
      validity: { ...procedureBase.validity, source: 'completed_dsh_session_turn' },
      components: procedureBase.components.map(component => ({
        ...component,
        content: component.role === 'goal_signature'
          ? 'Check the installed Experience Map profile with a local verification command'
          : component.content,
      })) }
    const preferenceBase = projection('preference-zh', 'preference_policy', 'general', '中文技术回答必须使用中文')
    const preference = { ...preferenceBase, validity: { ...preferenceBase.validity, source: 'completed_dsh_session_turn' },
      components: preferenceBase.components.map(component => ({
      ...component,
      content: component.role === 'task_or_output_scope' ? '中文技术回答' : component.content,
      })) }
    const factBase = projection('fact-node', 'fact', 'general', 'workspace runtime node version v22')
    const fact = { ...factBase, validity: { ...factBase.validity, source: 'completed_dsh_session_turn' },
      components: factBase.components.map(component => ({
      ...component,
      content: component.role === 'subject' ? 'workspace runtime'
        : component.role === 'predicate' ? 'node version' : component.content,
      })) }
    const eligibilityForSuggestion = { requestedUseMode: 'suggest' as const, workspaceRoot: null, requiredCapabilities: [] }

    expect(matchExperienceProjection(
      fingerprintFor('以后为我写中文诗歌时必须使用中文', 'general'), procedure, eligibilityForSuggestion,
    )).toMatchObject({ rejected: true, selectedComponentRevisionIds: [],
      reasonCodes: expect.arrayContaining(['automatic_focus_not_matched']) })
    expect(matchExperienceProjection(
      fingerprintFor('Check the installed Experience Map profile with a local verification command', 'general'),
      procedure,
      eligibilityForSuggestion,
    ).reasonCodes).not.toContain('automatic_focus_not_matched')
    expect(matchExperienceProjection(
      fingerprintFor('deploy a database migration', 'general'), preference, eligibilityForSuggestion,
    )).toMatchObject({ rejected: true, selectedComponentRevisionIds: [],
      reasonCodes: expect.arrayContaining(['automatic_focus_not_matched']) })
    expect(matchExperienceProjection(
      fingerprintFor('inspect certificate expiry', 'general'), fact, eligibilityForSuggestion,
    )).toMatchObject({ rejected: true, selectedComponentRevisionIds: [],
      reasonCodes: expect.arrayContaining(['automatic_focus_not_matched']) })
    expect(matchExperienceProjection(
      fingerprintFor('写一个中文技术回答', 'general'), preference, eligibilityForSuggestion,
    ).reasonCodes).not.toContain('automatic_focus_not_matched')
    expect(matchExperienceProjection(
      fingerprintFor('read workspace runtime node version', 'general'), fact, eligibilityForSuggestion,
    ).reasonCodes).not.toContain('automatic_focus_not_matched')
    expect(matchExperienceProjection(
      fingerprintFor('read workspace runtime python version', 'general'), fact, eligibilityForSuggestion,
    )).toMatchObject({ rejected: true,
      reasonCodes: expect.arrayContaining(['automatic_focus_not_matched']) })
    expect(matchExperienceProjection(
      fingerprintFor('写一个英文技术回答', 'general'), preference, eligibilityForSuggestion,
    )).toMatchObject({ rejected: true,
      reasonCodes: expect.arrayContaining(['automatic_focus_not_matched']) })
  })

  it('hard-rejects a direct-session Preference for a different explicit subject', () => {
    const base = projection('preference-subject', 'preference_policy', 'general', '使用中文回复')
    const preference = {
      ...base,
      validity: { source: 'completed_dsh_session_turn' },
      components: base.components.map(component => ({
        ...component,
        content: component.role === 'subject_scope' ? '用户 A 的会话'
          : component.role === 'task_or_output_scope' ? '技术回答' : component.content,
      })),
    }
    const candidate = matchExperienceProjection(
      fingerprintFor('为用户 B 的会话写技术回答', 'general'),
      preference,
      { requestedUseMode: 'suggest', workspaceRoot: null, requiredCapabilities: [] },
    )

    expect(candidate).toMatchObject({
      rejected: true,
      selectedComponentRevisionIds: [],
      reasonCodes: expect.arrayContaining(['preference_subject_conflict']),
    })
  })

  it('keeps the runner-up margin gate when the durable candidate limit is one', () => {
    const first = projection('limit-a', 'procedure', 'general', 'deploy web service verify health')
    const second = projection('limit-b', 'procedure', 'general', 'deploy web service verify health')
    const fingerprint = fingerprintFor('deploy web service verify health', 'general')
    const result = selectHybridMatchingExperiences(
      fingerprint,
      [first, second],
      1,
      NOW,
      eligibility(),
      operation(fingerprint, [first, second]),
    )

    expect(result.matchSet.candidates).toHaveLength(1)
    expect(result.matchSet.noMatch).toBe(true)
    expect(result.matchSet.retrievalDecision?.abstentionReasonCodes)
      .toContain('lexical_threshold_not_met')
  })

  it('abstains on a dense-only low margin and accepts after the frozen margin is met', () => {
    const first = projection('dense-a', 'procedure', 'general', 'verify remote service readiness')
    const second = projection('dense-b', 'procedure', 'general', 'inspect database migration state')
    const fingerprint = fingerprintFor('请处理这个没有共享词项的新任务', 'general')
    const firstDocument = projectExperienceVersion(first)
    const secondDocument = projectExperienceVersion(second)
    const close = operation(fingerprint, [first, second], {
      queryVector: new Float32Array([1, 0]),
      vectors: new Map([
        [firstDocument.documentId, new Float32Array([0.9, Math.sqrt(0.19)])],
        [secondDocument.documentId, new Float32Array([0.89, Math.sqrt(1 - 0.89 ** 2)])],
      ]),
    })
    const abstained = selectHybridMatchingExperiences(
      fingerprint, [first, second], 32, NOW, eligibility(), close,
    )
    expect(abstained.matchSet.noMatch).toBe(true)
    expect(abstained.matchSet.retrievalDecision?.abstentionReasonCodes)
      .toContain('dense_threshold_or_margin_not_met')

    const clear = {
      ...close,
      vectors: new Map([
        [firstDocument.documentId, new Float32Array([0.9, Math.sqrt(0.19)])],
        [secondDocument.documentId, new Float32Array([0.8, 0.6])],
      ]),
    }
    const accepted = selectHybridMatchingExperiences(
      fingerprint, [first, second], 32, NOW, eligibility(), clear,
    )
    expect(accepted.matchSet.noMatch).toBe(false)
    expect(accepted.matchSet.retrievalDecision?.primaryExperienceVersionId).toBe(first.experienceVersionId)
  })

  it('allows automatic dense recall only for an applicability-calibrated model and kind', () => {
    const procedure = projection('dense-procedure', 'procedure', 'general', 'verify local service readiness')
    const fact = projection('dense-fact', 'fact', 'general', 'workspace runtime node version')
    const fingerprint = fingerprintFor('没有共享词项的语义查询', 'general')
    const vectors = new Map([
      [projectExperienceVersion(procedure).documentId, new Float32Array([1, 0])],
      [projectExperienceVersion(fact).documentId, new Float32Array([1, 0])],
    ])
    const automatic = operation(fingerprint, [procedure, fact], {
      queryVector: new Float32Array([1, 0]),
      vectors,
      denseApplicabilityProfile: {
        profileDigest: digestChar('f'),
        allowedKinds: ['procedure'],
      },
    })

    const procedureResult = selectHybridMatchingExperiences(
      fingerprint, [procedure], 32, NOW, eligibility(), automatic,
    )
    expect(procedureResult.matchSet.retrievalDecision).toMatchObject({
      policyVersion: 'conservative-hybrid-policy-v2',
      denseApplicabilityProfileDigest: digestChar('f'),
      denseApplicabilityAllowedKinds: ['procedure'],
      primaryExperienceVersionId: procedure.experienceVersionId,
    })

    const factResult = selectHybridMatchingExperiences(
      fingerprint, [fact], 32, NOW, eligibility(), automatic,
    )
    expect(factResult.matchSet.noMatch).toBe(true)
    expect(factResult.matchSet.retrievalDecision?.abstentionReasonCodes)
      .toContain('dense_applicability_profile_not_calibrated')
    expect(factResult.matchSet.candidates[0]?.reasonCodes)
      .toContain('dense_applicability_profile_not_calibrated')

    const explicit = selectHybridMatchingExperiences(
      fingerprint,
      [fact],
      32,
      NOW,
      eligibility(),
      { ...automatic, recallDecisionKey: null, denseApplicabilityProfile: null },
    )
    expect(explicit.matchSet.retrievalDecision?.primaryExperienceVersionId).toBe(fact.experienceVersionId)
    expect(explicit.matchSet.retrievalDecision).toMatchObject({
      denseApplicabilityProfileDigest: null,
      denseApplicabilityAllowedKinds: null,
    })
  })

  it('lets a calibrated dense path bridge a direct-session procedure paraphrase without weakening hard gates', () => {
    const base = projection('dense-direct-session', 'procedure', 'general',
      'Locate the Node engine declaration in the root package manifest')
    const procedure = { ...base, validity: { source: 'completed_dsh_session_turn' } }
    const fingerprint = fingerprintFor('查明运行时版本约束写在哪个根级配置里', 'general')
    const dense = operation(fingerprint, [procedure], {
      queryVector: new Float32Array([1, 0]),
      vectors: new Map([[projectExperienceVersion(procedure).documentId, new Float32Array([1, 0])]]),
      denseApplicabilityProfile: { profileDigest: digestChar('f'), allowedKinds: ['procedure'] },
    })

    const recalled = selectHybridMatchingExperiences(
      fingerprint, [procedure], 32, NOW, eligibility(), dense,
    )
    expect(recalled.matchSet.retrievalDecision?.primaryExperienceVersionId)
      .toBe(procedure.experienceVersionId)
    expect(recalled.matchSet.candidates[0]).toMatchObject({
      experienceVersionId: procedure.experienceVersionId,
      rejected: false,
      selectedComponentRevisionIds: procedure.componentRevisionIds,
    })
    expect(recalled.matchSet.candidates[0]?.reasonCodes)
      .toContain('automatic_focus_satisfied_by_calibrated_dense')
    expect(recalled.matchSet.candidates[0]?.reasonCodes)
      .not.toContain('automatic_focus_not_matched')

    const uncalibrated = selectHybridMatchingExperiences(
      fingerprint,
      [procedure],
      32,
      NOW,
      eligibility(),
      { ...dense, denseApplicabilityProfile: null },
    )
    expect(uncalibrated.matchSet.noMatch).toBe(true)

    const forbiddenFingerprint = fingerprintFor(
      '查明运行时版本约束，但明确不要读取根级 package manifest', 'general')
    const forbidden = selectHybridMatchingExperiences(
      forbiddenFingerprint,
      [procedure],
      32,
      NOW,
      eligibility(),
      { ...dense, query: projectTaskFingerprint(forbiddenFingerprint) },
    )
    expect(forbidden.matchSet.noMatch).toBe(true)
    expect(forbidden.matchSet.candidates[0]?.reasonCodes)
      .toContain('explicit_task_forbidden_action')
  })

  it('treats an automatic suggestion task-family heuristic as ranking evidence, not a hard scope boundary', () => {
    const base = projection('automatic-family-soft', 'procedure', 'application_startup',
      'Inspect the package manifest Node engine support before dispatch')
    const automatic = { ...base, validity: { source: 'completed_dsh_session_turn' } }
    const fingerprint = fingerprintFor(
      'Inspect the package manifest Node engine support before dispatch', 'general')

    const automaticCandidate = matchExperienceProjection(fingerprint, automatic, eligibility())
    const manuallyScopedCandidate = matchExperienceProjection(fingerprint, base, eligibility())
    const causalBase = projection('automatic-causal-family-hard', 'causal', 'application_startup',
      'Enabling approved context reduced tool calls in the measured session')
    const automaticCausal = matchExperienceProjection(fingerprint, {
      ...causalBase, validity: { source: 'completed_dsh_session_turn' },
    }, eligibility())
    const wrongWorkspace = matchExperienceProjection(fingerprint, {
      ...automatic,
      scope: { ...automatic.scope, workspaceRoot: '/another/workspace' },
    }, eligibility())

    expect(automaticCandidate.reasonCodes).not.toContain('hard_scope_conflict')
    expect(manuallyScopedCandidate.reasonCodes).toContain('hard_scope_conflict')
    expect(automaticCausal.reasonCodes).toContain('hard_scope_conflict')
    expect(wrongWorkspace.reasonCodes).toContain('hard_scope_conflict')
  })

  it('uses dense-first plus an independent lexical margin to resolve a direct-session dense tie', () => {
    const correctBase = projection('corroborated-correct', 'procedure', 'general',
      'Check Node engine support in the package manifest before dispatch')
    const runnerBase = projection('corroborated-runner', 'procedure', 'general',
      'Check runtime package diagnostics before dispatch')
    const correct = directSessionWithFocus(correctBase,
      'Determine whether the configured JavaScript runtime satisfies its compatibility range')
    const runner = directSessionWithFocus(runnerBase,
      'Determine whether a cached database projection can be reopened after migration')
    const fingerprint = fingerprintFor(
      'Check Node engine support in the package manifest before dispatch', 'general')
    const dense = operation(fingerprint, [correct, runner], {
      queryVector: new Float32Array([1, 0]),
      vectors: new Map([
        [projectExperienceVersion(correct).documentId, new Float32Array([1, 0])],
        [projectExperienceVersion(runner).documentId,
          new Float32Array([0.999, Math.sqrt(1 - 0.999 ** 2)])],
      ]),
      denseApplicabilityProfile: { profileDigest: digestChar('f'), allowedKinds: ['procedure'] },
    })

    const recalled = selectHybridMatchingExperiences(
      fingerprint, [runner, correct], 32, NOW, eligibility(), dense,
    )

    expect(recalled.matchSet.retrievalDecision?.primaryExperienceVersionId)
      .toBe(correct.experienceVersionId)
    expect(recalled.matchSet.candidates[0]).toMatchObject({
      experienceVersionId: correct.experienceVersionId,
      lexicalRank: 1,
      semanticRank: 1,
      rejected: false,
    })
    expect(recalled.matchSet.candidates[0]?.reasonCodes)
      .toContain('automatic_focus_satisfied_by_calibrated_dense')
  })

  it('still abstains when a direct-session dense tie has no independent lexical margin', () => {
    const firstBase = projection('uncorroborated-a', 'procedure', 'general',
      'Check runtime package before dispatch target alpha')
    const secondBase = projection('uncorroborated-b', 'procedure', 'general',
      'Check runtime package before dispatch target beta')
    const first = directSessionWithFocus(firstBase, 'Unrelated first reusable focus')
    const second = directSessionWithFocus(secondBase, 'Unrelated second reusable focus')
    const fingerprint = fingerprintFor('Check runtime package before dispatch', 'general')
    const dense = operation(fingerprint, [first, second], {
      queryVector: new Float32Array([1, 0]),
      vectors: new Map([
        [projectExperienceVersion(first).documentId,
          new Float32Array([0.9, Math.sqrt(1 - 0.9 ** 2)])],
        [projectExperienceVersion(second).documentId,
          new Float32Array([0.89, Math.sqrt(1 - 0.89 ** 2)])],
      ]),
      denseApplicabilityProfile: { profileDigest: digestChar('f'), allowedKinds: ['procedure'] },
    })

    const recalled = selectHybridMatchingExperiences(
      fingerprint, [first, second], 32, NOW, eligibility(), dense,
    )

    expect(recalled.matchSet.noMatch).toBe(true)
    expect(recalled.matchSet.retrievalDecision?.abstentionReasonCodes)
      .toContain('dense_threshold_or_margin_not_met')
  })

  it('hard-rejects explicit task negation and private content before automatic ranking', () => {
    const broad = projection('broad-check', 'procedure', 'general', '检查 git、API 和 Session 状态')
    const restricted = { ...projection('restricted-check', 'procedure', 'general', '只检查 git 状态'),
      privacyClass: 'restricted' as const }
    const fingerprint = fingerprintFor('只看 git，明确不要检查 API/Session', 'general')
    const result = selectHybridMatchingExperiences(
      fingerprint,
      [broad, restricted],
      32,
      NOW,
      eligibility(),
      operation(fingerprint, [broad, restricted], {
        queryVector: new Float32Array([1, 0]),
        vectors: new Map([
          [projectExperienceVersion(broad).documentId, new Float32Array([1, 0])],
          [projectExperienceVersion(restricted).documentId, new Float32Array([1, 0])],
        ]),
        denseApplicabilityProfile: {
          profileDigest: digestChar('f'),
          allowedKinds: ['procedure'],
        },
      }),
    )

    expect(result.matchSet.noMatch).toBe(true)
    expect(result.matchSet.candidates.find(candidate => candidate.experienceVersionId === broad.experienceVersionId)
      ?.reasonCodes).toContain('explicit_task_forbidden_action')
    expect(result.matchSet.candidates.find(candidate => candidate.experienceVersionId === restricted.experienceVersionId)
      ?.reasonCodes).toContain('automatic_context_privacy_not_allowed')

    const safe = projection('git-only', 'procedure', 'general', '只检查 git，不检查 API')
    const safeResult = selectHybridMatchingExperiences(
      fingerprint,
      [safe],
      32,
      NOW,
      eligibility(),
      operation(fingerprint, [safe], {
        queryVector: new Float32Array([1, 0]),
        vectors: new Map([[projectExperienceVersion(safe).documentId, new Float32Array([1, 0])]]),
        denseApplicabilityProfile: { profileDigest: digestChar('f'), allowedKinds: ['procedure'] },
      }),
    )
    expect(safeResult.matchSet.candidates.find(candidate => candidate.experienceVersionId === safe.experienceVersionId)
      ?.reasonCodes).not.toContain('explicit_task_forbidden_action')
  })

  it('does not parse the lexical suffix in 分别 as a forbidden-action directive', () => {
    const base = projection('usage-accounting-language', 'procedure', 'general',
      '分别报告 modelCalls、toolCalls 和 failedToolCalls，并说明 token volume 不是费用')
    const procedure = { ...base, validity: { source: 'completed_dsh_session_turn' } }
    const fingerprint = fingerprintFor(
      '分别报告 modelCalls、toolCalls 和 failedToolCalls，并说明 token volume 不是费用', 'general')
    const recalled = selectHybridMatchingExperiences(
      fingerprint,
      [procedure],
      32,
      NOW,
      eligibility(),
      operation(fingerprint, [procedure]),
    )

    expect(recalled.matchSet.retrievalDecision?.primaryExperienceVersionId)
      .toBe(procedure.experienceVersionId)
    expect(recalled.matchSet.candidates[0]?.reasonCodes)
      .not.toContain('explicit_task_forbidden_action')
  })

  it('binds the frozen full model identity to the only calibrated applicability kinds', () => {
    const defaults = RuntimeSettingsSchema({} as RuntimeSettings)
    const calibrated = localEmbeddingSettings(defaults, {
      embeddingProvider: 'transformers_js',
      embeddingModelPath: '/tmp/calibrated-e5',
      embeddingModelId: 'Xenova/multilingual-e5-small',
      embeddingModelRevision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
      embeddingArtifactPath: 'onnx/model_quantized.onnx',
      embeddingArtifactSha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
      embeddingArtifactBytes: 118_308_185,
      embeddingDimension: 384,
      embeddingDtype: 'q8',
      embeddingPooling: 'mean',
      embeddingQueryPrefix: 'query: ',
      embeddingPassagePrefix: 'passage: ',
      embeddingTokenizerConfigBundleSha256: '4fbcddc3ad44860d65318f8f0c7b8f9d49632554f41b735749fe9075f04bb133',
      embeddingNormalization: 'l2',
      embeddingMaxInputTokens: 512,
      embeddingTruncationPolicy: 'truncate_end',
    })
    const custom = localEmbeddingSettings(defaults, {
      ...calibrated.values,
      embeddingModelRevision: 'custom-unreviewed-revision',
    })

    expect(automaticDenseApplicabilityProfile(localEmbeddingConfig(calibrated))).toMatchObject({
      profileDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      allowedKinds: ['diagnostic', 'procedure'],
    })
    expect(automaticDenseApplicabilityProfile(localEmbeddingConfig(custom))).toBeNull()
  })

  it('does not invoke an uncalibrated local model automatically but keeps explicit dense queries usable', async () => {
    const defaults = RuntimeSettingsSchema({} as RuntimeSettings)
    const runtime = localEmbeddingSettings(defaults, {
      embeddingProvider: 'transformers_js',
      embeddingModelPath: '/tmp/custom-local-model',
      embeddingModelRevision: 'custom-unreviewed-revision',
    })
    const config = localEmbeddingConfig(runtime)
    const candidate = projection('custom-model', 'procedure', 'general', 'verify custom model recall')
    const baseProjection = retrievalProjection([candidate])
    const projectionSnapshot: ExperienceRetrievalProjectionView = {
      ...baseProjection,
      manifest: {
        ...baseProjection.manifest,
        operationSettingsDigest: suggestionDigest(embeddingSettings(runtime)),
        modelId: config.modelId,
        modelRevision: config.revision,
        artifactSha256: config.artifactSha256,
        dimension: config.dimension,
        dtype: config.dtype,
        pooling: config.pooling,
        queryPrefix: config.queryPrefix,
        passagePrefix: config.passagePrefix,
        tokenizerConfigBundleSha256: config.tokenizerConfigBundleSha256,
        normalization: config.normalization,
        maxInputTokens: config.maxInputTokens,
        truncationPolicy: config.truncationPolicy,
      },
    }
    const embedBatch = vi.fn(async (requestId: string, texts: readonly string[], role: 'query' | 'passage') => {
      const { modelPath: _modelPath, artifactPath: _artifactPath, timeoutMs: _timeoutMs, ...modelIdentity } = config
      return {
        vectors: texts.map(() => new Float32Array(config.dimension)),
        receipt: {
          receiptId: 'custom-query-receipt',
          requestId,
          providerSchemaVersion: 'experience-embedding-provider-v2' as const,
          modelIdentity,
          role,
          inputCount: texts.length,
          dimension: config.dimension,
          createdAt: NOW,
        },
      }
    })
    const recall = new ConservativeRecall({
      readRetrievalInternal: () => ({
        projection: projectionSnapshot,
        vectors: new Map([[projectionSnapshot.documents[0]!.documentId, new Float32Array(config.dimension)]]),
      }),
    }, { embedBatch, dispose: vi.fn(async () => undefined) })
    const fingerprint = fingerprintFor('verify custom model recall', 'general')

    await expect(recall.prepare(fingerprint, runtime, digestChar('a'))).resolves.toMatchObject({
      denseState: 'unavailable',
      denseFailureCode: 'embedding_applicability_not_calibrated',
      queryVector: null,
      denseApplicabilityProfile: null,
    })
    expect(embedBatch).not.toHaveBeenCalled()

    await expect(recall.prepare(fingerprint, runtime, null)).resolves.toMatchObject({
      denseState: 'ready',
      denseFailureCode: null,
      queryEmbeddingReceiptId: 'custom-query-receipt',
      denseApplicabilityProfile: null,
    })
    expect(embedBatch).toHaveBeenCalledTimes(1)
  })

  it('ignores stale vectors and blocks model-only evidence', () => {
    const stale = projection('stale', 'procedure', 'general', 'semantic only passage')
    const modelOnly = { ...projection('model', 'procedure', 'general', 'shared lexical evidence task'),
      evidenceGrade: 'model_asserted' as const }
    const fingerprint = fingerprintFor('shared lexical evidence task', 'general')
    const staleDocument = projectExperienceVersion(stale)
    const staleProjection = retrievalProjection([stale, modelOnly])
    const altered = { ...stale, contentDigest: digestChar('f') }
    const result = selectHybridMatchingExperiences(
      fingerprint,
      [altered, modelOnly],
      32,
      NOW,
      eligibility(),
      {
        ...operation(fingerprint, [], {
          projection: staleProjection,
          queryVector: new Float32Array([1, 0]),
          vectors: new Map([[staleDocument.documentId, new Float32Array([1, 0])]]),
        }),
      },
    )

    expect(result.matchSet.noMatch).toBe(true)
    const blocked = result.matchSet.candidates.find(item => item.experienceVersionId === modelOnly.experienceVersionId)
    expect(blocked?.reasonCodes).toContain('evidence_gate_not_met')
    expect(result.matchSet.retrievalDecision?.primaryExperienceVersionId).toBeNull()
  })

  it('enters the real repository snapshot and enforces one durable automatic recall decision', async () => {
    const fixture = await retrievalFixture(32)
    try {
      const published = await seedVersion(fixture.database, fixture.actor, {
        ...diagnosticSpec(
          'Expired certificate recovery',
          'Diagnose an expired certificate and verify renewal',
          'certificate expired renew verify TLS',
        ),
        scope: { taskFamily: 'diagnostic', targetExposure: 'local' },
      })
      const recall = {
        prepare: async (fingerprint: ReturnType<typeof fingerprintFor>, _runtime: unknown, decisionKey: string | null) => {
          const versions = fixture.repository.listPlanningVersions(fixture.actor, 128)
          return operation(fingerprint, versions, { recallDecisionKey: decisionKey })
        },
      }
      const service = makePlanningService(fixture.repository, 32, undefined, recall)
      const values = RuntimeSettingsSchema({} as RuntimeSettings)
      const runtime = { revision: null, digest: digestChar('e'), values }
      const decisionKey = digestChar('a')
      const inputTask = planningTask({
        text: 'diagnose certificate expired then renew and verify TLS',
        targetExposure: 'local',
      })
      const first = await service.plan(
        planInput('hybrid-durable-first', inputTask), fixture.actor, undefined, runtime, decisionKey,
      )
      expect(first.planning.matchSet).toMatchObject({
        retrievalVersion: 'conservative-hybrid-v1',
        recallDecisionKey: decisionKey,
        retrievalDecision: { primaryExperienceVersionId: published.experienceVersionId },
      })
      expect(fixture.repository.getPlanningResult(first.planning.plan.usageId, fixture.actor).matchSet)
        .toEqual(first.planning.matchSet)
      expect(fixture.repository.hasRecallDecisionKey(decisionKey, fixture.actor)).toBe(true)
      await expect(service.plan(
        planInput('hybrid-durable-second', inputTask), fixture.actor, undefined, runtime, decisionKey,
      )).rejects.toMatchObject({ code: 'idempotency_conflict' })

      const row = fixture.database.handle.prepare(
        'SELECT payload_json FROM experience_usages WHERE usage_id = ?',
      ).get(first.planning.plan.usageId) as { payload_json: string }
      const forged = JSON.parse(row.payload_json) as {
        matchSet: { retrievalDecision: {
          denseApplicabilityProfileDigest: string | null
          denseApplicabilityAllowedKinds: string[] | null
        } }
      }
      forged.matchSet.retrievalDecision.denseApplicabilityProfileDigest = digestChar('f')
      forged.matchSet.retrievalDecision.denseApplicabilityAllowedKinds = ['fact']
      fixture.database.handle.prepare(
        'UPDATE experience_usages SET payload_json = ? WHERE usage_id = ?',
      ).run(JSON.stringify(forged), first.planning.plan.usageId)
      expect(() => fixture.repository.getPlanningResult(first.planning.plan.usageId, fixture.actor))
        .toThrow('PlanningResult durable JSON is inconsistent')
    } finally {
      await fixture.close()
    }
  })

  it('fails closed on a changed model generation and schedules only one background rebuild', async () => {
    const candidate = projection('settings-stale', 'procedure', 'general', 'shared task')
    const fingerprint = fingerprintFor('shared task', 'general')
    const projected = retrievalProjection([candidate])
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    const rebuild = vi.fn(() => pending)
    const embedding = { embedBatch: vi.fn(), dispose: vi.fn(async () => undefined) }
    const recall = new ConservativeRecall({
      readRetrievalInternal: () => ({ projection: projected, vectors: new Map() }),
    }, embedding as never, rebuild)
    const values = RuntimeSettingsSchema({} as RuntimeSettings)
    const runtime = { revision: null, digest: digestChar('e'), values }

    const [first, second] = await Promise.all([
      recall.prepare(fingerprint, runtime, null),
      recall.prepare(fingerprint, runtime, null),
    ])
    expect(first).toMatchObject({ denseState: 'disabled', queryVector: null })
    expect(second).toMatchObject({ denseState: 'disabled', queryVector: null })
    expect(embedding.embedBatch).not.toHaveBeenCalled()
    expect(rebuild).toHaveBeenCalledTimes(1)
    finish()
    await pending
  })
})

function projection(
  id: string,
  kind: ExperienceMatchProjection['kind'],
  taskFamily: string,
  text: string,
  symptom = text,
): ExperienceMatchProjection {
  const roles = TYPE_BEHAVIORS[kind].requiredRoles
  const components = roles.map((role, index) => ({
    componentId: brandedId<'ExperienceComponentId'>(`${id}-component-${index}`, 'componentId'),
    componentRevisionId: brandedId<'ExperienceComponentRevisionId'>(`${id}-revision-${index}`, 'componentRevisionId'),
    role,
    content: role === 'symptom_signature' ? symptom : `${role}: ${text}`,
  }))
  return {
    experienceVersionId: brandedId<'ExperienceVersionId'>(`${id}-version`, 'experienceVersionId'),
    experienceId: brandedId<'ExperienceId'>(`${id}-experience`, 'experienceId'),
    kind,
    title: text,
    intent: text,
    scope: { taskFamily, targetExposure: 'local' },
    validity: {},
    riskAndEffectSpec: {},
    privacyClass: 'workspace',
    allowedUseModes: ['reference', 'suggest', 'guided'],
    evidenceGrade: 'observation_supported',
    contentDigest: digestChar(id.charCodeAt(0).toString(16).slice(-1)),
    componentRevisionIds: components.map(component => component.componentRevisionId),
    components,
  }
}

function directSessionWithFocus(
  base: ExperienceMatchProjection,
  focus: string,
): ExperienceMatchProjection {
  return {
    ...base,
    validity: { source: 'completed_dsh_session_turn' },
    components: base.components.map(component => ({
      ...component,
      content: component.role === 'goal_signature' ? focus : component.content,
    })),
  }
}

function fingerprintFor(text: string, taskFamily: string) {
  return fingerprintTask(task(text), actor(), NOW, { taskFamily })
}

function task(text: string): PlanningTaskInput {
  return {
    text,
    workspaceRoot: null,
    targetExposure: 'local',
    mustUseExperience: false,
    riskClass: 'standard',
    requiredCapabilities: [],
    requestedUseMode: 'guided',
    overrideDecisionIds: [],
  }
}

function actor(): ActorView {
  return {
    actorId: brandedId<'ExperienceActorId'>('hybrid-actor', 'actorId'),
    principalId: brandedId<'ExperienceLocalOwnerPrincipalId'>('hybrid-principal', 'principalId'),
    kind: 'management_local_owner',
    authority: 'owner',
  }
}

function eligibility() {
  return { requestedUseMode: 'guided' as const, workspaceRoot: null, requiredCapabilities: [] }
}

function operation(
  fingerprint: ReturnType<typeof fingerprintFor>,
  versions: readonly ExperienceMatchProjection[],
  overrides: Partial<HybridRetrievalOperation> = {},
): HybridRetrievalOperation {
  return {
    query: projectTaskFingerprint(fingerprint),
    projection: retrievalProjection(versions),
    vectors: new Map(),
    queryVector: null,
    queryEmbeddingReceiptId: null,
    denseState: overrides.queryVector === undefined ? 'disabled' : 'ready',
    denseFailureCode: null,
    denseSimilarityThreshold: 0.76,
    denseMargin: 0.025,
    denseApplicabilityProfile: overrides.queryVector === undefined ? null : {
      profileDigest: digestChar('f'),
      allowedKinds: ['diagnostic', 'procedure'],
    },
    recallDecisionKey: digestChar('a'),
    ...overrides,
  }
}

function localEmbeddingSettings(
  defaults: RuntimeSettings,
  overrides: Partial<RuntimeSettings>,
): { readonly revision: number | null; readonly digest: string; readonly values: RuntimeSettings } {
  return {
    revision: 1,
    digest: digestChar('e'),
    values: RuntimeSettingsSchema({ ...defaults, ...overrides }),
  }
}

function retrievalProjection(versions: readonly ExperienceMatchProjection[]): ExperienceRetrievalProjectionView {
  const documents = versions.map(projectExperienceVersion)
  return {
    projectionKey: 'experience-retrieval-v1',
    schemaVersion: 2,
    manifest: {
      schemaVersion: 'experience-retrieval-projection-manifest-v2',
      projectionVersion: 'experience-retrieval-projector-v2',
      generation: 3,
      state: 'dense_ready',
      provider: 'transformers_js',
      providerState: 'ready',
      modelId: 'test/e5',
      modelRevision: 'revision-1',
      artifactSha256: 'a'.repeat(64),
      dimension: 2,
      dtype: 'q8',
      pooling: 'mean',
      queryPrefix: 'query: ',
      passagePrefix: 'passage: ',
      tokenizerConfigBundleSha256: 'b'.repeat(64),
      normalization: 'l2',
      maxInputTokens: 512,
      truncationPolicy: 'truncate_end',
      operationSettingsRevision: 1,
      operationSettingsDigest: digestChar('b'),
      sourceWatermarkDigest: digestChar('c'),
      contentDigest: digestChar('d'),
      documentCount: documents.length,
      vectorCount: documents.length,
      failureCode: null,
      builtAt: NOW,
    },
    documents,
  }
}

function digestChar(value: string): string {
  return `sha256:${(value.match(/[a-f0-9]/u)?.[0] ?? '0').repeat(64)}`
}
