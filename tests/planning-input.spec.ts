import { describe, expect, it } from 'vitest'
import { parsePlanTaskCommandInput } from '../src/application/input.js'

describe('M3 planning command input', () => {
  it('accepts an exact command with an absolute workspace root', () => {
    expect(parsePlanTaskCommandInput(command())).toMatchObject({
      interaction: 'defer',
      confirmExternalModelProcessing: false,
      task: { workspaceRoot: '/workspace/deepseek-harness' },
    })
  })

  it('rejects relative workspace roots and unknown command fields', () => {
    expect(() => parsePlanTaskCommandInput(command({
      task: { ...task(), workspaceRoot: 'relative/path' },
    }))).toThrow('workspaceRoot must be an absolute path or null')
    expect(() => parsePlanTaskCommandInput({ ...command(), extra: true }))
      .toThrow('Plan task command contains unrecognized fields')
  })

  it('requires an explicit model-processing confirmation value', () => {
    const { confirmExternalModelProcessing: _omitted, ...missing } = command()
    expect(() => parsePlanTaskCommandInput(missing))
      .toThrow('Plan task command is missing required fields')
  })
})

function command(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commandId: 'command-1',
    correlationId: 'correlation-1',
    causationId: null,
    issuedAt: '2026-09-02T02:00:00.000Z',
    sessionId: null,
    interaction: 'defer',
    confirmExternalModelProcessing: false,
    task: task(),
    ...overrides,
  }
}

function task(): Record<string, unknown> {
  return {
    text: 'Build and start the local Harness Web application',
    workspaceRoot: '/workspace/deepseek-harness',
    targetExposure: 'local',
    mustUseExperience: false,
    riskClass: 'medium',
    requiredCapabilities: ['build', 'web'],
    requestedUseMode: 'guided',
    overrideDecisionIds: [],
  }
}
