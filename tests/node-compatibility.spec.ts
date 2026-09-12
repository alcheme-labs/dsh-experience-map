import { describe, expect, it } from 'vitest'
import { supportedNodeVersion } from '../check-node-version.mjs'

describe('packed plugin Node compatibility gate', () => {
  it('rejects unsupported odd Node 23 while accepting the declared LTS ranges', () => {
    expect(supportedNodeVersion('23.10.0')).toBe(false)
    expect(supportedNodeVersion('22.18.0')).toBe(false)
    expect(supportedNodeVersion('22.19.0')).toBe(true)
    expect(supportedNodeVersion('24.0.0')).toBe(true)
    expect(supportedNodeVersion('25.0.0')).toBe(true)
  })
})
