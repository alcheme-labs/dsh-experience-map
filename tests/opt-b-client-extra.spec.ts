import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import type { ConnectionHandle, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { fieldTextDiff, fieldValuesEqual, createFieldEditDraft, resolveFieldEdit } from '../src/client/field-review.js'
import { fieldReviewProgress, nextUnreviewedField } from '../src/client/workspace-model.js'
import { createStore } from '../src/client/store.js'
import { retrievalProjection } from './fixtures/retrieval.js'
import { throughExperienceRpcCarrier } from './fixtures/client-rpc.js'
import { automationConfigurationFixture } from './fixtures/automation.js'
import { en, zh } from '../src/client/locales.js'
import {
  episodeRef,
  eligibleExtraction,
  proposalMetadata,
  sourceRef,
} from './fixtures/workflow.js'
import type {
  CandidateFieldReviewInput,
  CandidateFieldView,
  CandidateView,
  CandidateSummaryView,
  ExperienceStatusView,
  DomainReceipt,
} from '../src/types.js'

const require = createRequire(import.meta.url)
const temp = mkdtempSync(join(tmpdir(), 'opt-b-client-extra-'))

/** Minimal real translation: use the shipped zh dictionary and interpolate {name} params. */
function t(key: string, params?: Record<string, unknown>): string {
  let text = (zh as Record<string, string>)[key] ?? key
  if (params !== undefined) {
    text = text.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match)
  }
  return text
}

type ElementNode = { readonly type: unknown; readonly props: Record<string, unknown> & { readonly children?: unknown } }

let fieldDiffComponent: (props: unknown) => unknown
let commonReasonsComponent: (props: unknown) => unknown
let reviewToolbarComponent: (props: unknown) => unknown
let renderText: (component: (props: unknown) => unknown, props: object) => string
let renderTree: (component: (props: unknown) => unknown, props: object) => ElementNode

beforeAll(async () => {
  const source = readFileSync('src/client/workspace.tsx', 'utf8')
  await build({
    stdin: {
      contents: source + '\nexport { FieldDiff as __reviewFieldDiff }; export { CommonDecisionReasons as __reviewCommonReasons }; export { ReviewToolbar as __reviewReviewToolbar };',
      resolveDir: join(process.cwd(), 'src/client'),
      loader: 'tsx',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: join(temp, 'review.cjs'),
    jsx: 'automatic',
    plugins: [{ name: 'test-runtime', setup(b) {
      b.onResolve({ filter: /^react(?:\/.*)?$/ }, a => ({ path: require.resolve(a.path), external: true }))
      b.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: 'primitives', namespace: 'review' }))
      b.onLoad({ filter: /.*/, namespace: 'review' }, () => ({ contents: 'export const Button=({children})=>children;export const Pill=Button;export const StateDot=Button;export const IconCheckOutline14=()=>null;export const IconRefreshOutline14=()=>null;export const IconCloseOutline16=()=>null;export const IconPanelLeftOutline16=()=>null;', loader: 'jsx' }))
      b.onLoad({ filter: /\.css$/ }, () => ({ contents: 'export default {}', loader: 'js' }))
    } }],
  })
  const mod = require(join(temp, 'review.cjs')) as {
    __reviewFieldDiff: (props: unknown) => unknown
    __reviewCommonReasons: (props: unknown) => unknown
    __reviewReviewToolbar: (props: unknown) => unknown
  }
  fieldDiffComponent = mod.__reviewFieldDiff
  commonReasonsComponent = mod.__reviewCommonReasons
  reviewToolbarComponent = mod.__reviewReviewToolbar
  const text = (node: unknown): string => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(text).join(' ')
    const e = node as ElementNode
    if (typeof e.type === 'function') return text((e.type as (props: unknown) => unknown)(e.props))
    return text(e.props?.children)
  }
  renderText = (component, props) => text(component(props))
  renderTree = (component, props) => component(props) as ElementNode
})

afterAll(() => rmSync(temp, { recursive: true, force: true }))

function fieldView(name: string, overrides: Partial<CandidateFieldView> = {}): CandidateFieldView {
  return {
    field: name,
    stage: 'stable_kernel',
    componentRole: null,
    proposedValue: null,
    proposedSourceRefs: [],
    sourceRefs: [],
    unresolved: false,
    bulkAcceptAllowed: false,
    currentDecision: null,
    ...overrides,
  }
}

