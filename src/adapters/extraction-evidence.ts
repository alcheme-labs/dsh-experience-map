import { createHash } from 'node:crypto'
import { assertSafeText } from '../application/content-policy.js'
import { ExperienceError } from '../errors.js'
import type {
  BoundedSourceRecord,
  EpisodeRefView,
  ExtractionEvidenceClass,
  ExtractionEvidenceItem,
  ExtractionEvidencePacket,
  ExtractionEvidenceRole,
  ExtractionOmissionReason,
  ExtractionOmissionView,
} from '../types.js'

export const EXTRACTION_BUILDER_VERSION = 'diagnostic-evidence-packet-v3'

/** Deployment bounds for the transient proposal evidence projection. */
export interface ExtractionEvidenceConfig {
  readonly maxEvidenceItems: number
  readonly maxEvidenceItemBytes: number
  readonly maxEvidencePacketBytes: number
}

interface ProjectedItem {
  readonly ordinal: number
  readonly priority: number
  readonly item: ExtractionEvidenceItem
}

interface ProjectedRecord {
  readonly items: readonly ProjectedItem[]
  readonly omissions: readonly ExtractionOmissionView[]
}

interface ProjectionContext {
  readonly terminalAssistantRefs: ReadonlySet<string>
  readonly toolNamesByCallId: ReadonlyMap<string, string>
  readonly toolDetailsByCallId: ReadonlyMap<string, string>
  readonly toolResultCallIds: ReadonlySet<string>
}

/** Build the deterministic, source-preserving packet sent to a Diagnostic proposal model. */
export function buildExtractionEvidencePacket(
  episodeRefs: readonly EpisodeRefView[],
  records: readonly BoundedSourceRecord[],
  config: ExtractionEvidenceConfig,
): ExtractionEvidencePacket {
  if (episodeRefs.length === 0 || records.length === 0) {
    throw new ExperienceError('source_unresolvable', 'Diagnostic extraction requires Episode and source records')
  }
  const context = projectionContext(records)
  const projected = records.map((record, ordinal) => projectRecord(
    record,
    ordinal,
    config.maxEvidenceItemBytes,
    context,
  ))
  const candidates = projected.flatMap(result => result.items)
    .sort((left, right) => left.priority - right.priority || left.ordinal - right.ordinal)
  const omissions = projected.flatMap(result => result.omissions)
  const selected: ProjectedItem[] = []
  for (const candidate of candidates) {
    if (selected.length >= config.maxEvidenceItems) {
      omissions.push(omission(candidate.item, 'item_limit'))
      continue
    }
    selected.push(candidate)
  }
  let items = [...selected].sort((left, right) => left.ordinal - right.ordinal).map(value => value.item)
  let payload = packetPayload(episodeRefs, items, omissions, records)
  while (items.length > 1 && Buffer.byteLength(canonicalJson(payload)) > config.maxEvidencePacketBytes) {
    const removed = selected.pop()
    if (removed === undefined) break
    omissions.push(omission(removed.item, 'packet_byte_limit'))
    const retained = new Set(selected.map(item => item.item.itemId))
    items = items.filter(item => retained.has(item.itemId))
    payload = packetPayload(episodeRefs, items, omissions, records)
  }
  const packetBytes = Buffer.byteLength(canonicalJson(payload))
  if (items.length === 0 || packetBytes > config.maxEvidencePacketBytes) {
    throw new ExperienceError('source_unresolvable', 'Diagnostic evidence packet cannot fit its configured byte limit', {
      maxEvidencePacketBytes: config.maxEvidencePacketBytes,
      packetBytes,
    })
  }
  const disposition = sourceDisposition(items, omissions)
  return {
    builderVersion: EXTRACTION_BUILDER_VERSION,
    episodeRefs,
    items,
    omissions: sortOmissions(omissions),
    sourceRecordCount: records.length,
    ...disposition,
    sourceRecordBytes: records.reduce((total, record) => total + Buffer.byteLength(record.excerpt), 0),
    packetBytes,
    packetDigest: `sha256:${sha256(canonicalJson(payload))}`,
  }
}

/** Return only the packet fields visible to the proposal model. */
export function modelEvidenceEnvelope(packet: ExtractionEvidencePacket): unknown {
  return {
    builderVersion: packet.builderVersion,
    episodeRefs: packet.episodeRefs,
    evidenceItems: packet.items.map((item, index) => ({
      itemId: item.itemId,
      sourceAlias: sourceAlias(index),
      evidenceRole: item.evidenceRole,
      evidenceClass: item.evidenceClass,
      eventType: item.eventType,
      projectionTruncated: item.projectionTruncated,
      content: item.content,
    })),
    omissionSummary: packet.omissionReasonCounts,
    sourceRecordCount: packet.sourceRecordCount,
    evidenceItemCount: packet.items.length,
  }
}

