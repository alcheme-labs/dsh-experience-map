import { ExperienceError } from '../errors.js'

const SECRET_PATTERNS = [
  /\bauthorization\s*:\s*bearer\s+\S+/iu,
  /\bcookie\s*:\s*"?(?:dsh-auth-[^=\s;"]+=[^\s;"]{12,}|[A-Za-z0-9_.-]{2,}=[^,\s;"]{8,})/iu,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[=:]\s*\S+/iu,
  /[?&]token=[A-Za-z0-9_-]{16,}/iu,
  /\bdsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9._~-]{12,}\b/u,
  /\bsk-[A-Za-z0-9_-]{12,}\b/u,
]

/** Reject secret-shaped or control-character-bearing text before persistence or model use. */
export function assertSafeText(value: string, label: string): void {
  if (SECRET_PATTERNS.some(pattern => pattern.test(value))) {
    throw new ExperienceError(
      'sensitive_content_unauthorized',
      `${label} contains secret-shaped content and cannot enter Experience memory`,
    )
  }
  if (/\u0000/u.test(value)) {
    throw new ExperienceError('sensitive_content_unauthorized', `${label} contains forbidden control characters`)
  }
}

/** Bound inline Candidate content while Governed Content remains unavailable. */
export function assertInlineValue(value: unknown, maxBytes: number, label: string): void {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) {
    throw new ExperienceError('invalid_command', `${label} is not JSON serializable`)
  }
  if (Buffer.byteLength(encoded) > maxBytes) {
    throw new ExperienceError(
      'governed_content_capability_unavailable',
      `${label} exceeds the inline content limit and Governed Content is unavailable`,
      { maxBytes },
    )
  }
  assertSafeText(encoded, label)
}
