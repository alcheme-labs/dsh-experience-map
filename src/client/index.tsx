import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { registerExperienceSettings } from './settings-card.js'
import { registerExperienceWorkspace } from './workspace.js'

/** Required Browser services: authenticated Connection, locale, and existing Session view slots. */
export const inject = ['connection', 'locale', 'slots', 'settingsScope', 'settingsSchema']

/** Register the in-Harness Experience tab and authoritative status controller. */
export function apply(ctx: Context): void {
  registerExperienceWorkspace(ctx)
  registerExperienceSettings(ctx)
}
