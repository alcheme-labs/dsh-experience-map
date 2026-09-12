import { rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const outfile = new URL(`../.auto-e0-benchmark-${String(process.pid)}.mjs`, import.meta.url)

try {
  await build({
    entryPoints: [new URL('./auto-e0-benchmark.ts', import.meta.url).pathname],
    outfile: outfile.pathname,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node22'],
    external: ['@huggingface/transformers', 'minisearch'],
    logLevel: 'silent',
  })
  await import(`${pathToFileURL(outfile.pathname).href}?run=${String(Date.now())}`)
} finally {
  await rm(outfile, { force: true })
}
