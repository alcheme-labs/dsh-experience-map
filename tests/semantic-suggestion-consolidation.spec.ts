import { describe, expect, it, vi } from 'vitest'
import type { EmbeddingProviderPort } from '../src/application/retrieval-projection.js'
import { consolidatePublishedSuggestionDuplicates } from '../src/application/semantic-suggestion-consolidation.js'
import { suggestionDigest } from '../src/domain/automatic-suggestion.js'
import { TYPE_BEHAVIORS } from '../src/domain/behavior.js'
import { experienceKernelIdentity } from '../src/domain/experience-kernel.js'
import type { ExperienceKind } from '../src/domain/kind.js'
import { suggestionDecisionDigests, suggestionSaveEligibility } from '../src/domain/suggestion-materializer.js'
import { projectExperienceVersion } from '../src/domain/retrieval-projector.js'
import { brandedId } from '../src/ids.js'
import { RuntimeSettingsSchema, type RuntimeSettings } from '../src/runtime-settings-schema.js'
import type { RuntimeSettingsSnapshot } from '../src/runtime-settings.js'
import type { ExperienceSuggestionGroupView, ExperienceVersionView } from '../src/types.js'
import { episodeRef, sourceRef, workflowDraft } from './fixtures/workflow.js'

describe('semantic suggestion consolidation', () => {
  it('attaches a calibrated paraphrase only after complete component correspondence', async () => {
    const saved = version('宿主是否具备插件运行条件')
    const document = projectExperienceVersion(saved)
    const group = suggestionGroup('重新判断当前宿主能不能承载这个插件')
    const runtime = settings()
    const provider = fakeProvider(new Float32Array([1, 0]))

    const [resolved] = await consolidatePublishedSuggestionDuplicates(
      [group],
      {
        projection: {
          projectionKey: 'experience-retrieval-v1', schemaVersion: 2,
          manifest: {
            schemaVersion: 'experience-retrieval-projection-manifest-v2',
            projectionVersion: 'experience-retrieval-projector-v2', generation: 4,
            state: 'dense_ready', provider: 'transformers_js', providerState: 'ready',
            modelId: runtime.values.embeddingModelId,
            modelRevision: runtime.values.embeddingModelRevision,
            artifactSha256: runtime.values.embeddingArtifactSha256,
            dimension: runtime.values.embeddingDimension, dtype: runtime.values.embeddingDtype,
            pooling: runtime.values.embeddingPooling,
            queryPrefix: runtime.values.embeddingQueryPrefix,
            passagePrefix: runtime.values.embeddingPassagePrefix,
            tokenizerConfigBundleSha256: runtime.values.embeddingTokenizerConfigBundleSha256,
            normalization: runtime.values.embeddingNormalization,
            maxInputTokens: runtime.values.embeddingMaxInputTokens,
            truncationPolicy: runtime.values.embeddingTruncationPolicy,
            operationSettingsRevision: runtime.revision,
            operationSettingsDigest: suggestionDigest({ test: 'settings' }),
            sourceWatermarkDigest: suggestionDigest({ test: 'source' }),
            contentDigest: suggestionDigest({ test: 'retrieval' }),
            documentCount: 1, vectorCount: 1, failureCode: null,
            builtAt: '2099-01-01T00:00:00.000Z',
          },
          documents: [document],
        },
        vectors: new Map([[document.documentId, new Float32Array([1, 0])]]),
      },
      [saved],
      runtime,
      provider,
    )

    expect(resolved).toMatchObject({
      consolidation: 'semantic_duplicate',
      saveReadiness: 'ready',
      relatedExperienceVersionIds: [saved.experienceVersionId],
      canonicalMatch: { experienceVersionId: saved.experienceVersionId },
      consolidationDetail: {
        decision: 'same',
        reasonCodes: ['component_correspondence_complete'],
      },
    })
    expect(resolved?.reviewDigest).toMatch(/^sha256:/u)
    expect(resolved?.consolidationDetail?.componentCorrespondence).toHaveLength(group.draft.components.length)
    expect(provider.embedBatch).toHaveBeenCalledTimes(2)
  })

  it('does not let an identical vector turn a Chinese hard negative into a saveable duplicate', async () => {
    const saved = version('只读取 git 分支、HEAD 和工作树状态')
    const document = projectExperienceVersion(saved)
    const group = suggestionGroup('检查插件 API、Session v3 和共享路由，明确不只检查 git')
    const runtime = settings()

    const [resolved] = await consolidatePublishedSuggestionDuplicates(
      [group],
      {
        projection: {
          projectionKey: 'experience-retrieval-v1', schemaVersion: 2,
          manifest: manifest(runtime, document), documents: [document],
        },
        vectors: new Map([[document.documentId, new Float32Array([1, 0])]]),
      },
      [saved],
      runtime,
      fakeProvider(new Float32Array([1, 0])),
    )

    expect(resolved).toMatchObject({
      consolidation: 'distinct',
      saveReadiness: 'ready',
      relatedExperienceVersionIds: [saved.experienceVersionId],
      consolidationDetail: {
        decision: 'different',
        reasonCodes: expect.arrayContaining(['scope_constraint_conflict']),
      },
    })
    expect(resolved?.canonicalMatch).toBeUndefined()
  })

  it('releases provisional recent duplicates when component comparison proves they are different', async () => {
    const runtime = settings()
    const left = provisionalRelatedGroup(namedGroup('auth', '接口返回 401'), 'network')
    const right = provisionalRelatedGroup(namedGroup('network', '接口返回 404'), 'auth')

    const resolved = await consolidatePublishedSuggestionDuplicates(
      [left, right], emptyRetrieval(runtime), [], runtime, fakeProvider(new Float32Array([1, 0])),
    )

    expect(resolved).toHaveLength(2)
    expect(resolved).toEqual(expect.arrayContaining([
      expect.objectContaining({
        suggestionGroupId: left.suggestionGroupId,
        consolidation: 'distinct', saveReadiness: 'ready', relatedGroupIds: [],
        readinessReasons: [],
      }),
      expect.objectContaining({
        suggestionGroupId: right.suggestionGroupId,
        consolidation: 'distinct', saveReadiness: 'ready', relatedGroupIds: [],
        readinessReasons: [],
      }),
    ]))
    expect(resolved.every(group => group.reviewDigest !== null)).toBe(true)
  })

  it('consolidates provisional recent duplicates when all required components are semantically the same', async () => {
    const runtime = settings()
    const left = provisionalRelatedGroup(namedGroup('left', '宿主能否运行这个插件'), 'right')
    const right = provisionalRelatedGroup(namedGroup('right', '当前环境是否具备插件运行条件'), 'left')

    const resolved = await consolidatePublishedSuggestionDuplicates(
      [left, right], emptyRetrieval(runtime), [], runtime, fakeProvider(new Float32Array([1, 0])),
    )

    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({
      consolidation: 'semantic_consolidated', saveReadiness: 'ready', occurrenceCount: 2,
      readinessReasons: [],
      relatedGroupIds: ['suggestion-group:left', 'suggestion-group:right'],
      consolidationDetail: { decision: 'same' },
    })
    expect(resolved[0]?.reviewDigest).toMatch(/^sha256:/u)
  })

  it('does not release a high-similarity provisional relation that was pruned by the neighbour bound', async () => {
    const runtime = settings()
    const ids = ['a', 'b', 'c', 'd', 'e']
    const groups = ids.map((id, index) => provisionalRelatedGroups(
      namedGroup(id, `接口返回 ${String(401 + index)}`),
      ids.filter(relatedId => relatedId !== id),
    ))

    const resolved = await consolidatePublishedSuggestionDuplicates(
      groups, emptyRetrieval(runtime), [], runtime, fakeProvider(new Float32Array([1, 0])),
    )

    expect(resolved.filter(group => group.saveReadiness === 'needs_review')).toEqual(expect.arrayContaining([
      expect.objectContaining({ suggestionGroupId: 'suggestion-group:d' }),
      expect.objectContaining({ suggestionGroupId: 'suggestion-group:e' }),
    ]))
  })

  it('never releases an exact-identity component conflict through semantic comparison', async () => {
    const runtime = settings()
    const left = provisionalRelatedGroup(namedGroup('left-conflict', '接口返回 401'), 'right-conflict')
    const right = provisionalRelatedGroup(namedGroup('right-conflict', '接口返回 404'), 'left-conflict')
    const conflicted = {
      ...left,
      readinessReasons: [...left.readinessReasons, 'exact_identity_component_conflict'],
    }
    const finalized = { ...conflicted, ...suggestionDecisionDigests(conflicted) }

    const resolved = await consolidatePublishedSuggestionDuplicates(
      [finalized, right], emptyRetrieval(runtime), [], runtime, fakeProvider(new Float32Array([1, 0])),
    )

    expect(resolved.find(group => group.suggestionGroupId === finalized.suggestionGroupId)).toMatchObject({
      consolidation: 'possible_duplicate', saveReadiness: 'needs_review',
      readinessReasons: expect.arrayContaining(['exact_identity_component_conflict']),
    })
  })

  it('keeps cross-scope specialization review-only even when vectors are identical', async () => {
    const runtime = settings()
    const left = provisionalSpecializationGroup(namedGroup('scope-a', '检查插件状态'), 'scope-b')
    const right = provisionalSpecializationGroup(namedGroup('scope-b', '检查插件状态'), 'scope-a')

    const resolved = await consolidatePublishedSuggestionDuplicates(
      [left, right], emptyRetrieval(runtime), [], runtime, fakeProvider(new Float32Array([1, 0])),
    )

    expect(resolved).toHaveLength(2)
    expect(resolved.every(group => group.consolidation === 'specialization')).toBe(true)
    expect(resolved.every(group => group.saveReadiness === 'needs_review')).toBe(true)
  })

  it('never lets a semantic match promote an incomplete suggestion through the save gate', async () => {
    const saved = version('宿主是否具备插件运行条件')
    const document = projectExperienceVersion(saved)
    const group = suggestionGroup('重新判断当前宿主能不能承载这个插件', 'needs_enrichment')
    const runtime = settings()

    const [resolved] = await consolidatePublishedSuggestionDuplicates(
      [group],
      {
        projection: {
          projectionKey: 'experience-retrieval-v1', schemaVersion: 2,
          manifest: manifest(runtime, document), documents: [document],
        },
        vectors: new Map([[document.documentId, new Float32Array([1, 0])]]),
      },
      [saved],
      runtime,
      fakeProvider(new Float32Array([1, 0])),
    )

    expect(resolved).toMatchObject({
      consolidation: 'possible_duplicate',
      saveReadiness: 'needs_enrichment',
      readinessReasons: expect.arrayContaining(['stable_action_details_missing', 'semantic_duplicate_incomplete']),
      relatedExperienceVersionIds: [saved.experienceVersionId],
    })
    expect(resolved?.canonicalMatch).toBeUndefined()
  })

  it('abstains when a same-scope similarity stays below the conservative duplicate boundary', async () => {
    const saved = version('只读取 git 分支和工作树状态')
    const document = projectExperienceVersion(saved)
    const group = suggestionGroup('核验插件 API、Session v3 日志和共享路由')
    const runtime = settings({ equivalenceSimilarityThreshold: 0.965 })

    const [resolved] = await consolidatePublishedSuggestionDuplicates(
      [group],
      {
        projection: {
          projectionKey: 'experience-retrieval-v1', schemaVersion: 2,
          manifest: manifest(runtime, document),
          documents: [document],
        },
        vectors: new Map([[document.documentId, new Float32Array([1, 0])]]),
      },
      [saved],
      runtime,
      fakeProvider(new Float32Array([0.95, Math.sqrt(1 - 0.95 ** 2)])),
    )

    expect(resolved).toMatchObject({
      suggestionGroupId: group.suggestionGroupId,
      consolidation: 'distinct',
      consolidationDetail: {
        decision: 'different',
        reasonCodes: ['published_shortlist_empty'],
        targetExperienceVersionId: null,
      },
    })
    expect(resolved?.consolidationDetail?.activeComparisonSetDigest)
      .toBeDefined()
    expect(resolved?.canonicalMatch).toBeUndefined()
  })

  it('consolidates recent paraphrases into one stable representative and merges only mapped component sources', async () => {
    const runtime = settings()
    const left = namedGroup('a', '宿主能否运行这个插件')
    const right = namedGroup('b', '当前环境是否具备插件运行条件')

    const first = await consolidatePublishedSuggestionDuplicates(
      [right, left], emptyRetrieval(runtime), [], runtime, fakeProvider(new Float32Array([1, 0])),
    )
    const second = await consolidatePublishedSuggestionDuplicates(
      [left, right], emptyRetrieval(runtime), [], runtime, fakeProvider(new Float32Array([1, 0])),
    )

    expect(first).toHaveLength(1)
    expect(first).toEqual(second)
    expect(first[0]).toMatchObject({
      consolidation: 'semantic_consolidated', occurrenceCount: 2,
      relatedGroupIds: ['suggestion-group:a', 'suggestion-group:b'],
      consolidationDetail: {
        decision: 'same',
        sourceSuggestionGroupIds: ['suggestion-group:a', 'suggestion-group:b'],
      },
    })
    const symptom = first[0]!.draft.components.find(component => component.role === 'symptom_signature')!
    expect(symptom.sourceRefs).toEqual(['source:a', 'source:b'])
    expect(first[0]!.consolidationDetail?.componentCorrespondence).toHaveLength(left.draft.components.length * 2)
  })

  it('maps every source component in a recent semantic cluster to the published target', async () => {
    const runtime = settings()
    const left = namedGroup('a', '宿主能否运行这个插件')
    const right = namedGroup('b', '当前环境是否具备插件运行条件')
    const saved = version('宿主能否运行这个插件')
    const document = projectExperienceVersion(saved)

    const [resolved] = await consolidatePublishedSuggestionDuplicates(
      [right, left], retrieval(runtime, [document], [new Float32Array([1, 0])]), [saved], runtime,
      fakeProvider(new Float32Array([1, 0])),
    )

    expect(resolved).toMatchObject({
      consolidation: 'semantic_duplicate', occurrenceCount: 2,
      consolidationDetail: { decision: 'same', targetExperienceVersionId: saved.experienceVersionId },
    })
    const correspondence = resolved!.consolidationDetail!.componentCorrespondence
    expect(correspondence).toHaveLength(left.draft.components.length * 2)
    expect(new Set(correspondence.map(item => item.incomingSuggestionGroupId)))
      .toEqual(new Set([left.suggestionGroupId, right.suggestionGroupId]))
    expect(correspondence.every(item => item.targetComponentRevisionId !== null)).toBe(true)
  })

  it('uses complete-link clustering so semantic similarity is never transitively closed', async () => {
    const runtime = settings()
    const groups = [
      namedGroup('a', '检查宿主能力'),
      namedGroup('b', '核验当前环境能力'),
      namedGroup('c', '判断运行环境条件'),
    ]
    const provider = scriptedProvider([
      new Float32Array([1, 0]),
      new Float32Array([Math.cos(0.35), Math.sin(0.35)]),
      new Float32Array([Math.cos(0.7), Math.sin(0.7)]),
    ])

    const result = await consolidatePublishedSuggestionDuplicates(
      groups, emptyRetrieval(runtime), [], runtime, provider,
    )

    expect(result).toHaveLength(2)
    expect(result.find(group => group.consolidation === 'semantic_consolidated'))
      .toMatchObject({ relatedGroupIds: ['suggestion-group:a', 'suggestion-group:b'] })
    expect(result.find(group => group.suggestionGroupId === 'suggestion-group:c')).toBeDefined()
  })

  it('classifies an action flip as different even when every supplied vector is identical', async () => {
    const runtime = settings()
    const saved = version('检查配置')
    const target = {
      ...saved,
      components: saved.components.map(component => component.role === 'resolution_candidate'
        ? { ...component, content: '读取配置并验证' } : component),
    }
    const group = withDraft(namedGroup('action', '检查配置'), draft => ({
      ...draft,
      components: draft.components.map(component => component.role === 'resolution_candidate'
        ? { ...component, content: '删除配置并验证' } : component),
    }))
    const document = projectExperienceVersion(target)

    const [resolved] = await consolidatePublishedSuggestionDuplicates(
      [group], retrieval(runtime, [document], [new Float32Array([1, 0])]), [target], runtime,
      fakeProvider(new Float32Array([1, 0])),
    )

    expect(resolved).toMatchObject({
      consolidation: 'distinct',
      consolidationDetail: { decision: 'different', reasonCodes: expect.arrayContaining(['action_capability_conflict']) },
    })
  })

  it.each([
    ['condition polarity', 'diagnostic', 'environment_scope', '只适用于 workspace-a', '不适用于 workspace-a', 'condition_polarity_conflict'],
    ['condition state', 'diagnostic', 'environment_scope', '依赖已配置的本地模型', '本地模型未配置', 'condition_polarity_conflict'],
    ['negated action', 'procedure', 'step', '读取 git 状态，不检查 API 或 Session', '检查 API、Session 和 git 状态', 'condition_polarity_conflict'],
    ['HTTP status anchor', 'diagnostic', 'symptom_signature', '接口返回 401', '接口返回 404', 'semantic_anchor_conflict'],
    ['system error anchor', 'diagnostic', 'symptom_signature', '启动失败 EADDRINUSE', '启动失败 ECONNREFUSED', 'semantic_anchor_conflict'],
    ['IPv4 anchor', 'diagnostic', 'environment_scope', '本地服务 127.0.0.1', '本地服务 127.0.0.2', 'semantic_anchor_conflict'],
    ['verifier', 'diagnostic', 'recovery_verifier', 'HTTP 200 响应', '测试用例通过', 'outcome_verifier_conflict'],
  ] as const)(
    'classifies a %s change as different even when every supplied vector is identical',
    async (_label, kind, role, incoming, target, reasonCode) => {
      const runtime = settings()
      const group = typedGroup(kind, role, incoming)
      const saved = typedVersion(kind, role, target)
      const document = projectExperienceVersion(saved)

      const [resolved] = await consolidatePublishedSuggestionDuplicates(
        [group], retrieval(runtime, [document], [new Float32Array([1, 0])]), [saved], runtime,
        fakeProvider(new Float32Array([1, 0])),
      )

      expect(resolved).toMatchObject({
        consolidation: 'distinct',
        consolidationDetail: { decision: 'different', reasonCodes: expect.arrayContaining([reasonCode]) },
      })
    },
  )

  it('does not treat tool-output wording and supplemental numeric detail as proof of a distinct procedure', async () => {
    const runtime = settings()
    const incoming = withDraft(
      typedGroup('procedure', 'goal_signature', '核对 Node v23.10.0 是否满足 engines.node，并解释 exit=0 为什么仍可能是假成功'),
      draft => ({
        ...draft,
        components: draft.components.map(component => {
          if (component.role === 'entry_condition') {
            return { ...component, content: '目标是核对 Node v23.10.0 与当前 engines.node，并且只读执行' }
          }
          if (component.role === 'step') {
            return { ...component, content: '读取 package 和日志，再用 test 验证 Node v23.10.0 是否受支持' }
          }
          return component
        }),
      }),
    )
    const targetBase = typedVersion(
      'procedure',
      'goal_signature',
      '核对 Node v23.10.0 是否满足 ^22.19.0 || >=24.0.0',
    )
    const target = {
      ...targetBase,
      components: targetBase.components.map(component => {
        if (component.role === 'entry_condition') {
          return { ...component, content: '目标是核对 Node v23.10.0 与 ^22.19.0 || >=24.0.0，并且只读执行' }
        }
        if (component.role === 'step') {
          return { ...component, content: '读取 package 和日志，用 test 验证版本；依赖缺失时打印 no-semver' }
        }
        return component
      }),
      contentDigest: suggestionDigest({ test: 'node-runtime-supplemental-detail' }),
    }
    const document = projectExperienceVersion(target)

    const [resolved] = await consolidatePublishedSuggestionDuplicates(
      [incoming], retrieval(runtime, [document], [new Float32Array([1, 0])]), [target], runtime,
      fakeProvider(new Float32Array([1, 0])),
    )

    expect(resolved).toMatchObject({
      consolidation: 'semantic_duplicate',
      saveReadiness: 'ready',
      canonicalMatch: { experienceVersionId: target.experienceVersionId },
      consolidationDetail: {
        decision: 'same',
        reasonCodes: ['component_correspondence_complete'],
        materialDifferences: [],
      },
    })
  })

  it('treats bilingual materializer wording as one procedure when the verified command and scope are unchanged', async () => {
    const runtime = settings()
    const incomingContent: Readonly<Record<string, string>> = {
      goal_signature: '确认当前工作目录是否存在项目清单 package.json；只检查文件存在性，并报告已验证的结果。',
      entry_condition: '仅当当前目标一致、工作区为 /workspace/shared，且当前权限允许相应工具时进入。',
      forbidden_condition: '工作区、权限或验证器不一致时禁止直接照搬执行；自动建议本身不授予执行权限。',
      parameter: '一次性参数不固化；执行时重新读取当前任务参数和环境。',
      environment_adapter: '在 /workspace/shared 中按当前环境解析工具和路径，不复用会话中的临时绝对值。',
      step: '按已验证顺序执行稳定步骤：1. bash\n{ "command": "test -f ./package.json", "description": "检查项目清单是否存在" }。',
      checkpoint: '在关键步骤后使用 bash 检查当前结果。',
      side_effect_policy: '所有工具副作用继续服从当前任务权限、批准和预检；本经验只提供指导。',
      failure_branch: '任一步骤或最终验证失败时停止复用并重新诊断，不把 turn 完成当作成功。',
      verifier: '只有 bash 返回结构化成功结果时才算完成。',
    }
    const targetContent: Readonly<Record<string, string>> = {
      goal_signature: 'Check that package.json exists in the current workspace, then report the verified result.',
      entry_condition: 'Enter only when the current goal matches, the workspace is /workspace/shared, and current authority permits the tools.',
      forbidden_condition: 'Do not copy the path when workspace, authority, or verifier differs; a suggestion grants no execution permission.',
      parameter: 'Do not freeze one-off values; resolve current task parameters and environment at use time.',
      environment_adapter: 'Resolve tools and paths in /workspace/shared from the current environment rather than retaining transient absolute values.',
      step: 'Run the stable observed sequence: 1. bash\n{ "command": "test -f package.json", "description": "Verify that the project manifest exists" }.',
      checkpoint: 'After material steps, inspect the current result with bash.',
      side_effect_policy: 'All tool effects remain subject to current task authority, approval, and preflight; this Experience is guidance only.',
      failure_branch: 'If any step or final verifier fails, stop reuse and diagnose; turn completion is not success.',
      verifier: 'Completion requires a structurally successful bash result.',
    }
    const incoming = withDraft(
      typedGroup('procedure', 'goal_signature', incomingContent.goal_signature!),
      draft => ({
        ...draft,
        components: draft.components.map(component => ({
          ...component,
          content: incomingContent[component.role] ?? component.content,
        })),
      }),
    )
    const targetBase = typedVersion('procedure', 'goal_signature', targetContent.goal_signature!)
    const target = {
      ...targetBase,
      components: targetBase.components.map(component => ({
        ...component,
        content: targetContent[component.role] ?? component.content,
        evidenceIds: ['entry_condition', 'forbidden_condition', 'parameter', 'environment_adapter', 'side_effect_policy']
          .includes(component.role) ? [] : component.evidenceIds,
      })),
      contentDigest: suggestionDigest({ test: 'bilingual-materializer-procedure' }),
    }
    const document = projectExperienceVersion(target)

    const [resolved] = await consolidatePublishedSuggestionDuplicates(
      [incoming], retrieval(runtime, [document], [new Float32Array([1, 0])]), [target], runtime,
      fakeProvider(new Float32Array([1, 0])),
    )

    expect(resolved).toMatchObject({
      consolidation: 'semantic_duplicate',
      saveReadiness: 'ready',
      canonicalMatch: { experienceVersionId: target.experienceVersionId },
      consolidationDetail: {
        decision: 'same',
        reasonCodes: ['component_correspondence_complete'],
        materialDifferences: [],
      },
    })
    expect(resolved?.consolidationDetail?.componentCorrespondence).toHaveLength(incoming.draft.components.length)
  })

  it.each([
    ['missing state', 'discriminator', 'missing credential', '缺少凭据'],
    ['missing attachment', 'symptom_signature', '缺少 profile 凭据', 'profile 凭据未附带'],
    ['add action', 'resolution_candidate', 'add auth header', '添加认证头'],
  ] as const)(
    'keeps a bilingual %s paraphrase eligible for component correspondence',
    async (_label, role, incoming, target) => {
      const runtime = settings()
      const group = typedGroup('diagnostic', role, incoming)
      const saved = typedVersion('diagnostic', role, target)
      const document = projectExperienceVersion(saved)

      const [resolved] = await consolidatePublishedSuggestionDuplicates(
        [group], retrieval(runtime, [document], [new Float32Array([1, 0])]), [saved], runtime,
        fakeProvider(new Float32Array([1, 0])),
      )

      expect(resolved).toMatchObject({
        consolidation: 'semantic_duplicate',
        consolidationDetail: { decision: 'same', reasonCodes: ['component_correspondence_complete'] },
      })
    },
  )

  it.each([
    ['preference authority', 'preference_policy', 'authority_source', '当前用户原话', '工作区管理员规则'],
    ['fact value', 'fact', 'object_or_value', 'blue', 'green'],
    ['procedure side effect', 'procedure', 'side_effect_policy', '只读且不改文件', '允许修改配置'],
    ['causal mechanism', 'causal', 'mechanism', '缓存命中减少请求', '提高并发减少请求'],
  ] as const)(
    'keeps an exact-kernel %s conflict in review instead of appending evidence or creating a Series',
    async (_label, kind, role, incoming, target) => {
      const runtime = settings()
      const group = typedGroup(kind, role, incoming)
      const saved = typedVersion(kind, role, target)
      const document = projectExperienceVersion(saved)

      const [resolved] = await consolidatePublishedSuggestionDuplicates(
        [group], retrieval(runtime, [document], [new Float32Array([1, 0])]), [saved], runtime,
        fakeProvider(new Float32Array([1, 0])),
      )

      expect(resolved).toMatchObject({
        consolidation: 'possible_duplicate', saveReadiness: 'needs_review', reviewDigest: null,
        readinessReasons: expect.arrayContaining(['exact_kernel_component_conflict']),
        consolidationDetail: {
          decision: 'ambiguous', allowedOwnerChoices: [],
          reasonCodes: expect.arrayContaining(['exact_kernel_component_conflict']),
        },
      })
    },
  )

  it('keeps a semantic same result review-only for an uncalibrated model identity', async () => {
    const runtime = settings({ embeddingModelId: 'local/custom-model' })
    const saved = version('宿主是否具备插件运行条件')
    const document = projectExperienceVersion(saved)
    const group = suggestionGroup('重新判断当前宿主能不能承载这个插件')

    const [resolved] = await consolidatePublishedSuggestionDuplicates(
      [group], retrieval(runtime, [document], [new Float32Array([1, 0])]), [saved], runtime,
      fakeProvider(new Float32Array([1, 0])),
    )

    expect(resolved).toMatchObject({
      consolidation: 'possible_duplicate', saveReadiness: 'needs_review', reviewDigest: null,
      readinessReasons: expect.arrayContaining(['semantic_same_profile_not_calibrated']),
      consolidationDetail: { decision: 'ambiguous', allowedOwnerChoices: [] },
    })
  })

  it('requires a current canonical Version digest before producing semantic same', async () => {
    const runtime = settings()
    const saved = version('宿主是否具备插件运行条件')
    const document = projectExperienceVersion(saved)
    const stale = { ...saved, contentDigest: suggestionDigest({ changed: true }) }
    const group = suggestionGroup('重新判断当前宿主能不能承载这个插件')

    const [resolved] = await consolidatePublishedSuggestionDuplicates(
      [group], retrieval(runtime, [document], [new Float32Array([1, 0])]), [stale], runtime,
      fakeProvider(new Float32Array([1, 0])),
    )

    expect(resolved).toMatchObject({
      suggestionGroupId: group.suggestionGroupId,
      consolidation: 'distinct',
      consolidationDetail: {
        decision: 'different',
        reasonCodes: ['published_shortlist_empty'],
        targetExperienceVersionId: null,
      },
    })
    expect(resolved?.canonicalMatch).toBeUndefined()
  })

  it('binds a margin ambiguity into a reviewed attach choice and rejects forged choices', async () => {
    const runtime = settings()
    const first = version('宿主是否具备插件运行条件', 'a')
    const second = version('宿主是否具备插件运行条件', 'b')
    const documents = [projectExperienceVersion(first), projectExperienceVersion(second)]
    const group = suggestionGroup('重新判断当前宿主能不能承载这个插件')

    const [resolved] = await consolidatePublishedSuggestionDuplicates(
      [group], retrieval(runtime, documents, documents.map(() => new Float32Array([1, 0]))),
      [first, second], runtime, fakeProvider(new Float32Array([1, 0])),
    )
    const choice = {
      choice: 'attach_existing' as const,
      targetExperienceVersionId: resolved!.consolidationDetail!.targetExperienceVersionId!,
      materialDifferences: [],
    }

    expect(resolved).toMatchObject({
      consolidation: 'possible_duplicate', saveReadiness: 'needs_review',
      consolidationDetail: { decision: 'ambiguous', allowedOwnerChoices: ['attach_existing'] },
    })
    expect(resolved?.reviewDigest).toMatch(/^sha256:/u)
    expect(suggestionSaveEligibility(resolved!, choice).allowed).toBe(true)
    expect(suggestionSaveEligibility(resolved!, {
      ...choice, targetExperienceVersionId: brandedId<'ExperienceVersionId'>('version-forged', 'versionId'),
    }).allowed).toBe(false)
  })

  it('projects a verified condition specialization as an exact keep-distinct choice', async () => {
    const runtime = settings()
    const base = version('检查宿主条件')
    const target = {
      ...base,
      components: base.components.map(component => component.role === 'environment_scope'
        ? { ...component, content: 'workspace-a' } : component),
      contentDigest: suggestionDigest({ target: 'narrower-base' }),
    }
    const group = withDraft(namedGroup('specialized', '检查宿主条件'), draft => ({
      ...draft,
      components: draft.components.map(component => component.role === 'environment_scope'
        ? { ...component, content: 'workspace-a / package-b' } : component),
    }))
    const document = projectExperienceVersion(target)

    const [resolved] = await consolidatePublishedSuggestionDuplicates(
      [group], retrieval(runtime, [document], [new Float32Array([1, 0])]), [target], runtime,
      fakeProvider(new Float32Array([1, 0])),
    )
    const detail = resolved!.consolidationDetail!
    const choice = {
      choice: 'keep_distinct' as const,
      targetExperienceVersionId: detail.targetExperienceVersionId!,
      materialDifferences: detail.materialDifferences,
    }

    expect(resolved).toMatchObject({
      consolidation: 'specialization', saveReadiness: 'needs_review',
      consolidationDetail: { decision: 'specialization', allowedOwnerChoices: ['keep_distinct'] },
    })
    expect(resolved?.reviewDigest).toMatch(/^sha256:/u)
    expect(suggestionSaveEligibility(resolved!, choice).allowed).toBe(true)
    expect(suggestionSaveEligibility(resolved!, { ...choice, materialDifferences: [] }).allowed).toBe(false)
  })

  it('binds equivalence thresholds independently from recall thresholds', async () => {
    const saved = version('宿主是否具备插件运行条件')
    const document = projectExperienceVersion(saved)
    const group = suggestionGroup('重新判断当前宿主能不能承载这个插件')
    const run = async (runtime: RuntimeSettingsSnapshot) => (await consolidatePublishedSuggestionDuplicates(
      [group], retrieval(runtime, [document], [new Float32Array([1, 0])]), [saved], runtime,
      fakeProvider(new Float32Array([1, 0])),
    ))[0]!

    const baseline = await run(settings())
    const recallChanged = await run(settings({ embeddingSimilarityThreshold: 0.99, embeddingMargin: 0.2 }))
    const equivalenceChanged = await run(settings({ equivalenceSimilarityThreshold: 0.97 }))

    expect(recallChanged.consolidationDetail?.operationSettingsDigest)
      .toBe(baseline.consolidationDetail?.operationSettingsDigest)
    expect(recallChanged.reviewDigest).toBe(baseline.reviewDigest)
    expect(equivalenceChanged.consolidationDetail?.operationSettingsDigest)
      .not.toBe(baseline.consolidationDetail?.operationSettingsDigest)
    expect(equivalenceChanged.reviewDigest).not.toBe(baseline.reviewDigest)
  })
})

