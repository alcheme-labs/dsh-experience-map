import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { EXTRACTION_BUILDER_VERSION, type ExtractionEvidenceConfig } from '../adapters/extraction-evidence.js'
import type { DshSessionSource, RecentSessionTrajectoryScan } from '../adapters/session-source.js'
import {
  detectSuggestionSeed,
  SUGGESTION_DETECTOR_VERSION,
  TRAJECTORY_SEGMENTER_VERSION,
} from '../domain/automatic-suggestion.js'
import {
  materializeSuggestionGroups,
  SUGGESTION_MATERIALIZER_VERSION,
} from '../domain/suggestion-materializer.js'
import type { ExperienceProjectionStore, SuggestionSessionAnalysis, SuggestionSessionCommit } from '../persistence/projection-store.js'
import type {
  ExperienceSuggestionGroupView,
  ExperienceSuggestionSeedView,
  SuggestionProjectionView,
  SuggestionSaveDomainReceipt,
} from '../types.js'
import type { RuntimeSettingsSnapshot } from '../runtime-settings.js'
import { suggestionDigest } from '../domain/automatic-suggestion.js'
import { ExperienceError } from '../errors.js'

export const SUGGESTION_PROJECTOR_VERSION = [
  TRAJECTORY_SEGMENTER_VERSION,
  SUGGESTION_DETECTOR_VERSION,
  EXTRACTION_BUILDER_VERSION,
  SUGGESTION_MATERIALIZER_VERSION,
].join('+')

/** E1/E2 defaults; E5 captures live user settings once per bounded reconciliation. */
export interface ExperienceProjectionPolicy extends ExtractionEvidenceConfig {
  readonly recentSessionLimit: number
  readonly suggestionTtlMs: number
  readonly pollIntervalMs: number
  readonly maxInlineFieldBytes: number
}

export const DEFAULT_EXPERIENCE_PROJECTION_POLICY: ExperienceProjectionPolicy = {
  recentSessionLimit: 8,
  suggestionTtlMs: 14 * 24 * 60 * 60 * 1_000,
  pollIntervalMs: 30_000,
  maxInlineFieldBytes: 32_768,
  maxEvidenceItems: 64,
  maxEvidenceItemBytes: 4_096,
  maxEvidencePacketBytes: 65_536,
}


type RecentSessionSource = Pick<DshSessionSource, 'scanRecentCompletedTurns'>
  & Partial<Pick<DshSessionSource, 'analysisPolicyDigest'>>

/** One worker owns observed task completion, durable retries and atomic projection activation. */
export class ExperienceProjectionWorker {
  private active = true
  private installed = false
  private readonly stopping = new AbortController()
  private readController: AbortController | undefined
  private requested = false
  private retrievalRequested = false
  private running: Promise<SuggestionProjectionView> | undefined
  private backgroundTimer: ReturnType<typeof setTimeout> | undefined
  private lastGroupsDigest: string | undefined
  private lastGroups: ExperienceSuggestionGroupView[] = []

  constructor(
    private readonly ctx: Context,
    private readonly source: RecentSessionSource,
    private readonly store: ExperienceProjectionStore,
    private readonly policy: ExperienceProjectionPolicy,
    private readonly savedReceipts: () => readonly SuggestionSaveDomainReceipt[] = () => [],
    private readonly rebuildRetrieval: (signal?: AbortSignal) => Promise<void> = async () => undefined,
    private readonly runtimeSettings?: () => RuntimeSettingsSnapshot,
    private readonly consolidateGroups?: (
      groups: readonly ExperienceSuggestionGroupView[], signal?: AbortSignal,
    ) => Promise<ExperienceSuggestionGroupView[]>,
  ) { this.store.prepareObservedTaskLearning() }

