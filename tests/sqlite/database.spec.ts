import { access, chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ExperienceDatabase, type DatabaseConfig } from '../../src/persistence/database.js'
import { ActorResolver } from '../../src/application/actor-resolver.js'
import {
  EXPERIENCE_DB_APPLICATION_ID,
  EXPERIENCE_DB_SCHEMA_VERSION,
  EXPERIENCE_DB_TABLES,
} from '../../src/persistence/schema.js'
import { ExperienceRepository } from '../../src/persistence/repository.js'
import { publishReviewedWorkflow } from '../fixtures/published-workflow.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('canonical Experience SQLite identity', () => {
  it('bootstraps the exact strict table set and preserves one stable local principal', async () => {
    const { directory, path } = await databasePath()
    const first = await ExperienceDatabase.open(config(path))
    const firstPrincipal = await new ExperienceRepository(first).initializePrincipal()
    expect(first.handle.prepare('PRAGMA application_id').get()).toEqual({ application_id: EXPERIENCE_DB_APPLICATION_ID })
    expect(first.handle.prepare('PRAGMA user_version').get()).toEqual({ user_version: EXPERIENCE_DB_SCHEMA_VERSION })
    const tables = (first.handle.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
    ).all() as Array<{ name: string }>).map(row => row.name)
    expect(tables).toEqual([...EXPERIENCE_DB_TABLES].sort())
    expect(tables).toContain('experience_relations')
    expect(tables.some(name => name.includes('governed_content') || name.includes('vault'))).toBe(false)
    await first.close()

    const second = await ExperienceDatabase.open(config(path))
    const secondPrincipal = await new ExperienceRepository(second).initializePrincipal()
    expect(secondPrincipal).toBe(firstPrincipal)
    await second.close()
    expect(directory).toContain('experience-map-test-')
  })

  it('rejects foreign, newer, unidentified non-empty, and unsafe database files', async () => {
    const foreign = await rawDatabase()
    foreign.database.exec('PRAGMA application_id = 1234')
    foreign.database.close()
    await expect(ExperienceDatabase.open(config(foreign.path))).rejects.toMatchObject({
      code: 'database_foreign_application',
    })

    const newer = await rawDatabase()
    newer.database.exec(`PRAGMA application_id = ${String(EXPERIENCE_DB_APPLICATION_ID)}`)
    newer.database.exec(`PRAGMA user_version = ${String(EXPERIENCE_DB_SCHEMA_VERSION + 1)}`)
    newer.database.close()
    await expect(ExperienceDatabase.open(config(newer.path))).rejects.toMatchObject({ code: 'database_newer_schema' })

    const unknown = await rawDatabase()
    unknown.database.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY) STRICT')
    unknown.database.close()
    await expect(ExperienceDatabase.open(config(unknown.path))).rejects.toMatchObject({ code: 'database_schema_invalid' })

    const unsafe = await rawDatabase()
    unsafe.database.close()
    await chmod(unsafe.path, 0o644)
    await expect(ExperienceDatabase.open(config(unsafe.path))).rejects.toMatchObject({
      code: 'database_permissions_unsafe',
    })
  })

  it('reports an external writer reservation as database_busy', async () => {
    const { path } = await databasePath()
    const database = await ExperienceDatabase.open(config(path, 1))
    const external = new DatabaseSync(path)
    external.exec('PRAGMA busy_timeout = 1')
    external.exec('BEGIN IMMEDIATE')
    try {
      await expect(database.write(() => 1)).rejects.toMatchObject({ code: 'database_busy' })
    } finally {
      external.exec('ROLLBACK')
      external.close()
      await database.close()
    }
  })

  it('rejects pre-release schema data without changing or backing it up', async () => {
    const { path } = await databasePath()
    const original = await ExperienceDatabase.open(config(path))
    const repository = new ExperienceRepository(original)
    const principal = await repository.initializePrincipal()
    const actor = new ActorResolver(principal).resolve({ kind: 'management-cli' })
    const { candidate, published: receipt } = await publishReviewedWorkflow(repository, actor)
    await original.close()
    injectLegacyEvidenceGradeReview(path, candidate.candidateId)
    downgradeToSchemaV1(path)

    await expect(ExperienceDatabase.open(config(path))).rejects.toMatchObject({ code: 'database_schema_invalid' })
    const unchanged = new DatabaseSync(path)
    expect(unchanged.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
    expect(unchanged.prepare('SELECT COUNT(*) AS count FROM candidates').get()).toEqual({ count: 1 })
    unchanged.close()
    await expect(access(`${path}.schema-v1.backup`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(receipt.experienceVersionId).not.toBeNull()
  })

  it('keeps malformed pre-release schema data untouched across retries', async () => {
    const { path } = await databasePath()
    const original = await ExperienceDatabase.open(config(path))
    const repository = new ExperienceRepository(original)
    const principal = await repository.initializePrincipal()
    const actor = new ActorResolver(principal).resolve({ kind: 'management-cli' })
    await publishReviewedWorkflow(repository, actor)
    await original.close()
    downgradeToSchemaV1(path)
    const broken = new DatabaseSync(path)
    broken.prepare("UPDATE candidates SET payload_json = json_set(payload_json, '$.proposedComponents', json('[]'))").run()
    broken.close()

    await expect(ExperienceDatabase.open(config(path))).rejects.toMatchObject({ code: 'database_schema_invalid' })
    const unchanged = new DatabaseSync(path)
    expect(unchanged.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
    unchanged.close()
    await expect(access(`${path}.schema-v1.backup`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(ExperienceDatabase.open(config(path))).rejects.toMatchObject({ code: 'database_schema_invalid' })
  })
})

function config(path: string, busyTimeoutMs = 50): DatabaseConfig {
  return { databasePath: path, journalMode: 'wal', synchronous: 'normal', busyTimeoutMs, maxPendingWrites: 8 }
}

async function databasePath(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'experience-map-test-'))
  cleanup.push(directory)
  return { directory, path: join(directory, 'experience.sqlite') }
}

async function rawDatabase(): Promise<{ path: string; database: DatabaseSync }> {
  const { path } = await databasePath()
  const database = new DatabaseSync(path)
  await chmod(path, 0o600)
  return { path, database }
}

function injectLegacyEvidenceGradeReview(path: string, candidateId: string): void {
  const database = new DatabaseSync(path)
  const row = database.prepare('SELECT payload_json FROM candidates WHERE candidate_id = ?')
    .get(candidateId) as { payload_json: string }
  const payload = JSON.parse(row.payload_json) as {
    proposedBy: string
    draft: { fieldSourceRefs: Record<string, string[]> }
    sourceRefs: Array<{ sourceRefId: string }>
    decisions: Array<Record<string, unknown>>
  }
  const decisionId = 'decision:legacy-evidence-grade'
  const sourceRefId = payload.sourceRefs[0]!.sourceRefId
  const decision = {
    field: 'evidenceGrade',
    decision: 'accept',
    reason: 'legacy_model_grade_review',
    decisionId,
    actorId: payload.proposedBy,
    decidedAt: '2026-08-31T09:09:00.000Z',
    supersedesDecisionId: null,
  }
  payload.draft.fieldSourceRefs.evidenceGrade = [sourceRefId]
  payload.decisions.push(decision)
  database.prepare('UPDATE candidates SET payload_json = ? WHERE candidate_id = ?')
    .run(JSON.stringify(payload), candidateId)
  database.prepare(
    `INSERT INTO candidate_field_decisions
      (decision_id, candidate_id, field_name, decision, value_json, actor_id, reason, decided_at,
       effective_source_refs_json, supersedes_decision_id)
     VALUES (?, ?, 'evidenceGrade', 'accept', NULL, ?, ?, ?, '[]', NULL)`,
  ).run(decisionId, candidateId, payload.proposedBy, decision.reason, decision.decidedAt)
  database.close()
}

function downgradeToSchemaV1(path: string): void {
  const database = new DatabaseSync(path)
  const candidates = database.prepare(
    'SELECT candidate_id, payload_json FROM candidates WHERE published_version_id IS NOT NULL',
  ).all() as Array<{ candidate_id: string; payload_json: string }>
  const updateCandidate = database.prepare('UPDATE candidates SET payload_json = ? WHERE candidate_id = ?')
  for (const row of candidates) {
    const payload = JSON.parse(row.payload_json) as {
      draft: { components: Array<{ role: string; content: string; sourceRefs: string[] }> }
      componentIds: string[]
      componentRevisionIds: string[]
      evidenceIds: string[]
    } & Record<string, unknown>
    updateCandidate.run(JSON.stringify({
      ...payload,
      proposedComponents: payload.draft.components.map((component, index) => ({
        semanticRole: component.role,
        content: component.content,
        sourceRefs: component.sourceRefs,
        componentId: payload.componentIds[index],
        componentRevisionId: payload.componentRevisionIds[index],
        evidenceIds: [payload.evidenceIds[index]],
      })),
    }), row.candidate_id)
  }
  database.exec('PRAGMA foreign_keys = OFF')
  database.exec('PRAGMA legacy_alter_table = ON')
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(`
      DROP TABLE forget_context_targets;
      DROP TABLE forget_step_results;
      DROP TABLE forget_tombstones;
      DROP TABLE forget_requests;

      DROP TABLE experience_version_components;

      ALTER TABLE experience_versions RENAME TO experience_versions_v2;
      CREATE TABLE experience_versions (
        experience_version_id TEXT PRIMARY KEY,
        experience_id TEXT NOT NULL REFERENCES experience_series(experience_id) DEFERRABLE INITIALLY DEFERRED,
        version_number INTEGER NOT NULL CHECK (version_number >= 1),
        previous_version_id TEXT REFERENCES experience_versions(experience_version_id),
        title TEXT NOT NULL,
        intent TEXT NOT NULL,
        scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
        privacy_class TEXT NOT NULL CHECK (privacy_class IN ('public','workspace','restricted','secret_reference_only')),
        allowed_use_modes_json TEXT NOT NULL CHECK (json_valid(allowed_use_modes_json)),
        evidence_grade TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        created_at TEXT NOT NULL,
        UNIQUE(experience_id, version_number),
        UNIQUE(experience_id, content_digest)
      ) STRICT;
      INSERT INTO experience_versions
        SELECT experience_version_id, experience_id, version_number, previous_version_id, title, intent,
               scope_json, privacy_class, allowed_use_modes_json, evidence_grade, content_digest, payload_json, created_at
          FROM experience_versions_v2;
      DROP TABLE experience_versions_v2;

      ALTER TABLE experience_components RENAME TO experience_components_v2;
      CREATE TABLE experience_components (
        component_id TEXT PRIMARY KEY,
        experience_id TEXT NOT NULL REFERENCES experience_series(experience_id),
        semantic_role TEXT NOT NULL,
        current_revision_id TEXT NOT NULL REFERENCES component_revisions(component_revision_id)
          DEFERRABLE INITIALLY DEFERRED,
        UNIQUE(experience_id, semantic_role)
      ) STRICT;
      INSERT INTO experience_components SELECT * FROM experience_components_v2;
      DROP TABLE experience_components_v2;

      ALTER TABLE evidence_statements RENAME TO evidence_statements_v2;
      CREATE TABLE evidence_statements (
        evidence_id TEXT PRIMARY KEY,
        claim_text TEXT NOT NULL,
        source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
        direction TEXT NOT NULL CHECK (direction IN ('supports','contradicts','qualifies'))
      ) STRICT;
      INSERT INTO evidence_statements
        SELECT evidence_id, claim_text, source_refs_json, direction FROM evidence_statements_v2;
      DROP TABLE evidence_statements_v2;

      ALTER TABLE domain_receipts RENAME TO domain_receipts_v2;
      CREATE TABLE domain_receipts (
        receipt_id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL UNIQUE,
        action TEXT NOT NULL,
        commit_sequence INTEGER NOT NULL UNIQUE,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO domain_receipts
        SELECT receipt_id, command_id, action, commit_sequence, payload_json, created_at FROM domain_receipts_v2;
      DROP TABLE domain_receipts_v2;

      ALTER TABLE audit_events RENAME TO audit_events_v2;
      CREATE TABLE audit_events (
        audit_id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        action TEXT NOT NULL,
        object_refs_json TEXT NOT NULL CHECK (json_valid(object_refs_json)),
        payload_digest TEXT NOT NULL,
        source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO audit_events
        SELECT audit_id, actor_id, command_id, action, object_refs_json, payload_digest,
               source_refs_json, created_at FROM audit_events_v2;
      DROP TABLE audit_events_v2;
      UPDATE evidence_assessments SET operational_state = 'active';
      UPDATE experience_versions
         SET payload_json = json_set(payload_json, '$.operationalState', 'active');
      PRAGMA user_version = 1;
    `)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  } finally {
    database.exec('PRAGMA legacy_alter_table = OFF')
    database.exec('PRAGMA foreign_keys = ON')
    database.close()
  }
}
