import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { brandedId } from '../../src/ids.js'
import type { ExperienceId, ExperienceVersionId } from '../../src/ids.js'
import type { ExperienceDatabase } from '../../src/persistence/database.js'
import type {
  ActorView,
  EpisodeRefView,
  ExperienceVersionView,
  PublishedComponentView,
  SourceRefView,
} from '../../src/types.js'
import type { ExperienceKind } from '../../src/domain/kind.js'
import type { ComponentRole } from '../../src/types.js'

/** Seed many versions directly into a temporary store without the O(N²) candidate publish path. */
export interface SeedVersionSpec {
  readonly kind?: ExperienceKind
  readonly title: string
  readonly intent: string
  readonly scope?: Readonly<Record<string, string>>
  readonly components: ReadonlyArray<{ role: ComponentRole; content: string }>
  readonly createdAt?: string
  readonly privacyClass?: 'workspace' | 'public'
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)]),
    )
  }
  return value
}

function digestPayloadFor(version: {
  readonly kind: ExperienceKind
  readonly title: string
  readonly intent: string
  readonly scope: Readonly<Record<string, string>>
  readonly validity: Readonly<Record<string, string>>
  readonly authoritySpec: Readonly<Record<string, string>>
  readonly privacyClass: 'workspace' | 'public' | 'restricted' | 'secret_reference_only'
  readonly riskAndEffectSpec: Readonly<Record<string, string>>
  readonly allowedUseModes: readonly string[]
  readonly sourceEpisodeRefs: readonly EpisodeRefView[]
  readonly sourceRefs: readonly SourceRefView[]
  readonly components: readonly PublishedComponentView[]
  readonly evidenceGrade:
    | 'model_asserted' | 'observation_supported' | 'mechanism_supported'
    | 'intervention_supported' | 'counterfactual_supported'
}): string {
  const components = version.components.map(component => ({
    componentKey: component.componentKey,
    role: component.role,
    content: component.content,
    sourceRefs: component.sourceRefs,
  }))
  return sha256(canonicalJson({
    contentDigestSchema: 'v2-source-bound',
    kind: version.kind,
    title: version.title,
    intent: version.intent,
    scope: version.scope,
    validity: version.validity,
    authoritySpec: version.authoritySpec,
    privacyClass: version.privacyClass,
    riskAndEffectSpec: version.riskAndEffectSpec,
    allowedUseModes: version.allowedUseModes,
    sourceEpisodeRefs: version.sourceEpisodeRefs,
    sourceRefs: version.sourceRefs,
    components,
    evidenceGrade: version.evidenceGrade,
  }))
}

interface SupersedeTarget {
  readonly experienceId: ExperienceId
  readonly versionNumber: number
  readonly previousVersionId: ExperienceVersionId
}

