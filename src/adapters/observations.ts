import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-shell'
import { digest } from '../domain/planning.js'
import type { PlanningObservationKind, PlanningObservationView, PlanningTaskInput } from '../types.js'

const MAX_OBSERVATION_SOURCE_BYTES = 262_144

/** Read current facts through Harness capability seams without owning generic I/O. */
export class PlanningObservationRegistry {
  /** Bind optional Profile capabilities. Missing providers become typed unknown. */
  constructor(
    private readonly ctx: Context,
    private readonly freshnessMs: number,
  ) {}

  /** Observe all five fixed M3 scenario fact classes in stable order. */
  async observe(
    task: PlanningTaskInput,
    signal?: AbortSignal,
    freshnessMs: number = this.freshnessMs,
  ): Promise<PlanningObservationView[]> {
    const now = new Date().toISOString()
    const validUntil = new Date(Date.parse(now) + freshnessMs).toISOString()
    const repository = await this.repositoryState(task, now, validUntil, signal)
    const artifacts = await this.buildArtifacts(task, now, validUntil, signal)
    const contract = await this.webContract(task, now, validUntil, signal)
    return [
      repository,
      artifacts,
      contract,
      this.unknown('process_socket', 'No Experience-owned process reference exists before M5 execution', 'owned_process_absent', now, validUntil),
      this.unknown('authenticated_http', 'No explicit authenticated target and credential reference were supplied', 'authenticated_target_absent', now, validUntil),
    ]
  }

  private async repositoryState(
    task: PlanningTaskInput,
    now: string,
    validUntil: string,
    signal?: AbortSignal,
  ): Promise<PlanningObservationView> {
    if (task.workspaceRoot === null) {
      return this.unknown('repository_state', 'Task has no workspace root', 'workspace_root_absent', now, validUntil)
    }
    const fs = this.ctx.get('fs')
    if (fs === undefined) return this.unknown('repository_state', 'Filesystem provider unavailable', 'fs_provider_unavailable', now, validUntil)
    try {
      const packageTarget = await fs.resolve('package.json', {
        cwd: task.workspaceRoot,
        ...(signal === undefined ? {} : { signal }),
      })
      const info = await fs.stat(packageTarget, signal)
      if (info?.type !== 'file') {
        return this.unknown('repository_state', 'package.json is unavailable', 'package_manifest_absent', now, validUntil)
      }
      if ((info.size ?? 0) > MAX_OBSERVATION_SOURCE_BYTES) {
        return this.unknown('repository_state', 'package.json exceeds the observation safety limit', 'package_manifest_too_large', now, validUntil)
      }
      const manifestText = await fs.readText(packageTarget, signal)
      const manifest = JSON.parse(manifestText) as unknown
      const values: Record<string, string | number | boolean | null> = {
        packageManifestPresent: true,
        packageManifestBytes: info.size ?? Buffer.byteLength(manifestText),
        packageManager: recordString(manifest, 'packageManager'),
        nodeEngine: nestedRecordString(manifest, 'engines', 'node'),
        revision: null,
        dirty: null,
      }
      const shell = this.ctx.get('shell')
      if (shell !== undefined) {
        const result = await shell.run(shell.resolve({
          command: 'git status --porcelain=v1 && git rev-parse HEAD',
          workdir: task.workspaceRoot,
          timeoutMs: 5_000,
          stdoutMaxBytes: 65_536,
          ...(signal === undefined ? {} : { signal }),
        }))
        const output = result.stdout.text.trim().split(/\r?\n/u)
        if (result.exitCode === 0 && !result.stdout.truncated) {
          values.revision = output.at(-1) ?? null
          values.dirty = output.slice(0, -1).some((line: string) => line.trim() !== '')
        }
      }
      return this.observed('repository_state', 'Current repository metadata was read through Harness fs/shell', values,
        [packageTarget.displayPath], now, validUntil)
    } catch (error) {
      return this.unknown('repository_state', errorMessage(error), errorCode(error, 'repository_observation_failed'), now, validUntil)
    }
  }

