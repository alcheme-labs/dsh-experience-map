import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { assertSafeText } from '../application/content-policy.js'
import { ExperienceError } from '../errors.js'
import { brandedId } from '../ids.js'
import type {
  BoundedSourceRecord,
  OutcomeEvidenceConfig,
  SourceRefView,
  VerifiedOutcomeManifestConfig,
} from '../types.js'

/** Bounds applied while verifying criterion evidence configured by an acceptance Profile. */
export interface OutcomeEvidenceSourceLimits {
  readonly maxRecords: number
  readonly maxTotalBytes: number
}

/** Verified artifact identities and safe Host-owned criterion projections. */
export interface OutcomeEvidenceInspection {
  readonly sourceRefs: readonly SourceRefView[]
  readonly records: readonly BoundedSourceRecord[]
}

/** Re-read exact criterion evidence without copying its body into Experience or model input. */
export class OutcomeEvidenceSource {
  /** Bind an optional criterion manifest and existing source limits. */
  constructor(
    private readonly manifest: VerifiedOutcomeManifestConfig | undefined,
    private readonly limits: OutcomeEvidenceSourceLimits,
  ) {}

  /** Verify every distinct artifact and project criterion results without copying artifact bodies. */
  async inspect(limits: OutcomeEvidenceSourceLimits = this.limits): Promise<OutcomeEvidenceInspection> {
    if (this.manifest === undefined) return { sourceRefs: [], records: [] }
    const evidence = uniqueEvidence(this.manifest.criteria.flatMap(criterion => criterion.evidence))
    if (evidence.length > limits.maxRecords) {
      throw new ExperienceError('source_unresolvable', 'outcome evidence exceeds the configured record limit')
    }
    const expectedBytes = evidence.reduce((total, item) => total + item.bytes, 0)
    if (expectedBytes > limits.maxTotalBytes) {
      throw new ExperienceError('source_unresolvable', 'outcome evidence exceeds the configured byte limit')
    }
    const observedAt = new Date().toISOString()
    const sourceRefs = await Promise.all(evidence.map(async (expected): Promise<SourceRefView> => {
      let body: Buffer
      try {
        body = await readFile(expected.path)
      } catch (error) {
        throw new ExperienceError('source_unresolvable', 'outcome evidence artifact is unavailable', {
          locator: expected.locator,
        }, { cause: error })
      }
      const digest = `sha256:${sha256(body)}`
      if (body.byteLength !== expected.bytes || digest !== expected.contentDigest) {
        throw new ExperienceError('source_unresolvable', 'outcome evidence artifact changed', {
          locator: expected.locator,
          expectedDigest: expected.contentDigest,
          actualDigest: digest,
        })
      }
      return {
        sourceRefId: brandedId<'ExperienceSourceRefId'>(
          `source:${sha256(Buffer.from(`${expected.locator}:${digest}`))}`,
          'sourceRefId',
        ),
        sourceSystem: 'experience-verifier',
        sourceKind: 'external_document',
        locator: expected.locator,
        ownerScope: `criterion-manifest:${this.manifest!.policyVersion}`,
        accessScope: 'local_owner',
        occurredAt: observedAt,
        observedAt,
        contentDigest: digest,
        redactionState: 'digest_only',
      }
    }))
    const records = this.manifest.criteria.map(criterion => criterionRecord(
      this.manifest!,
      criterion,
      observedAt,
    ))
    return { sourceRefs, records }
  }
}

function criterionRecord(
  manifest: VerifiedOutcomeManifestConfig,
  criterion: VerifiedOutcomeManifestConfig['criteria'][number],
  observedAt: string,
): BoundedSourceRecord {
  const excerpt = JSON.stringify({
    policyVersion: manifest.policyVersion,
    criterionId: criterion.criterionId,
    mandatory: criterion.mandatory,
    result: criterion.result,
    evidence: criterion.evidence.map(value => ({
      locator: value.locator,
      contentDigest: value.contentDigest,
    })),
  })
  assertSafeText(excerpt, `criterion manifest ${criterion.criterionId}`)
  const digest = `sha256:${sha256(excerpt)}`
  return {
    sourceRef: {
      sourceRefId: brandedId<'ExperienceSourceRefId'>(
        `source:${sha256(`criterion:${manifest.policyVersion}:${criterion.criterionId}:${digest}`)}`,
        'sourceRefId',
      ),
      sourceSystem: 'experience-verifier',
      sourceKind: 'external_document',
      locator: `experience-verifier:criterion/${manifest.policyVersion}/${criterion.criterionId}`,
      ownerScope: `criterion-manifest:${manifest.policyVersion}`,
      accessScope: 'local_owner',
      occurredAt: observedAt,
      observedAt,
      contentDigest: digest,
      redactionState: 'bounded_excerpt',
    },
    eventType: 'acceptance_criterion',
    excerpt,
  }
}

function uniqueEvidence(values: readonly OutcomeEvidenceConfig[]): OutcomeEvidenceConfig[] {
  const result = new Map<string, OutcomeEvidenceConfig>()
  for (const value of values) {
    const key = `${value.path}\u0000${value.locator}\u0000${value.contentDigest}\u0000${String(value.bytes)}`
    result.set(key, value)
  }
  return [...result.values()]
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
