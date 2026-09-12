import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-shell'
import { digest } from '../domain/planning.js'
import { brandedId } from '../ids.js'
import type {
  ActorView,
  CriterionVerificationView,
  M5DomainReceipt,
  ExecutionCorrelationView,
  UsageExecutionView,
  VerificationRunView,
  VerifyUsageInput,
} from '../types.js'
import type { ExperienceExecutionService } from '../application/execution-service.js'
import type { ExperienceRepository } from '../persistence/repository.js'
import { isApprovedWebLauncherArguments } from './tool-guard.js'

const CRITERIA = [
  'WEB-LAUNCH-001',
  'WEB-READY-002',
  'WEB-AUTH-003',
  'WEB-SCOPE-004',
  'WEB-CLEAN-005',
] as const

interface ListenerObservation {
  readonly state: 'listening' | 'closed' | 'unknown'
  readonly pid: number | null
  readonly host: string | null
  readonly port: number
  readonly reasonCode: string
  readonly sourceRef: string | null
}

/** Fixed Web-startup verifiers over live Harness/OS/HTTP authority. */
export class WebUsageVerifier {
  private readonly unrelatedListenerBaselines = new Map<string, ReadonlySet<string>>()

  /** Bind public Harness capabilities and Experience owners. */
  constructor(
    private readonly ctx: Context,
    private readonly repository: ExperienceRepository,
    private readonly execution: ExperienceExecutionService,
    private readonly timeoutMs: number,
  ) {}

  /** Verify all five criteria and persist only bounded, secret-free facts. */
  async verify(
    input: VerifyUsageInput,
    current: UsageExecutionView,
    actor: ActorView,
    signal?: AbortSignal,
    timeoutMs: number = this.timeoutMs,
  ): Promise<M5DomainReceipt> {
    const progress = current.progress
    if (progress === null || progress.controllerRevision !== input.expectedControllerRevision) {
      throw new Error('StepProgress changed before verification started')
    }
    const runtime = this.execution.getActive(String(input.usageId))
    const sessionEvents = runtime == null
      ? []
      : (await this.ctx.sessionQuery.readSession(runtime.agent.session.id)).events
    const launcher = launcherCorrelation(current.correlations, sessionEvents)
    const jobId = launcher?.effectRef?.jobId ?? [...runtime?.ownedJobIds ?? []][0] ?? null
    const target = jobId === null ? null : runtime?.targetUrlsByJobId.get(jobId) ?? null
    const jobs = this.ctx.get('jobs')
    const job = runtime === null || jobId === null || jobs === undefined
      ? null : safeJob(() => jobs.get(JobId(jobId), runtime.agent))
    const port = target === null ? null : numericPort(target)
    const listener = port === null
      ? { state: 'unknown', pid: null, host: null, port: 0, reasonCode: 'readiness_url_absent', sourceRef: null } as const
      : await this.observeListener(port, signal, timeoutMs)

    const previous = current.verification
    const launchResult = this.verifyLauncher(sessionEvents, launcher)
    const readyResult = preservePass(previous, progress.controllerRevision, 'WEB-READY-002')
      ?? this.verifyReady(job, target, listener)
    const scopeResult = preservePass(previous, progress.controllerRevision, 'WEB-SCOPE-004')
      ?? this.verifyScope(target, listener)
    const authResult = preservePass(previous, progress.controllerRevision, 'WEB-AUTH-003')
      ?? await this.verifyAuth(target, signal, timeoutMs)
    if (job?.status === 'running' && listener.state === 'listening' && listener.pid !== null
      && !this.unrelatedListenerBaselines.has(String(input.usageId))) {
      const owners = await this.observeListenerOwners(signal, timeoutMs)
      if (owners !== null) {
        this.unrelatedListenerBaselines.set(String(input.usageId),
          new Set([...owners].filter(owner => !owner.startsWith(`${String(listener.pid)}:`))))
      }
    }
    const cleanResult = await this.verifyCleanup(String(input.usageId), job, launcher, listener, signal, timeoutMs)
    if (launcher !== null && listener.state === 'listening' && listener.pid !== null
      && target !== null && launcher.effectRef !== null) {
      await this.repository.confirmExecutionEffect({
        usageId: String(input.usageId),
        callId: launcher.callId,
        listenerPid: listener.pid,
        host: target.hostname,
        port: listener.port,
      })
      this.execution.setEffectState(String(input.usageId), 'confirmed')
    }
    const criteria = [launchResult, readyResult, authResult, scopeResult, cleanResult]
    if (cleanResult.result === 'pass') this.execution.setEffectState(String(input.usageId), 'none')
    const run: VerificationRunView = {
      verificationRunId: brandedId<'ExperienceVerificationRunId'>(randomUUID(), 'verificationRunId'),
      usageId: input.usageId,
      controllerRevision: progress.controllerRevision,
      providerVersion: 'dsh-web-guided-v1',
      criteria,
      phase: criteria.every(item => item.result === 'pass')
        ? 'complete'
        : criteria.some(item => item.result === 'unknown') ? 'unknown' : 'pre_cleanup',
      createdAt: new Date().toISOString(),
    }
    return this.repository.recordVerification(input, run, actor)
  }

