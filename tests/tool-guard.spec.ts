import { describe, expect, it } from 'vitest'
import { createUsageToolGuard, type UsageGuardPolicy } from '../src/adapters/tool-guard.js'
import { usageGuardPolicyDigest } from '../src/domain/execution.js'

describe('M5 Usage-scoped tool guard', () => {
  it('allows only the exact loopback ephemeral Web launcher', () => {
    const current = policy()
    const guard = createUsageToolGuard(() => current)
    expect(guard(execution('bash', {
      command: 'pnpm dsh web --no-open --host 127.0.0.1 --port 0', run_in_background: true,
    }))).toBeUndefined()
    expect(guard(execution('bash', {
      command: 'pnpm dsh web --no-open --host 0.0.0.0 --port 0',
      run_in_background: true,
    }))).toContain('loopback')
    expect(guard(execution('bash', { command: 'pnpm dsh web', run_in_background: true }))).toContain('--no-open')
    expect(guard(execution('bash', {
      command: 'pnpm dsh web --no-open --host 127.0.0.1 --port 0; echo unsafe',
      run_in_background: true,
    }))).toContain('unchained')
    expect(guard(execution('bash', {
      command: 'pnpm dsh web --no-open --host 127.0.0.1 --port 0',
    }))).toContain('background job')
    expect(guard(execution('bash', {
      command: 'echo pnpm dsh web --no-open --host 127.0.0.1 --port 0', run_in_background: true,
    }))).toContain('exact supported')
  })

  it('denies retry while a prior effect is unresolved and never broadens other guards', () => {
    const guard = createUsageToolGuard(() => ({ ...policy(), externalEffectState: 'possible' }))
    expect(guard(execution('bash', {
      command: 'pnpm dsh web --no-open --host 127.0.0.1 --port 0',
      run_in_background: true,
    }))).toContain('unresolved prior Web effect')
    expect(guard(execution('read_file', { path: 'README.md' }))).toBeUndefined()
    const confirmedGuard = createUsageToolGuard(() => ({ ...policy(), externalEffectState: 'confirmed' }))
    expect(confirmedGuard(execution('bash', {
      command: 'pnpm dsh web --no-open --host 127.0.0.1 --port 0',
      run_in_background: true,
    }))).toContain('unresolved prior Web effect')
  })

  it('allows cleanup only through the exact owned background job', () => {
    const guard = createUsageToolGuard(() => policy())
    expect(guard(execution('job_kill', { job_id: 'job-owned' }))).toBeUndefined()
    expect(guard(execution('job_kill', { job_id: 'job-other' }))).toContain('exact owned')
    expect(guard(execution('bash', { command: 'kill -9 1234' }))).toContain('owned background job')
  })

  it('fails closed when the active policy differs from its approved snapshot', () => {
    const guard = createUsageToolGuard(() => ({ ...policy(), policyDigest: 'sha256:changed' }))
    expect(guard(execution('bash', {
      command: 'pnpm dsh web --no-open --host 127.0.0.1 --port 0',
      run_in_background: true,
    }))).toContain('no valid approved execution policy snapshot')
  })
})

function policy(): UsageGuardPolicy {
  return {
    usageId: 'usage-m5',
    planRevision: 1,
    policyDigest: usageGuardPolicyDigest('usage-m5', 1),
    allowedExposure: 'loopback',
    ownedJobIds: new Set(['job-owned']),
    externalEffectState: 'none',
  }
}

function execution(name: string, args: unknown) {
  return { name, arguments: args } as never
}
