import { describe, expect, it } from 'vitest'
import { parseSaveExperienceSuggestionInput } from '../src/application/input.js'

const digest = (character: string): string => `sha256:${character.repeat(64)}`

describe('suggestion owner choice input', () => {
  it('parses the bounded structured choice on the existing save command', () => {
    const input = {
      commandId: '30000000-0000-4000-8000-000000000001',
      suggestionGroupId: 'suggestion-group:reviewed',
      expectedRevisionDigest: digest('a'),
      reviewDigest: digest('b'),
      sourceDigest: digest('c'),
      ownerChoice: {
        choice: 'keep_distinct',
        targetExperienceVersionId: 'version-existing',
        materialDifferences: [{
          facet: 'condition',
          incomingComponentKey: 'environment_scope-0',
          targetComponentRevisionId: 'revision-existing',
          incomingContentDigest: digest('d'),
          targetContentDigest: digest('e'),
          reasonCode: 'condition_scope_specialization',
        }],
      },
      correlationId: 'correlation-1',
      causationId: null,
      issuedAt: '2099-01-01T00:00:00.000Z',
    }

    expect(parseSaveExperienceSuggestionInput(input)).toEqual(input)
  })

  it.each([
    ['free-text facet', { facet: 'notes' }],
    ['unknown difference field', { extra: 'free text' }],
    ['unknown choice', null],
  ])('rejects %s instead of trusting client-authored semantics', (_name, mutation) => {
    const difference = {
      facet: 'condition', incomingComponentKey: 'incoming', targetComponentRevisionId: 'target',
      incomingContentDigest: digest('d'), targetContentDigest: digest('e'), reasonCode: 'verified',
      ...(mutation ?? {}),
    }
    const value = {
      commandId: '30000000-0000-4000-8000-000000000002', suggestionGroupId: 'group',
      expectedRevisionDigest: digest('a'), reviewDigest: digest('b'), sourceDigest: digest('c'),
      ownerChoice: {
        choice: mutation === null ? 'merge_anyway' : 'keep_distinct',
        targetExperienceVersionId: 'version-existing', materialDifferences: [difference],
      },
      correlationId: 'correlation-2', causationId: null, issuedAt: '2099-01-01T00:00:00.000Z',
    }

    expect(() => parseSaveExperienceSuggestionInput(value)).toThrowError(expect.objectContaining({
      code: 'invalid_command',
    }))
  })
})
