import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, Message, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { parseExitStatus } from '@deepseek-ai/dsh-shell'
import {
  createExperienceContextMessage,
  experienceMessageSource,
} from '../adapters/context-message.js'
import type { PlanningObservationRegistry } from '../adapters/observations.js'
import {
  contextSections,
  materializeContextSnapshot,
  renderContext,
} from '../domain/context.js'
import {
  admissionTaskDigest,
  digest,
  recallDecisionKey,
  registeredFailureSignatures,
  usageScopeDigest,
} from '../domain/planning.js'
import { brandedId } from '../ids.js'
import type {
  ContextDeliveryView,
  PlanningObservationView,
  PlanningTaskInput,
} from '../types.js'
import type { ExperienceRepository, RecallSettlementTrigger } from '../persistence/repository.js'
import type { ActorResolver } from './actor-resolver.js'
import type { ExperiencePlanningService } from './planning-service.js'
import type { ExperienceExecutionService } from './execution-service.js'
import { ContextRetirementCoordinator } from './context-retirement.js'
import type { RuntimeSettingsSnapshot } from '../runtime-settings.js'

/** Runtime policy for deterministic Session admission and bounded re-recall coordination. */
export interface SessionAdmissionPolicy {
  readonly claimLeaseMs: number
  readonly automaticRecall: boolean
  readonly defaultTargetExposure: PlanningTaskInput['targetExposure']
  readonly defaultRiskClass: PlanningTaskInput['riskClass']
  readonly defaultMustUseExperience: boolean
}

interface RecallTrigger {
  readonly kind: RecallSettlementTrigger['kind']
  readonly generation: string
  readonly sourceRef: string
  readonly evidenceDigest: string
  readonly evidenceSummary: string
  readonly failureSignature: string | null
  readonly taskEvidence: string | null
}

/** Connect approved Experience plans to public Harness admission and Session seams. */
export class SessionAdmission {
  /** Bind canonical owners; this adapter persists no state of its own. */
  constructor(
    private readonly ctx: Context,
    private readonly repository: ExperienceRepository,
    private readonly actors: ActorResolver,
    private readonly observations: PlanningObservationRegistry,
    private readonly planning: ExperiencePlanningService,
    private readonly execution: ExperienceExecutionService,
    private readonly policy: SessionAdmissionPolicy,
    retirement?: ContextRetirementCoordinator,
    private readonly runtimeSettings?: () => RuntimeSettingsSnapshot,
  ) {
    this.retirement = retirement ?? new ContextRetirementCoordinator(ctx, repository)
  }

  private readonly retirement: ContextRetirementCoordinator

  /** Register the pre-step, Session observation, and exact LLM-request observers. */
  install(): void {
    this.ctx.on('agent/pre-step', (payload, next) => this.preStep(payload.agent, payload.messages,
      payload.turn, payload.step, payload.signal, next), { global: true })
    this.ctx.on('session/event', (session, event) => {
      void this.observeSessionEvent(session, event).catch(error => {
        this.ctx.logger('experience-map').warn('ContextDelivery Session observation failed: %s', errorMessage(error))
      })
    }, { global: true })
    this.ctx.on('llm/stream', (options, next) => this.observeRequest(options, next), { global: true })
  }

