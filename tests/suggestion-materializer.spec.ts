import { describe, expect, it } from 'vitest'
import { validateWorkflowDraft } from '../src/domain/candidate-workflow.js'
import {
  materializeSuggestionGroups,
  suggestionEvidenceSourceRefsForComponent,
  suggestionKernelIdentity,
} from '../src/domain/suggestion-materializer.js'
import { experienceKernelIdentity } from '../src/domain/experience-kernel.js'
import type {
  ExperienceSuggestionSeedView,
  SourceRefView,
  SuggestionEvidenceSignalView,
} from '../src/types.js'

describe('E2 suggestion materialization and conservative consolidation', () => {
  it('turns source-backed Procedure and Diagnostic seeds into complete validated drafts', () => {
    const procedureSeed = seed('session-procedure', { kinds: ['procedure'] })
    const diagnosticSeed = seed('session-diagnostic', {
      kinds: ['diagnostic'], failedTools: ['build'], failureCodes: ['ENOENT'],
    })
    const groups = materializeSuggestionGroups([procedureSeed, diagnosticSeed], 32_768)

    expect(groups).toHaveLength(2)
    expect(new Set(groups.map(group => group.occurrences[0]!.occurrenceId)).size).toBe(2)
    expect(groups.map(group => group.occurrences[0]!.seedOccurrenceId).sort())
      .toEqual(['occurrence:session-diagnostic', 'occurrence:session-procedure'])
    for (const group of groups) {
      expect(group).toMatchObject({
        saveReadiness: 'ready',
        missingFields: [],
        reviewDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        revisionDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      })
      const sourceRefs = group.occurrences.flatMap(occurrence => occurrence.sourceRefs)
      const episodeRefs = group.occurrences.map(occurrence => occurrence.episodeRef)
      expect(() => validateWorkflowDraft(group.draft, episodeRefs, sourceRefs, 32_768)).not.toThrow()
    }
  })

  it('makes only complete explicit Preference and typed authoritative Fact suggestions save-ready', () => {
    const preference = semanticSeed(
      'session-preference',
      'preference_policy',
      '以后在中文技术回答中，必须优先使用中文，除非我明确要求英文。',
    )
    const fact = semanticSeed('session-fact', 'fact', '读取当前工作区 Node 版本。', [
      signal('session-fact', 2, 'tool_observation', 'observed_fact', factEvidence('node --version', { experienceFact: {
        subject: 'workspace runtime', predicate: 'node version', value: 'v22.23.1',
        observedAt: '2099-01-01T00:00:05.000Z', validUntil: '2099-02-01T00:00:05.000Z',
        sourceAuthority: 'node --version',
      } })),
    ])
    const groups = materializeSuggestionGroups([preference, fact], 32_768)

    expect(groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'preference_policy', saveReadiness: 'ready', missingFields: [],
        reviewDigest: expect.stringMatching(/^sha256:/u) }),
      expect.objectContaining({ kind: 'fact', saveReadiness: 'ready', missingFields: [],
        reviewDigest: expect.stringMatching(/^sha256:/u) }),
    ]))
    const preferenceGroup = groups.find(group => group.kind === 'preference_policy')!
    expect(preferenceGroup.draft.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'modality', content: 'must' }),
      expect.objectContaining({ role: 'task_or_output_scope', content: '中文技术回答' }),
      expect.objectContaining({ role: 'exception', content: '我明确要求英文' }),
    ]))
    const factGroup = groups.find(group => group.kind === 'fact')!
    expect(factGroup.draft.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'subject', content: 'workspace runtime' }),
      expect.objectContaining({ role: 'object_or_value', content: 'v22.23.1' }),
    ]))
  })

  it('keeps incomplete Preference/Fact and every Strategy/Causal candidate out of one-click save', () => {
    const incompletePreference = semanticSeed(
      'session-preference-incomplete', 'preference_policy', '以后在中文技术回答中，必须优先使用中文。',
    )
    const incompleteFact = semanticSeed('session-fact-incomplete', 'fact', '读取当前版本。', [
      signal('session-fact-incomplete', 2, 'tool_observation', 'observed_fact', factEvidence('runtime --version', { experienceFact: {
        subject: 'runtime', predicate: 'version', value: 'v22', observedAt: '2099-01-01T00:00:05.000Z',
      } })),
    ])
    const completeStrategy = semanticSeed(
      'session-strategy', 'strategy',
      '比较方案 A 和方案 B；硬约束是离线可用，选择标准是准确率；权衡是速度与质量；停止条件是准确率达标；升级条件是并列时请用户决定；成功指标是 harmful match 为零。',
    )
    const completeCausal = semanticSeed(
      'session-causal', 'causal',
      '当禁用缓存时，禁用缓存导致延迟下降。机制：避免旧缓存读取；另一种解释：网络波动；证伪条件：禁用缓存后延迟不变。',
      [signal('session-causal', 2, 'tool_observation', 'observed_fact', 'latency decreased by 30%')],
    )
    const groups = materializeSuggestionGroups([
      incompletePreference, incompleteFact, completeStrategy, completeCausal,
    ], 32_768)

    expect(groups.find(group => group.kind === 'preference_policy')).toMatchObject({
      saveReadiness: 'needs_enrichment', reviewDigest: null,
      missingFields: expect.arrayContaining(['override_policy']),
    })
    expect(groups.find(group => group.kind === 'fact')).toMatchObject({
      saveReadiness: 'needs_enrichment', reviewDigest: null,
      missingFields: expect.arrayContaining(['contradiction_policy']),
    })
    expect(groups.find(group => group.kind === 'strategy')).toMatchObject({
      saveReadiness: 'needs_review', reviewDigest: null,
      readinessReasons: ['strategy_requires_human_review'],
    })
    expect(groups.find(group => group.kind === 'causal')).toMatchObject({
      saveReadiness: 'needs_review', reviewDigest: null,
      readinessReasons: ['causal_candidate_requires_promotion'],
    })
  })

  it('does not label unrelated semantic kernels as possible duplicates', () => {
    const fact = (sessionId: string, subject: string) => semanticSeed(sessionId, 'fact', `读取 ${subject}。`, [
      signal(sessionId, 2, 'tool_observation', 'observed_fact', factEvidence(`${subject} --version`, { experienceFact: {
        subject, predicate: 'version', value: 'v1',
        observedAt: '2099-01-01T00:00:05.000Z', validUntil: '2099-02-01T00:00:05.000Z',
        sourceAuthority: `${subject} --version`,
      } })),
    ])
    const groups = materializeSuggestionGroups([
      fact('session-node-fact', 'node runtime'), fact('session-pnpm-fact', 'pnpm runtime'),
    ], 32_768)

    expect(groups).toHaveLength(2)
    expect(groups.every(group => group.consolidation === 'distinct')).toBe(true)
    expect(groups.every(group => group.saveReadiness === 'ready')).toBe(true)
  })

  it('keeps failed calls out of the reusable path and exposes them as excluded evidence', () => {
    const [group] = materializeSuggestionGroups([
      seed('session-failure', {
        kinds: ['procedure'],
        tools: ['read', 'test'],
        failedTools: ['broken-build'],
        failureCodes: ['ENOENT'],
      }),
    ], 32_768)

    const stableStep = group!.draft.components.find(component => component.role === 'step')!.content
    expect(stableStep).toContain('read')
    expect(stableStep).toContain('test')
    expect(stableStep).not.toContain('broken-build')
    expect(group!.draft.excludedSteps).toEqual([
      expect.objectContaining({
        summary: expect.stringContaining('broken-build'),
        sourceRefs: ['source:session-failure:2'],
      }),
    ])
  })

  it('grounds each Procedure component and excluded failure to only its supporting Session refs', () => {
    const [group] = materializeSuggestionGroups([seed('session-grounded', {
      kinds: ['procedure'], tools: ['read', 'test'], failedTools: ['broken-build'], failureCodes: ['ENOENT'],
    })], 32_768)
    const refs = (role: string) => group!.draft.components.find(component => component.role === role)!.sourceRefs

    expect(refs('goal_signature')).toEqual(['source:session-grounded:1'])
    expect(refs('entry_condition')).toEqual(['source:session-grounded:1'])
    expect(suggestionEvidenceSourceRefsForComponent(
      group!.draft.components.find(component => component.role === 'entry_condition')!,
    )).toEqual([])
    expect(suggestionEvidenceSourceRefsForComponent(
      group!.draft.components.find(component => component.role === 'goal_signature')!,
    )).toEqual(['source:session-grounded:1'])
    expect(refs('step')).toEqual(['source:session-grounded:4', 'source:session-grounded:5'])
    expect(refs('checkpoint')).toEqual(['source:session-grounded:5'])
    expect(refs('verifier')).toEqual(['source:session-grounded:5'])
    expect(refs('failure_branch')).toEqual(['source:session-grounded:2'])
    expect(group!.draft.fieldSourceRefs['component:procedure:step:6']).toEqual(refs('step'))
    expect(group!.draft.excludedSteps).toEqual([
      expect.objectContaining({ sourceRefs: ['source:session-grounded:2'] }),
    ])
    expect(group!.draft.components.every(component => component.sourceRefs.length < 4)).toBe(true)
  })

  it('keeps a Diagnostic check, resolution, observed result, and verifier on their narrow source channels', () => {
    const base = seed('diagnostic-grounded', {
      kinds: ['diagnostic'], tools: ['inspect', 'repair'], failedTools: ['failed'], failureCodes: ['EADDRINUSE'],
    })
    const diagnostic = {
      ...base,
      evidenceSignals: [
        base.evidenceSignals[0]!,
        base.evidenceSignals[1]!,
        signal('diagnostic-grounded', 4, 'tool_observation', 'observed_fact', 'inspect\n\nowned listener'),
        signal('diagnostic-grounded', 5, 'tool_observation', 'observed_fact', 'repair\n\nrestarted'),
        signal('diagnostic-grounded', 6, 'terminal_readback', 'observed_fact', 'test\n\nsocket ready'),
      ],
      stableKernel: {
        ...base.stableKernel,
        recoveryToolSequence: ['inspect', 'repair'],
        verifierTools: ['test'],
      },
    } satisfies ExperienceSuggestionSeedView
    const [group] = materializeSuggestionGroups([diagnostic], 32_768)
    const refs = (role: string) => group!.draft.components.find(component => component.role === role)!.sourceRefs

    expect(refs('symptom_signature')).toEqual(['source:diagnostic-grounded:2'])
    expect(refs('discriminator')).toEqual(['source:diagnostic-grounded:4'])
    expect(refs('resolution_candidate')).toEqual(['source:diagnostic-grounded:5'])
    expect(refs('observed_fact')).toEqual(['source:diagnostic-grounded:4', 'source:diagnostic-grounded:5'])
    expect(refs('recovery_verifier')).toEqual(['source:diagnostic-grounded:6'])
  })

  it('keeps exact cross-Session source consolidation component-aligned', () => {
    const [group] = materializeSuggestionGroups([
      seed('ground-a', { kinds: ['procedure'], tools: ['read', 'test'] }),
      seed('ground-b', { kinds: ['procedure'], tools: ['read', 'test'] }),
    ], 32_768)
    const refs = (role: string) => group!.draft.components.find(component => component.role === role)!.sourceRefs

    expect(refs('goal_signature')).toEqual(['source:ground-a:1', 'source:ground-b:1'])
    expect(refs('step')).toEqual([
      'source:ground-a:4', 'source:ground-a:5', 'source:ground-b:4', 'source:ground-b:5',
    ])
    expect(refs('verifier')).toEqual(['source:ground-a:5', 'source:ground-b:5'])
    expect(refs('goal_signature')).not.toContain('source:ground-a:4')
  })

  it('keeps semantic-kind grounding separate between instruction and observation evidence', () => {
    const fact = semanticSeed('ground-fact', 'fact', '读取当前工作区 Node 版本。', [
      signal('ground-fact', 2, 'tool_observation', 'observed_fact', factEvidence('node --version', { experienceFact: {
        subject: 'workspace runtime', predicate: 'node version', value: 'v22.23.1',
        observedAt: '2099-01-01T00:00:05.000Z', validUntil: '2099-02-01T00:00:05.000Z',
        sourceAuthority: 'node --version',
      } })),
    ])
    const causal = semanticSeed(
      'ground-causal', 'causal',
      '当禁用缓存时，禁用缓存导致延迟下降。机制：避免旧缓存读取；另一种解释：网络波动；证伪条件：禁用缓存后延迟不变。',
      [signal('ground-causal', 2, 'tool_observation', 'observed_fact', 'latency decreased by 30%')],
    )
    const groups = materializeSuggestionGroups([fact, causal], 32_768)
    const factGroup = groups.find(group => group.kind === 'fact')!
    const causalGroup = groups.find(group => group.kind === 'causal')!

    expect(factGroup.draft.components.every(component =>
      component.sourceRefs.length === 1 && component.sourceRefs[0] === 'source:ground-fact:2')).toBe(true)
    expect(causalGroup.draft.components.find(component => component.role === 'cause_or_intervention')?.sourceRefs)
      .toEqual(['source:ground-causal:1'])
    expect(causalGroup.draft.components.find(component => component.role === 'evidence_link')?.sourceRefs)
      .toEqual(['source:ground-causal:2'])
  })

  it('separates an observed causal effect from its final evidence qualifier', () => {
    const causal = semanticSeed(
      'ground-causal-split', 'causal',
      '当启用批准上下文时，启用批准上下文导致工具调用下降。机制：减少重复探索；另一种解释：模型随机性；证伪条件：对照运行没有下降。',
      [
        signal('ground-causal-split', 2, 'tool_observation', 'observed_fact', 'tool calls decreased'),
        signal('ground-causal-split', 3, 'tool_observation', 'observed_fact', 'sample size n=1'),
      ],
    )
    const [group] = materializeSuggestionGroups([causal], 32_768)

    expect(group!.draft.components.find(component => component.role === 'effect_or_metric')?.sourceRefs)
      .toEqual(['source:ground-causal-split:2'])
    expect(group!.draft.components.find(component => component.role === 'evidence_link')?.sourceRefs)
      .toEqual(['source:ground-causal-split:3'])
  })

  it('keeps a changed non-Series Fact value review-only instead of merging its evidence', () => {
    const fact = (sessionId: string, value: string) => semanticSeed(sessionId, 'fact', '读取当前工作区 Node 版本。', [
      signal(sessionId, 2, 'tool_observation', 'observed_fact', factEvidence('node --version', { experienceFact: {
        subject: 'workspace runtime', predicate: 'node version', value,
        observedAt: '2099-01-01T00:00:05.000Z', validUntil: '2099-02-01T00:00:05.000Z',
        sourceAuthority: 'node --version',
      } })),
    ])
    const [group] = materializeSuggestionGroups([
      fact('fact-value-a', 'v22.23.1'), fact('fact-value-b', 'v24.1.0'),
    ], 32_768)

    expect(group).toMatchObject({
      consolidation: 'possible_duplicate', saveReadiness: 'needs_review', reviewDigest: null,
      readinessReasons: expect.arrayContaining(['exact_identity_component_conflict']),
      occurrenceCount: 2,
    })
    const value = group!.draft.components.find(component => component.role === 'object_or_value')!
    expect(value.sourceRefs).toHaveLength(1)
  })

  it('does not call tool names or transient command arguments save-ready experience', () => {
    const incomplete = seed('session-incomplete', { kinds: ['procedure'] })
    const incompleteGroup = materializeSuggestionGroups([{
      ...incomplete,
      evidenceSignals: incomplete.evidenceSignals.filter(signal => signal.role === 'user_goal'),
    }], 32_768)[0]!
    expect(incompleteGroup).toMatchObject({
      saveReadiness: 'needs_enrichment',
      reviewDigest: null,
      readinessReasons: ['verifier_evidence_missing'],
    })

    const transient = seed('session-transient', { kinds: ['procedure'], tools: ['bash'] })
    const transientGroup = materializeSuggestionGroups([{
      ...transient,
      evidenceSignals: transient.evidenceSignals.map(signal => signal.role !== 'terminal_readback'
        ? signal : { ...signal, content: 'bash\n{"command":"node /tmp/session-123/run.js"}\n\nsuccess' }),
    }], 32_768)[0]!
    expect(transientGroup).toMatchObject({
      saveReadiness: 'needs_review',
      reviewDigest: null,
      readinessReasons: ['transient_action_parameter'],
    })

    const genericFailure = seed('session-generic-failure', {
      kinds: ['diagnostic'], failedTools: ['build'], failureCodes: ['tool_error'],
    })
    expect(materializeSuggestionGroups([genericFailure], 32_768)[0]).toMatchObject({
      saveReadiness: 'needs_enrichment',
      reviewDigest: null,
      readinessReasons: ['diagnostic_signature_missing'],
      missingFields: expect.arrayContaining(['symptom_signature']),
    })
  })

  it('collapses three exact cross-Session occurrences into one save surface', () => {
    const seeds = ['session-a', 'session-b', 'session-c'].map(sessionId => seed(sessionId, {
      kinds: ['procedure'],
      workspace: '/workspace/shared',
    }))
    const groups = materializeSuggestionGroups(seeds, 32_768)

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      consolidation: 'exact',
      occurrenceCount: 3,
      crossSession: true,
      sessionIds: ['session-a', 'session-b', 'session-c'],
      saveReadiness: 'ready',
    })
    expect(new Set(groups[0]!.occurrences.map(item => item.occurrenceId)).size).toBe(3)
  })

  it('uses one cross-Session group for repeated exact semantic experiences of every remaining kind', () => {
    const preferenceGoal = '以后在中文技术回答中，必须优先使用中文，除非我明确要求英文。'
    const strategyGoal = '比较方案 A 和方案 B；硬约束是离线可用，选择标准是准确率；权衡是速度与质量；停止条件是准确率达标；升级条件是并列时请用户决定；成功指标是 harmful match 为零。'
    const causalGoal = '当禁用缓存时，禁用缓存导致延迟下降。机制：避免旧缓存读取；另一种解释：网络波动；证伪条件：禁用缓存后延迟不变。'
    const fact = (sessionId: string) => semanticSeed(sessionId, 'fact', '读取当前工作区 Node 版本。', [
      signal(sessionId, 2, 'tool_observation', 'observed_fact', factEvidence('node --version', { experienceFact: {
        subject: 'workspace runtime', predicate: 'node version', value: 'v22.23.1',
        observedAt: '2099-01-01T00:00:05.000Z', validUntil: '2099-02-01T00:00:05.000Z',
        sourceAuthority: 'node --version',
      } })),
    ])
    const causal = (sessionId: string) => semanticSeed(sessionId, 'causal', causalGoal, [
      signal(sessionId, 2, 'tool_observation', 'observed_fact', 'latency decreased by 30%'),
    ])
    const cases: readonly [string, ExperienceSuggestionSeedView, ExperienceSuggestionSeedView][] = [
      ['preference_policy', semanticSeed('preference-a', 'preference_policy', preferenceGoal),
        semanticSeed('preference-b', 'preference_policy', preferenceGoal)],
      ['fact', fact('fact-a'), fact('fact-b')],
      ['strategy', semanticSeed('strategy-a', 'strategy', strategyGoal),
        semanticSeed('strategy-b', 'strategy', strategyGoal)],
      ['causal', causal('causal-a'), causal('causal-b')],
    ]

    for (const [kind, first, second] of cases) {
      const groups = materializeSuggestionGroups([first, second], 32_768)
      expect(groups, kind).toHaveLength(1)
      expect(groups[0], kind).toMatchObject({
        kind, consolidation: 'exact', occurrenceCount: 2, crossSession: true,
      })
    }
  })

  it('never auto-merges same-scope path variants or different-scope specializations', () => {
    const possible = materializeSuggestionGroups([
      seed('session-a', { kinds: ['procedure'], tools: ['read', 'test'] }),
      seed('session-b', { kinds: ['procedure'], tools: ['install', 'test'] }),
    ], 32_768)
    expect(possible).toHaveLength(2)
    expect(possible).toEqual(expect.arrayContaining([
      expect.objectContaining({ consolidation: 'possible_duplicate', saveReadiness: 'needs_review', reviewDigest: null }),
    ]))

    const specializations = materializeSuggestionGroups([
      seed('session-c', { kinds: ['procedure'], workspace: '/workspace/a' }),
      seed('session-d', { kinds: ['procedure'], workspace: '/workspace/b' }),
    ], 32_768)
    expect(specializations).toHaveLength(2)
    expect(specializations.every(group => group.consolidation === 'specialization')).toBe(true)
    expect(specializations.every(group => group.saveReadiness === 'needs_review')).toBe(true)
  })

  it('excludes terminal groups before deriving live suggestion relationships', () => {
    const first = seed('session-terminal', { kinds: ['procedure'], tools: ['read', 'test'] })
    const second = seed('session-live', { kinds: ['procedure'], tools: ['install', 'test'] })
    const terminalId = materializeSuggestionGroups([first], 32_768)[0]!.suggestionGroupId

    const groups = materializeSuggestionGroups([first, second], 32_768, new Set([terminalId]))

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      consolidation: 'distinct', saveReadiness: 'ready', relatedGroupIds: [], readinessReasons: [],
    })
    expect(groups[0]!.sessionIds).toEqual(['session-live'])
  })

  it('keeps the stable group identity independent of observation time and projection generation', () => {
    const first = seed('session-a', { kinds: ['procedure'], observedAt: '2099-01-01T00:00:10.000Z' })
    const reread = {
      ...first,
      detectorVersion: 'procedure-diagnostic-detector-v2',
      evidenceSignals: first.evidenceSignals.map(signal => ({
        ...signal,
        sourceRef: { ...signal.sourceRef, observedAt: '2099-01-01T01:00:00.000Z' },
      })),
    }

    expect(suggestionKernelIdentity(first, 'procedure')).toBe(suggestionKernelIdentity(reread, 'procedure'))
    expect(materializeSuggestionGroups([first], 32_768)[0]!.suggestionGroupId)
      .toBe(materializeSuggestionGroups([reread], 32_768)[0]!.suggestionGroupId)
  })

  it('keeps exact identity conservative across full scope and code-sensitive symbols', () => {
    const group = materializeSuggestionGroups([seed('session-exact', { kinds: ['procedure'] })], 32_768)[0]!
    const base = { kind: group.kind, scope: group.draft.scope, components: group.draft.components }
    const otherScope = { ...base, scope: { ...base.scope, product: 'another-product' } }
    const otherCommand = {
      ...base,
      components: base.components.map(component => component.role !== 'step' ? component : {
        ...component,
        content: component.content.replace('--verified', '--Verified'),
      }),
    }

    expect(experienceKernelIdentity(otherScope)).not.toBe(experienceKernelIdentity(base))
    expect(experienceKernelIdentity(otherCommand)).not.toBe(experienceKernelIdentity(base))
  })
})

