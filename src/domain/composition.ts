import { ExperienceError } from '../errors.js'
import type { BehaviorContribution } from './behavior.js'

/** One contribution with stable owner identity and dependency edges. */
export interface CompositionInput extends BehaviorContribution {
  readonly experienceId: string
  readonly componentId: string
  readonly precedes: readonly string[]
  readonly conflictsWith: readonly string[]
}

/** Deterministic composition with explicit discarded conflicts. */
export interface CompositionResult {
  readonly ordered: readonly CompositionInput[]
  readonly discarded: readonly { readonly componentId: string; readonly reasonCode: 'experience_conflict' }[]
}

/** Compose independent contributions without depending on retrieval order. */
export function composeContributions(input: readonly CompositionInput[]): CompositionResult {
  const canonical = [...input].sort(compare)
  const byId = new Map(canonical.map(item => [item.componentId, item]))
  if (byId.size !== canonical.length) {
    throw new ExperienceError('invalid_command', 'component ids must be unique during composition')
  }
  const discarded = new Set<string>()
  const conflictKeys = new Set<string>()
  const conflicts: Array<readonly [CompositionInput, CompositionInput]> = []
  for (const item of canonical) {
    for (const targetId of item.conflictsWith) {
      const target = byId.get(targetId)
      if (target === undefined || target.componentId === item.componentId) continue
      const [left, right] = compare(item, target) <= 0 ? [item, target] : [target, item]
      const key = `${left.componentId}\u0000${right.componentId}`
      if (!conflictKeys.has(key)) {
        conflictKeys.add(key)
        conflicts.push([left, right])
      }
    }
  }
  for (const [left, right] of conflicts) {
    const loser = compare(left, right) <= 0 ? right : left
    discarded.add(loser.componentId)
  }
  const live = canonical.filter(item => !discarded.has(item.componentId))
  const indegree = new Map(live.map(item => [item.componentId, 0]))
  const outgoing = new Map(live.map(item => [item.componentId, [] as string[]]))
  for (const item of live) {
    for (const targetId of item.precedes) {
      if (!indegree.has(targetId)) continue
      outgoing.get(item.componentId)?.push(targetId)
      indegree.set(targetId, (indegree.get(targetId) ?? 0) + 1)
    }
  }
  const ready = live.filter(item => indegree.get(item.componentId) === 0).sort(compare)
  const ordered: CompositionInput[] = []
  while (ready.length > 0) {
    const item = ready.shift()
    if (item === undefined) break
    ordered.push(item)
    for (const targetId of outgoing.get(item.componentId) ?? []) {
      const next = (indegree.get(targetId) ?? 0) - 1
      indegree.set(targetId, next)
      if (next === 0) {
        const target = byId.get(targetId)
        if (target !== undefined) {
          ready.push(target)
          ready.sort(compare)
        }
      }
    }
  }
  if (ordered.length !== live.length) {
    throw new ExperienceError('composition_cycle', 'precedes relations must be acyclic')
  }
  return {
    ordered,
    discarded: [...discarded].sort().map(componentId => ({ componentId, reasonCode: 'experience_conflict' })),
  }
}

function compare(left: CompositionInput, right: CompositionInput): number {
  return left.priority - right.priority
    || left.experienceId.localeCompare(right.experienceId)
    || left.componentId.localeCompare(right.componentId)
}