  private verifyLauncher(
    events: readonly import('@deepseek-ai/dsh-session').SessionEvent[],
    correlation: ExecutionCorrelationView | null,
  ): CriterionVerificationView {
    if (correlation === null) return criterion('WEB-LAUNCH-001', 'unknown', {}, null, 'launcher_correlation_absent')
    const event = events.find(item => item.seq === correlation.callEventSeq && item.type === 'tool/call')
    if (event?.type !== 'tool/call' || String(event.data.callId) !== correlation.callId) {
      return criterion('WEB-LAUNCH-001', 'unknown', {}, null, 'launcher_session_event_absent')
    }
    let argumentsValue: unknown = null
    try {
      argumentsValue = JSON.parse(event.data.arguments) as unknown
    } catch {
      argumentsValue = null
    }
    const command = isRecord(argumentsValue) && typeof argumentsValue.command === 'string'
      ? argumentsValue.command : null
    if (command === null) return criterion('WEB-LAUNCH-001', 'fail', {}, sessionRef(correlation, 'call'), 'launcher_arguments_invalid')
    const supported = /(?:^|\s)(?:pnpm\s+)?dsh\s+web(?:\s|$)/u.test(command)
      && !/[;&|<>`\n]|\$\(/u.test(command)
    const fixedArgs = /(?:^|\s)--no-open(?:\s|$)/u.test(command)
      && /(?:^|\s)--host(?:=|\s+)127\.0\.0\.1(?:\s|$)/u.test(command)
      && /(?:^|\s)--port(?:=|\s+)0(?:\s|$)/u.test(command)
    const background = isRecord(argumentsValue) && argumentsValue.run_in_background === true
    const approved = isApprovedWebLauncherArguments(argumentsValue)
    return criterion('WEB-LAUNCH-001', approved ? 'pass' : 'fail', {
      supported,
      fixedArgs,
      background,
      callEventSeq: correlation.callEventSeq,
    }, sessionRef(correlation, 'call'), approved ? 'supported_launcher_observed' : 'unsupported_launcher')
  }

  private verifyReady(
    job: ReturnType<typeof safeJob>,
    target: URL | null,
    listener: ListenerObservation,
  ): CriterionVerificationView {
    if (target === null || job === null) {
      return criterion('WEB-READY-002', 'unknown', {}, null, 'owned_readiness_target_absent')
    }
    if (job.status !== 'running') {
      return criterion('WEB-READY-002', 'fail', { jobStatus: job.status }, jobRef(job.id), 'readiness_process_not_running')
    }
    if (listener.state !== 'listening' || listener.pid === null) {
      return criterion('WEB-READY-002', listener.state === 'closed' ? 'fail' : 'unknown', {
        jobStatus: job.status,
        listenerState: listener.state,
      }, listener.sourceRef, listener.reasonCode)
    }
    return criterion('WEB-READY-002', 'pass', {
      jobStatus: job.status,
      host: target.hostname,
      port: listener.port,
      listenerPid: listener.pid,
    }, listener.sourceRef, 'owned_listener_alive')
  }

  private async verifyAuth(
    target: URL | null,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<CriterionVerificationView> {
    if (target === null) return criterion('WEB-AUTH-003', 'unknown', {}, null, 'auth_handle_absent')
    const requestSignal = combinedSignal(signal, timeoutMs)
    try {
      const exchange = await fetch(target, { redirect: 'manual', signal: requestSignal })
      const setCookie = exchange.headers.get('set-cookie')
      if (exchange.status !== 303 || exchange.headers.get('location') !== '/' || setCookie === null) {
        return criterion('WEB-AUTH-003', 'fail', {
          exchangeStatus: exchange.status,
          redirectLocation: exchange.headers.get('location'),
          cookieIssued: setCookie !== null,
        }, httpRef(target.origin, 'token-exchange'), 'token_exchange_failed')
      }
      const cookie = setCookie.split(';', 1)[0] ?? ''
      if (cookie === '') return criterion('WEB-AUTH-003', 'fail', { exchangeStatus: exchange.status },
        httpRef(target.origin, 'token-exchange'), 'empty_session_cookie')
      const root = await fetch(`${target.origin}/`, { headers: { cookie }, signal: requestSignal })
      const html = await root.text()
      const manifest = root.status === 200 && /__DSH_BOOT__/u.test(html)
      const rpc = await fetch(`${target.origin}/api/session/list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: `experience-verify-${randomUUID()}`,
          method: 'session/list',
          payload: { args: { _request: {} } },
        }),
        signal: requestSignal,
      })
      const rpcBody: unknown = await rpc.json().catch(() => null)
      const rpcOk = rpc.status === 200 && isRecord(rpcBody) && isRecord(rpcBody.result)
        && rpcBody.result.ok === true
      return criterion('WEB-AUTH-003', manifest && rpcOk ? 'pass' : 'fail', {
        exchangeStatus: exchange.status,
        cleanRootStatus: root.status,
        bootManifestPresent: manifest,
        rpcStatus: rpc.status,
        rpcEnvelopeOk: rpcOk,
        tokenDigest: digest(target.searchParams.get('token') ?? ''),
        cookieDigest: digest(cookie),
      }, httpRef(target.origin, 'authenticated-root-and-rpc'), manifest && rpcOk
        ? 'authenticated_contract_passed' : 'authenticated_readback_failed')
    } catch (error) {
      return criterion('WEB-AUTH-003', 'unknown', {}, httpRef(target.origin, 'authenticated-root-and-rpc'),
        isAbort(error) ? 'authenticated_readback_timeout' : 'authenticated_readback_unknown')
    }
  }

  private verifyScope(target: URL | null, listener: ListenerObservation): CriterionVerificationView {
    if (target === null || listener.state === 'unknown') {
      return criterion('WEB-SCOPE-004', 'unknown', {}, listener.sourceRef, 'listener_scope_unknown')
    }
    const loopback = target.hostname === '127.0.0.1' && listener.host === '127.0.0.1'
    return criterion('WEB-SCOPE-004', loopback ? 'pass' : 'fail', {
      requestedHost: target.hostname,
      observedHost: listener.host,
      port: listener.port,
    }, listener.sourceRef, loopback ? 'loopback_listener_observed' : 'non_loopback_listener_observed')
  }

  private async verifyCleanup(
    usageId: string,
    job: ReturnType<typeof safeJob>,
    launcher: ExecutionCorrelationView | null,
    listener: ListenerObservation,
    signal?: AbortSignal,
    timeoutMs: number = this.timeoutMs,
  ): Promise<CriterionVerificationView> {
    if (job === null || launcher?.effectRef === null || launcher === null) {
      return criterion('WEB-CLEAN-005', 'unknown', {}, null, 'owned_process_reference_absent')
    }
    if (job.status === 'running' || job.status === 'stopping') {
      return criterion('WEB-CLEAN-005', 'not_evaluated', { jobStatus: job.status }, jobRef(job.id), 'cleanup_not_requested')
    }
    if (listener.state === 'unknown') {
      return criterion('WEB-CLEAN-005', 'unknown', { jobStatus: job.status }, listener.sourceRef, 'cleanup_socket_unknown')
    }
    if (listener.state === 'listening') {
      const ownerMismatch = launcher.effectRef.listenerPid !== null && listener.pid !== launcher.effectRef.listenerPid
      return criterion('WEB-CLEAN-005', ownerMismatch ? 'unknown' : 'fail', {
        jobStatus: job.status,
        listenerPid: listener.pid,
        expectedPid: launcher.effectRef.listenerPid,
      }, listener.sourceRef, ownerMismatch ? 'cleanup_pid_owner_mismatch' : 'cleanup_port_still_listening')
    }
    const baseline = this.unrelatedListenerBaselines.get(usageId)
    const currentOwners = baseline === undefined ? null : await this.observeListenerOwners(signal, timeoutMs)
    if (baseline === undefined || currentOwners === null) {
      return criterion('WEB-CLEAN-005', 'unknown', {
        jobStatus: job.status,
        port: listener.port,
        acceptingConnections: false,
      }, listener.sourceRef, 'unrelated_listener_readback_unknown')
    }
    const preserved = [...baseline].every(owner => currentOwners.has(owner))
    if (!preserved) {
      return criterion('WEB-CLEAN-005', 'fail', {
        jobStatus: job.status,
        port: listener.port,
        unrelatedListenerCountBefore: baseline.size,
        unrelatedListenerCountAfter: currentOwners.size,
      }, listener.sourceRef, 'unrelated_listener_changed_during_cleanup')
    }
    this.unrelatedListenerBaselines.delete(usageId)
    return criterion('WEB-CLEAN-005', 'pass', {
      jobStatus: job.status,
      port: listener.port,
      acceptingConnections: false,
      unrelatedListenerCount: baseline.size,
      unrelatedListenersPreserved: true,
    }, listener.sourceRef, 'owned_cleanup_confirmed')
  }

  private async observeListenerOwners(
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<ReadonlySet<string> | null> {
    const shell = this.ctx.get('shell')
    if (shell === undefined) return null
    try {
      const result = await shell.run(shell.resolve({
        command: 'lsof -nP -iTCP -sTCP:LISTEN -Fpc',
        timeoutMs: Math.min(timeoutMs, 5_000),
        stdoutMaxBytes: 65_536,
        ...(signal === undefined ? {} : { signal }),
      }))
      const complete = !result.stdout.truncated && !result.stderr.truncated
      if (result.exitCode === 1 && complete
        && result.stdout.text.trim() === '' && result.stderr.text.trim() === '') return new Set()
      if (result.exitCode !== 0 || !complete) return null
      const owners = new Set<string>()
      let pid: string | null = null
      for (const line of result.stdout.text.split(/\r?\n/u)) {
        if (/^p\d+$/u.test(line)) pid = line.slice(1)
        else if (pid !== null && line.startsWith('c')) owners.add(`${pid}:${line.slice(1)}`)
      }
      return owners
    } catch {
      return null
    }
  }

  private async observeListener(
    port: number,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<ListenerObservation> {
    const shell = this.ctx.get('shell')
    if (shell === undefined) return { state: 'unknown', pid: null, host: null, port,
      reasonCode: 'shell_provider_unavailable', sourceRef: null }
    const command = `lsof -nP -iTCP:${String(port)} -sTCP:LISTEN -Fpnc`
    try {
      const result = await shell.run(shell.resolve({
        command,
        timeoutMs: Math.min(timeoutMs, 5_000),
        stdoutMaxBytes: 16_384,
        ...(signal === undefined ? {} : { signal }),
      }))
      const sourceRef = `external-authority://process-socket/tcp/${String(port)}/${digest({
        exitCode: result.exitCode,
        stdout: result.stdout.text,
        stderr: result.stderr.text,
      })}`
      const complete = !result.stdout.truncated && !result.stderr.truncated
      if (result.exitCode === 1 && complete
        && result.stdout.text.trim() === '' && result.stderr.text.trim() === '') {
        return { state: 'closed', pid: null, host: null, port, reasonCode: 'listener_absent', sourceRef }
      }
      if (result.exitCode !== 0 || !complete) {
        return { state: 'unknown', pid: null, host: null, port,
          reasonCode: 'listener_readback_failed', sourceRef }
      }
      const lines = result.stdout.text.split(/\r?\n/u)
      const pidLine = lines.find(line => /^p\d+$/u.test(line))
      const nameLine = lines.find(line => /^n/u.test(line))
      const pid = pidLine === undefined ? null : Number(pidLine.slice(1))
      const host = nameLine === undefined ? null : listenerHost(nameLine.slice(1), port)
      if (!Number.isSafeInteger(pid) || pid === null || host === null) {
        return { state: 'unknown', pid: null, host: null, port,
          reasonCode: 'listener_owner_unparseable', sourceRef }
      }
      return { state: 'listening', pid, host, port, reasonCode: 'listener_observed', sourceRef }
    } catch {
      return { state: 'unknown', pid: null, host: null, port,
        reasonCode: 'listener_readback_failed', sourceRef: null }
    }
  }
}

function launcherCorrelation(
  values: readonly ExecutionCorrelationView[],
  events: readonly import('@deepseek-ai/dsh-session').SessionEvent[],
): ExecutionCorrelationView | null {
  const candidates = [...values].reverse().filter(item => item.toolName === 'bash'
    && item.effectRef?.kind === 'background_job')
  return candidates.find(candidate => {
    const event = events.find(item => item.seq === candidate.callEventSeq && item.type === 'tool/call')
    if (event?.type !== 'tool/call') return false
    try {
      return isApprovedWebLauncherArguments(JSON.parse(event.data.arguments) as unknown)
    } catch {
      return false
    }
  }) ?? candidates[0] ?? null
}

function preservePass(
  previous: VerificationRunView | null,
  controllerRevision: number,
  id: CriterionVerificationView['criterionId'],
): CriterionVerificationView | null {
  if (previous?.controllerRevision !== controllerRevision
    || previous.providerVersion !== 'dsh-web-guided-v1') return null
  return previous?.criteria.find(item => item.criterionId === id && item.result === 'pass') ?? null
}

function criterion(
  criterionId: CriterionVerificationView['criterionId'],
  result: CriterionVerificationView['result'],
  boundedValue: CriterionVerificationView['boundedValue'],
  sourceRef: string | null,
  reasonCode: string,
): CriterionVerificationView {
  const observedAt = new Date().toISOString()
  const base = { criterionId, mandatory: true as const, result, observedAt, boundedValue, sourceRef, reasonCode }
  return { ...base, integrityDigest: digest(base) }
}

function sessionRef(correlation: ExecutionCorrelationView, kind: 'call' | 'result'): string {
  const seq = kind === 'call' ? correlation.callEventSeq : correlation.resultEventSeq
  return `dsh-session://${correlation.sessionId}/event/${String(seq)}`
}

function jobRef(id: string): string {
  return `harness-job://${id}`
}

function httpRef(origin: string, path: string): string {
  return `external-authority://${new URL(origin).host}/${path}`
}

function safeJob(read: () => import('@deepseek-ai/dsh-jobs').JobSnapshot): import('@deepseek-ai/dsh-jobs').JobSnapshot | null {
  try { return read() } catch { return null }
}

function numericPort(url: URL): number | null {
  const value = Number(url.port)
  return Number.isSafeInteger(value) && value > 0 && value <= 65_535 ? value : null
}

function listenerHost(value: string, port: number): string | null {
  const suffix = `:${String(port)}`
  if (!value.endsWith(suffix)) return null
  const host = value.slice(0, -suffix.length)
  return host === 'localhost' ? '127.0.0.1' : host
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export { CRITERIA as WEB_USAGE_CRITERIA }
