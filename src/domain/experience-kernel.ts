import type { ComponentRole, ExperienceComponentInput, ExperienceVersionView } from '../types.js'
import type { ExperienceKind } from './kind.js'
import { suggestionDigest } from './automatic-suggestion.js'

/** Shared exact-identity schema used by suggestion grouping and canonical publication. */
export const EXPERIENCE_KERNEL_IDENTITY_VERSION = 'experience-kernel-identity-v2'

export interface ExperienceKernelSource {
  readonly kind: ExperienceKind
  readonly scope: Readonly<Record<string, string>>
  readonly components: readonly Pick<ExperienceComponentInput, 'componentKey' | 'role' | 'content'>[]
}

export interface ExperienceKernelProjection {
  readonly schemaVersion: typeof EXPERIENCE_KERNEL_IDENTITY_VERSION
  readonly kind: ExperienceKind
  readonly scopeKey: string
  readonly scope: Readonly<Record<string, string>>
  readonly taskFamilyKey: string
  readonly typeSpecific: Readonly<Record<string, readonly string[]>>
}

const COMPONENT_IDENTITY_CLASS = {
  goal_signature: 'series', entry_condition: 'series', forbidden_condition: 'series',
  parameter: 'comparison', environment_adapter: 'comparison', step: 'series', checkpoint: 'series',
  side_effect_policy: 'comparison', failure_branch: 'comparison', verifier: 'series',
  symptom_signature: 'series', environment_scope: 'series', observed_fact: 'comparison',
  hypothesis: 'comparison', discriminator: 'series', misleading_signal: 'comparison', branch: 'series',
  resolution_candidate: 'series', falsifier: 'comparison', recovery_verifier: 'series',
  directive: 'series', modality: 'series', subject_scope: 'series', task_or_output_scope: 'series',
  authority_source: 'comparison', override_policy: 'comparison', positive_example: 'comparison',
  negative_example: 'comparison', exception: 'comparison', no_known_exception: 'comparison',
  valid_from: 'series', subject: 'series', predicate: 'series', object_or_value: 'comparison',
  qualifiers: 'comparison', source_evidence: 'grounding_only', contradiction_policy: 'comparison',
  decision_point: 'series', candidate_option: 'comparison', hard_constraint: 'series',
  decision_criterion: 'comparison', tradeoff: 'comparison', stop_exploration_rule: 'comparison',
  escalation_rule: 'comparison', outcome_measure: 'series', cause_or_intervention: 'series',
  effect_or_metric: 'series', applicability_condition: 'series', mechanism: 'comparison',
  competing_explanation: 'comparison', evidence_link: 'grounding_only', causal_grade: 'comparison',
  allowed_use: 'comparison',
} as const satisfies Readonly<Record<ComponentRole, 'series' | 'comparison' | 'grounding_only'>>

/** Shared classification used by exact identity and source-grounding projection. */
export function experienceComponentIdentityClass(
  role: ComponentRole,
): 'series' | 'comparison' | 'grounding_only' {
  return COMPONENT_IDENTITY_CLASS[role]
}

/** Project the exact stable kernel without title wording, source timestamps, or model scores. */
export function projectExperienceKernel(source: ExperienceKernelSource): ExperienceKernelProjection {
  const taskFamilyKey = normalizeKernelText(source.scope.taskFamily
    ?? firstRole(source.components, taskFamilyRole(source.kind))
    ?? '')
  const scopeKey = normalizeKernelText(
    source.scope.workspaceRoot ?? source.scope.workspace ?? source.scope.environment ?? 'local_owner',
  )
  return {
    schemaVersion: EXPERIENCE_KERNEL_IDENTITY_VERSION,
    kind: source.kind,
    scopeKey,
    scope: normalizedScope(source.scope),
    taskFamilyKey,
    typeSpecific: typeSpecificKernel(source.kind, source.components),
  }
}

/** Hash the shared deterministic kernel. Similarity is intentionally never an exact identity input. */
export function experienceKernelIdentity(source: ExperienceKernelSource): string {
  return suggestionDigest(projectExperienceKernel(source))
}

/** Compare the hard owner/environment scope shared by equivalence projection and its commit guard. */
export function experienceHardScopeMatches(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const stable = (scope: Readonly<Record<string, string>>) => Object.entries(scope)
    .filter(([key]) => key !== 'taskFamily')
    .map(([key, value]) => `${normalizeKernelText(key)}: ${normalizeKernelText(value)}`)
    .sort()
  const candidate = stable(left)
  const existing = stable(right)
  return candidate.length === existing.length
    && candidate.every((value, index) => value === existing[index])
}

