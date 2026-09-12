/** Match package.json: Node 22.19+ within 22.x, or any Node 24+. */
export function supportedNodeVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/u.exec(version)
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > 23 || (major === 22 && minor >= 19)
}

/** Fail when the installed plugin is actually loaded under an unsupported Node runtime. */
export function assertSupportedNodeVersion(version = process.versions.node): void {
  if (supportedNodeVersion(version)) return
  throw new Error(
    `dsh-experience-map requires Node 22.19+ (22.x) or Node 24+; current Node is ${version}. `
    + 'Node 23 can make the DSH CLI exit 0 without running.',
  )
}
