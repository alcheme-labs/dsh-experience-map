import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ActorResolver } from '../src/application/actor-resolver.js'
import { markdownDigest } from '../src/domain/markdown.js'
import { digest } from '../src/domain/planning.js'
import { ExperienceDatabase } from '../src/persistence/database.js'
import { ExperienceRepository } from '../src/persistence/repository.js'
import type { ActorView, RevisionProposalView } from '../src/types.js'
import { envelope } from './fixtures/m5-usage.js'
import { publishReviewedWorkflow } from './fixtures/published-workflow.js'
import { workflowDraft } from './fixtures/workflow.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('M7 Markdown projection and reviewable write-back', () => {
  it('digests the exact UTF-8 Markdown bytes used by the Browser client', () => {
    const markdown = '# Experience\n\n中文与 emoji 🧭\n'
    expect(markdownDigest(markdown)).toBe(
      `sha256:${createHash('sha256').update(new TextEncoder().encode(markdown)).digest('hex')}`,
    )
  })

  it('turns an exact component edit into a proposal and publishes only after field review', async () => {
    const state = await open()
    const published = await publishReviewedWorkflow(state.repository, state.actor, 1_300)
    const base = state.repository.getVersion(published.published.experienceVersionId!, state.actor)
    const projection = await state.repository.exportMarkdown({
      ...envelope(), experienceVersionId: base.experienceVersionId,
    }, state.actor, 262_144)
    const component = base.components[0]!
    const replacement = `${component.content} Confirm the authoritative readback before reuse.`
    const editedMarkdown = projection.markdown.replace(component.content, replacement)
    const receipt = await state.repository.proposeMarkdownRevision({
      ...envelope(),
      markdownProjectionReceiptId: projection.receipt.markdownProjectionReceiptId,
      editedMarkdown,
      editedMarkdownDigest: markdownDigest(editedMarkdown),
    }, state.actor, 262_144)

    const proposal = state.repository.getRevisionProposal(String(receipt.revisionProposalId), state.actor)
    expect(proposal).toMatchObject({
      baseVersionId: base.experienceVersionId,
      sourceUsageId: null,
      sourceMarkdownProjectionReceiptId: projection.receipt.markdownProjectionReceiptId,
      diagnosis: { classification: 'markdown_diff' },
      state: 'proposed',
    })
    expect(proposal.changes).toEqual([expect.objectContaining({
      componentId: component.componentId,
      replacementContent: replacement,
      sourceRefs: component.sourceRefs,
      decision: 'pending',
    })])
    expect(state.repository.getVersion(base.experienceVersionId, state.actor).components[0]!.content)
      .toBe(component.content)

    const reviewed = await acceptAll(state.repository, state.actor, proposal)
    const result = await state.repository.publishRevision({
      ...envelope(), revisionProposalId: reviewed.revisionProposalId, expectedRevision: reviewed.revision,
    }, state.actor)
    const next = state.repository.getVersion(result.experienceVersionId!, state.actor)
    expect(next).toMatchObject({ previousVersionId: base.experienceVersionId, versionNumber: base.versionNumber + 1 })
    expect(next.components[0]!.content).toBe(replacement)
    expect(state.repository.getVersion(base.experienceVersionId, state.actor).components[0]!.content)
      .toBe(component.content)
    expect(state.repository.getAuditDossier({
      subject: { kind: 'experience', id: String(base.experienceId) },
      asOfRecordedAt: null, cursor: null, limit: 100,
    }, state.actor).objects.map(item => item.objectKind)).toEqual(expect.arrayContaining([
      'markdown_projection', 'revision_proposal', 'revision_change',
    ]))
    await state.database.close()
  })

  it('rejects unknown sections, immutable metadata edits, stale bases, and forgotten targets', async () => {
    const state = await open()
    const published = await publishReviewedWorkflow(state.repository, state.actor, 1_310)
    const base = state.repository.getVersion(published.published.experienceVersionId!, state.actor)
    const projection = await state.repository.exportMarkdown({
      ...envelope(), experienceVersionId: base.experienceVersionId,
    }, state.actor, 262_144)
    const component = base.components[0]!
    const changed = projection.markdown.replace(component.content, `${component.content} Updated.`)
    const unknown = changed.replace(`## Component ${String(component.componentId)}`, '## Unsupported\nvalue\n\n'
      + `## Component ${String(component.componentId)}`)
    await expect(state.repository.proposeMarkdownRevision({
      ...envelope(), markdownProjectionReceiptId: projection.receipt.markdownProjectionReceiptId,
      editedMarkdown: unknown, editedMarkdownDigest: markdownDigest(unknown),
    }, state.actor, 262_144)).rejects.toMatchObject({ code: 'invalid_command' })
    const metadataEdit = changed.replace(`Title: ${base.title}`, 'Title: rewritten outside structured review')
    await expect(state.repository.proposeMarkdownRevision({
      ...envelope(), markdownProjectionReceiptId: projection.receipt.markdownProjectionReceiptId,
      editedMarkdown: metadataEdit, editedMarkdownDigest: markdownDigest(metadataEdit),
    }, state.actor, 262_144)).rejects.toMatchObject({ code: 'invalid_command' })

    const proposed = await state.repository.proposeMarkdownRevision({
      ...envelope(), markdownProjectionReceiptId: projection.receipt.markdownProjectionReceiptId,
      editedMarkdown: changed, editedMarkdownDigest: markdownDigest(changed),
    }, state.actor, 262_144)
    const accepted = await acceptAll(
      state.repository, state.actor,
      state.repository.getRevisionProposal(String(proposed.revisionProposalId), state.actor),
    )
    await state.repository.publishRevision({
      ...envelope(), revisionProposalId: accepted.revisionProposalId, expectedRevision: accepted.revision,
    }, state.actor)
    await expect(state.repository.proposeMarkdownRevision({
      ...envelope(), markdownProjectionReceiptId: projection.receipt.markdownProjectionReceiptId,
      editedMarkdown: changed, editedMarkdownDigest: markdownDigest(changed),
    }, state.actor, 262_144)).rejects.toMatchObject({ code: 'stale_revision' })

    const current = state.repository.getStatus(state.actor).latestVersion!
    const currentProjection = await state.repository.exportMarkdown({
      ...envelope(), experienceVersionId: current.experienceVersionId,
    }, state.actor, 262_144)
    const preview = state.repository.previewForget(current.experienceId, state.actor)
    await state.repository.forgetExperience({
      ...envelope(), experienceId: current.experienceId,
      expectedSeriesRevision: preview.expectedSeriesRevision,
      previewDigest: preview.previewDigest,
      reason: 'Owner removes the test Experience from future recall.',
    }, state.actor)
    await expect(state.repository.proposeMarkdownRevision({
      ...envelope(), markdownProjectionReceiptId: currentProjection.receipt.markdownProjectionReceiptId,
      editedMarkdown: currentProjection.markdown.replace(current.components[0]!.content, 'Changed after Forget.'),
      editedMarkdownDigest: markdownDigest(
        currentProjection.markdown.replace(current.components[0]!.content, 'Changed after Forget.')),
    }, state.actor, 262_144)).rejects.toMatchObject({ code: 'invalid_command' })
    await state.database.close()
  })

  it('refuses secret-reference-only export and reads an immutable projection after restart', async () => {
    const state = await open()
    const secret = await publishReviewedWorkflow(state.repository, state.actor, 1_320)
    const secretVersion = state.repository.getVersion(secret.published.experienceVersionId!, state.actor)
    if (secretVersion.contentDigestSchema !== 'v2-source-bound') throw new Error('Expected a source-bound Version')
    const secretContentDigest = digest({
      contentDigestSchema: 'v2-source-bound',
      kind: secretVersion.kind,
      title: secretVersion.title,
      intent: secretVersion.intent,
      scope: secretVersion.scope,
      validity: secretVersion.validity,
      authoritySpec: secretVersion.authoritySpec,
      privacyClass: 'secret_reference_only',
      riskAndEffectSpec: secretVersion.riskAndEffectSpec,
      allowedUseModes: secretVersion.allowedUseModes,
      sourceEpisodeRefs: secretVersion.sourceEpisodeRefs,
      sourceRefs: secretVersion.sourceRefs,
      components: secretVersion.components.map(component => ({
        componentKey: component.componentKey,
        role: component.role,
        content: component.content,
        sourceRefs: component.sourceRefs,
      })),
      evidenceGrade: secretVersion.evidenceGrade,
    }).slice('sha256:'.length)
    state.database.handle.prepare(
      `UPDATE experience_versions SET privacy_class = ?, content_digest = ?, payload_json = ?
        WHERE experience_version_id = ?`,
    ).run('secret_reference_only', secretContentDigest, JSON.stringify({
      ...secretVersion, privacyClass: 'secret_reference_only', contentDigest: secretContentDigest,
    }),
      secretVersion.experienceVersionId)
    await expect(state.repository.exportMarkdown({
      ...envelope(), experienceVersionId: secretVersion.experienceVersionId,
    }, state.actor, 262_144)).rejects.toMatchObject({ code: 'sensitive_content_unauthorized' })

    const normal = await publishReviewedWorkflow(state.repository, state.actor, 1_321, workflowDraft({
      title: 'Normal Markdown projection diagnostic',
      intent: 'Verify an ordinary projection remains readable after restart.',
    }))
    const projection = await state.repository.exportMarkdown({
      ...envelope(), experienceVersionId: normal.published.experienceVersionId!,
    }, state.actor, 262_144)
    await state.database.close()
    const database = await ExperienceDatabase.open({
      databasePath: join(state.directory, 'experience.sqlite'), journalMode: 'wal', synchronous: 'normal',
      busyTimeoutMs: 50, maxPendingWrites: 8,
    })
    const repository = new ExperienceRepository(database)
    const principal = await repository.initializePrincipal()
    const actor = new ActorResolver(principal).resolve({ kind: 'management-cli' })
    expect(repository.getMarkdownProjection(
      String(projection.receipt.markdownProjectionReceiptId), actor,
    )).toEqual(projection)
    await database.close()
  })
})

