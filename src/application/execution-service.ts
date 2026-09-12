import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-jobs'
import { createUsageToolGuard, isApprovedWebLauncherArguments } from '../adapters/tool-guard.js'
import { digest } from '../domain/planning.js'
import { brandedId } from '../ids.js'
import type {
  ExecutionCorrelationView,
  PlanningResultView,
  StepProgressView,
} from '../types.js'
import type { ExperienceRepository } from '../persistence/repository.js'

interface PendingToolResult {
  readonly isError: boolean
  readonly toolName: string
  readonly jobId: string | null
  readonly approvedWebLauncher: boolean
  readonly value?: unknown
}

/** Runtime-only secret material and exact live owner for one guided Usage. */
export interface ActiveUsageRuntime {
  readonly usageId: string
  readonly sessionId: string
  readonly agent: Agent
  readonly ownedJobIds: ReadonlySet<string>
  readonly targetUrlsByJobId: ReadonlyMap<string, URL>
  readonly startedAt: string
}

interface MutableActiveUsage {
  readonly usageId: string
  readonly sessionId: string
  readonly agent: Agent
  readonly ownedJobIds: Set<string>
  readonly targetUrlsByJobId: Map<string, URL>
  readonly pendingResults: Map<string, PendingToolResult>
  readonly startedAt: string
  externalEffectState: 'none' | 'possible' | 'confirmed' | 'unknown'
  disposeGuard: () => void
  guardActive: boolean
  tail: Promise<void>
}

/** Coordinate guided-domain state with Harness tool and Session events. */
export class ExperienceExecutionService {
  private readonly activeBySession = new Map<string, MutableActiveUsage>()

  /** Bind one Host context and the sole canonical Experience repository. */
  constructor(private readonly ctx: Context, private readonly repository: ExperienceRepository) {}

  /** Observe public lifecycle and event seams. */
  install(): void {
    this.ctx.on('session/event', (session, event) => this.observeSessionEvent(session, event), { global: true })
    this.ctx.on('tools/result', (execution, result) => this.observeToolResult(execution, result), { global: true })
    this.ctx.on('agent/disposed', payload => this.releaseSession(String(payload.agent.session.id)), { global: true })
    this.ctx.effect(() => () => {
      for (const sessionId of [...this.activeBySession.keys()]) this.finishSession(sessionId)
    }, 'experience-map guided execution guards')
  }

  /** Start or idempotently restore the domain cursor, then install one agent-scoped deny layer. */
  async activate(planning: PlanningResultView, agent: Agent, runtimeActor: import('../types.js').ActorView): Promise<StepProgressView> {
    const sessionId = String(agent.session.id)
    this.assertCanActivate(planning, agent)
    const existing = this.activeBySession.get(sessionId)
    if (existing !== undefined) {
      return this.repository.startUsage(existing.usageId, sessionId, runtimeActor)
    }
    const active: MutableActiveUsage = {
      usageId: String(planning.plan.usageId),
      sessionId,
      agent,
      ownedJobIds: new Set(),
      targetUrlsByJobId: new Map(),
      pendingResults: new Map(),
      startedAt: new Date().toISOString(),
      externalEffectState: 'none',
      disposeGuard: () => {},
      guardActive: false,
      tail: Promise.resolve(),
    }
    this.activeBySession.set(sessionId, active)
    try {
      const progress = await this.repository.startUsage(active.usageId, sessionId, runtimeActor)
      active.disposeGuard = agent.ctx.tools.guard(createUsageToolGuard(() => ({
        usageId: active.usageId,
        planRevision: progress.planRevision,
        policyDigest: progress.guardPolicyDigest,
        allowedExposure: 'loopback',
        ownedJobIds: active.ownedJobIds,
        externalEffectState: active.externalEffectState,
      })))
      active.guardActive = true
      return progress
    } catch (error) {
      this.finishSession(sessionId)
      throw error
    }
  }

  /** Reject a conflicting Session Usage before any Context delivery is persisted. */
  assertCanActivate(planning: PlanningResultView, agent: Agent): void {
    const existing = this.activeBySession.get(String(agent.session.id))
    if (existing === undefined) return
    if (existing.usageId !== planning.plan.usageId) {
      throw new Error('another guided Experience Usage is active in this Session')
    }
    if (!existing.guardActive) {
      throw new Error('guided Experience execution ended and is retained only for verification or settlement')
    }
  }

  /** Return runtime-only auth/process material without exposing it to transport or persistence. */
  getActive(usageId: string): ActiveUsageRuntime | null {
    const active = [...this.activeBySession.values()].find(item => item.usageId === usageId)
    if (active === undefined) return null
    return {
      usageId: active.usageId,
      sessionId: active.sessionId,
      agent: active.agent,
      ownedJobIds: active.ownedJobIds,
      targetUrlsByJobId: new Map([...active.targetUrlsByJobId]
        .map(([jobId, target]) => [jobId, new URL(target)])),
      startedAt: active.startedAt,
    }
  }

  /** Await all Session tool events observed before a verification command. */
  async flush(usageId: string): Promise<void> {
    const active = [...this.activeBySession.values()].find(item => item.usageId === usageId)
    if (active !== undefined) await active.tail
  }

  /** Apply an authoritative external-effect readback to the active Guard policy. */
  setEffectState(usageId: string, state: 'none' | 'confirmed'): void {
    const active = [...this.activeBySession.values()].find(item => item.usageId === usageId)
    if (active !== undefined) active.externalEffectState = state
  }

  /** End the exact Guard lifecycle after terminal Usage settlement. */
  finish(usageId: string): void {
    const active = [...this.activeBySession.values()].find(item => item.usageId === usageId)
    if (active !== undefined) this.finishSession(active.sessionId)
  }

