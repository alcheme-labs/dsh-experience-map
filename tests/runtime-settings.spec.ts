import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { RESTART_CONFIG_KEYS } from '../src/index.js'
import { automationConfiguration, RuntimeSettingsSource } from '../src/runtime-settings.js'
import {
  RUNTIME_SETTINGS_KEYS,
  RuntimeSettingsSchema,
  RuntimeSettingsConfigSchema,
  type RuntimeSettings,
  type RuntimeSettingsConfig,
} from '../src/runtime-settings-schema.js'

describe('Experience Map runtime settings', () => {
  it('keeps exactly 56 live fields and 12 restart-only fields', () => {
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

  it('captures immutable startup configuration without a competing settings writer', async () => {
    const ctx = new Context()
    const original = new RuntimeSettingsSource(ctx, hostSettings(runtimeDefaults()))
    const first = original.capture()
    expect(first.revision).toBeNull()
    expect(first.values.maxTokens).toBe(8_192)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.values)).toBe(true)

    const updated = new RuntimeSettingsSource(ctx, hostSettings({
      ...runtimeDefaults(), maxTokens: 12_288,
    }))
    const second = updated.capture()
    expect(first.values.maxTokens).toBe(8_192)
    expect(second.values.maxTokens).toBe(12_288)
    expect(second.digest).not.toBe(first.digest)
    await ctx.fiber.dispose()
  })

  it('rejects invalid cross-field budgets at the plugin configuration boundary', async () => {
    const ctx = new Context()
    expect(() => new RuntimeSettingsSource(ctx, hostSettings({
      ...runtimeDefaults(), maxRecordBytes: 65_536, maxTotalBytes: 4_096,
    }))).toThrow('maxRecordBytes must not exceed maxTotalBytes')
    await ctx.fiber.dispose()
  })

  it('rejects an enabled local embedding route without pinned local artifact identity', async () => {
    const ctx = new Context()
    expect(() => new RuntimeSettingsSource(ctx, hostSettings({
      ...runtimeDefaults(), embeddingProvider: 'transformers_js', embeddingModelPath: '',
    }))).toThrow('embeddingModelPath must be an absolute local directory')
    expect(() => new RuntimeSettingsSource(ctx, hostSettings({
      ...runtimeDefaults(), embeddingProvider: 'transformers_js',
      embeddingModelPath: '/tmp/model', embeddingArtifactSha256: 'not-a-digest',
    }))).toThrow('embeddingArtifactSha256')
    await ctx.fiber.dispose()
  })
})

function hostSettings(values: RuntimeSettings): RuntimeSettingsConfig {
  return RuntimeSettingsConfigSchema(values as unknown as RuntimeSettingsConfig)
}

function runtimeDefaults(): RuntimeSettings {
  return RuntimeSettingsSchema({} as RuntimeSettings)
}
