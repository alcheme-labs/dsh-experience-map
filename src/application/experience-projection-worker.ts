import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { EXTRACTION_BUILDER_VERSION, type ExtractionEvidenceConfig } from '../adapters/extraction-evidence.js'
import type { DshSessionSource } from '../adapters/session-source.js'
import {
  detectSuggestionSeed,
  SUGGESTION_DETECTOR_VERSION,
  TRAJECTORY_SEGMENTER_VERSION,
} from '../domain/automatic-suggestion.js'
import {
  materializeSuggestionGroups,
  SUGGESTION_MATERIALIZER_VERSION,
} from '../domain/suggestion-materializer.js'
import type { ExperienceProjectionStore } from '../persistence/projection-store.js'
import type {
  ExperienceSuggestionGroupView,
  ExperienceSuggestionSeedView,
  SessionSuggestionScanView,
  SuggestionProjectionView,
  SuggestionSaveDomainReceipt,
} from '../types.js'
import type { RuntimeSettingsSnapshot } from '../runtime-settings.js'

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

/**
 * Sole wake/reconcile owner for Session-derived suggestions. Wake events carry no
 * data; every run reconstructs the bounded truth from Session Query.
 */
export class ExperienceProjectionWorker {
  private active = true
  private requested = false
  private running: Promise<SuggestionProjectionView> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly source: RecentSessionSource,
    private readonly store: ExperienceProjectionStore,
    private readonly policy: ExperienceProjectionPolicy,
    private readonly savedReceipts: () => readonly SuggestionSaveDomainReceipt[] = () => [],
    private readonly rebuildRetrieval: () => Promise<void> = async () => undefined,
    private readonly runtimeSettings?: () => RuntimeSettingsSnapshot,
    private readonly consolidateGroups?: (
      groups: readonly ExperienceSuggestionGroupView[],
    ) => Promise<ExperienceSuggestionGroupView[]>,
  ) {}

  /** Install one event wake-up and one bounded missed-event recovery timer. */
  install(): void {
    this.ctx.on('session/event', (_session: Session, event: SessionEvent) => {
      if (event.type !== 'turn/end') return
      void this.drain().catch(() => {
        this.ctx.logger('experience-map').warn('Suggestion projection wake failed; the last good generation remains active')
      })
    }, { global: true })
    this.ctx.effect(() => {
      const timer = setInterval(() => {
        void this.drain().catch(() => {
          this.ctx.logger('experience-map').warn(
            'Suggestion projection reconciliation failed; the last good generation remains active',
          )
        })
      }, this.policy.pollIntervalMs)
      timer.unref()
      return () => {
        clearInterval(timer)
        return this.stop()
      }
    }, 'experience-map recent Session projection worker')
  }

  /** Request a complete recent-N reconciliation; overlapping callers share one loop. */
  drain(now = new Date()): Promise<SuggestionProjectionView> {
    if (!this.active) return Promise.resolve(this.store.read())
    this.requested = true
    if (this.running !== undefined) return this.running
    const running = this.drainLoop(now).finally(() => {
      if (this.running === running) this.running = undefined
    })
    this.running = running
    return running
  }

  /** Stop future work and wait for the current sidecar transaction to settle. */
  async stop(): Promise<void> {
    this.active = false
    this.requested = false
    await this.running?.catch(() => undefined)
  }

  private async drainLoop(initialNow: Date): Promise<SuggestionProjectionView> {
    let view = this.store.read()
    let now = initialNow
    while (this.active && this.requested) {
      this.requested = false
      view = this.store.reconcileSaved(this.savedReceipts())
      await this.rebuildRetrieval()
      const startedAt = now.toISOString()
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
        const completedAt = new Date().toISOString()
        view = this.store.rebuild({
          projectorVersion: SUGGESTION_PROJECTOR_VERSION,
          sourceWatermarkDigest: snapshot.digest,
          sessions: [],
          seeds: [],
          groups: [],
          startedAt,
          completedAt,
        })
        now = new Date()
        continue
      }
      let batch: Awaited<ReturnType<RecentSessionSource['scanRecentCompletedTurns']>>
      try {
        batch = await this.source.scanRecentCompletedTurns(
          policy.recentSessionLimit,
          policy.suggestionTtlMs,
          now,
        )
      } catch {
        const completedAt = new Date().toISOString()
        const wasReady = view.state === 'ready'
        view = this.store.recordSourceFailure(startedAt, completedAt)
        if (wasReady) {
          this.ctx.logger('experience-map').warn(
            'Recent Session suggestion projection kept generation %d after source failure',
            view.generation,
          )
        }
        now = new Date()
        continue
      }
      const seeds: ExperienceSuggestionSeedView[] = []
      const sessions: SessionSuggestionScanView[] = []
      for (const scan of batch.sessions) {
        const occurrenceIds: string[] = []
        for (const slice of scan.slices) {
          const seed = detectSuggestionSeed(
            slice,
            scan.workspaceRoot,
            policy.suggestionTtlMs,
            policy,
          )
          if (seed !== null) {
            seeds.push(seed)
            occurrenceIds.push(seed.occurrenceId)
          }
        }
        const sensitiveBlocked = scan.slices.some(slice => slice.blockedReason === 'sensitive_content')
        sessions.push({
          sessionId: scan.sessionId,
          workspaceRoot: scan.workspaceRoot,
          sessionCreatedAt: scan.sessionCreatedAt,
          lastEventAt: scan.lastEventAt,
          capturedThroughSeq: scan.capturedThroughSeq,
          lastCompletedEndSeq: scan.lastCompletedEndSeq,
          state: occurrenceIds.length > 0 ? 'processed' : sensitiveBlocked ? 'blocked' : 'no_suggestion',
          reason: sensitiveBlocked
            ? 'sensitive_content_omitted'
            : occurrenceIds.length === 0 ? 'no_completed_verified_tool_path' : null,
          occurrenceIds,
        })
      }
      const completedAt = new Date().toISOString()
      const activeSeeds = seeds.filter(seed => Date.parse(seed.expiresAt) > Date.parse(completedAt))
      const terminalGroupIds = new Set(view.dispositions.map(disposition => disposition.suggestionGroupId))
      let groups = materializeSuggestionGroups(activeSeeds, policy.maxInlineFieldBytes, terminalGroupIds)
      if (this.consolidateGroups !== undefined) {
        try {
          groups = await this.consolidateGroups(groups)
        } catch {
          this.ctx.logger('experience-map').warn(
            'Semantic suggestion consolidation failed; exact kernel grouping remains active',
          )
        }
      }
      view = this.store.rebuild({
        projectorVersion: SUGGESTION_PROJECTOR_VERSION,
        sourceWatermarkDigest: batch.sourceWatermarkDigest,
        sessions,
        seeds: activeSeeds,
        groups,
        startedAt,
        completedAt,
      })
      now = new Date()
    }
    return view
  }
}
