import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ActorResolver } from '../../src/application/actor-resolver.js'
import {
  experienceComparisonSetDigest,
  experienceKernelIdentity,
  normalizeKernelText,
} from '../../src/domain/experience-kernel.js'
import { suggestionDigest } from '../../src/domain/automatic-suggestion.js'
import {
  materializeSuggestionGroups,
  suggestionDecisionDigests,
  suggestionEvidenceSourceRefsForComponent,
} from '../../src/domain/suggestion-materializer.js'
import { projectExperienceVersion } from '../../src/domain/retrieval-projector.js'
import { brandedId } from '../../src/ids.js'
import { assertExperienceStoreInvariants } from '../../src/invariant.js'
import { ExperienceDatabase, type DatabaseConfig } from '../../src/persistence/database.js'
import { ExperienceRepository } from '../../src/persistence/repository.js'
import type {
  ActorView,
  ExperienceSuggestionSeedView,
  ExperienceSuggestionGroupView,
  ExperienceVersionView,
  SaveExperienceSuggestionInput,
  SourceRefView,
} from '../../src/types.js'
import { prepareAcceptedWorkflow, workflowCommand } from '../fixtures/published-workflow.js'
import { episodeRef, sourceRef, workflowDraft } from '../fixtures/workflow.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('E3 canonical automatic-suggestion save', () => {
  it('creates one source-bound Experience and reads the exact durable receipt after restart', async () => {
    const path = await temporaryPath()
    const first = await open(path)
    const group = suggestionGroup('new')
    const input = saveInput(group, 1)

    const receipt = await first.repository.saveExperienceSuggestion(input, group, first.actor, 16_384)

    expect(receipt).toMatchObject({
      action: 'suggestion.save',
      outcome: 'saved_new_experience',
      suggestionGroupId: group.suggestionGroupId,
      kernelIdentity: group.kernelIdentity,
      reviewDigest: group.reviewDigest,
      sourceDigest: group.sourceDigest,
      sourceSuggestionGroupIds: [group.suggestionGroupId],
    })
    const version = first.repository.getVersion(receipt.experienceVersionId, first.actor)
    expect(version).toMatchObject({
      kind: 'diagnostic',
      contentDigestSchema: 'v2-source-bound',
      sourceEpisodeRefs: [expect.objectContaining({ episodeRefId: 'episode:new', sessionOrRunId: 'session:new' })],
      sourceRefs: [sourceRef],
      governanceState: 'accepted',
      operationalState: 'conditional',
    })
    expect(first.repository.getStatus(first.actor).versionCount).toBe(1)
    assertExperienceStoreInvariants(first.database.handle)
    await first.database.close()

    const second = await open(path)
    expect(second.repository.getReceipt(receipt.receiptId, second.actor)).toEqual(receipt)
    expect(second.repository.getVersion(receipt.experienceVersionId, second.actor).contentDigest)
      .toBe(version.contentDigest)
    await second.database.close()
  })

  it('attaches a new occurrence once and never creates a duplicate Experience', async () => {
    const state = await open(await temporaryPath())
    const firstGroup = suggestionGroup('first')
    const first = await state.repository.saveExperienceSuggestion(
      saveInput(firstGroup, 10), firstGroup, state.actor, 16_384,
    )
    const secondSource = source('second')
    const secondGroup = suggestionGroup('second', secondSource)
    const secondInput = saveInput(secondGroup, 11)

    const attached = await state.repository.saveExperienceSuggestion(
      secondInput, secondGroup, state.actor, 16_384,
    )
    const repeated = await state.repository.saveExperienceSuggestion(
      saveInput(secondGroup, 12), secondGroup, state.actor, 16_384,
    )

    expect(attached).toMatchObject({
      outcome: 'attached_as_evidence',
      experienceId: first.experienceId,
      experienceVersionId: first.experienceVersionId,
    })
    expect(repeated).toMatchObject({
      outcome: 'already_recorded',
      experienceId: first.experienceId,
      evidenceIds: attached.evidenceIds,
      assessmentId: attached.assessmentId,
    })
    expect(count(state.database, 'experience_series')).toBe(1)
    expect(attached.evidenceIds).toHaveLength(evidenceComponentCount(secondGroup))
    expect(count(state.database, 'evidence_statements'))
      .toBe(evidenceComponentCount(firstGroup) + evidenceComponentCount(secondGroup))
    expect(count(state.database, 'evidence_assessments')).toBe(2)
    expect(await state.repository.saveExperienceSuggestion(
      secondInput, secondGroup, state.actor, 16_384,
    )).toEqual(attached)
    await expect(state.repository.saveExperienceSuggestion(
      { ...secondInput, sourceDigest: `sha256:${'f'.repeat(64)}` }, secondGroup, state.actor, 16_384,
    )).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await state.database.close()
  })

  it('attaches a reviewed semantic paraphrase to its bound canonical Version', async () => {
    const state = await open(await temporaryPath())
    const original = suggestionGroup('semantic-original')
    const saved = await state.repository.saveExperienceSuggestion(
      saveInput(original, 13), original, state.actor, 16_384,
    )
    const targetVersion = state.repository.getVersion(saved.experienceVersionId, state.actor)
    const paraphrase = semanticDuplicateGroup('semantic-paraphrase', saved, targetVersion)

    const attached = await state.repository.saveExperienceSuggestion(
      saveInput(paraphrase, 14), paraphrase, state.actor, 16_384,
    )

    expect(attached).toMatchObject({
      outcome: 'attached_as_evidence',
      experienceId: saved.experienceId,
      experienceVersionId: saved.experienceVersionId,
    })
    expect(state.repository.getStatus(state.actor).versionCount).toBe(1)
    expect(count(state.database, 'experience_series')).toBe(1)
    assertExperienceStoreInvariants(state.database.handle)
    await state.database.close()
  })

  it('binds semantic suggestion evidence to each mapped canonical component', async () => {
    const state = await open(await temporaryPath())
    const original = suggestionGroup('semantic-component-original')
    const saved = await state.repository.saveExperienceSuggestion(
      saveInput(original, 15), original, state.actor, 16_384,
    )
    const targetVersion = state.repository.getVersion(saved.experienceVersionId, state.actor)
    const base = semanticDuplicateGroup('semantic-component-paraphrase', saved, targetVersion)
    const componentSources = base.draft.components.map((_, index) => source(`semantic-component-${index}`))
    const paraphrase = withDecisionDigests({
      ...base,
      draft: {
        ...base.draft,
        components: base.draft.components.map((component, index) => ({
          ...component,
          sourceRefs: [componentSources[index]!.sourceRefId],
        })),
      },
      occurrences: base.occurrences.map(occurrence => ({
        ...occurrence,
        sourceRefs: [...occurrence.sourceRefs, ...componentSources],
      })),
    })

    const attached = await state.repository.saveExperienceSuggestion(
      saveInput(paraphrase, 16), paraphrase, state.actor, 16_384,
    )

    expect(attached.outcome).toBe('attached_as_evidence')
    const evidenceComponents = paraphrase.draft.components.filter(component =>
      suggestionEvidenceSourceRefsForComponent(component).length > 0)
    expect(attached.evidenceIds).toHaveLength(evidenceComponents.length)
    const attachedRows = state.database.handle.prepare(
      `SELECT component_revision_id, source_refs_json FROM evidence_statements
        WHERE source_refs_json LIKE '%source:semantic-component-%'
        ORDER BY source_refs_json`,
    ).all() as Array<{ component_revision_id: string; source_refs_json: string }>
    expect(attachedRows).toHaveLength(evidenceComponents.length)
    for (const incoming of evidenceComponents) {
      const index = paraphrase.draft.components.indexOf(incoming)
      const target = targetVersion.components.find(component => component.role === incoming.role)!
      expect(attachedRows).toContainEqual({
        component_revision_id: target.componentRevisionId,
        source_refs_json: JSON.stringify([componentSources[index]!.sourceRefId]),
      })
    }
    expect(new Set(attachedRows.map(row => row.component_revision_id)).size)
      .toBe(evidenceComponents.length)
    assertExperienceStoreInvariants(state.database.handle)
    await state.database.close()
  })

  it('fails closed when the active comparison set changes after semantic review', async () => {
    const state = await open(await temporaryPath())
    const original = suggestionGroup('semantic-stale-original')
    const saved = await state.repository.saveExperienceSuggestion(
      saveInput(original, 17), original, state.actor, 16_384,
    )
    const targetVersion = state.repository.getVersion(saved.experienceVersionId, state.actor)
    const reviewed = semanticDuplicateGroup('semantic-stale-reviewed', saved, targetVersion)
    const extraBase = suggestionGroup('semantic-stale-extra', source('semantic-stale-extra'))
    const extraDraft = {
      ...extraBase.draft,
      components: extraBase.draft.components.map(component => component.role === 'symptom_signature'
        ? { ...component, content: '另一个确定不同的诊断症状' }
        : component),
    }
    const extraKernel = experienceKernelIdentity({
      kind: extraDraft.proposedKind, scope: extraDraft.scope, components: extraDraft.components,
    })
    const extra = withDecisionDigests({
      ...extraBase,
      suggestionGroupId: `suggestion-group:${extraKernel.slice('sha256:'.length)}`,
      kernelIdentity: extraKernel,
      draft: extraDraft,
    })
    await state.repository.saveExperienceSuggestion(saveInput(extra, 18), extra, state.actor, 16_384)

    await expect(state.repository.saveExperienceSuggestion(
      saveInput(reviewed, 19), reviewed, state.actor, 16_384,
    )).rejects.toMatchObject({ code: 'stale_revision' })
    expect(count(state.database, 'experience_series')).toBe(2)
    expect(count(state.database, 'evidence_statements'))
      .toBe(evidenceComponentCount(original) + evidenceComponentCount(extra))
    await state.database.close()
  })

  it('never lets a semantic target bypass the active exact-kernel owner', async () => {
    const state = await open(await temporaryPath())
    const exact = suggestionGroup('semantic-target-exact')
    const exactReceipt = await state.repository.saveExperienceSuggestion(
      saveInput(exact, 25), exact, state.actor, 16_384,
    )
    const otherBase = suggestionGroup('semantic-target-other', source('semantic-target-other'))
    const otherDraft = {
      ...otherBase.draft,
      components: otherBase.draft.components.map(component => component.role === 'symptom_signature'
        ? { ...component, content: '另一个已发布诊断目标' }
        : component),
    }
    const otherKernel = experienceKernelIdentity({
      kind: otherDraft.proposedKind, scope: otherDraft.scope, components: otherDraft.components,
    })
    const other = withDecisionDigests({
      ...otherBase,
      suggestionGroupId: `suggestion-group:${otherKernel.slice('sha256:'.length)}`,
      kernelIdentity: otherKernel,
      draft: otherDraft,
    })
    const otherReceipt = await state.repository.saveExperienceSuggestion(
      saveInput(other, 26), other, state.actor, 16_384,
    )
    const otherVersion = state.repository.getVersion(otherReceipt.experienceVersionId, state.actor)
    const incoming = suggestionGroup('semantic-target-incoming', source('semantic-target-incoming'))
    const semanticBase = semanticDuplicateGroup('semantic-target-semantic', otherReceipt, otherVersion)
    const semantic = withDecisionDigests({
      ...semanticBase,
      suggestionGroupId: incoming.suggestionGroupId,
      kernelIdentity: incoming.kernelIdentity,
      sourceDigest: incoming.sourceDigest,
      draft: incoming.draft,
      occurrences: incoming.occurrences,
      occurrenceCount: incoming.occurrenceCount,
      sessionIds: incoming.sessionIds,
      consolidationDetail: {
        ...semanticBase.consolidationDetail!,
        sourceSuggestionGroupIds: [incoming.suggestionGroupId],
        sourceGroups: [{
          suggestionGroupId: incoming.suggestionGroupId,
          kernelIdentity: incoming.kernelIdentity,
          revisionDigest: incoming.revisionDigest,
          occurrenceIds: incoming.occurrences.map(occurrence => occurrence.occurrenceId),
        }],
        activeComparisonSetDigest: experienceComparisonSetDigest(
          { kind: incoming.kind, scope: incoming.draft.scope },
          [state.repository.getVersion(exactReceipt.experienceVersionId, state.actor), otherVersion],
        ),
        componentCorrespondence: incoming.draft.components.map(component => {
          const target = otherVersion.components.find(candidate => candidate.role === component.role)!
          return {
            incomingSuggestionGroupId: incoming.suggestionGroupId,
            incomingComponentKey: component.componentKey,
            incomingRole: component.role,
            incomingContentDigest: suggestionDigest(normalizeKernelText(component.content)),
            targetComponentKey: target.componentKey,
            targetComponentRevisionId: target.componentRevisionId,
            targetRole: target.role,
            targetContentDigest: suggestionDigest(normalizeKernelText(target.content)),
            matchBasis: normalizeKernelText(component.content) === normalizeKernelText(target.content)
              ? 'exact' as const : 'semantic' as const,
          }
        }),
      },
    })

    await expect(state.repository.saveExperienceSuggestion(
      saveInput(semantic, 27), semantic, state.actor, 16_384,
    )).rejects.toMatchObject({ code: 'experience_duplicate' })
    expect(count(state.database, 'experience_series')).toBe(2)
    await state.database.close()
  })

  it('rejects a semantic component mapping that no longer names the reviewed target content', async () => {
    const state = await open(await temporaryPath())
    const original = suggestionGroup('semantic-mapping-original')
    const saved = await state.repository.saveExperienceSuggestion(
      saveInput(original, 28), original, state.actor, 16_384,
    )
    const target = state.repository.getVersion(saved.experienceVersionId, state.actor)
    const reviewed = semanticDuplicateGroup('semantic-mapping-reviewed', saved, target)
    const corrupted = withDecisionDigests({
      ...reviewed,
      consolidationDetail: {
        ...reviewed.consolidationDetail!,
        componentCorrespondence: reviewed.consolidationDetail!.componentCorrespondence.map((mapping, index) =>
          index === 0 ? { ...mapping, targetContentDigest: suggestionDigest('stale target content') } : mapping),
      },
    })

    await expect(state.repository.saveExperienceSuggestion(
      saveInput(corrupted, 29), corrupted, state.actor, 16_384,
    )).rejects.toMatchObject({ code: 'stale_revision' })
    expect(count(state.database, 'evidence_statements')).toBe(evidenceComponentCount(original))
    await state.database.close()
  })

  it('serializes comparison-bound semantic creations so only one stale-empty snapshot can commit', async () => {
    const path = await temporaryPath()
    const first = await open(path)
    const second = await open(path)
    const left = comparisonBoundGroup('semantic-concurrent-left', '插件宿主能否运行当前扩展')
    const right = comparisonBoundGroup('semantic-concurrent-right', '当前环境是否具备扩展运行条件')

    const results = await Promise.allSettled([
      first.repository.saveExperienceSuggestion(saveInput(left, 20), left, first.actor, 16_384),
      second.repository.saveExperienceSuggestion(saveInput(right, 21), right, second.actor, 16_384),
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: 'stale_revision' })
    expect(count(first.database, 'experience_series')).toBe(1)
    assertExperienceStoreInvariants(first.database.handle)
    await Promise.all([first.database.close(), second.database.close()])
  })

  it('serializes concurrent saves from two database connections into one Experience and one evidence set', async () => {
    const path = await temporaryPath()
    const first = await open(path)
    const second = await open(path)
    const group = suggestionGroup('concurrent')

    const receipts = await Promise.all([
      first.repository.saveExperienceSuggestion(saveInput(group, 20), group, first.actor, 16_384),
      second.repository.saveExperienceSuggestion(saveInput(group, 21), group, second.actor, 16_384),
    ])

    expect(receipts.map(receipt => receipt.outcome).sort())
      .toEqual(['already_recorded', 'saved_new_experience'])
    expect(new Set(receipts.map(receipt => receipt.experienceId)).size).toBe(1)
    expect(count(first.database, 'experience_series')).toBe(1)
    expect(count(first.database, 'evidence_statements')).toBe(evidenceComponentCount(group))
    expect(count(first.database, 'evidence_assessments')).toBe(1)
    assertExperienceStoreInvariants(first.database.handle)
    await Promise.all([first.database.close(), second.database.close()])
  })

  it('rejects an exact-kernel component conflict without writing Evidence or another Series', async () => {
    const state = await open(await temporaryPath())
    const fact = (label: string, value: string) => materializeSuggestionGroups([
      semanticSeed(label, 'fact', '读取当前工作区 Node 版本。', factEvidence('node --version', JSON.stringify({ experienceFact: {
        subject: 'workspace runtime', predicate: 'node version', value,
        observedAt: '2099-01-01T00:00:00.000Z', validUntil: '2099-02-01T00:00:00.000Z',
        sourceAuthority: 'node --version',
      } }))),
    ], 16_384)[0]!
    const original = fact('exact-conflict-original', 'v22.23.1')
    const conflicting = fact('exact-conflict-new', 'v24.0.0')
    expect(conflicting.kernelIdentity).toBe(original.kernelIdentity)
    await state.repository.saveExperienceSuggestion(saveInput(original, 22), original, state.actor, 16_384)
    const evidenceBefore = count(state.database, 'evidence_statements')

    await expect(state.repository.saveExperienceSuggestion(
      saveInput(conflicting, 23), conflicting, state.actor, 16_384,
    )).rejects.toMatchObject({ code: 'experience_duplicate' })
    expect(count(state.database, 'experience_series')).toBe(1)
    expect(count(state.database, 'evidence_statements')).toBe(evidenceBefore)
    await state.database.close()
  })

  it('normalizes a legacy suggestion receipt to its single source group on readback', async () => {
    const state = await open(await temporaryPath())
    const group = suggestionGroup('legacy-receipt')
    const receipt = await state.repository.saveExperienceSuggestion(
      saveInput(group, 24), group, state.actor, 16_384,
    )
    const row = state.database.handle.prepare(
      'SELECT payload_json FROM domain_receipts WHERE receipt_id = ?',
    ).get(receipt.receiptId) as { payload_json: string }
    const legacy = JSON.parse(row.payload_json) as Record<string, unknown>
    delete legacy.sourceSuggestionGroupIds
    state.database.handle.prepare('UPDATE domain_receipts SET payload_json = ? WHERE receipt_id = ?')
      .run(JSON.stringify(legacy), receipt.receiptId)

    expect(state.repository.getReceipt(receipt.receiptId, state.actor)).toMatchObject({
      action: 'suggestion.save',
      sourceSuggestionGroupIds: [group.suggestionGroupId],
    })
    await state.database.close()
  })

  it('fails closed on stale, expired, unreviewed, and ordinary Candidate duplicate writes', async () => {
    const state = await open(await temporaryPath())
    const group = suggestionGroup('guard')
    await expect(state.repository.saveExperienceSuggestion(
      { ...saveInput(group, 30), expectedRevisionDigest: `sha256:${'e'.repeat(64)}` },
      group,
      state.actor,
      16_384,
    )).rejects.toMatchObject({ code: 'stale_revision' })
    const possibleDuplicate = withDecisionDigests({ ...group, consolidation: 'possible_duplicate' as const })
    await expect(state.repository.saveExperienceSuggestion(
      saveInput(possibleDuplicate, 31),
      possibleDuplicate,
      state.actor,
      16_384,
    )).rejects.toMatchObject({ code: 'invalid_command' })
    const expired = withDecisionDigests({ ...group, expiresAt: '2000-01-01T00:00:00.000Z' })
    await expect(state.repository.saveExperienceSuggestion(
      saveInput(expired, 32), expired, state.actor, 16_384,
    )).rejects.toMatchObject({ code: 'stale_revision' })

    await state.repository.saveExperienceSuggestion(saveInput(group, 33), group, state.actor, 16_384)
    const prepared = await prepareAcceptedWorkflow(state.repository, state.actor, 34, group.draft)
    await expect(state.repository.publishCandidate(
      workflowCommand(prepared.candidate, 9, 34), state.actor, 16_384,
    )).rejects.toMatchObject({
      code: 'experience_duplicate',
      details: { kernelIdentity: group.kernelIdentity },
    })
    expect(state.repository.getCandidate(prepared.candidate.candidateId, state.actor).state).toBe('accepted')
    expect(count(state.database, 'experience_series')).toBe(1)
    await state.database.close()
  })

  it('saves and projects complete Preference and Fact suggestions through the same canonical transaction', async () => {
    const state = await open(await temporaryPath())
    const preference = materializeSuggestionGroups([
      semanticSeed('preference', 'preference_policy',
        '以后在中文技术回答中，必须优先使用中文，除非我明确要求英文。'),
    ], 16_384)[0]!
    const factEnvelope = JSON.stringify({ experienceFact: {
      subject: 'workspace runtime', predicate: 'node version', value: 'v22.23.1',
      observedAt: '2099-01-01T00:00:00.000Z', validUntil: '2099-02-01T00:00:00.000Z',
      sourceAuthority: 'node --version',
    } })
    const fact = materializeSuggestionGroups([
      semanticSeed('fact', 'fact', '读取当前工作区 Node 版本。', factEvidence('node --version', factEnvelope)),
    ], 16_384)[0]!

    expect(preference.saveReadiness).toBe('ready')
    expect(fact.saveReadiness).toBe('ready')
    const preferenceReceipt = await state.repository.saveExperienceSuggestion(
      saveInput(preference, 40), preference, state.actor, 16_384,
    )
    const factReceipt = await state.repository.saveExperienceSuggestion(
      saveInput(fact, 41), fact, state.actor, 16_384,
    )
    const preferenceVersion = state.repository.getVersion(preferenceReceipt.experienceVersionId, state.actor)
    const factVersion = state.repository.getVersion(factReceipt.experienceVersionId, state.actor)

    expect(preferenceVersion.kind).toBe('preference_policy')
    expect(factVersion.kind).toBe('fact')
    expect(projectExperienceVersion(preferenceVersion).fields.artifactsOrEntities.join(' ')).toContain('中文技术回答')
    expect(projectExperienceVersion(factVersion).fields.artifactsOrEntities.join(' ')).toContain('workspace runtime')
    expect(count(state.database, 'experience_series')).toBe(2)
    assertExperienceStoreInvariants(state.database.handle)
    await state.database.close()
  })

  it('rejects a Fact whose authoritative freshness window expired before the canonical save', async () => {
    const state = await open(await temporaryPath())
    const group = materializeSuggestionGroups([
      semanticSeed('expired-fact', 'fact', '读取当前工作区 Node 版本。', factEvidence('node --version', JSON.stringify({ experienceFact: {
        subject: 'workspace runtime', predicate: 'node version', value: 'v22.23.1',
        observedAt: '2026-09-09T00:00:00.000Z', validUntil: '2026-09-10T00:00:00.000Z',
        sourceAuthority: 'node --version',
      } }))),
    ], 16_384)[0]!

    expect(group.saveReadiness).toBe('ready')
    await expect(state.repository.saveExperienceSuggestion(
      saveInput(group, 42), group, state.actor, 16_384,
    )).rejects.toMatchObject({ code: 'stale_revision' })
    expect(count(state.database, 'experience_series')).toBe(0)
    await state.database.close()
  })
})