/** Resolve one model-visible alias back to the exact locally held SourceRef id. */
export function sourceRefIdForAlias(packet: ExtractionEvidencePacket, alias: string): string | undefined {
  const match = /^s([1-9][0-9]*)$/u.exec(alias)
  if (match === null) return undefined
  const index = Number(match[1]) - 1
  return packet.items[index]?.sourceRef.sourceRefId
}

function projectRecord(
  record: BoundedSourceRecord,
  ordinal: number,
  maxBytes: number,
  context: ProjectionContext,
): ProjectedRecord {
  const parsed = parseJson(record.excerpt)
  if (record.eventType === 'step/start' || record.eventType === 'step/end') {
    return omittedRecord(record, 'lifecycle_noise')
  }
  if (parsed === undefined) {
    if (record.eventType === 'historical_record') {
      return oneItem(record, ordinal, 'historical_evidence', 'historical_record', record.excerpt, 1, maxBytes)
    }
    return omittedRecord(record, 'empty_projection')
  }
  const root = asRecord(parsed)
  const data = asRecord(root?.data)
  switch (record.eventType) {
    case 'user/message': {
      const text = visibleTexts(data?.content).join('\n\n')
      return text === '' ? omittedRecord(record, 'empty_projection')
        : oneItem(record, ordinal, 'user_goal', 'user_instruction', text, 0, maxBytes)
    }
    case 'assistant/message': {
      const content = asRecord(data?.message)?.content
      const text = assistantVisibleTexts(content).join('\n\n')
      const omissions = hasReasoning(content) ? [omission(record, 'assistant_reasoning_removed')] : []
      if (text === '') return { items: [], omissions: omissions.length === 0
        ? [omission(record, 'empty_projection')] : omissions }
      if (!context.terminalAssistantRefs.has(record.sourceRef.sourceRefId)) {
        return { items: [], omissions: [...omissions, omission(record, 'intermediate_model_commentary')] }
      }
      const item = oneItem(record, ordinal, 'model_claim', 'model_claim', text, 4, maxBytes)
      return { items: item.items, omissions: [...item.omissions, ...omissions] }
    }
    case 'tool/call': {
      const name = typeof data?.name === 'string' ? data.name : 'tool'
      if (!isDiagnosticEvidenceTool(name)) {
        return omittedRecord(record, 'low_relevance_action')
      }
      const callId = typeof data?.callId === 'string' ? data.callId : undefined
      if (callId !== undefined && context.toolResultCallIds.has(callId)) {
        return omittedRecord(record, 'merged_into_tool_result')
      }
      const detail = toolDetail(name, data?.arguments)
      return oneItem(record, ordinal, 'attempted_action', 'observed_fact', detail, 2, maxBytes)
    }
    case 'tool/result': {
      const text = visibleTexts(asRecord(data?.message)?.content).join('\n\n')
        || (typeof data?.output === 'string' ? data.output : '')
      if (text === '') return omittedRecord(record, 'empty_projection')
      const callId = toolResultCallId(data)
      const toolName = callId === undefined ? undefined : context.toolNamesByCallId.get(callId)
      if (toolName !== undefined && !isDiagnosticEvidenceTool(toolName)) {
        return omittedRecord(record, 'low_relevance_action')
      }
      const role = classifyToolResult(parsed, text, toolName)
      const detail = callId === undefined ? undefined : context.toolDetailsByCallId.get(callId)
      const content = detail === undefined ? text : `${detail}\n\n${text}`
      return oneItem(record, ordinal, role, 'observed_fact', content, role === 'tool_observation' ? 1 : 0, maxBytes)
    }
    case 'turn/end': {
      const reason = readableValue(data?.reason ?? data ?? parsed)
      return oneItem(record, ordinal, 'terminal_outcome', 'observed_fact', reason, 0, maxBytes)
    }
    case 'historical_record': {
      const text = visibleTexts(parsed).join('\n\n') || record.excerpt
      return oneItem(
        record,
        ordinal,
        'historical_evidence',
        'historical_record',
        text,
        historicalPriority(text),
        maxBytes,
      )
    }
    case 'acceptance_criterion': {
      return oneItem(record, ordinal, 'acceptance_criterion', 'observed_fact', record.excerpt, 0, maxBytes)
    }
    default:
      return omittedRecord(record, 'lifecycle_noise')
  }
}

