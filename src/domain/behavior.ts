import type { ComponentRole } from '../types.js'
import { ExperienceError } from '../errors.js'
import type { ExperienceKind } from './kind.js'
import { EXPERIENCE_KINDS } from './kind.js'

/** Deterministic contribution emitted by a type behavior. */
export interface BehaviorContribution {
  readonly sourceRole: ComponentRole
  readonly contributionRole: 'instruction' | 'constraint' | 'fact' | 'hypothesis' | 'criterion'
  readonly text: string
  readonly priority: number
}

/** Pure behavior shared by publication, planning, context, and settlement. */
export interface TypeBehavior {
  readonly kind: ExperienceKind
  readonly requiredRoles: readonly ComponentRole[]
  readonly optionalRoles: readonly ComponentRole[]
  validate(roles: ReadonlySet<ComponentRole>): readonly ComponentRole[]
  contribute(role: ComponentRole, content: string): BehaviorContribution
  contextSection(contributions: readonly BehaviorContribution[]): string
  mandatoryCriteria(contributions: readonly BehaviorContribution[]): readonly string[]
  revisionHint(failedRole: ComponentRole): string
}

const REQUIRED: Record<ExperienceKind, readonly ComponentRole[]> = {
  procedure: [
    'goal_signature', 'entry_condition', 'forbidden_condition', 'parameter',
    'environment_adapter', 'step', 'checkpoint', 'side_effect_policy',
    'failure_branch', 'verifier',
  ],
  diagnostic: [
    'symptom_signature', 'environment_scope', 'observed_fact', 'hypothesis',
    'discriminator', 'misleading_signal', 'branch', 'resolution_candidate',
    'falsifier', 'recovery_verifier',
  ],
  preference_policy: [
    'directive', 'modality', 'subject_scope', 'task_or_output_scope',
    'authority_source', 'override_policy', 'valid_from',
  ],
  fact: [
    'subject', 'predicate', 'object_or_value', 'qualifiers', 'valid_from',
    'source_evidence', 'contradiction_policy',
  ],
  strategy: [
    'decision_point', 'candidate_option', 'hard_constraint', 'decision_criterion',
    'tradeoff', 'stop_exploration_rule', 'escalation_rule', 'outcome_measure',
  ],
  causal: [
    'cause_or_intervention', 'effect_or_metric', 'applicability_condition',
    'mechanism', 'competing_explanation', 'evidence_link', 'falsifier',
    'causal_grade', 'allowed_use',
  ],
}

const OPTIONAL: Partial<Record<ExperienceKind, readonly ComponentRole[]>> = {
  preference_policy: ['positive_example', 'negative_example', 'exception', 'no_known_exception'],
}

function roleFor(kind: ExperienceKind, role: ComponentRole): BehaviorContribution['contributionRole'] {
  if (kind === 'preference_policy' || role === 'hard_constraint' || role === 'forbidden_condition') return 'constraint'
  if (kind === 'fact' || role === 'observed_fact') return 'fact'
  if (kind === 'causal' || role === 'hypothesis') return 'hypothesis'
  if (role.includes('verifier') || role === 'outcome_measure') return 'criterion'
  return 'instruction'
}

function behavior(kind: ExperienceKind): TypeBehavior {
  const requiredRoles = REQUIRED[kind]
  const optionalRoles = OPTIONAL[kind] ?? []
  const acceptedRoles = new Set([...requiredRoles, ...optionalRoles])
  return Object.freeze({
    kind,
    requiredRoles,
    optionalRoles,
    validate: (roles: ReadonlySet<ComponentRole>) => {
      const missing = requiredRoles.filter(role => !roles.has(role))
      if (kind === 'preference_policy') {
        if (!roles.has('positive_example') && !roles.has('negative_example')) missing.push('positive_example')
        if (!roles.has('exception') && !roles.has('no_known_exception')) missing.push('no_known_exception')
      }
      return missing
    },
    contribute: (role: ComponentRole, content: string) => {
      if (!acceptedRoles.has(role)) {
        throw new ExperienceError('wrong_experience_kind', `${role} is not valid for ${kind}`)
      }
      const requiredPriority = requiredRoles.indexOf(role)
      return {
        sourceRole: role,
        contributionRole: roleFor(kind, role),
        text: content,
        priority: requiredPriority === -1 ? requiredRoles.length : requiredPriority,
      }
    },
    contextSection: (contributions: readonly BehaviorContribution[]) => contributions
      .slice()
      .sort((a: BehaviorContribution, b: BehaviorContribution) =>
        a.priority - b.priority || a.sourceRole.localeCompare(b.sourceRole))
      .map((item: BehaviorContribution) => `${item.sourceRole}: ${item.text}`)
      .join('\n'),
    mandatoryCriteria: (contributions: readonly BehaviorContribution[]) => contributions
      .filter((item: BehaviorContribution) => item.contributionRole === 'criterion')
      .map((item: BehaviorContribution) => item.text),
    revisionHint: (failedRole: ComponentRole) => `revise:${kind}:${failedRole}`,
  })
}

/** Exhaustive first-party behavior registry. */
export const TYPE_BEHAVIORS: Readonly<Record<ExperienceKind, TypeBehavior>> = Object.freeze(
  Object.fromEntries(EXPERIENCE_KINDS.map(kind => [kind, behavior(kind)])) as Record<ExperienceKind, TypeBehavior>,
)

/** Throw if any compiler face drifts from the six-value owner. */
export function assertBehaviorParity(): void {
  const actual = Object.keys(TYPE_BEHAVIORS).sort()
  const expected = [...EXPERIENCE_KINDS].sort()
  if (actual.length !== expected.length || actual.some((kind, index) => kind !== expected[index])) {
    throw new Error('Experience Type Behavior registry does not match EXPERIENCE_KINDS')
  }
}