  private async preStep(
    agent: Agent,
    _proposedMessages: readonly UserMessage[],
    turn: number,
    step: number,
    signal: AbortSignal,
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const hasDirectInput = decision.messages.some(message => message.source.kind === 'user')
    const taskText = directUserTask(decision.messages)
    const runtime = this.runtimeSettings?.()
    const policy: SessionAdmissionPolicy = runtime === undefined ? this.policy : {
      claimLeaseMs: runtime.values.admissionClaimLeaseMs,
      automaticRecall: runtime.values.automaticRecall,
      defaultTargetExposure: runtime.values.defaultTargetExposure,
      defaultRiskClass: runtime.values.defaultRiskClass,
      defaultMustUseExperience: runtime.values.defaultMustUseExperience,
    }
    const automaticRecall = runtime?.values.automaticRecall ?? policy.automaticRecall
    const automaticContextInjection = runtime?.values.automaticContextInjection
      ?? 'after_current_plan_approval'
    const contextInjectionEnabled = automaticContextInjection !== 'never'
    let mustUseExperience = automaticRecall && policy.defaultMustUseExperience
    let contextClosureRequired = false
    try {
      const owner = this.actors.resolveLocalUserTask()
      const runtimeActor = this.actors.resolve({
        kind: 'restricted-runtime',
        runtimeKind: 'agent',
        runtimeId: String(agent.id),
      })
      await this.reconcileSession(agent.session)
      const priorDeliveries = this.repository.listUnsettledSessionContextDeliveries(
        String(agent.session.id), owner,
      )
      const initialTrigger = step === 1 && hasDirectInput
        ? userTurnTrigger(agent.session, decision.messages, turn) : null
      const directTask = taskText === null ? null : taskFromDirectInput(taskText, agent, policy)
      const priorTask = step > 1 && priorDeliveries.at(-1) !== undefined
        ? taskFromPlanning(this.repository.getContextUsage(
            String(priorDeliveries.at(-1)!.usageId), owner,
          ).planning)
        : null
      const recallTask = directTask ?? priorTask
      const trigger = initialTrigger ?? (step > 1 && recallTask !== null && priorDeliveries.length > 0
        ? await this.changedRecallTrigger(
            agent.session,
            priorDeliveries,
            recallTask,
            signal,
            owner,
            runtime?.values.observationFreshnessMs,
          )
        : null)
      if (trigger === null) return decision
      const triggeredTask = recallTask === null ? null : taskWithRecallEvidence(recallTask, trigger)
      if (triggeredTask === null) {
        contextClosureRequired = priorDeliveries.length > 0
          || this.repository.listActiveContextDeliveries(String(agent.session.id)).length > 0
        await this.closePriorUsages(agent.session, priorDeliveries, trigger, runtimeActor, owner)
        contextClosureRequired = false
        return decision
      }
      const decisionKey = recallDecisionKey({
        sessionId: String(agent.session.id),
        actorRef: String(runtimeActor.principalId),
        task: triggeredTask,
        triggerKind: trigger.kind,
        triggerGeneration: trigger.generation,
      })
      let claimed = contextInjectionEnabled
        ? await this.repository.claimAdmissionRetryBinding({
            taskInputDigest: admissionTaskDigest(triggeredTask.text),
            sessionId: String(agent.session.id),
            scopeDigest: usageScopeDigest(triggeredTask),
            workspaceRoot: agent.session.header.cwd ?? null,
            runtimeActor,
            leaseMs: policy.claimLeaseMs,
          })
        : null
      if (claimed === null && this.repository.hasRecallDecisionKey(decisionKey, owner)) return decision
      contextClosureRequired = priorDeliveries.length > 0
        || this.repository.listActiveContextDeliveries(String(agent.session.id)).length > 0
      await this.closePriorUsages(agent.session, priorDeliveries, trigger, runtimeActor, owner)
      contextClosureRequired = false
      if (claimed === null && automaticRecall) {
        // Browser approval stays bound to its visible Session. A connectionless
        // headless invocation cannot resume that Session, so its one-time retry
        // binding uses the already-governed actor/scope/exact-task key instead.
        const approvalSessionId = this.ctx.get('connection') === undefined
          && step === 1 && priorDeliveries.length === 0
          ? null : String(agent.session.id)
        const planned = await this.planning.plan({
          commandId: brandedId<'ExperienceCommandId'>(randomUUID(), 'commandId'),
          correlationId: randomUUID(),
          causationId: null,
          issuedAt: new Date().toISOString(),
          sessionId: approvalSessionId,
          interaction: contextInjectionEnabled ? 'ask_current_agent' : 'defer',
          confirmExternalModelProcessing: false,
          task: triggeredTask,
        }, owner, signal, runtime, decisionKey)
        if (planned.planning.retryBinding === null) {
          return triggeredTask.mustUseExperience && planned.planning.admissionAttempt.state === 'pending_external_decision'
            ? { kind: 'reject' }
            : decision
        }
        if (!contextInjectionEnabled) return decision
        claimed = await this.repository.claimAdmissionRetryBinding({
          taskInputDigest: admissionTaskDigest(triggeredTask.text),
          sessionId: String(agent.session.id),
          scopeDigest: usageScopeDigest(triggeredTask),
          workspaceRoot: agent.session.header.cwd ?? null,
          runtimeActor,
          leaseMs: policy.claimLeaseMs,
        })
      }
      if (claimed === null) return decision
      mustUseExperience = taskFromPlanning(claimed.planning).mustUseExperience
      this.execution.assertCanActivate(claimed.planning, agent)
      signal.throwIfAborted()
      const task = taskFromPlanning(claimed.planning)
      const currentObservations = await this.observations.observe(
        task,
        signal,
        runtime?.values.observationFreshnessMs,
      )
      signal.throwIfAborted()
      const sections = contextSections(claimed.planning)
      const content = renderContext(sections)
      const contextSnapshotId = brandedId<'ExperienceContextSnapshotId'>(randomUUID(), 'contextSnapshotId')
      const contextDeliveryId = brandedId<'ExperienceContextDeliveryId'>(randomUUID(), 'contextDeliveryId')
      const contentDigest = digest(content)
      const message = createExperienceContextMessage(content, {
        usageId: claimed.planning.plan.usageId,
        contextSnapshotId,
        contentDigest,
        sections,
      }, contextDeliveryId)
      const now = new Date().toISOString()
      const snapshot = materializeContextSnapshot(
        claimed.planning,
        sections,
        contextSnapshotId,
        String(message.id),
        now,
      )
      const delivery: ContextDeliveryView = {
        contextDeliveryId,
        contextSnapshotId,
        usageId: claimed.planning.plan.usageId,
        sessionId: String(agent.session.id),
        messageId: String(message.id),
        contentDigest: snapshot.contentDigest,
        deliveryStatus: 'prepared',
        sessionEventSeq: null,
        requestBoundaryRef: null,
        appendedAt: null,
        deliveredAt: null,
        createdAt: now,
      }
      await this.repository.consumeClaimAndPrepareContext({ claimed, currentObservations, snapshot, delivery })
      await this.execution.activate(claimed.planning, agent, runtimeActor)
      return { ...decision, messages: [message, ...decision.messages] }
    } catch (error) {
      this.ctx.logger('experience-map').warn(
        'Experience admission delegated without context after exact recheck failed: %s',
        errorMessage(error),
      )
      return contextClosureRequired || mustUseExperience ? { kind: 'reject' } : decision
    }
  }