function insertStoredVersionRows(
  handle: DatabaseSync,
  actor: ActorView,
  spec: SeedVersionSpec,
  _ordinal: number,
  base?: SupersedeTarget,
): ExperienceVersionView {
  const now = spec.createdAt ?? new Date().toISOString()
  const seedTag = randomUUID()
  const experienceId = base?.experienceId ?? brandedId<'ExperienceId'>('seed-exp-' + seedTag, 'experienceId')
  const experienceVersionId = brandedId<'ExperienceVersionId'>('seed-ver-' + seedTag, 'versionId')
  const assessmentId = brandedId<'ExperienceAssessmentId'>('seed-assessment-' + experienceVersionId, 'assessmentId')
  const decisionId = 'seed-decision-' + experienceVersionId
  const kind = spec.kind ?? 'diagnostic'
  const episodeRef: EpisodeRefView = {
    episodeRefId: brandedId<'ExperienceEpisodeRefId'>('seed-episode-' + String(experienceVersionId), 'episodeRefId'),
    sourceSystem: 'dsh-session',
    sessionOrRunId: 'session-' + String(experienceVersionId),
    eventStart: 0,
    eventEnd: 1,
    occurredAt: { start: now, end: now },
    contentDigest: 'sha256:seed-episode',
    redactionState: 'bounded_excerpt',
  }
  const sourceRef: SourceRefView = {
    sourceRefId: brandedId<'ExperienceSourceRefId'>('seed-source-' + String(experienceVersionId), 'sourceRefId'),
    sourceSystem: 'dsh-session',
    sourceKind: 'tool_result',
    locator: 'dsh-session:' + seedFor(String(experienceVersionId)) + '#1',
    ownerScope: 'local_owner',
    accessScope: 'local_owner',
    occurredAt: now,
    observedAt: now,
    contentDigest: 'sha256:seed-source',
    redactionState: 'bounded_excerpt',
  }
  const components: PublishedComponentView[] = spec.components.map((component, index) => ({
    componentKey: `${component.role}-${index}`,
    componentId: brandedId<'ExperienceComponentId'>('seed-c-' + String(experienceVersionId) + '-' + index, 'componentId'),
    componentRevisionId: brandedId<'ExperienceComponentRevisionId'>('seed-r-' + String(experienceVersionId) + '-' + index, 'componentRevisionId'),
    evidenceIds: [brandedId<'ExperienceEvidenceId'>('seed-e-' + String(experienceVersionId) + '-' + index, 'evidenceId')],
    role: component.role,
    content: component.content,
    sourceRefs: [sourceRef.sourceRefId],
  }))
  const versionWithoutDigest = {
    experienceVersionId,
    experienceId,
    versionNumber: base === undefined ? 1 : base.versionNumber + 1,
    previousVersionId: base?.previousVersionId ?? null,
    kind,
    title: spec.title,
    intent: spec.intent,
    scope: spec.scope ?? { product: 'deepseek-harness', surface: 'web' },
    validity: { node: '>=22' },
    authoritySpec: { owner: 'local-user' },
    privacyClass: spec.privacyClass ?? 'workspace',
    riskAndEffectSpec: { risk: 'local-process' },
    allowedUseModes: ['reference', 'suggest', 'guided'],
    sourceEpisodeRefs: [episodeRef],
    sourceRefs: [sourceRef],
    components,
    componentRevisionIds: components.map(component => component.componentRevisionId),
    initialAssessmentId: assessmentId,
    relationIds: [],
    createdByDecisionId: decisionId,
    evidenceGrade: 'observation_supported',
    governanceState: 'accepted',
    operationalState: 'conditional',
    legacyWarnings: [],
    contentDigestSchema: 'v2-source-bound',
    createdAt: now,
  } as const
  const fullVersion: ExperienceVersionView = {
    ...versionWithoutDigest,
    contentDigest: digestPayloadFor(versionWithoutDigest),
  }

  const handleInsertVersion = (): void => {
    handle.prepare(
      `INSERT INTO experience_versions
         (experience_version_id, experience_id, version_number, previous_version_id, title, intent,
          scope_json, privacy_class, allowed_use_modes_json, evidence_grade, initial_assessment_id,
          created_by_decision_id, content_digest, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      experienceVersionId, experienceId, versionWithoutDigest.versionNumber, versionWithoutDigest.previousVersionId,
      spec.title, spec.intent,
      JSON.stringify(versionWithoutDigest.scope), versionWithoutDigest.privacyClass,
      JSON.stringify(versionWithoutDigest.allowedUseModes), versionWithoutDigest.evidenceGrade,
      assessmentId, decisionId, fullVersion.contentDigest, JSON.stringify(fullVersion), now,
    )
  }
  if (base === undefined) {
    handle.prepare(
      `INSERT INTO experience_series
         (experience_id, kind, current_version_id, series_revision, lifecycle_projection, created_at)
       VALUES (?, ?, ?, 1, 'active', ?)`,
    ).run(experienceId, kind, experienceVersionId, now)
    handleInsertVersion()
  } else {
    handleInsertVersion()
    const updated = handle.prepare(
      `UPDATE experience_series
          SET current_version_id = ?, series_revision = series_revision + 1
        WHERE experience_id = ?`,
    ).run(experienceVersionId, experienceId)
    if (updated.changes !== 1) throw new Error(`seed supersede failed for ${experienceId}`)
  }
  handle.prepare(
    `INSERT INTO governance_decisions (decision_id, actor_id, payload_json, created_at) VALUES (?, ?, ?, ?)`,
  ).run(decisionId, actor.actorId, JSON.stringify({
    subjectRef: experienceVersionId, decisionType: 'publish_candidate', outcome: 'accepted',
    authority: actor.authority, reasonCode: 'seed',
  }), now)
  const insertComponent = handle.prepare(
    `INSERT INTO experience_components (component_id, experience_id, semantic_role, current_revision_id) VALUES (?, ?, ?, ?)`,
  )
  const insertRevision = handle.prepare(
    `INSERT INTO component_revisions (component_revision_id, component_id, content_text, source_refs_json, created_at) VALUES (?, ?, ?, ?, ?)`,
  )
  const insertEvidence = handle.prepare(
    `INSERT INTO evidence_statements (evidence_id, component_revision_id, claim_text, source_refs_json, direction) VALUES (?, ?, ?, ?, 'supports')`,
  )
  const insertMembership = handle.prepare(
    `INSERT INTO experience_version_components (experience_version_id, ordinal, component_revision_id) VALUES (?, ?, ?)`,
  )
  const allEvidenceIds: string[] = []
  for (let index = 0; index < components.length; index++) {
    const component = components[index]!
    insertComponent.run(component.componentId, experienceId, component.role, component.componentRevisionId)
    insertRevision.run(component.componentRevisionId, component.componentId, component.content, JSON.stringify(component.sourceRefs), now)
    insertEvidence.run(component.evidenceIds[0]!, component.componentRevisionId, component.content, JSON.stringify(component.sourceRefs))
    insertMembership.run(experienceVersionId, index, component.componentRevisionId)
    allEvidenceIds.push(...component.evidenceIds)
  }
  handle.prepare(
    `INSERT INTO evidence_assessments
       (assessment_id, experience_version_id, grade, governance_state, operational_state,
        evidence_ids_json, decided_by, decided_at)
     VALUES (?, ?, ?, 'accepted', 'conditional', ?, ?, ?)`,
  ).run(assessmentId, experienceVersionId, versionWithoutDigest.evidenceGrade, JSON.stringify([...allEvidenceIds].sort()), actor.actorId, now)
  return fullVersion
}

/** Insert each spec as one active current Version inside one wrapped transaction. */
export async function seedVersions(
  database: ExperienceDatabase,
  actor: ActorView,
  specs: readonly SeedVersionSpec[],
): Promise<ExperienceVersionView[]> {
  return database.write(handle => specs.map((spec, index) => insertStoredVersionRows(handle, actor, spec, index)))
}

/** Insert a single active current Version. */
export async function seedVersion(
  database: ExperienceDatabase,
  actor: ActorView,
  spec: SeedVersionSpec,
): Promise<ExperienceVersionView> {
  const versions = await seedVersions(database, actor, [spec])
  return versions[0]!
}

/** Insert a NEWER version of the same Experience and make it the current one (supercedes base). */
export async function seedSupersedingVersion(
  database: ExperienceDatabase,
  actor: ActorView,
  base: ExperienceVersionView,
  spec: SeedVersionSpec,
): Promise<ExperienceVersionView> {
  const versions = await database.write(handle => [
    insertStoredVersionRows(handle, actor, spec, 0, {
      experienceId: base.experienceId,
      versionNumber: base.versionNumber,
      previousVersionId: base.experienceVersionId,
    }),
  ])
  return versions[0]!
}

function seedFor(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').slice(-10)
}
