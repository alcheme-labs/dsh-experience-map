import type { HistoricalSource } from '../adapters/historical-source.js'
import type { DiagnosticProposalLlm } from '../adapters/proposal-llm.js'
import type { OutcomeEvidenceSource } from '../adapters/outcome-evidence-source.js'
import type { DshSessionSource } from '../adapters/session-source.js'
import {
  buildExtractionEvidencePacket,
  type ExtractionEvidenceConfig,
} from '../adapters/extraction-evidence.js'
import { ExperienceError } from '../errors.js'
import {
  evaluateExtractionEligibility,
  type ExtractionEligibilityResult,
} from '../domain/extraction-eligibility.js'
import type {
  ActorView,
  DomainReceipt,
  ProposalSourceInspectionInput,
  ProposalSourceInspectionView,
  ProposeCandidateInput,
  ExtractionTriggerKind,
  VerifiedOutcomeManifestConfig,
} from '../types.js'
import { ExperienceRepository, workflowPayloadDigest } from '../persistence/repository.js'
import type { RuntimeSettingsSnapshot } from '../runtime-settings.js'

interface InFlightProposal {
  readonly payloadDigest: string
  readonly promise: Promise<DomainReceipt>
}

interface ProposalSourceLimits {
  readonly maxRecords: number
  readonly maxRecordBytes: number
  readonly maxTotalBytes: number
}

/** Coordinates local source inspection, explicit disclosure, model proposal, and durable commit. */
export class CandidateProposalService {
  private readonly inFlight = new Map<string, InFlightProposal>()

  /** Bind the proposal use case to its source readers, proposer, and canonical repository. */
  constructor(
    private readonly repository: ExperienceRepository,
    private readonly sessions: DshSessionSource,
    private readonly historical: HistoricalSource,
    private readonly outcomeEvidence: OutcomeEvidenceSource,
    private readonly proposer: DiagnosticProposalLlm,
    private readonly maxInlineFieldBytes: number,
    private readonly sourceLimits: ProposalSourceLimits,
    private readonly extractionConfig: ExtractionEvidenceConfig,
    private readonly outcomeManifest?: VerifiedOutcomeManifestConfig,
  ) {}

  /** Inspect exact local sources and disclose the model route without invoking the model. */
  async inspect(
    input: ProposalSourceInspectionInput,
    actor: ActorView,
    signal?: AbortSignal,
    runtime?: RuntimeSettingsSnapshot,
  ): Promise<ProposalSourceInspectionView> {
    requireOwner(actor)
    const { episode, historicalRecords, outcomeRecords, outcomeSourceRefs, records } =
      await this.readSources(input.episode, signal, runtime)
    const eligibility = evaluateExtractionEligibility(
      episode,
      [...historicalRecords.map(record => record.sourceRef), ...outcomeSourceRefs],
      input.requestedTriggerKind,
      this.outcomeManifest,
    )
    const evidencePacket = buildExtractionEvidencePacket(
      [episode.episodeRef], records, runtime?.values ?? this.extractionConfig,
    )
    return {
      requestedKind: input.requestedKind,
      outputTokenLimit: input.outputTokenLimit,
      episode,
      ...eligibility,
      historicalSourceRefs: historicalRecords.map(record => record.sourceRef),
      historicalRecords,
      outcomeRecords,
      outcomeSourceRefs,
      evidencePacket,
      disclosure: await this.proposer.disclosure(
        evidencePacket, input.outputTokenLimit, signal, input.requestedKind, runtime,
      ),
    }
  }

  /** Invoke the proposer only for an exact confirmed disclosure, then persist one Candidate. */
  async propose(
    input: ProposeCandidateInput,
    actor: ActorView,
    signal?: AbortSignal,
    runtime?: RuntimeSettingsSnapshot,
  ): Promise<DomainReceipt> {
    requireOwner(actor)
    const payloadDigest = workflowPayloadDigest('candidate.propose', actor, input)
    const committed = this.repository.findCommandReceipt(input.commandId, payloadDigest, actor)
    if (committed !== null) return committed
    const active = this.inFlight.get(input.commandId)
    if (active !== undefined) {
      if (active.payloadDigest !== payloadDigest) {
        throw new ExperienceError('idempotency_conflict', 'CommandId is already proposing a different payload')
      }
      return active.promise
    }
    const promise = this.runProposal(input, actor, signal, runtime)
    this.inFlight.set(input.commandId, { payloadDigest, promise })
    try {
      return await promise
    } finally {
      if (this.inFlight.get(input.commandId)?.promise === promise) this.inFlight.delete(input.commandId)
    }
  }

