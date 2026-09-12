import type { Context } from '@deepseek-ai/cordis'
import type { ActorResolver, TrustedCommandOrigin } from './actor-resolver.js'
import type { ContextRetirementCoordinator } from './context-retirement.js'
import type { ExperienceLearningProjector } from './learning-projector.js'
import type { ExperienceRepository } from '../persistence/repository.js'
import type {
  ForgetDomainReceipt,
  ForgetExperienceInput,
  ForgetImpactPreviewView,
  ForgetRequestView,
} from '../types.js'

/** Execute canonical Forget first, then reconcile cross-store cleanup without rollback. */
export class ExperienceForgetService {
  /** Bind the owners involved in the explicit Forget protocol. */
  constructor(
    private readonly ctx: Context,
    private readonly repository: ExperienceRepository,
    private readonly actors: ActorResolver,
    private readonly retirement: ContextRetirementCoordinator,
    private readonly learning: ExperienceLearningProjector,
  ) {}

  /** Return an owner-visible impact whose digest must be echoed by the command. */
  preview(experienceId: ForgetExperienceInput['experienceId'], origin: TrustedCommandOrigin): ForgetImpactPreviewView {
    return this.repository.previewForget(experienceId, this.actors.resolve(origin))
  }

  /** Commit no-retrieval, then attempt Context and projection cleanup exactly once per durable target. */
  async forget(input: ForgetExperienceInput, origin: TrustedCommandOrigin): Promise<ForgetDomainReceipt> {
    const actor = this.actors.resolve(origin)
    const receipt = await this.repository.forgetExperience(input, actor)
    const deliveries = this.repository.listForgetContextDeliveries(String(receipt.forgetRequestId), actor)
    for (const delivery of deliveries) {
      try {
        const requested = await this.repository.requestContextRetirement(delivery, 'forgotten')
        await this.repository.linkForgetContextRetirement(
          String(receipt.forgetRequestId),
          String(delivery.contextDeliveryId),
          String(requested.contextRetirementId),
          requested.status === 'replaced_on_surface' ? 'retired'
            : requested.status === 'failed' ? 'failed' : 'pending',
          requested.status === 'replaced_on_surface' ? 'session_surface_replaced'
            : requested.status === 'failed' ? requested.failureReason ?? 'session_surface_replacement_failed'
              : 'session_surface_retirement_requested',
        )
        const result = await this.retirement.complete(delivery, requested)
        if (result.status === 'pending') {
          await this.repository.linkForgetContextRetirement(
            String(receipt.forgetRequestId),
            String(delivery.contextDeliveryId),
            String(result.contextRetirementId),
            'unknown',
            'session_not_live_retirement_deferred',
          )
        }
      } catch (error) {
        await this.repository.linkForgetContextRetirement(
          String(receipt.forgetRequestId),
          String(delivery.contextDeliveryId),
          null,
          'failed',
          'context_retirement_request_failed',
        )
        this.ctx.logger('experience-map').warn(
          'Forget kept canonical recall stopped after Context retirement failed: %s',
          errorMessage(error),
        )
      }
    }
    try {
      await this.learning.drain()
      await this.repository.finishForgetProjection(String(receipt.forgetRequestId))
    } catch (error) {
      await this.repository.finishForgetProjection(String(receipt.forgetRequestId), 'learning_projection_rebuild_failed')
      this.ctx.logger('experience-map').warn(
        'Forget kept canonical recall stopped after projection invalidation failed: %s',
        errorMessage(error),
      )
    }
    return receipt
  }

  /** Read one Forget request after canonical and cross-store processing. */
  get(forgetRequestId: string, origin: TrustedCommandOrigin): ForgetRequestView {
    return this.repository.getForgetRequest(forgetRequestId, this.actors.resolve(origin))
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