  private async changedRecallTrigger(
    session: Session,
    priorDeliveries: readonly ContextDeliveryView[],
    task: PlanningTaskInput,
    signal: AbortSignal,
    owner: ReturnType<ActorResolver['resolveLocalUserTask']>,
    observationFreshnessMs: number | undefined,
  ): Promise<RecallTrigger | null> {
    const latest = priorDeliveries.at(-1)
    if (latest === undefined) return null
    const events = (await this.ctx.sessionQuery.readSession(session.id)).events
    const failure = latestRegisteredFailure(String(session.id), events, latest)
    if (failure !== null) return failure
    if (!hasToolResultAfterDelivery(events, latest)) return null
    const context = this.repository.getContextUsage(String(latest.usageId), owner)
    const baseline = context.planning.preflights[0]?.observations ?? []
    if (baseline.length === 0) return null
    const current = await this.observations.observe(task, signal, observationFreshnessMs)
    const before = environmentGeneration(baseline)
    const after = environmentGeneration(current)
    if (before === after) return null
    const changed = changedEnvironmentFacts(baseline, current)
    if (changed.length === 0) return null
    const evidenceDigest = digest({
      schemaVersion: 'experience-environment-change-evidence-v1',
      before,
      after,
      changed,
    })
    return {
      kind: 'environment_generation_changed',
      generation: after,
      sourceRef: `experience-usage:${String(latest.usageId)}#environment-generation:${after}`,
      evidenceDigest,
      evidenceSummary: changed.join('; '),
      failureSignature: null,
      taskEvidence: `Observed environment change: ${changed.join('; ')}`,
    }
  }

