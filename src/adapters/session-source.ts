import { createHash } from 'node:crypto'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { assertSafeText } from '../application/content-policy.js'
import { ExperienceError } from '../errors.js'
import { brandedId } from '../ids.js'
import type {
  BoundedSourceRecord,
  EpisodeInspectionView,
  EpisodeLocatorInput,
  EpisodeRefView,
  SourceRefView,
} from '../types.js'

/** Source-reader limits resolved from validated Host configuration. */
export interface SessionSourceConfig {
  readonly maxRecords: number
  readonly maxRecordBytes: number
  readonly maxTotalBytes: number
}

/** One complete turn cut returned to the local detector without exposing backend artifacts. */
export interface SessionTrajectorySlice {
  readonly episodeRef: EpisodeRefView
  readonly records: readonly BoundedSourceRecord[]
  readonly turn: number
  readonly terminationReason: EpisodeInspectionView['termination']['reason']
  readonly blockedReason: 'sensitive_content' | null
}

/** One recent Session read result from an all-or-nothing corpus generation. */
export interface RecentSessionTrajectoryScan {
  readonly sessionId: string
  readonly workspaceRoot: string | null
  readonly sessionCreatedAt: string
  readonly lastEventAt: string | null
  readonly capturedThroughSeq: number | null
  readonly lastCompletedEndSeq: number | null
  readonly slices: readonly SessionTrajectorySlice[]
}

/** Atomic recent-N scan input consumed by the sole Experience projection worker. */
export interface RecentSessionTrajectoryBatch {
  readonly sourceWatermarkDigest: string
  readonly sessions: readonly RecentSessionTrajectoryScan[]
}

type SessionSourceQuery = Pick<SessionQueryEngine, 'observeSession'>
  & Partial<Pick<SessionQueryEngine, 'listSessions' | 'listEvents' | 'readSession' | 'readEvent'>>

/** Read terminal DSH Session events without copying the Session into Experience storage. */
export class DshSessionSource {
  /** Bind the reader to the live-preferred Session query owner. */
  constructor(
    private readonly query: SessionSourceQuery,
    private readonly config: SessionSourceConfig,
  ) {}

