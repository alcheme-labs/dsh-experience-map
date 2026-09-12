import type { ToolExecution, ToolGuard } from '@deepseek-ai/dsh-tools'
import { usageGuardPolicyDigest } from '../domain/execution.js'

/** Immutable inputs for one agent/Usage monotonic deny layer. */
export interface UsageGuardPolicy {
  readonly usageId: string
  readonly planRevision: number
  readonly policyDigest: string
  readonly allowedExposure: 'loopback'
  readonly ownedJobIds: ReadonlySet<string>
  readonly externalEffectState: 'none' | 'possible' | 'confirmed' | 'unknown'
}

/** Build a synchronous deny-only guard; it never advances domain progress. */
export function createUsageToolGuard(readPolicy: () => UsageGuardPolicy): ToolGuard {
  return (execution: Readonly<ToolExecution>): string | undefined => {
    const policy = readPolicy()
    if (policy.allowedExposure !== 'loopback'
      || policy.policyDigest !== usageGuardPolicyDigest(policy.usageId, policy.planRevision)) {
      return `Experience Usage ${policy.usageId} has no valid approved execution policy snapshot`
    }
    if (execution.name === 'bash') return guardBash(execution.arguments, policy)
    if (execution.name === 'job_kill') return guardJobKill(execution.arguments, policy)
    return undefined
  }
}

function guardBash(argumentsValue: unknown, policy: UsageGuardPolicy): string | undefined {
  const command = recordString(argumentsValue, 'command')
  if (command === null) return undefined
  if (!/(?:^|\s)(?:pnpm\s+)?dsh\s+web(?:\s|$)/u.test(command)) {
    if (/(?:^|[;&|]\s*)\b(?:kill|pkill)\b/u.test(command)) {
      return `Experience Usage ${policy.usageId} requires cleanup through its exact owned background job`
    }
    return undefined
  }
  if (/[;&|<>`\n]|\$\(/u.test(command)) {
    return `Experience Usage ${policy.usageId} requires one unchained Web launcher command`
  }
  if (recordBoolean(argumentsValue, 'run_in_background') !== true) {
    return `Experience Usage ${policy.usageId} requires the Web launcher to run as an owned background job`
  }
  if (policy.externalEffectState !== 'none') {
    return `Experience Usage ${policy.usageId} has an unresolved prior Web effect; verify it before retrying`
  }
  if (/(?:^|\s)--host(?:=|\s+)0\.0\.0\.0(?:\s|$)/u.test(command)
    || /(?:^|\s)--host(?:=|\s+)::(?:\s|$)/u.test(command)) {
    return `Experience Usage ${policy.usageId} allows loopback Web listeners only`
  }
  if (!/(?:^|\s)--no-open(?:\s|$)/u.test(command)
    || !/(?:^|\s)--host(?:=|\s+)127\.0\.0\.1(?:\s|$)/u.test(command)
    || !/(?:^|\s)--port(?:=|\s+)0(?:\s|$)/u.test(command)) {
    return `Experience Usage ${policy.usageId} requires --no-open --host 127.0.0.1 --port 0`
  }
  if (!isApprovedWebLauncherArguments(argumentsValue)) {
    return `Experience Usage ${policy.usageId} requires the exact supported Web launcher command`
  }
  return undefined
}

/** Recognize the fixed first-scenario launcher without attempting general shell parsing. */
export function isApprovedWebLauncherArguments(value: unknown): boolean {
  const command = recordString(value, 'command')
  if (command === null || recordBoolean(value, 'run_in_background') !== true) return false
  const normalized = command.trim().replace(/[ \t]+/gu, ' ')
  return normalized === 'dsh web --no-open --host 127.0.0.1 --port 0'
    || normalized === 'pnpm dsh web --no-open --host 127.0.0.1 --port 0'
}

function guardJobKill(argumentsValue: unknown, policy: UsageGuardPolicy): string | undefined {
  const jobId = recordString(argumentsValue, 'job_id')
  if (jobId === null || !policy.ownedJobIds.has(jobId)) {
    return `Experience Usage ${policy.usageId} may clean up only an exact owned background job`
  }
  return undefined
}

function recordString(value: unknown, key: string): string | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as Record<string, unknown>)[key] === 'string'
    ? (value as Record<string, string>)[key]! : null
}

function recordBoolean(value: unknown, key: string): boolean | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as Record<string, unknown>)[key] === 'boolean'
    ? (value as Record<string, boolean>)[key]! : null
}