function decision(
  decision: 'accept' | 'reject' | 'edit',
  reason: string,
  extra: Partial<CandidateFieldReviewInput> = {},
): NonNullable<CandidateFieldView['currentDecision']> {
  return {
    field: 'title',
    decision,
    reason,
    ...extra,
    decisionId: `${decision}-id`,
    actorId: 'actor-test' as NonNullable<CandidateFieldView['currentDecision']>['actorId'],
    decidedAt: '2026-08-31T09:00:00.000Z',
  }
}

function collectButtons(node: unknown, found: ElementNode[] = []): ElementNode[] {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const item of node) collectButtons(item, found)
    return found
  }
  const element = node as ElementNode
  if (element.type === 'button') found.push(element)
  collectButtons(element.props?.children, found)
  return found
}

describe('B3 C1 readable original-vs-effective difference', () => {
  it('produces a word-aligned diff for changed text fields with removed and added spans', () => {
    const diff = fieldTextDiff('alpha beta gamma', 'alpha omega gamma')
    expect(diff).not.toBeNull()
    expect(diff!.map(segment => segment.type)).toEqual(['same', 'removed', 'added', 'same'])
    expect(diff!.map(segment => segment.text)).toContain('beta')
    expect(diff!.map(segment => segment.text)).toContain('omega')
  })

  it('returns a single same segment when the text did not change', () => {
    expect(fieldTextDiff('same title', 'same title')).toEqual([{ type: 'same', text: 'same title' }])
  })

  it('returns null for structured values so the UI compares both readable sides', () => {
    expect(fieldTextDiff({ a: 1 }, { a: 2 })).toBeNull()
    expect(fieldValuesEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(fieldValuesEqual({ a: 1 }, { a: 1 })).toBe(true)
  })

  it('renders the changed diff for a text field via the real FieldEditor subcomponent', () => {
    const field = fieldView('title', { proposedValue: 'alpha beta gamma' })
    const html = renderText(fieldDiffComponent, {
      field, proposed: 'alpha beta gamma', effective: 'alpha omega gamma', t,
    })
    expect(html).toContain(t('field.diffChanged'))
    expect(html).toContain('beta')
    expect(html).toContain('omega')
  })

  it('renders both readable sides for a structured change instead of a JSON color block', () => {
    const field = fieldView('scope', {
      proposedValue: { surface: 'web', region: 'cn' },
      sourceRefs: ['source:test-terminal-event'],
    })
    const html = renderText(fieldDiffComponent, {
      field, proposed: { surface: 'web', region: 'cn' }, effective: { surface: 'web', region: 'us' }, t,
    })
    expect(html).toContain(t('field.diffOriginal'))
    expect(html).toContain(t('field.diffEffective'))
    expect(html).toContain('region')
    expect(html).toContain('us')
    expect(html).not.toContain('{"surface":"web","region":"cn"}')
  })
})

describe('B3 C2 proactive editable decision reasons', () => {
  it('renders the common reason chips as buttons, never a pre-filled verified conclusion', () => {
    const tree = renderTree(commonReasonsComponent, { value: '', onPick: () => {}, t })
    const buttons = collectButtons(tree)
    expect(buttons.length).toBeGreaterThan(0)
    const labels = buttons.map(button => typeof button.props.children === 'string' ? button.props.children : '')
    expect(labels).toContain(t('reason.quick.matchesProposal'))
    expect(labels).toContain(t('reason.quick.contradictsFacts'))
    for (const button of buttons) expect(button.props.type).toBe('button')
  })

  it('selecting a chip fills the reason without auto-deciding (onPick only, no decision callback)', () => {
    let picked: string | null = null
    const tree = renderTree(commonReasonsComponent, { value: '', onPick: (value: string) => { picked = value }, t })
    const matching = collectButtons(tree).find(button => button.props.children === t('reason.quick.sourceInsufficient'))!
    ;(matching.props.onClick as () => void)()
    expect(picked).toBe(t('reason.quick.sourceInsufficient'))
  })

  it('marks the chip currently reflected in the editable reason box', () => {
    const reason = t('reason.quick.correctedContent')
    const tree = renderTree(commonReasonsComponent, { value: reason, onPick: () => {}, t })
    const pressed = collectButtons(tree).filter(button => button.props['aria-pressed'] === true)
    expect(pressed).toHaveLength(1)
    expect(pressed[0]!.props.children).toBe(reason)
  })
})

describe('B3 C3 Host-driven progress and next unreviewed navigation', () => {
  it('derives progress only from Host field decisions', () => {
    const fields = [
      fieldView('title', { currentDecision: decision('accept', 'ok') }),
      fieldView('intent', { currentDecision: decision('edit', 'edited', { value: 'changed' }) }),
      fieldView('scope', { currentDecision: decision('reject', 'bad') }),
      fieldView('validity'),
    ]
    expect(fieldReviewProgress(fields)).toEqual({ accepted: 1, edited: 1, rejected: 1, pending: 1, total: 4 })
  })

  it('locates the next unreviewed field, skipping reviewed fields, and wraps without repeating', () => {
    const fields = [
      fieldView('title', { currentDecision: decision('accept', 'ok') }),
      fieldView('intent'),
      fieldView('scope', { currentDecision: decision('accept', 'ok') }),
      fieldView('validity'),
    ]
    expect(nextUnreviewedField(fields, null)).toBe('intent')
    expect(nextUnreviewedField(fields, 'intent')).toBe('validity')
    expect(nextUnreviewedField(fields, 'validity')).toBe('intent')
    expect(nextUnreviewedField(fields, 'title')).toBe('intent')
  })

  it('returns null (completed end state) once every field has a decision', () => {
    const fields = [
      fieldView('title', { currentDecision: decision('accept', 'ok') }),
      fieldView('intent', { currentDecision: decision('edit', 'edited', { value: 'changed' }) }),
      fieldView('scope', { currentDecision: decision('reject', 'bad') }),
    ]
    expect(nextUnreviewedField(fields, null)).toBeNull()
    expect(fieldReviewProgress(fields).pending).toBe(0)
  })

  it('renders the toolbar with Host counts and the next-unreviewed action while fields remain pending', () => {
    const stageFields = [
      fieldView('title'),
      fieldView('intent', { currentDecision: decision('edit', 'edited', { value: 'changed' }) }),
    ]
    const progress = fieldReviewProgress(stageFields)
    const overallProgress = fieldReviewProgress([
      fieldView('title'),
      fieldView('intent', { currentDecision: decision('reject', 'bad') }),
    ])
    const html = renderText(reviewToolbarComponent, {
      progress, overall: overallProgress, hasPending: progress.pending > 0, allDecided: overallProgress.pending === 0, onNext: () => {}, t,
    })
    expect(html).toContain(t('review.nextUnreviewed'))
    expect(html).toContain(t('review.reviewedCount', { reviewed: 1, total: 2 }))
    expect(html).not.toContain(t('review.allReviewed'))
  })

  it('shows the completed end state when no field is pending', () => {
    const all = [
      fieldView('title', { currentDecision: decision('accept', 'ok') }),
      fieldView('intent', { currentDecision: decision('accept', 'ok') }),
    ]
    const progress = fieldReviewProgress(all)
    const html = renderText(reviewToolbarComponent, {
      progress, overall: progress, hasPending: false, allDecided: true, onNext: () => {}, t,
    })
    expect(html).toContain(t('review.allReviewed'))
  })
})

describe('B3 C4 authoritative field decision through the real store', () => {
  function candidateWithField(decided: CandidateFieldView['currentDecision'], revision: number): CandidateView {
    return {
      candidateId: 'candidate-1' as CandidateView['candidateId'],
      candidateRevision: revision,
      state: 'in_review',
      target: 'new_experience',
      proposedKind: 'diagnostic',
      title: 'Candidate',
      extractionTrigger: eligibleExtraction.extractionTrigger,
      outcomeAssessment: eligibleExtraction.outcomeAssessment,
      eligibilityDigest: eligibleExtraction.eligibilityDigest,
      triggerReason: 'terminal Episode has a verified successful outcome',
      sourceEpisodeRefs: [episodeRef],
      sourceRefs: [sourceRef],
      proposal: proposalMetadata,
      evidenceGrade: 'observation_supported',
      fields: [fieldView('title', {
        currentDecision: decided,
        proposedValue: 'Original',
        proposedSourceRefs: [sourceRef.sourceRefId],
        sourceRefs: [sourceRef.sourceRefId],
      })],
      excludedSteps: [],
      missingEvidence: [],
      unresolvedFields: [],
      publicationReadiness: { ready: false, blockers: ['field_decisions_incomplete'] },
      createdAt: proposalMetadata.proposedAt,
      publishedVersionId: null,
      dispositionReason: null,
    }
  }

  function fieldReceipt(): DomainReceipt {
    return {
      receiptId: 'receipt-field' as DomainReceipt['receiptId'],
      commandId: 'command-field' as DomainReceipt['commandId'],
      action: 'candidate.field_decide',
      actor: {
        actorId: 'actor-1' as DomainReceipt['actor']['actorId'],
        principalId: 'principal-1' as DomainReceipt['actor']['principalId'],
        kind: 'browser_local_owner',
        authority: 'owner',
      },
      candidateId: 'candidate-1' as DomainReceipt['candidateId'],
      candidateRevision: 2,
      experienceId: null,
      experienceVersionId: null,
      correlationId: 'client-test',
      causationId: null,
      issuedAt: '2026-08-31T09:10:00.000Z',
      commitSequence: 2,
      createdAt: '2026-08-31T09:10:01.000Z',
    }
  }

  function status(receipt: DomainReceipt): ExperienceStatusView {
    return {
      actor: receipt.actor,
      principalId: receipt.actor.principalId,
      candidateCount: 1,
      versionCount: 0,
      latestReceipt: receipt,
      latestForgetRequest: null,
      latestVersion: null,
      pendingPlanApprovalCount: 0,
      latestPlanning: null,
    }
  }

  function summary(candidate: CandidateView): CandidateSummaryView {
    return {
      candidateId: candidate.candidateId,
      candidateRevision: candidate.candidateRevision,
      state: candidate.state,
      proposedKind: candidate.proposedKind,
      title: candidate.title,
      triggerReason: candidate.triggerReason,
      eligibilityStatus: candidate.extractionTrigger.eligibilityStatus,
      pendingFieldCount: candidate.fields.filter(f => f.currentDecision === null).length,
      rejectedFieldCount: candidate.fields.filter(f => f.currentDecision?.decision === 'reject').length,
      createdAt: candidate.createdAt,
      proposal: candidate.proposal,
    }
  }

  function ok(value: unknown): ConnectionRpcResult<unknown> {
    return { ok: true, value }
  }

  type DecideResult = ConnectionRpcResult<unknown>

  function connection(
    candidate: CandidateView,
    decideResult: () => DecideResult,
  ): { handle: ConnectionHandle; calls: Array<{ endpoint: string; input: unknown }> } {
    const calls: Array<{ endpoint: string; input: unknown }> = []
    const candidateRef = { current: candidate }
    const handle = {
      rpc: {
        call: async (_channel: string, endpoint: string, input: unknown): Promise<ConnectionRpcResult<unknown>> => {
          calls.push({ endpoint, input })
          switch (endpoint) {
            case 'status/query':
              return ok(status(fieldReceipt()))
            case 'suggestions/query':
              return ok({ projectionKey: 'experience-suggestions-v1', schemaVersion: 5,
                groups: [], sessions: [], seeds: [], dispositions: [] })
            case 'retrieval/query':
              return ok(retrievalProjection())
            case 'candidate/list':
              return ok([summary(candidateRef.current)])
            case 'plan/list':
              return ok([])
            case 'plan/config':
              return ok({ taskFingerprintProposalMode: 'deterministic', provider: null, model: null, maxOutputTokens: null, promptVersion: 'task-fingerprint-v1' })
            case 'automation/config':
              return ok(automationConfigurationFixture())
            case 'learning/query':
              return ok({ projectionKey: 'experience-learning-v1', builderVersion: 'm7-learning-v4', capabilities: [], summary: { label: 'x', detail: 'y' } })
            case 'learning/governance':
              return ok({ capability: 'none', stage: 'disabled', revision: 1, observations: [], overrides: [] })
            case 'relation-map/query':
              return ok({ edges: [], nodes: [] })
            case 'infrastructure/readiness':
              return ok({ evaluation: null, overview: { state: 'unknown', blockers: [], resolution: null } })
            case 'candidate/get':
              return ok(candidateRef.current)
            case 'candidate/field-decide': {
              const result = decideResult()
              if (!result.ok) return result
              const asInput = (input as { input?: Record<string, unknown> }).input ?? {}
              const fieldName = String(asInput.field)
              const review = asInput as unknown as CandidateFieldReviewInput
              candidateRef.current = {
                ...candidateRef.current,
                candidateRevision: candidateRef.current.candidateRevision + 1,
                fields: candidateRef.current.fields.map(f => f.field === fieldName
                  ? {
                    ...f,
                    currentDecision: decision(review.decision, review.reason,
                      review.decision === 'edit'
                        ? { value: review.value, ...(review.effectiveSourceRefs === undefined ? {} : { effectiveSourceRefs: review.effectiveSourceRefs }) }
                        : {}),
                  }
                  : f),
              }
              return ok({ receiptId: 'receipt-field' })
            }
            case 'receipt/get':
              return ok(fieldReceipt())
            default:
              throw new Error(`unexpected endpoint ${endpoint}`)
          }
        },
      },
    } as unknown as ConnectionHandle
    return { handle, calls }
  }

  async function preparedStore(
    candidate: CandidateView,
    decideResult: () => DecideResult,
  ): Promise<{ store: ReturnType<typeof createStore>; calls: Array<{ endpoint: string; input: unknown }> }> {
    const { handle, calls } = connection(candidate, decideResult)
    const store = createStore(throughExperienceRpcCarrier(handle))
    await store.refresh()
    await store.select('candidate-1' as CandidateView['candidateId'])
    return { store, calls }
  }

  it('writes a field accept with reason and reads the Host decision back (no optimistic success)', async () => {
    const { store, calls } = await preparedStore(candidateWithField(null, 1), () => ok({ receiptId: 'receipt-field' }))
    expect(store.getSnapshot().selected?.fields[0]?.currentDecision).toBeNull()
    await store.decide('title', { decision: 'accept', reason: 'matches the model proposal' })
    const snapshot = store.getSnapshot()
    expect(snapshot.phase).toBe('ready')
    expect(snapshot.error).toBeUndefined()
    expect(snapshot.selected?.fields[0]?.currentDecision?.decision).toBe('accept')
    const write = calls.find(call => call.endpoint === 'candidate/field-decide')!
    const writeInput = (write.input as { input: Record<string, unknown> }).input
    expect(writeInput.expectedRevision).toBe(1)
    expect(writeInput.reason).toBe('matches the model proposal')
    const endpoints = calls.map(call => call.endpoint)
    expect(endpoints.lastIndexOf('candidate/field-decide')).toBeLessThan(endpoints.lastIndexOf('candidate/get'))
  })

  it('does not mark a field as reviewed when the Host rejects a stale revision', async () => {
    const { store, calls } = await preparedStore(candidateWithField(null, 1), () => ({
      ok: false,
      error: { code: 'candidate_revision_conflict', message: 'expected revision 2, got 1', details: {} },
    }))
    await store.decide('title', { decision: 'accept', reason: 'matches' })
    const snapshot = store.getSnapshot()
    expect(snapshot.phase).toBe('error')
    expect(snapshot.error).toBe('expected revision 2, got 1')
    // C4: the rejected write must not auto-recover. No candidate/get after the failed decide,
    // so the failure copy cannot claim the view is already synced with the Host.
    const endpoints = calls.map(call => call.endpoint)
    const lastDecide = endpoints.lastIndexOf('candidate/field-decide')
    const autoReadback = endpoints.slice(lastDecide + 1).includes('candidate/get')
    expect(autoReadback).toBe(false)
    expect((zh as Record<string, string>)['review.decisionFailed']).not.toContain('已从 Host 恢复')
    expect((en as Record<string, string>)['review.decisionFailed']).not.toContain('recovered from the Host')
    // The field is NOT optimistically marked reviewed; the Host remains authoritative.
    expect(snapshot.selected?.fields[0]?.currentDecision).toBeNull()
  })

  it('requires a real effective source reselection before an edit can be submitted', () => {
    const draft = createFieldEditDraft('title', 'Original')
    expect(draft).not.toBeNull()
    expect(resolveFieldEdit(draft!, [])).toEqual({ ok: false, issue: 'effective_source_required' })
    expect(resolveFieldEdit(draft!, [sourceRef.sourceRefId])).toEqual({ ok: true, value: 'Original' })
  })
})