function suggestionGroup(label: string, exactSource = sourceRef): ExperienceSuggestionGroupView {
  const draft = workflowDraft({
    components: workflowDraft().components.map(component => ({
      ...component,
      sourceRefs: [exactSource.sourceRefId],
    })),
    fieldSourceRefs: Object.fromEntries(Object.entries(workflowDraft().fieldSourceRefs)
      .map(([field]) => [field, [exactSource.sourceRefId]])),
    excludedSteps: workflowDraft().excludedSteps.map(step => ({
      ...step,
      sourceRefs: [exactSource.sourceRefId],
    })),
  })
  const kernelIdentity = experienceKernelIdentity({
    kind: draft.proposedKind,
    scope: draft.scope,
    components: draft.components,
  })
  const sourceDigest = suggestionDigest([exactSource.contentDigest])
  const base: ExperienceSuggestionGroupView = {
    suggestionGroupId: `suggestion-group:${kernelIdentity.slice('sha256:'.length)}`,
    kernelIdentity,
    revisionDigest: '',
    sourceDigest,
    kind: 'diagnostic',
    title: draft.title,
    draft,
    saveReadiness: 'ready',
    readinessReasons: [],
    missingFields: [],
    riskFlags: ['current_permission_required', 'tool_side_effects_not_authorized'],
    reviewDigest: null,
    consolidation: 'distinct',
    relatedGroupIds: [],
    occurrences: [{
      occurrenceId: `occurrence:${label}`,
      seedOccurrenceId: `seed:${label}`,
      sessionId: `session:${label}`,
      episodeRef: { ...episodeRef, episodeRefId: `episode:${label}` as never, sessionOrRunId: `session:${label}` },
      sourceRefs: [exactSource],
      detectedAt: '2099-01-01T00:00:00.000Z',
      expiresAt: '2099-01-15T00:00:00.000Z',
    }],
    occurrenceCount: 1,
    sessionIds: [`session:${label}`],
    crossSession: false,
    detectorVersions: ['detector-v1'],
    segmenterVersions: ['segmenter-v1'],
    materializerVersion: 'materializer-v1',
    expiresAt: '2099-01-15T00:00:00.000Z',
  }
  return withDecisionDigests(base)
}