function suggestionGroup(
  goal: string,
  saveReadiness: ExperienceSuggestionGroupView['saveReadiness'] = 'ready',
): ExperienceSuggestionGroupView {
  const original = workflowDraft()
  const components = original.components.map(component => component.role === 'symptom_signature'
    ? { ...component, content: goal }
    : component)
  const draft = workflowDraft({
    title: goal,
    intent: goal,
    scope: { workspaceRoot: '/workspace/shared' },
    components,
  })
  const kernelIdentity = experienceKernelIdentity({
    kind: draft.proposedKind, scope: draft.scope, components: draft.components,
  })
  const base: ExperienceSuggestionGroupView = {
    suggestionGroupId: `suggestion-group:${kernelIdentity.slice(7)}`,
    kernelIdentity, revisionDigest: '', sourceDigest: suggestionDigest(sourceRef.contentDigest),
    kind: draft.proposedKind, title: draft.title, draft,
    saveReadiness,
    readinessReasons: saveReadiness === 'ready' ? ['current_permission_required'] : ['stable_action_details_missing'],
    missingFields: saveReadiness === 'ready' ? [] : ['resolution_candidate'], riskFlags: ['current_permission_required'],
    reviewDigest: null, consolidation: 'distinct', relatedGroupIds: [],
    occurrences: [{
      occurrenceId: 'occurrence:paraphrase', seedOccurrenceId: 'seed:paraphrase',
      sessionId: 'session:paraphrase', episodeRef, sourceRefs: [sourceRef],
      detectedAt: '2099-01-01T00:00:00.000Z', expiresAt: '2099-01-15T00:00:00.000Z',
    }],
    occurrenceCount: 1, sessionIds: ['session:paraphrase'], crossSession: false,
    detectorVersions: ['detector-v1'], segmenterVersions: ['segmenter-v1'],
    materializerVersion: 'materializer-v1', expiresAt: '2099-01-15T00:00:00.000Z',
  }
  return { ...base, ...suggestionDecisionDigests(base) }
}

