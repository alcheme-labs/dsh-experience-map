import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

describe('CORR-E5 frozen evaluation inputs', () => {
  it('binds every runtime label to expected-free replay fixtures', async () => {
    const [manifestBytes, developmentBytes, holdoutBytes, fixtureBytes] = await Promise.all([
      readFile(resolve(root, 'benchmarks/corr-e0/manifest.json')),
      readFile(resolve(root, 'benchmarks/corr-e0/development.json')),
      readFile(resolve(root, 'benchmarks/corr-e0/holdout.json')),
      readFile(resolve(root, 'benchmarks/corr-e0/runtime-fixtures.json')),
    ])
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    const development = JSON.parse(developmentBytes.toString('utf8'))
    const holdout = JSON.parse(holdoutBytes.toString('utf8'))
    const fixtures = JSON.parse(fixtureBytes.toString('utf8'))
    const sessionCases = [development, holdout].flatMap(split => [
      ...split.tasks.extractability,
      ...split.tasks.kind,
    ])
    const groundingCases = [development, holdout].flatMap(split => split.tasks.grounding)

    expect(fixtures.truthManifestSha256).toBe(sha256(manifestBytes))
    expect(Object.keys(fixtures.sessionCases).sort()).toEqual(sessionCases.map(item => item.id).sort())
    expect(Object.keys(fixtures.groundingCases).sort()).toEqual(groundingCases.map(item => item.id).sort())
    expect(hasExpectedKey(fixtures)).toBe(false)
    expect(manifest.totals).toMatchObject({ caseCount: 108, holdoutCount: 24, deidentifiedSessionCount: 54 })
    expect(sha256(developmentBytes)).toBe(manifest.splits.development.sha256)
    expect(sha256(holdoutBytes)).toBe(manifest.splits.holdout.sha256)
  })
})

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function hasExpectedKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasExpectedKey)
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(value).some(([key, child]) => key === 'expected' || hasExpectedKey(child))
}
