import type {
  ActorId,
  AssessmentId,
  CandidateId,
  ComponentId,
  ComponentRevisionId,
  EvidenceId,
  ExperienceId,
  ExperienceVersionId,
} from '../ids.js'
import type {
  AllowedUseMode,
  ComponentRole,
  EvidenceGrade,
} from '../types.js'
import type { ExperienceKind } from './kind.js'

/** Field-level human decision retained on a Candidate. */
export interface FieldDecision {
  readonly decisionId: string
  readonly field: string
  readonly decision: 'accept' | 'reject' | 'edit'
  readonly value?: unknown
  readonly actorId: ActorId
  readonly reason: string
  readonly decidedAt: string
}

/** Candidate aggregate before publication. */
export interface ExperienceCandidate {
  readonly candidateId: CandidateId
  readonly target: 'new_experience' | 'revise_experience'
  readonly extractionTrigger: string
  readonly triggerReason: string
  readonly proposedKind: ExperienceKind
  readonly sourceEpisodeRefs: readonly string[]
  readonly sourceRefs: readonly string[]
  readonly proposedScope: Readonly<Record<string, string>>
  readonly proposedComponents: readonly ComponentRevision[]
  readonly proposedEvidenceLinks: readonly EvidenceStatement[]
  readonly fieldDecisions: readonly FieldDecision[]
  readonly candidateRevision: number
  readonly state: 'proposed' | 'in_review' | 'accepted' | 'published' | 'rejected' | 'withdrawn'
  readonly proposedBy: ActorId
  readonly createdAt: string
}

/** Stable identity across Experience versions. */
export interface ExperienceSeries {
  readonly experienceId: ExperienceId
  readonly kind: ExperienceKind
  readonly currentVersionId: ExperienceVersionId
  readonly seriesRevision: number
  readonly createdAt: string
  readonly lifecycleProjection: 'active' | 'retired'
}

/** Immutable published Experience. */
export interface ExperienceVersion {
  readonly experienceVersionId: ExperienceVersionId
  readonly experienceId: ExperienceId
  readonly versionNumber: number
  readonly previousVersionId: ExperienceVersionId | null
  readonly title: string
  readonly intent: string
  readonly scope: Readonly<Record<string, string>>
  readonly validity: Readonly<Record<string, unknown>>
  readonly authoritySpec: Readonly<Record<string, unknown>>
  readonly privacyClass: 'public' | 'workspace' | 'restricted' | 'secret_reference_only'
  readonly riskAndEffectSpec: Readonly<Record<string, unknown>>
  readonly allowedUseModes: readonly AllowedUseMode[]
  readonly componentRevisionIds: readonly ComponentRevisionId[]
  readonly initialAssessmentId: AssessmentId
  readonly relationIds: readonly string[]
  readonly contentDigest: string
  readonly createdByDecisionId: string
  readonly createdAt: string
}

/** Stable independently revisable semantic component. */
export interface ExperienceComponent {
  readonly componentId: ComponentId
  readonly experienceId: ExperienceId
  readonly semanticRole: ComponentRole
  readonly currentRevisionId: ComponentRevisionId
}

/** Immutable component contents. M1 permits inline text only. */
export interface ComponentRevision {
  readonly componentRevisionId: ComponentRevisionId
  readonly componentId: ComponentId
  readonly semanticRole: ComponentRole
  readonly content: string
  readonly sourceRefs: readonly string[]
  readonly evidenceIds: readonly EvidenceId[]
  readonly createdAt: string
}

/** A claim and its exact source direction. */
export interface EvidenceStatement {
  readonly evidenceId: EvidenceId
  readonly componentRevisionId: ComponentRevisionId
  readonly claim: string
  readonly sourceRefs: readonly string[]
  readonly direction: 'supports' | 'contradicts' | 'qualifies'
}

