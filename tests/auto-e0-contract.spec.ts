import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXPERIENCE_DB_SCHEMA_VERSION } from '../src/persistence/schema.js'

const root = resolve(import.meta.dirname, '..')

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(root, path), 'utf8')) as T
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

interface Benchmark {
  readonly replay: { readonly sha256: string }
  readonly environment: { readonly node: string; readonly remoteAccessEnabledForThisRun: boolean }
  readonly baselines: {
    readonly b0: { readonly baseCommit: string; readonly quality: Quality }
    readonly miniSearch: { readonly quality: Quality }
  }
  readonly models: readonly ModelResult[]
  readonly decision: { readonly embeddingDefault: string; readonly lexicalDefault: string }
}

interface Quality {
  readonly extractionPrecision: number
  readonly identityFalseMerges: number
  readonly recallHarmfulMatches: number
  readonly recallTop1Accuracy: number
}

interface ModelResult {
  readonly id: string
  readonly status: string
  readonly loader: string
  readonly runtimeProfile: string
  readonly artifactVerified: boolean
  readonly passesDenseRecallGate: boolean
  readonly quality: Quality
  readonly roleDecision: {
    readonly extraction: string
    readonly kindClassification: string
    readonly exactIdentityMerge: string
    readonly recallRanking: string
  }
}

