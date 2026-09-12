import { describe, expect, it } from 'vitest'
import { assertBehaviorParity, TYPE_BEHAVIORS } from '../../src/domain/behavior.js'
import { composeContributions, type CompositionInput } from '../../src/domain/composition.js'
import { EXPERIENCE_KINDS } from '../../src/domain/kind.js'
import { EXPERIENCE_KIND_SQL } from '../../src/persistence/schema.js'

describe('Experience kind and type behavior owners', () => {
  it('owns exactly the six protocol kinds and one behavior for each', () => {
    expect(EXPERIENCE_KINDS).toEqual([
      'procedure', 'diagnostic', 'preference_policy', 'fact', 'strategy', 'causal',
    ])
    expect(assertBehaviorParity).not.toThrow()
    expect(Object.keys(TYPE_BEHAVIORS).sort()).toEqual([...EXPERIENCE_KINDS].sort())
    expect(EXPERIENCE_KIND_SQL).toBe(EXPERIENCE_KINDS.map(kind => `'${kind}'`).join(','))
  })

  it.each(EXPERIENCE_KINDS)('%s validates, contributes, renders, and revises deterministically', (kind) => {
    const behavior = TYPE_BEHAVIORS[kind]
    expect(behavior.validate(new Set())).toEqual(expect.arrayContaining([...behavior.requiredRoles]))
    const complete = new Set(behavior.requiredRoles)
    if (kind === 'preference_policy') {
      complete.add('positive_example')
      complete.add('no_known_exception')
    }
    expect(behavior.validate(complete)).toEqual([])
    const contributions = behavior.requiredRoles.map(role => behavior.contribute(role, `${role} value`))
    expect(behavior.contextSection([...contributions].reverse())).toEqual(behavior.contextSection(contributions))
    expect(behavior.revisionHint(behavior.requiredRoles[0]!)).toBe(`revise:${kind}:${behavior.requiredRoles[0]!}`)
  })

  it('rejects components belonging to another Experience kind', () => {
    expect(() => TYPE_BEHAVIORS.procedure.contribute('causal_grade', 'unsupported'))
      .toThrow(/not valid for procedure/i)
  })
})

describe('deterministic composition', () => {
  const inputs: CompositionInput[] = [
    item('b', 1, ['c']),
    item('a', 1, []),
    item('c', 0, []),
  ]

  it('does not depend on retrieval order and respects dependency edges', () => {
    const expected = composeContributions(inputs)
    expect(composeContributions([...inputs].reverse())).toEqual(expected)
    expect(composeContributions([inputs[1]!, inputs[2]!, inputs[0]!])).toEqual(expected)
    expect(expected.ordered.map(item => item.componentId)).toEqual(['a', 'b', 'c'])
  })

  it('records deterministic conflict losers and rejects cycles', () => {
    const conflict = composeContributions([
      { ...item('a', 0, []), conflictsWith: ['b'] },
      { ...item('b', 1, []), conflictsWith: ['a'] },
    ])
    expect(conflict.ordered.map(item => item.componentId)).toEqual(['a'])
    expect(conflict.discarded).toEqual([{ componentId: 'b', reasonCode: 'experience_conflict' }])
    expect(() => composeContributions([
      item('a', 0, ['b']),
      item('b', 0, ['a']),
    ])).toThrow(/acyclic/)
  })

  it('normalizes a conflict declared from either side', () => {
    const leftDeclared = composeContributions([
      { ...item('a', 0, []), conflictsWith: ['b'] },
      item('b', 1, []),
    ])
    const rightDeclared = composeContributions([
      item('a', 0, []),
      { ...item('b', 1, []), conflictsWith: ['a'] },
    ])
    expect(rightDeclared.ordered.map(item => item.componentId))
      .toEqual(leftDeclared.ordered.map(item => item.componentId))
    expect(rightDeclared.discarded).toEqual(leftDeclared.discarded)
    expect(rightDeclared.discarded).toEqual([{ componentId: 'b', reasonCode: 'experience_conflict' }])
  })
})

function item(componentId: string, priority: number, precedes: readonly string[]): CompositionInput {
  return {
    componentId,
    experienceId: 'experience-1',
    sourceRole: 'step',
    contributionRole: 'instruction',
    text: componentId,
    priority,
    precedes,
    conflictsWith: [],
  }
}