/** Independent evidence, governance, and operational dimensions. */
export interface EvidenceAssessment {
  readonly assessmentId: AssessmentId
  readonly experienceVersionId: ExperienceVersionId
  readonly grade: EvidenceGrade
  readonly governanceState: 'accepted' | 'contested' | 'rejected'
  readonly operationalState: 'active' | 'conditional' | 'stale' | 'superseded' | 'retired'
  readonly evidenceIds: readonly EvidenceId[]
  readonly decidedBy: ActorId
  readonly decidedAt: string
}

/** Exact candidate discovery result and explanations. */
export interface MatchSet {
  readonly matchSetId: string
  readonly candidates: readonly {
    readonly experienceVersionId: ExperienceVersionId
    readonly eligible: boolean
    readonly reasons: readonly string[]
  }[]
  readonly createdAt: string
}

/** Current-time applicability observation. */
export interface PreflightRecord {
  readonly preflightId: string
  readonly experienceVersionId: ExperienceVersionId
  readonly conditions: readonly {
    readonly key: string
    readonly result: 'true' | 'false' | 'unknown'
    readonly observationRefs: readonly string[]
  }[]
  readonly createdAt: string
}

/** Immutable composed plan. */
export interface UsagePlan {
  readonly usagePlanId: string
  readonly usageId: string
  readonly planRevision: number
  readonly selectedVersions: readonly ExperienceVersionId[]
  readonly orderedStepRefs: readonly string[]
  readonly discardedContributions: readonly { readonly sourceRef: string; readonly reasonCode: string }[]
  readonly planningBlockers: readonly string[]
}

/** Exact approval request over one immutable Plan and Preflight set. */
export interface PlanApprovalRequest {
  readonly requestId: string
  readonly usagePlanId: string
  readonly preflightIds: readonly string[]
  readonly status: 'pending' | 'approved' | 'denied' | 'withdrawn' | 'expired' | 'superseded'
  readonly validUntil: string
}

/** One use attempt; never the authority for external effects. */
export interface ExperienceUsage {
  readonly usageId: string
  readonly matchSetId: string | null
  readonly activePlanId: string | null
  readonly settlementId: string | null
  readonly state: 'opened' | 'matched' | 'preflighted' | 'planned' | 'awaiting_approval'
    | 'in_progress' | 'settling' | 'success' | 'partial' | 'failure' | 'unknown'
    | 'aborted' | 'rejected_before_use'
  readonly usageRevision: number
}

/** Immutable current execution cursor. */
export interface StepProgress {
  readonly stepProgressId: string
  readonly usageId: string
  readonly controllerRevision: number
  readonly stepRef: string
  readonly state: 'ready' | 'running' | 'paused' | 'completed' | 'failed' | 'unknown' | 'aborted'
}

/** Approved materialization sent to a model-visible Session surface. */
export interface ContextSnapshot {
  readonly contextSnapshotId: string
  readonly usageId: string
  readonly sectionDigests: readonly string[]
  readonly sourceRefs: readonly string[]
  readonly contentDigest: string
}

/** Terminal criterion-backed use outcome. */
export interface UsageSettlement {
  readonly settlementId: string
  readonly usageId: string
  readonly outcome: 'success' | 'partial' | 'failure' | 'unknown' | 'aborted'
  readonly criteria: readonly {
    readonly criterionId: string
    readonly mandatory: boolean
    readonly result: 'pass' | 'fail' | 'unknown' | 'not_evaluated'
    readonly evidenceRefs: readonly string[]
  }[]
}

/** Component-level immutable revision proposal. */
export interface RevisionProposal {
  readonly revisionProposalId: string
  readonly experienceId: ExperienceId
  readonly baseVersionId: ExperienceVersionId
  readonly changes: readonly {
    readonly componentId: ComponentId
    readonly replacementContent: string
    readonly sourceRefs: readonly string[]
  }[]
  readonly state: 'proposed' | 'in_review' | 'accepted' | 'published' | 'rejected' | 'withdrawn'
}
