import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { ExperienceError } from './errors.js'

/** Assert canonical relationships that SQLite foreign keys alone cannot express. */
export function assertExperienceStoreInvariants(handle: DatabaseSync): void {
  const principalCount = scalarCount(handle, 'SELECT COUNT(*) AS count FROM local_owner_principals')
  if (principalCount !== 1) fail('Experience Store must contain exactly one LocalOwnerPrincipal')

  const publishedWithoutVersion = scalarCount(handle, `
    SELECT COUNT(*) AS count FROM candidates c
      LEFT JOIN experience_versions v ON v.experience_version_id = c.published_version_id
     WHERE c.state = 'published' AND v.experience_version_id IS NULL
  `)
  if (publishedWithoutVersion !== 0) fail('published Candidate lacks its immutable Version')

  const versionWithoutComponents = scalarCount(handle, `
    SELECT COUNT(*) AS count FROM experience_versions v
      LEFT JOIN experience_version_components vc
        ON vc.experience_version_id = v.experience_version_id
     WHERE vc.experience_version_id IS NULL
  `)
  if (versionWithoutComponents !== 0) fail('ExperienceVersion lacks exact ComponentRevision membership')

  const mismatchedAssessment = scalarCount(handle, `
    SELECT COUNT(*) AS count FROM experience_versions v
      LEFT JOIN evidence_assessments a ON a.assessment_id = v.initial_assessment_id
     WHERE a.assessment_id IS NULL OR a.experience_version_id <> v.experience_version_id
  `)
  if (mismatchedAssessment !== 0) fail('ExperienceVersion initial EvidenceAssessment is inconsistent')

  const versions = handle.prepare(
    'SELECT experience_version_id FROM experience_versions ORDER BY experience_version_id',
  ).all() as Array<{ experience_version_id: string }>
  for (const version of versions) assertStoredVersionConsistency(handle, version.experience_version_id)

  const broken = handle.prepare('PRAGMA foreign_key_check').all()
  if (broken.length > 0) fail('Experience Store contains broken foreign keys')
}