async function acceptAll(
  repository: ExperienceRepository,
  actor: ActorView,
  initial: RevisionProposalView,
): Promise<RevisionProposalView> {
  let proposal = initial
  for (const change of proposal.changes) {
    await repository.decideRevisionChange({
      ...envelope(), revisionProposalId: proposal.revisionProposalId,
      expectedRevision: proposal.revision, revisionChangeId: change.revisionChangeId,
      decision: 'accept', reason: 'Owner reviewed the exact component diff.',
    }, actor)
    proposal = repository.getRevisionProposal(String(proposal.revisionProposalId), actor)
  }
  return proposal
}

async function open(): Promise<{
  directory: string
  database: ExperienceDatabase
  repository: ExperienceRepository
  actor: ActorView
}> {
  const directory = await mkdtemp(join(tmpdir(), 'experience-map-m7-markdown-'))
  cleanup.push(directory)
  const database = await ExperienceDatabase.open({
    databasePath: join(directory, 'experience.sqlite'), journalMode: 'wal', synchronous: 'normal',
    busyTimeoutMs: 50, maxPendingWrites: 8,
  })
  const repository = new ExperienceRepository(database)
  const principal = await repository.initializePrincipal()
  return { directory, database, repository,
    actor: new ActorResolver(principal).resolve({ kind: 'management-cli' }) }
}