function semanticSeed(
  label: string,
  kind: ExperienceSuggestionSeedView['suggestedKinds'][number],
  goal: string,
  factEnvelope?: string,
): ExperienceSuggestionSeedView {
  const userSource = source(`${label}:user`)
  const factSource = factEnvelope === undefined ? null : source(`${label}:fact`)
  return {
    occurrenceId: `seed:${label}`,
    sessionId: `session:${label}`,
    workspaceRoot: '/workspace/shared',
    episodeRef: { ...episodeRef, episodeRefId: `episode:${label}` as never, sessionOrRunId: `session:${label}` },
    suggestedKinds: [kind],
    triggerKind: kind === 'preference_policy' ? 'explicit_user_directive' : 'authoritative_fact',
    stableKernel: {
      taskGoal: goal, toolSequence: [], failedToolSequence: [], recoveryToolSequence: [],
      failureCodes: [], verifierTools: [],
    },
    evidenceSignals: [{
      itemId: `item:${label}:user`, sourceRef: userSource, eventType: 'user/message',
      role: 'user_goal', evidenceClass: 'user_instruction', content: goal,
      projectionDigest: suggestionDigest(goal), projectionTruncated: false,
    }, ...(factSource === null || factEnvelope === undefined ? [] : [{
      itemId: `item:${label}:fact`, sourceRef: factSource, eventType: 'tool/result' as const,
      role: 'tool_observation' as const, evidenceClass: 'observed_fact' as const, content: factEnvelope,
      projectionDigest: suggestionDigest(factEnvelope), projectionTruncated: false,
    }])],
    detectorVersion: 'six-kind-evidence-detector-v3',
    segmenterVersion: 'session-turn-segmenter-v1',
    detectedAt: '2099-01-01T00:00:00.000Z',
    expiresAt: '2099-01-15T00:00:00.000Z',
  }
}

