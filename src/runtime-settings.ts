import type { Context } from '@deepseek-ai/cordis'
import type { SettingsForms } from '@deepseek-ai/dsh-settings'
import { digest } from './domain/planning.js'
import type { AutomationConfigurationView } from './types.js'
import {
  RuntimeSettingsSchema,
  RUNTIME_SETTINGS_KEYS,
  type RuntimeSettings,
  type RuntimeSettingsConfig,
  validateRuntimeSettings,
} from './runtime-settings-schema.js'

/** Immutable effective settings captured once at a public operation boundary. */
export interface RuntimeSettingsSnapshot {
  readonly revision: number | null
  readonly digest: string
  readonly values: RuntimeSettings
}

/** Optional user-settings adapter with a composition-config fallback. */
export class RuntimeSettingsSource {
  private current: () => RuntimeSettings
  private provider: SettingsForms | undefined

  /** Register the live namespace whenever a settings provider is present. */
  constructor(ctx: Context, entry: RuntimeSettingsConfig) {
    this.current = () => parseRuntimeSettings(Object.fromEntries(
      RUNTIME_SETTINGS_KEYS.map(key => [key, entry[key].get()]),
    ) as unknown as RuntimeSettings)
    this.current()
    ctx.inject(['settings'], settingsCtx => {
      const provider = settingsCtx.settings
      this.provider = provider
      settingsCtx.effect(() => () => {
        if (this.provider !== provider) return
        this.provider = undefined
      }, 'experience-map runtime settings provider ownership')
    })
  }

  /** Capture one operation-stable value, revision, and content identity. */
  capture(): RuntimeSettingsSnapshot {
    const values = deepFreeze(structuredClone(parseRuntimeSettings(this.current())))
    const revision = this.provider?.describe()
      .find(descriptor => descriptor.ns === 'experience-map')?.revision ?? null
    return deepFreeze({
      revision,
      digest: digest(values),
      values,
    })
  }
}

/** Derive an honest effective-state readback without widening any runtime authority. */
export function automationConfiguration(snapshot: RuntimeSettingsSnapshot): AutomationConfigurationView {
  const value = snapshot.values
  const contextConfigured = value.automaticContextInjection
  const contextEffective = contextConfigured === 'never' ? 'never' : 'after_current_plan_approval'
  const enrichmentReasons = value.enrichmentMode === 'disabled'
    ? ['user_disabled']
    : [
        'automatic_enrichment_not_implemented',
        ...(value.generationRoute === 'current_agent_model'
          ? ['background_current_agent_call_config_unavailable'] : []),
      ]
  return deepFreeze({
    schemaVersion: 'experience-automation-configuration-v1',
    settingsRevision: snapshot.revision,
    settingsDigest: snapshot.digest,
    suggestionDetection: booleanControl(value.automaticSuggestionDetection),
    recentSuggestionSessionLimit: value.recentSuggestionSessionLimit,
    suggestionTtlMs: value.suggestionTtlMs,
    recall: booleanControl(value.automaticRecall),
    contextInjection: {
      configured: contextConfigured,
      effective: contextEffective,
      availability: contextConfigured === 'never'
        ? 'disabled'
        : contextConfigured === 'eligible_high_confidence' ? 'constrained' : 'enabled',
      reasonCodes: contextConfigured === 'never'
        ? ['user_disabled']
        : contextConfigured === 'eligible_high_confidence'
          ? ['current_plan_approval_still_required'] : [],
    },
    toolExecution: {
      configured: value.automaticToolExecution,
      effective: 'disabled',
      availability: value.automaticToolExecution === 'disabled' ? 'disabled' : 'configured_but_unavailable',
      reasonCodes: value.automaticToolExecution === 'disabled'
        ? ['user_disabled'] : ['execution_binding_unavailable'],
    },
    enrichment: {
      configured: value.enrichmentMode,
      effective: 'disabled',
      availability: value.enrichmentMode === 'disabled' ? 'disabled' : 'configured_but_unavailable',
      reasonCodes: enrichmentReasons,
      generationRoute: value.generationRoute,
    },
    reranker: {
      configured: 'disabled',
      effective: 'disabled',
      availability: 'configured_but_unavailable',
      reasonCodes: ['e0_quality_gate_not_met'],
    },
  })
}

function booleanControl(configured: boolean): AutomationConfigurationView['suggestionDetection'] {
  return {
    configured,
    effective: configured,
    availability: configured ? 'enabled' : 'disabled',
    reasonCodes: configured ? [] : ['user_disabled'],
  }
}

function parseRuntimeSettings(value: RuntimeSettings): RuntimeSettings {
  const parsed = RuntimeSettingsSchema(value)
  validateRuntimeSettings(parsed)
  return parsed
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}