function seed(sessionId: string, options: {
  readonly kinds?: ExperienceSuggestionSeedView['suggestedKinds']
  readonly workspace?: string
  readonly tools?: readonly string[]
  readonly failedTools?: readonly string[]
  readonly failureCodes?: readonly string[]
  readonly observedAt?: string
} = {}): ExperienceSuggestionSeedView {
  const detectedAt = '2099-01-01T00:00:10.000Z'
  const kinds = options.kinds ?? ['procedure']
  const tools = options.tools ?? ['read', 'test']
  const failedTools = options.failedTools ?? []
  const failureCodes = options.failureCodes ?? []
  const signals = [
    signal(sessionId, 1, 'user_goal', 'user_instruction', '构建并验证本地 Web 项目。', options.observedAt),
    ...failureCodes.map((code, index) => signal(
      sessionId, 2 + index, 'symptom', 'observed_fact',
      `${failedTools[index] ?? failedTools[0] ?? 'failed-tool'}\n{"command":"failed"}\n\n${code}`,
      options.observedAt,
    )),
    ...tools.map((tool, index) => signal(
      sessionId,
      4 + index,
      index === tools.length - 1 ? 'terminal_readback' : 'tool_observation',
      'observed_fact',
      `${tool}\n{"command":"${tool} --verified"}\n\nsuccess`,
      options.observedAt,
    )),
  ]
  return {
    occurrenceId: `occurrence:${sessionId}`,
    sessionId,
    workspaceRoot: options.workspace ?? '/workspace/shared',
    episodeRef: {
      episodeRefId: `episode:${sessionId}` as never,
      sourceSystem: 'dsh-session',
      sessionOrRunId: sessionId,
      eventStart: 0,
      eventEnd: 9,
      occurredAt: { start: '2099-01-01T00:00:00.000Z', end: detectedAt },
      contentDigest: digestFor(`${sessionId}:episode`),
      redactionState: 'bounded_excerpt',
    },
    suggestedKinds: kinds,
    triggerKind: failureCodes.length === 0 ? 'terminal_success' : 'high_cost_resolution',
    stableKernel: {
      taskGoal: '构建并验证本地 Web 项目。',
      toolSequence: [...tools],
      failedToolSequence: [...failedTools],
      recoveryToolSequence: [...tools],
      failureCodes: [...failureCodes],
      verifierTools: ['test'],
    },
    evidenceSignals: signals,
    detectorVersion: 'procedure-diagnostic-detector-v1',
    segmenterVersion: 'session-turn-segmenter-v1',
    detectedAt,
    expiresAt: '2099-01-15T00:00:10.000Z',
  }
}

