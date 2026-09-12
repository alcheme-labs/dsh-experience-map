import type { BoundedSourceRecord } from '../types.js'

/** Human-readable section extracted from one exact bounded source record. */
export interface DisclosureSection {
  readonly kind: 'content' | 'reasoning' | 'response' | 'tool' | 'input' | 'output'
    | 'step_start' | 'step_end' | 'turn_end' | 'record'
  readonly text: string
}

/** Readable projection of one record; the unchanged excerpt remains the technical source. */
export interface DisclosureRecordPresentation {
  readonly sections: readonly DisclosureSection[]
  readonly rawExcerpt: string
}

/** Project known Session event payloads into readable content without changing proposal input. */
export function presentDisclosureRecord(record: BoundedSourceRecord): DisclosureRecordPresentation {
  const parsed = parseJson(record.excerpt)
  if (parsed === undefined) return fallback(record.excerpt)
  const root = asRecord(parsed)
  if (root === undefined) return fallback(record.excerpt)
  const data = asRecord(root.data)
  let sections: DisclosureSection[]
  switch (record.eventType) {
    case 'user/message':
      sections = textSections(data?.content, 'content')
      break
    case 'assistant/message':
      sections = assistantSections(asRecord(data?.message)?.content)
      break
    case 'tool/call':
      sections = toolCallSections(data)
      break
    case 'tool/result':
      sections = textSections(asRecord(data?.message)?.content, 'output')
      break
    case 'step/start':
      sections = lifecycleSection('step_start', data)
      break
    case 'step/end':
      sections = lifecycleSection('step_end', data)
      break
    case 'turn/end':
      sections = lifecycleSection('turn_end', data)
      break
    case 'historical_record':
      sections = deepTextSections(parsed, 'record')
      break
    default:
      sections = deepTextSections(parsed, 'record')
  }
  return {
    sections: sections.length === 0 ? [{ kind: 'record', text: readableValue(parsed) }] : sections,
    rawExcerpt: record.excerpt,
  }
}

function assistantSections(value: unknown): DisclosureSection[] {
  const items = Array.isArray(value) ? value : [value]
  const sections: DisclosureSection[] = []
  for (const item of items) {
    if (typeof item === 'string') {
      if (item.trim() !== '') sections.push({ kind: 'response', text: item })
      continue
    }
    const content = asRecord(item)
    if (content === undefined) continue
    if ((content.type === 'text' || content.type === 'reasoning') && typeof content.text === 'string') {
      sections.push({ kind: content.type === 'reasoning' ? 'reasoning' : 'response', text: content.text })
      continue
    }
    if (content.type === 'tool-call') {
      if (typeof content.name === 'string') sections.push({ kind: 'tool', text: content.name })
      if (content.arguments !== undefined) sections.push({ kind: 'input', text: readableValue(content.arguments) })
    }
  }
  return sections
}

function toolCallSections(data: Record<string, unknown> | undefined): DisclosureSection[] {
  if (data === undefined) return []
  const sections: DisclosureSection[] = []
  if (typeof data.name === 'string') sections.push({ kind: 'tool', text: data.name })
  if (data.arguments !== undefined) sections.push({ kind: 'input', text: readableValue(data.arguments) })
  return sections
}

function lifecycleSection(
  kind: Extract<DisclosureSection['kind'], 'step_start' | 'step_end' | 'turn_end'>,
  data: Record<string, unknown> | undefined,
): DisclosureSection[] {
  if (data === undefined) return []
  const values: string[] = []
  if (Number.isSafeInteger(data.turn)) values.push(`turn ${String(data.turn)}`)
  if (Number.isSafeInteger(data.step)) values.push(`step ${String(data.step)}`)
  if (data.reason !== undefined) values.push(readableValue(data.reason))
  return values.length === 0 ? [] : [{ kind, text: values.join(' · ') }]
}

function textSections(value: unknown, kind: DisclosureSection['kind']): DisclosureSection[] {
  const texts = deepTexts(value)
  return texts.map(text => ({ kind, text }))
}

function deepTextSections(value: unknown, kind: DisclosureSection['kind']): DisclosureSection[] {
  return deepTexts(value).map(text => ({ kind, text }))
}

function deepTexts(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(deepTexts)
  const record = asRecord(value)
  if (record === undefined) return []
  const texts: string[] = []
  if (typeof record.text === 'string' && record.text.trim() !== '') texts.push(record.text)
  for (const [key, nested] of Object.entries(record)) {
    if (key !== 'text') texts.push(...deepTexts(nested))
  }
  return texts
}

function readableValue(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = parseJson(value)
    return parsed === undefined ? value : JSON.stringify(parsed, null, 2)
  }
  return JSON.stringify(value, null, 2) ?? String(value)
}

function fallback(excerpt: string): DisclosureRecordPresentation {
  return { sections: [{ kind: 'record', text: excerpt }], rawExcerpt: excerpt }
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