function version(goal: string, suffix = 'existing'): ExperienceVersionView {
  const draft = workflowDraft({
    title: goal,
    intent: goal,
    scope: { workspaceRoot: '/workspace/shared' },
    components: workflowDraft().components.map(component => component.role === 'symptom_signature'
      ? { ...component, content: goal }
      : component),
  })
  return {
    experienceId: brandedId<'ExperienceId'>(`experience-${suffix}`, 'experienceId'),
    experienceVersionId: brandedId<'ExperienceVersionId'>(`version-${suffix}`, 'versionId'),
    versionNumber: 1, previousVersionId: null, kind: draft.proposedKind,
    title: draft.title, intent: draft.intent, scope: draft.scope, validity: draft.validity,
    authoritySpec: draft.authoritySpec, privacyClass: draft.privacyClass,
    riskAndEffectSpec: draft.riskAndEffectSpec, allowedUseModes: draft.allowedUseModes,
    components: draft.components.map((component, index) => ({
      ...component,
      componentId: brandedId<'ExperienceComponentId'>(`component-${String(index)}`, 'componentId'),
      componentRevisionId: brandedId<'ExperienceComponentRevisionId'>(`revision-${String(index)}`, 'revisionId'),
      evidenceIds: [brandedId<'ExperienceEvidenceId'>(`evidence-${String(index)}`, 'evidenceId')],
    })),
    componentRevisionIds: draft.components.map((_component, index) =>
      brandedId<'ExperienceComponentRevisionId'>(`revision-${String(index)}`, 'revisionId')),
    initialAssessmentId: brandedId<'ExperienceAssessmentId'>('assessment-existing', 'assessmentId'),
    relationIds: [], createdByDecisionId: 'decision-existing', evidenceGrade: draft.evidenceGrade,
    governanceState: 'accepted', operationalState: 'conditional', legacyWarnings: [],
    contentDigest: suggestionDigest({ version: 'existing' }), createdAt: '2099-01-01T00:00:00.000Z',
  }
}

