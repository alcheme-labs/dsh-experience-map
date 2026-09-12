import { describe, expect, it } from 'vitest'
import { presentDisclosureRecord } from '../../src/client/disclosure-preview.js'
import type { BoundedSourceRecord } from '../../src/types.js'
import { sourceRef } from '../fixtures/workflow.js'

describe('M2 disclosure record presentation', () => {
  it('shows user and assistant content without exposing event metadata as the primary view', () => {
    expect(presentDisclosureRecord(record('user/message', {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'Diagnose the startup failure' }] },
      sourceEventSeqs: [1, 2, 3],
    })).sections).toEqual([{ kind: 'content', text: 'Diagnose the startup failure' }])

    expect(presentDisclosureRecord(record('assistant/message', {
      type: 'assistant/message',
      data: { message: { content: [
        { type: 'reasoning', text: 'Check the authoritative log.' },
        { type: 'text', text: 'The build artifact is absent.' },
        { type: 'tool-call', name: 'bash', arguments: '{"command":"pnpm build"}' },
      ] } },
    })).sections).toEqual([
      { kind: 'reasoning', text: 'Check the authoritative log.' },
      { kind: 'response', text: 'The build artifact is absent.' },
      { kind: 'tool', text: 'bash' },
      { kind: 'input', text: '{\n  "command": "pnpm build"\n}' },
    ])
  })

  it('shows nested tool output and lifecycle records in readable sections', () => {
    expect(presentDisclosureRecord(record('tool/result', {
      type: 'tool/result',
      data: { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'build passed' }] }] } },
    })).sections).toEqual([{ kind: 'output', text: 'build passed' }])
    expect(presentDisclosureRecord(record('step/start', {
      type: 'step/start', data: { turn: 2, step: 4 },
    })).sections).toEqual([{ kind: 'step_start', text: 'turn 2 · step 4' }])
  })

  it('fails open to the exact bounded excerpt when a record is truncated or unknown', () => {
    const excerpt = '{"type":"assistant/message","data":…'
    const presentation = presentDisclosureRecord({ ...record('assistant/message', excerpt), excerpt })
    expect(presentation.sections).toEqual([{ kind: 'record', text: excerpt }])
    expect(presentation.rawExcerpt).toBe(excerpt)
  })
})

function record(eventType: string, value: unknown): BoundedSourceRecord {
  const excerpt = typeof value === 'string' ? value : JSON.stringify(value)
  return { sourceRef, eventType, excerpt }
}
