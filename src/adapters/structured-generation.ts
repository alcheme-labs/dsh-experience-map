import { randomUUID } from 'node:crypto'
import {
  AssistantStreamAccumulator,
  BlockAssembler,
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  type GenerateOptions,
  type LlmCallConfig,
  type LlmRuntime,
  type ReasoningEffortId,
  type TokenUsage,
  type ToolCallBlock,
  type ToolSchema,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import {
  canonicalHeader,
  SessionId,
  type Session,
  type SessionSeq,
  type SessionStore,
} from '@deepseek-ai/dsh-session'
import {
  assertObjectJsonSchema,
  validateJsonSchemaValue,
  type ObjectJsonSchema,
} from '@deepseek-ai/dsh-tools'
import { assertSafeText } from '../application/content-policy.js'
import { ExperienceError } from '../errors.js'

/** One schema tool used as the sole successful result channel. */
export interface StructuredResultTool extends Omit<ToolSchema, 'parameters'> {
  readonly parameters: ObjectJsonSchema & Record<string, unknown>
}

/** Inputs to one logged provider-neutral structured generation call. */
export interface LoggedStructuredGenerationRequest {
  readonly callConfig: LlmCallConfig
  readonly expectedMaxTokens: number | null
  readonly expectedReasoningEffort: ReasoningEffortId
  readonly system: string
  readonly message: UserMessage
  readonly tool: StructuredResultTool
  readonly signal?: AbortSignal
}

/** Schema-valid value and durable request/response identity. */
export interface LoggedStructuredGenerationResult {
  readonly value: unknown
  readonly rawArguments: string
  readonly proposalSessionId: SessionId
  readonly usage?: TokenUsage
}

/** Owns one-shot LLM streaming, tool-result validation, and durable Session logging. */
export class LoggedStructuredGeneration {
  /** Bind public Harness LLM and Session owners without registering another Service. */
  constructor(
    private readonly llm: () => LlmRuntime | undefined,
    private readonly sessions: () => SessionStore | undefined,
  ) {}

  /** Generate exactly one schema-valid tool value and persist the complete call. */
  async generate(request: LoggedStructuredGenerationRequest): Promise<LoggedStructuredGenerationResult> {
    assertObjectJsonSchema(request.tool.parameters)
    const llm = this.llm()
    if (llm === undefined) {
      throw new ExperienceError('internal', 'Structured generation requires an LLM service in this Profile')
    }
    const sessions = this.sessions()
    if (sessions === undefined) {
      throw new ExperienceError('internal', 'Structured generation requires the Harness Session service')
    }
    const session = sessions.prepare(SessionId(`experience-proposal-${randomUUID()}`))
    const detach = sessions.enter(session)
    let stepStarted = false
    let stepEnded = false
    let turnStarted = false
    let turnEnded = false
    try {
      sessions.announce(session)
      let result: Omit<LoggedStructuredGenerationResult, 'proposalSessionId'>
      try {
        session.append('turn/start', { turn: 1 })
        turnStarted = true
        session.append('step/start', { turn: 1, step: 1 })
        stepStarted = true
        const prepared = await llm.prepareCall(request.callConfig, request.signal)
        if ((prepared.config.maxTokens ?? null) !== request.expectedMaxTokens
          || prepared.config.reasoningEffort !== request.expectedReasoningEffort) {
          throw new ExperienceError(
            'source_unresolvable',
            'structured generation settings changed after disclosure; inspect and confirm again',
          )
        }
        const header = canonicalHeader({
          config: prepared.config,
          adapterDefaults: prepared.adapterDefaults,
          tools: [request.tool],
        })
        session.append('system/message', {
          turn: 1,
          step: 1,
          message: createSystemMessage(request.system, 'dsh-experience-map'),
        }, { surfaceOp: 'append' })
        session.append('user/message', request.message, { surfaceOp: 'append' })
        session.append('request/header', { header, reason: 'initial' })
        session.append('request/context', {
          provider: prepared.config.provider,
          model: prepared.config.model,
          ...(prepared.context?.contextWindow === undefined
            ? {} : { contextWindow: prepared.context.contextWindow }),
        })
        const options: GenerateOptions = {
          ...prepared.config,
          messages: [request.message],
          system: request.system,
          tools: [request.tool],
          sessionId: session.id,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        }
        result = await collectStructuredResult(
          prepared.stream(options),
          session,
          request.tool,
          request.expectedMaxTokens,
          prepared.config.provider,
          prepared.config.model,
        )
        session.append('step/end', { turn: 1, step: 1 })
        stepEnded = true
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        turnEnded = true
      } catch (error) {
        if (stepStarted && !stepEnded) session.append('step/end', { turn: 1, step: 1 })
        if (turnStarted && !turnEnded) session.append('turn/end', { turn: 1, reason: generationFailure(error) })
        await requireDurableSession(sessions, session, error)
        throw error
      }
      await requireDurableSession(sessions, session)
      return { ...result, proposalSessionId: session.id }
    } finally {
      detach()
    }
  }
}

async function collectStructuredResult(
  stream: AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk>,
  session: Session,
  tool: StructuredResultTool,
  maxOutputTokens: number | null,
  provider: string,
  model: string,
): Promise<Omit<LoggedStructuredGenerationResult, 'proposalSessionId'>> {
  const assembler = new BlockAssembler()
  const recordedStream = new AssistantStreamAccumulator()
  for await (const chunk of stream) {
    recordedStream.push({ time: Date.now(), chunk })
    assembler.push(chunk)
  }
  const message = createAssistantMessage({
    content: assembler.blocks(),
    source: {
      provider,
      model,
      ...(assembler.replayState === undefined ? {} : { replayState: assembler.replayState }),
    },
  })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message,
    stream: [...recordedStream.snapshot()],
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }, { surfaceOp: 'append' })
  const finishError = structuredFinishError(assembler.finish, assembler.usage, maxOutputTokens)
  if (finishError !== undefined) throw finishError

  const unsupported = message.content.filter(block => block.type !== 'reasoning'
    && block.type !== 'text' && block.type !== 'tool-call')
  const visibleText = message.content
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('')
    .trim()
  const calls = message.content.filter((block): block is ToolCallBlock => block.type === 'tool-call')
  if (unsupported.length > 0 || visibleText !== '' || calls.length !== 1 || calls[0]?.name !== tool.name) {
    for (const call of calls) {
      const callSeq = appendStructuredToolCall(session, call)
      appendStructuredToolResult(session, call, callSeq, true)
    }
    throw new ExperienceError('invalid_command', 'Structured generator did not return exactly one expected result tool call', {
      expectedTool: tool.name,
      returnedTools: calls.map(call => call.name),
      visibleText: visibleText !== '',
      unsupportedBlockTypes: [...new Set(unsupported.map(block => block.type))],
    })
  }

  const call = calls[0]
  const callSeq = appendStructuredToolCall(session, call)
  try {
    assertSafeText(call.arguments, 'Structured generation output')
    let value: unknown
    try {
      value = JSON.parse(call.arguments) as unknown
    } catch (error) {
      throw new ExperienceError('invalid_command', 'Structured generator tool arguments are not valid JSON', {}, { cause: error })
    }
    const violations = validateJsonSchemaValue(tool.parameters, value, 'candidate')
    if (violations.length > 0) {
      throw new ExperienceError('invalid_command', 'Structured generator tool arguments do not match the Candidate schema', {
        violations,
      })
    }
    appendStructuredToolResult(session, call, callSeq, false)
    return {
      value,
      rawArguments: call.arguments,
      ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    }
  } catch (error) {
    appendStructuredToolResult(session, call, callSeq, true)
    throw error
  }
}

