/** Stable application and domain failure codes. */
export type ExperienceErrorCode =
  | 'database_foreign_application'
  | 'database_newer_schema'
  | 'database_schema_invalid'
  | 'database_permissions_unsafe'
  | 'database_busy'
  | 'idempotency_conflict'
  | 'experience_duplicate'
  | 'embedding_provider_unavailable'
  | 'embedding_artifact_missing'
  | 'embedding_artifact_digest_mismatch'
  | 'embedding_model_drift'
  | 'embedding_timeout'
  | 'embedding_cancelled'
  | 'embedding_wrong_dimension'
  | 'embedding_non_finite_vector'
  | 'stale_revision'
  | 'required_field_missing'
  | 'source_unresolvable'
  | 'episode_not_terminal'
  | 'sensitive_content_unauthorized'
  | 'governed_content_capability_unavailable'
  | 'wrong_experience_kind'
  | 'proposal_output_limit'
  | 'invalid_command'
  | 'not_found'
  | 'principal_unauthorized'
  | 'composition_cycle'
  | 'internal'

const EXPERIENCE_ERROR_BRAND = Symbol.for('@alcheme/dsh-experience-map/ExperienceError')
const EXPERIENCE_ERROR_CODES: ReadonlySet<string> = new Set<ExperienceErrorCode>([
  'database_foreign_application',
  'database_newer_schema',
  'database_schema_invalid',
  'database_permissions_unsafe',
  'database_busy',
  'idempotency_conflict',
  'experience_duplicate',
  'embedding_provider_unavailable',
  'embedding_artifact_missing',
  'embedding_artifact_digest_mismatch',
  'embedding_model_drift',
  'embedding_timeout',
  'embedding_cancelled',
  'embedding_wrong_dimension',
  'embedding_non_finite_vector',
  'stale_revision',
  'required_field_missing',
  'source_unresolvable',
  'episode_not_terminal',
  'sensitive_content_unauthorized',
  'governed_content_capability_unavailable',
  'wrong_experience_kind',
  'proposal_output_limit',
  'invalid_command',
  'not_found',
  'principal_unauthorized',
  'composition_cycle',
  'internal',
])

/** Typed failure surfaced without exposing SQLite or transport internals. */
export class ExperienceError extends Error {
  readonly [EXPERIENCE_ERROR_BRAND] = true

  /** Create one stable failure. */
  constructor(
    readonly code: ExperienceErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ExperienceError'
  }
}

/** Convert an unknown failure to the stable public form. */
export function publicFailure(error: unknown): {
  readonly code: ExperienceErrorCode
  readonly message: string
  readonly details: Readonly<Record<string, unknown>>
} {
  if (isExperienceError(error)) {
    return { code: error.code, message: error.message, details: error.details }
  }
  return { code: 'internal', message: 'Experience operation failed', details: {} }
}

function isExperienceError(error: unknown): error is ExperienceError {
  if (!(error instanceof Error) || (error as ExperienceError)[EXPERIENCE_ERROR_BRAND] !== true) return false
  const candidate = error as ExperienceError
  return EXPERIENCE_ERROR_CODES.has(candidate.code)
    && typeof candidate.message === 'string'
    && typeof candidate.details === 'object'
    && candidate.details !== null
    && !Array.isArray(candidate.details)
}
