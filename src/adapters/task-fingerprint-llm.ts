import { createUserMessage, ReasoningEffortId, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { ExperienceError } from '../errors.js'
import type { PlanningTaskInput, TaskFingerprintView } from '../types.js'
import { LoggedStructuredGeneration, type StructuredResultTool } from './structured-generation.js'

/** Deployment policy for model-assisted fingerprint discovery. */
export interface TaskFingerprintProposalConfig {
  readonly taskFingerprintProposalMode: 'deterministic' | 'model'
  readonly taskFingerprintMaxTokens: number
}

type Proposal = Partial<Pick<TaskFingerprintView,
  'intent' | 'taskFamily' | 'entities' | 'expectedOutputs' | 'artifactKinds' | 'capabilities' | 'acceptanceCriteria'>>

/** Per-operation model route captured from live settings. */
export interface TaskFingerprintRoute {
  readonly provider: string
  readonly model: string
  readonly maxTokens: number
}

/** Optional bounded model proposer; the Host still owns hard facts and composition. */
export class TaskFingerprintLlm {
  private readonly generation: LoggedStructuredGeneration

  /** Bind the same public LLM and Session owners used by M2 structured generation. */
  constructor(
    llm: () => LlmRuntime | undefined,
    sessions: () => SessionStore | undefined,
    private readonly provider: string,
    private readonly model: string,
    private readonly maxTokens: number,
  ) {
    this.generation = new LoggedStructuredGeneration(llm, sessions)
  }

  /** Propose discovery-only fields from one explicit task. */
  async propose(task: PlanningTaskInput, signal?: AbortSignal, route?: TaskFingerprintRoute): Promise<Proposal> {
    const selected = route ?? { provider: this.provider, model: this.model, maxTokens: this.maxTokens }
    const result = await this.generation.generate({
      callConfig: {
        provider: selected.provider,
        model: selected.model,
        reasoningEffort: ReasoningEffortId('low'),
        maxTokens: selected.maxTokens,
      },
      expectedMaxTokens: selected.maxTokens,
      expectedReasoningEffort: ReasoningEffortId('low'),
      system: 'Extract discovery fields for Experience matching. Do not decide eligibility, approval, or execution.',
      message: createUserMessage({
        content: [{ type: 'text', text: JSON.stringify(task) }],
        source: { kind: 'plugin', plugin: 'dsh-experience-map', form: 'recall' },
      }),
      tool: taskFingerprintTool(),
      ...(signal === undefined ? {} : { signal }),
    })
    if (typeof result.value !== 'object' || result.value === null || Array.isArray(result.value)) {
      throw new ExperienceError('invalid_command', 'TaskFingerprint proposer returned an invalid result')
    }
    return result.value as Proposal
  }
}

function taskFingerprintTool(): StructuredResultTool {
  return {
    name: 'submit_task_fingerprint_proposal',
    description: 'Return discovery-only fields. Host-owned hard facts are intentionally absent.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['intent', 'taskFamily', 'entities', 'expectedOutputs', 'artifactKinds', 'capabilities', 'acceptanceCriteria'],
      properties: {
        intent: { type: 'string', minLength: 1, maxLength: 240 },
        taskFamily: { type: 'string', minLength: 1, maxLength: 120 },
        entities: stringArray(),
        expectedOutputs: stringArray(),
        artifactKinds: stringArray(),
        capabilities: stringArray(),
        acceptanceCriteria: stringArray(),
      },
    } as ObjectJsonSchema & Record<string, unknown>,
  }
}

function stringArray(): Record<string, unknown> {
  return { type: 'array', maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 240 } }
}
