import { describe, expect, it } from 'vitest'
import { assertSupportedNodeVersion, supportedNodeVersion } from '../src/node-compatibility.js'

describe('packed plugin Node compatibility gate', () => {
  it('rejects unsupported odd Node 23 while accepting the declared LTS ranges', () => {
    expect(supportedNodeVersion('23.10.0')).toBe(false)
    expect(supportedNodeVersion('22.18.0')).toBe(false)
    expect(supportedNodeVersion('22.19.0')).toBe(true)
    expect(supportedNodeVersion('24.0.0')).toBe(true)
    expect(supportedNodeVersion('25.0.0')).toBe(true)
  })

  it('fails at plugin load instead of requiring an install lifecycle script', () => {
    expect(() => assertSupportedNodeVersion('23.10.0')).toThrow('Node 23 can make the DSH CLI exit 0 without running')
    expect(() => assertSupportedNodeVersion('22.19.0')).not.toThrow()
  })
})