  install(): void {
    this.installed = true
    this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (!this.active || event.type !== 'turn/end') return
      if (this.runtimeSettings?.().values.automaticSuggestionDetection === false) return
      this.store.requestSession(String(session.id), event.seq)
      this.retrievalRequested = true
      void this.kick(new Date()).catch(() => this.warn())
    }, { global: true })
    this.ctx.effect(() => {
      const timer = setInterval(() => {
        // Only reconcile queued notifications, TTL and saved Versions. Never discover chat history.
        this.retrievalRequested = true
        if (this.running !== undefined) return
        void this.kick(new Date()).catch(() => this.warn())
      }, this.policy.pollIntervalMs)
      timer.unref()
      return () => { clearInterval(timer); return this.stop() }
    }, 'experience-map incremental Session projection worker')
  }

  /** Reconcile already observed task requests and receipts; never enumerate Session history. */
  drain(now = new Date()): Promise<SuggestionProjectionView> {
    this.retrievalRequested = true
    return this.kick(now)
  }

  private warn(): void {
    this.ctx.logger('experience-map').warn('Suggestion reconciliation failed; the last good generation remains active')
  }

  private kick(now: Date): Promise<SuggestionProjectionView> {
    if (!this.active) return Promise.resolve(this.store.read())
    this.requested = true
    if (this.running !== undefined) return this.running
    const running = this.drainLoop(now).finally(() => {
      if (this.running === running) this.running = undefined
      this.readController = undefined
      this.scheduleBackground()
    })
    this.running = running
    return running
  }

  async stop(): Promise<void> {
    this.active = false
    this.requested = false
    clearTimeout(this.backgroundTimer)
    this.stopping.abort()
    this.readController?.abort()
    await this.running?.catch(() => undefined)
  }

  private scheduleBackground(): void {
    clearTimeout(this.backgroundTimer)
    if (!this.active || !this.installed
      || this.runtimeSettings?.().values.automaticSuggestionDetection === false) return
    if (this.store.nextSessionJob(Date.now()) === undefined) return // Poll handles retry deadlines.
    this.backgroundTimer = setTimeout(() => {
      void this.kick(new Date()).catch(() => this.warn())
    }, 100)
    this.backgroundTimer.unref()
  }

  private async drainLoop(now: Date): Promise<SuggestionProjectionView> {
    let view = this.store.read()
    while (this.active && this.requested) {
      this.requested = false
      const startedAt = now.toISOString()
      if (this.retrievalRequested) {
        this.retrievalRequested = false
        view = this.store.reconcileSaved(this.savedReceipts())
        await this.rebuildRetrieval(this.stopping.signal)
      }
      if (!this.active) return view
      const snapshot = this.runtimeSettings?.()
      const policy: ExperienceProjectionPolicy = snapshot === undefined ? this.policy : {
        ...this.policy,
        recentSessionLimit: snapshot.values.recentSuggestionSessionLimit,
        suggestionTtlMs: snapshot.values.suggestionTtlMs,
        maxInlineFieldBytes: snapshot.values.maxInlineFieldBytes,
        maxEvidenceItems: snapshot.values.maxEvidenceItems,
        maxEvidenceItemBytes: snapshot.values.maxEvidenceItemBytes,
        maxEvidencePacketBytes: snapshot.values.maxEvidencePacketBytes,
      }
      if (snapshot !== undefined && !snapshot.values.automaticSuggestionDetection) {
        return this.store.rebuild({projectorVersion:SUGGESTION_PROJECTOR_VERSION,sourceWatermarkDigest:snapshot.digest,
          sessions:[],seeds:[],groups:[],startedAt,completedAt:new Date().toISOString(),
          retentionCutoffAt:new Date(Date.now()-policy.suggestionTtlMs).toISOString()})
      }
      const buildKey = suggestionDigest({sourceLimits:this.source.analysisPolicyDigest ?? null,version:SUGGESTION_PROJECTOR_VERSION,ttl:policy.suggestionTtlMs,
        items:policy.maxEvidenceItems,itemBytes:policy.maxEvidenceItemBytes,packetBytes:policy.maxEvidencePacketBytes})
      const job = this.store.nextSessionJob(now.getTime())
      let operationController: AbortController | undefined
      let commit: SuggestionSessionCommit | undefined
      let sourceFailed = false
      let scanned: RecentSessionTrajectoryScan | undefined
      if (job !== undefined) {
        const controller = new AbortController()
        const signal = AbortSignal.any([controller.signal,this.stopping.signal])
        operationController = controller
        this.readController = controller
        try {
          // Exactly one body-bearing read. A full-corpus scan is never called by this worker.
          const batch = await this.source.scanRecentCompletedTurns(1,policy.suggestionTtlMs,now,signal,[job.sessionId],job.completedEndSeqs)
          signal.throwIfAborted()
          const scan = batch.sessions[0]
          if (batch.sessions.length !== 1 || scan?.sessionId !== job.sessionId) throw new Error('Session point read identity mismatch')
          scanned = scan
        } catch {
          if (!this.active) return view
          if (controller.signal.aborted) { now = new Date(); continue } // Keep durable pending work.
          this.store.retrySessionJob(job,now.getTime())
          sourceFailed = true
        } finally {
          if (scanned === undefined) {
            this.readController = undefined
          }
        }
      }
      if (!this.active) return view
      if (scanned !== undefined && job !== undefined) {
        const analysis = this.analyze(scanned,job.analysis,policy,job.completedEndSeqs,job.buildKey===buildKey)
        commit = {job,analysis,buildKey,sourceKey:scanned.sourceKey ?? null}
      }
      const analyses = this.store.readSessionAnalyses().filter(value=>value.scan.sessionId!==commit?.job.sessionId)
      if (commit !== undefined) analyses.push(commit.analysis)
      // Keep an existing published inbox when no notified analysis has been produced yet.
      if (job === undefined && analyses.length === 0 && view.sessions.length > 0) return view
      const completedAt = new Date().toISOString()
      const cutoff = Date.parse(completedAt)-policy.suggestionTtlMs
      const selected = analyses.filter(value=>Date.parse(value.scan.lastEventAt ?? value.scan.sessionCreatedAt)>=cutoff)
        .sort((a,b)=>Date.parse(b.scan.lastEventAt ?? b.scan.sessionCreatedAt)-Date.parse(a.scan.lastEventAt ?? a.scan.sessionCreatedAt)
          || Date.parse(b.scan.sessionCreatedAt)-Date.parse(a.scan.sessionCreatedAt) || a.scan.sessionId.localeCompare(b.scan.sessionId))
        .slice(0,policy.recentSessionLimit)
      const seeds = selected.flatMap(value=>value.seeds).map(seed=>({...seed,
        expiresAt:new Date(Math.min(Date.parse(seed.expiresAt),Date.parse(seed.detectedAt)+policy.suggestionTtlMs)).toISOString(),
      })).filter(seed=>Date.parse(seed.expiresAt)>Date.parse(completedAt))
      const ids = new Set(seeds.map(seed=>seed.occurrenceId))
      const sessions = selected.map(value=>({...value.scan,occurrenceIds:value.scan.occurrenceIds.filter(id=>ids.has(id))}))
      const dispositions = this.store.read().dispositions
      const groupDigest = suggestionDigest({seeds,dispositions,maxBytes:policy.maxInlineFieldBytes,
        settingsDigest:snapshot?.digest ?? null,retrievalDigest:this.store.readRetrieval().manifest.contentDigest})
      let groups = this.lastGroupsDigest === groupDigest ? this.lastGroups
        : materializeSuggestionGroups(seeds,policy.maxInlineFieldBytes,new Set(dispositions.map(d=>d.suggestionGroupId)))
      if (this.lastGroupsDigest !== groupDigest && this.consolidateGroups !== undefined) {
        try { groups = await this.consolidateGroups(groups,operationController===undefined ? this.stopping.signal
          : AbortSignal.any([operationController.signal,this.stopping.signal])) }
        catch { if (this.active) this.ctx.logger('experience-map').warn('Semantic suggestion consolidation failed; exact kernel grouping remains active') }
      }
      if (!this.active) return view
      if (operationController?.signal.aborted) { now = new Date(); continue }
      this.readController = undefined
      view = this.store.rebuild({projectorVersion:SUGGESTION_PROJECTOR_VERSION,
        sourceWatermarkDigest:suggestionDigest({buildKey,sessions,seeds:seeds.map(seed=>seed.occurrenceId)}),
        sessions,seeds,groups,startedAt,completedAt,retentionCutoffAt:new Date(cutoff).toISOString(),...commit===undefined ? {} : {sessionCommit:commit}})
      this.lastGroupsDigest = groupDigest
      this.lastGroups = groups
      if (sourceFailed || this.store.hasFailedSessionJobs()) view = this.store.recordSourceFailure(startedAt,completedAt)
      now = new Date()
      if (this.store.nextSessionJob(now.getTime(),true)!==undefined) this.requested=true
    }
    return view
  }

  private analyze(scan: RecentSessionTrajectoryScan, previous: SuggestionSessionAnalysis | null,
    policy: ExperienceProjectionPolicy, completedEndSeqs: readonly number[], reuse: boolean): SuggestionSessionAnalysis {
    const revisedEnds = new Set(scan.slices.map(slice=>slice.episodeRef.eventEnd))
    const seeds: ExperienceSuggestionSeedView[] = [...(previous?.seeds.filter(seed=>!revisedEnds.has(seed.episodeRef.eventEnd)) ?? [])]
    const known = new Set(previous?.turnDigests)
    const blockedTurnDigests: string[] = [...(previous?.blockedTurnDigests ?? [])]
    let sensitiveBlocked = blockedTurnDigests.length > 0
    const handledTurnDigests: string[] = [...(previous?.turnDigests ?? [])]
    for (const slice of scan.slices) {
      // Retain prior derived results, but never learn unobserved historical task completions.
      if (!completedEndSeqs.includes(slice.episodeRef.eventEnd) && !known.has(slice.episodeRef.contentDigest)) continue
      const digest = slice.episodeRef.contentDigest
      handledTurnDigests.push(digest)
      if (known.has(digest) && reuse) {
        if (previous?.blockedTurnDigests?.includes(digest) || slice.blockedReason==='sensitive_content') {
          sensitiveBlocked=true; blockedTurnDigests.push(digest)
        }
        seeds.push(...(previous?.seeds.filter(seed=>seed.episodeRef.contentDigest===digest) ?? []))
        continue
      }
      if (slice.blockedReason==='sensitive_content') { sensitiveBlocked=true; blockedTurnDigests.push(digest) }
      try {
        const seed = detectSuggestionSeed(slice,scan.workspaceRoot,policy.suggestionTtlMs,policy)
        if (seed!==null) seeds.push(seed)
      } catch(error) {
        if (!(error instanceof ExperienceError) || error.code!=='sensitive_content_unauthorized') throw error
        sensitiveBlocked = true
        blockedTurnDigests.push(digest)
      }
    }
    const occurrenceIds = seeds.map(seed=>seed.occurrenceId)
    return {seeds,blockedTurnDigests:[...new Set(blockedTurnDigests)],turnDigests:[...new Set(handledTurnDigests)],scan:{
      sessionId:scan.sessionId,workspaceRoot:scan.workspaceRoot,sessionCreatedAt:scan.sessionCreatedAt,
      lastEventAt:scan.lastEventAt,capturedThroughSeq:scan.capturedThroughSeq,lastCompletedEndSeq:scan.lastCompletedEndSeq,
      state:seeds.length ? 'processed' : sensitiveBlocked ? 'blocked' : 'no_suggestion',
      reason:sensitiveBlocked ? 'sensitive_content_omitted' : seeds.length ? null : 'no_completed_verified_tool_path',occurrenceIds,
    }}
  }
}