function settings(overrides: Partial<RuntimeSettings> = {}): RuntimeSettingsSnapshot {
  const defaults = RuntimeSettingsSchema({} as RuntimeSettings)
  const values = RuntimeSettingsSchema({
    ...defaults,
    embeddingProvider: 'transformers_js', embeddingModelPath: '/tmp/test-model',
    ...overrides,
  })
  return { revision: 1, digest: suggestionDigest({ test: 'settings' }), values }
}

function namedGroup(id: string, goal: string): ExperienceSuggestionGroupView {
  const base = suggestionGroup(goal)
  const exactSource = {
    ...sourceRef,
    sourceRefId: `source:${id}` as never,
    contentDigest: suggestionDigest({ source: id }),
    locator: `dsh-session:${id}#1`,
    ownerScope: `session:${id}`,
  }
  const draft = {
    ...base.draft,
    components: base.draft.components.map(component => ({ ...component, sourceRefs: [exactSource.sourceRefId] })),
    fieldSourceRefs: Object.fromEntries(Object.keys(base.draft.fieldSourceRefs)
      .map(field => [field, [exactSource.sourceRefId]])),
  }
  const group: ExperienceSuggestionGroupView = {
    ...base,
    suggestionGroupId: `suggestion-group:${id}`,
    draft,
    sourceDigest: suggestionDigest(exactSource.contentDigest),
    occurrences: [{
      ...base.occurrences[0]!,
      occurrenceId: `occurrence:${id}`,
      seedOccurrenceId: `seed:${id}`,
      sessionId: `session:${id}`,
      sourceRefs: [exactSource],
    }],
    sessionIds: [`session:${id}`],
  }
  return { ...group, ...suggestionDecisionDigests(group) }
}

