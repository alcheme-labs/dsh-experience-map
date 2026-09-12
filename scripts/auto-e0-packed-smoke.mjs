import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const projectRoot = process.cwd()
const tarball = resolve(projectRoot, process.argv[2] ?? '')
const output = resolve(projectRoot, process.argv[3] ?? 'evidence/auto/e0/packed-smoke.json')
if (process.argv[2] === undefined) throw new Error('usage: auto-e0-packed-smoke.mjs <tarball> [output]')

const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean).sort()
const forbidden = entries.filter(entry => /(^|\/)(benchmarks|evidence|scripts|src|tests|models)(\/|$)/.test(entry)
  || /\.(onnx|bin|safetensors)$/.test(entry))
if (forbidden.length > 0) throw new Error(`packed artifact contains forbidden development/model files: ${forbidden.join(', ')}`)

const unpackRoot = await mkdtemp(join(tmpdir(), 'dsh-auto-e0-packed-smoke-'))
try {
  execFileSync('tar', ['-xzf', tarball, '-C', unpackRoot])
  const packageRoot = join(unpackRoot, 'package')
  await symlink(resolve(projectRoot, 'node_modules'), join(packageRoot, 'node_modules'), 'dir')
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const loaded = await Promise.all([
    import(pathToFileURL(join(packageRoot, 'lib/index.js')).href),
    import(pathToFileURL(join(packageRoot, 'lib/cli/startup.js')).href),
    import(pathToFileURL(join(packageRoot, 'lib/cli/runner.js')).href),
  ])
  const tarballBytes = await readFile(tarball)
  const result = {
    schemaVersion: 'experience-auto-e0-packed-smoke-v2',
    status: 'passed',
    node: process.version,
    package: `${String(manifest.name)}@${String(manifest.version)}`,
    tarballSha256: `sha256:${createHash('sha256').update(tarballBytes).digest('hex')}`,
    tarballBytes: tarballBytes.byteLength,
    entryCount: entries.length,
    loadedExports: {
      host: Object.keys(loaded[0]).sort(),
      cliStartup: Object.keys(loaded[1]).sort(),
      cliRunner: Object.keys(loaded[2]).sort(),
    },
    runtimeDependencies: manifest.dependencies,
    optionalRuntimeDependencies: manifest.optionalDependencies ?? {},
    optionalPeerRuntimeDependencies: Object.fromEntries(Object.entries(manifest.peerDependencies ?? {})
      .filter(([name]) => manifest.peerDependenciesMeta?.[name]?.optional === true)),
    forbiddenEntries: forbidden,
    modelArtifactsBundled: false,
  }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} finally {
  await rm(unpackRoot, { recursive: true, force: true })
}
