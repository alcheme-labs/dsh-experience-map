import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { digest } from './planning.js'
import { ExperienceError } from '../errors.js'
import type { ExperienceVersionView, RevisionChangeView } from '../types.js'

const FORMAT = 'experience-map-markdown-v1'
const MARKER = '<!-- experience-map-projection:'

interface ProjectionMetadata {
  readonly format: typeof FORMAT
  readonly experienceId: string
  readonly experienceVersionId: string
  readonly versionContentDigest: string
  readonly components: readonly {
    readonly componentId: string
    readonly componentRevisionId: string
    readonly semanticRole: string
  }[]
}

/** Render one deterministic human-readable projection of an immutable Version. */
export function renderExperienceMarkdown(version: ExperienceVersionView): string {
  const metadata: ProjectionMetadata = {
    format: FORMAT,
    experienceId: version.experienceId,
    experienceVersionId: version.experienceVersionId,
    versionContentDigest: version.contentDigest,
    components: version.components.map(component => ({
      componentId: component.componentId,
      componentRevisionId: component.componentRevisionId,
      semanticRole: component.role,
    })),
  }
  const encoded = Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64url')
  const sections = version.components.map(component => [
    `## Component ${component.componentId}`,
    `Role: ${component.role}`,
    `Revision: ${component.componentRevisionId}`,
    '',
    component.content,
  ].join('\n'))
  return [
    '# Experience Map Projection',
    `${MARKER}${encoded} -->`,
    '',
    '## Overview',
    `Title: ${version.title}`,
    `Intent: ${version.intent}`,
    `Kind: ${version.kind}`,
    `Version: ${String(version.versionNumber)}`,
    '',
    ...sections.flatMap(section => [section, '']),
  ].join('\n')
}

/** Verify one edited projection and return only component-scoped structured changes. */
export function parseExperienceMarkdownRevision(
  editedMarkdown: string,
  base: ExperienceVersionView,
  expectedProjectionDigest: string,
  maxBytes: number,
): RevisionChangeView[] {
  if (Buffer.byteLength(editedMarkdown, 'utf8') > maxBytes) {
    throw new ExperienceError('invalid_command', 'Edited Markdown exceeds the configured projection limit')
  }
  const lines = editedMarkdown.replaceAll('\r\n', '\n').split('\n')
  if (lines[0] !== '# Experience Map Projection' || !lines[1]?.startsWith(MARKER) || !lines[1].endsWith(' -->')) {
    throw new ExperienceError('invalid_command', 'Markdown projection header or receipt metadata is missing')
  }
  const encoded = lines[1].slice(MARKER.length, -4)
  const metadata = decodeMetadata(encoded)
  validateMetadata(metadata, base)
  const expectedOverview = [
    '## Overview',
    `Title: ${base.title}`,
    `Intent: ${base.intent}`,
    `Kind: ${base.kind}`,
    `Version: ${String(base.versionNumber)}`,
  ]
  const overviewStart = lines.indexOf('## Overview')
  if (overviewStart !== 3 || lines[2] !== ''
    || expectedOverview.some((line, index) => lines[overviewStart + index] !== line)) {
    throw new ExperienceError('invalid_command', 'Markdown overview is immutable; edit component bodies only')
  }
  const firstComponent = lines.findIndex(line => line.startsWith('## Component '))
  if (firstComponent !== overviewStart + expectedOverview.length + 1
    || lines[overviewStart + expectedOverview.length] !== '') {
    throw new ExperienceError('invalid_command', 'Markdown projection has no component sections')
  }

  const parsed = parseComponentSections(lines.slice(firstComponent))
  if (parsed.size !== base.components.length) {
    throw new ExperienceError('invalid_command', 'Markdown projection is missing or duplicates a component section')
  }
  if (JSON.stringify([...parsed.keys()]) !== JSON.stringify(base.components.map(item => String(item.componentId)))) {
    throw new ExperienceError('invalid_command', 'Markdown component order is immutable')
  }
  const changes: RevisionChangeView[] = []
  for (const component of base.components) {
    const section = parsed.get(String(component.componentId))
    if (section === undefined) throw new ExperienceError('invalid_command', 'Markdown projection is missing a component section')
    if (section.role !== component.role || section.revision !== component.componentRevisionId) {
      throw new ExperienceError('invalid_command', 'Markdown component identity, role, or revision was changed')
    }
    if (section.content === component.content) continue
    if (section.content.trim() === '') throw new ExperienceError('required_field_missing', 'Edited component content must not be empty')
    changes.push({
      revisionChangeId: digest({ expectedProjectionDigest, componentId: component.componentId, content: section.content }),
      componentId: component.componentId,
      semanticRole: component.role,
      replacementContent: section.content,
      sourceRefs: component.sourceRefs,
      decision: 'pending',
      decisionReason: null,
    })
  }
  if (changes.length === 0) throw new ExperienceError('invalid_command', 'Edited Markdown contains no component changes')
  return changes
}

