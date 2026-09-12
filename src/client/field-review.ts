import {
  M2_ALLOWED_USE_MODES,
  type AllowedUseMode,
  type DiagnosticComponentInput,
} from '../types.js'

/** Editable client model for one M2 Candidate field. */
export type FieldEditDraft =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'record'; readonly entries: readonly FieldRecordEntry[] }
  | { readonly kind: 'privacy'; readonly value: 'public' | 'workspace' | 'restricted' }
  | { readonly kind: 'use_modes'; readonly values: readonly AllowedUseMode[] }
  | { readonly kind: 'component'; readonly value: DiagnosticComponentInput }

/** One key/value row in a typed record editor. */
export interface FieldRecordEntry {
  readonly key: string
  readonly value: string
}

/** Stable validation issue shown beside an edited Candidate field. */
export type FieldEditIssue =
  | 'empty_value'
  | 'empty_record'
  | 'duplicate_record_key'
  | 'effective_source_required'
  | 'use_mode_required'

/** Result of converting a typed editor draft into the Candidate replacement value. */
export type FieldEditResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issue: FieldEditIssue }

const RECORD_FIELDS = new Set(['scope', 'validity', 'authoritySpec', 'riskAndEffectSpec'])
const IMMUTABLE_FIELDS = new Set(['proposedKind', 'sourceEpisodeRefs', 'sourceRefs'])

/** Structural equality of two field values (original proposal vs effective value). */
export function fieldValuesEqual(proposed: unknown, effective: unknown): boolean {
  if (Object.is(proposed, effective)) return true
  if (typeof proposed !== 'object' || proposed === null
    || typeof effective !== 'object' || effective === null) return false
  if (Array.isArray(proposed) !== Array.isArray(effective)) return false
  if (Array.isArray(proposed) && Array.isArray(effective)) {
    if (proposed.length !== effective.length) return false
    return proposed.every((item, index) => fieldValuesEqual(item, effective[index]))
  }
  const left = proposed as Record<string, unknown>
  const right = effective as Record<string, unknown>
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every(key => key in right && fieldValuesEqual(left[key], right[key]))
}

/** One aligned span of a readable field diff. */
export type FieldDiffSegment =
  | { readonly type: 'same'; readonly text: string }
  | { readonly type: 'removed'; readonly text: string }
  | { readonly type: 'added'; readonly text: string }

/** Bound on the LCS matrix so pathological values degrade to replace instead of hanging. */
const DIFF_MAX_TOKENS = 512

/**
 * Word-aligned diff for the original proposal and the effective value of a text field.
 * Returns null when either side is not text (complex fields are compared structurally instead).
 */
export function fieldTextDiff(proposed: unknown, effective: unknown): FieldDiffSegment[] | null {
  if (typeof proposed !== 'string' || typeof effective !== 'string') return null
  if (proposed === effective) return [{ type: 'same', text: proposed }]
  const source = tokenize(proposed)
  const target = tokenize(effective)
  if (source.length * target.length > DIFF_MAX_TOKENS * DIFF_MAX_TOKENS) {
    return replaceSegments(source, target)
  }
  return mergeSegments(diffTokens(source, target))
}

function tokenize(value: string): string[] {
  return value.split(/\s+/).filter(word => word !== '')
}

function diffTokens(source: readonly string[], target: readonly string[]): FieldDiffSegment[] {
  const table = lcsTable(source, target)
  const segments: FieldDiffSegment[] = []
  let i = 0
  let j = 0
  while (i < source.length && j < target.length) {
    const sourceWord = source[i]!
    const targetWord = target[j]!
    if (sourceWord === targetWord) {
      pushSegment(segments, 'same', sourceWord)
      i += 1
      j += 1
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      pushSegment(segments, 'removed', sourceWord)
      i += 1
    } else {
      pushSegment(segments, 'added', targetWord)
      j += 1
    }
  }
  while (i < source.length) {
    pushSegment(segments, 'removed', source[i]!)
    i += 1
  }
  while (j < target.length) {
    pushSegment(segments, 'added', target[j]!)
    j += 1
  }
  return segments
}