function provisionalRelatedGroup(
  group: ExperienceSuggestionGroupView,
  relatedId: string,
): ExperienceSuggestionGroupView {
  const provisional: ExperienceSuggestionGroupView = {
    ...group,
    consolidation: 'possible_duplicate',
    saveReadiness: 'needs_review',
    readinessReasons: ['possible_duplicate'],
    reviewDigest: null,
    relatedGroupIds: [`suggestion-group:${relatedId}`],
  }
  return { ...provisional, ...suggestionDecisionDigests(provisional) }
}

function provisionalRelatedGroups(
  group: ExperienceSuggestionGroupView,
  relatedIds: readonly string[],
): ExperienceSuggestionGroupView {
  const provisional: ExperienceSuggestionGroupView = {
    ...group,
    consolidation: 'possible_duplicate',
    saveReadiness: 'needs_review',
    readinessReasons: ['possible_duplicate'],
    reviewDigest: null,
    relatedGroupIds: relatedIds.map(relatedId => `suggestion-group:${relatedId}`),
  }
  return { ...provisional, ...suggestionDecisionDigests(provisional) }
}

function provisionalSpecializationGroup(
  group: ExperienceSuggestionGroupView,
  relatedId: string,
): ExperienceSuggestionGroupView {
  const provisional: ExperienceSuggestionGroupView = {
    ...group,
    consolidation: 'specialization',
    saveReadiness: 'needs_review',
    readinessReasons: ['specialization'],
    reviewDigest: null,
    relatedGroupIds: [`suggestion-group:${relatedId}`],
  }
  return { ...provisional, ...suggestionDecisionDigests(provisional) }
}

