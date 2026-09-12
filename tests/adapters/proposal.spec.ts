import { ToolCallId, type GenerateOptions, type LlmCallConfig, type LlmRuntime, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, type SessionId, type SessionStore } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { DiagnosticProposalLlm } from '../../src/adapters/proposal-llm.js'
import { parseProposeCandidateInput } from '../../src/application/input.js'
import type { DiagnosticCandidateDraft } from '../../src/types.js'
import { evidencePacket, proposeInput, workflowDraft } from '../fixtures/workflow.js'
import { RuntimeSettingsSchema, type RuntimeSettings } from '../../src/runtime-settings-schema.js'

const configuredDefault = { mode: 'configured_default' } as const

describe('M2 proposal disclosure and schema gate', () => {
  it('requires confirmation of the exact framed source digest before resolving an LLM service', async () => {
    let llmReads = 0
    const disclosureSource = new DiagnosticProposalLlm(
      () => runtimeOf(async function* () { throw new Error('stream must not run') }),
      () => undefined,
      {
        provider: 'test-provider', model: 'test-model', reasoningEffort: 'off', maxTokens: 8_192,
        maxModelInputBytes: 98_304,
      },
    )
    const disclosure = await disclosureSource.disclosure(evidencePacket, configuredDefault)
    const proposer = new DiagnosticProposalLlm(() => {
      llmReads++
      return undefined
    }, () => undefined, {
      provider: 'test-provider', model: 'test-model', reasoningEffort: 'off', maxTokens: 8_192,
      maxModelInputBytes: 98_304,
    })
    expect(disclosure).toMatchObject({
      provider: 'test-provider', model: 'test-model', evidenceItemCount: 1,
      reasoningEffort: 'off', maxOutputTokens: 8_192,
      promptVersion: 'diagnostic-candidate-v9', policyVersion: 'source-secret-evidence-class-v3',
      resultToolName: 'submit_diagnostic_candidate',
    })
    await expect(proposer.propose(evidencePacket, configuredDefault, 'sha256:wrong', 8_192))
      .rejects.toMatchObject({ code: 'source_unresolvable' })
    expect(llmReads).toBe(0)
    await expect(proposer.propose(
      evidencePacket,
      configuredDefault,
      disclosure.disclosureDigest,
      disclosure.maxOutputTokens,
    ))
      .rejects.toThrow(/requires an LLM service/i)
    expect(llmReads).toBe(1)
  })

  it('binds configured, provider-default, and custom output-token settings to distinct confirmations', async () => {
    const llm = runtimeOf(async function* () { throw new Error('stream must not run') })
    const proposer = new DiagnosticProposalLlm(
      () => llm,
      () => undefined,
      { provider: 'test-provider', model: 'model-a', reasoningEffort: 'low', maxTokens: 8_192, maxModelInputBytes: 98_304 },
    )
    const configured = await proposer.disclosure(evidencePacket, configuredDefault)
    const provider = await proposer.disclosure(evidencePacket, { mode: 'provider_default' })
    const custom = await proposer.disclosure(evidencePacket, { mode: 'custom', maxTokens: 16_384 })

    expect(configured).toMatchObject({
      outputTokenLimitMode: 'configured_default', configuredMaxOutputTokens: 8_192,
      requestedMaxOutputTokens: 8_192, maxOutputTokens: 8_192, maxOutputTokensSource: 'experience_default',
    })
    expect(provider).toMatchObject({
      outputTokenLimitMode: 'provider_default', requestedMaxOutputTokens: null,
      maxOutputTokens: 32_768, maxOutputTokensSource: 'provider_default',
    })
    expect(custom).toMatchObject({
      outputTokenLimitMode: 'custom', requestedMaxOutputTokens: 16_384,
      maxOutputTokens: 16_384, maxOutputTokensSource: 'user_override',
    })
    expect(new Set([configured.disclosureDigest, provider.disclosureDigest, custom.disclosureDigest]).size).toBe(3)
  })

  it('binds consent to the provider, model, policy versions, and bounded source digest', async () => {
    const llm = runtimeOf(async function* () { throw new Error('stream must not run') })
    const first = new DiagnosticProposalLlm(
      () => llm,
      () => undefined,
      { provider: 'test-provider', model: 'model-a', reasoningEffort: 'off', maxTokens: 8_192, maxModelInputBytes: 98_304 },
    )
    const changedRoute = new DiagnosticProposalLlm(
      () => llm,
      () => undefined,
      { provider: 'test-provider', model: 'model-b', reasoningEffort: 'off', maxTokens: 8_192, maxModelInputBytes: 98_304 },
    )
    const firstDisclosure = await first.disclosure(evidencePacket, configuredDefault)
    const changedDisclosure = await changedRoute.disclosure(evidencePacket, configuredDefault)
    expect(changedDisclosure.sourceInputDigest).toBe(firstDisclosure.sourceInputDigest)
    expect(changedDisclosure.disclosureDigest).not.toBe(firstDisclosure.disclosureDigest)
    await expect(first.propose(evidencePacket, configuredDefault, firstDisclosure.sourceInputDigest, 8_192))
      .rejects.toMatchObject({ code: 'source_unresolvable' })
  })

  it('binds consent to one immutable live-settings revision and digest', async () => {
    const llm = runtimeOf(async function* () { throw new Error('stream must not run') })
    const defaults = RuntimeSettingsSchema({} as RuntimeSettings)
    const proposer = new DiagnosticProposalLlm(
      () => llm,
      () => undefined,
      defaults,
    )
    const firstRuntime = { revision: 4, digest: 'sha256:settings-four', values: defaults } as const
    const secondRuntime = {
      revision: 5,
      digest: 'sha256:settings-five',
      values: { ...defaults, model: 'model-after-save' },
    } as const
    const first = await proposer.disclosure(evidencePacket, configuredDefault, undefined, 'diagnostic', firstRuntime)
    const second = await proposer.disclosure(evidencePacket, configuredDefault, undefined, 'diagnostic', secondRuntime)
    expect(first).toMatchObject({ settingsRevision: 4, settingsDigest: 'sha256:settings-four' })
    expect(second).toMatchObject({ settingsRevision: 5, settingsDigest: 'sha256:settings-five' })
    expect(second.disclosureDigest).not.toBe(first.disclosureDigest)
    await expect(proposer.propose(
      evidencePacket,
      configuredDefault,
      first.disclosureDigest,
      first.maxOutputTokens,
      undefined,
      'diagnostic',
      secondRuntime,
    )).rejects.toMatchObject({ code: 'source_unresolvable' })
  })

  it('records the exact model request and response in a durable proposal Session', async () => {
    const logged: Session[] = []
    const sessions = sessionStore(logged)
    const requests: GenerateOptions[] = []
    const generated = modelValue()
    const llm = runtimeOf(async function* (request) {
      requests.push(request)
      yield* structuredResponse(generated)
    })
    const proposer = new DiagnosticProposalLlm(
      () => llm,
      () => sessions,
      { provider: 'test-provider', model: 'test-model', reasoningEffort: 'off', maxTokens: 8_192, maxModelInputBytes: 98_304 },
    )
    const disclosure = await proposer.disclosure(evidencePacket, configuredDefault)
    const result = await proposer.propose(
      evidencePacket,
      configuredDefault,
      disclosure.disclosureDigest,
      disclosure.maxOutputTokens,
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]?.sessionId).toBe(result.metadata.proposalSessionId)
    expect(requests[0]?.system).toContain('Abstract the reusable stable kernel')
    expect(requests[0]?.system).toContain('Do not infer verified causation from chronology')
    expect(requests[0]?.system).toContain('A model_claim alone never proves an observation')
    expect(requests[0]?.system).toContain('passing criterion with an evidence locator and digest supports the delegated result')
    expect(requests[0]?.system).toContain('proposedKind is Host-immutable and must cite at least one source')
    expect(requests[0]?.system).toContain('allowedUseModes may contain only: ["reference","suggest","guided"]')
    expect(requests[0]?.system).not.toContain('guarded_execute')
    expect(requests[0]?.system).toContain('Use "workspace" only as privacyClass')
    expect(requests[0]?.tools).toHaveLength(1)
    expect(requests[0]?.tools?.[0]).toMatchObject({ name: 'submit_diagnostic_candidate' })
    const requestText = requests[0]?.messages[0]?.content[0]
    expect(requestText?.type === 'text' ? requestText.text : '').toContain('"sourceAlias":"s1"')
    expect(requestText?.type === 'text' ? requestText.text : '').not.toContain(evidencePacket.items[0]!.sourceRef.sourceRefId)
    expect(result.draft.components[0]?.sourceRefs).toEqual([evidencePacket.items[0]!.sourceRef.sourceRefId])
    expect(result.draft.fieldSourceRefs[`component:${result.draft.components[0]!.componentKey}`])
      .toEqual([evidencePacket.items[0]!.sourceRef.sourceRefId])
    expect(result.draft.unresolvedFields).toEqual([])
    expect(logged).toHaveLength(1)
    expect(logged[0]?.snapshotEvents().map(event => event.type)).toMatchInlineSnapshot(`
      [
        "turn/start",
        "step/start",
        "system/message",
        "user/message",
        "request/header",
        "request/context",
        "assistant/message",
        "tool/call",
        "tool/result",
        "step/end",
        "turn/end",
      ]
    `)
    const header = logged[0]?.snapshotEvents().find(event => event.type === 'request/header')
    expect(header?.data).toMatchObject({
      header: {
        config: {
          provider: 'test-provider',
          model: 'test-model',
          reasoningEffort: 'off',
          maxTokens: 8_192,
          temperature: 0,
        },
      },
    })
    expect(logged[0]?.deriveMessages()).toEqual([
      expect.objectContaining({
        role: 'system',
        content: [{ type: 'text', text: requests[0]?.system }],
      }),
      requests[0]?.messages[0],
      expect.objectContaining({
        role: 'assistant',
        content: [expect.objectContaining({
          type: 'tool-call', name: 'submit_diagnostic_candidate', arguments: JSON.stringify(generated),
        })],
      }),
      expect.objectContaining({ role: 'user', content: [expect.objectContaining({ type: 'tool-result', isError: false })] }),
    ])
    expect(result.metadata.proposalSessionId).toMatch(/^experience-proposal-/u)
  })

  it('logs reasoning but accepts the Candidate only from the schema tool', async () => {
    const logged: Session[] = []
    const generated = modelValue()
    const llm = runtimeOf(async function* () {
      yield { type: 'reasoning-delta', index: 0, text: 'brief private reasoning' }
      yield* structuredResponse(generated, 1, { inputTokens: 100, outputTokens: 80, reasoningTokens: 5 })
    })
    const proposer = new DiagnosticProposalLlm(
      () => llm,
      () => sessionStore(logged),
      { provider: 'test-provider', model: 'test-model', reasoningEffort: 'low', maxTokens: 8_192, maxModelInputBytes: 98_304 },
    )
    const disclosure = await proposer.disclosure(evidencePacket, configuredDefault)

    const result = await proposer.propose(
      evidencePacket,
      configuredDefault,
      disclosure.disclosureDigest,
      disclosure.maxOutputTokens,
    )

    expect(result.draft.components).toHaveLength(10)
    expect(logged[0]?.deriveMessages().at(-2)).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'brief private reasoning' },
        expect.objectContaining({ type: 'tool-call', arguments: JSON.stringify(generated) }),
      ],
    })
  })

  it('preserves every value when a structured record repeats one semantic key', async () => {
    const generated = modelValue()
    generated.validity = [
      { key: 'observation_supported', value: 'The dist directory is ignored by Git.' },
      { key: 'observation_supported', value: 'The current dist index exists.' },
      { key: 'deferred_to_verifier', value: 'Live authentication remains external.' },
    ]
    const proposer = new DiagnosticProposalLlm(
      () => runtimeOf(async function* () { yield* structuredResponse(generated) }),
      () => sessionStore([]),
      { provider: 'test-provider', model: 'model-a', reasoningEffort: 'low', maxTokens: 8_192, maxModelInputBytes: 98_304 },
    )
    const disclosure = await proposer.disclosure(evidencePacket, configuredDefault)

    const result = await proposer.propose(
      evidencePacket,
      configuredDefault,
      disclosure.disclosureDigest,
      disclosure.maxOutputTokens,
    )

    expect(result.draft.validity).toEqual({
      observation_supported: 'The dist directory is ignored by Git.\nThe current dist index exists.',
      deferred_to_verifier: 'Live authentication remains external.',
    })
  })

  it('fails closed after generation when no Session persistence listener participates', async () => {
    const logged: Session[] = []
    const llm = runtimeOf(async function* () {
      yield* structuredResponse(modelValue())
    })
    const proposer = new DiagnosticProposalLlm(
      () => llm,
      () => sessionStore(logged, false),
      { provider: 'test-provider', model: 'test-model', reasoningEffort: 'off', maxTokens: 8_192, maxModelInputBytes: 98_304 },
    )
    const disclosure = await proposer.disclosure(evidencePacket, configuredDefault)
    await expect(proposer.propose(
      evidencePacket,
      configuredDefault,
      disclosure.disclosureDigest,
      disclosure.maxOutputTokens,
    ))
      .rejects.toThrow(/durable Session persistence listener/u)
    expect(logged[0]?.snapshotEvents().at(-1)).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'completed' } },
    })
  })

  it('rejects wire proposals without explicit processing consent and schema-tool values with extra fields', async () => {
    expect(() => parseProposeCandidateInput({
      ...proposeInput(), confirmExternalModelProcessing: false,
    })).toThrow(/must be true/i)
    expect(() => parseProposeCandidateInput({
      ...proposeInput(), actorId: 'self-reported',
    })).toThrow(/unrecognized fields/i)
    const llm = runtimeOf(async function* () {
      yield* structuredResponse({ ...modelValue(), extra: true })
    })
    const proposer = new DiagnosticProposalLlm(
      () => llm,
      () => sessionStore([]),
      { provider: 'test-provider', model: 'model-a', reasoningEffort: 'low', maxTokens: 8_192, maxModelInputBytes: 98_304 },
    )
    const disclosure = await proposer.disclosure(evidencePacket, configuredDefault)
    await expect(proposer.propose(
      evidencePacket,
      configuredDefault,
      disclosure.disclosureDigest,
      disclosure.maxOutputTokens,
    )).rejects.toThrow(/do not match the Candidate schema/u)
  })

  it('rejects model-selected role multiplicity and arbitrary review field names at the schema boundary', async () => {
    const generated = modelValue()
    const componentEntries = Object.entries(generated.components as Record<string, Record<string, unknown>>)
    const components: Array<Record<string, unknown>> = componentEntries
      .map(([role, component]) => ({ ...component, role }))
    components.push({
      ...components.find(component => component.role === 'observed_fact')!,
      componentKey: 'duplicate-observed-fact',
    })
    generated.components = components
    generated.fieldSourceRefs = [
      ...Object.entries(generated.fieldSourceRefs as Record<string, string[]>)
        .map(([field, sourceRefs]) => ({ field, sourceRefs })),
      { field: 'components', sourceRefs: ['s1'] },
      { field: 'excludedSteps', sourceRefs: ['s1'] },
    ]
    generated.unresolvedFields = ['validaity']
    const proposer = new DiagnosticProposalLlm(
      () => runtimeOf(async function* () { yield* structuredResponse(generated) }),
      () => sessionStore([]),
      { provider: 'test-provider', model: 'model-a', reasoningEffort: 'low', maxTokens: 8_192, maxModelInputBytes: 98_304 },
    )
    const disclosure = await proposer.disclosure(evidencePacket, configuredDefault)

    await expect(proposer.propose(
      evidencePacket,
      configuredDefault,
      disclosure.disclosureDigest,
      disclosure.maxOutputTokens,
    )).rejects.toThrow(/do not match the Candidate schema/u)
  })

  it('rejects an impossible Candidate whose Host-immutable kind has no source', async () => {
    const generated = modelValue()
    generated.fieldSourceRefs = {
      ...(generated.fieldSourceRefs as Record<string, string[]>),
      proposedKind: [],
    }
    const proposer = new DiagnosticProposalLlm(
      () => runtimeOf(async function* () { yield* structuredResponse(generated) }),
      () => sessionStore([]),
      { provider: 'test-provider', model: 'model-a', reasoningEffort: 'low', maxTokens: 8_192, maxModelInputBytes: 98_304 },
    )
    const disclosure = await proposer.disclosure(evidencePacket, configuredDefault)

    await expect(proposer.propose(
      evidencePacket,
      configuredDefault,
      disclosure.disclosureDigest,
      disclosure.maxOutputTokens,
    )).rejects.toThrow(/Host-immutable proposedKind requires at least one disclosed source reference/u)
  })

  it('binds consent to reasoning and output settings and rejects oversized model input before dispatch', async () => {
    let prepareCalls = 0
    const llm = runtimeOf(async function* () { throw new Error('stream must not run') }, () => { prepareCalls++ })
    const low = new DiagnosticProposalLlm(
      () => llm,
      () => undefined,
      { provider: 'test-provider', model: 'model-a', reasoningEffort: 'low', maxTokens: 8_192, maxModelInputBytes: 98_304 },
    )
    const high = new DiagnosticProposalLlm(
      () => llm,
      () => undefined,
      { provider: 'test-provider', model: 'model-a', reasoningEffort: 'high', maxTokens: 16_384, maxModelInputBytes: 98_304 },
    )
    const lowDisclosure = await low.disclosure(evidencePacket, configuredDefault)
    const highDisclosure = await high.disclosure(evidencePacket, configuredDefault)
    expect(lowDisclosure.disclosureDigest).not.toBe(highDisclosure.disclosureDigest)
    const bounded = new DiagnosticProposalLlm(
      () => llm,
      () => undefined,
      { provider: 'test-provider', model: 'model-a', reasoningEffort: 'low', maxTokens: 8_192, maxModelInputBytes: 8_192 },
    )
    await expect(bounded.disclosure({
      ...evidencePacket,
      items: [{ ...evidencePacket.items[0]!, content: 'x'.repeat(16_384) }],
    }, configuredDefault)).rejects.toThrow(/model-input limit/u)
    expect(prepareCalls).toBe(0)
  })

  it('reports exact usage and no automatic retry when reasoning consumes the output limit', async () => {
    const logged: Session[] = []
    let prepareCalls = 0
    const llm = runtimeOf(async function* () {
      yield { type: 'reasoning-delta', index: 0, text: 'reasoning only' }
      yield { type: 'usage', usage: { inputTokens: 20_712, outputTokens: 8_192, reasoningTokens: 8_192 } }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    }, () => { prepareCalls++ })
    const proposer = new DiagnosticProposalLlm(
      () => llm,
      () => sessionStore(logged),
      { provider: 'test-provider', model: 'model-a', reasoningEffort: 'low', maxTokens: 8_192, maxModelInputBytes: 98_304 },
    )
    const disclosure = await proposer.disclosure(evidencePacket, configuredDefault)
    await expect(proposer.propose(
      evidencePacket,
      configuredDefault,
      disclosure.disclosureDigest,
      disclosure.maxOutputTokens,
    )).rejects.toMatchObject({
      code: 'proposal_output_limit',
      details: {
        maxOutputTokens: 8_192,
        inputTokens: 20_712,
        outputTokens: 8_192,
        reasoningTokens: 8_192,
        automaticRetry: false,
      },
    })
    expect(prepareCalls).toBe(1)
    expect(logged).toHaveLength(1)
  })

  it('derives the evidence grade and rejects observed facts sourced only from model claims', async () => {
    const generated: unknown[] = []
    const llm = runtimeOf(async function* () {
      yield* structuredResponse(generated.shift()!)
    })
    const proposer = new DiagnosticProposalLlm(
      () => llm,
      () => sessionStore([], true),
      { provider: 'test-provider', model: 'model-a', reasoningEffort: 'low', maxTokens: 8_192, maxModelInputBytes: 98_304 },
    )
    generated.push(modelValue())
    const disclosure = await proposer.disclosure(evidencePacket, configuredDefault)
    await expect(proposer.propose(
      evidencePacket,
      configuredDefault,
      disclosure.disclosureDigest,
      disclosure.maxOutputTokens,
    ))
      .resolves.toMatchObject({ draft: { evidenceGrade: 'observation_supported' } })

    const claimPacket = {
      ...evidencePacket,
      items: evidencePacket.items.map(item => ({
        ...item, evidenceRole: 'model_claim' as const, evidenceClass: 'model_claim' as const,
      })),
      packetDigest: 'sha256:model-claim-only',
    }
    generated.push(modelValue())
    const claimDisclosure = await proposer.disclosure(claimPacket, configuredDefault)
    await expect(proposer.propose(
      claimPacket,
      configuredDefault,
      claimDisclosure.disclosureDigest,
      claimDisclosure.maxOutputTokens,
    ))
      .rejects.toThrow(/observed_fact evidence item/u)
  })
})