describe('AUTO E0 dependency and quality gate', () => {
  it('freezes four independent truth sets and adversarial negatives against B0', async () => {
    const source = await readFile(resolve(root, 'benchmarks/auto-e0/replay.json'), 'utf8')
    const replay = JSON.parse(source) as {
      readonly schemaVersion: string
      readonly baseCommit: string
      readonly qualityGates: { readonly identityFalseMerges: number; readonly recallHarmfulMatches: number }
      readonly sessionCases: readonly { readonly shouldExtract: boolean; readonly kind: string | null }[]
      readonly identityCases: readonly { readonly sameExperience: boolean }[]
      readonly recallCases: readonly { readonly requiredNegative: boolean; readonly forbiddenIds: readonly string[] }[]
    }
    const decision = await json<{ readonly replay: { readonly sha256: string } }>('evidence/auto/e0/decision-record.json')

    expect(replay.schemaVersion).toBe('experience-auto-e0-replay-v1')
    expect(replay.baseCommit).toBe('5543cb6')
    expect(replay.sessionCases.some(item => item.shouldExtract && item.kind === 'procedure')).toBe(true)
    expect(replay.sessionCases.some(item => item.shouldExtract && item.kind === 'diagnostic')).toBe(true)
    expect(replay.sessionCases.some(item => !item.shouldExtract && item.kind === null)).toBe(true)
    expect(replay.identityCases.some(item => item.sameExperience)).toBe(true)
    expect(replay.identityCases.some(item => !item.sameExperience)).toBe(true)
    expect(replay.recallCases.filter(item => item.requiredNegative)).not.toHaveLength(0)
    expect(replay.recallCases.filter(item => item.requiredNegative)
      .every(item => item.forbiddenIds.length > 0)).toBe(true)
    expect(replay.qualityGates).toEqual(expect.objectContaining({
      identityFalseMerges: 0,
      recallHarmfulMatches: 0,
    }))
    expect(decision.replay.sha256).toBe(sha256(source))
  })

  it.each([
    ['evidence/auto/e0/benchmark-offline-node22.json', /^v22\./],
    ['evidence/auto/e0/benchmark-offline-node24.json', /^v24\./],
  ])('proves the selected dense model reloads offline on %s', async (path, nodePattern) => {
    const benchmark = await json<Benchmark>(path)
    const selected = benchmark.models.find(item => item.id === 'multilingual-e5-small')

    expect(benchmark.environment.node).toMatch(nodePattern)
    expect(benchmark.environment.remoteAccessEnabledForThisRun).toBe(false)
    expect(benchmark.replay.sha256).toBe('sha256:2ee140cf177a796f841a867a366825a2b19515ac864d84a71125913c3464dddd')
    expect(benchmark.baselines.b0.baseCommit).toBe('5543cb6')
    expect(selected).toEqual(expect.objectContaining({
      status: 'ok',
      loader: 'verified_local_revision_directory',
      runtimeProfile: 'single-consumer-sequential-no-cpu-arena',
      artifactVerified: true,
      passesDenseRecallGate: true,
    }))
    expect(selected?.quality).toEqual(expect.objectContaining({
      recallHarmfulMatches: 0,
      recallTop1Accuracy: 1,
    }))
    expect(selected?.roleDecision).toEqual({
      extraction: 'not_authorized',
      kindClassification: 'not_authorized',
      exactIdentityMerge: 'not_authorized',
      possibleDuplicateDiscovery: 'advisory_only',
      recallRanking: 'eligible_after_hard_filters_and_abstain',
    })
    expect(benchmark.decision).toEqual(expect.objectContaining({
      embeddingDefault: 'multilingual-e5-small',
      lexicalDefault: 'minisearch',
    }))
  })

  it('does not misrepresent lexical or semantic similarity as extraction or identity truth', async () => {
    const benchmark = await json<Benchmark>('evidence/auto/e0/benchmark-offline-node22.json')
    const e5 = benchmark.models.find(item => item.id === 'multilingual-e5-small')!

    expect(benchmark.baselines.miniSearch.quality.extractionPrecision).toBeLessThan(1)
    expect(benchmark.baselines.miniSearch.quality.identityFalseMerges).toBeGreaterThan(0)
    expect(e5.quality.extractionPrecision).toBeLessThan(1)
    expect(e5.quality.identityFalseMerges).toBeGreaterThan(0)
    expect(e5.roleDecision.extraction).toBe('not_authorized')
    expect(e5.roleDecision.exactIdentityMerge).toBe('not_authorized')
  })

  it('keeps schema v8 canonical and freezes one cross-connection save transaction', async () => {
    const decision = await json<{
      readonly status: string
      readonly canonicalSchemaReuse: { readonly schemaVersion: number; readonly newCanonicalTables: readonly string[] }
      readonly saveExperienceSuggestionTransaction: {
        readonly command: string
        readonly action: string
        readonly transactionMode: string
        readonly concurrency: string
        readonly possibleDuplicate: string
      }
      readonly identityDecision: { readonly neverIdentityInputs: readonly string[] }
    }>('evidence/auto/e0/decision-record.json')
    const database = await readFile(resolve(root, 'src/persistence/database.ts'), 'utf8')

    expect(decision.status).toBe('passed')
    expect(decision.canonicalSchemaReuse).toEqual({
      ...decision.canonicalSchemaReuse,
      schemaVersion: EXPERIENCE_DB_SCHEMA_VERSION,
      newCanonicalTables: [],
    })
    expect(decision.saveExperienceSuggestionTransaction).toEqual(expect.objectContaining({
      command: 'SaveExperienceSuggestion',
      action: 'suggestion.save',
      transactionMode: 'BEGIN IMMEDIATE through the existing ExperienceDatabase.write owner',
    }))
    expect(decision.saveExperienceSuggestionTransaction.concurrency).toContain('every connection')
    expect(decision.saveExperienceSuggestionTransaction.possibleDuplicate).toContain('never auto-merges')
    expect(decision.identityDecision.neverIdentityInputs).toContain('embedding score')
    expect(database).toContain("this.handle.exec('BEGIN IMMEDIATE')")
  })

  it('selects only the minimum runtime dependencies and forbids silent remote fallback', async () => {
    const pkg = await json<{
      readonly dependencies: Record<string, string>
      readonly optionalDependencies?: Record<string, string>
      readonly peerDependencies: Record<string, string>
      readonly peerDependenciesMeta: Record<string, { readonly optional?: boolean }>
      readonly devDependencies: Record<string, string>
    }>('package.json')
    const decision = await json<{
      readonly embeddingProviderContract: {
        readonly typedFailures: readonly string[]
        readonly invariants: readonly string[]
        readonly implementations: Record<string, string>
      }
      readonly dependencyDecision: { readonly rejectedOrGated: Record<string, string> }
    }>('evidence/auto/e0/decision-record.json')

    expect(pkg.dependencies).toEqual({ minisearch: '7.2.0' })
    expect(pkg.optionalDependencies?.['@huggingface/transformers']).toBeUndefined()
    expect(pkg.peerDependencies['@huggingface/transformers']).toBe('4.2.0')
    expect(pkg.peerDependenciesMeta['@huggingface/transformers']).toEqual({ optional: true })
    expect(pkg.devDependencies.minisearch).toBeUndefined()
    expect(pkg.devDependencies['@huggingface/transformers']).toBe('4.2.0')
    expect(decision.embeddingProviderContract.typedFailures).toContain('remote_not_opted_in')
    expect(decision.embeddingProviderContract.invariants).toContain('no silent provider fallback')
    expect(decision.embeddingProviderContract.implementations.ollama).toContain('unimplemented')
    expect(Object.keys(decision.dependencyDecision.rejectedOrGated)).toEqual(expect.arrayContaining([
      'fts5', 'sqliteVecAnn', 'reranker', 'graphDatabase', 'memoryFramework',
    ]))
  })

  it('loads the packed Host and CLI faces without shipping model or development files', async () => {
    const smoke = await json<{
      readonly status: string
      readonly package: string
      readonly loadedExports: { readonly host: readonly string[]; readonly cliStartup: readonly string[]; readonly cliRunner: readonly string[] }
      readonly runtimeDependencies: Record<string, string>
      readonly optionalRuntimeDependencies: Record<string, string>
      readonly forbiddenEntries: readonly string[]
      readonly modelArtifactsBundled: boolean
    }>('evidence/auto/e0/packed-smoke.json')

    expect(smoke).toEqual(expect.objectContaining({
      status: 'passed',
      package: '@alcheme/dsh-experience-map@0.0.0-development',
      forbiddenEntries: [],
      modelArtifactsBundled: false,
      runtimeDependencies: { minisearch: '7.2.0' },
      optionalRuntimeDependencies: { '@huggingface/transformers': '4.2.0' },
    }))
    expect(smoke.loadedExports.host).toContain('Experiences')
    expect(smoke.loadedExports.cliStartup).toContain('apply')
    expect(smoke.loadedExports.cliRunner).toContain('apply')
  })

  it('records every installed production-subtree package with a known lockfile-covered license', async () => {
    const inventory = await json<{
      readonly status: string
      readonly packageCount: number
      readonly licenseCounts: Record<string, number>
      readonly packages: readonly {
        readonly name: string
        readonly license: string
        readonly lockfileCovered: boolean
        readonly installScripts: readonly string[]
      }[]
      readonly buildPolicy: { readonly allowed: readonly string[]; readonly disabled: readonly string[] }
    }>('evidence/auto/e0/runtime-dependency-inventory.json')

    expect(inventory.status).toBe('passed')
    expect(inventory.packageCount).toBe(inventory.packages.length)
    expect(inventory.packageCount).toBeGreaterThan(2)
    expect(inventory.packages.every(item => item.license !== 'UNKNOWN' && item.lockfileCovered)).toBe(true)
    expect(inventory.licenseCounts['LGPL-3.0-or-later']).toBe(1)
    expect(inventory.packages.find(item => item.name === 'onnxruntime-node')?.installScripts)
      .toContain('postinstall:node ./script/install')
    expect(inventory.buildPolicy).toEqual({
      allowed: ['onnxruntime-node@1.24.3:postinstall'],
      disabled: ['sharp@0.34.5:install', 'protobufjs@7.6.6:postinstall'],
    })
  })
})