/** Digest the exact exported or edited Markdown bytes. */
export function markdownDigest(markdown: string): string {
  return `sha256:${createHash('sha256').update(markdown, 'utf8').digest('hex')}`
}

function decodeMetadata(encoded: string): ProjectionMetadata {
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown
    if (!isRecord(value) || value.format !== FORMAT || typeof value.experienceId !== 'string'
      || typeof value.experienceVersionId !== 'string' || typeof value.versionContentDigest !== 'string'
      || !Array.isArray(value.components)) throw new Error('invalid')
    const components = value.components.map(item => {
      if (!isRecord(item) || typeof item.componentId !== 'string'
        || typeof item.componentRevisionId !== 'string' || typeof item.semanticRole !== 'string') throw new Error('invalid')
      return {
        componentId: item.componentId,
        componentRevisionId: item.componentRevisionId,
        semanticRole: item.semanticRole,
      }
    })
    return { format: FORMAT, experienceId: value.experienceId,
      experienceVersionId: value.experienceVersionId, versionContentDigest: value.versionContentDigest, components }
  } catch (error) {
    throw new ExperienceError('invalid_command', 'Markdown projection metadata is invalid', {}, { cause: error })
  }
}

function validateMetadata(metadata: ProjectionMetadata, base: ExperienceVersionView): void {
  const expected = base.components.map(component => ({
    componentId: String(component.componentId),
    componentRevisionId: String(component.componentRevisionId),
    semanticRole: component.role,
  }))
  if (metadata.experienceId !== base.experienceId
    || metadata.experienceVersionId !== base.experienceVersionId
    || metadata.versionContentDigest !== base.contentDigest
    || JSON.stringify(metadata.components) !== JSON.stringify(expected)) {
    throw new ExperienceError('invalid_command', 'Markdown projection metadata does not match the exported Version')
  }
}

function parseComponentSections(lines: readonly string[]): Map<string, { role: string; revision: string; content: string }> {
  const result = new Map<string, { role: string; revision: string; content: string }>()
  let index = 0
  while (index < lines.length) {
    while (lines[index]?.trim() === '') index += 1
    if (index >= lines.length) break
    const header = lines[index]
    if (header === undefined || !header.startsWith('## Component ')) {
      throw new ExperienceError('invalid_command', 'Markdown projection contains an unknown section')
    }
    const componentId = header.slice('## Component '.length).trim()
    if (componentId === '' || result.has(componentId)) {
      throw new ExperienceError('invalid_command', 'Markdown projection duplicates or omits a component identity')
    }
    const roleLine = lines[index + 1]
    const revisionLine = lines[index + 2]
    if (!roleLine?.startsWith('Role: ') || !revisionLine?.startsWith('Revision: ') || lines[index + 3] !== '') {
      throw new ExperienceError('invalid_command', 'Markdown component header is invalid')
    }
    index += 4
    const content: string[] = []
    while (index < lines.length && !lines[index]!.startsWith('## Component ')) {
      if (lines[index]!.startsWith('## ')) {
        throw new ExperienceError('invalid_command', 'Markdown projection contains an unknown section')
      }
      content.push(lines[index]!)
      index += 1
    }
    while (content.at(-1) === '') content.pop()
    result.set(componentId, {
      role: roleLine.slice('Role: '.length),
      revision: revisionLine.slice('Revision: '.length),
      content: content.join('\n'),
    })
  }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
