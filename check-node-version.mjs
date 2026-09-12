import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/** Match package.json: Node 22.19+ within 22.x, or any Node 24+. */
export function supportedNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/u.exec(version)
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > 23 || (major === 22 && minor >= 19)
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (!supportedNodeVersion(process.versions.node)) {
    console.error(
      `@alcheme/dsh-experience-map requires Node 22.19+ (22.x) or Node 24+; `
      + `current Node is ${process.versions.node}. Node 23 can make the DSH CLI exit 0 without running.`,
    )
    process.exitCode = 1
  }
}
