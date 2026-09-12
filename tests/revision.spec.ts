import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { digest } from '../src/domain/planning.js'
import { brandedId } from '../src/ids.js'
import type { CriterionVerificationView, VerificationRunView } from '../src/types.js'
import { WEB_USAGE_CRITERIA } from '../src/adapters/web-verifier.js'
import { createM5Fixture, envelope } from './fixtures/m5-usage.js'

const cleanup: Array<{ directory: string; close(): Promise<void> }> = []

afterEach(async () => {
  for (const fixture of cleanup.splice(0)) {
    await fixture.close()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

describe('M5 minimal Experience revision', () => {
  it('replaces only invalidated verifier or Condition components and publishes immutable Version 2', async () => {
    const fixture = await staleSettledFixture()
    const proposeInput = {
      ...envelope(), usageId: fixture.progress.usageId,
      baseVersionId: fixture.baseVersion.experienceVersionId,
    }
    const proposedReceipt = await fixture.repository.proposeRevision(proposeInput, fixture.owner)
    expect(proposedReceipt.action).toBe('revision.propose')
    const proposal = fixture.repository.getRevisionProposal(proposedReceipt.revisionProposalId!, fixture.owner)
    expect(proposal.diagnosis.classification).toBe('auth_contract_changed')
    expect(proposal.changes.length).toBeGreaterThan(0)
    expect(proposal.changes.every(change =>
      change.semanticRole === 'environment_scope' || change.semanticRole === 'recovery_verifier')).toBe(true)
    const unchangedBefore = fixture.baseVersion.components.filter(component =>
      !proposal.changes.some(change => change.componentId === component.componentId))
    let reviewed = proposal
    for (const change of proposal.changes) {
      const receipt = await fixture.repository.decideRevisionChange({
        ...envelope(), revisionProposalId: reviewed.revisionProposalId,
        expectedRevision: reviewed.revision, revisionChangeId: change.revisionChangeId,
        decision: 'accept', reason: 'verified against current Web authority',
      }, fixture.owner)
      reviewed = fixture.repository.getRevisionProposal(receipt.revisionProposalId!, fixture.owner)
    }
    expect(reviewed.state).toBe('accepted')
    const publishInput = {
      ...envelope(), revisionProposalId: reviewed.revisionProposalId,
      expectedRevision: reviewed.revision,
    }
    const receipt = await fixture.repository.publishRevision(publishInput, fixture.owner)
    expect(receipt).toMatchObject({ action: 'revision.publish', experienceVersionId: expect.any(String) })
    const version2 = fixture.repository.getVersion(receipt.experienceVersionId!, fixture.owner)
    expect(version2).toMatchObject({
      versionNumber: 2, operationalState: 'conditional',
      previousVersionId: fixture.baseVersion.experienceVersionId,
    })
    expect(unchangedBefore.every(component => version2.componentRevisionIds.includes(component.componentRevisionId))).toBe(true)
    expect(fixture.repository.getVersion(fixture.baseVersion.experienceVersionId, fixture.owner)).toEqual(fixture.baseVersion)
    const series = fixture.database.handle.prepare(
      'SELECT current_version_id, series_revision FROM experience_series WHERE experience_id = ?',
    ).get(fixture.baseVersion.experienceId) as { current_version_id: string; series_revision: number }
    expect(series).toEqual({ current_version_id: receipt.experienceVersionId, series_revision: 2 })
    const planningVersions = fixture.repository.listPlanningVersions(fixture.owner, 32)
    expect(planningVersions.map(version => version.experienceVersionId)).toContain(receipt.experienceVersionId)
    expect(planningVersions.map(version => version.experienceVersionId)).not.toContain(
      fixture.baseVersion.experienceVersionId,
    )
    expect(fixture.database.handle.prepare(
      "SELECT topic FROM outbox_entries WHERE topic = 'experience.version.published' ORDER BY rowid DESC LIMIT 1",
    ).get()).toEqual({ topic: 'experience.version.published' })
    expect(await fixture.repository.publishRevision(publishInput, fixture.owner)).toEqual(receipt)
    const row = fixture.database.handle.prepare(
      'SELECT payload_json FROM experience_versions WHERE experience_version_id = ?',
    ).get(receipt.experienceVersionId) as { payload_json: string }
    const corrupted = { ...JSON.parse(row.payload_json) as Record<string, unknown>, previousVersionId: null }
    fixture.database.handle.prepare(
      'UPDATE experience_versions SET payload_json = ? WHERE experience_version_id = ?',
    ).run(JSON.stringify(corrupted), receipt.experienceVersionId)
    expect(() => fixture.repository.getVersion(receipt.experienceVersionId!, fixture.owner))
      .toThrow('ExperienceVersion durable JSON is invalid')
  })

  it('does not publish after any proposed replacement is rejected', async () => {
    const fixture = await staleSettledFixture()
    const proposed = await fixture.repository.proposeRevision({
      ...envelope(), usageId: fixture.progress.usageId,
      baseVersionId: fixture.baseVersion.experienceVersionId,
    }, fixture.owner)
    let proposal = fixture.repository.getRevisionProposal(proposed.revisionProposalId!, fixture.owner)
    for (const [index, change] of proposal.changes.entries()) {
      const receipt = await fixture.repository.decideRevisionChange({
        ...envelope(), revisionProposalId: proposal.revisionProposalId,
        expectedRevision: proposal.revision, revisionChangeId: change.revisionChangeId,
        decision: index === 0 ? 'reject' : 'accept', reason: 'explicit owner decision',
      }, fixture.owner)
      proposal = fixture.repository.getRevisionProposal(receipt.revisionProposalId!, fixture.owner)
    }
    expect(proposal.state).toBe('rejected')
    await expect(fixture.repository.publishRevision({
      ...envelope(), revisionProposalId: proposal.revisionProposalId, expectedRevision: proposal.revision,
    }, fixture.owner)).rejects.toMatchObject({ code: 'invalid_command' })
  })
})

async function staleSettledFixture() {
  const fixture = await createM5Fixture({ stale: true })
  cleanup.push({ directory: fixture.directory, close: () => fixture.database.close() })
  let progress = fixture.progress
  while (progress.state !== 'completed') {
    await fixture.repository.progressUsage({
      ...envelope(), usageId: progress.usageId,
      expectedControllerRevision: progress.controllerRevision,
      action: 'advance', checkpointRef: progress.stepRef, reason: 'step completed',
    }, fixture.owner)
    progress = fixture.repository.getUsageExecution(String(progress.usageId), fixture.owner).progress!
  }
  const verification = run(String(progress.usageId), progress.controllerRevision)
  await fixture.repository.recordVerification({
    ...envelope(), usageId: progress.usageId, expectedControllerRevision: progress.controllerRevision,
  }, verification, fixture.owner)
  await fixture.repository.settleUsage({
    ...envelope(), usageId: progress.usageId,
    expectedControllerRevision: progress.controllerRevision,
    verificationRunId: verification.verificationRunId,
  }, fixture.owner)
  return fixture
}

function run(usageId: string, controllerRevision: number): VerificationRunView {
  return {
    verificationRunId: brandedId<'ExperienceVerificationRunId'>(randomUUID(), 'verificationRunId'),
    usageId: brandedId<'ExperienceUsageId'>(usageId, 'usageId'),
    controllerRevision,
    providerVersion: 'dsh-web-guided-v1',
    criteria: WEB_USAGE_CRITERIA.map(criterion),
    phase: 'complete',
    createdAt: new Date().toISOString(),
  }
}

function criterion(criterionId: CriterionVerificationView['criterionId']): CriterionVerificationView {
  const base = {
    criterionId, mandatory: true as const, result: 'pass' as const,
    observedAt: new Date().toISOString(), boundedValue: { fixture: true },
    sourceRef: `fixture://m5/${criterionId}`, reasonCode: 'fixture_pass',
  }
  return { ...base, integrityDigest: digest(base) }
}
