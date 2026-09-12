import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { exportPublicRepository } from './export-public-repo.mjs'

const root = resolve(import.meta.dirname, '..')
const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-experience-release-check-'))
const publicRoot = join(temporaryRoot, 'public')

try {
  const exported = await exportPublicRepository(publicRoot)
  const packageJson = JSON.parse(await readFile(resolve(publicRoot, 'package.json'), 'utf8'))
  if (packageJson.optionalDependencies?.['@huggingface/transformers'] !== undefined) {
    throw new Error('Transformers.js must not be installed automatically while its upstream native dependency advisories remain open')
  }
  if (packageJson.peerDependenciesMeta?.['@huggingface/transformers']?.optional !== true) {
    throw new Error('Transformers.js must remain an explicit optional peer runtime')
  }

  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: join(temporaryRoot, 'npm-cache') },
  }))
  const packageFiles = packed[0]?.files?.map(file => file.path) ?? []
  const forbidden = packageFiles.filter(path => /^(?:src|tests|evidence|docs|handoff|\.github)\//u.test(path)
    || /(?:session\.jsonl|\.credentials\.yaml|\.anonymous-user-id)$/u.test(path))
  if (forbidden.length > 0) throw new Error(`Private or source-only files would enter npm package: ${forbidden.join(', ')}`)
  for (const path of ['lib/client.js', 'lib/client.js.map']) {
    const body = await readFile(resolve(root, path), 'utf8')
    if (/\/Users\/[A-Za-z0-9._-]+\//u.test(body)) {
      throw new Error(`Absolute macOS user path would enter npm package: ${path}`)
    }
  }

  process.stdout.write(`${JSON.stringify({
    status: 'passed',
    publicFileCount: exported.files.length,
    npmFileCount: packageFiles.length,
    npmPackedBytes: packed[0]?.size ?? null,
    npmUnpackedBytes: packed[0]?.unpackedSize ?? null,
  }, null, 2)}\n`)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