/** Reject divergence between one immutable Version snapshot and its normalized records. */
export function assertStoredVersionConsistency(handle: DatabaseSync, versionId: string): void {
  const row = handle.prepare(`
    SELECT v.experience_version_id, v.experience_id, v.version_number, v.title, v.intent,
           v.scope_json, v.privacy_class, v.allowed_use_modes_json, v.evidence_grade,
           v.initial_assessment_id, v.created_by_decision_id, v.content_digest,
           v.payload_json, v.created_at, s.kind,
           a.grade AS assessment_grade, a.governance_state, a.operational_state,
           a.evidence_ids_json
      FROM experience_versions v
      JOIN experience_series s ON s.experience_id = v.experience_id
      JOIN evidence_assessments a ON a.assessment_id = v.initial_assessment_id
     WHERE v.experience_version_id = ?
  `).get(versionId) as StoredVersionRow | undefined
  if (row === undefined) fail('ExperienceVersion canonical records are incomplete')

  const value = jsonObject(row.payload_json, 'ExperienceVersion payload')
  const components = value.components
  const componentRevisionIds = value.componentRevisionIds
  if (!Array.isArray(components) || !isStringArray(componentRevisionIds)) {
    fail('ExperienceVersion component snapshot is invalid')
  }
  if (value.experienceVersionId !== row.experience_version_id
    || value.experienceId !== row.experience_id
    || value.versionNumber !== row.version_number
    || value.kind !== row.kind
    || value.title !== row.title
    || value.intent !== row.intent
    || !jsonEquals(value.scope, jsonValue(row.scope_json, 'ExperienceVersion scope'))
    || value.privacyClass !== row.privacy_class
    || !jsonEquals(value.allowedUseModes, jsonValue(row.allowed_use_modes_json, 'ExperienceVersion use modes'))
    || value.evidenceGrade !== row.evidence_grade
    || value.evidenceGrade !== row.assessment_grade
    || value.initialAssessmentId !== row.initial_assessment_id
    || value.createdByDecisionId !== row.created_by_decision_id
    || value.contentDigest !== row.content_digest
    || value.createdAt !== row.created_at
    || value.governanceState !== row.governance_state
    || value.operationalState !== row.operational_state) {
    fail('ExperienceVersion snapshot diverges from canonical records')
  }

  const stored = handle.prepare(`
    SELECT vc.ordinal, r.component_revision_id, r.component_id, r.content_text,
           r.source_refs_json, c.experience_id, c.semantic_role
      FROM experience_version_components vc
      JOIN component_revisions r ON r.component_revision_id = vc.component_revision_id
      JOIN experience_components c ON c.component_id = r.component_id
     WHERE vc.experience_version_id = ?
     ORDER BY vc.ordinal
  `).all(versionId) as unknown as StoredComponentRow[]
  if (stored.length !== components.length || stored.length !== componentRevisionIds.length) {
    fail('ExperienceVersion component snapshot has inconsistent membership')
  }

  const allEvidenceIds: string[] = []
  const digestComponents: Array<Record<string, unknown>> = []
  for (let index = 0; index < stored.length; index++) {
    const component = objectValue(components[index], 'ExperienceVersion component')
    const persisted = stored[index]!
    const sourceRefs = jsonValue(persisted.source_refs_json, 'ComponentRevision source refs')
    const evidenceIds = component.evidenceIds
    if (persisted.ordinal !== index
      || persisted.experience_id !== row.experience_id
      || component.componentId !== persisted.component_id
      || component.componentRevisionId !== persisted.component_revision_id
      || componentRevisionIds[index] !== persisted.component_revision_id
      || component.role !== persisted.semantic_role
      || component.content !== persisted.content_text
      || !jsonEquals(component.sourceRefs, sourceRefs)
      || typeof component.componentKey !== 'string'
      || !isStringArray(evidenceIds)) {
      fail('ExperienceVersion component snapshot diverges from canonical records')
    }
    const persistedEvidenceIds = (handle.prepare(
      'SELECT evidence_id FROM evidence_statements WHERE component_revision_id = ? ORDER BY evidence_id',
    ).all(persisted.component_revision_id) as Array<{ evidence_id: string }>).map(item => item.evidence_id)
    if (!isStringArray(evidenceIds)
      || evidenceIds.some(evidenceId => !persistedEvidenceIds.includes(evidenceId))) {
      fail('ExperienceVersion initial evidence is missing from canonical records')
    }
    // Version JSON and its initial assessment are immutable creation snapshots.
    // Later EvidenceStatements and Assessments are append-only canonical facts.
    allEvidenceIds.push(...evidenceIds)
    digestComponents.push({
      componentKey: component.componentKey,
      role: component.role,
      content: component.content,
      sourceRefs,
    })
  }

  const assessedEvidenceIds = jsonValue(row.evidence_ids_json, 'EvidenceAssessment evidence ids')
  if (!isStringArray(assessedEvidenceIds) || !sameStringSet(assessedEvidenceIds, allEvidenceIds)) {
    fail('ExperienceVersion EvidenceAssessment membership is inconsistent')
  }
  const digestPayload: Record<string, unknown> = {
    kind: value.kind,
    title: value.title,
    intent: value.intent,
    scope: value.scope,
    validity: value.validity,
    authoritySpec: value.authoritySpec,
    privacyClass: value.privacyClass,
    riskAndEffectSpec: value.riskAndEffectSpec,
    allowedUseModes: value.allowedUseModes,
    components: digestComponents,
    evidenceGrade: value.evidenceGrade,
  }
  if (value.contentDigestSchema === 'v2-source-bound') {
    if (!Array.isArray(value.sourceEpisodeRefs) || value.sourceEpisodeRefs.length === 0
      || !Array.isArray(value.sourceRefs) || value.sourceRefs.length === 0) {
      fail('source-bound ExperienceVersion lacks exact source references')
    }
    digestPayload.contentDigestSchema = value.contentDigestSchema
    digestPayload.sourceEpisodeRefs = value.sourceEpisodeRefs
    digestPayload.sourceRefs = value.sourceRefs
  }
  const computedDigest = sha256(canonicalJson(digestPayload))
  if (computedDigest !== row.content_digest) fail('ExperienceVersion content digest is inconsistent')
}

interface StoredVersionRow {
  readonly experience_version_id: string
  readonly experience_id: string
  readonly version_number: number
  readonly title: string
  readonly intent: string
  readonly scope_json: string
  readonly privacy_class: string
  readonly allowed_use_modes_json: string
  readonly evidence_grade: string
  readonly initial_assessment_id: string
  readonly created_by_decision_id: string
  readonly content_digest: string
  readonly payload_json: string
  readonly created_at: string
  readonly kind: string
  readonly assessment_grade: string
  readonly governance_state: string
  readonly operational_state: string
  readonly evidence_ids_json: string
}

interface StoredComponentRow {
  readonly ordinal: number
  readonly component_revision_id: string
  readonly component_id: string
  readonly content_text: string
  readonly source_refs_json: string
  readonly experience_id: string
  readonly semantic_role: string
}

function scalarCount(handle: DatabaseSync, sql: string): number {
  const row = handle.prepare(sql).get() as { count: number }
  return row.count
}

function jsonValue(json: string, label: string): unknown {
  try {
    return JSON.parse(json) as unknown
  } catch (error) {
    throw new ExperienceError('database_schema_invalid', `${label} is invalid JSON`, {}, { cause: error })
  }
}

function jsonObject(json: string, label: string): Record<string, unknown> {
  return objectValue(jsonValue(json, label), label)
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} is not an object`)
  }
  return value as Record<string, unknown>
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((value, index) => value === sortedRight[index])
}

function jsonEquals(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]))
  }
  return value
}

function fail(message: string): never {
  throw new ExperienceError('database_schema_invalid', message)
}
