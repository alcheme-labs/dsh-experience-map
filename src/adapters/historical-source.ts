import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { assertSafeText } from '../application/content-policy.js'
import { ExperienceError } from '../errors.js'
import { brandedId } from '../ids.js'
import type { BoundedSourceRecord, SourceRefView } from '../types.js'

/** One deployment-configured exact record in the M0 historical fallback. */
export interface HistoricalRecordConfig {
  readonly line: number
  readonly digest: string
  readonly bytes: number
}

/** Optional read-only historical source selected and verified during M0. */
export interface HistoricalSourceConfig {
  readonly path: string
  readonly runId: string
  readonly aggregateDigest: string
  readonly records: HistoricalRecordConfig[]
}

/** Bounds applied before historical records can enter the proposal input. */
export interface HistoricalSourceLimits {
  readonly maxRecords: number
  readonly maxRecordBytes: number
  readonly maxTotalBytes: number
}

/** Re-read only the exact M0-selected records; never writes or broadens their range. */
export class HistoricalSource {
  /** Bind a disabled or exact historical source configuration. */
  constructor(
    private readonly config: HistoricalSourceConfig | undefined,
    private readonly limits: HistoricalSourceLimits,
  ) {}

  /** Return verified bounded records, or an empty set when no fallback is configured. */
  async inspect(limits: HistoricalSourceLimits = this.limits): Promise<readonly BoundedSourceRecord[]> {
    if (this.config === undefined) return []
    if (this.config.records.length === 0) {
      throw new ExperienceError('source_unresolvable', 'historical source configuration has no selected records')
    }
    if (this.config.records.length > limits.maxRecords) {
      throw new ExperienceError('source_unresolvable', 'historical source selection exceeds the configured record limit')
    }
    let text: string
    try {
      text = await readFile(this.config.path, 'utf8')
    } catch (error) {
      throw new ExperienceError('source_unresolvable', 'historical source artifact is unavailable', {}, { cause: error })
    }
    const lines = text.match(/[^\n]*(?:\n|$)/gu) ?? []
    const selected = this.config.records.map((expected) => {
      if (!Number.isSafeInteger(expected.line) || expected.line < 1) {
        throw new ExperienceError('source_unresolvable', 'historical source line is invalid')
      }
      const body = lines[expected.line - 1]
      if (body === undefined) {
        throw new ExperienceError('source_unresolvable', `historical source omitted L${String(expected.line)}`)
      }
      const digest = `sha256:${sha256(body)}`
      if (digest !== expected.digest || Buffer.byteLength(body) !== expected.bytes) {
        throw new ExperienceError('source_unresolvable', `historical source record L${String(expected.line)} changed`)
      }
      if (expected.bytes > limits.maxRecordBytes) {
        throw new ExperienceError('source_unresolvable', `historical source record L${String(expected.line)} exceeds its byte limit`)
      }
      assertSafeText(body, `historical source L${String(expected.line)}`)
      return { expected, body, digest }
    })
    const aggregate = `sha256:${sha256(selected.map(item => item.body).join(''))}`
    if (aggregate !== this.config.aggregateDigest) {
      throw new ExperienceError('source_unresolvable', 'historical source aggregate changed')
    }
    const totalBytes = selected.reduce((total, item) => total + item.expected.bytes, 0)
    if (totalBytes > limits.maxTotalBytes) {
      throw new ExperienceError('source_unresolvable', 'historical source selection exceeds the configured total byte limit')
    }
    const observedAt = new Date().toISOString()
    return selected.map(({ expected, body, digest }) => {
      const locator = `codex-rollout:${this.config!.runId}#L${String(expected.line)}`
      const sourceRef: SourceRefView = {
        sourceRefId: brandedId<'ExperienceSourceRefId'>(`source:${sha256(`${locator}:${digest}`)}`, 'sourceRefId'),
        sourceSystem: 'codex-rollout',
        sourceKind: 'external_document',
        locator,
        ownerScope: `run:${this.config!.runId}`,
        accessScope: 'local_owner',
        occurredAt: parseOccurredAt(body) ?? observedAt,
        observedAt,
        contentDigest: digest,
        redactionState: 'bounded_excerpt',
      }
      return { sourceRef, eventType: 'historical_record', excerpt: body }
    })
  }
}

function parseOccurredAt(body: string): string | undefined {
  try {
    const value: unknown = JSON.parse(body)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    if (typeof record.timestamp === 'string' && Number.isFinite(Date.parse(record.timestamp))) return record.timestamp
    if (typeof record.time === 'number' && Number.isFinite(record.time)) return new Date(record.time).toISOString()
    return undefined
  } catch {
    return undefined
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
