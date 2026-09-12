import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { exportPublicRepository } from '../../scripts/export-public-repo.mjs'

const root = resolve(import.meta.dirname, '../..')
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('public release boundary', () => {
  it('keeps package ownership, support, and optional semantic runtime explicit', async () => {
    const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
      readonly author?: string
      readonly version?: string
      readonly repository?: { readonly url?: string }
      readonly optionalDependencies?: Readonly<Record<string, string>>
      readonly peerDependencies?: Readonly<Record<string, string>>
      readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>
      readonly files?: readonly string[]
      readonly keywords?: readonly string[]
    }
    expect(packageJson.author).toBe('杭州星原驱动科技有限公司')
    expect(packageJson.version).toBe('0.1.0-beta.3')
    expect(packageJson.repository?.url).toBe('git+https://github.com/alcheme-labs/dsh-experience-map.git')
    expect(packageJson.optionalDependencies?.['@huggingface/transformers']).toBeUndefined()
    expect(packageJson.peerDependencies?.['@huggingface/transformers']).toBe('4.2.0')
    expect(packageJson.peerDependenciesMeta?.['@huggingface/transformers']?.optional).toBe(true)
    expect(packageJson.keywords).toContain('dsh-plugin')
    expect(packageJson.files).toEqual(expect.arrayContaining([
      'CHANGELOG.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'NOTICE',
    ]))

    const workflow = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8')
    expect(workflow).not.toContain('gitleaks/gitleaks-action@')
    expect(workflow).toContain('gitleaks_8.30.1_linux_x64.tar.gz')
    expect(workflow).toContain('551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb')
    expect(workflow).toContain('gitleaks" git --redact --no-banner --config .gitleaks.toml')
    expect(workflow).not.toMatch(/uses:\s+[^\s]+@v[0-9]/u)
  })

  it('binds the public benefit wording to the de-identified paired measurements', async () => {
    const evidence = JSON.parse(
      await readFile(resolve(root, 'evidence/release/benefit-pilot.json'), 'utf8'),
    ) as {
      readonly runs: ReadonlyArray<{
        readonly id: string
        readonly providerTokenVolume: number
        readonly toolCalls: number
        readonly modelSteps: number
      }>
      readonly pairedChange: {
        readonly controlRun: string
        readonly treatmentRun: string
        readonly providerTokenVolumePercent: number
      }
      readonly nonClaims: readonly string[]
    }
    const control = evidence.runs.find(run => run.id === evidence.pairedChange.controlRun)
    const treatment = evidence.runs.find(run => run.id === evidence.pairedChange.treatmentRun)
    expect(control).toBeDefined()
    expect(treatment).toBeDefined()
    const percent = ((treatment!.providerTokenVolume - control!.providerTokenVolume)
      / control!.providerTokenVolume) * 100
    expect(percent).toBeCloseTo(evidence.pairedChange.providerTokenVolumePercent, 10)
    expect(control!.toolCalls).toBeGreaterThan(treatment!.toolCalls)
    expect(control!.modelSteps).toBeGreaterThan(treatment!.modelSteps)
    expect(evidence.nonClaims).toContain('not an average or guaranteed saving')

    const [readme, chinese, evidenceDocument] = await Promise.all([
      readFile(resolve(root, 'README.md'), 'utf8'),
      readFile(resolve(root, 'README.zh.md'), 'utf8'),
      readFile(resolve(root, 'docs/release/BENEFIT_EVIDENCE.md'), 'utf8'),
    ])
    expect(readme).toContain('65.9% lower provider token volume')
    expect(chinese).toContain('provider token volume 降低 65.9%')
    expect(evidenceDocument).toContain('not a promised saving rate')
    expect(evidenceDocument).toContain('不是节省比例承诺')
  })

  it('uses the published unscoped beta package in public installation guidance', async () => {
    const packageSpec = 'dsh-experience-map@0.1.0-beta.3'
    const documents = await Promise.all([
      'README.md',
      'README.zh.md',
      'docs/QUICKSTART.md',
      'docs/QUICKSTART.zh.md',
      'docs/release/COMMUNITY_POST.zh.md',
    ].map(path => readFile(resolve(root, path), 'utf8')))

    for (const document of documents) {
      expect(document).toContain(packageSpec)
      expect(document).not.toContain('<RELEASE_TARBALL_URL_OR_LOCAL_PATH>')
    }
  })

  it('exports a new clean tree without private history or internal evidence', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'experience-public-test-'))
    temporaryDirectories.push(temporaryRoot)
    const target = join(temporaryRoot, 'public')
    const result = await exportPublicRepository(target)
    const paths = result.files.map(file => file.path)

    expect(paths).toContain('src/index.ts')
    expect(paths).toContain('tests/docs/public-release.spec.ts')
    expect(paths).toContain('evidence/release/benefit-pilot.json')
    expect(paths).toContain('NOTICE')
    expect(paths).toContain('docs/QUICKSTART.md')
    expect(paths).toContain('docs/QUICKSTART.zh.md')
    expect(paths).toContain('docs/media/experience-map-overview.png')
    expect(paths.some(path => path.endsWith('.mp4'))).toBe(false)
    expect(paths).toContain('docs/release/COMMUNITY_POST.zh.md')
    expect(paths).not.toContain('tests/docs/status.spec.ts')
    expect(paths.some(path => path.startsWith('docs/external-agent-pilot/'))).toBe(false)
    expect(paths.some(path => path.startsWith('evidence/manual/'))).toBe(false)
    expect(paths.some(path => path.endsWith('session.jsonl'))).toBe(false)

    const manifest = JSON.parse(await readFile(join(target, 'PUBLIC_EXPORT_MANIFEST.json'), 'utf8')) as {
      readonly sourceCommit: string
      readonly fileCount: number
      readonly files: readonly unknown[]
    }
    expect(manifest.sourceCommit).toMatch(/^[a-f0-9]{40}$/u)
    expect(manifest.fileCount).toBe(paths.length)
    expect(manifest.files).toHaveLength(paths.length)
  })

  it('keeps generated client source identities repository-relative', async () => {
    const [client, sourceMap] = await Promise.all([
      readFile(resolve(root, 'lib/client.js'), 'utf8'),
      readFile(resolve(root, 'lib/client.js.map'), 'utf8'),
    ])
    expect(client).not.toMatch(/\/Users\/[A-Za-z0-9._-]+\//u)
    expect(sourceMap).not.toMatch(/\/Users\/[A-Za-z0-9._-]+\//u)
    expect(sourceMap).toContain('experience-css-module:src/client/workspace.module.css')
  })
})
