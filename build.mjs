import { build } from 'esbuild'
import { readFile, rm } from 'node:fs/promises'
import { basename, relative, resolve, sep } from 'node:path'
import { transform } from 'lightningcss'

const packageId = 'dsh-experience-map'
const dshExternals = ['@deepseek-ai/*', '@huggingface/transformers']

const cssModules = {
  name: 'experience-css-modules',
  setup(builder) {
    builder.onResolve({ filter: /\.module\.css$/ }, args => {
      const sourcePath = resolve(args.resolveDir, args.path)
      return {
        path: relative(process.cwd(), sourcePath).split(sep).join('/'),
        namespace: 'experience-css-module',
        pluginData: { sourcePath },
      }
    })
    builder.onLoad({ filter: /.*/, namespace: 'experience-css-module' }, async args => {
      const sourcePath = args.pluginData.sourcePath
      const source = await readFile(sourcePath)
      const result = transform({
        filename: args.path,
        code: source,
        cssModules: { pattern: 'experience_[hash]_[local]' },
        minify: true,
      })
      const classes = Object.fromEntries(Object.entries(result.exports ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => [name, value.name]))
      const tagId = `${packageId}/${basename(sourcePath)}`
      const css = result.code.toString()
      return {
        loader: 'js',
        watchFiles: [sourcePath],
        contents: [
          `const css = ${JSON.stringify(css)};`,
          `const tagId = ${JSON.stringify(tagId)};`,
          'if (typeof document !== "undefined") {',
          '  let tag = document.querySelector(`style[data-plugin-css="${tagId}"]`);',
          '  if (tag === null) {',
          '    tag = document.createElement("style");',
          '    tag.dataset.plugin = ' + JSON.stringify(packageId) + ';',
          '    tag.dataset.pluginCss = tagId;',
          '    document.head.appendChild(tag);',
          '  }',
          '  tag.textContent = css;',
          '}',
          `export default ${JSON.stringify(classes)};`,
        ].join('\n'),
      }
    })
  },
}

await rm('lib', { recursive: true, force: true })

await build({
  entryPoints: {
    index: 'src/index.ts',
    'embedding-worker': 'src/adapters/local-embedding-worker.ts',
    'cli/startup': 'src/cli/startup.ts',
    'cli/runner': 'src/cli/runner.ts',
  },
  outdir: 'lib',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
  external: dshExternals,
  logLevel: 'info',
})

await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: true,
  jsx: 'automatic',
  external: [
    ...dshExternals,
    'react',
    'react-dom',
    'react-dom/client',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    'scheduler',
  ],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageId)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
  plugins: [cssModules],
  logLevel: 'info',
})

const clientBundle = await readFile('lib/client.js', 'utf8')
if (/require\((['"])@deepseek-ai\/schemastery\1\)/.test(clientBundle)) {
  throw new Error('Client bundle must use the injected settings schema service, not import Schemastery')
}
