import { brandedId } from '../../src/ids.js'
import type { ExperienceRepository } from '../../src/persistence/repository.js'
import type {
  ActorView,
  CandidateCommandInput,
  CandidateView,
  ExperienceCandidateDraft,
  DomainReceipt,
} from '../../src/types.js'
import { eligibleExtraction, episodeRef, proposalMetadata, proposeInput, sourceRef, workflowDraft } from './workflow.js'

/** Prepare one fully reviewed Candidate through the public M2 repository workflow. */
export async function prepareAcceptedWorkflow(
  repository: ExperienceRepository,
  actor: ActorView,
  seed = 1,
  draft: ExperienceCandidateDraft = workflowDraft(),
): Promise<{ readonly candidate: CandidateView; readonly proposal: DomainReceipt }> {
  const proposalInput = proposeInput(commandValue(1, seed, 0), draft.proposedKind)
  const proposal = await repository.proposeCandidate(
    proposalInput,
    draft,
    [episodeRef],
    [sourceRef],
    proposalMetadata,
    eligibleExtraction,
    actor,
    16_384,
  )
  let candidate = repository.getCandidate(proposal.candidateId, actor)
  const submitted = await repository.submitCandidate(command(candidate, 2, seed, 0), actor)
  candidate = repository.getCandidate(submitted.candidateId, actor)
  for (const [index, field] of candidate.fields.entries()) {
    const decided = await repository.decideCandidateField({
      ...command(candidate, 3, seed, index),
      field: field.field,
      decision: 'accept',
      reason: 'owner_checked_source',
    }, actor, 16_384)
    candidate = repository.getCandidate(decided.candidateId, actor)
  }
  const accepted = await repository.acceptCandidate(command(candidate, 4, seed, 0), actor, 16_384)
  return { candidate: repository.getCandidate(accepted.candidateId, actor), proposal }
}

/** Publish one fully reviewed Candidate through the sole production publication path. */
export async function publishReviewedWorkflow(
  repository: ExperienceRepository,
  actor: ActorView,
  seed = 1,
  draft: ExperienceCandidateDraft = workflowDraft(),
): Promise<{ readonly candidate: CandidateView; readonly proposal: DomainReceipt; readonly published: DomainReceipt }> {
  const prepared = await prepareAcceptedWorkflow(repository, actor, seed, draft)
  const published = await repository.publishCandidate(command(prepared.candidate, 5, seed, 0), actor, 16_384)
  return { ...prepared, published }
}

/** Build a deterministic command for a prepared Candidate. */
export function workflowCommand(
  candidate: Pick<CandidateView, 'candidateId' | 'candidateRevision'>,
  lane: number,
  seed: number,
  ordinal = 0,
): CandidateCommandInput {
  return command(candidate, lane, seed, ordinal)
}

function command(
  candidate: Pick<CandidateView, 'candidateId' | 'candidateRevision'>,
  lane: number,
  seed: number,
  ordinal: number,
): CandidateCommandInput {
  return {
    commandId: brandedId<'ExperienceCommandId'>(commandValue(lane, seed, ordinal), 'commandId'),
    candidateId: candidate.candidateId,
    expectedRevision: candidate.candidateRevision,
    correlationId: `workflow-${String(seed)}`,
    causationId: null,
    issuedAt: '2026-08-31T09:10:00.000Z',
  }
}

function commandValue(lane: number, seed: number, ordinal: number): string {
  return `${String(lane).padStart(8, '0')}-0000-4000-8000-${String(seed * 1_000 + ordinal).padStart(12, '0')}`
}
