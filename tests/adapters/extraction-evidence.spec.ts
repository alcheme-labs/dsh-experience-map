import { describe, expect, it } from 'vitest'
import { buildExtractionEvidencePacket } from '../../src/adapters/extraction-evidence.js'
import { brandedId } from '../../src/ids.js'
import type { BoundedSourceRecord, SourceRefView } from '../../src/types.js'
import { episodeRef } from '../fixtures/workflow.js'

const limits = {
  maxEvidenceItems: 8,
  maxEvidenceItemBytes: 1_024,
  maxEvidencePacketBytes: 16_384,
}

describe('M2 extraction evidence packet', () => {
  it('removes assistant reasoning and labels visible assistant text as a model claim', () => {
    const packet = buildExtractionEvidencePacket([episodeRef], [record(1, 'assistant/message', {
      type: 'assistant/message',
      data: { message: { content: [
        { type: 'reasoning', text: 'private chain of thought' },
        { type: 'text', text: 'The frontend artifact may be missing.' },
      ] } },
    })], limits)
    expect(packet.items).toHaveLength(1)
    expect(packet.items[0]).toMatchObject({
      evidenceRole: 'model_claim',
      evidenceClass: 'model_claim',
      content: 'The frontend artifact may be missing.',
    })
    expect(JSON.stringify(packet)).not.toContain('private chain of thought')
    expect(packet.omissions).toContainEqual(expect.objectContaining({ reason: 'assistant_reasoning_removed' }))
  })

  it('keeps current source inspection and shell observations needed by the diagnostic', () => {
    const packet = buildExtractionEvidencePacket([episodeRef], [
      record(1, 'assistant/message', {
        type: 'assistant/message',
        data: { turn: 1, message: { content: [{ type: 'text', text: 'I will inspect the repository first.' }] } },
      }),
      record(2, 'tool/call', {
        type: 'tool/call', data: { turn: 1, callId: 'read-1', name: 'read', arguments: '{}' },
      }),
      record(3, 'tool/result', {
        type: 'tool/result',
        data: { turn: 1, message: { source: { callId: 'read-1' }, content: [{ type: 'text', text: 'package.json body' }] } },
      }),
      record(4, 'tool/call', {
        type: 'tool/call', data: { turn: 1, callId: 'shell-1', name: 'bash', arguments: '{"command":"pnpm build"}' },
      }),
      record(5, 'tool/result', {
        type: 'tool/result',
        data: { turn: 1, message: { source: { callId: 'shell-1' }, content: [{ type: 'text', text: 'Error: frontend dist missing' }] } },
      }),
      record(6, 'assistant/message', {
        type: 'assistant/message',
        data: { turn: 1, message: { content: [{ type: 'text', text: 'The missing dist artifact is the remaining hypothesis.' }] } },
      }),
      record(7, 'turn/end', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
    ], limits)

    expect(packet.items.map(item => item.content)).toEqual([
      expect.stringMatching(/^read[\s\S]*package\.json body$/u),
      expect.stringMatching(/^bash[\s\S]*pnpm build[\s\S]*Error: frontend dist missing$/u),
      'The missing dist artifact is the remaining hypothesis.',
      expect.stringContaining('completed'),
    ])
    expect(packet.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceRefId: source(1).sourceRefId, reason: 'intermediate_model_commentary' }),
      expect.objectContaining({ sourceRefId: source(2).sourceRefId, reason: 'merged_into_tool_result' }),
      expect.objectContaining({ sourceRefId: source(4).sourceRefId, reason: 'merged_into_tool_result' }),
    ]))
    expect(packet.sentSourceRecordCount).toBe(4)
    expect(packet.fullyOmittedSourceRecordCount).toBe(3)
    expect(packet.removedBlockCount).toBe(0)
  })

  it('keeps Host acceptance criteria and current inspection ahead of historical evidence', () => {
    const packet = buildExtractionEvidencePacket([episodeRef], [
      record(1, 'historical_record', { text: 'An old launch was discussed.' }),
      record(2, 'tool/call', {
        type: 'tool/call', data: { callId: 'read-1', name: 'read', arguments: '{"path":"package.json"}' },
      }),
      record(3, 'tool/result', {
        type: 'tool/result',
        data: { message: { source: { callId: 'read-1' }, content: [{ type: 'text', text: 'current package.json' }] } },
      }),
      record(4, 'acceptance_criterion', {
        policyVersion: 'm0-web-acceptance-v1', criterionId: 'WEB-LAUNCH-001', mandatory: true, result: 'pass',
      }),
    ], { ...limits, maxEvidenceItems: 2 })

    expect(packet.items.map(item => item.evidenceRole)).toEqual([
      'tool_observation', 'acceptance_criterion',
    ])
    expect(packet.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceRefId: source(1).sourceRefId, reason: 'item_limit' }),
      expect.objectContaining({ sourceRefId: source(2).sourceRefId, reason: 'merged_into_tool_result' }),
    ]))
  })

  it('does not treat error words inside inspected source code as a runtime symptom', () => {
    const packet = buildExtractionEvidencePacket([episodeRef], [
      record(1, 'tool/call', {
        type: 'tool/call', data: { callId: 'read-1', name: 'read', arguments: '{"path":"startup.ts"}' },
      }),
      record(2, 'tool/result', {
        type: 'tool/result',
        data: {
          message: {
            source: { callId: 'read-1' },
            content: [{ type: 'text', text: "throw new Error('frontend artifact missing')" }],
          },
        },
      }),
    ], limits)

    expect(packet.items[0]).toMatchObject({
      evidenceRole: 'tool_observation',
      content: expect.stringMatching(/^read[\s\S]*frontend artifact missing/u),
    })
  })

  it('retains historical failures and readbacks ahead of ordinary historical narration and current action inputs', () => {
    const packet = buildExtractionEvidencePacket([episodeRef], [
      record(1, 'historical_record', { text: 'Start the project.' }),
      record(2, 'tool/call', {
        type: 'tool/call', data: { callId: 'read-1', name: 'read', arguments: '{"path":"startup.ts"}' },
      }),
      record(3, 'tool/result', {
        type: 'tool/result',
        data: { message: { source: { callId: 'read-1' }, content: [{ type: 'text', text: 'current source body' }] } },
      }),
      record(4, 'historical_record', { text: 'ERROR Failed to switch pnpm: ENOENT.' }),
      record(5, 'historical_record', { text: 'Plugin tree failed: Cannot find module frontend dependency.' }),
      record(6, 'historical_record', { text: 'dsh web: http://127.0.0.1:3080' }),
    ], { ...limits, maxEvidenceItems: 3 })

    expect(packet.items.map(item => item.content)).toEqual([
      expect.stringMatching(/^read[\s\S]*current source body$/u),
      'Plugin tree failed: Cannot find module frontend dependency.',
      'dsh web: http://127.0.0.1:3080',
    ])
    expect(packet.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceRefId: source(1).sourceRefId, reason: 'item_limit' }),
      expect.objectContaining({ sourceRefId: source(2).sourceRefId, reason: 'merged_into_tool_result' }),
      expect.objectContaining({ sourceRefId: source(4).sourceRefId, reason: 'item_limit' }),
    ]))
  })

  it('keeps goals, errors, readbacks, and terminal outcome ahead of low-priority actions', () => {
    const records = [
      record(1, 'tool/call', { type: 'tool/call', data: { name: 'bash', arguments: '{"command":"pnpm build"}' } }),
      record(2, 'user/message', { type: 'user/message', data: { content: [{ type: 'text', text: 'Diagnose Web startup.' }] } }),
      record(3, 'tool/result', { type: 'tool/result', data: { output: 'Error: frontend dist missing', isError: true } }),
      record(4, 'tool/result', { type: 'tool/result', data: { output: 'HTTP/1.1 200 verified' } }),
      record(5, 'turn/end', { type: 'turn/end', data: { reason: { kind: 'completed' } } }),
    ]
    const packet = buildExtractionEvidencePacket([episodeRef], records, { ...limits, maxEvidenceItems: 4 })
    expect(packet.items.map(item => item.evidenceRole)).toEqual([
      'user_goal', 'symptom', 'terminal_readback', 'terminal_outcome',
    ])
    expect(packet.omissions).toContainEqual(expect.objectContaining({
      sourceRefId: source(1).sourceRefId,
      reason: 'item_limit',
    }))
  })

  it('is stable across rereads and enforces UTF-8 item and packet byte limits', () => {
    const first = record(1, 'user/message', {
      type: 'user/message', data: { content: [{ type: 'text', text: '诊断'.repeat(2_000) }] },
    })
    const reread = { ...first, sourceRef: { ...first.sourceRef, observedAt: '2026-09-01T12:00:00.000Z' } }
    const config = { ...limits, maxEvidenceItemBytes: 257, maxEvidencePacketBytes: 4_096 }
    const left = buildExtractionEvidencePacket([episodeRef], [first], config)
    const right = buildExtractionEvidencePacket([episodeRef], [reread], config)
    expect(left.packetDigest).toBe(right.packetDigest)
    expect(left.packetBytes).toBeLessThanOrEqual(config.maxEvidencePacketBytes)
    expect(Buffer.byteLength(left.items[0]!.content)).toBeLessThanOrEqual(config.maxEvidenceItemBytes)
    expect(left.items[0]?.projectionTruncated).toBe(true)
  })
})

function record(sequence: number, eventType: string, value: unknown): BoundedSourceRecord {
  return { sourceRef: source(sequence), eventType, excerpt: JSON.stringify(value) }
}

function source(sequence: number): SourceRefView {
  return {
    sourceRefId: brandedId<'ExperienceSourceRefId'>(`source:test-${String(sequence)}`, 'sourceRefId'),
    sourceSystem: 'dsh-session',
    sourceKind: 'session_event',
    locator: `dsh-session:session-test#${String(sequence)}`,
    ownerScope: 'session:session-test',
    accessScope: 'local_owner',
    occurredAt: '2026-09-01T08:00:00.000Z',
    observedAt: '2026-09-01T09:00:00.000Z',
    contentDigest: `sha256:source-${String(sequence)}`,
    redactionState: 'bounded_excerpt',
  }
}