function projectionContext(records: readonly BoundedSourceRecord[]): ProjectionContext {
  const lastAssistantByTurn = new Map<string, string>()
  const toolNamesByCallId = new Map<string, string>()
  const toolDetailsByCallId = new Map<string, string>()
  const toolResultCallIds = new Set<string>()
  for (const record of records) {
    const root = asRecord(parseJson(record.excerpt))
    const data = asRecord(root?.data)
    if (record.eventType === 'assistant/message') {
      const content = asRecord(data?.message)?.content
      if (assistantVisibleTexts(content).length > 0) {
        lastAssistantByTurn.set(String(data?.turn ?? 'unknown'), record.sourceRef.sourceRefId)
      }
    }
    if (record.eventType === 'tool/call' && typeof data?.callId === 'string' && typeof data.name === 'string') {
      toolNamesByCallId.set(data.callId, data.name)
      toolDetailsByCallId.set(data.callId, toolDetail(data.name, data.arguments))
    }
    if (record.eventType === 'tool/result') {
      const callId = toolResultCallId(data)
      if (callId !== undefined) toolResultCallIds.add(callId)
    }
  }
  return {
    terminalAssistantRefs: new Set(lastAssistantByTurn.values()),
    toolNamesByCallId,
    toolDetailsByCallId,
    toolResultCallIds,
  }
}

function toolResultCallId(data: Record<string, unknown> | undefined): string | undefined {
  const source = asRecord(asRecord(data?.message)?.source)
  if (typeof source?.callId === 'string') return source.callId
  return undefined
}

function isExecutionTool(name: string): boolean {
  return /(?:bash|shell|exec|terminal|process|subprocess|command)/iu.test(name)
}

function isInspectionTool(name: string): boolean {
  return /(?:^|[./:_-])(?:read|grep|glob)(?:$|[./:_-])/iu.test(name)
}

function isDiagnosticEvidenceTool(name: string): boolean {
  return isExecutionTool(name) || isInspectionTool(name)
}

function historicalPriority(text: string): number {
  if (/(?:plugin tree failed|loader entr(?:y|ies).*(?:failed|cannot)|cannot find module)/iu.test(text)) return 1.1
  if (/(?:http\/\d|127\.0\.0\.1|\blistening\b|dsh web:|读回|监听)/iu.test(text)) return 1.2
  if (/(?:\bpassed\b|\bsuccess\b|\bhealthy\b|exit[_ ]?code[^0-9]{0,8}0|成功|通过)/iu.test(text)) return 1.4
  if (/(?:\berror\b|\bfailed\b|enoent|not found|missing|失败|错误|缺失)/iu.test(text)) return 1.6
  return 3
}

function toolDetail(name: string, value: unknown): string {
  return value === undefined ? name : `${name}\n${readableValue(value)}`
}

function oneItem(
  record: BoundedSourceRecord,
  ordinal: number,
  evidenceRole: ExtractionEvidenceRole,
  evidenceClass: ExtractionEvidenceClass,
  content: string,
  priority: number,
  maxBytes: number,
): ProjectedRecord {
  const bounded = boundedUtf8(content.trim(), maxBytes)
  if (bounded.value === '') return omittedRecord(record, 'empty_projection')
  assertSafeText(bounded.value, `extraction evidence ${record.sourceRef.locator}`)
  const projectionDigest = `sha256:${sha256(bounded.value)}`
  return {
    items: [{
      ordinal,
      priority,
      item: {
        itemId: `evidence:${sha256(`${record.sourceRef.sourceRefId}:${evidenceRole}:${projectionDigest}`)}`,
        sourceRef: record.sourceRef,
        eventType: record.eventType,
        evidenceRole,
        evidenceClass,
        content: bounded.value,
        sourceContentDigest: record.sourceRef.contentDigest,
        projectionDigest,
        projectionTruncated: bounded.truncated,
      },
    }],
    omissions: [],
  }
}

function classifyToolResult(value: unknown, text: string, toolName: string | undefined): ExtractionEvidenceRole {
  if (containsTrueFlag(value, 'isError')) return 'symptom'
  if (toolName !== undefined && isInspectionTool(toolName)) return 'tool_observation'
  if (/(?:\berror\b|\bfailed\b|\bexception\b|enoent|not found|missing|失败|错误|未找到|缺失)/iu.test(text)) {
    return 'symptom'
  }
  if (/(?:http\/\d|exit code 0|\bpassed\b|\bsuccess\b|\bverified\b|\bhealthy\b|\blistening\b|127\.0\.0\.1|读回|成功|通过|监听)/iu.test(text)) {
    return 'terminal_readback'
  }
  return 'tool_observation'
}

function assistantVisibleTexts(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value]
  return items.flatMap((item) => {
    if (typeof item === 'string') return item.trim() === '' ? [] : [item]
    const record = asRecord(item)
    if (record?.type === 'reasoning') return []
    return record?.type === 'text' && typeof record.text === 'string' && record.text.trim() !== ''
      ? [record.text]
      : []
  })
}

function hasReasoning(value: unknown): boolean {
  const items = Array.isArray(value) ? value : [value]
  return items.some(item => asRecord(item)?.type === 'reasoning')
}