  private async runProposal(
    input: ProposeCandidateInput,
    actor: ActorView,
    signal?: AbortSignal,
    runtime?: RuntimeSettingsSnapshot,
  ): Promise<DomainReceipt> {
    if (input.confirmExternalModelProcessing !== true) {
      throw new ExperienceError('sensitive_content_unauthorized', 'external model processing requires explicit confirmation')
    }
    const { episode, historicalRecords, records, outcomeSourceRefs } =
      await this.readSources(input.episode, signal, runtime)
    const historicalRefs = historicalRecords.map(record => record.sourceRef)
    const eligibility = this.matchEligibilityDigest(
      episode,
      [...historicalRefs, ...outcomeSourceRefs],
      input.eligibilityDigest,
    )
    if (eligibility.extractionTrigger.eligibilityStatus === 'ineligible') {
      throw new ExperienceError('invalid_command', 'this Episode is not eligible for Candidate extraction', {
        reasons: eligibility.extractionTrigger.eligibilityReasons,
      })
    }
    const evidencePacket = buildExtractionEvidencePacket(
      [episode.episodeRef], records, runtime?.values ?? this.extractionConfig,
    )
    const result = await this.proposer.propose(
      evidencePacket,
      input.outputTokenLimit,
      input.proposalDisclosureDigest,
      input.confirmedMaxOutputTokens,
      signal,
      input.requestedKind,
      runtime,
    )
    return this.repository.proposeCandidate(
      input,
      result.draft,
      [episode.episodeRef],
      uniqueSourceRefs([...evidencePacket.items.map(item => item.sourceRef), ...outcomeSourceRefs]),
      result.metadata,
      eligibility,
      actor,
      runtime?.values.maxInlineFieldBytes ?? this.maxInlineFieldBytes,
    )
  }

  private matchEligibilityDigest(
    episode: Awaited<ReturnType<DshSessionSource['inspect']>>,
    historicalRefs: readonly ProposalSourceInspectionView['historicalSourceRefs'][number][],
    expectedDigest: string,
  ): ExtractionEligibilityResult {
    for (const trigger of TRIGGER_KINDS) {
      const result = evaluateExtractionEligibility(episode, historicalRefs, trigger, this.outcomeManifest)
      if (result.eligibilityDigest === expectedDigest) return result
    }
    throw new ExperienceError('invalid_command', 'Episode eligibility changed after disclosure confirmation')
  }

  private async readSources(
    input: ProposeCandidateInput['episode'],
    signal?: AbortSignal,
    runtime?: RuntimeSettingsSnapshot,
  ) {
    const limits = runtime?.values ?? this.sourceLimits
    const [episode, historicalRecords, outcomeInspection] = await Promise.all([
      this.sessions.inspect(input, signal, limits),
      this.historical.inspect(limits),
      this.outcomeEvidence.inspect(limits),
    ])
    signal?.throwIfAborted()
    const outcomeSourceRefs = outcomeInspection.sourceRefs
    const outcomeRecords = outcomeInspection.records
    const records = [...episode.records, ...outcomeRecords, ...historicalRecords]
    if (records.length > limits.maxRecords) {
      throw new ExperienceError('source_unresolvable', 'combined proposal sources exceed the configured record limit')
    }
    const totalBytes = records.reduce((total, record) => total + Buffer.byteLength(record.excerpt), 0)
    if (totalBytes > limits.maxTotalBytes) {
      throw new ExperienceError('source_unresolvable', 'combined proposal sources exceed the configured byte limit')
    }
    return {
      episode,
      historicalRecords,
      outcomeRecords,
      outcomeSourceRefs,
      records,
    }
  }
}

function uniqueSourceRefs(
  values: readonly ProposalSourceInspectionView['historicalSourceRefs'][number][],
): ProposalSourceInspectionView['historicalSourceRefs'][number][] {
  return [...new Map(values.map(value => [value.sourceRefId, value])).values()]
}

const TRIGGER_KINDS: readonly ExtractionTriggerKind[] = [
  'terminal_success',
  'high_cost_resolution',
  'repeated_kernel',
  'user_correction',
  'diagnostic_exclusion',
  'environment_invalidation',
  'outcome_unknown',
]

function requireOwner(actor: ActorView): void {
  if (actor.authority !== 'owner') {
    throw new ExperienceError('principal_unauthorized', 'this actor cannot inspect or propose Experience Candidates')
  }
}
