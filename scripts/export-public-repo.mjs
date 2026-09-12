import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')

const PUBLIC_ROOT_FILES = new Set([
  '.github',
  '.gitignore',
  '.gitleaks.toml',
  'CHANGELOG.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'NOTICE',
  'README.md',
  'README.zh.md',
  'SECURITY.md',
  'SUPPORT.md',
  'THIRD_PARTY_NOTICES.md',
  'build.mjs',
  'cordis.patch.yml',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'tsconfig.client.json',
  'tsconfig.host.json',
  'tsconfig.tests.json',
  'vitest.config.ts',
])

const PUBLIC_PREFIXES = [
  '.github/',
  'benchmarks/',
  'docs/decisions/',
  'docs/QUICKSTART.md',
  'docs/QUICKSTART.zh.md',
  'docs/media/',
  'docs/release/',
  'evidence/auto/e0/',
  'evidence/release/',
  'src/',
  'tests/',
]

const PUBLIC_SCRIPTS = new Set([
  'scripts/auto-e0-benchmark.ts',
  'scripts/auto-e0-packed-smoke.mjs',
  'scripts/auto-e0-runner.mjs',
  'scripts/auto-e0-supply-chain.mjs',
  'scripts/auto-e4-replay.ts',
  'scripts/auto-e4-runner.mjs',
  'scripts/corr-e2-evaluation.ts',
  'scripts/corr-e2-runner.mjs',
  'scripts/corr-e5-evaluation.ts',
  'scripts/corr-e5-runner.mjs',
  'scripts/export-public-repo.mjs',
  'scripts/export-public-repo.d.mts',
  'scripts/public-release-check.mjs',
])

const PUBLIC_SINGLE_FILES = new Set([
  'handoff/oracle-planning.ts',
])

const EXCLUDED_PUBLIC_TESTS = new Set([
  'tests/docs/status.spec.ts',
])

export async function exportPublicRepository(outputPath) {
  const target = resolve(outputPath)
  const targetWithinRoot = relative(root, target)
  if (target === root || (targetWithinRoot !== '..' && !targetWithinRoot.startsWith(`..${sep}`))) {
    throw new Error('Public export target must be outside the source repository')
  }
  try {
    await stat(target)
    throw new Error('Public export target already exists; choose a new empty path')
  } catch (error) {
    if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error
  }

  const candidates = trackedAndVisibleFiles()
  const selected = candidates.filter(isPublicPath).sort()
  if (selected.length === 0) throw new Error('Public export selected no files')
  await mkdir(target, { recursive: false })

  const files = []
  for (const path of selected) {
    const source = resolve(root, path)
    const destination = resolve(target, path)
    await assertSafePublicFile(path, source)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
    const body = await readFile(source)
    files.push({ path, bytes: body.byteLength, sha256: sha256(body) })
  }

  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const dirty = execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trim() !== ''
  await writeFile(resolve(target, 'PUBLIC_EXPORT_MANIFEST.json'), `${JSON.stringify({
    schemaVersion: 1,
    sourceCommit,
    sourceTreeDirty: dirty,
    fileCount: files.length,
    files,
  }, null, 2)}\n`)
  return { target, sourceCommit, dirty, files }
}

function trackedAndVisibleFiles() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0').filter(Boolean)
}

function isPublicPath(path) {
  if (EXCLUDED_PUBLIC_TESTS.has(path)) return false
  if (PUBLIC_ROOT_FILES.has(path) || PUBLIC_SINGLE_FILES.has(path) || PUBLIC_SCRIPTS.has(path)) return true
  return PUBLIC_PREFIXES.some(prefix => path.startsWith(prefix))
}

async function assertSafePublicFile(path, source) {
  const forbiddenBasename = /(^|\/)(?:\.credentials\.yaml|\.anonymous-user-id|session\.jsonl|\.DS_Store)$/u
  if (forbiddenBasename.test(path)) throw new Error(`Forbidden private artifact selected: ${path}`)
  if (!/\.(?:c?js|mjs|json|md|mts|ts|tsx|ya?ml)$/u.test(path)) return
  const body = await readFile(source, 'utf8')
  const forbidden = [
    { name: 'macOS user path', pattern: /\/Users\/[A-Za-z0-9._-]+\//u },
    { name: 'private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
    { name: 'credential assignment', pattern: /(?:API_KEY|ACCESS_TOKEN|PRIVATE_KEY)\s*[:=]\s*["'][A-Za-z0-9_+/.=-]{20,}["']/u },
  ]
  for (const rule of forbidden) {
    if (rule.pattern.test(body)) throw new Error(`${rule.name} found in public file: ${path}`)
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function main() {
  const output = process.argv.slice(2).find(argument => argument !== '--')
  if (output === undefined || output.trim() === '') {
    throw new Error('Usage: pnpm release:export -- /absolute/path/to/new-public-directory')
  }
  const result = await exportPublicRepository(isAbsolute(output) ? output : resolve(process.cwd(), output))
  process.stdout.write(`${JSON.stringify({
    target: result.target,
    sourceCommit: result.sourceCommit,
    sourceTreeDirty: result.dirty,
    fileCount: result.files.length,
  }, null, 2)}\n`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
