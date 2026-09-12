import type { AutomationConfigurationView } from '../../src/types.js'

/** Complete conservative E5 readback shared by Browser-controller fixtures. */
export function automationConfigurationFixture(): AutomationConfigurationView {
  return {
    schemaVersion: 'experience-automation-configuration-v1',
    settingsRevision: 0,
    settingsDigest: `sha256:${'a'.repeat(64)}`,
    suggestionDetection: { configured: true, effective: true, availability: 'enabled', reasonCodes: [] },
    recentSuggestionSessionLimit: 8,
    suggestionTtlMs: 14 * 24 * 60 * 60_000,
    recall: { configured: true, effective: true, availability: 'enabled', reasonCodes: [] },
    contextInjection: {
      configured: 'after_current_plan_approval',
      effective: 'after_current_plan_approval',
      availability: 'enabled',
      reasonCodes: [],
    },
    toolExecution: {
      configured: 'disabled', effective: 'disabled', availability: 'disabled', reasonCodes: ['user_disabled'],
    },
    enrichment: {
      configured: 'disabled', effective: 'disabled', availability: 'disabled', reasonCodes: ['user_disabled'],
      generationRoute: 'configured_dsh_provider',
    },
    reranker: {
      configured: 'disabled', effective: 'disabled', availability: 'configured_but_unavailable',
      reasonCodes: ['e0_quality_gate_not_met'],
    },
  }
}