function withDraft(
  group: ExperienceSuggestionGroupView,
  update: (draft: ExperienceSuggestionGroupView['draft']) => ExperienceSuggestionGroupView['draft'],
): ExperienceSuggestionGroupView {
  const draft = update(group.draft)
  const changed = {
    ...group,
    draft,
    kernelIdentity: experienceKernelIdentity({
      kind: draft.proposedKind, scope: draft.scope, components: draft.components,
    }),
  }
  return { ...changed, ...suggestionDecisionDigests(changed) }
}

function typedGroup(
  kind: ExperienceKind,
  changedRole: ExperienceSuggestionGroupView['draft']['components'][number]['role'],
  changedContent: string,
): ExperienceSuggestionGroupView {
  const base = namedGroup(`typed-${kind}`, `typed ${kind}`)
  const roles = [
    ...TYPE_BEHAVIORS[kind].requiredRoles,
    ...(kind === 'preference_policy' ? ['positive_example', 'no_known_exception'] as const : []),
  ]
  const draft = {
    ...base.draft,
    proposedKind: kind,
    components: roles.map((role, index) => ({
      componentKey: `${kind}:${role}:${String(index + 1)}`,
      role,
      content: role === changedRole ? changedContent : `${role} stable value`,
      sourceRefs: [base.occurrences[0]!.sourceRefs[0]!.sourceRefId],
    })),
  }
  const changed: ExperienceSuggestionGroupView = {
    ...base,
    kind,
    draft,
    kernelIdentity: experienceKernelIdentity({ kind, scope: draft.scope, components: draft.components }),
  }
  return { ...changed, ...suggestionDecisionDigests(changed) }
}

