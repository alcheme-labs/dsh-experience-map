import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  currentTaskStage,
  DEFAULT_EXPERIENCE_MODE,
  TASK_STAGES,
  taskStageReachable,
  taskStageState,
} from '../../src/client/workspace-model.js'
import type { ViewState } from '../../src/client/store.js'

describe('Experience workspace product modes', () => {
  it('opens in task mode and exposes the implemented M2-M5 stages', () => {
    expect(DEFAULT_EXPERIENCE_MODE).toBe('task')
    expect(TASK_STAGES).toEqual([
      'match', 'preflight', 'plan', 'context', 'execution', 'verification', 'settlement', 'revision',
    ])
  })

  it('derives the current stage only from Host-authoritative readback', () => {
    expect(currentTaskStage(viewState())).toBe('match')
    expect(currentTaskStage(viewState({ selectedPlanning: planning(0, false) }))).toBe('preflight')
    expect(currentTaskStage(viewState({ selectedPlanning: planning(0, true) }))).toBe('plan')
    expect(currentTaskStage(viewState({ selectedPlanning: planning(1) }))).toBe('plan')
    expect(currentTaskStage(viewState({
      selectedPlanning: planning(1),
      selectedContext: { snapshot: { contextSnapshotId: 'snapshot-1' } } as unknown as NonNullable<ViewState['selectedContext']>,
    }))).toBe('context')
    expect(currentTaskStage(executionState('running'))).toBe('execution')
    expect(currentTaskStage(executionState('completed'))).toBe('verification')
    expect(currentTaskStage(executionState('aborted'))).toBe('verification')
    expect(currentTaskStage(verifiedState('pre_cleanup'))).toBe('verification')
    expect(currentTaskStage(verifiedState('unknown'))).toBe('verification')
    expect(currentTaskStage(verifiedState('complete'))).toBe('settlement')
  })

  it('allows completed and current stages without allowing a future-stage skip', () => {
    expect(taskStageReachable('match', 'plan')).toBe(true)
    expect(taskStageReachable('plan', 'plan')).toBe(true)
    expect(taskStageReachable('context', 'plan')).toBe(false)
    expect(TASK_STAGES.map(stage => taskStageState(stage, 'plan'))).toEqual([
      'done',
      'done',
      'current',
      'blocked',
      'blocked',
      'blocked',
      'blocked',
      'blocked',
    ])
  })
})

describe('Experience workspace design-system constraints', () => {
  it('keeps semantic colors in DeepSeek Web aliases', () => {
    const stylesheet = readFileSync(new URL('../../src/client/workspace.module.css', import.meta.url), 'utf8')
    expect(stylesheet).not.toMatch(/#[\da-f]{3,8}\b|\brgba?\(|\bhsla?\(/i)
    expect(stylesheet).toContain('var(--dsw-alias-')
  })

  it('declares the public DeepSeek primitive package as a peer dependency', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      readonly peerDependencies?: Readonly<Record<string, string>>
    }
    expect(manifest.peerDependencies?.['@deepseek-ai/dsh-client-ui-primitives']).toBeTruthy()
  })

  it('keeps M5 identifiers, source refs, and reason codes in the inspector', () => {
    const source = readFileSync(new URL('../../src/client/workspace.tsx', import.meta.url), 'utf8')
    const execution = functionSource(source, 'function ExecutionProgressPanel', 'function VerificationPanel')
    const verification = functionSource(source, 'function VerificationPanel', 'function SettlementPanel')
    const settlement = functionSource(source, 'function SettlementPanel', 'function RevisionPanel')
    const revision = functionSource(source, 'function RevisionPanel', 'function discardReasonLabel')
    const inspector = functionSource(source, 'function ExecutionInspectorTechnical', 'function RevisionInspectorTechnical')

    expect(execution).not.toContain('item.callId')
    expect(verification).not.toContain('item.reasonCode')
    expect(verification).not.toContain('item.sourceRef')
    expect(settlement).not.toContain('settlement.settlementId')
    expect(revision).not.toContain('proposal.publishedVersionId')
    expect(inspector).toContain('item.callId')
    expect(inspector).toContain('item.reasonCode')
    expect(inspector).toContain('item.sourceRef')
    expect(inspector).toContain('settlement?.settlementId')
  })
})

function functionSource(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  if (startIndex < 0 || endIndex < 0) throw new Error(`missing source range: ${start} -> ${end}`)
  return source.slice(startIndex, endIndex)
}

function viewState(overrides: Partial<ViewState> = {}): ViewState {
  return {
    phase: 'ready',
    candidates: [],
    planningResults: [],
    proposalStatus: 'idle',
    running: false,
    ...overrides,
  }
}

function planning(preflightCount: number, noMatch = false): NonNullable<ViewState['selectedPlanning']> {
  return {
    preflights: Array.from({ length: preflightCount }, () => ({})),
    matchSet: { noMatch },
  } as unknown as NonNullable<ViewState['selectedPlanning']>
}

function executionState(state: 'running' | 'completed' | 'aborted'): ViewState {
  return viewState({
    selectedPlanning: planning(1),
    selectedContext: { snapshot: { contextSnapshotId: 'snapshot-1' } } as unknown as NonNullable<ViewState['selectedContext']>,
    selectedExecution: {
      progress: { state },
      verification: null,
    } as unknown as NonNullable<ViewState['selectedExecution']>,
  })
}

function verifiedState(phase: 'pre_cleanup' | 'complete' | 'unknown'): ViewState {
  return viewState({
    selectedPlanning: planning(1),
    selectedContext: { snapshot: { contextSnapshotId: 'snapshot-1' } } as unknown as NonNullable<ViewState['selectedContext']>,
    selectedExecution: {
      progress: { state: 'completed' },
      verification: { phase },
      settlement: null,
    } as unknown as NonNullable<ViewState['selectedExecution']>,
  })
}
