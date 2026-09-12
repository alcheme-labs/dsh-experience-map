import type {
  ComponentRole,
  ExperienceRetrievalDocumentView,
  ExperienceVersionView,
  RetrievalSemanticFields,
  TaskFingerprintView,
} from '../types.js'
import { suggestionDigest } from './automatic-suggestion.js'

export const EXPERIENCE_RETRIEVAL_PROJECTOR_VERSION = 'experience-retrieval-projector-v2' as const

const MAX_DENSE_TEXT_CHARS = 2_048
const MAX_DENSE_HEADER_CHARS = 96
const MAX_DENSE_DETAIL_CHARS = 224

/** Small structural input shared by canonical Versions and the repository's read-only scan. */
export interface RetrievalProjectableVersion {
  readonly experienceVersionId: ExperienceVersionView['experienceVersionId']
  readonly experienceId: ExperienceVersionView['experienceId']
  readonly kind: ExperienceVersionView['kind']
  readonly title: string
  readonly intent: string
  readonly scope: Readonly<Record<string, string>>
  readonly validity: Readonly<Record<string, string>>
  readonly riskAndEffectSpec: Readonly<Record<string, string>>
  readonly contentDigest: string
  readonly components: readonly Pick<ExperienceVersionView['components'][number], 'role' | 'content'>[]
}

/** Query-side projection with the exact same field vocabulary as Version documents. */
export interface RetrievalTaskQueryView {
  readonly projectionVersion: typeof EXPERIENCE_RETRIEVAL_PROJECTOR_VERSION
  readonly fields: RetrievalSemanticFields
  readonly lexicalText: string
  readonly denseText: string
  readonly contentDigest: string
}

/** Project one active canonical Version into stable lexical and dense text views. */
export function projectExperienceVersion(version: RetrievalProjectableVersion): ExperienceRetrievalDocumentView {
  const components = new Map<ComponentRole, string[]>()
  for (const component of version.components) {
    const values = components.get(component.role) ?? []
    values.push(component.content)
    components.set(component.role, values)
  }
  const fields: RetrievalSemanticFields = {
    kind: [version.kind],
    taskFamily: compact([version.scope.taskFamily, ...roleValues(components, taskFamilyRoles(version.kind))]),
    goalOrIntent: compact([
      version.title,
      version.intent,
      ...roleValues(components, ['goal_signature', 'symptom_signature', 'directive', 'decision_point', 'effect_or_metric']),
    ]),
    scope: recordValues(version.scope),
    capabilitiesOrTools: roleValues(components, [
      'step', 'environment_adapter', 'resolution_candidate', 'branch', 'candidate_option', 'mechanism',
    ]),
    artifactsOrEntities: roleValues(components, [
      'subject', 'predicate', 'object_or_value', 'subject_scope', 'task_or_output_scope',
    ]),
    environment: roleValues(components, [
      'environment_scope', 'environment_adapter', 'entry_condition', 'applicability_condition',
    ]),
    validity: [...recordValues(version.validity), ...roleValues(components, ['valid_from', 'contradiction_policy'])],
    risk: [
      ...recordValues(version.riskAndEffectSpec),
      ...roleValues(components, ['forbidden_condition', 'side_effect_policy', 'failure_branch', 'override_policy']),
    ],
    typeSpecific: version.components.map(component => `${component.role}: ${component.content}`),
  }
  return retrievalDocument(version, fields)
}

/** Project one canonical task fingerprint through the same field names and ordering. */
export function projectTaskFingerprint(fingerprint: TaskFingerprintView): RetrievalTaskQueryView {
  const fields: RetrievalSemanticFields = {
    kind: [],
    taskFamily: compact([fingerprint.taskFamily]),
    goalOrIntent: compact([fingerprint.intent, fingerprint.taskText]),
    scope: compact([`actor: ${fingerprint.actorRef}`]),
    capabilitiesOrTools: compact(fingerprint.capabilities),
    artifactsOrEntities: compact([...fingerprint.artifactKinds, ...fingerprint.entities, ...fingerprint.expectedOutputs]),
    environment: compact(fingerprint.environmentRefs),
    validity: [],
    risk: [],
    typeSpecific: [],
  }
  const views = renderViews(fields)
  return {
    projectionVersion: EXPERIENCE_RETRIEVAL_PROJECTOR_VERSION,
    fields,
    ...views,
    contentDigest: suggestionDigest({ projectionVersion: EXPERIENCE_RETRIEVAL_PROJECTOR_VERSION, fields, views }),
  }
}

function retrievalDocument(
  version: RetrievalProjectableVersion,
  fields: RetrievalSemanticFields,
): ExperienceRetrievalDocumentView {
  const views = renderViews(fields)
  const contentDigest = suggestionDigest({
    projectionVersion: EXPERIENCE_RETRIEVAL_PROJECTOR_VERSION,
    experienceVersionId: version.experienceVersionId,
    versionContentDigest: version.contentDigest,
    fields,
    views,
  })
  return {
    documentId: `retrieval-document:${version.experienceVersionId}:${contentDigest.slice('sha256:'.length)}`,
    experienceId: version.experienceId,
    experienceVersionId: version.experienceVersionId,
    versionContentDigest: version.contentDigest,
    kind: version.kind,
    projectionVersion: EXPERIENCE_RETRIEVAL_PROJECTOR_VERSION,
    fields,
    ...views,
    contentDigest,
  }
}

