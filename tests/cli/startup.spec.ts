import type { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { apply } from '../../src/cli/startup.js'

it.each([
  ['status', [], { kind: 'status' }],
  ['suggestions-show', [], { kind: 'suggestions-show' }],
  ['suggestion-save', ['--input', 'save.json'], { kind: 'suggestion-save', inputPath: 'save.json' }],
  ['suggestion-dismiss', ['--input', 'dismiss.json'], { kind: 'suggestion-dismiss', inputPath: 'dismiss.json' }],
  ['retrieval-show', [], { kind: 'retrieval-show' }],
  ['automation-config-show', [], { kind: 'automation-config-show' }],
  ['learning-governance-show', [], { kind: 'learning-governance-show' }],
  ['learning-ranking-reviews-show', [], { kind: 'learning-ranking-reviews-show' }],
  ['plan-show', ['--usage-id', 'usage-1'], { kind: 'plan-show', usageId: 'usage-1' }],
  ['evaluation-record', ['--input', 'obs.json'], { kind: 'evaluation-record', inputPath: 'obs.json' }],
  ['evaluation-report', ['--cohort-id', 'cohort-m7'], { kind: 'evaluation-report', cohortId: 'cohort-m7' }],
])('registers exactly the invoked management command: %s', (command, args, expected) => {
  const registrations: unknown[] = []
  const ctx = {
    get: (name: string) => name === 'cmdlineArgs' ? { get: () => ['experience', command, ...args] } : () => { throw new Error('unexpected exit') },
    provide: (_name: string, spec: unknown) => {
      if (registrations.length) throw new Error('duplicate service registration')
      registrations.push(spec)
    },
  } as unknown as Context
  apply(ctx)
  expect(registrations).toEqual([expected])
})
