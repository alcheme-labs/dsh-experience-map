import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const directory = await mkdtemp(fileURLToPath(new URL('../.corr-e5-', import.meta.url)))
const outfile = join(directory, 'evaluation.mjs')
const worker = join(directory, 'embedding-worker.js')
try {
  const shared = {
    bundle: true, format: 'esm', platform: 'node', target: ['node22'],
    external: ['@huggingface/transformers', 'minisearch'], logLevel: 'silent',
  }
  await Promise.all([
    build({ ...shared, entryPoints: [new URL('./corr-e5-evaluation.ts', import.meta.url).pathname], outfile }),
    build({
      ...shared,
      entryPoints: [new URL('../src/adapters/local-embedding-worker.ts', import.meta.url).pathname],
      outfile: worker,
    }),
  ])
  await import(`${pathToFileURL(outfile).href}?run=${String(Date.now())}`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