  private async buildArtifacts(
    task: PlanningTaskInput,
    now: string,
    validUntil: string,
    signal?: AbortSignal,
  ): Promise<PlanningObservationView> {
    if (task.workspaceRoot === null) {
      return this.unknown('build_artifact', 'Task has no workspace root', 'workspace_root_absent', now, validUntil)
    }
    const fs = this.ctx.get('fs')
    if (fs === undefined) return this.unknown('build_artifact', 'Filesystem provider unavailable', 'fs_provider_unavailable', now, validUntil)
    try {
      const paths = ['apps/web/dist', 'apps/cli/lib', 'lib']
      const values: Record<string, string | number | boolean | null> = {}
      const refs: string[] = []
      for (const path of paths) {
        const target = await fs.resolve(path, {
          cwd: task.workspaceRoot,
          ...(signal === undefined ? {} : { signal }),
        })
        const info = await fs.stat(target, signal)
        values[path] = info !== undefined
        if (info !== undefined) refs.push(target.displayPath)
      }
      return this.observed('build_artifact', 'Configured build artifact locations were checked', values, refs, now, validUntil)
    } catch (error) {
      return this.unknown('build_artifact', errorMessage(error), errorCode(error, 'artifact_observation_failed'), now, validUntil)
    }
  }

  private async webContract(
    task: PlanningTaskInput,
    now: string,
    validUntil: string,
    signal?: AbortSignal,
  ): Promise<PlanningObservationView> {
    if (task.workspaceRoot === null) {
      return this.unknown('web_contract', 'Task has no workspace root', 'workspace_root_absent', now, validUntil)
    }
    const fs = this.ctx.get('fs')
    if (fs === undefined) return this.unknown('web_contract', 'Filesystem provider unavailable', 'fs_provider_unavailable', now, validUntil)
    try {
      const candidates = [
        'packages/bundle/web-app/README.md',
        'packages/bundle/web-app/cordis.patch.yml',
        'docs/architecture.md',
      ]
      const refs: string[] = []
      let combined = ''
      for (const path of candidates) {
        const target = await fs.resolve(path, {
          cwd: task.workspaceRoot,
          ...(signal === undefined ? {} : { signal }),
        })
        const info = await fs.stat(target, signal)
        if (info?.type !== 'file' || (info.size ?? 0) > MAX_OBSERVATION_SOURCE_BYTES) continue
        combined += `\n${await fs.readText(target, signal)}`
        refs.push(target.displayPath)
      }
      if (combined === '') return this.unknown('web_contract', 'No supported Web contract source was found', 'web_contract_source_absent', now, validUntil)
      const authRequired = /auth|authenticated|credential|token|cookie/iu.test(combined)
      return this.observed('web_contract', 'Current Harness Web contract sources were inspected', {
        authRequired,
        loopbackOnly: /127\.0\.0\.1|localhost|loopback/iu.test(combined),
        contractSources: refs.length,
      }, refs, now, validUntil)
    } catch (error) {
      return this.unknown('web_contract', errorMessage(error), errorCode(error, 'web_contract_observation_failed'), now, validUntil)
    }
  }

  private observed(
    kind: PlanningObservationKind,
    summary: string,
    values: Readonly<Record<string, string | number | boolean | null>>,
    sourceRefs: readonly string[],
    observedAt: string,
    validUntil: string,
  ): PlanningObservationView {
    const base = {
      observationId: randomUUID(),
      kind,
      providerVersion: 'harness-capability-adapter-v1',
      status: 'observed' as const,
      summary,
      values,
      sourceRefs,
      observedAt,
      validUntil,
      reasonCode: null,
    }
    return { ...base, contentDigest: digest(base) }
  }

  private unknown(
    kind: PlanningObservationKind,
    summary: string,
    reasonCode: string,
    observedAt: string,
    validUntil: string,
  ): PlanningObservationView {
    const base = {
      observationId: randomUUID(),
      kind,
      providerVersion: 'harness-capability-adapter-v1',
      status: 'unknown' as const,
      summary,
      values: {},
      sourceRefs: [],
      observedAt,
      validUntil,
      reasonCode,
    }
    return { ...base, contentDigest: digest(base) }
  }
}

function recordString(value: unknown, key: string): string | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as Record<string, unknown>)[key] === 'string'
    ? (value as Record<string, string>)[key]! : null
}

function nestedRecordString(value: unknown, outer: string, inner: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return recordString((value as Record<string, unknown>)[outer], inner)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown, fallback: string): string {
  return typeof error === 'object' && error !== null && typeof Reflect.get(error, 'code') === 'string'
    ? String(Reflect.get(error, 'code')) : fallback
}
