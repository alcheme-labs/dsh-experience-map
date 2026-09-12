import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, parse, resolve } from 'node:path'

const projectRoot = process.cwd()
const output = resolve(projectRoot, process.argv[2] ?? 'evidence/auto/e0/runtime-dependency-inventory.json')
const lockfile = await readFile(resolve(projectRoot, 'pnpm-lock.yaml'), 'utf8')
const roots = [
  { name: 'minisearch', placement: 'required' },
  { name: '@huggingface/transformers', placement: 'optional_peer_operator_supplied' },
]
const packages = new Map()

for (const root of roots) {
  await visit(resolve(projectRoot, 'node_modules', root.name), root.name, root.placement)
}

const inventory = [...packages.values()].sort((left, right) => left.name.localeCompare(right.name)
  || left.version.localeCompare(right.version))
const licenseCounts = Object.fromEntries([...new Set(inventory.map(item => item.license))].sort()
  .map(license => [license, inventory.filter(item => item.license === license).length]))
const result = {
  schemaVersion: 'experience-auto-e0-runtime-dependency-inventory-v2',
  status: inventory.every(item => item.lockfileCovered && item.license !== 'UNKNOWN') ? 'passed' : 'failed',
  statusScope: 'license and lockfile coverage; security disposition is reported separately',
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  roots,
  packageCount: inventory.length,
  licenseCounts,
  packages: inventory,
  buildPolicy: {
    allowed: ['onnxruntime-node@1.24.3:postinstall'],
    disabled: ['sharp@0.34.5:install', 'protobufjs@7.6.6:postinstall'],
  },
  securityDisposition: {
    defaultProductionInstall: 'audited separately and contains MiniSearch only',
    transformersJs: 'not automatically installed; upstream native dependency advisories remain open',
  },
  notes: [
    'MiniSearch is the default installed production subtree. The Transformers.js rows inventory an explicitly supplied optional peer runtime from the development environment.',
    'The LGPL libvips binary is a transitive platform package of sharp. Sharp belongs to the operator-supplied Transformers.js runtime, is not used by text embedding, and is not bundled into this plugin tarball.',
    'Model weights are separately revision/SHA pinned and are not npm dependencies.',
  ],
}
if (result.status !== 'passed') throw new Error('runtime dependency inventory contains an unknown license or unlocked package')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

async function visit(unresolvedPath, parent, placement) {
  let packageRoot
  try {
    packageRoot = await realpath(unresolvedPath)
    if (!(await stat(packageRoot)).isDirectory()) return
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const key = `${String(manifest.name)}@${String(manifest.version)}`
  const existing = packages.get(key)
  const installScripts = Object.entries(manifest.scripts ?? {})
    .filter(([name]) => ['preinstall', 'install', 'postinstall'].includes(name))
    .map(([name, command]) => `${name}:${String(command)}`)
  const record = existing ?? {
    name: String(manifest.name),
    version: String(manifest.version),
    license: String(manifest.license ?? 'UNKNOWN'),
    placement,
    parents: [],
    installScripts,
    lockfileCovered: lockfile.includes(`  '${key}':`) || lockfile.includes(`  ${key}:`),
  }
  if (!record.parents.includes(parent)) record.parents.push(parent)
  record.parents.sort()
  packages.set(key, record)
  if (existing !== undefined) return
  const children = { ...(manifest.dependencies ?? {}), ...(manifest.optionalDependencies ?? {}) }
  for (const name of Object.keys(children).sort()) {
    const child = await resolveDependencyRoot(packageRoot, name)
    if (child !== null) await visit(child, key, placement)
  }
}

async function resolveDependencyRoot(packageRoot, name) {
  let cursor = packageRoot
  const root = parse(cursor).root
  while (cursor !== root) {
    if (basename(cursor) === 'node_modules') {
      const candidate = join(cursor, name)
      try {
        return await realpath(candidate)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    cursor = dirname(cursor)
  }
  return null
}