function appendStructuredToolCall(session: Session, call: ToolCallBlock): SessionSeq {
  return session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: call.id,
    name: call.name,
    arguments: call.arguments,
  }).seq
}

function appendStructuredToolResult(
  session: Session,
  call: ToolCallBlock,
  callSeq: SessionSeq,
  isError: boolean,
): void {
  const message = createToolResultMessage({
    callId: call.id,
    content: [{
      type: 'text',
      text: isError ? 'Structured result rejected by local validation.' : 'Structured result accepted by local validation.',
    }],
    isError,
  })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message,
    ...(isError ? { error: { name: 'StructuredGenerationValidationError', code: 'STRUCTURED_RESULT_REJECTED' } } : {}),
  }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
}

function structuredFinishError(
  finish: import('@deepseek-ai/dsh-llm').FinishReason,
  usage: TokenUsage | undefined,
  maxOutputTokens: number | null,
): ExperienceError | undefined {
  switch (finish.kind) {
    case 'tool-calls': return undefined
    case 'max-tokens': return new ExperienceError(
      'proposal_output_limit',
      'Candidate proposal reached its output-token limit before producing a valid structured result',
      {
        maxOutputTokens,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        reasoningTokens: usage?.reasoningTokens,
        automaticRetry: false,
      },
    )
    case 'error':
    case 'aborted': return new ExperienceError('internal', `Structured generation failed: ${finish.failure.message}`)
    case 'stop': return new ExperienceError('invalid_command', 'Structured generator returned without the required result tool call')
    default: return new ExperienceError('internal', 'Structured generator returned an unknown finish reason')
  }
}

async function requireDurableSession(
  sessions: SessionStore,
  session: Session,
  cause?: unknown,
): Promise<void> {
  let participated: boolean
  try {
    participated = await sessions.flush(session)
  } catch (error) {
    throw new ExperienceError('internal', 'Structured generation Session could not be persisted', {}, { cause: error })
  }
  if (!participated) {
    throw new ExperienceError(
      'internal',
      'Structured generation requires a durable Session persistence listener',
      {},
      cause === undefined ? undefined : { cause },
    )
  }
}

function generationFailure(error: unknown): { readonly kind: 'error'; readonly error: { readonly message: string; readonly code: string } } {
  const code = typeof error === 'object' && error !== null && typeof Reflect.get(error, 'code') === 'string'
    ? Reflect.get(error, 'code') as string
    : 'UNKNOWN'
  return {
    kind: 'error',
    error: { message: error instanceof Error ? error.message : String(error), code },
  }
}