  /**
   * Enumerate recent logical Sessions and rebuild complete turn slices from public Query APIs.
   * Event metadata selects recent work; exact log reads remain the source of slice identity.
   */
  async scanRecentCompletedTurns(
    limit: number,
    ttlMs: number,
    now = new Date(),
    signal?: AbortSignal,
  ): Promise<RecentSessionTrajectoryBatch> {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new ExperienceError('invalid_command', 'recent Session limit and TTL must be positive safe integers')
    }
    const listSessions = this.query.listSessions?.bind(this.query)
    const listEvents = this.query.listEvents?.bind(this.query)
    const readSession = this.query.readSession?.bind(this.query)
    const readEvent = this.query.readEvent?.bind(this.query)
    if (listSessions === undefined || listEvents === undefined || readSession === undefined || readEvent === undefined) {
      throw new ExperienceError('source_unresolvable', 'DSH Session Query does not expose recent-session read APIs')
    }
    signal?.throwIfAborted()
    let listed: Awaited<ReturnType<SessionQueryEngine['listSessions']>>
    try {
      listed = await listSessions(signal)
    } catch (error) {
      signal?.throwIfAborted()
      throw new ExperienceError('source_unresolvable', 'DSH Session corpus is unavailable', {}, { cause: error })
    }
    const activity: Array<{
      readonly header: SessionHeader
      readonly lastEventAt: number
    }> = []
    for (const record of listed) {
      signal?.throwIfAborted()
      try {
        const events = await listEvents(record.header.id)
        const last = events.at(-1)
        activity.push({
          header: record.header,
          lastEventAt: last?.time ?? record.header.createdAt,
        })
      } catch (error) {
        signal?.throwIfAborted()
        throw new ExperienceError(
          'source_unresolvable',
          'DSH Session event metadata is unavailable',
          {},
          { cause: error },
        )
      }
    }
    const cutoff = now.getTime() - ttlMs
    const selected = activity
      .filter(item => item.lastEventAt >= cutoff)
      .sort((left, right) => right.lastEventAt - left.lastEventAt
        || right.header.createdAt - left.header.createdAt
        || String(left.header.id).localeCompare(String(right.header.id)))
      .slice(0, limit)
    const scans: RecentSessionTrajectoryScan[] = []
    for (const item of selected) {
      signal?.throwIfAborted()
      try {
        const snapshot = await readSession(item.header.id)
        if (snapshot.session.id !== item.header.id) throw new Error('Session identity changed during read')
        const slices = completedTurnSlices(snapshot.session, snapshot.events, this.config, now.toISOString())
          .filter(slice => Date.parse(slice.episodeRef.occurredAt.end) >= cutoff)
          .slice(-64)
        const latestSlice = slices.at(-1)
        if (latestSlice !== undefined) {
          const terminal = await readEvent({
            sessionId: snapshot.session.id,
            seq: SessionSeq(latestSlice.episodeRef.eventEnd),
          }, signal)
          if (terminal.target.type !== 'turn/end' || terminal.target.seq !== latestSlice.episodeRef.eventEnd) {
            throw new Error('Session terminal boundary changed during read')
          }
        }
        const last = snapshot.events.at(-1)
        scans.push({
          sessionId: String(snapshot.session.id),
          workspaceRoot: snapshot.session.cwd ?? null,
          sessionCreatedAt: new Date(snapshot.session.createdAt).toISOString(),
          lastEventAt: last === undefined ? null : new Date(last.time).toISOString(),
          capturedThroughSeq: last?.seq ?? null,
          lastCompletedEndSeq: slices.at(-1)?.episodeRef.eventEnd ?? null,
          slices,
        })
      } catch (error) {
        signal?.throwIfAborted()
        throw new ExperienceError(
          'source_unresolvable',
          'A recent DSH Session cannot be read atomically',
          {},
          { cause: error },
        )
      }
    }
    return {
      sourceWatermarkDigest: `sha256:${sha256(canonicalJson(scans.map(scan => ({
        sessionId: scan.sessionId,
        capturedThroughSeq: scan.capturedThroughSeq,
        lastCompletedEndSeq: scan.lastCompletedEndSeq,
      }))))}`,
      sessions: scans,
    }
  }

  /** Inspect and validate one exact terminal Session interval. */
  async inspect(
    locator: EpisodeLocatorInput,
    signal?: AbortSignal,
    limits: SessionSourceConfig = this.config,
  ): Promise<EpisodeInspectionView> {
    validateLocator(locator)
    signal?.throwIfAborted()
    const id = SessionId(locator.sessionId)
    let observation: Awaited<ReturnType<SessionQueryEngine['observeSession']>>
    try {
      observation = await this.query.observeSession(id, {
        projectionMode: 'none',
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      signal?.throwIfAborted()
      throw new ExperienceError('source_unresolvable', 'DSH Session source is unavailable', {}, { cause: error })
    }
    try {
      signal?.throwIfAborted()
      if (observation.header.id !== id || observation.events.length === 0) {
        throw new ExperienceError('source_unresolvable', 'Session source identity or event range is unavailable')
      }
      const first = observation.events[0]!
      const last = observation.events.at(-1)!
      const trailingSeedBoundary = last.type === 'session/end-seed' ? last : undefined
      const terminal = trailingSeedBoundary === undefined ? last : observation.events.at(-2)
      if (terminal === undefined) {
        throw new ExperienceError('episode_not_terminal', 'Session has no completed turn before its seed boundary')
      }
      const eventStart = locator.eventStart ?? first.seq
      const eventEnd = locator.eventEnd ?? terminal.seq
      if (eventStart !== first.seq || eventEnd !== terminal.seq) {
        throw new ExperienceError('source_unresolvable', 'the first vertical requires the exact complete Session range', {
          availableStart: first.seq,
          availableEnd: terminal.seq,
        })
      }
      if (terminal.type !== 'turn/end') {
        throw new ExperienceError('episode_not_terminal', 'Episode selection must end at a turn/end event')
      }
      const eventCut = observation.events.slice(0, terminal.seq - first.seq + 1)
      const contentDigest = `sha256:${sha256(canonicalEventCut(eventCut))}`
      if (locator.contentDigest !== undefined && locator.contentDigest !== contentDigest) {
        throw new ExperienceError('source_unresolvable', 'Session content changed after Episode selection', {
          expectedDigest: locator.contentDigest,
          actualDigest: contentDigest,
        })
      }
      const observedAt = new Date().toISOString()
      const episodeRef: EpisodeRefView = {
        episodeRefId: brandedId<'ExperienceEpisodeRefId'>(
          `episode:${sha256(`${id}:${String(eventStart)}:${String(eventEnd)}:${contentDigest}`)}`,
          'episodeRefId',
        ),
        sourceSystem: 'dsh-session',
        sessionOrRunId: id,
        eventStart,
        eventEnd,
        occurredAt: {
          start: new Date(first.time).toISOString(),
          end: new Date(terminal.time).toISOString(),
        },
        contentDigest,
        redactionState: 'bounded_excerpt',
      }
      const selected = eventCut.filter(isProposalRecord)
      const records: BoundedSourceRecord[] = []
      let usedBytes = 0
      for (const event of selected) {
        if (records.length >= limits.maxRecords) break
        const serialized = JSON.stringify(event)
        assertSafeText(serialized, `Session event ${String(event.seq)}`)
        const excerpt = boundedUtf8(serialized, limits.maxRecordBytes)
        const bytes = Buffer.byteLength(excerpt)
        if (usedBytes + bytes > limits.maxTotalBytes) break
        usedBytes += bytes
        records.push({
          sourceRef: sessionEventRef(id, event, observedAt),
          eventType: event.type,
          excerpt,
        })
      }
      if (records.length === 0) {
        throw new ExperienceError('source_unresolvable', 'Session contains no proposal-safe source records')
      }
      const terminalSourceRef = sessionEventRef(id, terminal, observedAt)
      return {
        episodeRef,
        sourceRefs: records.map(record => record.sourceRef),
        records,
        termination: {
          state: 'terminated',
          reason: turnTerminationReason(terminal.data),
          terminalSourceRefId: terminalSourceRef.sourceRefId,
        },
        recordCount: records.length,
        omittedRecordCount: selected.length - records.length,
      }
    } finally {
      observation[Symbol.dispose]()
    }
  }
}

function sessionEventRef(sessionId: string, event: SessionEvent, observedAt: string): SourceRefView {
  const serialized = JSON.stringify(event)
  const digest = `sha256:${sha256(serialized)}`
  return {
    sourceRefId: brandedId<'ExperienceSourceRefId'>(
      `source:${sha256(`dsh-session:${sessionId}:${String(event.seq)}:${digest}`)}`,
      'sourceRefId',
    ),
    sourceSystem: 'dsh-session',
    sourceKind: event.type === 'tool/result'
      ? 'tool_result'
      : event.type === 'user/message' ? 'user_instruction' : 'session_event',
    locator: `dsh-session:${sessionId}#${String(event.seq)}`,
    ownerScope: `session:${sessionId}`,
    accessScope: 'local_owner',
    occurredAt: new Date(event.time).toISOString(),
    observedAt,
    contentDigest: digest,
    redactionState: 'bounded_excerpt',
  }
}

function completedTurnSlices(
  header: SessionHeader,
  events: readonly SessionEvent[],
  limits: SessionSourceConfig,
  observedAt: string,
): SessionTrajectorySlice[] {
  const slices: SessionTrajectorySlice[] = []
  let startIndex: number | null = null
  let activeTurn: number | null = null
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!
    if (event.type === 'turn/start') {
      startIndex = index
      activeTurn = event.data.turn
      continue
    }
    if (event.type !== 'turn/end' || startIndex === null || activeTurn !== event.data.turn) continue
    const selected = events.slice(startIndex, index + 1)
    if (event.data.reason.kind === 'completed') {
      const first = selected[0]!
      const contentDigest = `sha256:${sha256(canonicalEventCut(selected))}`
      const episodeRef: EpisodeRefView = {
        episodeRefId: brandedId<'ExperienceEpisodeRefId'>(
          `episode:${sha256(`${String(header.id)}:${String(first.seq)}:${String(event.seq)}:${contentDigest}`)}`,
          'episodeRefId',
        ),
        sourceSystem: 'dsh-session',
        sessionOrRunId: String(header.id),
        eventStart: first.seq,
        eventEnd: event.seq,
        occurredAt: {
          start: new Date(first.time).toISOString(),
          end: new Date(event.time).toISOString(),
        },
        contentDigest,
        redactionState: 'bounded_excerpt',
      }
      try {
        const records = boundedSourceRecords(String(header.id), selected, limits, observedAt)
        if (records.length > 0) {
          slices.push({
            episodeRef,
            records,
            turn: activeTurn,
            terminationReason: 'completed',
            blockedReason: null,
          })
        }
      } catch (error) {
        if (!(error instanceof ExperienceError) || error.code !== 'sensitive_content_unauthorized') throw error
        slices.push({
          episodeRef,
          records: [],
          turn: activeTurn,
          terminationReason: 'completed',
          blockedReason: 'sensitive_content',
        })
      }
    }
    startIndex = null
    activeTurn = null
  }
  return slices
}