  private async closePriorUsages(
    session: Session,
    knownDeliveries: readonly ContextDeliveryView[],
    trigger: RecallTrigger,
    runtimeActor: ReturnType<ActorResolver['resolve']>,
    owner: ReturnType<ActorResolver['resolveLocalUserTask']>,
  ): Promise<void> {
    const current = this.repository.listUnsettledSessionContextDeliveries(String(session.id), owner)
    const unsettledByUsage = new Map([...knownDeliveries, ...current]
      .map(delivery => [String(delivery.usageId), delivery]))
    const surfaceDeliveries = this.repository.listActiveContextDeliveries(String(session.id))
    const byDelivery = new Map([...surfaceDeliveries, ...unsettledByUsage.values()]
      .map(delivery => [String(delivery.contextDeliveryId), delivery]))
    for (const delivery of byDelivery.values()) {
      if (delivery.sessionEventSeq !== null) {
        const retirement = await this.retirement.retire(
          delivery,
          trigger.kind === 'initial_user_turn' ? 'next_usage' : 'plan_superseded',
          session,
        )
        if (retirement.status !== 'replaced_on_surface') {
          throw new Error('Experience Context retirement is not proven on the Session surface')
        }
      } else if (delivery.deliveryStatus !== 'failed_before_send') {
        throw new Error('Experience Context without a Session event is not proven absent')
      }
    }
    for (const delivery of unsettledByUsage.values()) {
      await this.execution.flush(String(delivery.usageId))
      await this.repository.startUsage(String(delivery.usageId), String(session.id), runtimeActor)
      await this.repository.settleUsageForRecall({
        contextDeliveryId: String(delivery.contextDeliveryId),
        sessionId: String(session.id),
        kind: trigger.kind,
        generation: trigger.generation,
        sourceRef: trigger.sourceRef,
        evidenceDigest: trigger.evidenceDigest,
        evidenceSummary: trigger.evidenceSummary,
        failureSignature: trigger.failureSignature,
      }, owner)
      this.execution.finish(String(delivery.usageId))
    }
    if (this.repository.listUnsettledSessionContextDeliveries(String(session.id), owner).length > 0
      || this.repository.listActiveContextDeliveries(String(session.id)).length > 0) {
      throw new Error('Session still has an active Experience Context or unsettled Usage')
    }
  }

  private async observeSessionEvent(session: Session, event: SessionEvent): Promise<void> {
    if (event.type !== 'user/message') return
    const source = experienceMessageSource(event.data)
    if (source === null || source.lifecycle !== 'active') return
    const contentDigest = messageContentDigest(event.data)
    if (contentDigest !== source.contentDigest) {
      throw new Error('Experience message content diverges from its logged source digest')
    }
    await this.repository.recordContextAppended({
      contextDeliveryId: source.contextDeliveryId,
      sessionId: String(session.id),
      messageId: String(event.data.id),
      contentDigest,
      sessionEventSeq: event.seq,
      appendedAt: new Date(event.time).toISOString(),
    })
  }

  private observeRequest(
    options: GenerateOptions,
    next: () => AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk>,
  ): AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk> {
    const experienceMessages = options.messages.flatMap(message => {
      const source = experienceMessageSource(message)
      return source?.lifecycle === 'active' ? [{ message, source }] : []
    })
    if (experienceMessages.length === 0 || options.sessionId === undefined) return next()
    const sessionId = String(options.sessionId)
    const repository = this.repository
    const sessions = this.ctx.sessions
    const sessionQuery = this.ctx.sessionQuery
    return (async function* () {
      const session = sessions.get(options.sessionId!)
      if (session === undefined) throw new Error('Experience request names a non-live Session')
      const events = (await sessionQuery.readSession(options.sessionId!)).events
      for (const entry of experienceMessages) {
        const event = events.find(candidate => candidate.type === 'user/message'
          && candidate.data.id === entry.message.id)
        if (event === undefined) throw new Error('Experience request message is absent from the Session log')
        const contentDigest = messageContentDigest(entry.message)
        if (contentDigest !== entry.source.contentDigest) {
          throw new Error('Experience request content diverges from ContextSnapshot')
        }
        await repository.recordContextAppended({
          contextDeliveryId: entry.source.contextDeliveryId,
          sessionId,
          messageId: String(entry.message.id),
          contentDigest,
          sessionEventSeq: event.seq,
          appendedAt: new Date(event.time).toISOString(),
        })
        await repository.recordContextIncluded({
          contextDeliveryId: entry.source.contextDeliveryId,
          requestBoundaryRef: digest({
            schemaVersion: 'experience-request-boundary-v1',
            sessionId,
            capturedThroughSeq: session.seq - 1,
            messageIds: options.messages.map(message => String(message.id)),
            provider: options.provider,
            model: options.model,
          }),
          deliveredAt: new Date().toISOString(),
        })
      }
      yield* next()
    })()
  }