  private observeToolResult(
    execution: Readonly<ToolExecution>,
    result: Readonly<ToolExecutionResult>,
  ): undefined {
    const sessionId = execution.agent === undefined ? null : String(execution.agent.session.id)
    const active = sessionId === null ? undefined : this.activeBySession.get(sessionId)
    if (active === undefined) return undefined
    const jobId = recordString(execution.arguments, 'job_id')
    const approvedWebLauncher = execution.name === 'bash'
      && isApprovedWebLauncherArguments(execution.arguments)
    active.pendingResults.set(String(execution.callId), result.isError
      ? { isError: true, toolName: execution.name, jobId, approvedWebLauncher }
      : { isError: false, toolName: execution.name, jobId, approvedWebLauncher, value: result.value })
    return undefined
  }

  private observeSessionEvent(session: Session, event: SessionEvent): void {
    const active = this.activeBySession.get(String(session.id))
    if (active === undefined) return
    if (event.type === 'turn/end'
      && (event.data.reason.kind === 'aborted' || event.data.reason.kind === 'interrupted')) {
      this.releaseSession(String(session.id))
      return
    }
    if (event.type === 'assistant/message') {
      const hasToolCall = event.data.message.content.some(block => block.type === 'tool-call')
      const text = event.data.message.content
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (event.data.interrupted !== true && !hasToolCall && text.trim() !== '') {
        active.tail = active.tail.then(async () => {
          await this.repository.recordPreferenceOutput({
            usageId: active.usageId,
            sessionId: String(session.id),
            messageId: String(event.data.message.id),
            text,
          })
        }).catch(error => {
          this.ctx.logger('experience-map').warn('M7 Preference validation failed: %s', errorMessage(error))
        })
      }
      return
    }
    if (event.type !== 'tool/call' && event.type !== 'tool/result') return
    active.tail = active.tail.then(async () => {
      if (event.type === 'tool/call') {
        const now = new Date(event.time).toISOString()
        const correlation: ExecutionCorrelationView = {
          executionCorrelationId: brandedId<'ExperienceExecutionCorrelationId'>(randomUUID(), 'executionCorrelationId'),
          usageId: brandedId<'ExperienceUsageId'>(active.usageId, 'usageId'),
          sessionId: active.sessionId,
          callId: String(event.data.callId),
          rootCallId: String(event.data.callId),
          toolName: event.data.name,
          argumentsDigest: digest(event.data.arguments),
          callEventSeq: event.seq,
          resultEventSeq: null,
          resultState: 'pending',
          externalEffectState: launchLike(event.data.name, event.data.arguments) ? 'possible' : 'none',
          effectRef: null,
          createdAt: now,
          updatedAt: now,
        }
        await this.repository.recordExecutionCall(correlation)
        return
      }
      const callId = String(event.data.message.source.callId)
      const pending = active.pendingResults.get(callId)
      active.pendingResults.delete(callId)
      const effect = pending?.isError === false && pending.toolName === 'bash'
        && pending.approvedWebLauncher
        ? backgroundEffect(pending.value) : null
      if (effect !== null) {
        active.ownedJobIds.add(effect.jobId)
        active.externalEffectState = 'possible'
      } else if (pending?.approvedWebLauncher === true) {
        active.externalEffectState = 'unknown'
      }
      const target = pending?.isError === false && pending.toolName === 'job_output'
        && pending.jobId !== null && active.ownedJobIds.has(pending.jobId)
        ? readinessUrl(pending.value) : null
      if (target !== null && pending !== undefined && pending.jobId !== null) {
        active.targetUrlsByJobId.set(pending.jobId, target)
      }
      const externalEffectState = pending?.approvedWebLauncher === true
        ? effect === null ? 'unknown' : 'possible'
        : 'none'
      await this.repository.recordExecutionResult({
        usageId: active.usageId,
        callId,
        resultEventSeq: event.seq,
        resultState: event.data.message.content[0].isError === true || pending?.isError !== false ? 'failure' : 'success',
        externalEffectState,
        effectRef: effect,
      })
    }).catch(error => {
      active.externalEffectState = 'unknown'
      this.ctx.logger('experience-map').warn('M5 execution correlation failed: %s', errorMessage(error))
    })
  }

  private releaseSession(sessionId: string): void {
    const active = this.activeBySession.get(sessionId)
    if (active === undefined || !active.guardActive) return
    active.guardActive = false
    active.disposeGuard()
  }

  private finishSession(sessionId: string): void {
    const active = this.activeBySession.get(sessionId)
    if (active === undefined) return
    this.activeBySession.delete(sessionId)
    this.releaseGuard(active)
  }

  private releaseGuard(active: MutableActiveUsage): void {
    if (!active.guardActive) return
    active.guardActive = false
    active.disposeGuard()
  }
}

function launchLike(toolName: string, argumentsText: string): boolean {
  return toolName === 'bash' && /\bdsh\b.*\bweb\b/u.test(argumentsText)
}

function backgroundEffect(value: unknown): ExecutionCorrelationView['effectRef'] {
  if (!isRecord(value) || value.kind !== 'background' || typeof value.jobId !== 'string') return null
  return {
    kind: 'background_job',
    jobId: value.jobId,
    labelDigest: digest(value.jobId),
    listenerPid: null,
    host: null,
    port: null,
  }
}

function readinessUrl(value: unknown): URL | null {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const match = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]{43})(?=$|[^A-Za-z0-9_-])/u.exec(text)
  if (match?.[1] === undefined || match[2] === undefined) return null
  try {
    return new URL(`http://127.0.0.1:${match[1]}/?token=${match[2]}`)
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordString(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