function boundedSourceRecords(
  sessionId: string,
  events: readonly SessionEvent[],
  limits: SessionSourceConfig,
  observedAt: string,
): BoundedSourceRecord[] {
  const records: BoundedSourceRecord[] = []
  let usedBytes = 0
  for (const event of events.filter(isProposalRecord)) {
    if (records.length >= limits.maxRecords) break
    const serialized = JSON.stringify(event)
    assertSafeText(serialized, `Session event ${String(event.seq)}`)
    const excerpt = boundedUtf8(serialized, limits.maxRecordBytes)
    const bytes = Buffer.byteLength(excerpt)
    if (usedBytes + bytes > limits.maxTotalBytes) break
    usedBytes += bytes
    records.push({ sourceRef: sessionEventRef(sessionId, event, observedAt), eventType: event.type, excerpt })
  }
  return records
}

function isProposalRecord(event: SessionEvent): boolean {
  if (event.type === 'user/message') {
    const data = asRecord(event.data)
    const source = asRecord(data?.source)
    return source?.kind === 'user'
  }
  return event.type === 'tool/call'
    || event.type === 'tool/result'
    || event.type === 'assistant/message'
    || event.type === 'step/start'
    || event.type === 'step/end'
    || event.type === 'turn/end'
}

function turnTerminationReason(value: unknown): EpisodeInspectionView['termination']['reason'] {
  const data = asRecord(value)
  const reason = asRecord(data?.reason)
  switch (reason?.kind) {
    case 'completed': return 'completed'
    case 'aborted': return 'aborted'
    case 'error': return 'error'
    case 'max-tokens': return 'max_tokens'
    case 'interrupted': return 'interrupted'
    default: return 'unknown'
  }
}

function validateLocator(locator: EpisodeLocatorInput): void {
  if (locator.sessionId.trim() === '') {
    throw new ExperienceError('required_field_missing', 'sessionId is required')
  }
  for (const [field, value] of [['eventStart', locator.eventStart], ['eventEnd', locator.eventEnd]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new ExperienceError('invalid_command', `${field} must be a non-negative safe integer`)
    }
  }
  if (locator.eventStart !== undefined && locator.eventEnd !== undefined && locator.eventEnd < locator.eventStart) {
    throw new ExperienceError('invalid_command', 'eventEnd must not precede eventStart')
  }
}

function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value
  const suffix = maxBytes >= Buffer.byteLength('…') ? '…' : ''
  const contentLimit = maxBytes - Buffer.byteLength(suffix)
  let bounded = ''
  let bytes = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character)
    if (bytes + characterBytes > contentLimit) break
    bounded += character
    bytes += characterBytes
  }
  return `${bounded}${suffix}`
}

function canonicalEventCut(events: readonly SessionEvent[]): string {
  return `${events.map(event => canonicalJson(event)).join('\n')}\n`
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new ExperienceError('source_unresolvable', 'Session event contains a non-JSON value')
  }
  return serialized
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