  private async reconcileSession(session: Session): Promise<void> {
    const deliveries = this.repository.listContextDeliveries(String(session.id))
    const events = deliveries.length === 0
      ? []
      : (await this.ctx.sessionQuery.readSession(session.id)).events
    for (const delivery of deliveries) {
      if (delivery.deliveryStatus === 'included_in_request'
        || delivery.deliveryStatus === 'failed_before_send'
        || delivery.deliveryStatus === 'interrupted_before_request') continue
      const event = events.find((candidate): candidate is SessionEvent<'user/message'> =>
        candidate.type === 'user/message' && candidate.data.id === delivery.messageId)
      if (event === undefined) {
        if (delivery.deliveryStatus === 'prepared') {
          await this.repository.recordContextInterruption({
            contextDeliveryId: String(delivery.contextDeliveryId),
            status: 'failed_before_send',
          })
        }
        continue
      }
      const source = experienceMessageSource(event.data)
      const contentDigest = messageContentDigest(event.data)
      if (source?.contextDeliveryId !== delivery.contextDeliveryId
        || source.contextSnapshotId !== delivery.contextSnapshotId
        || contentDigest !== delivery.contentDigest) {
        throw new Error('Session log contains a mismatched Experience delivery identity')
      }
      const appended = await this.repository.recordContextAppended({
        contextDeliveryId: String(delivery.contextDeliveryId),
        sessionId: String(session.id),
        messageId: String(event.data.id),
        contentDigest,
        sessionEventSeq: event.seq,
        appendedAt: new Date(event.time).toISOString(),
      })
      const end = events.find(candidate => candidate.seq > event.seq && candidate.type === 'step/end')
      const response = events.find(candidate => candidate.seq > event.seq
        && (end === undefined || candidate.seq < end.seq)
        && (candidate.type === 'assistant/attempt' || candidate.type === 'assistant/message'))
      if (response !== undefined) {
        await this.repository.recordContextIncluded({
          contextDeliveryId: String(delivery.contextDeliveryId),
          requestBoundaryRef: digest({
            schemaVersion: 'experience-reconciled-request-v1',
            sessionId: String(session.id),
            messageId: delivery.messageId,
            sessionEventSeq: appended.sessionEventSeq,
            responseEventSeq: response.seq,
          }),
          deliveredAt: new Date(response.time).toISOString(),
        })
      } else if (end !== undefined) {
        await this.repository.recordContextInterruption({
          contextDeliveryId: String(delivery.contextDeliveryId),
          status: 'interrupted_before_request',
        })
      }
    }
  }
}

function userTurnTrigger(
  session: Session,
  messages: readonly UserMessage[],
  turn: number,
): RecallTrigger {
  const evidenceDigest = digest({
    schemaVersion: 'experience-user-turn-trigger-v1',
    sessionId: String(session.id),
    turn,
    messageIds: messages.map(message => String(message.id)),
  })
  return {
    kind: 'initial_user_turn',
    generation: `messages:${digest(messages.map(message => String(message.id)))}`,
    sourceRef: `dsh-session:${String(session.id)}#turn:${String(turn)}`,
    evidenceDigest,
    evidenceSummary: `new_user_turn:${String(turn)}`,
    failureSignature: null,
    taskEvidence: null,
  }
}

function taskWithRecallEvidence(task: PlanningTaskInput, trigger: RecallTrigger): PlanningTaskInput {
  if (trigger.taskEvidence === null) return task
  return { ...task, text: `${stripRecallEvidence(task.text)}\n\n${trigger.taskEvidence}` }
}

function stripRecallEvidence(text: string): string {
  return text.split(/\n\nObserved (?:registered tool failure|environment change):/u, 1)[0]!
}

function latestRegisteredFailure(
  sessionId: string,
  events: readonly SessionEvent[],
  delivery: ContextDeliveryView,
): RecallTrigger | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (!eventAfterDelivery(event, delivery)) break
    if (event.type !== 'tool/result' || !toolResultFailed(event)) continue
    const errorText = event.data.error === undefined
      ? '' : `${event.data.error.name} ${event.data.error.code}`
    const signatures = registeredFailureSignatures(`${errorText}\n${toolResultText(event)}`).sort()
    if (signatures.length === 0) continue
    const evidenceDigest = digest({
      schemaVersion: 'experience-registered-tool-failure-v1',
      sessionId,
      eventSeq: event.seq,
      eventDigest: digest(event),
      signatures,
    })
    return {
      kind: 'registered_tool_failure',
      generation: `failure:${String(event.seq)}:${signatures.join('+')}`,
      sourceRef: `dsh-session:${sessionId}#${String(event.seq)}`,
      evidenceDigest,
      evidenceSummary: `registered_tool_failure:${signatures.join('+')}:event:${String(event.seq)}`,
      failureSignature: signatures.join('+'),
      taskEvidence: `Observed registered tool failure: ${signatures.join(', ')}`,
    }
  }
  return null
}

function hasToolResultAfterDelivery(events: readonly SessionEvent[], delivery: ContextDeliveryView): boolean {
  return events.some(event => event.type === 'tool/result' && eventAfterDelivery(event, delivery))
}