function semanticDuplicateGroup(
  label: string,
  target: Awaited<ReturnType<ExperienceRepository['saveExperienceSuggestion']>>,
  targetVersion: ExperienceVersionView,
): ExperienceSuggestionGroupView {
  const base = suggestionGroup(label, source(label))
  const draft = workflowDraft({
    title: '同义改写后的排错目标',
    intent: '用另一种说法完成相同排错目标',
    fieldSourceRefs: base.draft.fieldSourceRefs,
    excludedSteps: base.draft.excludedSteps,
    components: base.draft.components.map(component => component.role === 'symptom_signature'
      ? { ...component, content: '同义改写后的症状描述' }
      : component),
  })
  const kernelIdentity = experienceKernelIdentity({
    kind: draft.proposedKind, scope: draft.scope, components: draft.components,
  })
  const suggestionGroupId = `suggestion-group:${kernelIdentity.slice('sha256:'.length)}`
  const group: ExperienceSuggestionGroupView = {
    ...base,
    suggestionGroupId,
    kernelIdentity,
    title: draft.title,
    draft,
    consolidation: 'semantic_duplicate',
    canonicalMatch: {
      experienceId: target.experienceId,
      experienceVersionId: target.experienceVersionId,
      versionContentDigest: targetVersion.contentDigest,
      title: 'Verified Web startup diagnostic',
      intent: 'Reuse the verified startup diagnosis without repeating exploration.',
      similarity: 0.97,
      retrievalGeneration: 2,
      modelId: 'test/e5',
      modelRevision: 'r1',
    },
    consolidationDetail: {
      algorithmVersion: 'experience-equivalence-v1',
      decision: 'same',
      reasonCodes: ['component_correspondence_complete'],
      sourceSuggestionGroupIds: [suggestionGroupId],
      sourceGroups: [{
        suggestionGroupId,
        kernelIdentity,
        revisionDigest: base.revisionDigest,
        occurrenceIds: base.occurrences.map(occurrence => occurrence.occurrenceId),
      }],
      targetExperienceId: target.experienceId,
      targetExperienceVersionId: target.experienceVersionId,
      targetVersionContentDigest: targetVersion.contentDigest,
      retrievalGeneration: 2,
      modelIdentityDigest: suggestionDigest({ model: 'test/e5', revision: 'r1' }),
      operationSettingsDigest: suggestionDigest({ settings: 'test' }),
      activeComparisonSetDigest: experienceComparisonSetDigest({ kind: draft.proposedKind, scope: draft.scope }, [targetVersion]),
      allowedOwnerChoices: [],
      componentCorrespondence: draft.components.map(component => {
        const existing = targetVersion.components.find(targetComponent => targetComponent.role === component.role)!
        return {
          incomingSuggestionGroupId: suggestionGroupId,
          incomingComponentKey: component.componentKey,
          incomingRole: component.role,
          incomingContentDigest: suggestionDigest(component.content),
          targetComponentKey: existing.componentKey,
          targetComponentRevisionId: existing.componentRevisionId,
          targetRole: existing.role,
          targetContentDigest: suggestionDigest(existing.content),
          matchBasis: component.role === 'symptom_signature' ? 'semantic' as const : 'exact' as const,
        }
      }),
      materialDifferences: [],
    },
  }
  const targetVersionId = target.experienceVersionId
  return withDecisionDigests({
    ...group,
    canonicalMatch: {
      ...group.canonicalMatch!,
      experienceVersionId: targetVersionId,
    },
  })
}