function typedVersion(
  kind: ExperienceKind,
  changedRole: ExperienceVersionView['components'][number]['role'],
  changedContent: string,
): ExperienceVersionView {
  const base = version(`typed ${kind}`, `typed-${kind}`)
  const roles = [
    ...TYPE_BEHAVIORS[kind].requiredRoles,
    ...(kind === 'preference_policy' ? ['positive_example', 'no_known_exception'] as const : []),
  ]
  const components = roles.map((role, index) => ({
    componentKey: `${kind}:${role}:${String(index + 1)}`,
    role,
    content: role === changedRole ? changedContent : `${role} stable value`,
    sourceRefs: [sourceRef.sourceRefId],
    componentId: brandedId<'ExperienceComponentId'>(`component-${kind}-${String(index)}`, 'componentId'),
    componentRevisionId: brandedId<'ExperienceComponentRevisionId'>(
      `revision-${kind}-${String(index)}`, 'revisionId',
    ),
    evidenceIds: [brandedId<'ExperienceEvidenceId'>(`evidence-${kind}-${String(index)}`, 'evidenceId')],
  }))
  return {
    ...base,
    kind,
    components,
    componentRevisionIds: components.map(component => component.componentRevisionId),
    contentDigest: suggestionDigest({ kind, changedRole, changedContent }),
  }
}

