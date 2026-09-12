import { digest } from './planning.js'

/** Immutable policy revision enforced while one Web-startup Usage is active. */
export const GUIDED_WEB_POLICY_VERSION = 'm5-web-guard-v1'

/** Derive the approved deny-layer policy snapshot reference for one Plan revision. */
export function usageGuardPolicyDigest(usageId: string, planRevision: number): string {
  return digest({
    schemaVersion: GUIDED_WEB_POLICY_VERSION,
    usageId,
    planRevision,
    launcher: 'dsh web --no-open --host 127.0.0.1 --port 0',
    allowedExposure: 'loopback',
    cleanup: 'owned_background_job_only',
  })
}