function eventAfterDelivery(event: SessionEvent, delivery: ContextDeliveryView): boolean {
  return delivery.sessionEventSeq === null
    ? event.time >= Date.parse(delivery.createdAt)
    : event.seq > delivery.sessionEventSeq
}

function toolResultFailed(event: SessionEvent<'tool/result'>): boolean {
  if (event.data.error !== undefined) return true
  const block = event.data.message.content[0] as unknown
  if (isRecord(block) && block.isError === true) return true
  const status = parseExitStatus(toolResultText(event))
  return 'signal' in status || status.exitCode !== 0
}

function toolResultText(event: SessionEvent<'tool/result'>): string {
  return textValues(event.data.message.content[0]).join('\n').slice(0, 8_192)
}

function textValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(textValues)
  if (!isRecord(value)) return []
  const own = value.type === 'text' && typeof value.text === 'string' ? [value.text] : []
  return [...own, ...textValues(value.content)]
}

function environmentGeneration(observations: readonly PlanningObservationView[]): string {
  return digest({
    schemaVersion: 'experience-environment-generation-v1',
    facts: stableEnvironmentFacts(observations),
  })
}

function stableEnvironmentFacts(observations: readonly PlanningObservationView[]) {
  return observations.map(observation => ({
    kind: observation.kind,
    status: observation.status,
    values: stableObservationValues(observation),
    reasonCode: observation.reasonCode,
  })).sort((left, right) => left.kind.localeCompare(right.kind))
}

/** Ignore ordinary in-task repository dirtiness while retaining environment identity changes. */
function stableObservationValues(observation: PlanningObservationView) {
  const entries = Object.entries(observation.values)
    .filter(([key]) => observation.kind !== 'repository_state' || [
      'packageManifestPresent',
      'packageManager',
      'nodeEngine',
      'revision',
    ].includes(key))
    .sort(([left], [right]) => left.localeCompare(right))
  return Object.fromEntries(entries)
}

function changedEnvironmentFacts(
  before: readonly PlanningObservationView[],
  after: readonly PlanningObservationView[],
): string[] {
  const beforeByKind = new Map(stableEnvironmentFacts(before).map(item => [item.kind, JSON.stringify(item)]))
  return stableEnvironmentFacts(after).flatMap(item => {
    const serialized = JSON.stringify(item)
    if (beforeByKind.get(item.kind) === serialized) return []
    const values = Object.entries(item.values).map(([key, value]) => `${key}=${String(value)}`).join(',')
    const reason = item.reasonCode === null ? '' : `:reason=${item.reasonCode}`
    return [`${item.kind}:${item.status}${values === '' ? '' : `:${values}`}${reason}`.slice(0, 512)]
  }).slice(0, 8)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function taskFromDirectInput(
  taskText: string,
  agent: Agent,
  policy: SessionAdmissionPolicy,
): PlanningTaskInput {
  return {
    text: taskText,
    workspaceRoot: agent.session.header.cwd ?? null,
    targetExposure: policy.defaultTargetExposure,
    mustUseExperience: policy.defaultMustUseExperience,
    riskClass: policy.defaultRiskClass,
    requiredCapabilities: [],
    requestedUseMode: 'guided',
    overrideDecisionIds: [],
  }
}

function directUserTask(messages: readonly UserMessage[]): string | null {
  const direct = messages.filter(message => message.source.kind === 'user')
  if (direct.length === 0 || direct.some(message => message.content.some(block => block.type !== 'text'))) return null
  const texts = direct.flatMap(message => message.content.map(block => block.type === 'text' ? block.text : ''))
  return texts.length === 0 ? null : texts.join('\n\n')
}

function taskFromPlanning(planning: import('../types.js').PlanningResultView): PlanningTaskInput {
  return {
    text: planning.fingerprint.taskText,
    workspaceRoot: planning.fingerprint.environmentRefs[0] ?? null,
    targetExposure: planning.fingerprint.targetExposure,
    mustUseExperience: planning.fingerprint.hardConstraints.includes('must_use_experience:true'),
    riskClass: planning.fingerprint.riskClass,
    requiredCapabilities: planning.fingerprint.hardConstraints.flatMap(value =>
      value.startsWith('required_capability:') ? [value.slice('required_capability:'.length)] : []),
    requestedUseMode: planning.plan.useMode,
    overrideDecisionIds: planning.plan.overrideDecisionIds,
  }
}

function messageContentDigest(message: Message): string {
  const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  return digest(text)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