function runtimeOf(
  stream: (request: GenerateOptions) => AsyncGenerator<StreamChunk>,
  onPrepare?: () => void,
): LlmRuntime {
  const resolve = (config: LlmCallConfig): LlmCallConfig => config.maxTokens === undefined
    ? { ...config, maxTokens: 32_768 }
    : config
  return {
    resolveCallConfig: async (config: LlmCallConfig) => resolve(config),
    prepareCall: async (config: LlmCallConfig) => {
      onPrepare?.()
      const resolved = resolve(config)
      return {
        config: resolved,
        adapterDefaults: config.maxTokens === undefined ? { maxTokens: true } : {},
        context: { contextWindow: 65_536 },
        retryPolicy: { maxAttempts: 1 },
        stream,
      }
    },
  } as unknown as LlmRuntime
}

function modelValue(overrides: Partial<DiagnosticCandidateDraft> = {}): Record<string, unknown> {
  const draft = workflowDraft(overrides)
  const { evidenceGrade: _evidenceGrade, unresolvedFields: _unresolvedFields, ...structured } = draft
  return {
    ...structured,
    scope: Object.entries(draft.scope).map(([key, value]) => ({ key, value })),
    validity: Object.entries(draft.validity).map(([key, value]) => ({ key, value })),
    authoritySpec: Object.entries(draft.authoritySpec).map(([key, value]) => ({ key, value })),
    riskAndEffectSpec: Object.entries(draft.riskAndEffectSpec).map(([key, value]) => ({ key, value })),
    components: Object.fromEntries(draft.components.map(({ role, ...component }) => [
      role,
      { ...component, sourceRefs: ['s1'] },
    ])),
    fieldSourceRefs: Object.fromEntries(Object.keys(draft.fieldSourceRefs)
      .filter(field => !field.startsWith('component:'))
      .map(field => [field, ['s1']])),
    excludedSteps: draft.excludedSteps.map(step => ({ ...step, sourceRefs: ['s1'] })),
  }
}

async function* structuredResponse(
  value: unknown,
  index = 0,
  usage?: { readonly inputTokens: number; readonly outputTokens: number; readonly reasoningTokens?: number },
): AsyncGenerator<StreamChunk> {
  const id = ToolCallId(`candidate-${String(index)}`)
  const argumentsJson = JSON.stringify(value)
  yield { type: 'block-start', index, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index, id, name: 'submit_diagnostic_candidate', argumentsDelta: argumentsJson }
  yield { type: 'block-end', index, block: { type: 'tool-call', id, name: 'submit_diagnostic_candidate', arguments: argumentsJson } }
  if (usage !== undefined) yield { type: 'usage', usage }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

function sessionStore(logged: Session[], durable = true): SessionStore {
  return {
    prepare: (id?: SessionId) => {
      const session = Session.create(id!)
      logged.push(session)
      return session
    },
    enter: () => () => undefined,
    announce: () => undefined,
    flush: async () => durable,
  } as unknown as SessionStore
}