function renderViews(fields: RetrievalSemanticFields): { readonly lexicalText: string; readonly denseText: string } {
  const entries = Object.entries(fields) as Array<[keyof RetrievalSemanticFields, readonly string[]]>
  const lines = entries.flatMap(([field, values]) => values.map(value => `${field}: ${value}`))
  const lexicalText = lines.join('\n')
  const typed = fields.typeSpecific.map(parseTypedValue).filter(value => value !== null)
  const roleValues = (roles: readonly ComponentRole[]) => typed
    .filter((value): value is { readonly role: ComponentRole; readonly content: string } =>
      value !== null && roles.includes(value.role))
    .map(value => value.content)
  const buckets = [
    ['goalOrIntent', [
      ...fields.goalOrIntent,
      ...roleValues(['goal_signature', 'symptom_signature', 'directive', 'subject', 'decision_point',
        'cause_or_intervention', 'effect_or_metric']),
    ]],
    ['taskFamily', fields.taskFamily],
    ['kind', fields.kind],
    ['environmentOrFailure', [
      ...fields.environment,
      ...fields.risk,
      ...roleValues(['entry_condition', 'forbidden_condition', 'environment_scope', 'failure_branch',
        'discriminator', 'falsifier', 'applicability_condition']),
    ]],
    ['capabilitiesOrTools', [
      ...fields.capabilitiesOrTools,
      ...roleValues(['step', 'branch', 'resolution_candidate', 'candidate_option', 'mechanism']),
    ]],
    ['verifier', roleValues(['checkpoint', 'verifier', 'recovery_verifier', 'outcome_measure'])],
    ['artifactsOrEntities', fields.artifactsOrEntities],
    ['scope', fields.scope],
    ['validity', fields.validity],
  ] as const satisfies readonly (readonly [string, readonly string[]])[]
  const seen = new Set<string>()
  const assigned = buckets.map(([label, values]) => [label, compact(values.map(normalizeDenseValue)).filter(value => {
    if (seen.has(value)) return false
    seen.add(value)
    return true
  })] as const)
  // A compact operational header guarantees every critical facet precedes optional detail.
  const headers = assigned.map(([label, values]) => denseHeader(label, values))
    .filter((line): line is string => line !== null)
  const details = assigned.map(([label, values]) => denseDetail(label, values.slice(1)))
    .filter((line): line is string => line !== null)
  const denseLines = [...headers, ...details]
  return { lexicalText, denseText: boundedDense(denseLines.join('\n')) }
}

function denseHeader(label: string, values: readonly string[]): string | null {
  const selected = values[0]
  if (selected === undefined) return null
  return boundedDenseLine(label, selected, MAX_DENSE_HEADER_CHARS)
}

function denseDetail(label: string, values: readonly string[]): string | null {
  if (values.length === 0) return null
  return boundedDenseLine(label, values.join(' · '), MAX_DENSE_DETAIL_CHARS)
}

function boundedDenseLine(label: string, content: string, maxChars: number): string {
  const prefix = `${label}: `
  const available = Math.max(1, maxChars - prefix.length)
  return `${prefix}${content.length <= available ? content : `${content.slice(0, available - 1)}…`}`
}

function boundedDense(value: string): string {
  return value.length <= MAX_DENSE_TEXT_CHARS ? value : `${value.slice(0, MAX_DENSE_TEXT_CHARS - 1)}…`
}

function normalizeSemanticText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

function normalizeDenseValue(value: string): string {
  return normalizeSemanticText(value).replace(/^[a-z][a-z_]*:\s*/u, '')
}

function parseTypedValue(value: string): { readonly role: ComponentRole; readonly content: string } | null {
  const separator = value.indexOf(':')
  if (separator < 1) return null
  const role = value.slice(0, separator) as ComponentRole
  const content = value.slice(separator + 1).trim()
  return content === '' ? null : { role, content }
}

function roleValues(
  components: ReadonlyMap<ComponentRole, readonly string[]>,
  roles: readonly ComponentRole[],
): string[] {
  return compact(roles.flatMap(role => components.get(role) ?? []))
}

function taskFamilyRoles(kind: RetrievalProjectableVersion['kind']): readonly ComponentRole[] {
  switch (kind) {
    case 'procedure': return ['goal_signature']
    case 'diagnostic': return ['symptom_signature']
    case 'preference_policy': return ['task_or_output_scope']
    case 'fact': return ['subject', 'predicate']
    case 'strategy': return ['decision_point']
    case 'causal': return ['cause_or_intervention', 'effect_or_metric']
  }
}

function recordValues(record: Readonly<Record<string, string>>): string[] {
  return Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}: ${value}`)
}

function compact(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined && value.trim() !== ''))]
}
