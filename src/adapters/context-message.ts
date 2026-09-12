import { createUserMessage, type ContextSnapshotSection, type Message, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextSnapshotView } from '../types.js'

/** Durable provenance carried beside every model-visible Experience message. */
export interface ExperienceMessageSource {
  readonly kind: 'experience'
  readonly plugin: '@alcheme/dsh-experience-map'
  readonly lifecycle: 'active' | 'inactive'
  readonly usageId: string
  readonly contextSnapshotId: string
  readonly contextDeliveryId: string
  readonly contentDigest: string
  readonly form: 'snapshot' | 'notice'
  readonly sections?: readonly ContextSnapshotSection[]
  readonly summary?: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    experience: ExperienceMessageSource
  }
}

/** Build the single active Experience message that Agent Loop will append. */
export function createExperienceContextMessage(
  content: string,
  snapshot: Pick<ContextSnapshotView, 'usageId' | 'contextSnapshotId' | 'contentDigest' | 'sections'>,
  contextDeliveryId: string,
): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: content }],
    source: {
      kind: 'experience',
      plugin: '@alcheme/dsh-experience-map',
      lifecycle: 'active',
      usageId: String(snapshot.usageId),
      contextSnapshotId: String(snapshot.contextSnapshotId),
      contextDeliveryId,
      contentDigest: snapshot.contentDigest,
      form: 'snapshot',
      sections: snapshot.sections.map(section => ({ name: section.name, text: section.text })),
    },
  })
}

/** Build an inert replacement marker that preserves history without retaining old instructions. */
export function createExperienceRetirementMessage(
  delivery: { readonly usageId: string; readonly contextSnapshotId: string; readonly contextDeliveryId: string },
  contextRetirementId: string,
): UserMessage {
  const summary = `Experience context ${String(delivery.contextSnapshotId)} retired before the next usage.`
  return createUserMessage({
    content: [{ type: 'text', text: `<experience-context-inactive retirement="${contextRetirementId}" />` }],
    source: {
      kind: 'experience',
      plugin: '@alcheme/dsh-experience-map',
      lifecycle: 'inactive',
      usageId: delivery.usageId,
      contextSnapshotId: delivery.contextSnapshotId,
      contextDeliveryId: delivery.contextDeliveryId,
      contentDigest: '',
      form: 'notice',
      summary,
    },
  })
}

/** Narrow one immutable Harness message to Experience-owned provenance. */
export function experienceMessageSource(message: Message): ExperienceMessageSource | null {
  return message.source.kind === 'experience' ? message.source : null
}