function lcsTable(source: readonly string[], target: readonly string[]): number[][] {
  const rows = source.length + 1
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(target.length + 1).fill(0))
  for (let i = source.length - 1; i >= 0; i -= 1) {
    for (let j = target.length - 1; j >= 0; j -= 1) {
      table[i]![j] = source[i] === target[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  return table
}

function pushSegment(segments: FieldDiffSegment[], type: FieldDiffSegment['type'], word: string): void {
  const last = segments[segments.length - 1]
  if (last !== undefined && last.type === type) {
    segments[segments.length - 1] = { type, text: `${last.text} ${word}` }
  } else {
    segments.push({ type, text: word })
  }
}

function mergeSegments(segments: readonly FieldDiffSegment[]): FieldDiffSegment[] {
  return segments.filter(segment => segment.text !== '')
}

function replaceSegments(source: readonly string[], target: readonly string[]): FieldDiffSegment[] {
  const segments: FieldDiffSegment[] = []
  if (source.length > 0) segments.push({ type: 'removed', text: source.join(' ') })
  if (target.length > 0) segments.push({ type: 'added', text: target.join(' ') })
  return segments
}

/** Build the typed editor model for a reviewable field, or null for Host-owned fields. */
export function createFieldEditDraft(field: string, value: unknown): FieldEditDraft | null {
  if (IMMUTABLE_FIELDS.has(field)) return null
  if (field === 'title' || field === 'intent') {
    return typeof value === 'string' ? { kind: 'text', value } : null
  }
  if (RECORD_FIELDS.has(field)) {
    if (!isStringRecord(value)) return null
    return { kind: 'record', entries: Object.entries(value).map(([key, item]) => ({ key, value: item })) }
  }
  if (field === 'privacyClass') {
    return value === 'public' || value === 'workspace' || value === 'restricted'
      ? { kind: 'privacy', value }
      : null
  }
  if (field === 'allowedUseModes') {
    return isAllowedUseModes(value) ? { kind: 'use_modes', values: value } : null
  }
  if (field.startsWith('component:') && isDiagnosticComponent(value)) {
    return { kind: 'component', value }
  }
  return null
}

/** Convert one typed edit and the explicitly reselected evidence into a field replacement. */
export function resolveFieldEdit(
  draft: FieldEditDraft,
  effectiveSourceRefs: readonly string[],
): FieldEditResult {
  if (effectiveSourceRefs.length === 0) return { ok: false, issue: 'effective_source_required' }
  switch (draft.kind) {
    case 'text':
      return draft.value.trim() === ''
        ? { ok: false, issue: 'empty_value' }
        : { ok: true, value: draft.value }
    case 'record': {
      if (draft.entries.length === 0) return { ok: false, issue: 'empty_record' }
      const entries = draft.entries.map(entry => ({ key: entry.key.trim(), value: entry.value.trim() }))
      if (entries.some(entry => entry.key === '' || entry.value === '')) {
        return { ok: false, issue: 'empty_record' }
      }
      if (new Set(entries.map(entry => entry.key)).size !== entries.length) {
        return { ok: false, issue: 'duplicate_record_key' }
      }
      return { ok: true, value: Object.fromEntries(entries.map(entry => [entry.key, entry.value])) }
    }
    case 'privacy':
      return { ok: true, value: draft.value }
    case 'use_modes':
      return draft.values.length === 0
        ? { ok: false, issue: 'use_mode_required' }
        : { ok: true, value: draft.values }
    case 'component':
      return draft.value.content.trim() === ''
        ? { ok: false, issue: 'empty_value' }
        : { ok: true, value: { ...draft.value, sourceRefs: [...effectiveSourceRefs] } }
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every(item => typeof item === 'string')
}

function isAllowedUseModes(value: unknown): value is AllowedUseMode[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string'
    && M2_ALLOWED_USE_MODES.includes(item as typeof M2_ALLOWED_USE_MODES[number]))
}

function isDiagnosticComponent(value: unknown): value is DiagnosticComponentInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const component = value as Record<string, unknown>
  return typeof component.componentKey === 'string'
    && typeof component.role === 'string'
    && typeof component.content === 'string'
    && Array.isArray(component.sourceRefs)
    && component.sourceRefs.every(item => typeof item === 'string')
}
