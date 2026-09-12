import { SessionId, SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { createExperienceRetirementMessage } from '../adapters/context-message.js'
import type { ExperienceRepository } from '../persistence/repository.js'
import type { ContextDeliveryView, ContextRetirementView } from '../types.js'

/** Coordinate one Experience Context retirement through the public Session surface. */
export class ContextRetirementCoordinator {
  /** Bind the canonical Experience repository to the Harness Session owner. */
  constructor(
    private readonly ctx: Context,
    private readonly repository: ExperienceRepository,
  ) {}

  /** Request retirement and complete it immediately when the target Session is live. */
  async retire(
    delivery: ContextDeliveryView,
    reason: ContextRetirementView['reason'],
    knownSession?: Session,
  ): Promise<ContextRetirementView> {
    const retirement = await this.repository.requestContextRetirement(delivery, reason)
    return this.complete(delivery, retirement, knownSession)
  }

  /** Complete one already-requested retirement against the current Session surface. */
  async complete(
    delivery: ContextDeliveryView,
    retirement: ContextRetirementView,
    knownSession?: Session,
  ): Promise<ContextRetirementView> {
    if (retirement.status === 'replaced_on_surface' || retirement.status === 'failed') return retirement
    const session = knownSession ?? this.ctx.sessions.get(SessionId(delivery.sessionId))
    if (session === undefined) return retirement
    const replacedSeq = SessionSeq(retirement.replacedSessionEventSeq)
    if (!session.surface.nodes.includes(replacedSeq)) {
      const trace = await this.ctx.sessionQuery.traceEvent({
        sessionId: session.id,
        seq: replacedSeq,
      })
      if (trace.replacementChain.length === 0) {
        await this.repository.finishContextRetirement(String(retirement.contextRetirementId), {
          failureReason: 'delivery_event_is_not_current_and_has_no_replacement',
        })
        throw new Error('Experience Context has an unknown Session surface state')
      }
      return this.repository.finishContextRetirement(String(retirement.contextRetirementId), {
        replacementSessionEventSeq: trace.replacementChain.at(-1)!,
      })
    }
    const marker = createExperienceRetirementMessage({
      usageId: String(delivery.usageId),
      contextSnapshotId: String(delivery.contextSnapshotId),
      contextDeliveryId: String(delivery.contextDeliveryId),
    }, String(retirement.contextRetirementId))
    try {
      const event = session.append('user/message', marker, {
        surfaceOp: {
          op: 'replace',
          startSeq: replacedSeq,
          endSeq: replacedSeq,
        },
        sourceEventSeqs: [replacedSeq],
      })
      return this.repository.finishContextRetirement(String(retirement.contextRetirementId), {
        replacementSessionEventSeq: event.seq,
      })
    } catch (error) {
      await this.repository.finishContextRetirement(String(retirement.contextRetirementId), {
        failureReason: errorMessage(error),
      })
      throw error
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
