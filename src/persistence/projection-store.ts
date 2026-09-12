import { randomUUID } from 'node:crypto'
import { access, mkdir, open, rename, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { suggestionDigest } from '../domain/automatic-suggestion.js'
import {
  suggestionDecisionDigests,
  suggestionSaveEligibility,
  suggestionSourceGroupIds,
} from '../domain/suggestion-materializer.js'
import { ExperienceError } from '../errors.js'
import type { ActorId } from '../ids.js'
import type {
  DismissExperienceSuggestionInput,
  ExperienceSuggestionGroupView,
  ExperienceSuggestionSeedView,
  ExperienceRetrievalDocumentView,
  ExperienceRetrievalManifestView,
  ExperienceRetrievalProjectionView,
  SaveExperienceSuggestionInput,
  SessionSuggestionScanView,
  SuggestionDispositionProjectionView,
  SuggestionSaveDomainReceipt,
  SuggestionProjectionReceiptView,
  SuggestionProjectionView,
} from '../types.js'

/** Separate application id for the disposable projection sidecar (“EXPS”). */
export const SUGGESTION_PROJECTION_APPLICATION_ID = 0x45585053
export const SUGGESTION_PROJECTION_STORAGE_SCHEMA_VERSION = 5
export const SUGGESTION_PROJECTION_VIEW_SCHEMA_VERSION = 5
/** Backward-compatible name for the physical SQLite schema owner. */
export const SUGGESTION_PROJECTION_SCHEMA_VERSION = SUGGESTION_PROJECTION_STORAGE_SCHEMA_VERSION
export const SUGGESTION_PROJECTION_KEY = 'experience-suggestions-v1' as const
export const EXPERIENCE_RETRIEVAL_PROJECTION_KEY = 'experience-retrieval-v1' as const

const TABLES = [
  'projection_generations',
  'projection_metadata',
  'projection_receipts',
  'retrieval_documents',
  'retrieval_generations',
  'retrieval_metadata',
  'suggestion_dispositions',
  'suggestion_groups',
  'session_scans',
  'suggestion_seeds',
] as const

class ProjectionStoreInvalidError extends Error {}

const SCHEMA = `
  CREATE TABLE projection_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    active_generation INTEGER NOT NULL CHECK (active_generation >= 0),
    previous_generation INTEGER CHECK (previous_generation IS NULL OR previous_generation >= 0),
    degraded_reason TEXT CHECK (degraded_reason IS NULL OR degraded_reason IN ('source_unavailable','recovered_from_corruption')),
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE projection_generations (
    generation INTEGER PRIMARY KEY CHECK (generation >= 0),
    projector_version TEXT NOT NULL,
    source_watermark_digest TEXT NOT NULL,
    content_digest TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE session_scans (
    generation INTEGER NOT NULL REFERENCES projection_generations(generation) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    PRIMARY KEY (generation, session_id)
  ) STRICT;

  CREATE TABLE suggestion_seeds (
    generation INTEGER NOT NULL REFERENCES projection_generations(generation) ON DELETE CASCADE,
    occurrence_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    PRIMARY KEY (generation, occurrence_id),
    FOREIGN KEY (generation, session_id) REFERENCES session_scans(generation, session_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE suggestion_groups (
    generation INTEGER NOT NULL REFERENCES projection_generations(generation) ON DELETE CASCADE,
    group_id TEXT NOT NULL,
    kernel_identity TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    PRIMARY KEY (generation, group_id)
  ) STRICT;

  CREATE TABLE suggestion_dispositions (
    group_id TEXT PRIMARY KEY,
    kernel_identity TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('dismissed','saved_new_experience','attached_as_evidence')),
    command_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    scope_digest TEXT NOT NULL,
    occurrence_ids_json TEXT NOT NULL CHECK (json_valid(occurrence_ids_json)),
    input_digest TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    projection_receipt_id TEXT NOT NULL,
    target_ref TEXT
  ) STRICT;

  CREATE TABLE projection_receipts (
    receipt_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('activated','unchanged','failed','dismissed','saved')),
    generation INTEGER NOT NULL CHECK (generation >= 0),
    source_watermark_digest TEXT NOT NULL,
    processed_session_count INTEGER NOT NULL CHECK (processed_session_count >= 0),
    occurrence_count INTEGER NOT NULL CHECK (occurrence_count >= 0),
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE retrieval_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    active_generation INTEGER NOT NULL CHECK (active_generation >= 0),
    previous_generation INTEGER CHECK (previous_generation IS NULL OR previous_generation >= 0),
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE retrieval_generations (
    generation INTEGER PRIMARY KEY CHECK (generation >= 0),
    content_digest TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE retrieval_documents (
    generation INTEGER NOT NULL REFERENCES retrieval_generations(generation) ON DELETE CASCADE,
    document_id TEXT NOT NULL,
    experience_version_id TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    vector_json TEXT CHECK (vector_json IS NULL OR json_valid(vector_json)),
    PRIMARY KEY (generation, document_id),
    UNIQUE (generation, experience_version_id)
  ) STRICT;
`

/** Atomic input produced by one recent-Session reconciliation. */
export interface SuggestionProjectionBuild {
  readonly projectorVersion: string
  readonly sourceWatermarkDigest: string
  readonly sessions: readonly SessionSuggestionScanView[]
  readonly seeds: readonly ExperienceSuggestionSeedView[]
  readonly groups: readonly ExperienceSuggestionGroupView[]
  readonly startedAt: string
  readonly completedAt: string
}

/** Complete lexical/dense snapshot prepared outside the sidecar transaction. */
export interface RetrievalProjectionBuild {
  readonly projectionVersion: ExperienceRetrievalManifestView['projectionVersion']
  readonly sourceWatermarkDigest: string
  readonly operationSettingsRevision: number | null
  readonly operationSettingsDigest: string
  readonly provider: ExperienceRetrievalManifestView['provider']
  readonly providerState: ExperienceRetrievalManifestView['providerState']
  readonly model: {
    readonly modelId: string
    readonly modelRevision: string
    readonly artifactSha256: string
    readonly dimension: number
    readonly dtype: NonNullable<ExperienceRetrievalManifestView['dtype']>
    readonly pooling: NonNullable<ExperienceRetrievalManifestView['pooling']>
    readonly queryPrefix: string
    readonly passagePrefix: string
    readonly tokenizerConfigBundleSha256: string
    readonly normalization: 'l2'
    readonly maxInputTokens: number
    readonly truncationPolicy: 'truncate_end'
  } | null
  readonly documents: readonly ExperienceRetrievalDocumentView[]
  readonly vectors: readonly Float32Array[] | null
  readonly failureCode: ExperienceRetrievalManifestView['failureCode']
  readonly builtAt: string
}

/** Host-only vector readback used by the matcher; Browser never receives vectors. */
export interface RetrievalProjectionInternalView {
  readonly projection: ExperienceRetrievalProjectionView
  readonly vectors: ReadonlyMap<string, Float32Array>
}

/** One disposable SQLite owner for suggestions and future lexical/dense generations. */
export class ExperienceProjectionStore {
  private closed = false

  private constructor(readonly handle: DatabaseSync, readonly path: string) {}

  /** Open the sidecar, quarantining corrupt or incompatible disposable state before rebuilding. */
  static async open(databasePath: string): Promise<ExperienceProjectionStore> {
    const actual = suggestionProjectionPath(databasePath)
    if (actual !== ':memory:') await ensureOwnerOnlyFile(actual)
    try {
      return await openStore(actual, null, handle => new ExperienceProjectionStore(handle, actual))
    } catch (error) {
      if (actual === ':memory:' || !isRecoverableProjectionCorruption(error)) throw error
      const suffix = `.corrupt-${Date.now().toString(36)}`
      for (const extra of ['', '-wal', '-shm']) {
        const source = `${actual}${extra}`
        if (await exists(source)) await rename(source, `${actual}${suffix}${extra}`)
      }
      await ensureOwnerOnlyFile(actual)
      return openStore(
        actual,
        'recovered_from_corruption',
        handle => new ExperienceProjectionStore(handle, actual),
      )
    }
  }

  /** Atomically activate a complete generation, or record an idempotent unchanged scan. */
  rebuild(input: SuggestionProjectionBuild): SuggestionProjectionView {
    this.assertOpen()
    validateBuild(input)
    const completedMs = Date.parse(input.completedAt)
    const seeds = [...input.seeds]
      .filter(seed => Date.parse(seed.expiresAt) > completedMs)
      .sort((left, right) => left.occurrenceId.localeCompare(right.occurrenceId))
    const sessions = [...input.sessions]
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
      .map(session => ({
        ...session,
        occurrenceIds: session.occurrenceIds.filter(id => seeds.some(seed => seed.occurrenceId === id)).sort(),
      }))
    const occurrenceIds = new Set(seeds.map(seed => seed.occurrenceId))
    const groups = [...input.groups]
      .filter(group => Date.parse(group.expiresAt) > completedMs
        && group.occurrences.every(occurrence => occurrenceIds.has(occurrence.seedOccurrenceId)))
      .sort((left, right) => left.suggestionGroupId.localeCompare(right.suggestionGroupId))
    const contentDigest = suggestionDigest({
      sessions,
      seeds: seeds.map(stableProjectionContent),
      groups: groups.map(stableProjectionContent),
    })
    transaction(this.handle, () => {
      this.handle.prepare('DELETE FROM suggestion_dispositions WHERE expires_at <= ?').run(input.completedAt)
      const current = this.currentGeneration()
      const unchanged = current.projectorVersion === input.projectorVersion
        && current.sourceWatermarkDigest === input.sourceWatermarkDigest
        && current.contentDigest === contentDigest
      if (unchanged) {
        const metadata = this.handle.prepare(
          'SELECT degraded_reason FROM projection_metadata WHERE singleton = 1',
        ).get() as { degraded_reason: SuggestionProjectionView['degradedReason'] }
        if (metadata.degraded_reason !== null) {
          this.handle.prepare(
            'UPDATE projection_metadata SET degraded_reason = NULL, updated_at = ? WHERE singleton = 1',
          ).run(input.completedAt)
        }
        return
      }
      const next = current.generation + 1
      this.handle.prepare(
        `INSERT INTO projection_generations
           (generation, projector_version, source_watermark_digest, content_digest, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(next, input.projectorVersion, input.sourceWatermarkDigest, contentDigest, input.completedAt)
      const insertSession = this.handle.prepare(
        'INSERT INTO session_scans (generation, session_id, payload_json) VALUES (?, ?, ?)',
      )
      for (const session of sessions) insertSession.run(next, session.sessionId, JSON.stringify(session))
      const insertSeed = this.handle.prepare(
        `INSERT INTO suggestion_seeds
           (generation, occurrence_id, session_id, expires_at, payload_json) VALUES (?, ?, ?, ?, ?)`,
      )
      for (const seed of seeds) {
        insertSeed.run(next, seed.occurrenceId, seed.sessionId, seed.expiresAt, JSON.stringify(seed))
      }
      const insertGroup = this.handle.prepare(
        `INSERT INTO suggestion_groups
           (generation, group_id, kernel_identity, expires_at, payload_json) VALUES (?, ?, ?, ?, ?)`,
      )
      for (const group of groups) {
        insertGroup.run(
          next,
          group.suggestionGroupId,
          group.kernelIdentity,
          group.expiresAt,
          JSON.stringify(group),
        )
      }
      this.handle.prepare(
        `UPDATE projection_metadata
           SET active_generation = ?, previous_generation = ?, degraded_reason = NULL, updated_at = ?
         WHERE singleton = 1`,
      ).run(next, current.generation, input.completedAt)
      this.handle.prepare(
        'DELETE FROM projection_generations WHERE generation NOT IN (?, ?)',
      ).run(next, current.generation)
      insertReceipt(this.handle, projectionReceipt(
        'activated',
        next,
        input.sourceWatermarkDigest,
        sessions.length,
        seeds.length,
        input.startedAt,
        input.completedAt,
        null,
      ))
      pruneReceipts(this.handle)
    })
    return this.read()
  }

  /** Atomically suppress one exact current suggestion snapshot for its retention window. */
  dismiss(
    input: DismissExperienceSuggestionInput,
    actorId: ActorId,
  ): SuggestionProjectionView {
    this.assertOpen()
    validateDismiss(input)
    transaction(this.handle, () => {
      const inputDigest = suggestionDigest(input)
      const previousCommands = this.handle.prepare(
        'SELECT input_digest FROM suggestion_dispositions WHERE command_id = ?',
      ).all(input.commandId) as Array<{ input_digest: string }>
      if (previousCommands.some(previous => previous.input_digest !== inputDigest)) {
        throw new ExperienceError('idempotency_conflict', 'suggestion dismissal command was reused with different input')
      }
      const generation = this.currentGeneration()
      const row = this.handle.prepare(
        'SELECT payload_json FROM suggestion_groups WHERE generation = ? AND group_id = ?',
      ).get(generation.generation, input.suggestionGroupId) as { payload_json: string } | undefined
      if (row === undefined) throw new ExperienceError('not_found', 'suggestion group is not active')
      const group = parseGroup(row.payload_json)
      const decisionDigests = suggestionDecisionDigests(group)
      const completedAt = new Date().toISOString()
      if (Date.parse(group.expiresAt) <= Date.parse(completedAt)) {
        throw new ExperienceError('stale_revision', 'suggestion group expired before the decision')
      }
      if (group.revisionDigest !== decisionDigests.revisionDigest
        || group.reviewDigest !== decisionDigests.reviewDigest
        || group.revisionDigest !== input.expectedRevisionDigest
        || group.reviewDigest !== input.reviewDigest) {
        throw new ExperienceError('stale_revision', 'suggestion group changed after it was displayed', {
          actualRevisionDigest: group.revisionDigest,
          actualReviewDigest: group.reviewDigest,
        })
      }
      const terminalGroups = terminalGroupBindings(group)
      const existing = terminalGroups.map(item => this.handle.prepare(
        'SELECT command_id, input_digest FROM suggestion_dispositions WHERE group_id = ?',
      ).get(item.suggestionGroupId) as { command_id: string; input_digest: string } | undefined)
      if (existing.some(item => item !== undefined
        && (item.command_id !== input.commandId || item.input_digest !== inputDigest))) {
        throw new ExperienceError('stale_revision', 'one or more semantic source groups already have a terminal decision')
      }
      const pending = terminalGroups.filter((_, index) => existing[index] === undefined)
      if (pending.length === 0) return
      const counts = this.counts(generation.generation)
      const receipt = projectionReceipt(
        'dismissed',
        generation.generation,
        generation.sourceWatermarkDigest,
        counts.sessions,
        counts.seeds,
        input.issuedAt,
        completedAt,
        input.reasonCode,
      )
      const insertDisposition = this.handle.prepare(
        `INSERT INTO suggestion_dispositions
           (group_id, kernel_identity, decision, command_id, actor_id, scope_digest,
            occurrence_ids_json, input_digest, decided_at, expires_at, projection_receipt_id, target_ref)
         VALUES (?, ?, 'dismissed', ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      for (const terminalGroup of pending) insertDisposition.run(
        terminalGroup.suggestionGroupId,
        terminalGroup.kernelIdentity,
        input.commandId,
        actorId,
        suggestionDigest(group.draft.scope),
        JSON.stringify(terminalGroup.occurrenceIds),
        inputDigest,
        completedAt,
        group.expiresAt,
        receipt.receiptId,
      )
      insertReceipt(this.handle, receipt)
      this.handle.prepare(
        'UPDATE projection_metadata SET updated_at = ? WHERE singleton = 1',
      ).run(completedAt)
      pruneReceipts(this.handle)
    })
    return this.read()
  }

  /** Repair saved dispositions from canonical receipts after a commit/sidecar crash gap. */
  reconcileSaved(receipts: readonly SuggestionSaveDomainReceipt[]): SuggestionProjectionView {
    this.assertOpen()
    transaction(this.handle, () => {
      const current = this.currentGeneration()
      const counts = this.counts(current.generation)
      const now = new Date().toISOString()
      let changed = false
      for (const receipt of [...receipts].sort((left, right) => left.commitSequence - right.commitSequence)) {
        if (Date.parse(receipt.expiresAt) <= Date.parse(now)) continue
        const expectedDecision = receipt.outcome === 'saved_new_experience'
          ? 'saved_new_experience' : 'attached_as_evidence'
        const bindings = receiptTerminalGroupBindings(this.handle, current.generation, receipt)
        const projectionReceiptId = `projection-receipt:canonical:${receipt.receiptId}`
        const insert = this.handle.prepare(
          `INSERT INTO suggestion_dispositions
             (group_id, kernel_identity, decision, command_id, actor_id, scope_digest,
              occurrence_ids_json, input_digest, decided_at, expires_at, projection_receipt_id, target_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        let receiptChanged = false
        for (const binding of bindings) {
          const existing = this.handle.prepare(
            'SELECT decision, target_ref FROM suggestion_dispositions WHERE group_id = ?',
          ).get(binding.suggestionGroupId) as {
            decision: SuggestionDispositionProjectionView['decision']
            target_ref: string | null
          } | undefined
          if (existing !== undefined && existing.decision !== 'dismissed') {
            if (existing.target_ref !== receipt.experienceVersionId || existing.decision !== expectedDecision) {
              throw new ExperienceError('database_schema_invalid', 'Saved suggestion disposition conflicts with canonical receipt')
            }
            continue
          }
          if (existing?.decision === 'dismissed') {
            this.handle.prepare('DELETE FROM suggestion_dispositions WHERE group_id = ?')
              .run(binding.suggestionGroupId)
          }
          insert.run(
            binding.suggestionGroupId,
            binding.kernelIdentity,
            expectedDecision,
            receipt.commandId,
            receipt.actor.actorId,
            receipt.scopeDigest,
            JSON.stringify(binding.occurrenceIds),
            receipt.inputDigest,
            receipt.createdAt,
            receipt.expiresAt,
            projectionReceiptId,
            receipt.experienceVersionId,
          )
          receiptChanged = true
        }
        if (receiptChanged) {
          const projected = this.handle.prepare(
            'SELECT receipt_id FROM projection_receipts WHERE receipt_id = ?',
          ).get(projectionReceiptId)
          if (projected === undefined) insertReceipt(this.handle, {
            receiptId: projectionReceiptId,
            status: 'saved',
            generation: current.generation,
            sourceWatermarkDigest: current.sourceWatermarkDigest,
            processedSessionCount: counts.sessions,
            occurrenceCount: counts.seeds,
            startedAt: receipt.issuedAt,
            completedAt: receipt.createdAt,
            reason: receipt.outcome,
          })
          changed = true
        }
      }
      if (changed) {
        this.handle.prepare('UPDATE projection_metadata SET updated_at = ? WHERE singleton = 1').run(now)
        pruneReceipts(this.handle)
      }
    })
    return this.read()
  }

  /** Resolve and validate the exact immutable group that may enter canonical storage. */
  resolveForSave(input: SaveExperienceSuggestionInput): ExperienceSuggestionGroupView {
    this.assertOpen()
    validateSave(input)
    return readTransaction(this.handle, () => {
      const generation = this.currentGeneration()
      const row = this.handle.prepare(
        'SELECT payload_json FROM suggestion_groups WHERE generation = ? AND group_id = ?',
      ).get(generation.generation, input.suggestionGroupId) as { payload_json: string } | undefined
      if (row === undefined) throw new ExperienceError('not_found', 'suggestion group is not active')
      const group = parseGroup(row.payload_json)
      const decisionDigests = suggestionDecisionDigests(group)
      const now = new Date().toISOString()
      if (Date.parse(group.expiresAt) <= Date.parse(now)) {
        throw new ExperienceError('stale_revision', 'suggestion group expired before the save')
      }
      if (group.revisionDigest !== decisionDigests.revisionDigest
        || group.reviewDigest !== decisionDigests.reviewDigest
        || group.revisionDigest !== input.expectedRevisionDigest
        || group.reviewDigest !== input.reviewDigest
        || group.sourceDigest !== input.sourceDigest) {
        throw new ExperienceError('stale_revision', 'suggestion group changed after it was displayed', {
          actualRevisionDigest: group.revisionDigest,
          actualReviewDigest: group.reviewDigest,
          actualSourceDigest: group.sourceDigest,
        })
      }
      const eligibility = suggestionSaveEligibility(group, input.ownerChoice)
      if (!eligibility.allowed) {
        throw new ExperienceError('invalid_command', 'suggestion group is not ready for canonical save', {
          saveReadiness: group.saveReadiness,
          consolidation: group.consolidation,
          readinessReasons: group.readinessReasons,
          reason: eligibility.reason,
        })
      }
      const disposition = this.handle.prepare(
        'SELECT command_id FROM suggestion_dispositions WHERE group_id = ?',
      ).get(group.suggestionGroupId) as { command_id: string } | undefined
      if (disposition !== undefined && disposition.command_id !== input.commandId) {
        throw new ExperienceError('stale_revision', 'suggestion group already has a terminal decision')
      }
      return structuredClone(group)
    })
  }

  /** Project one committed canonical save back into the disposable suggestion inbox. */
  markSaved(
    input: SaveExperienceSuggestionInput,
    group: ExperienceSuggestionGroupView,
    receipt: SuggestionSaveDomainReceipt,
  ): SuggestionProjectionView {
    this.assertOpen()
    assertSuggestionReceiptMatchesGroup(input, group, receipt)
    transaction(this.handle, () => {
      const inputDigest = receipt.inputDigest
      const previousCommands = this.handle.prepare(
        'SELECT input_digest FROM suggestion_dispositions WHERE command_id = ?',
      ).all(input.commandId) as Array<{ input_digest: string }>
      if (previousCommands.some(previous => previous.input_digest !== inputDigest)) {
        throw new ExperienceError('idempotency_conflict', 'suggestion save command was reused with different input')
      }
      const terminalGroups = terminalGroupBindings(group)
      const existing = terminalGroups.map(item => this.handle.prepare(
        'SELECT command_id, input_digest, decision, target_ref FROM suggestion_dispositions WHERE group_id = ?',
      ).get(item.suggestionGroupId) as {
        command_id: string
        input_digest: string
        decision: SuggestionDispositionProjectionView['decision']
        target_ref: string | null
      } | undefined)
      if (existing.some(item => item !== undefined
        && (item.command_id !== input.commandId || item.input_digest !== inputDigest))) {
        throw new ExperienceError('stale_revision', 'one or more semantic source groups already have a terminal decision')
      }
      const expectedDecision = receipt.outcome === 'saved_new_experience'
        ? 'saved_new_experience' : 'attached_as_evidence'
      if (existing.some(item => item !== undefined
        && (item.decision !== expectedDecision || item.target_ref !== receipt.experienceVersionId))) {
        throw new ExperienceError('database_schema_invalid', 'Saved suggestion disposition conflicts with canonical receipt')
      }
      const pending = terminalGroups.filter((_, index) => existing[index] === undefined)
      if (pending.length === 0) return
      const generation = this.currentGeneration()
      const counts = this.counts(generation.generation)
      const completedAt = receipt.createdAt
      const projection = projectionReceipt(
        'saved',
        generation.generation,
        generation.sourceWatermarkDigest,
        counts.sessions,
        counts.seeds,
        input.issuedAt,
        completedAt,
        receipt.outcome,
      )
      const insertDisposition = this.handle.prepare(
        `INSERT INTO suggestion_dispositions
           (group_id, kernel_identity, decision, command_id, actor_id, scope_digest,
            occurrence_ids_json, input_digest, decided_at, expires_at, projection_receipt_id, target_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const terminalGroup of pending) insertDisposition.run(
        terminalGroup.suggestionGroupId,
        terminalGroup.kernelIdentity,
        expectedDecision,
        receipt.commandId,
        receipt.actor.actorId,
        receipt.scopeDigest,
        JSON.stringify(terminalGroup.occurrenceIds),
        inputDigest,
        completedAt,
        group.expiresAt,
        projection.receiptId,
        receipt.experienceVersionId,
      )
      insertReceipt(this.handle, projection)
      this.handle.prepare(
        'UPDATE projection_metadata SET updated_at = ? WHERE singleton = 1',
      ).run(completedAt)
      pruneReceipts(this.handle)
    })
    return this.read()
  }

  /** Preserve the last good generation and expose a bounded source failure. */
  recordSourceFailure(startedAt: string, completedAt: string): SuggestionProjectionView {
    this.assertOpen()
    transaction(this.handle, () => {
      const metadata = this.handle.prepare(
        'SELECT degraded_reason FROM projection_metadata WHERE singleton = 1',
      ).get() as { degraded_reason: SuggestionProjectionView['degradedReason'] }
      if (metadata.degraded_reason === 'source_unavailable') return
      const current = this.currentGeneration()
      const counts = this.counts(current.generation)
      this.handle.prepare(
        `UPDATE projection_metadata
           SET degraded_reason = 'source_unavailable', updated_at = ? WHERE singleton = 1`,
      ).run(completedAt)
      insertReceipt(this.handle, projectionReceipt(
        'failed',
        current.generation,
        current.sourceWatermarkDigest,
        counts.sessions,
        counts.seeds,
        startedAt,
        completedAt,
        'recent Session source unavailable',
      ))
      pruneReceipts(this.handle)
    })
    return this.read()
  }

  /** Read only the active generation; an unfinished or failed rebuild is never visible. */
  read(): SuggestionProjectionView {
    this.assertOpen()
    return readTransaction(this.handle, () => {
      const metadata = this.handle.prepare(
        'SELECT active_generation, degraded_reason FROM projection_metadata WHERE singleton = 1',
      ).get() as { active_generation: number; degraded_reason: SuggestionProjectionView['degradedReason'] }
      const generation = this.currentGeneration()
      const sessions = (this.handle.prepare(
        'SELECT payload_json FROM session_scans WHERE generation = ? ORDER BY session_id',
      ).all(metadata.active_generation) as Array<{ payload_json: string }>).map(row => parseSession(row.payload_json))
      const seeds = (this.handle.prepare(
        'SELECT payload_json FROM suggestion_seeds WHERE generation = ? ORDER BY occurrence_id',
      ).all(metadata.active_generation) as Array<{ payload_json: string }>).map(row => parseSeed(row.payload_json))
      const allGroups = (this.handle.prepare(
        'SELECT payload_json FROM suggestion_groups WHERE generation = ? ORDER BY group_id',
      ).all(metadata.active_generation) as Array<{ payload_json: string }>).map(row => parseGroup(row.payload_json))
      const readAt = new Date().toISOString()
      const activeGroups = allGroups.filter(group => Date.parse(group.expiresAt) > Date.parse(readAt))
      const dispositions = (this.handle.prepare(
        'SELECT * FROM suggestion_dispositions WHERE expires_at > ? ORDER BY decided_at, group_id',
      ).all(readAt) as unknown as DispositionRow[]).map(dispositionView)
      const suppressed = new Set(dispositions.map(disposition => disposition.suggestionGroupId))
      const groups = activeGroups.filter(group => !suppressed.has(group.suggestionGroupId))
      const latest = this.handle.prepare(
        'SELECT * FROM projection_receipts ORDER BY rowid DESC LIMIT 1',
      ).get() as ReceiptRow | undefined
      if (latest === undefined) throw new Error('suggestion projection has no receipt')
      return {
        projectionKey: SUGGESTION_PROJECTION_KEY,
        schemaVersion: SUGGESTION_PROJECTION_VIEW_SCHEMA_VERSION,
        projectorVersion: generation.projectorVersion,
        generation: generation.generation,
        sourceWatermarkDigest: generation.sourceWatermarkDigest,
        state: metadata.degraded_reason === null ? 'ready' : 'degraded',
        degradedReason: metadata.degraded_reason,
        sessions,
        seeds,
        groups,
        dispositions,
        suppressedGroupCount: activeGroups.length - groups.length,
        latestReceipt: receiptView(latest),
      }
    })
  }

  /** Atomically publish one complete retrieval generation and retain only one rollback generation. */
  rebuildRetrieval(input: RetrievalProjectionBuild): ExperienceRetrievalProjectionView {
    this.assertOpen()
    validateRetrievalBuild(input)
    const documents = [...input.documents].sort((left, right) => left.documentId.localeCompare(right.documentId))
    const vectorByDocument = new Map<string, Float32Array>()
    if (input.vectors !== null) {
      for (let index = 0; index < documents.length; index += 1) {
        const vector = input.vectors[index]!
        validateRetrievalVector(vector, input.model!.dimension)
        vectorByDocument.set(documents[index]!.documentId, vector)
      }
    }
    const stableManifest = {
      schemaVersion: 'experience-retrieval-projection-manifest-v2' as const,
      projectionVersion: input.projectionVersion,
      state: input.vectors === null ? 'lexical_ready' as const : 'dense_ready' as const,
      provider: input.provider,
      providerState: input.providerState,
      modelId: input.model?.modelId ?? null,
      modelRevision: input.model?.modelRevision ?? null,
      artifactSha256: input.model?.artifactSha256 ?? null,
      dimension: input.model?.dimension ?? null,
      dtype: input.model?.dtype ?? null,
      pooling: input.model?.pooling ?? null,
      queryPrefix: input.model?.queryPrefix ?? null,
      passagePrefix: input.model?.passagePrefix ?? null,
      tokenizerConfigBundleSha256: input.model?.tokenizerConfigBundleSha256 ?? null,
      normalization: input.model?.normalization ?? null,
      maxInputTokens: input.model?.maxInputTokens ?? null,
      truncationPolicy: input.model?.truncationPolicy ?? null,
      operationSettingsRevision: input.operationSettingsRevision,
      operationSettingsDigest: input.operationSettingsDigest,
      sourceWatermarkDigest: input.sourceWatermarkDigest,
      documentCount: documents.length,
      vectorCount: input.vectors?.length ?? 0,
      failureCode: input.failureCode,
    }
    const contentDigest = suggestionDigest({
      manifest: stableManifest,
      documents: documents.map(document => ({
        document,
        vector: vectorByDocument.get(document.documentId) === undefined
          ? null : [...vectorByDocument.get(document.documentId)!],
      })),
    })
    transaction(this.handle, () => {
      const current = this.currentRetrievalGeneration()
      if (current.contentDigest === contentDigest) return
      const generation = current.generation + 1
      const manifest: ExperienceRetrievalManifestView = {
        ...stableManifest,
        generation,
        contentDigest,
        builtAt: input.builtAt,
      }
      this.handle.prepare(
        `INSERT INTO retrieval_generations (generation, content_digest, payload_json, created_at)
         VALUES (?, ?, ?, ?)`,
      ).run(generation, contentDigest, JSON.stringify(manifest), input.builtAt)
      const insert = this.handle.prepare(
        `INSERT INTO retrieval_documents
           (generation, document_id, experience_version_id, payload_json, vector_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      for (const document of documents) {
        const vector = vectorByDocument.get(document.documentId)
        insert.run(
          generation,
          document.documentId,
          document.experienceVersionId,
          JSON.stringify(document),
          vector === undefined ? null : JSON.stringify([...vector]),
        )
      }
      this.handle.prepare(
        `UPDATE retrieval_metadata
            SET active_generation = ?, previous_generation = ?, updated_at = ?
          WHERE singleton = 1`,
      ).run(generation, current.generation, input.builtAt)
      this.handle.prepare('DELETE FROM retrieval_generations WHERE generation NOT IN (?, ?)')
        .run(generation, current.generation)
    })
    return this.readRetrieval()
  }

  /** Read the active retrieval manifest and documents without exposing vectors. */
  readRetrieval(): ExperienceRetrievalProjectionView {
    this.assertOpen()
    return readTransaction(this.handle, () => {
      const generation = this.currentRetrievalGeneration()
      const manifest = parseRetrievalManifest(generation.payloadJson)
      const documents = (this.handle.prepare(
        'SELECT payload_json FROM retrieval_documents WHERE generation = ? ORDER BY document_id',
      ).all(generation.generation) as Array<{ payload_json: string }>)
        .map(row => parseRetrievalDocument(row.payload_json))
      if (documents.length !== manifest.documentCount) {
        throw new ProjectionStoreInvalidError('retrieval projection document count is inconsistent')
      }
      return {
        projectionKey: EXPERIENCE_RETRIEVAL_PROJECTION_KEY,
        schemaVersion: 2,
        manifest,
        documents,
      }
    })
  }

  /** Read the same active generation with its Host-only vectors. */
  readRetrievalInternal(): RetrievalProjectionInternalView {
    this.assertOpen()
    return readTransaction(this.handle, () => {
      const projection = readRetrievalWithoutTransaction(this.handle, this.currentRetrievalGeneration())
      const rows = this.handle.prepare(
        'SELECT document_id, vector_json FROM retrieval_documents WHERE generation = ? ORDER BY document_id',
      ).all(projection.manifest.generation) as Array<{ document_id: string; vector_json: string | null }>
      const vectors = new Map<string, Float32Array>()
      for (const row of rows) {
        if (row.vector_json === null) continue
        const vector = parseRetrievalVector(row.vector_json)
        validateRetrievalVector(vector, projection.manifest.dimension!)
        vectors.set(row.document_id, vector)
      }
      if (vectors.size !== projection.manifest.vectorCount) {
        throw new ProjectionStoreInvalidError('retrieval projection vector count is inconsistent')
      }
      return { projection, vectors }
    })
  }

  /** Close the sole sidecar connection. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.handle.close()
  }

  private currentGeneration(): GenerationRow {
    const row = this.handle.prepare(
      `SELECT g.generation, g.projector_version, g.source_watermark_digest, g.content_digest
         FROM projection_metadata m
         JOIN projection_generations g ON g.generation = m.active_generation
        WHERE m.singleton = 1`,
    ).get() as {
      generation: number
      projector_version: string
      source_watermark_digest: string
      content_digest: string
    } | undefined
    if (row === undefined) throw new Error('suggestion projection has no active generation')
    return {
      generation: row.generation,
      projectorVersion: row.projector_version,
      sourceWatermarkDigest: row.source_watermark_digest,
      contentDigest: row.content_digest,
    }
  }

  private currentRetrievalGeneration(): RetrievalGenerationRow {
    const row = this.handle.prepare(
      `SELECT g.generation, g.content_digest, g.payload_json
         FROM retrieval_metadata m
         JOIN retrieval_generations g ON g.generation = m.active_generation
        WHERE m.singleton = 1`,
    ).get() as { generation: number; content_digest: string; payload_json: string } | undefined
    if (row === undefined) throw new Error('retrieval projection has no active generation')
    const manifest = parseRetrievalManifest(row.payload_json)
    if (manifest.generation !== row.generation || manifest.contentDigest !== row.content_digest) {
      throw new ProjectionStoreInvalidError('retrieval generation identity is inconsistent')
    }
    return { generation: row.generation, contentDigest: row.content_digest, payloadJson: row.payload_json }
  }

  private counts(generation: number): { sessions: number; seeds: number } {
    return this.handle.prepare(
      `SELECT
         (SELECT count(*) FROM session_scans WHERE generation = ?) AS sessions,
         (SELECT count(*) FROM suggestion_seeds WHERE generation = ?) AS seeds`,
    ).get(generation, generation) as { sessions: number; seeds: number }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('suggestion projection store is closed')
  }
}

interface GenerationRow {
  readonly generation: number
  readonly projectorVersion: string
  readonly sourceWatermarkDigest: string
  readonly contentDigest: string
}

interface RetrievalGenerationRow {
  readonly generation: number
  readonly contentDigest: string
  readonly payloadJson: string
}

interface ReceiptRow {
  readonly receipt_id: string
  readonly status: SuggestionProjectionReceiptView['status']
  readonly generation: number
  readonly source_watermark_digest: string
  readonly processed_session_count: number
  readonly occurrence_count: number
  readonly started_at: string
  readonly completed_at: string
  readonly reason: string | null
}

interface DispositionRow {
  readonly group_id: string
  readonly kernel_identity: string
  readonly decision: SuggestionDispositionProjectionView['decision']
  readonly command_id: string
  readonly actor_id: ActorId
  readonly scope_digest: string
  readonly occurrence_ids_json: string
  readonly input_digest: string
  readonly decided_at: string
  readonly expires_at: string
  readonly projection_receipt_id: string
  readonly target_ref: string | null
}

async function openStore(
  path: string,
  recovered: SuggestionProjectionView['degradedReason'],
  create: (handle: DatabaseSync) => ExperienceProjectionStore,
): Promise<ExperienceProjectionStore> {
  const { DatabaseSync } = await import('node:sqlite')
  const handle = new DatabaseSync(path)
  try {
    handle.exec('PRAGMA foreign_keys = ON')
    handle.exec('PRAGMA busy_timeout = 5000')
    handle.exec('PRAGMA journal_mode = WAL')
    handle.exec('PRAGMA synchronous = NORMAL')
    const applicationId = pragma(handle, 'application_id')
    const version = pragma(handle, 'user_version')
    const tables = listTables(handle)
    if (applicationId === 0 && tables.length === 0) bootstrap(handle, recovered)
    else {
      if (applicationId !== SUGGESTION_PROJECTION_APPLICATION_ID
        || (version !== 4 && version !== SUGGESTION_PROJECTION_SCHEMA_VERSION)) {
        throw new ProjectionStoreInvalidError('unrecognized suggestion projection schema')
      }
      if (version === 4) upgradeSuggestionDispositionSchemaV5(handle)
      upgradeLegacyRetrievalProjection(handle)
      assertStore(handle, tables)
    }
    return create(handle)
  } catch (error) {
    handle.close()
    throw error
  }
}

/** Remove the obsolete one-row-per-command constraint so one terminal decision can cover a semantic cluster. */
function upgradeSuggestionDispositionSchemaV5(handle: DatabaseSync): void {
  transaction(handle, () => {
    handle.exec(`
      ALTER TABLE suggestion_dispositions RENAME TO suggestion_dispositions_v4;
      CREATE TABLE suggestion_dispositions (
        group_id TEXT PRIMARY KEY,
        kernel_identity TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('dismissed','saved_new_experience','attached_as_evidence')),
        command_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        scope_digest TEXT NOT NULL,
        occurrence_ids_json TEXT NOT NULL CHECK (json_valid(occurrence_ids_json)),
        input_digest TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        projection_receipt_id TEXT NOT NULL,
        target_ref TEXT
      ) STRICT;
      INSERT INTO suggestion_dispositions
        SELECT * FROM suggestion_dispositions_v4;
      DROP TABLE suggestion_dispositions_v4;
    `)
    backfillSemanticDispositionSources(handle)
    handle.exec(`PRAGMA user_version = ${String(SUGGESTION_PROJECTION_STORAGE_SCHEMA_VERSION)}`)
  })
}

function backfillSemanticDispositionSources(handle: DatabaseSync): void {
  const rows = handle.prepare(
    `SELECT disposition.*, suggestion.payload_json
       FROM suggestion_dispositions disposition
       JOIN projection_metadata metadata ON metadata.singleton = 1
       JOIN suggestion_groups suggestion
         ON suggestion.generation = metadata.active_generation
        AND suggestion.group_id = disposition.group_id
      ORDER BY disposition.group_id`,
  ).all() as unknown as Array<DispositionRow & { readonly payload_json: string }>
  const insert = handle.prepare(
    `INSERT INTO suggestion_dispositions
       (group_id, kernel_identity, decision, command_id, actor_id, scope_digest,
        occurrence_ids_json, input_digest, decided_at, expires_at, projection_receipt_id, target_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const row of rows) {
    const group = parseGroup(row.payload_json)
    for (const source of terminalGroupBindings(group).filter(item => item.suggestionGroupId !== row.group_id)) {
      const existing = handle.prepare(
        'SELECT command_id, input_digest FROM suggestion_dispositions WHERE group_id = ?',
      ).get(source.suggestionGroupId) as { readonly command_id: string; readonly input_digest: string } | undefined
      if (existing !== undefined) {
        if (existing.command_id === row.command_id && existing.input_digest === row.input_digest) continue
        throw new ProjectionStoreInvalidError('semantic source group has a conflicting terminal decision')
      }
      insert.run(
        source.suggestionGroupId,
        source.kernelIdentity,
        row.decision,
        row.command_id,
        row.actor_id,
        row.scope_digest,
        JSON.stringify(source.occurrenceIds),
        row.input_digest,
        row.decided_at,
        row.expires_at,
        row.projection_receipt_id,
        row.target_ref,
      )
    }
  }
}

function bootstrap(handle: DatabaseSync, recovered: SuggestionProjectionView['degradedReason']): void {
  transaction(handle, () => {
    const applicationId = pragma(handle, 'application_id')
    const version = pragma(handle, 'user_version')
    const tables = listTables(handle)
    if (applicationId === SUGGESTION_PROJECTION_APPLICATION_ID
      && version === SUGGESTION_PROJECTION_SCHEMA_VERSION) return
    if (applicationId !== 0 || tables.length > 0) {
      throw new ProjectionStoreInvalidError('suggestion projection changed during bootstrap')
    }
    handle.exec(SCHEMA)
    const now = new Date().toISOString()
    const emptyDigest = suggestionDigest({ sessions: [], seeds: [], groups: [] })
    handle.prepare(
      `INSERT INTO projection_generations
         (generation, projector_version, source_watermark_digest, content_digest, created_at)
       VALUES (0, 'uninitialized', ?, ?, ?)`,
    ).run(suggestionDigest([]), emptyDigest, now)
    handle.prepare(
      `INSERT INTO projection_metadata
         (singleton, active_generation, previous_generation, degraded_reason, updated_at)
       VALUES (1, 0, NULL, ?, ?)`,
    ).run(recovered, now)
    const emptyRetrievalManifest = {
      schemaVersion: 'experience-retrieval-projection-manifest-v2',
      projectionVersion: 'experience-retrieval-projector-v2',
      state: 'lexical_ready' as const,
      provider: 'disabled' as const,
      providerState: 'disabled' as const,
      modelId: null,
      modelRevision: null,
      artifactSha256: null,
      dimension: null,
      dtype: null,
      pooling: null,
      queryPrefix: null,
      passagePrefix: null,
      tokenizerConfigBundleSha256: null,
      normalization: null,
      maxInputTokens: null,
      truncationPolicy: null,
      operationSettingsRevision: null,
      operationSettingsDigest: suggestionDigest({ provider: 'disabled' }),
      sourceWatermarkDigest: suggestionDigest([]),
      documentCount: 0,
      vectorCount: 0,
      failureCode: null,
    } as const
    const retrievalManifest: ExperienceRetrievalManifestView = {
      ...emptyRetrievalManifest,
      generation: 0,
      contentDigest: suggestionDigest({ manifest: emptyRetrievalManifest, documents: [] }),
      builtAt: now,
    }
    handle.prepare(
      `INSERT INTO retrieval_generations (generation, content_digest, payload_json, created_at)
       VALUES (0, ?, ?, ?)`,
    ).run(retrievalManifest.contentDigest, JSON.stringify(retrievalManifest), now)
    handle.prepare(
      `INSERT INTO retrieval_metadata
         (singleton, active_generation, previous_generation, updated_at)
       VALUES (1, 0, NULL, ?)`,
    ).run(now)
    insertReceipt(handle, projectionReceipt(
      'unchanged', 0, suggestionDigest([]), 0, 0, now, now,
      recovered === null ? null : 'disposable projection rebuilt after corruption',
    ))
    handle.exec(`PRAGMA application_id = ${String(SUGGESTION_PROJECTION_APPLICATION_ID)}`)
    handle.exec(`PRAGMA user_version = ${String(SUGGESTION_PROJECTION_SCHEMA_VERSION)}`)
  })
  assertStore(handle, listTables(handle))
}

/** Retire a valid rebuildable v1 retrieval snapshot without touching suggestion decisions. */
function upgradeLegacyRetrievalProjection(handle: DatabaseSync): void {
  const metadata = handle.prepare(
    'SELECT active_generation FROM retrieval_metadata WHERE singleton = 1',
  ).get() as { active_generation: number } | undefined
  if (metadata === undefined) return
  const row = handle.prepare(
    'SELECT payload_json FROM retrieval_generations WHERE generation = ?',
  ).get(metadata.active_generation) as { payload_json: string } | undefined
  if (row === undefined) return
  let candidate: unknown
  try {
    candidate = JSON.parse(row.payload_json)
  } catch {
    return
  }
  if (typeof candidate !== 'object' || candidate === null) return
  const identity = candidate as Record<string, unknown>
  if (identity.schemaVersion === 'experience-retrieval-projection-manifest-v2') return
  if (identity.schemaVersion !== 'experience-retrieval-projection-manifest-v1'
    || identity.projectionVersion !== 'experience-retrieval-projector-v1') return
  validateLegacyRetrievalSnapshot(handle, metadata.active_generation, identity)
  const now = new Date().toISOString()
  const next = (handle.prepare('SELECT COALESCE(MAX(generation), -1) + 1 AS generation FROM retrieval_generations')
    .get() as { generation: number }).generation
  const stableManifest = {
    schemaVersion: 'experience-retrieval-projection-manifest-v2' as const,
    projectionVersion: 'experience-retrieval-projector-v2' as const,
    state: 'lexical_ready' as const,
    provider: 'disabled' as const,
    providerState: 'disabled' as const,
    modelId: null, modelRevision: null, artifactSha256: null, dimension: null,
    dtype: null, pooling: null, queryPrefix: null, passagePrefix: null,
    tokenizerConfigBundleSha256: null, normalization: null, maxInputTokens: null, truncationPolicy: null,
    operationSettingsRevision: null,
    operationSettingsDigest: suggestionDigest({ provider: 'disabled' }),
    sourceWatermarkDigest: suggestionDigest([]),
    documentCount: 0, vectorCount: 0, failureCode: null,
  }
  const manifest: ExperienceRetrievalManifestView = {
    ...stableManifest,
    generation: next,
    contentDigest: suggestionDigest({ manifest: stableManifest, documents: [] }),
    builtAt: now,
  }
  transaction(handle, () => {
    handle.prepare(
      `INSERT INTO retrieval_generations (generation, content_digest, payload_json, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(next, manifest.contentDigest, JSON.stringify(manifest), now)
    handle.prepare(
      `UPDATE retrieval_metadata SET active_generation = ?, previous_generation = NULL, updated_at = ?
        WHERE singleton = 1`,
    ).run(next, now)
    handle.prepare('DELETE FROM retrieval_generations WHERE generation <> ?').run(next)
  })
}

function validateLegacyRetrievalSnapshot(
  handle: DatabaseSync,
  generation: number,
  manifest: Readonly<Record<string, unknown>>,
): void {
  if (manifest.generation !== generation
    || !Number.isSafeInteger(manifest.documentCount) || (manifest.documentCount as number) < 0
    || !Number.isSafeInteger(manifest.vectorCount) || (manifest.vectorCount as number) < 0
    || !isSha256(manifest.contentDigest) || !isSha256(manifest.sourceWatermarkDigest)
    || !isSha256(manifest.operationSettingsDigest) || !Number.isFinite(Date.parse(String(manifest.builtAt)))) {
    throw new ProjectionStoreInvalidError('legacy retrieval manifest is invalid')
  }
  const rows = handle.prepare(
    'SELECT document_id, payload_json, vector_json FROM retrieval_documents WHERE generation = ? ORDER BY document_id',
  ).all(generation) as Array<{ document_id: string; payload_json: string; vector_json: string | null }>
  const vectorCount = rows.filter(row => row.vector_json !== null).length
  if (rows.length !== manifest.documentCount || vectorCount !== manifest.vectorCount) {
    throw new ProjectionStoreInvalidError('legacy retrieval manifest counts are inconsistent')
  }
  const versions = new Set<string>()
  const documents = rows.map(row => {
    const document = JSON.parse(row.payload_json) as Record<string, unknown>
    if (document.projectionVersion !== 'experience-retrieval-projector-v1'
      || document.documentId !== row.document_id || typeof document.experienceVersionId !== 'string'
      || versions.has(document.experienceVersionId) || document.lexicalText !== document.denseText
      || typeof document.fields !== 'object' || document.fields === null || !isSha256(document.contentDigest)) {
      throw new ProjectionStoreInvalidError('legacy retrieval document is invalid')
    }
    const expected = suggestionDigest({
      projectionVersion: document.projectionVersion,
      experienceVersionId: document.experienceVersionId,
      versionContentDigest: document.versionContentDigest,
      fields: document.fields,
    })
    if (document.contentDigest !== expected
      || document.documentId !== `retrieval-document:${document.experienceVersionId}:${expected.slice('sha256:'.length)}`) {
      throw new ProjectionStoreInvalidError('legacy retrieval document identity is invalid')
    }
    versions.add(document.experienceVersionId)
    const vector = row.vector_json === null ? null : JSON.parse(row.vector_json) as unknown
    if (vector !== null && (!Array.isArray(vector) || vector.some(value => typeof value !== 'number'))) {
      throw new ProjectionStoreInvalidError('legacy retrieval vector is invalid')
    }
    return { document, vector }
  })
  const { generation: _generation, contentDigest: _contentDigest, builtAt: _builtAt, ...stable } = manifest
  if (suggestionDigest({ manifest: stable, documents }) !== manifest.contentDigest) {
    throw new ProjectionStoreInvalidError('legacy retrieval content digest is inconsistent')
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value)
}

function assertStore(handle: DatabaseSync, tables: readonly string[]): void {
  const actual = [...tables].sort()
  const expected = [...TABLES].sort()
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new ProjectionStoreInvalidError('suggestion projection table set is not recognized')
  }
  const integrity = handle.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
  if (integrity.integrity_check !== 'ok') {
    throw new ProjectionStoreInvalidError('suggestion projection integrity check failed')
  }
  const foreign = handle.prepare('PRAGMA foreign_key_check').all()
  if (foreign.length > 0) throw new ProjectionStoreInvalidError('suggestion projection foreign keys are inconsistent')
  const nonStrict = handle.prepare(
    `SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table'
       AND name NOT GLOB 'sqlite_*' AND strict <> 1`,
  ).all()
  if (nonStrict.length > 0) throw new ProjectionStoreInvalidError('suggestion projection tables must be STRICT')
  const metadata = handle.prepare(
    'SELECT active_generation FROM projection_metadata WHERE singleton = 1',
  ).get() as { active_generation: number } | undefined
  if (metadata === undefined) throw new ProjectionStoreInvalidError('suggestion projection metadata is missing')
  const generation = handle.prepare(
    'SELECT generation FROM projection_generations WHERE generation = ?',
  ).get(metadata.active_generation)
  if (generation === undefined) throw new ProjectionStoreInvalidError('suggestion projection active generation is missing')
  const receipt = handle.prepare('SELECT receipt_id FROM projection_receipts LIMIT 1').get()
  if (receipt === undefined) throw new ProjectionStoreInvalidError('suggestion projection receipt is missing')
  const retrievalMetadata = handle.prepare(
    'SELECT active_generation FROM retrieval_metadata WHERE singleton = 1',
  ).get() as { active_generation: number } | undefined
  if (retrievalMetadata === undefined) {
    throw new ProjectionStoreInvalidError('retrieval projection metadata is missing')
  }
  const retrievalGeneration = handle.prepare(
    'SELECT payload_json FROM retrieval_generations WHERE generation = ?',
  ).get(retrievalMetadata.active_generation) as { payload_json: string } | undefined
  if (retrievalGeneration === undefined) {
    throw new ProjectionStoreInvalidError('retrieval projection active generation is missing')
  }
  const retrievalManifest = parseRetrievalManifest(retrievalGeneration.payload_json)
  if (retrievalManifest.generation !== retrievalMetadata.active_generation) {
    throw new ProjectionStoreInvalidError('retrieval projection generation identity is inconsistent')
  }
  for (const row of handle.prepare('SELECT payload_json FROM session_scans').all() as Array<{ payload_json: string }>) {
    try {
      parseSession(row.payload_json)
    } catch (error) {
      throw new ProjectionStoreInvalidError('suggestion Session projection JSON is invalid', { cause: error })
    }
  }
  for (const row of handle.prepare('SELECT payload_json FROM suggestion_seeds').all() as Array<{ payload_json: string }>) {
    try {
      parseSeed(row.payload_json)
    } catch (error) {
      throw new ProjectionStoreInvalidError('suggestion seed projection JSON is invalid', { cause: error })
    }
  }
  for (const row of handle.prepare('SELECT payload_json FROM suggestion_groups').all() as Array<{ payload_json: string }>) {
    try {
      parseGroup(row.payload_json)
    } catch (error) {
      throw new ProjectionStoreInvalidError('suggestion group projection JSON is invalid', { cause: error })
    }
  }
  for (const row of handle.prepare('SELECT * FROM suggestion_dispositions').all() as unknown as DispositionRow[]) {
    try {
      dispositionView(row)
    } catch (error) {
      throw new ProjectionStoreInvalidError('suggestion disposition projection JSON is invalid', { cause: error })
    }
  }
  const retrievalRows = handle.prepare(
    'SELECT generation, document_id, payload_json, vector_json FROM retrieval_documents',
  ).all() as Array<{ generation: number; document_id: string; payload_json: string; vector_json: string | null }>
  for (const row of retrievalRows) {
    try {
      const document = parseRetrievalDocument(row.payload_json)
      if (document.documentId !== row.document_id) throw new Error('document identity differs from row identity')
      if (row.vector_json !== null) {
        const manifestRow = handle.prepare(
          'SELECT payload_json FROM retrieval_generations WHERE generation = ?',
        ).get(row.generation) as { payload_json: string }
        const manifest = parseRetrievalManifest(manifestRow.payload_json)
        if (manifest.dimension === null) throw new Error('vector generation has no dimension')
        validateRetrievalVector(parseRetrievalVector(row.vector_json), manifest.dimension)
      }
    } catch (error) {
      throw new ProjectionStoreInvalidError('retrieval projection row is invalid', { cause: error })
    }
  }
  const activeCounts = handle.prepare(
    `SELECT COUNT(*) AS document_count,
            COALESCE(SUM(CASE WHEN vector_json IS NULL THEN 0 ELSE 1 END), 0) AS vector_count
       FROM retrieval_documents WHERE generation = ?`,
  ).get(retrievalMetadata.active_generation) as { document_count: number; vector_count: number }
  if (activeCounts.document_count !== retrievalManifest.documentCount
    || activeCounts.vector_count !== retrievalManifest.vectorCount) {
    throw new ProjectionStoreInvalidError('retrieval projection manifest counts are inconsistent')
  }
  const activeContent = (handle.prepare(
    'SELECT payload_json, vector_json FROM retrieval_documents WHERE generation = ? ORDER BY document_id',
  ).all(retrievalMetadata.active_generation) as Array<{ payload_json: string; vector_json: string | null }>)
    .map(row => ({
      document: parseRetrievalDocument(row.payload_json),
      vector: row.vector_json === null ? null : [...parseRetrievalVector(row.vector_json)],
    }))
  const {
    generation: _generation,
    contentDigest: _contentDigest,
    builtAt: _builtAt,
    ...stableManifest
  } = retrievalManifest
  if (suggestionDigest({ manifest: stableManifest, documents: activeContent }) !== retrievalManifest.contentDigest) {
    throw new ProjectionStoreInvalidError('retrieval projection content digest is inconsistent')
  }
}

function transaction(handle: DatabaseSync, work: () => void): void {
  handle.exec('BEGIN IMMEDIATE')
  try {
    work()
    handle.exec('COMMIT')
  } catch (error) {
    handle.exec('ROLLBACK')
    throw error
  }
}

function readTransaction<T>(handle: DatabaseSync, work: () => T): T {
  handle.exec('BEGIN')
  try {
    const result = work()
    handle.exec('COMMIT')
    return result
  } catch (error) {
    handle.exec('ROLLBACK')
    throw error
  }
}

function projectionReceipt(
  status: SuggestionProjectionReceiptView['status'],
  generation: number,
  sourceWatermarkDigest: string,
  processedSessionCount: number,
  occurrenceCount: number,
  startedAt: string,
  completedAt: string,
  reason: string | null,
): SuggestionProjectionReceiptView {
  return {
    receiptId: `projection-receipt:${randomUUID()}`,
    status,
    generation,
    sourceWatermarkDigest,
    processedSessionCount,
    occurrenceCount,
    startedAt,
    completedAt,
    reason,
  }
}

function insertReceipt(handle: DatabaseSync, receipt: SuggestionProjectionReceiptView): void {
  handle.prepare(
    `INSERT INTO projection_receipts
       (receipt_id, status, generation, source_watermark_digest, processed_session_count,
        occurrence_count, started_at, completed_at, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    receipt.receiptId,
    receipt.status,
    receipt.generation,
    receipt.sourceWatermarkDigest,
    receipt.processedSessionCount,
    receipt.occurrenceCount,
    receipt.startedAt,
    receipt.completedAt,
    receipt.reason,
    receipt.completedAt,
  )
}

function pruneReceipts(handle: DatabaseSync): void {
  handle.exec(`DELETE FROM projection_receipts WHERE receipt_id NOT IN (
    SELECT receipt_id FROM projection_receipts ORDER BY rowid DESC LIMIT 128
  )`)
}

function receiptView(row: ReceiptRow): SuggestionProjectionReceiptView {
  return {
    receiptId: row.receipt_id,
    status: row.status,
    generation: row.generation,
    sourceWatermarkDigest: row.source_watermark_digest,
    processedSessionCount: row.processed_session_count,
    occurrenceCount: row.occurrence_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    reason: row.reason,
  }
}

function dispositionView(row: DispositionRow): SuggestionDispositionProjectionView {
  const occurrenceIds = JSON.parse(row.occurrence_ids_json) as unknown
  if (!Array.isArray(occurrenceIds) || occurrenceIds.some(value => typeof value !== 'string')) {
    throw new Error('suggestion disposition occurrence ids are invalid')
  }
  return {
    suggestionGroupId: row.group_id,
    kernelIdentity: row.kernel_identity,
    decision: row.decision,
    commandId: row.command_id,
    actorId: row.actor_id,
    scopeDigest: row.scope_digest,
    occurrenceIds,
    inputDigest: row.input_digest,
    decidedAt: row.decided_at,
    expiresAt: row.expires_at,
    projectionReceiptId: row.projection_receipt_id,
    targetRef: row.target_ref,
  }
}

function validateBuild(input: SuggestionProjectionBuild): void {
  if (input.projectorVersion.trim() === '' || !/^sha256:[a-f0-9]{64}$/u.test(input.sourceWatermarkDigest)) {
    throw new ExperienceError('invalid_command', 'suggestion projection build identity is invalid')
  }
  if (!Number.isFinite(Date.parse(input.startedAt)) || !Number.isFinite(Date.parse(input.completedAt))) {
    throw new ExperienceError('invalid_command', 'suggestion projection build timestamps are invalid')
  }
}

function validateDismiss(input: DismissExperienceSuggestionInput): void {
  if (input.commandId.trim() === '' || input.suggestionGroupId.trim() === ''
    || !/^sha256:[a-f0-9]{64}$/u.test(input.expectedRevisionDigest)
    || (input.reviewDigest !== null && !/^sha256:[a-f0-9]{64}$/u.test(input.reviewDigest))
    || !Number.isFinite(Date.parse(input.issuedAt))) {
    throw new ExperienceError('invalid_command', 'suggestion dismissal identity is invalid')
  }
}

function validateSave(input: SaveExperienceSuggestionInput): void {
  if (input.commandId.trim() === '' || input.suggestionGroupId.trim() === ''
    || !/^sha256:[a-f0-9]{64}$/u.test(input.expectedRevisionDigest)
    || !/^sha256:[a-f0-9]{64}$/u.test(input.reviewDigest)
    || !/^sha256:[a-f0-9]{64}$/u.test(input.sourceDigest)
    || input.correlationId.trim() === ''
    || (input.causationId !== null && input.causationId.trim() === '')
    || !Number.isFinite(Date.parse(input.issuedAt))) {
    throw new ExperienceError('invalid_command', 'suggestion save identity is invalid')
  }
}

function validateRetrievalBuild(input: RetrievalProjectionBuild): void {
  const vectorsMatch = input.vectors === null || input.vectors.length === input.documents.length
  const identities = new Set<string>()
  const versions = new Set<string>()
  for (const document of input.documents) {
    try {
      parseRetrievalDocument(JSON.stringify(document))
    } catch (error) {
      throw new ExperienceError('invalid_command', 'retrieval document content is invalid', {}, { cause: error })
    }
    if (document.projectionVersion !== input.projectionVersion || identities.has(document.documentId)
      || versions.has(document.experienceVersionId)) {
      throw new ExperienceError('invalid_command', 'retrieval documents are not one unique projection generation')
    }
    identities.add(document.documentId)
    versions.add(document.experienceVersionId)
  }
  if (!vectorsMatch
    || !/^sha256:[a-f0-9]{64}$/u.test(input.sourceWatermarkDigest)
    || !/^sha256:[a-f0-9]{64}$/u.test(input.operationSettingsDigest)
    || (input.operationSettingsRevision !== null
      && (!Number.isSafeInteger(input.operationSettingsRevision) || input.operationSettingsRevision < 0))
    || !Number.isFinite(Date.parse(input.builtAt))) {
    throw new ExperienceError('invalid_command', 'retrieval projection build is inconsistent')
  }
  if (input.provider === 'disabled') {
    if (input.providerState !== 'disabled' || input.model !== null || input.failureCode !== null
      || input.vectors !== null) {
      throw new ExperienceError('invalid_command', 'disabled retrieval provider cannot identify or run a model')
    }
    return
  }
  if (input.provider !== 'transformers_js' || input.model === null) {
    throw new ExperienceError('invalid_command', 'configured retrieval provider requires an exact model identity')
  }
  if (input.model.modelId.trim() === '' || input.model.modelRevision.trim() === ''
    || !/^[a-f0-9]{64}$/u.test(input.model.artifactSha256)
    || !/^[a-f0-9]{64}$/u.test(input.model.tokenizerConfigBundleSha256)
    || !Number.isSafeInteger(input.model.dimension) || input.model.dimension < 1
    || !Number.isSafeInteger(input.model.maxInputTokens) || input.model.maxInputTokens < 32
    || input.model.normalization !== 'l2' || input.model.truncationPolicy !== 'truncate_end'
    || !['q8', 'fp32', 'fp16'].includes(input.model.dtype)
    || !['mean', 'cls'].includes(input.model.pooling)) {
    throw new ExperienceError('invalid_command', 'configured retrieval model identity is invalid')
  }
  const ready = input.providerState === 'ready' && input.vectors !== null && input.failureCode === null
  const unavailable = input.providerState === 'unavailable' && input.vectors === null && input.failureCode !== null
  const configuredEmpty = input.providerState === 'configured' && input.documents.length === 0
    && input.vectors === null && input.failureCode === null
  if (!ready && !unavailable && !configuredEmpty) {
    throw new ExperienceError('invalid_command', 'configured retrieval provider state is inconsistent')
  }
}

function validateRetrievalVector(vector: Float32Array, dimension: number): void {
  if (vector.length !== dimension) {
    throw new ExperienceError('embedding_wrong_dimension', 'retrieval vector dimension does not match generation')
  }
  if ([...vector].some(value => !Number.isFinite(value))) {
    throw new ExperienceError('embedding_non_finite_vector', 'retrieval vector contains a non-finite value')
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  if (!Number.isFinite(norm) || norm < 0.999 || norm > 1.001) {
    throw new ExperienceError('embedding_model_drift', 'retrieval vector is not unit normalized')
  }
}

function parseRetrievalManifest(value: string): ExperienceRetrievalManifestView {
  const parsed = JSON.parse(value) as ExperienceRetrievalManifestView
  const providerState = new Set(['disabled', 'configured', 'ready', 'unavailable'])
  const failureCodes = new Set([
    'embedding_provider_unavailable', 'embedding_artifact_missing', 'embedding_artifact_digest_mismatch',
    'embedding_model_drift', 'embedding_timeout', 'embedding_cancelled',
    'embedding_wrong_dimension', 'embedding_non_finite_vector',
  ])
  if (parsed.schemaVersion !== 'experience-retrieval-projection-manifest-v2'
    || parsed.projectionVersion !== 'experience-retrieval-projector-v2'
    || !Number.isSafeInteger(parsed.generation) || parsed.generation < 0
    || (parsed.state !== 'lexical_ready' && parsed.state !== 'dense_ready')
    || !Number.isSafeInteger(parsed.documentCount) || parsed.documentCount < 0
    || !Number.isSafeInteger(parsed.vectorCount) || parsed.vectorCount < 0
    || !/^sha256:[a-f0-9]{64}$/u.test(parsed.contentDigest)
    || !/^sha256:[a-f0-9]{64}$/u.test(parsed.sourceWatermarkDigest)
    || !/^sha256:[a-f0-9]{64}$/u.test(parsed.operationSettingsDigest)
    || (parsed.operationSettingsRevision !== null
      && (!Number.isSafeInteger(parsed.operationSettingsRevision) || parsed.operationSettingsRevision < 0))
    || !providerState.has(parsed.providerState)
    || !Number.isFinite(Date.parse(parsed.builtAt))
    || (parsed.failureCode !== null && !failureCodes.has(parsed.failureCode))) {
    throw new Error('retrieval manifest is invalid')
  }
  if ((parsed.state === 'dense_ready' && parsed.vectorCount !== parsed.documentCount)
    || (parsed.state === 'lexical_ready' && parsed.vectorCount !== 0)
    || (parsed.state === 'dense_ready' && parsed.providerState !== 'ready')) {
    throw new Error('retrieval manifest state is inconsistent')
  }
  const modelValues = [parsed.modelId, parsed.modelRevision, parsed.artifactSha256, parsed.dimension,
    parsed.dtype, parsed.pooling, parsed.queryPrefix, parsed.passagePrefix,
    parsed.tokenizerConfigBundleSha256, parsed.normalization, parsed.maxInputTokens, parsed.truncationPolicy]
  if (parsed.provider === 'disabled') {
    if (parsed.providerState !== 'disabled' || parsed.failureCode !== null
      || modelValues.some(item => item !== null)) {
      throw new Error('disabled retrieval manifest identifies a model')
    }
  } else if (parsed.provider === 'transformers_js') {
    if (parsed.providerState === 'disabled' || modelValues.some(item => item === null)
      || parsed.modelId!.trim() === '' || parsed.modelRevision!.trim() === ''
      || !Number.isSafeInteger(parsed.dimension) || parsed.dimension! < 1
      || !/^[a-f0-9]{64}$/u.test(parsed.artifactSha256!)
      || !/^[a-f0-9]{64}$/u.test(parsed.tokenizerConfigBundleSha256!)
      || !Number.isSafeInteger(parsed.maxInputTokens) || parsed.maxInputTokens! < 32
      || !['q8', 'fp32', 'fp16'].includes(parsed.dtype!)
      || !['mean', 'cls'].includes(parsed.pooling!)
      || parsed.normalization !== 'l2' || parsed.truncationPolicy !== 'truncate_end'
      || typeof parsed.queryPrefix !== 'string' || typeof parsed.passagePrefix !== 'string') {
      throw new Error('local retrieval manifest model identity is invalid')
    }
    if ((parsed.providerState === 'unavailable') !== (parsed.failureCode !== null)
      || (parsed.providerState === 'ready') !== (parsed.state === 'dense_ready')
      || (parsed.providerState === 'configured' && parsed.documentCount !== 0)) {
      throw new Error('local retrieval manifest availability is inconsistent')
    }
  } else {
    throw new Error('retrieval manifest provider is invalid')
  }
  return parsed
}

function parseRetrievalDocument(value: string): ExperienceRetrievalDocumentView {
  const parsed = JSON.parse(value) as ExperienceRetrievalDocumentView
  const fieldKeys: readonly (keyof ExperienceRetrievalDocumentView['fields'])[] = [
    'kind', 'taskFamily', 'goalOrIntent', 'scope', 'capabilitiesOrTools',
    'artifactsOrEntities', 'environment', 'validity', 'risk', 'typeSpecific',
  ]
  if (typeof parsed.documentId !== 'string' || typeof parsed.experienceVersionId !== 'string'
    || typeof parsed.experienceId !== 'string' || typeof parsed.versionContentDigest !== 'string'
    || parsed.projectionVersion !== 'experience-retrieval-projector-v2'
    || typeof parsed.lexicalText !== 'string' || typeof parsed.denseText !== 'string'
    || parsed.lexicalText.trim() === '' || parsed.denseText.trim() === ''
    || typeof parsed.fields !== 'object' || parsed.fields === null
    || fieldKeys.some(key => !Array.isArray(parsed.fields[key])
      || parsed.fields[key].some(item => typeof item !== 'string'))
    || !/^sha256:[a-f0-9]{64}$/u.test(parsed.contentDigest)) {
    throw new Error('retrieval document is invalid')
  }
  const contentDigest = suggestionDigest({
    projectionVersion: parsed.projectionVersion,
    experienceVersionId: parsed.experienceVersionId,
    versionContentDigest: parsed.versionContentDigest,
    fields: parsed.fields,
    views: { lexicalText: parsed.lexicalText, denseText: parsed.denseText },
  })
  if (contentDigest !== parsed.contentDigest
    || parsed.documentId !== `retrieval-document:${parsed.experienceVersionId}:${contentDigest.slice('sha256:'.length)}`) {
    throw new Error('retrieval document content identity is invalid')
  }
  return parsed
}

function parseRetrievalVector(value: string): Float32Array {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'number')) {
    throw new Error('retrieval vector is invalid')
  }
  return Float32Array.from(parsed)
}

function readRetrievalWithoutTransaction(
  handle: DatabaseSync,
  generation: RetrievalGenerationRow,
): ExperienceRetrievalProjectionView {
  const manifest = parseRetrievalManifest(generation.payloadJson)
  const documents = (handle.prepare(
    'SELECT payload_json FROM retrieval_documents WHERE generation = ? ORDER BY document_id',
  ).all(generation.generation) as Array<{ payload_json: string }>).map(row => parseRetrievalDocument(row.payload_json))
  if (documents.length !== manifest.documentCount) {
    throw new ProjectionStoreInvalidError('retrieval projection document count is inconsistent')
  }
  return { projectionKey: EXPERIENCE_RETRIEVAL_PROJECTION_KEY, schemaVersion: 2, manifest, documents }
}

function stableProjectionContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableProjectionContent)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key, item]) => key !== 'observedAt' && item !== undefined)
      .map(([key, item]) => [key, stableProjectionContent(item)]))
  }
  return value
}

function parseSession(value: string): SessionSuggestionScanView {
  return JSON.parse(value) as SessionSuggestionScanView
}

function parseSeed(value: string): ExperienceSuggestionSeedView {
  return JSON.parse(value) as ExperienceSuggestionSeedView
}

function parseGroup(value: string): ExperienceSuggestionGroupView {
  return JSON.parse(value) as ExperienceSuggestionGroupView
}

function terminalGroupBindings(group: ExperienceSuggestionGroupView): readonly {
  readonly suggestionGroupId: string
  readonly kernelIdentity: string
  readonly occurrenceIds: readonly string[]
}[] {
  const values = [{
    suggestionGroupId: group.suggestionGroupId,
    kernelIdentity: group.kernelIdentity,
    occurrenceIds: group.occurrences.map(occurrence => occurrence.occurrenceId).sort(),
  }, ...(group.consolidationDetail?.sourceGroups ?? []).map(source => ({
    suggestionGroupId: source.suggestionGroupId,
    kernelIdentity: source.kernelIdentity,
    occurrenceIds: [...source.occurrenceIds].sort(),
  }))]
  return [...new Map(values.map(value => [value.suggestionGroupId, value] as const)).values()]
    .sort((left, right) => left.suggestionGroupId.localeCompare(right.suggestionGroupId))
}

function assertSuggestionReceiptMatchesGroup(
  input: SaveExperienceSuggestionInput,
  group: ExperienceSuggestionGroupView,
  receipt: SuggestionSaveDomainReceipt,
): void {
  const expectedSourceGroups = suggestionSourceGroupIds(group)
  const actualSourceGroups = [...receipt.sourceSuggestionGroupIds].sort()
  const expectedOccurrences = group.occurrences.map(occurrence => occurrence.occurrenceId).sort()
  const actualOccurrences = [...receipt.occurrenceIds].sort()
  if (receipt.commandId !== input.commandId || receipt.suggestionGroupId !== group.suggestionGroupId
    || receipt.kernelIdentity !== group.kernelIdentity || receipt.reviewDigest !== input.reviewDigest
    || receipt.sourceDigest !== input.sourceDigest
    || receipt.suggestionRevisionDigest !== input.expectedRevisionDigest
    || expectedSourceGroups.length !== actualSourceGroups.length
    || expectedSourceGroups.some((value, index) => value !== actualSourceGroups[index])
    || expectedOccurrences.length !== actualOccurrences.length
    || expectedOccurrences.some((value, index) => value !== actualOccurrences[index])) {
    throw new ExperienceError('database_schema_invalid', 'Canonical suggestion receipt does not match the saved group')
  }
}

function receiptTerminalGroupBindings(
  handle: DatabaseSync,
  generation: number,
  receipt: SuggestionSaveDomainReceipt,
): ReturnType<typeof terminalGroupBindings> {
  const expectedIds = new Set([
    receipt.suggestionGroupId,
    ...receipt.sourceSuggestionGroupIds,
  ])
  const legacySingleGroup = receipt.sourceSuggestionGroupIds.length === 1
    && receipt.sourceSuggestionGroupIds[0] === receipt.suggestionGroupId
  const known = new Map<string, ReturnType<typeof terminalGroupBindings>[number]>()
  for (const groupId of [...expectedIds]) {
    const row = handle.prepare(
      'SELECT payload_json FROM suggestion_groups WHERE generation = ? AND group_id = ?',
    ).get(generation, groupId) as { payload_json: string } | undefined
    if (row === undefined) continue
    for (const binding of terminalGroupBindings(parseGroup(row.payload_json))) {
      known.set(binding.suggestionGroupId, binding)
      if (legacySingleGroup || expectedIds.has(binding.suggestionGroupId)) {
        expectedIds.add(binding.suggestionGroupId)
      }
    }
  }
  return [...expectedIds].sort().map(suggestionGroupId => known.get(suggestionGroupId) ?? {
    suggestionGroupId,
    kernelIdentity: receipt.kernelIdentity,
    occurrenceIds: [...receipt.occurrenceIds].sort(),
  })
}

function pragma(handle: DatabaseSync, name: 'application_id' | 'user_version'): number {
  const row = handle.prepare(`PRAGMA ${name}`).get() as Record<string, number>
  return row[name] ?? 0
}

function listTables(handle: DatabaseSync): string[] {
  return (handle.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
  ).all() as Array<{ name: string }>).map(row => row.name)
}

async function ensureOwnerOnlyFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const mode = (await stat(path)).mode & 0o777
  if ((mode & 0o077) !== 0) {
    throw new ExperienceError('database_permissions_unsafe', 'Experience suggestion projection is not owner-only', {
      mode: mode.toString(8),
    })
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function isRecoverableProjectionCorruption(error: unknown): boolean {
  if (error instanceof ProjectionStoreInvalidError) return true
  const message = error instanceof Error ? error.message : String(error)
  return /(?:file is not a database|database disk image is malformed|SQLITE_CORRUPT)/iu.test(message)
}

/** Derive the one sidecar path without changing the canonical database schema. */
export function suggestionProjectionPath(databasePath: string): string {
  return databasePath === ':memory:' ? ':memory:' : `${resolve(databasePath)}.projection.sqlite`
}