function semanticSeed(
  sessionId: string,
  kind: ExperienceSuggestionSeedView['suggestedKinds'][number],
  goal: string,
  extraSignals: readonly SuggestionEvidenceSignalView[] = [],
): ExperienceSuggestionSeedView {
  const base = seed(sessionId, { kinds: [kind], tools: [] })
  return {
    ...base,
    suggestedKinds: [kind],
    triggerKind: kind === 'preference_policy' ? 'explicit_user_directive'
      : kind === 'fact' ? 'authoritative_fact'
        : kind === 'strategy' ? 'strategy_candidate' : 'causal_candidate',
    stableKernel: {
      ...base.stableKernel,
      taskGoal: goal,
      toolSequence: [],
      recoveryToolSequence: [],
      verifierTools: [],
    },
    evidenceSignals: [
      signal(sessionId, 1, 'user_goal', 'user_instruction', goal),
      ...extraSignals,
    ],
  }
}

function factEvidence(command: string, envelope: unknown): string {
  return `bash\n${JSON.stringify({ command })}\n\n${JSON.stringify(envelope)}`
}

function signal(
  sessionId: string,
  seq: number,
  role: SuggestionEvidenceSignalView['role'],
  evidenceClass: SuggestionEvidenceSignalView['evidenceClass'],
  content: string,
  observedAt = '2099-01-01T00:00:10.000Z',
): SuggestionEvidenceSignalView {
  const sourceRef: SourceRefView = {
    sourceRefId: `source:${sessionId}:${String(seq)}` as never,
    sourceSystem: 'dsh-session',
    sourceKind: role === 'user_goal' ? 'user_instruction' : 'tool_result',
    locator: `dsh-session:${sessionId}#${String(seq)}`,
    ownerScope: `session:${sessionId}`,
    accessScope: 'local_owner',
    occurredAt: new Date(Date.UTC(2099, 0, 1, 0, 0, seq)).toISOString(),
    observedAt,
    contentDigest: digestFor(`${sessionId}:${String(seq)}:${content}`),
    redactionState: 'bounded_excerpt',
  }
  return {
    itemId: `item:${sessionId}:${String(seq)}`,
    sourceRef,
    eventType: role === 'user_goal' ? 'user/message' : 'tool/result',
    role,
    evidenceClass,
    content,
    projectionDigest: digestFor(`projection:${sessionId}:${String(seq)}:${content}`),
    projectionTruncated: false,
  }
}

function digestFor(value: string): string {
  const bytes = [...new TextEncoder().encode(value)]
  const hex = bytes.map(value => value.toString(16).padStart(2, '0')).join('')
  return `sha256:${(hex + '0'.repeat(64)).slice(0, 64)}`
}
