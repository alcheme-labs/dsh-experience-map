import { describe, expect, it } from 'vitest'
import { createFieldEditDraft, resolveFieldEdit } from '../../src/client/field-review.js'

describe('M2 typed field review', () => {
  it('keeps Host-owned identity and source fields immutable', () => {
    expect(createFieldEditDraft('proposedKind', 'diagnostic')).toBeNull()
    expect(createFieldEditDraft('sourceEpisodeRefs', [])).toBeNull()
    expect(createFieldEditDraft('sourceRefs', [])).toBeNull()
  })

  it('requires explicit effective sources for every edited field', () => {
    const draft = createFieldEditDraft('title', 'Original title')
    expect(draft).toEqual({ kind: 'text', value: 'Original title' })
    expect(resolveFieldEdit(draft!, [])).toEqual({ ok: false, issue: 'effective_source_required' })
    expect(resolveFieldEdit({ kind: 'text', value: 'Edited title' }, ['source:1']))
      .toEqual({ ok: true, value: 'Edited title' })
  })

  it('edits Diagnostic content without exposing component identity or source arrays as free-form JSON', () => {
    const draft = createFieldEditDraft('component:symptom', {
      componentKey: 'symptom',
      role: 'symptom_signature',
      content: 'Original symptom',
      sourceRefs: ['source:old'],
    })
    expect(draft?.kind).toBe('component')
    if (draft?.kind !== 'component') throw new Error('expected component editor')
    const result = resolveFieldEdit({
      kind: 'component',
      value: { ...draft.value, content: 'Edited symptom' },
    }, ['source:new'])
    expect(result).toEqual({
      ok: true,
      value: {
        componentKey: 'symptom',
        role: 'symptom_signature',
        content: 'Edited symptom',
        sourceRefs: ['source:new'],
      },
    })
  })

  it('validates record rows and limits use-mode editing to the M2 ceiling', () => {
    expect(resolveFieldEdit({
      kind: 'record',
      entries: [{ key: 'surface', value: 'web' }, { key: 'surface', value: 'cli' }],
    }, ['source:1'])).toEqual({ ok: false, issue: 'duplicate_record_key' })
    expect(createFieldEditDraft('allowedUseModes', ['reference', 'suggest', 'guided']))
      .toEqual({ kind: 'use_modes', values: ['reference', 'suggest', 'guided'] })
    expect(createFieldEditDraft('allowedUseModes', ['guarded_execute'])).toBeNull()
  })
})