/** Digest the active comparison set shown to an equivalence decision before canonical commit. */
export function experienceComparisonSetDigest(
  source: Pick<ExperienceKernelSource, 'kind' | 'scope'>,
  versions: readonly ExperienceVersionView[],
): string {
  return suggestionDigest(versions.filter(version => version.kind === source.kind
    && experienceHardScopeMatches(source.scope, version.scope))
    .map(version => ({
      experienceVersionId: version.experienceVersionId,
      contentDigest: version.contentDigest,
      kernelIdentity: experienceKernelIdentity({
        kind: version.kind,
        scope: version.scope,
        components: version.components,
      }),
    }))
    .sort((left, right) => left.experienceVersionId.localeCompare(right.experienceVersionId)))
}

/** Stable normalization shared by write-side and read-side projection. */
export function normalizeKernelText(value: string): string {
  return value.normalize('NFKC')
    .replace(/[\t\n\r ]+/gu, ' ')
    .trim()
}

function normalizedScope(scope: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(scope)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [normalizeKernelText(key), normalizeKernelText(value)]))
}

function typeSpecificKernel(
  kind: ExperienceKind,
  components: ExperienceKernelSource['components'],
): Readonly<Record<string, readonly string[]>> {
  switch (kind) {
    case 'procedure': return {
      goal: roleValues(components, ['goal_signature']),
      prerequisites: roleValues(components, ['entry_condition', 'forbidden_condition']),
      orderedActions: roleValues(components, ['step'], true),
      outcome: roleValues(components, ['checkpoint']),
      verifier: roleValues(components, ['verifier']),
    }
    case 'diagnostic': return {
      symptom: roleValues(components, ['symptom_signature']),
      environment: roleValues(components, ['environment_scope']),
      discriminator: roleValues(components, ['discriminator']),
      resolution: roleValues(components, ['resolution_candidate', 'branch'], true),
      verifier: roleValues(components, ['recovery_verifier']),
    }
    case 'preference_policy': return {
      directive: roleValues(components, ['directive', 'modality']),
      subject: roleValues(components, ['subject_scope']),
      taskOrOutput: roleValues(components, ['task_or_output_scope']),
    }
    case 'fact': return {
      subjectPredicate: roleValues(components, ['subject', 'predicate']),
      validityGeneration: roleValues(components, ['valid_from']),
    }
    case 'strategy': return {
      decisionPoint: roleValues(components, ['decision_point']),
      hardConstraints: roleValues(components, ['hard_constraint']),
      outcomeMeasure: roleValues(components, ['outcome_measure']),
    }
    case 'causal': return {
      intervention: roleValues(components, ['cause_or_intervention']),
      effect: roleValues(components, ['effect_or_metric']),
      applicability: roleValues(components, ['applicability_condition']),
    }
  }
}

function taskFamilyRole(kind: ExperienceKind): ComponentRole {
  switch (kind) {
    case 'procedure': return 'goal_signature'
    case 'diagnostic': return 'symptom_signature'
    case 'preference_policy': return 'task_or_output_scope'
    case 'fact': return 'subject'
    case 'strategy': return 'decision_point'
    case 'causal': return 'effect_or_metric'
  }
}

function firstRole(
  components: ExperienceKernelSource['components'],
  role: ComponentRole,
): string | undefined {
  return components.find(component => component.role === role)?.content
}

function roleValues(
  components: ExperienceKernelSource['components'],
  roles: readonly ComponentRole[],
  ordered = false,
): string[] {
  const order = new Map(roles.map((role, index) => [role, index]))
  const ordinals = new Map<ComponentRole, number>()
  const values = components
    .filter(component => order.has(component.role) && experienceComponentIdentityClass(component.role) === 'series')
    .map(component => ({
      roleOrder: order.get(component.role)!,
      ordinal: (() => {
        const value = ordinals.get(component.role) ?? 0
        ordinals.set(component.role, value + 1)
        return value
      })(),
      role: component.role,
      value: normalizeKernelText(component.content),
    }))
    .filter(item => item.value !== '')
  if (!ordered) values.sort((left, right) => left.roleOrder - right.roleOrder
    || left.value.localeCompare(right.value))
  return [...new Set(values.map(item => ordered
    ? JSON.stringify({
      role: item.role,
      ordinal: item.ordinal,
      value: item.value,
    })
    : JSON.stringify({ role: item.role, value: item.value })))]
}
