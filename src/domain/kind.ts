/** The single machine-owned Experience kind vocabulary. */
export const EXPERIENCE_KINDS = [
  'procedure',
  'diagnostic',
  'preference_policy',
  'fact',
  'strategy',
  'causal',
] as const

/** Published Experience semantic kind. */
export type ExperienceKind = typeof EXPERIENCE_KINDS[number]

/** Check the exact closed kind vocabulary at an untyped boundary. */
export function isExperienceKind(value: unknown): value is ExperienceKind {
  return typeof value === 'string' && (EXPERIENCE_KINDS as readonly string[]).includes(value)
}