function emptyRetrieval(runtime: RuntimeSettingsSnapshot) {
  const stable = manifest(runtime, projectExperienceVersion(version('unused')))
  return {
    projection: {
      projectionKey: 'experience-retrieval-v1' as const,
      schemaVersion: 2 as const,
      manifest: {
        ...stable,
        state: 'lexical_ready' as const,
        providerState: 'configured' as const,
        documentCount: 0,
        vectorCount: 0,
      },
      documents: [],
    },
    vectors: new Map<string, Float32Array>(),
  }
}

function retrieval(
  runtime: RuntimeSettingsSnapshot,
  documents: readonly ReturnType<typeof projectExperienceVersion>[],
  vectors: readonly Float32Array[],
) {
  return {
    projection: {
      projectionKey: 'experience-retrieval-v1' as const,
      schemaVersion: 2 as const,
      manifest: {
        ...manifest(runtime, documents[0]!),
        documentCount: documents.length,
        vectorCount: vectors.length,
      },
      documents,
    },
    vectors: new Map(documents.map((document, index) => [document.documentId, vectors[index]!] as const)),
  }
}

function manifest(
  runtime: RuntimeSettingsSnapshot,
  document: ReturnType<typeof projectExperienceVersion>,
) {
  return {
    schemaVersion: 'experience-retrieval-projection-manifest-v2' as const,
    projectionVersion: 'experience-retrieval-projector-v2' as const, generation: 4,
    state: 'dense_ready' as const, provider: 'transformers_js' as const, providerState: 'ready' as const,
    modelId: runtime.values.embeddingModelId, modelRevision: runtime.values.embeddingModelRevision,
    artifactSha256: runtime.values.embeddingArtifactSha256, dimension: runtime.values.embeddingDimension,
    dtype: runtime.values.embeddingDtype, pooling: runtime.values.embeddingPooling,
    queryPrefix: runtime.values.embeddingQueryPrefix, passagePrefix: runtime.values.embeddingPassagePrefix,
    tokenizerConfigBundleSha256: runtime.values.embeddingTokenizerConfigBundleSha256,
    normalization: runtime.values.embeddingNormalization,
    maxInputTokens: runtime.values.embeddingMaxInputTokens,
    truncationPolicy: runtime.values.embeddingTruncationPolicy,
    operationSettingsRevision: runtime.revision,
    operationSettingsDigest: suggestionDigest({ test: 'settings' }),
    sourceWatermarkDigest: suggestionDigest({ test: 'source' }),
    contentDigest: suggestionDigest({ test: 'retrieval', document: document.contentDigest }),
    documentCount: 1, vectorCount: 1, failureCode: null,
    builtAt: '2099-01-01T00:00:00.000Z',
  }
}

function fakeProvider(vector: Float32Array) {
  const embedBatch = vi.fn<EmbeddingProviderPort['embedBatch']>(async (requestId, texts, role, config) => ({
    vectors: texts.map(() => vector),
    receipt: {
      receiptId: 'embedding-receipt:test', requestId,
      providerSchemaVersion: 'experience-embedding-provider-v2', role,
      inputCount: texts.length, dimension: config.dimension,
      modelIdentity: {
        provider: config.provider, modelId: config.modelId, revision: config.revision,
        artifactSha256: config.artifactSha256, artifactBytes: config.artifactBytes,
        dimension: config.dimension, dtype: config.dtype, pooling: config.pooling,
        queryPrefix: config.queryPrefix, passagePrefix: config.passagePrefix,
        tokenizerConfigBundleSha256: config.tokenizerConfigBundleSha256,
        normalization: config.normalization, maxInputTokens: config.maxInputTokens,
        truncationPolicy: config.truncationPolicy,
      },
      createdAt: '2099-01-01T00:00:00.000Z',
    },
  }))
  return { embedBatch, dispose: vi.fn(async () => undefined) }
}

function scriptedProvider(groupVectors: readonly Float32Array[]) {
  let call = 0
  const embedBatch = vi.fn<EmbeddingProviderPort['embedBatch']>(async (requestId, texts, role, config) => {
    const vectors = call === 0 ? groupVectors : texts.map(() => new Float32Array([1, 0]))
    call += 1
    return {
      vectors,
      receipt: {
        receiptId: `embedding-receipt:${String(call)}`, requestId,
        providerSchemaVersion: 'experience-embedding-provider-v2', role,
        inputCount: texts.length, dimension: config.dimension,
        modelIdentity: {
          provider: config.provider, modelId: config.modelId, revision: config.revision,
          artifactSha256: config.artifactSha256, artifactBytes: config.artifactBytes,
          dimension: config.dimension, dtype: config.dtype, pooling: config.pooling,
          queryPrefix: config.queryPrefix, passagePrefix: config.passagePrefix,
          tokenizerConfigBundleSha256: config.tokenizerConfigBundleSha256,
          normalization: config.normalization, maxInputTokens: config.maxInputTokens,
          truncationPolicy: config.truncationPolicy,
        },
        createdAt: '2099-01-01T00:00:00.000Z',
      },
    }
  })
  return { embedBatch, dispose: vi.fn(async () => undefined) }
}
