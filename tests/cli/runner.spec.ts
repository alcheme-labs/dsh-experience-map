import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../../src/cli/runner.js'
import { ExperienceError, publicFailure } from '../../src/errors.js'

const cleanup: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('management CLI async runner', () => {
  it('commits Forget from an exact JSON command and returns receipt plus per-owner readback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-map-cli-forget-'))
    cleanup.push(directory)
    const inputPath = join(directory, 'forget.json')
    await writeFile(inputPath, JSON.stringify({
      commandId: '70000000-0000-4000-8000-000000000001',
      experienceId: 'experience-1', expectedSeriesRevision: 2,
      previewDigest: `sha256:${'a'.repeat(64)}`,
      reason: 'Owner confirmed obsolete guidance', correlationId: 'cli-forget', causationId: null,
      issuedAt: '2026-09-02T09:00:00.000Z',
    }))
    const stdout: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk))
      return true
    })
    const receipt = {
      receiptId: 'receipt-forget-1', action: 'experience.forget', forgetRequestId: 'forget-1',
      experienceId: 'experience-1',
    }
    const forgetExperience = vi.fn(async () => receipt)
    const getReceipt = vi.fn(() => receipt)
    const getForgetRequest = vi.fn(() => ({ forgetRequestId: 'forget-1', state: 'completed' }))
    const ctx = new Context()
    ctx.provide('experiences', { forgetExperience, getReceipt, getForgetRequest } as never)
    ctx.provide('fs', {
      resolve: async (path: string) => path,
      readText: async (target: string) => readFile(target, 'utf8'),
    } as never)
    ctx.provide('experienceCliSpec', { kind: 'forget', inputPath })
    ctx.provide('appReady', { onReady(listener: () => void) { listener(); return () => {} } })
    const exited = new Promise<number>(resolve => { ctx.provide('appExit', resolve) })

    apply(ctx)

    expect(await exited).toBe(0)
    expect(forgetExperience).toHaveBeenCalledWith(expect.objectContaining({
      experienceId: 'experience-1', expectedSeriesRevision: 2,
    }), { kind: 'management-cli' })
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      ok: true,
      value: { receipt: { action: 'experience.forget' }, forget: { state: 'completed' } },
    })
  })

  it('reads the M6 learning projection after application readiness', async () => {
    const ctx = new Context()
    const stdout: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk))
      return true
    })
    ctx.provide('experiences', {
      getLearningProjection: async () => ({ projectionKey: 'experience-learning-v1', generation: 3 }),
    } as never)
    ctx.provide('experienceCliSpec', { kind: 'learning-show' })
    ctx.provide('appReady', { onReady(listener: () => void) { listener(); return () => {} } })
    const exited = new Promise<number>(resolve => { ctx.provide('appExit', resolve) })

    apply(ctx)

    expect(await exited).toBe(0)
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      ok: true, value: { projectionKey: 'experience-learning-v1', generation: 3 },
    })
  })

  it('reads the same active suggestion generation exposed by the Host', async () => {
    const ctx = new Context()
    const stdout: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk))
      return true
    })
    const projection = {
      projectionKey: 'experience-suggestions-v1', generation: 2, sessions: [], seeds: [],
      groups: [{
        suggestionGroupId: 'suggestion-group:vector-shortlist',
        consolidation: 'possible_duplicate', saveReadiness: 'needs_review',
        readinessReasons: ['semantic_duplicate_vector_only_unverified'],
      }],
    }
    ctx.provide('experiences', { getSuggestionProjection: () => projection } as never)
    ctx.provide('experienceCliSpec', { kind: 'suggestions-show' })
    ctx.provide('appReady', { onReady(listener: () => void) { listener(); return () => {} } })
    const exited = new Promise<number>(resolve => { ctx.provide('appExit', resolve) })

    apply(ctx)

    expect(await exited).toBe(0)
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      ok: true,
      value: {
        projectionKey: 'experience-suggestions-v1', generation: 2,
        groups: [{
          consolidation: 'possible_duplicate', saveReadiness: 'needs_review',
          readinessReasons: ['semantic_duplicate_vector_only_unverified'],
        }],
      },
    })
  })

  it('saves one exact automatic suggestion through the canonical Host service', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-map-cli-suggestion-save-'))
    cleanup.push(directory)
    const inputPath = join(directory, 'save.json')
    await writeFile(inputPath, JSON.stringify({
      commandId: '72000000-0000-4000-8000-000000000001',
      suggestionGroupId: 'suggestion-group:procedure-1',
      expectedRevisionDigest: `sha256:${'a'.repeat(64)}`,
      reviewDigest: `sha256:${'b'.repeat(64)}`,
      sourceDigest: `sha256:${'c'.repeat(64)}`,
      ownerChoice: {
        choice: 'attach_existing',
        targetExperienceVersionId: 'version-existing',
        materialDifferences: [],
      },
      correlationId: 'cli-suggestion-save', causationId: null,
      issuedAt: '2026-09-11T00:00:00.000Z',
    }))
    const stdout: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk))
      return true
    })
    const receipt = {
      receiptId: 'receipt-suggestion-1', action: 'suggestion.save',
      outcome: 'saved_new_experience', experienceVersionId: 'version-1',
    }
    const saveExperienceSuggestion = vi.fn(async () => receipt)
    const ctx = new Context()
    ctx.provide('experiences', { saveExperienceSuggestion } as never)
    ctx.provide('fs', {
      resolve: async (path: string) => path,
      readText: async (target: string) => readFile(target, 'utf8'),
    } as never)
    ctx.provide('experienceCliSpec', { kind: 'suggestion-save', inputPath } as never)
    ctx.provide('appReady', { onReady(listener: () => void) { listener(); return () => {} } })
    const exited = new Promise<number>(resolve => { ctx.provide('appExit', resolve) })

    apply(ctx)

    expect(await exited).toBe(0)
    expect(saveExperienceSuggestion).toHaveBeenCalledWith(expect.objectContaining({
      suggestionGroupId: 'suggestion-group:procedure-1',
      reviewDigest: `sha256:${'b'.repeat(64)}`,
      ownerChoice: {
        choice: 'attach_existing',
        targetExperienceVersionId: 'version-existing',
        materialDifferences: [],
      },
    }), { kind: 'management-cli' })
    expect(JSON.parse(stdout.join(''))).toEqual({ ok: true, value: receipt })
  })

  it('dismisses one exact automatic suggestion through the canonical projection owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-map-cli-suggestion-dismiss-'))
    cleanup.push(directory)
    const inputPath = join(directory, 'dismiss.json')
    await writeFile(inputPath, JSON.stringify({
      commandId: '72000000-0000-4000-8000-000000000002',
      suggestionGroupId: 'suggestion-group:procedure-1',
      expectedRevisionDigest: `sha256:${'a'.repeat(64)}`,
      reviewDigest: `sha256:${'b'.repeat(64)}`,
      reasonCode: 'not_reusable',
      issuedAt: '2026-09-11T00:00:00.000Z',
    }))
    const stdout: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk))
      return true
    })
    const projection = {
      projectionKey: 'experience-suggestions-v1', generation: 3, groups: [],
    }
    const dismissSuggestion = vi.fn(() => projection)
    const ctx = new Context()
    ctx.provide('experiences', { dismissSuggestion } as never)
    ctx.provide('fs', {
      resolve: async (path: string) => path,
      readText: async (target: string) => readFile(target, 'utf8'),
    } as never)
    ctx.provide('experienceCliSpec', { kind: 'suggestion-dismiss', inputPath } as never)
    ctx.provide('appReady', { onReady(listener: () => void) { listener(); return () => {} } })
    const exited = new Promise<number>(resolve => { ctx.provide('appExit', resolve) })

    apply(ctx)

    expect(await exited).toBe(0)
    expect(dismissSuggestion).toHaveBeenCalledWith(expect.objectContaining({
      suggestionGroupId: 'suggestion-group:procedure-1', reasonCode: 'not_reusable',
    }), { kind: 'management-cli' })
    expect(JSON.parse(stdout.join(''))).toEqual({ ok: true, value: projection })
  })

  it('reads the active retrieval generation without vector payloads', async () => {
    const ctx = new Context()
    const stdout: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk))
      return true
    })
    ctx.provide('experiences', {
      getRetrievalProjection: () => ({
        projectionKey: 'experience-retrieval-v1', manifest: { generation: 4, vectorCount: 0 }, documents: [],
      }),
    } as never)
    ctx.provide('experienceCliSpec', { kind: 'retrieval-show' })
    ctx.provide('appReady', { onReady(listener: () => void) { listener(); return () => {} } })
    const exited = new Promise<number>(resolve => { ctx.provide('appExit', resolve) })

    apply(ctx)

    expect(await exited).toBe(0)
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      ok: true, value: { projectionKey: 'experience-retrieval-v1', manifest: { generation: 4 } },
    })
    expect(stdout.join('')).not.toContain('vector_json')
  })

  it('reads configured and effective automation controls through the management surface', async () => {
    const ctx = new Context()
    const stdout: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk))
      return true
    })
    ctx.provide('experiences', {
      getAutomationConfiguration: () => ({
          schemaVersion: 'experience-automation-configuration-v1',
          suggestionDetection: { configured: true, effective: true, availability: 'enabled' },
          recall: { configured: true, effective: true, availability: 'enabled' },
          contextInjection: {
            configured: 'after_current_plan_approval',
            effective: 'after_current_plan_approval',
            availability: 'enabled',
          },
          toolExecution: {
            configured: 'when_eligible', effective: 'disabled', availability: 'configured_but_unavailable',
            reasonCodes: ['execution_binding_unavailable'],
          },
      }),
    } as never)
    ctx.provide('experienceCliSpec', { kind: 'automation-config-show' })
    ctx.provide('appReady', { onReady(listener: () => void) { listener(); return () => {} } })
    const exited = new Promise<number>(resolve => { ctx.provide('appExit', resolve) })

    apply(ctx)

    expect(await exited).toBe(0)
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      ok: true,
      value: {
        suggestionDetection: { configured: true, effective: true },
        recall: { configured: true, effective: true },
        contextInjection: { effective: 'after_current_plan_approval' },
        toolExecution: {
          configured: 'when_eligible', effective: 'disabled', availability: 'configured_but_unavailable',
        },
      },
    })
  })

  it('declares a canonical relation through the management parser and reads its receipt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'experience-map-cli-relation-'))
    cleanup.push(directory)
    const inputPath = join(directory, 'relation.json')
    await writeFile(inputPath, JSON.stringify({
      commandId: '71000000-0000-4000-8000-000000000001',
      relationType: 'precedes',
      sourceObjectRef: { kind: 'component', id: 'component-a' },
      targetObjectRef: { kind: 'component', id: 'component-b' },
      scope: { workspace: 'deepseek-harness' }, qualifiers: {},
      validFrom: '2026-09-03T00:00:00.000Z', validTo: null, evidenceIds: [],
      correlationId: 'cli-relation', causationId: null, issuedAt: '2026-09-03T00:00:00.000Z',
    }))
    const stdout: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk))
      return true
    })
    const relationReceipt = { receiptId: 'receipt-relation-1', relationId: 'relation-1' }
    const domainReceipt = { ...relationReceipt, action: 'relation.declare' }
    const declareRelation = vi.fn(async () => relationReceipt)
    const getReceipt = vi.fn(() => domainReceipt)
    const ctx = new Context()
    ctx.provide('experiences', { declareRelation, getReceipt } as never)
    ctx.provide('fs', {
      resolve: async (path: string) => path,
      readText: async (target: string) => readFile(target, 'utf8'),
    } as never)
    ctx.provide('experienceCliSpec', { kind: 'relation-declare', inputPath })
    ctx.provide('appReady', { onReady(listener: () => void) { listener(); return () => {} } })
    const exited = new Promise<number>(resolve => { ctx.provide('appExit', resolve) })

    apply(ctx)

    expect(await exited).toBe(0)
    expect(declareRelation).toHaveBeenCalledWith(expect.objectContaining({
      relationType: 'precedes', sourceObjectRef: { kind: 'component', id: 'component-a' },
    }), { kind: 'management-cli' })
    expect(JSON.parse(stdout.join(''))).toEqual({ ok: true, value: domainReceipt })
  })

  it('sanitizes an asynchronous failure and requests a non-zero bounded exit', async () => {
    const ctx = new Context()
    const stderr: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk))
      return true
    })
    ctx.provide('experiences', {
      getReceipt: () => { throw new Error('/private/database/path: constraint failed') },
    } as never)
    ctx.provide('experienceCliSpec', { kind: 'receipt-get', receiptId: 'receipt-1' })
    ctx.provide('appReady', {
      onReady(listener: () => void) {
        listener()
        return () => {}
      },
    })
    const exited = new Promise<number>((resolve) => {
      ctx.provide('appExit', resolve)
    })
    apply(ctx)
    expect(await exited).toBe(1)
    expect(stderr.join('')).toContain('Experience operation failed')
    expect(stderr.join('')).not.toContain('/private/database/path')
  })

  it('uses the same stable public form for unknown failures', () => {
    expect(publicFailure(new Error('sensitive internal text'))).toEqual({
      code: 'internal', message: 'Experience operation failed', details: {},
    })
  })

  it('preserves a branded Experience error across independently bundled faces', () => {
    const error = new Error('CommandId was already used with a different payload') as Error & {
      code: string
      details: Readonly<Record<string, unknown>>
      [key: symbol]: unknown
    }
    error[Symbol.for('dsh-experience-map/ExperienceError')] = true
    error.code = 'idempotency_conflict'
    error.details = {}

    expect(publicFailure(error)).toEqual({
      code: 'idempotency_conflict',
      message: 'CommandId was already used with a different payload',
      details: {},
    })
  })

  it('does not trust an unbranded error that imitates a public code', () => {
    const error = Object.assign(new Error('sensitive internal text'), {
      code: 'idempotency_conflict',
      details: {},
    })
    expect(error).not.toBeInstanceOf(ExperienceError)
    expect(publicFailure(error)).toEqual({
      code: 'internal', message: 'Experience operation failed', details: {},
    })
  })
})
