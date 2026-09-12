import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  name: string
  bin?: unknown
  dsh?: { bundle?: { patch?: string }; client?: { platform?: string } }
  exports?: Record<string, unknown>
}

describe('independent Bundle manifest', () => {
  it('publishes one Bundle with Host, Client, and non-bin management exports', () => {
    expect(manifest.name).toBe('@alcheme/dsh-experience-map')
    expect(manifest.bin).toBeUndefined()
    expect(manifest.dsh).toMatchObject({ bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } })
    expect(manifest.exports).toHaveProperty('.')
    expect(manifest.exports).toHaveProperty('./client')
    expect(manifest.exports).not.toHaveProperty('./probe/transport')
    expect(manifest.exports).toHaveProperty('./cli/startup')
    expect(manifest.exports).toHaveProperty('./cli/runner')
  })

  it('keeps management CLI rows out of the default Bundle patch', () => {
    const patch = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain("name: '@alcheme/dsh-experience-map'")
    expect(patch).not.toContain('/probe/transport')
    expect(patch).not.toContain('/cli/startup')
    expect(patch).not.toContain('/cli/runner')
  })

  it('keeps the explicit management Profile overlay in the project', () => {
    const patch = readFileSync(new URL('./management.cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain("name: '@alcheme/dsh-experience-map/cli/startup'")
    expect(patch).toContain("name: '@alcheme/dsh-experience-map/cli/runner'")
  })
})
