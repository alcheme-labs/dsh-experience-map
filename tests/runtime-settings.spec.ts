import { Context, type Fiber } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { describe, expect, it } from 'vitest'
import { RESTART_CONFIG_KEYS } from '../src/index.js'
import { automationConfiguration, RuntimeSettingsSource } from '../src/runtime-settings.js'
import {
  RUNTIME_SETTINGS_KEYS,
  RuntimeSettingsSchema,
  type RuntimeSettings,
} from '../src/runtime-settings-schema.js'

class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

describe('Experience Map runtime settings', () => {
  it('keeps exactly 54 live fields and 12 restart-only fields', () => {
    const runtime = runtimeDefaults()
    expect(RUNTIME_SETTINGS_KEYS).toHaveLength(56)
    expect(RESTART_CONFIG_KEYS).toHaveLength(12)
    expect(Object.keys(runtime).sort()).toEqual([...RUNTIME_SETTINGS_KEYS].sort())
    expect(new Set([...RUNTIME_SETTINGS_KEYS, ...RESTART_CONFIG_KEYS]).size).toBe(68)
    expect(runtime).toMatchObject({
      automaticSuggestionDetection: true,
      recentSuggestionSessionLimit: 8,
      suggestionTtlMs: 14 * 24 * 60 * 60_000,
      automaticRecall: true,
      automaticContextInjection: 'after_current_plan_approval',
      automaticToolExecution: 'disabled',
      enrichmentMode: 'disabled',
      generationRoute: 'configured_dsh_provider',
      embeddingNormalization: 'l2',
      embeddingMaxInputTokens: 512,
      embeddingTruncationPolicy: 'truncate_end',
      equivalenceSimilarityThreshold: 0.88,
      equivalenceMargin: 0.03,
    })
  })

  it('reads configured automation preferences back with stricter effective limits', () => {
    const values = RuntimeSettingsSchema({
      automaticContextInjection: 'eligible_high_confidence',
      automaticToolExecution: 'when_eligible',
      enrichmentMode: 'always',
      generationRoute: 'current_agent_model',
    } as RuntimeSettings)
    const view = automationConfiguration({ revision: 7, digest: 'sha256:' + '7'.repeat(64), values })

    expect(view).toMatchObject({
      settingsRevision: 7,
      suggestionDetection: { configured: true, effective: true, availability: 'enabled' },
      recall: { configured: true, effective: true, availability: 'enabled' },
      contextInjection: {
        configured: 'eligible_high_confidence',
        effective: 'after_current_plan_approval',
        availability: 'constrained',
        reasonCodes: ['current_plan_approval_still_required'],
      },
      toolExecution: {
        configured: 'when_eligible', effective: 'disabled', availability: 'configured_but_unavailable',
        reasonCodes: ['execution_binding_unavailable'],
      },
      enrichment: {
        configured: 'always', effective: 'disabled', availability: 'configured_but_unavailable',
        generationRoute: 'current_agent_model',
        reasonCodes: ['automatic_enrichment_not_implemented', 'background_current_agent_call_config_unavailable'],
      },
      reranker: { effective: 'disabled', reasonCodes: ['e0_quality_gate_not_met'] },
    })
    expect(Object.isFrozen(view)).toBe(true)
  })

  it('captures immutable operation settings and moves identity after one durable update', async () => {
    const bench = await boot()
    const first = bench.source.capture()
    expect(first.revision).toBe(0)
    expect(first.values.maxTokens).toBe(8_192)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.values)).toBe(true)

    await bench.ctx.settings.update('experience-map', { maxTokens: 12_288 }, first.revision ?? undefined)
    const second = bench.source.capture()
    expect(first.values.maxTokens).toBe(8_192)
    expect(second.values.maxTokens).toBe(12_288)
    expect(second.revision).toBe(1)
    expect(second.digest).not.toBe(first.digest)
    await bench.ctx.fiber.dispose()
  })

  it('rejects invalid cross-field budgets before persistence', async () => {
    const bench = await boot()
    await expect(bench.ctx.settings.update('experience-map', {
      maxRecordBytes: 65_536,
      maxTotalBytes: 4_096,
    })).rejects.toThrow('maxRecordBytes must not exceed maxTotalBytes')
    expect(bench.source.capture().values.maxTotalBytes).toBe(262_144)
    await bench.ctx.fiber.dispose()
  })

  it('rejects an enabled local embedding route without a pinned local artifact identity', async () => {
    const bench = await boot()
    await expect(bench.ctx.settings.update('experience-map', {
      embeddingProvider: 'transformers_js',
      embeddingModelPath: '',
    })).rejects.toThrow('embeddingModelPath must be an absolute local directory')
    await expect(bench.ctx.settings.update('experience-map', {
      embeddingProvider: 'transformers_js',
      embeddingModelPath: '/tmp/model',
      embeddingArtifactSha256: 'not-a-digest',
    })).rejects.toThrow('embeddingArtifactSha256')
    expect(bench.source.capture().values.embeddingProvider).toBe('disabled')
    await bench.ctx.fiber.dispose()
  })

  it('rejects a concurrent edit that uses a stale namespace revision', async () => {
    const bench = await boot()
    const revision = bench.source.capture().revision
    const results = await Promise.allSettled([
      bench.ctx.settings.update('experience-map', { maxTokens: 10_240 }, revision ?? undefined),
      bench.ctx.settings.update('experience-map', { maxTokens: 12_288 }, revision ?? undefined),
    ])

    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(bench.source.capture()).toMatchObject({ revision: 1 })
    await bench.ctx.fiber.dispose()
  })

  it('falls back to composition values when the optional settings provider detaches', async () => {
    const bench = await boot()
    await bench.ctx.settings.update('experience-map', { model: 'changed-model' })
    expect(bench.source.capture().values.model).toBe('changed-model')

    await bench.settingsFiber.dispose()

    expect(bench.source.capture()).toMatchObject({
      revision: null,
      values: { model: 'deepseek-v4-flash' },
    })
    await bench.ctx.fiber.dispose()
  })
})

async function boot(): Promise<{
  readonly ctx: Context
  readonly settingsFiber: Fiber
  readonly source: RuntimeSettingsSource
}> {
  const ctx = new Context()
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  const source = new RuntimeSettingsSource(ctx, runtimeDefaults())
  return { ctx, settingsFiber, source }
}

function runtimeDefaults(): RuntimeSettings {
  return RuntimeSettingsSchema({} as RuntimeSettings)
}
