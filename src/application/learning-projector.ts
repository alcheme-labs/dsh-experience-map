import type { Context } from '@deepseek-ai/cordis'
import type { LearningProjectionView } from '../types.js'
import type { ExperienceRepository } from '../persistence/repository.js'
import type { RuntimeSettingsSnapshot } from '../runtime-settings.js'

/** Validated scheduling policy for the local outbox-driven learning projector. */
export interface LearningProjectorConfig {
  readonly learningPollIntervalMs: number
  readonly learningClaimLeaseMs: number
  readonly learningRetryDelayMs: number
  readonly learningBatchSize: number
}

/** Cordis-owned worker that reconciles rebuildable learning rows from canonical Experience records. */
export class ExperienceLearningProjector {
  private active = true
  private draining: Promise<LearningProjectionView> | undefined

  /** Bind the worker to its repository and deployment scheduling policy. */
  constructor(
    private readonly ctx: Context,
    private readonly repository: ExperienceRepository,
    private readonly config: LearningProjectorConfig,
    private readonly runtimeSettings?: () => RuntimeSettingsSnapshot,
  ) {}

  /** Install bounded polling and stop accepting work when the owning Cordis fiber disposes. */
  install(): void {
    this.ctx.effect(() => {
      const timer = setInterval(() => {
        void this.drain().catch(error => {
          this.ctx.logger('experience-map').warn('M6 learning projection failed: %s', errorMessage(error))
        })
      }, this.config.learningPollIntervalMs)
      timer.unref()
      return async () => {
        this.active = false
        clearInterval(timer)
        await this.draining?.catch(() => undefined)
      }
    }, 'experience-map learning projection worker')
  }

  /** Drain all currently due learning entries; overlapping callers share the same run. */
  drain(): Promise<LearningProjectionView> {
    if (this.draining !== undefined) return this.draining
    const runtime = this.runtimeSettings?.().values
    const config: LearningProjectorConfig = runtime === undefined ? this.config : {
      learningPollIntervalMs: this.config.learningPollIntervalMs,
      learningClaimLeaseMs: runtime.learningClaimLeaseMs,
      learningRetryDelayMs: runtime.learningRetryDelayMs,
      learningBatchSize: runtime.learningBatchSize,
    }
    const running = this.drainLoop(config).finally(() => {
      if (this.draining === running) this.draining = undefined
    })
    this.draining = running
    return running
  }

  private async drainLoop(config: LearningProjectorConfig): Promise<LearningProjectionView> {
    let projection: LearningProjectionView | undefined
    while (this.active) {
      const now = new Date()
      const claimed = await this.repository.claimLearningOutbox(
        now.toISOString(),
        new Date(now.getTime() + config.learningClaimLeaseMs).toISOString(),
        config.learningBatchSize,
      )
      if (claimed.length === 0) return projection ?? this.repository.readLearningProjection()
      try {
        projection = await this.repository.commitLearningProjection(claimed)
      } catch (error) {
        await this.repository.releaseLearningOutbox(
          claimed,
          new Date(Date.now() + config.learningRetryDelayMs).toISOString(),
        )
        throw error
      }
    }
    return projection ?? this.repository.readLearningProjection()
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