function comparisonBoundGroup(label: string, symptom: string): ExperienceSuggestionGroupView {
  const base = suggestionGroup(label, source(label))
  const draft = {
    ...base.draft,
    components: base.draft.components.map(component => component.role === 'symptom_signature'
      ? { ...component, content: symptom }
      : component),
  }
  const kernelIdentity = experienceKernelIdentity({
    kind: draft.proposedKind, scope: draft.scope, components: draft.components,
  })
  const suggestionGroupId = `suggestion-group:${kernelIdentity.slice('sha256:'.length)}`
  const group = {
    ...base,
    suggestionGroupId,
    kernelIdentity,
    draft,
    consolidation: 'semantic_consolidated' as const,
    consolidationDetail: {
      algorithmVersion: 'experience-equivalence-v1' as const,
      decision: 'same' as const,
      reasonCodes: ['recent_component_correspondence_complete'],
      sourceSuggestionGroupIds: [suggestionGroupId],
      sourceGroups: [{
        suggestionGroupId,
        kernelIdentity,
        revisionDigest: base.revisionDigest,
        occurrenceIds: base.occurrences.map(occurrence => occurrence.occurrenceId),
      }],
      targetExperienceId: null,
      targetExperienceVersionId: null,
      targetVersionContentDigest: null,
      retrievalGeneration: 1,
      modelIdentityDigest: suggestionDigest({ model: 'test/e5', revision: 'r1' }),
      operationSettingsDigest: suggestionDigest({ settings: 'test' }),
      activeComparisonSetDigest: experienceComparisonSetDigest({ kind: base.kind, scope: base.draft.scope }, []),
      allowedOwnerChoices: [],
      componentCorrespondence: draft.components.map(component => ({
        incomingSuggestionGroupId: suggestionGroupId,
        incomingComponentKey: component.componentKey,
        incomingRole: component.role,
        incomingContentDigest: suggestionDigest(normalizeKernelText(component.content)),
        targetComponentKey: component.componentKey,
        targetComponentRevisionId: null,
        targetRole: component.role,
        targetContentDigest: suggestionDigest(normalizeKernelText(component.content)),
        matchBasis: 'exact' as const,
      })),
      materialDifferences: [],
    },
  }
  return withDecisionDigests(group)
}