function visibleTexts(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() === '' ? [] : [value]
  if (Array.isArray(value)) return value.flatMap(visibleTexts)
  const record = asRecord(value)
  if (record === undefined || record.type === 'reasoning') return []
  const texts: string[] = []
  if (typeof record.text === 'string' && record.text.trim() !== '') texts.push(record.text)
  if (typeof record.output === 'string' && record.output.trim() !== '') texts.push(record.output)
  if (typeof record.message === 'string' && record.message.trim() !== '') texts.push(record.message)
  for (const [key, nested] of Object.entries(record)) {
    if (key !== 'text' && key !== 'output' && key !== 'message' && key !== 'reasoning'
      && (Array.isArray(nested) || asRecord(nested) !== undefined)) {
      texts.push(...visibleTexts(nested))
    } else if (key === 'message' && typeof nested !== 'string') {
      texts.push(...visibleTexts(nested))
    }
  }
  return [...new Set(texts)]
}

function containsTrueFlag(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some(item => containsTrueFlag(item, key))
  const record = asRecord(value)
  if (record === undefined) return false
  if (record[key] === true) return true
  return Object.values(record).some(item => containsTrueFlag(item, key))
}

function omittedRecord(record: BoundedSourceRecord, reason: ExtractionOmissionReason): ProjectedRecord {
  return { items: [], omissions: [omission(record, reason)] }
}

function omission(
  value: BoundedSourceRecord | ExtractionEvidenceItem,
  reason: ExtractionOmissionReason,
): ExtractionOmissionView {
  return {
    sourceRefId: value.sourceRef.sourceRefId,
    eventType: value.eventType,
    reason,
  }
}

function sortOmissions(values: readonly ExtractionOmissionView[]): ExtractionOmissionView[] {
  return [...values].sort((left, right) => left.sourceRefId.localeCompare(right.sourceRefId)
    || left.reason.localeCompare(right.reason))
}

function packetPayload(
  episodeRefs: readonly EpisodeRefView[],
  items: readonly ExtractionEvidenceItem[],
  omissions: readonly ExtractionOmissionView[],
  records: readonly BoundedSourceRecord[],
): unknown {
  const disposition = sourceDisposition(items, omissions)
  return {
    builderVersion: EXTRACTION_BUILDER_VERSION,
    episodeRefs,
    items: items.map(item => ({
      itemId: item.itemId,
      sourceRefId: item.sourceRef.sourceRefId,
      locator: item.sourceRef.locator,
      eventType: item.eventType,
      evidenceRole: item.evidenceRole,
      evidenceClass: item.evidenceClass,
      content: item.content,
      sourceContentDigest: item.sourceContentDigest,
      projectionDigest: item.projectionDigest,
      projectionTruncated: item.projectionTruncated,
    })),
    omissions: sortOmissions(omissions),
    sourceRecordCount: records.length,
    ...disposition,
    sourceRecordBytes: records.reduce((total, record) => total + Buffer.byteLength(record.excerpt), 0),
  }
}

function sourceDisposition(
  items: readonly ExtractionEvidenceItem[],
  omissions: readonly ExtractionOmissionView[],
): Pick<ExtractionEvidencePacket,
  'sentSourceRecordCount' | 'fullyOmittedSourceRecordCount' | 'removedBlockCount' | 'omissionReasonCounts'> {
  const sent = new Set(items.map(item => item.sourceRef.sourceRefId as string))
  const omitted = new Set(omissions.map(item => item.sourceRefId))
  const omissionReasonCounts: Partial<Record<ExtractionOmissionReason, number>> = {}
  for (const item of omissions) omissionReasonCounts[item.reason] = (omissionReasonCounts[item.reason] ?? 0) + 1
  return {
    sentSourceRecordCount: sent.size,
    fullyOmittedSourceRecordCount: [...omitted].filter(sourceRefId => !sent.has(sourceRefId)).length,
    removedBlockCount: omissions.filter(item => sent.has(item.sourceRefId)).length,
    omissionReasonCounts: Object.fromEntries(Object.entries(omissionReasonCounts).sort(([left], [right]) => (
      left.localeCompare(right)
    ))),
  }
}

function sourceAlias(index: number): string {
  return `s${String(index + 1)}`
}

function boundedUtf8(value: string, maxBytes: number): { readonly value: string; readonly truncated: boolean } {
  if (Buffer.byteLength(value) <= maxBytes) return { value, truncated: false }
  const suffix = '…'
  const limit = maxBytes - Buffer.byteLength(suffix)
  let bounded = ''
  let bytes = 0
  for (const character of value) {
    const next = Buffer.byteLength(character)
    if (bytes + next > limit) break
    bounded += character
    bytes += next
  }
  return { value: `${bounded}${suffix}`, truncated: true }
}

function readableValue(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value) as unknown, null, 2)
    } catch {
      return value
    }
  }
  return JSON.stringify(value)
}

function parseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
