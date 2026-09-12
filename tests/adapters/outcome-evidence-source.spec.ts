import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OutcomeEvidenceSource } from '../../src/adapters/outcome-evidence-source.js'
import type { VerifiedOutcomeManifestConfig } from '../../src/types.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('criterion outcome evidence source', () => {
  it('returns one digest-only SourceRef for repeated exact criterion evidence', async () => {
    const { path, body } = await artifact()
    const evidence = { path, locator: 'experience-verifier:test/result.json', contentDigest: digest(body), bytes: body.length }
    const inspection = await new OutcomeEvidenceSource(manifest(evidence), {
      maxRecords: 8,
      maxTotalBytes: 65_536,
    }).inspect()
    expect(inspection.sourceRefs).toHaveLength(1)
    expect(inspection.sourceRefs[0]).toMatchObject({
      sourceSystem: 'experience-verifier',
      sourceKind: 'external_document',
      locator: evidence.locator,
      contentDigest: evidence.contentDigest,
      redactionState: 'digest_only',
    })
    expect(inspection.records).toHaveLength(2)
    expect(inspection.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: 'acceptance_criterion',
        sourceRef: expect.objectContaining({
          sourceSystem: 'experience-verifier',
          redactionState: 'bounded_excerpt',
        }),
        excerpt: expect.stringContaining('"criterionId":"one"'),
      }),
      expect.objectContaining({ excerpt: expect.stringContaining('"criterionId":"two"') }),
    ]))
    expect(JSON.stringify(inspection.records)).not.toContain(path)
  })

  it('fails closed when the configured evidence body changes', async () => {
    const { path, body } = await artifact()
    const source = new OutcomeEvidenceSource(manifest({
      path,
      locator: 'experience-verifier:test/result.json',
      contentDigest: digest(body),
      bytes: body.length,
    }), { maxRecords: 8, maxTotalBytes: 65_536 })
    await writeFile(path, '{"status":"changed"}\n')
    await expect(source.inspect()).rejects.toMatchObject({ code: 'source_unresolvable' })
  })
})

async function artifact(): Promise<{ readonly path: string; readonly body: Buffer }> {
  const directory = await mkdtemp(join(tmpdir(), 'experience-outcome-evidence-'))
  cleanup.push(directory)
  const path = join(directory, 'result.json')
  const body = Buffer.from('{"status":"accepted"}\n')
  await writeFile(path, body)
  return { path, body }
}

function manifest(evidence: VerifiedOutcomeManifestConfig['criteria'][number]['evidence'][number]): VerifiedOutcomeManifestConfig {
  return {
    episode: { sessionId: 'session-test', eventStart: 0, eventEnd: 2, contentDigest: 'sha256:episode' },
    policyVersion: 'test-outcome-v1',
    criteria: [
      { criterionId: 'one', mandatory: true, result: 'pass', evidence: [evidence] },
      { criterionId: 'two', mandatory: true, result: 'pass', evidence: [evidence] },
    ],
  }
}

function digest(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