function factEvidence(command: string, envelope: string): string {
  return `bash\n${JSON.stringify({ command })}\n\n${envelope}`
}

function withDecisionDigests(group: ExperienceSuggestionGroupView): ExperienceSuggestionGroupView {
  return { ...group, ...suggestionDecisionDigests(group) }
}

function evidenceComponentCount(group: ExperienceSuggestionGroupView): number {
  return group.draft.components.filter(component =>
    suggestionEvidenceSourceRefsForComponent(component).length > 0).length
}

function saveInput(group: ExperienceSuggestionGroupView, sequence: number): SaveExperienceSuggestionInput {
  return {
    commandId: brandedId<'ExperienceCommandId'>(
      `30000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
      'commandId',
    ),
    suggestionGroupId: group.suggestionGroupId,
    expectedRevisionDigest: group.revisionDigest,
    reviewDigest: group.reviewDigest ?? `sha256:${'0'.repeat(64)}`,
    sourceDigest: group.sourceDigest,
    correlationId: `suggestion-save-${String(sequence)}`,
    causationId: null,
    issuedAt: '2099-01-01T00:01:00.000Z',
  }
}

function source(label: string): SourceRefView {
  return {
    ...sourceRef,
    sourceRefId: `source:${label}` as never,
    locator: `dsh-session:${label}#1`,
    ownerScope: `session:${label}`,
    contentDigest: `sha256:${label}`,
  }
}

async function open(path: string): Promise<{
  readonly database: ExperienceDatabase
  readonly repository: ExperienceRepository
  readonly actor: ActorView
}> {
  const database = await ExperienceDatabase.open(config(path))
  const repository = new ExperienceRepository(database)
  const principal = await repository.initializePrincipal()
  return {
    database,
    repository,
    actor: new ActorResolver(principal).resolve({ kind: 'management-cli' }),
  }
}

function count(database: ExperienceDatabase, table: string): number {
  return (database.handle.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count
}

function config(databasePath: string): DatabaseConfig {
  return { databasePath, journalMode: 'wal', synchronous: 'normal', busyTimeoutMs: 2_000, maxPendingWrites: 16 }
}

async function temporaryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'experience-map-suggestion-save-'))
  cleanup.push(directory)
  return join(directory, 'experience.sqlite')
}
