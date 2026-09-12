import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionPendingInteractionSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button,
  IconCheckOutline14,
  IconRefreshOutline14,
  Pill,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type {
  BoundedSourceRecord,
  CandidateRejectionReasonCode,
  CandidateFieldView,
  CandidateView,
  ComponentRole,
  MatchCandidateView,
  PlanningObservationView,
  PlanningResultView,
  PreflightRecordView,
  DiagnosticComponentInput,
  EpisodeRefView,
  ExtractionEvidenceItem,
  ExtractionOmissionReason,
  ExtractionOmissionView,
  ProposalOutputTokenLimitInput,
  RevisionProposalView,
  SourceRefView,
  UsageExecutionView,
  LearningCapability,
  LearningPredictionView,
  ExperienceSuggestionGroupView,
  SuggestionOwnerChoiceInput,
} from '../types.js'
import { CANDIDATE_REJECTION_REASON_CODES, LEARNING_CAPABILITIES, M2_ALLOWED_USE_MODES } from '../types.js'
import { EXPERIENCE_KINDS, type ExperienceKind } from '../domain/kind.js'
import {
  createFieldEditDraft,
  fieldTextDiff,
  fieldValuesEqual,
  resolveFieldEdit,
  type FieldEditDraft,
  type FieldEditIssue,
} from './field-review.js'
import { en, type ExperienceLocaleKey, zh } from './locales.js'
import { createStore, type ExperienceStore } from './store.js'
import { ExperienceShell } from './workspace-shell.js'
import {
  currentTaskStage,
  DEFAULT_EXPERIENCE_MODE,
  fieldReviewProgress,
  type ExperienceMode,
  type FieldReviewProgress,
  type InspectorTab,
  nextUnreviewedField,
  TASK_STAGES,
  type TaskStage,
  taskStageReachable,
  taskStageState,
  parseLearningHistory,
  parseLearningRanking,
  type LearningHistoryView,
  type LearningRankingView,
  type LearningParticipation,
  type LearningTaskOutcome,
  type LearningRankingMode,
} from './workspace-model.js'
import css from './workspace.module.css'

const NS = 'experience-map'
/** Dedicated ranking predictor the Host binds its history-ranking wire to (CONTRACT/OPT-C). */
const LEARNING_RANKING_PREDICTOR_VERSION = 'opt-history-ranking'
type ViewProps = ConvViewProps & PropsLocale<typeof NS>
type Translate = ViewProps['t']
type ManagementSection = 'recent_suggestions' | 'cross_session' | 'needs_attention' | 'candidates'
type SuggestionSection = Exclude<ManagementSection, 'candidates'>

/** Editable reason suggestions; selecting one only fills the reason box, it never decides. */
const COMMON_DECISION_REASONS: readonly ExperienceLocaleKey[] = [
  'reason.quick.matchesProposal',
  'reason.quick.correctedContent',
  'reason.quick.sourceInsufficient',
  'reason.quick.contradictsFacts',
]

/** Install the M2 Experience workspace in the existing Harness Conversation tab strip. */
export function registerExperienceWorkspace(ctx: Context): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const stores = new Set<ExperienceStore>()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'experience-map dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view', id: 'experience', order: 20, locale: NS, label: () => t('view.label'),
  }, (props: ViewProps) => <ExperienceWorkspaceOwner key={props.sessionId} {...props} connection={connection} stores={stores} />))
  ctx.on('connection/reset', () => {
    for (const store of stores) void store.reset()
  })
}

function ExperienceWorkspaceOwner({ connection, stores, ...props }: ViewProps & {
  readonly connection: ConnectionHandle
  readonly stores: Set<ExperienceStore>
}) {
  const [store] = useState(() => createStore(connection))
  useEffect(() => {
    stores.add(store)
    void store.refresh()
    return () => { stores.delete(store) }
  }, [store, stores])
  return <ExperienceWorkspace {...props} store={store} />
}

function ExperienceWorkspace({
  store,
  t,
  sessionId,
  useSessionPendingInteraction,
}: ViewProps & { readonly store: ExperienceStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const planReviewKey = useSessionPendingInteraction((interactions: SessionPendingInteractionSnapshot) => {
    const interaction = interactions.get(sessionId)
    return interaction?.kind === 'plan-review' ? interaction.key : undefined
  })
  const previousPlanReviewKey = useRef<string | undefined>(undefined)
  const [mode, setMode] = useState<ExperienceMode>(DEFAULT_EXPERIENCE_MODE)
  const [managementSection, setManagementSection] = useState<ManagementSection>('recent_suggestions')
  const [selectedSuggestionGroupId, setSelectedSuggestionGroupId] = useState<string | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('overview')
  const [stage, setStage] = useState<CandidateFieldView['stage']>('stable_kernel')
  const derivedTaskStage = currentTaskStage(state)
  const selectedSuggestion = state.suggestions?.groups.find(
    group => group.suggestionGroupId === selectedSuggestionGroupId,
  )
  const [activeTaskStage, setActiveTaskStage] = useState<TaskStage>(derivedTaskStage)
  const [requestedKind, setRequestedKind] = useState<ExperienceKind>('diagnostic')
  const [outputTokenLimitMode, setOutputTokenLimitMode] = useState<ProposalOutputTokenLimitInput['mode']>('configured_default')
  const [customMaxTokens, setCustomMaxTokens] = useState(16_384)
  const outputTokenLimit = outputTokenLimitMode === 'custom'
    ? { mode: outputTokenLimitMode, maxTokens: customMaxTokens } as const
    : { mode: outputTokenLimitMode } as const
  const customLimitValid = outputTokenLimitMode !== 'custom'
    || (Number.isSafeInteger(customMaxTokens) && customMaxTokens >= 1_024 && customMaxTokens <= 32_768)
  const generationSelectionCurrent = state.inspection === undefined
    || (state.inspection.requestedKind === requestedKind
      && outputTokenLimitEquals(state.inspection.outputTokenLimit, outputTokenLimit))
  useEffect(() => {
    setStage('stable_kernel')
  }, [state.selected?.candidateId])
  useEffect(() => {
    setActiveTaskStage(derivedTaskStage)
  }, [derivedTaskStage, state.selectedPlanning?.plan.usageId])
  useEffect(() => {
    if (selectedSuggestionGroupId !== null && selectedSuggestion === undefined) {
      setSelectedSuggestionGroupId(null)
    }
  }, [selectedSuggestion, selectedSuggestionGroupId])
  const changeManagementSection = (section: ManagementSection): void => {
    setManagementSection(section)
    setSelectedSuggestionGroupId(null)
  }
  const inspectSuggestion = (groupId: string): void => {
    setSelectedSuggestionGroupId(groupId)
    setInspectorOpen(true)
    setInspectorTab('sources')
  }
  useEffect(() => {
    const previous = previousPlanReviewKey.current
    previousPlanReviewKey.current = planReviewKey
    // ui-session owns plan-review settlement; the Experience view only reads the resulting Host state.
    if (previous !== undefined && planReviewKey === undefined) void store.refresh()
  }, [planReviewKey, store])
  const changeMode = (next: ExperienceMode): void => {
    setMode(next)
    setInspectorTab('overview')
  }
  return <div
    className={css.workspaceRoot}
    data-testid="experience-map"
    data-experience-phase={state.phase}
    data-conversation-composer-overlay=""
  >
    <ExperienceShell
      mode={mode}
      taskLabel={t('mode.task')}
      managementLabel={t('mode.management')}
      pendingLabel={t('mode.pending')}
      pendingCount={(state.suggestions?.groups.length ?? 0)
        + state.candidates.filter(candidate => candidate.state === 'proposed' || candidate.state === 'in_review').length}
      inspectorLabel={t('inspector.title')}
      inspectorOpen={inspectorOpen}
      onModeChange={changeMode}
      onInspectorOpenChange={setInspectorOpen}
      context={<div>
        <div className={css.contextTitle}>
          <span>{t('title')}</span>
          <Pill>{mode === 'task' ? t(`task.stage.${activeTaskStage}`) : t('management.pending')}</Pill>
        </div>
        <p className={css.contextDescription}>{mode === 'task' ? t('task.description') : t('management.description')}</p>
      </div>}
      navigation={mode === 'task'
        ? <TaskNavigation active={activeTaskStage} current={derivedTaskStage} setActive={setActiveTaskStage} t={t} />
        : <ManagementNavigation state={state} store={store} active={managementSection}
            setActive={changeManagementSection} t={t} />}
      workbench={mode === 'task'
        ? <PlanningPanel store={store} state={state} sessionId={sessionId} activeStage={activeTaskStage} t={t} />
        : managementSection === 'candidates' ? <ManagementWorkspace
            store={store}
            state={state}
            sessionId={sessionId}
            t={t}
            stage={stage}
            setStage={setStage}
            outputTokenLimitMode={outputTokenLimitMode}
            setOutputTokenLimitMode={setOutputTokenLimitMode}
            customMaxTokens={customMaxTokens}
            setCustomMaxTokens={setCustomMaxTokens}
            outputTokenLimit={outputTokenLimit}
            customLimitValid={customLimitValid}
            generationSelectionCurrent={generationSelectionCurrent}
            requestedKind={requestedKind}
            setRequestedKind={setRequestedKind}
          /> : <SuggestionWorkbench
            state={state}
            store={store}
            section={managementSection}
            selectedGroupId={selectedSuggestionGroupId}
            selectGroup={inspectSuggestion}
            t={t}
          />}
      inspector={<ExperienceInspector
        mode={mode}
        tab={inspectorTab}
        setTab={setInspectorTab}
        state={state}
        store={store}
        selectedSuggestion={selectedSuggestion}
        t={t}
      />}
      status={<LocalStatus state={state} t={t} />}
    />
  </div>
}

function TaskNavigation({ active, current, setActive, t }: {
  readonly active: TaskStage
  readonly current: TaskStage
  readonly setActive: (stage: TaskStage) => void
  readonly t: Translate
}) {
  return <>
    <h3 className={css.navigationTitle}>{t('task.navigation')}</h3>
    <ol className={css.stageList}>
      {TASK_STAGES.map((item, index) => {
        const state = taskStageState(item, current)
        return <li key={item}>
          <button
            type="button"
            className={css.stageButton}
            data-active={active === item || undefined}
            data-state={state}
            disabled={!taskStageReachable(item, current)}
            aria-current={active === item ? 'step' : undefined}
            onClick={() => setActive(item)}
          >
            <span className={css.stageRow}>
              <span className={css.stageMarker}>{state === 'done' ? <IconCheckOutline14 /> : index + 1}</span>
              <span>
                <span className={css.stageName}>{t(`task.stage.${item}`)}</span>
                <span className={css.stageHint}>{t(`task.stageHint.${state}`)}</span>
              </span>
            </span>
          </button>
        </li>
      })}
    </ol>
  </>
}

function ManagementNavigation({ state, store, active, setActive, t }: {
  readonly state: ReturnType<ExperienceStore['getSnapshot']>
  readonly store: ExperienceStore
  readonly active: ManagementSection
  readonly setActive: (section: ManagementSection) => void
  readonly t: Translate
}) {
  const groups = state.suggestions?.groups ?? []
  const sections: ReadonlyArray<readonly [ManagementSection, number]> = [
    ['recent_suggestions', groups.length],
    ['cross_session', groups.filter(group => group.crossSession).length],
    ['needs_attention', groups.filter(group => group.saveReadiness !== 'ready').length],
    ['candidates', state.candidates.length],
  ]
  return <>
    <div className={css.navigationHeading}>
      <h3 className={css.navigationTitle}>{t('management.pending')}</h3>
      <Button size="sm" variant="toolbar" icon={<IconRefreshOutline14 />} aria-label={t('action.refresh')}
        disabled={state.running} onClick={() => void store.refresh()} />
    </div>
    <ul className={css.candidateList} data-testid="experience-management-sections">
      {sections.map(([section, count]) => <li key={section}>
        <button type="button" className={css.candidateButton} aria-current={active === section}
          onClick={() => setActive(section)}>
          <strong>{t(`suggestion.section.${section}`)}</strong>
          <span>{count}</span>
        </button>
      </li>)}
    </ul>
    {active !== 'candidates' ? null : <>
    <p className={css.candidateCount} data-testid="experience-candidate-count">{t('inbox.count')}: {state.candidates.length}</p>
    {state.candidates.length === 0 ? <p className={css.muted}>{t('inbox.empty')}</p> : null}
    <ul className={css.candidateList}>
      {state.candidates.map(candidate => <li key={candidate.candidateId}>
        <button
          type="button"
          className={css.candidateButton}
          data-candidate-id={candidate.candidateId}
          disabled={state.running}
          aria-current={state.selected?.candidateId === candidate.candidateId}
          onClick={() => void store.select(candidate.candidateId)}
        >
          <strong>{candidate.title}</strong>
          <span>{t(`candidate.state.${candidate.state}`)} · {t('candidate.pending')} {candidate.pendingFieldCount}</span>
          <small className={css.candidateMeta}>{t(`eligibility.${candidate.eligibilityStatus}`)}</small>
        </button>
      </li>)}
    </ul>
    </>}
  </>
}

function SuggestionWorkbench({ state, store, section, selectedGroupId, selectGroup, t }: {
  readonly state: ReturnType<ExperienceStore['getSnapshot']>
  readonly store: ExperienceStore
  readonly section: SuggestionSection
  readonly selectedGroupId: string | null
  readonly selectGroup: (groupId: string) => void
  readonly t: Translate
}) {
  const projection = state.suggestions
  const allGroups = projection?.groups ?? []
  const groups = section === 'cross_session'
    ? allGroups.filter(group => group.crossSession)
    : section === 'needs_attention'
      ? allGroups.filter(group => group.saveReadiness !== 'ready')
      : allGroups
  return <div className={css.managementWorkbench} data-testid={`experience-suggestions-${section}`}>
    <header className={css.workbenchHeader}>
      <div>
        <h2>{t(`suggestion.section.${section}`)}</h2>
        <p>{t(`suggestion.description.${section}`)}</p>
      </div>
      <Pill>{groups.length}</Pill>
    </header>
    {projection?.state !== 'degraded' ? null : <p className={css.suggestionWarning} role="status">
      {t('suggestion.projectionDegraded')}
    </p>}
    {(projection?.suppressedGroupCount ?? 0) === 0 ? null : <p className={css.muted}>
      {t('suggestion.suppressed')}: {projection!.suppressedGroupCount}
    </p>}
    {section !== 'recent_suggestions' || projection === undefined ? null
      : <SessionSuggestionIndex projection={projection} groups={allGroups} selectGroup={selectGroup} t={t} />}
    {groups.length === 0 ? <section className={css.surface}>
      <div className={css.emptyState}>{t('suggestion.empty')}</div>
    </section> : <div className={css.suggestionGrid}>
      {groups.map(group => <SuggestionCard
        key={group.suggestionGroupId}
        group={group}
        selected={selectedGroupId === group.suggestionGroupId}
        running={state.running}
        store={store}
        selectGroup={selectGroup}
        t={t}
      />)}
    </div>}
  </div>
}

function SessionSuggestionIndex({ projection, groups, selectGroup, t }: {
  readonly projection: NonNullable<ReturnType<ExperienceStore['getSnapshot']>['suggestions']>
  readonly groups: readonly ExperienceSuggestionGroupView[]
  readonly selectGroup: (groupId: string) => void
  readonly t: Translate
}) {
  return <section className={css.surface} aria-labelledby="suggestion-session-index-heading">
    <div className={css.surfaceSection}>
      <h3 id="suggestion-session-index-heading">{t('suggestion.sessionIndex')}</h3>
      <div className={css.suggestionSessionIndex}>
        {projection.sessions.map(session => {
          const sessionGroups = groups.filter(group => group.sessionIds.includes(session.sessionId))
          return <details key={session.sessionId}>
            <summary>
              <span>{t('suggestion.session')} · {formatDateTime(session.sessionCreatedAt)}</span>
              <span>{sessionGroups.length === 0
                ? t(`suggestion.sessionState.${session.state}`)
                : `${sessionGroups.length} ${t('suggestion.groups')}`}</span>
            </summary>
            {sessionGroups.length === 0 ? <p className={css.muted}>{t('suggestion.noSuggestion')}</p>
              : <ul>{sessionGroups.map(group => <li key={group.suggestionGroupId}>
                <button type="button" className={css.suggestionLink}
                  onClick={() => selectGroup(group.suggestionGroupId)}>{group.title}</button>
              </li>)}</ul>}
          </details>
        })}
      </div>
    </div>
  </section>
}

function SuggestionCard({ group, selected, running, store, selectGroup, t }: {
  readonly group: ExperienceSuggestionGroupView
  readonly selected: boolean
  readonly running: boolean
  readonly store: ExperienceStore
  readonly selectGroup: (groupId: string) => void
  readonly t: Translate
}) {
  const roles = suggestionDetailRoles(group.kind)
  const path = suggestionComponent(group, roles.path)
  const precondition = suggestionComponent(group, roles.precondition)
  const failure = suggestionComponent(group, roles.failure)
  const verifier = suggestionComponent(group, roles.verifier)
  const sourceCount = new Set(group.occurrences.flatMap(occurrence =>
    occurrence.sourceRefs.map(ref => ref.sourceRefId))).size
  return <article className={css.suggestionCard} aria-current={selected || undefined}
    data-testid="experience-suggestion-card" data-suggestion-group-id={group.suggestionGroupId}>
    <header className={css.suggestionCardHeader}>
      <div>
        <h3>{group.title}</h3>
        <p>{t(`experienceKind.${group.kind}`)} · {t(`suggestion.consolidation.${group.consolidation}`)}
          {group.crossSession ? ` · ${t('suggestion.crossSession')}` : ''}</p>
      </div>
      <Pill>{t(`suggestion.readiness.${group.saveReadiness}`)}</Pill>
    </header>
    <div className={css.suggestionCounts}>
      <span>{t('suggestion.occurrences')}: {group.occurrenceCount}</span>
      <span>{t('suggestion.sessions')}: {group.sessionIds.length}</span>
      <span>{t('suggestion.sources')}: {sourceCount}</span>
    </div>
    <dl className={css.suggestionDetails}>
      <dt>{t('suggestion.goal')}</dt><dd>{group.draft.intent}</dd>
      <dt>{t('suggestion.path')}</dt><dd>{path}</dd>
      <dt>{t('suggestion.precondition')}</dt><dd>{precondition}</dd>
      <dt>{t('suggestion.failure')}</dt><dd>{failure}</dd>
      <dt>{t('suggestion.verifier')}</dt><dd>{verifier}</dd>
      <dt>{t('suggestion.risk')}</dt><dd>{group.riskFlags.map(flag => t(suggestionRiskKey(flag))).join('；')}</dd>
    </dl>
    {group.saveReadiness === 'ready' ? <p className={css.suggestionNotice} role="status">
      {group.consolidation === 'semantic_duplicate'
        ? <>{t('suggestion.semanticDuplicateAttach')} {t('suggestion.semanticDuplicateTarget')}：
          <strong>{group.canonicalMatch?.title ?? t('field.empty')}</strong></>
        : t('suggestion.saveReady')}
    </p> : <p className={css.suggestionWarning} role="status">
      {t('suggestion.needsAttention')}: {suggestionReadinessExplanation(group, t)}
    </p>}
    <div className={css.actionRow}>
      {group.saveReadiness !== 'ready' ? null : <Button variant="primary" disabled={running}
        onClick={() => void store.saveSuggestion(group)}>
        {t('suggestion.action.save')}
      </Button>}
      {group.consolidationDetail?.allowedOwnerChoices.map(choice => <Button key={choice}
        variant="primary" disabled={running}
        onClick={() => void store.saveSuggestion(group, suggestionOwnerChoice(group, choice))}>
        {t(choice === 'attach_existing'
          ? 'suggestion.action.attachExisting' : 'suggestion.action.keepDistinct')}
      </Button>)}
      <Button disabled={running} onClick={() => selectGroup(group.suggestionGroupId)}>
        {t('suggestion.action.details')}
      </Button>
      <Button disabled={running} onClick={() => void store.dismissSuggestion(group, 'not_reusable')}>
        {t('suggestion.action.dismiss')}
      </Button>
    </div>
  </article>
}

function suggestionOwnerChoice(
  group: ExperienceSuggestionGroupView,
  choice: SuggestionOwnerChoiceInput['choice'],
): SuggestionOwnerChoiceInput {
  const detail = group.consolidationDetail
  if (detail?.targetExperienceVersionId === null || detail?.targetExperienceVersionId === undefined) {
    throw new Error('Suggestion duplicate target is unavailable')
  }
  return {
    choice,
    targetExperienceVersionId: detail.targetExperienceVersionId,
    materialDifferences: choice === 'keep_distinct' ? detail.materialDifferences : [],
  }
}

function suggestionComponent(
  group: ExperienceSuggestionGroupView,
  roles: readonly ComponentRole[],
): string {
  for (const role of roles) {
    const component = group.draft.components.find(item => item.role === role)
    if (component !== undefined) return component.content
  }
  return '—'
}

function suggestionDetailRoles(kind: ExperienceKind): Readonly<Record<
  'path' | 'precondition' | 'failure' | 'verifier', readonly ComponentRole[]
>> {
  switch (kind) {
    case 'procedure': return {
      path: ['step'], precondition: ['entry_condition'],
      failure: ['failure_branch', 'forbidden_condition'], verifier: ['verifier'],
    }
    case 'diagnostic': return {
      path: ['resolution_candidate', 'branch'], precondition: ['discriminator', 'environment_scope'],
      failure: ['falsifier', 'misleading_signal'], verifier: ['recovery_verifier'],
    }
    case 'preference_policy': return {
      path: ['directive', 'modality'], precondition: ['task_or_output_scope', 'subject_scope'],
      failure: ['override_policy', 'exception', 'no_known_exception'], verifier: ['authority_source', 'valid_from'],
    }
    case 'fact': return {
      path: ['object_or_value', 'predicate'], precondition: ['qualifiers', 'valid_from'],
      failure: ['contradiction_policy'], verifier: ['source_evidence'],
    }
    case 'strategy': return {
      path: ['candidate_option'], precondition: ['hard_constraint', 'decision_criterion'],
      failure: ['stop_exploration_rule', 'escalation_rule'], verifier: ['outcome_measure'],
    }
    case 'causal': return {
      path: ['cause_or_intervention', 'effect_or_metric'], precondition: ['applicability_condition', 'mechanism'],
      failure: ['competing_explanation', 'falsifier'], verifier: ['causal_grade', 'evidence_link'],
    }
  }
}

function suggestionRiskKey(flag: string): ExperienceLocaleKey {
  if (flag === 'current_permission_required') return 'suggestion.risk.currentPermission'
  if (flag === 'freshness_revalidation_required') return 'suggestion.risk.freshness'
  if (flag === 'human_decision_required') return 'suggestion.risk.humanDecision'
  if (flag === 'causal_promotion_required') return 'suggestion.risk.causalPromotion'
  if (flag === 'current_user_authority_required') return 'suggestion.risk.currentUserAuthority'
  return 'suggestion.risk.noExecutionAuthority'
}

function suggestionReadinessExplanation(group: ExperienceSuggestionGroupView, t: Translate): string {
  if (group.readinessReasons.includes('semantic_duplicate_vector_only_unverified')) {
    return t('suggestion.reason.semanticVectorOnly')
  }
  if (group.readinessReasons.includes('semantic_duplicate_ambiguous')) {
    return t('suggestion.reason.semanticAmbiguous')
  }
  if (group.readinessReasons.includes('semantic_specialization_review')) {
    return t('suggestion.reason.semanticSpecialization')
  }
  if (group.saveReadiness === 'needs_review') return t('suggestion.reason.needsReview')
  if (group.saveReadiness === 'needs_enrichment') return t('suggestion.reason.needsEnrichment')
  return t('suggestion.reason.blocked')
}

function LocalStatus({ state, t }: {
  readonly state: ReturnType<ExperienceStore['getSnapshot']>
  readonly t: Translate
}) {
  const status = state.phase === 'ready' ? 'done' : state.phase === 'loading' ? 'ongoing' : 'error'
  const statusText = state.phase === 'loading' ? t('state.loading')
    : state.phase === 'ready' ? t('state.ready') : `${t('state.error')}: ${state.error ?? ''}`
  return <div className={css.statusGrid} role={state.phase === 'error' ? 'alert' : 'status'}>
    <div className={css.statusItem}>
      <span className={css.statusLabel}>{t('status.host')}</span>
      <span className={css.statusValue}><StateDot state={status} /><span>{statusText}</span></span>
    </div>
    <div className={css.statusItem}>
      <span className={css.statusLabel}>{t('field.principal')}</span>
      <span className={css.statusValue}><span data-testid="experience-principal">{state.status?.principalId ?? t('field.empty')}</span></span>
    </div>
    <div className={css.statusItem}>
      <span className={css.statusLabel}>{t('field.receipt')}</span>
      <span className={css.statusValue}><span data-testid="experience-latest-receipt">{state.receipt?.receiptId ?? t('field.empty')}</span></span>
    </div>
    <div className={css.statusItem}>
      <span className={css.statusLabel}>{t('field.version')}</span>
      <span className={css.statusValue}><span data-testid="experience-latest-version">{state.version?.experienceVersionId ?? t('field.empty')}</span></span>
    </div>
    <div className={css.statusItem}>
      <span className={css.statusLabel}>{t('status.semanticModel')}</span>
      <span className={css.statusValue} data-testid="experience-retrieval-provider-state">
        <StateDot state={state.retrieval?.manifest.providerState === 'ready' ? 'done'
          : state.retrieval?.manifest.providerState === 'unavailable' ? 'error' : 'ongoing'} />
        <span>{state.retrieval === undefined ? t('field.empty')
          : `${t(`status.semanticModel.${state.retrieval.manifest.providerState}`)} · ${state.retrieval.manifest.documentCount}`}</span>
      </span>
    </div>
  </div>
}

function ManagementWorkspace({
  store,
  state,
  sessionId,
  t,
  stage,
  setStage,
  outputTokenLimitMode,
  setOutputTokenLimitMode,
  customMaxTokens,
  setCustomMaxTokens,
  outputTokenLimit,
  customLimitValid,
  generationSelectionCurrent,
  requestedKind,
  setRequestedKind,
}: {
  readonly store: ExperienceStore
  readonly state: ReturnType<ExperienceStore['getSnapshot']>
  readonly sessionId: string
  readonly t: Translate
  readonly stage: CandidateFieldView['stage']
  readonly setStage: (stage: CandidateFieldView['stage']) => void
  readonly outputTokenLimitMode: ProposalOutputTokenLimitInput['mode']
  readonly setOutputTokenLimitMode: (mode: ProposalOutputTokenLimitInput['mode']) => void
  readonly customMaxTokens: number
  readonly setCustomMaxTokens: (value: number) => void
  readonly outputTokenLimit: ProposalOutputTokenLimitInput
  readonly customLimitValid: boolean
  readonly generationSelectionCurrent: boolean
  readonly requestedKind: ExperienceKind
  readonly setRequestedKind: (kind: ExperienceKind) => void
}) {
  const disclosure = state.inspection?.disclosure
  const disclosedItems = state.inspection?.evidencePacket.items ?? []
  const disclosureComplete = disclosure !== undefined && disclosure.evidenceItemCount === disclosedItems.length
  const confirmed = disclosure !== undefined
    && state.confirmedDisclosureDigest === disclosure.disclosureDigest
    && outputTokenLimitEquals(state.inspection?.outputTokenLimit, outputTokenLimit)
  return <div className={css.managementWorkbench}>
    <header className={css.workbenchHeader}>
      <div>
        <h2>{state.selected?.title ?? t('management.pending')}</h2>
        <p>{state.selected === undefined ? t('management.selectCandidate') : t('management.reviewDescription')}</p>
      </div>
      {state.selected === undefined ? null : <Pill>{t(`candidate.state.${state.selected.state}`)}</Pill>}
    </header>
    <section className={css.surface} aria-labelledby="episode-heading">
      <div className={css.surfaceSection}>
        <h3 id="episode-heading">{t('episode.title')}</h3>
        <p className={css.muted}>{t('episode.description')}</p>
        <fieldset disabled={state.running} className={css.generationSettings}>
          <legend>{t('disclosure.outputTokenSetting')}</legend>
          <label>{t('candidate.kind')}
            <select
              aria-label={t('candidate.kind')}
              name="experience-requested-kind"
              value={requestedKind}
              onChange={event => setRequestedKind(event.currentTarget.value as ExperienceKind)}
            >
              {EXPERIENCE_KINDS.map(kind => <option key={kind} value={kind}>{t(`experienceKind.${kind}`)}</option>)}
            </select>
          </label>
          <select
            aria-label={t('disclosure.outputTokenSetting')}
            name="experience-output-token-mode"
            value={outputTokenLimitMode}
            onChange={event => setOutputTokenLimitMode(event.currentTarget.value as ProposalOutputTokenLimitInput['mode'])}
          >
            <option value="configured_default">{t('disclosure.outputTokenMode.configured_default')}</option>
            <option value="provider_default">{t('disclosure.outputTokenMode.provider_default')}</option>
            <option value="custom">{t('disclosure.outputTokenMode.custom')}</option>
          </select>
          {outputTokenLimitMode !== 'custom' ? null : (
            <input
              aria-label={t('disclosure.outputTokenMode.custom')}
              name="experience-custom-output-token-limit"
              autoComplete="off"
              type="number"
              min={1_024}
              max={32_768}
              step={1_024}
              value={customMaxTokens}
              onChange={event => setCustomMaxTokens(event.currentTarget.valueAsNumber)}
            />
          )}
        </fieldset>
        {!generationSelectionCurrent ? <p role="status">{t('disclosure.reinspectRequired')}</p> : null}
        <div className={css.actionRow}>
          <Button
            variant="primary"
            disabled={state.running || !customLimitValid}
            onClick={() => void store.inspect(sessionId, requestedKind, outputTokenLimit)}
          >{t('action.inspectWithSettings')}</Button>
        </div>
      </div>
      {disclosure === undefined ? null : (
        <div className={css.surfaceSection}>
          <ProposalStatus state={state} disclosure={disclosure} t={t} />
          <EligibilitySummary inspection={state.inspection!} t={t} />
          <div className={css.inlineFacts}>
            <div className={css.fact}><span className={css.factLabel}>{t('disclosure.route')}</span>
              <span className={css.factValue} data-testid="experience-disclosure-route">{disclosure.provider} / {disclosure.model}</span></div>
            <div className={css.fact}><span className={css.factLabel}>{t('disclosure.sourceRecords')}</span>
              <span className={css.factValue} data-testid="experience-disclosure-records"
                data-source-record-count={disclosure.sourceRecordCount}
                data-evidence-item-count={disclosure.evidenceItemCount}
                data-omitted-entry-count={disclosure.omittedEntryCount}>
                {disclosure.sourceRecordCount} · {t('disclosure.items')} {disclosure.evidenceItemCount}
              </span></div>
            <div className={css.fact}><span className={css.factLabel}>{t('disclosure.reasoning')}</span>
              <span className={css.factValue} data-testid="experience-disclosure-generation">{disclosure.reasoningEffort} · {t(`disclosure.outputTokenMode.${disclosure.outputTokenLimitMode}`)} · {displayTokenLimit(disclosure.maxOutputTokens, t)}</span></div>
            <div className={css.fact}><span className={css.factLabel}>{t('disclosure.estimatedTokens')}</span>
              <span className={css.factValue} data-testid="experience-disclosure-budget">{disclosure.estimatedInputTokens}</span></div>
          </div>
          <OmissionDetails omissions={state.inspection!.evidencePacket.omissions} t={t} />
          {!disclosureComplete ? <p role="alert">{t('disclosure.incomplete')}</p> : null}
          <DisclosureSummary items={disclosedItems} t={t} />
          <details data-testid="experience-disclosure-preview">
            <summary>{t('disclosure.preview')}: {disclosure.evidenceItemCount}</summary>
            <DisclosureItems items={disclosedItems} t={t} />
          </details>
          <details>
            <summary>{t('disclosure.technicalDetails')}</summary>
            <p>{disclosure.promptVersion} · {disclosure.schemaVersion} · {disclosure.policyVersion}</p>
            <p data-testid="experience-disclosure-result-tool">{t('disclosure.resultTool')}: {disclosure.resultToolName}</p>
            <p data-testid="experience-disclosure-result-schema" className={css.digest}>{t('disclosure.resultSchemaDigest')}: {disclosure.resultSchemaDigest}</p>
            <p data-testid="experience-disclosure-digest" className={css.digest}>{t('disclosure.digest')}: {disclosure.sourceInputDigest}</p>
            <p data-testid="experience-disclosure-settings-revision" className={css.digest}>{t('disclosure.settingsRevision')}: {disclosure.settingsRevision ?? '—'}</p>
            <p data-testid="experience-disclosure-settings-digest" className={css.digest}>{t('disclosure.settingsDigest')}: {disclosure.settingsDigest}</p>
            <p data-testid="experience-disclosure-confirmation-digest" className={css.digest}>{t('disclosure.confirmationDigest')}: {disclosure.disclosureDigest}</p>
          </details>
          <label className={css.checkboxRow}>
            <input type="checkbox" checked={confirmed} disabled={!disclosureComplete}
              onChange={event => store.confirmDisclosure(disclosure.disclosureDigest, event.currentTarget.checked)} />
            <span>{t('disclosure.confirm')}</span>
          </label>
          <div className={css.actionRow}>
            <Button
              variant="primary"
              disabled={state.running || !confirmed || !disclosureComplete || state.inspection!.publicationMode === 'not_allowed'}
              onClick={() => void store.propose()}
            >{state.proposalStatus === 'generating' ? t('action.proposing') : t('action.propose')}</Button>
          </div>
        </div>
      )}
    </section>
    {state.selected === undefined ? <section className={css.surface}><div className={css.emptyState}>{t('candidate.noneSelected')}</div></section> : (
      <section className={css.surface}><div className={css.surfaceSection}>
        <CandidateEditor key={state.selected.candidateId} candidate={state.selected} stage={stage}
          running={state.running} t={t} setStage={setStage} store={store} error={state.error} />
      </div></section>
    )}
    {state.version === undefined ? null : <MarkdownPanel state={state} store={store} t={t} />}
    {state.version === undefined ? null : <ForgetPanel state={state} store={store} t={t} />}
  </div>
}

function MarkdownPanel({ state, store, t }: {
  readonly state: ReturnType<ExperienceStore['getSnapshot']>
  readonly store: ExperienceStore
  readonly t: Translate
}) {
  const [edited, setEdited] = useState('')
  const [reason, setReason] = useState('Reviewed the structured Markdown diff')
  useEffect(() => setEdited(state.markdownProjection?.markdown ?? ''), [state.markdownProjection?.receipt.projectionDigest])
  const proposal = state.markdownRevision
  return <section className={css.surface} aria-labelledby="markdown-heading" data-testid="experience-markdown">
    <div className={css.surfaceSection}>
      <h3 id="markdown-heading">{t('markdown.title')}</h3>
      <p className={css.muted}>{t('markdown.description')}</p>
      <div className={css.actionRow}><Button variant="primary" disabled={state.running}
        data-testid="experience-markdown-export" onClick={() => void store.exportMarkdown()}>
        {t('markdown.export')}
      </Button></div>
      {state.markdownProjection === undefined ? null : <>
        <p className={css.digest}>{t('markdown.receipt')}: {state.markdownProjection.receipt.markdownProjectionReceiptId}</p>
        <label className={css.fieldLabel}>{t('markdown.editor')}
          <textarea className={css.recordContent} value={edited}
            onChange={event => setEdited(event.currentTarget.value)} />
        </label>
        <p role="status" className={css.notice}>{t('markdown.proposalOnly')}</p>
        <Button variant="primary" disabled={state.running || edited === state.markdownProjection.markdown || edited.trim() === ''}
          data-testid="experience-markdown-propose" onClick={() => void store.proposeMarkdownRevision(edited)}>
          {t('markdown.propose')}
        </Button>
      </>}
      {proposal === undefined ? null : <div data-testid="experience-markdown-revision">
        <h4>{t('revision.title')} · {t(`revision.state.${proposal.state}`)}</h4>
        <label className={css.fieldLabel}>{t('revision.reason')}
          <input value={reason} onChange={event => setReason(event.currentTarget.value)} />
        </label>
        <ul className={css.resultList}>{proposal.changes.map(change => <li key={change.revisionChangeId}>
          <strong>{componentRoleText(change.semanticRole, t)}</strong> · {t(`revision.decision.${change.decision}`)}
          <p>{change.replacementContent}</p>
          {change.decision !== 'pending' ? null : <div className={css.actionRow}>
            <Button variant="primary" disabled={state.running || reason.trim() === ''}
              onClick={() => void store.decideRevision(change.revisionChangeId, 'accept', reason.trim())}>{t('revision.accept')}</Button>
            <Button disabled={state.running || reason.trim() === ''}
              onClick={() => void store.decideRevision(change.revisionChangeId, 'reject', reason.trim())}>{t('revision.reject')}</Button>
          </div>}
        </li>)}</ul>
        <Button variant="primary" disabled={state.running || proposal.state !== 'accepted'}
          onClick={() => void store.publishRevision()}>{t('revision.publish')}</Button>
      </div>}
    </div>
  </section>
}

function ForgetPanel({ state, store, t }: {
  readonly state: ReturnType<ExperienceStore['getSnapshot']>
  readonly store: ExperienceStore
  readonly t: Translate
}) {
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  useEffect(() => setConfirmed(false), [state.forgetPreview?.previewDigest])
  const preview = state.forgetPreview
  const request = state.forgetRequest?.experienceId === state.version?.experienceId
    ? state.forgetRequest : undefined
  return <section className={css.surface} aria-labelledby="forget-heading" data-testid="experience-forget">
    <div className={css.surfaceSection}>
      <h3 id="forget-heading">{t('forget.title')}</h3>
      <p className={css.muted}>{t('forget.description')}</p>
      {request === undefined ? null : <div role="status" data-testid="experience-forget-readback">
        <h4>{t('forget.result')}: {t(`forget.state.${request.state}`)}</h4>
        <ul className={css.resultList}>{request.steps.map(step => <li key={step.stepResultId}>
          <strong>{t(`forget.phase.${step.phase}`)}</strong> · {t(`forget.status.${step.status}`)} · {t(forgetReasonLabel(step.reasonCode))}
        </li>)}</ul>
      </div>}
      {request !== undefined ? null : <>
        <Button variant="primary" disabled={state.running} data-testid="experience-forget-preview"
          onClick={() => void store.previewForget()}>{t('forget.preview')}</Button>
        {preview === undefined ? null : <div className={css.forgetPreview} data-testid="experience-forget-impact">
          <h4>{t('forget.previewTitle')}</h4>
          <dl>
            <dt>{t('forget.futureRecall')}</dt><dd>{t('forget.futureRecall.stop')}</dd>
            <dt>{t('forget.versionCount')}</dt><dd>{preview.versionCount}</dd>
            <dt>{t('forget.activeContexts')}</dt><dd>{preview.activeContextTargets.length}</dd>
            <dt>{t('forget.immutableHistory')}</dt><dd>{preview.immutableHistory.map(item => t(`forget.history.${item}`)).join(' · ')}</dd>
            <dt>{t('forget.vault')}</dt><dd>{t('forget.vault.notApplicable')}</dd>
          </dl>
          <label className={css.fieldLabel}>{t('forget.reason')}
            <textarea value={reason} placeholder={t('forget.reasonPlaceholder')}
              onChange={event => setReason(event.currentTarget.value)} />
          </label>
          <label className={css.checkboxRow}>
            <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.currentTarget.checked)} />
            <span>{t('forget.confirm')}</span>
          </label>
          <Button variant="primary" disabled={state.running || !confirmed || reason.trim() === ''}
            data-testid="experience-forget-commit" onClick={() => void store.forgetExperience(reason)}>
            {t('forget.commit')}
          </Button>
        </div>}
      </>}
    </div>
  </section>
}

function ExperienceInspector({ mode, tab, setTab, state, store, selectedSuggestion, t }: {
  readonly mode: ExperienceMode
  readonly tab: InspectorTab
  readonly setTab: (tab: InspectorTab) => void
  readonly state: ReturnType<ExperienceStore['getSnapshot']>
  readonly store: ExperienceStore
  readonly selectedSuggestion: ExperienceSuggestionGroupView | undefined
  readonly t: Translate
}) {
  return <>
    <div className={css.tabs} role="tablist" aria-label={t('inspector.title')}>
      {(['overview', 'sources', 'history', 'technical'] as const).map(item => (
        <Pill key={item} active={tab === item} role="tab" aria-selected={tab === item}
          onClick={() => setTab(item)}>{t(`inspector.tab.${item}`)}</Pill>
      ))}
    </div>
    {tab === 'overview' ? <>
      <section className={css.inspectorSection}>
        <h4>{mode === 'task' ? t('task.current') : t('management.current')}</h4>
        <p>{mode === 'task'
          ? state.selectedPlanning?.fingerprint.intent ?? t('planning.empty')
          : selectedSuggestion?.title ?? state.selected?.title ?? t('candidate.noneSelected')}</p>
        {mode !== 'management' || selectedSuggestion === undefined ? null
          : <p>{t(`suggestion.readiness.${selectedSuggestion.saveReadiness}`)} · {t(`experienceKind.${selectedSuggestion.kind}`)}</p>}
      </section>
      <section className={css.inspectorSection}>
        <h4>{t('inspector.authority')}</h4>
        <dl>
          <dt>{t('field.principal')}</dt><dd>{state.status?.principalId ?? t('field.empty')}</dd>
          <dt>{t('field.receipt')}</dt><dd>{state.receipt?.receiptId ?? t('field.empty')}</dd>
          <dt>{t('field.version')}</dt><dd>{state.version?.experienceVersionId ?? t('field.empty')}</dd>
        </dl>
      </section>
      {mode === 'task' && state.selectedPlanning !== undefined
        ? <PlanningRecommendationInspector state={state} t={t} /> : null}
      {mode === 'task' && state.selectedExecution !== undefined
        ? <ExecutionInspectorOverview execution={state.selectedExecution} t={t} /> : null}
      {state.version === undefined || state.version.legacyWarnings.length === 0 ? null : (
        <section className={css.inspectorSection} role="status" data-testid="experience-version-legacy-warnings">
          <h4>{t('version.legacyWarnings')}</h4>
          <ul>{state.version.legacyWarnings.map(warning => <li key={warning}>{t(legacyWarningLabel(warning))}</li>)}</ul>
        </section>
      )}
    </> : null}
    {tab === 'sources' ? <>
      {selectedSuggestion === undefined ? null : <section className={css.inspectorSection}
        data-testid="experience-inspector-suggestion-sources">
        <h4>{t('suggestion.inspector.sources')}</h4>
        {selectedSuggestion.occurrences.map(occurrence => <div key={occurrence.occurrenceId}>
          <p><strong>{t('suggestion.session')}</strong> · <time dateTime={occurrence.detectedAt}>{formatDateTime(occurrence.detectedAt)}</time></p>
          <p>{t('field.eventRange')}: {occurrence.episodeRef.eventStart}–{occurrence.episodeRef.eventEnd}</p>
          <SourceRefList refs={occurrence.sourceRefs} t={t} />
        </div>)}
      </section>}
      <section className={css.inspectorSection}>
        <h4>{t('inspector.episode')}</h4>
        {state.inspection === undefined ? <p className={css.muted}>{t('field.empty')}</p> : <>
          <p data-testid="experience-episode-records">{t('disclosure.records')}: {state.inspection.episode.recordCount}</p>
          <EvidenceRecords records={[...state.inspection.episode.records, ...state.inspection.outcomeRecords, ...state.inspection.historicalRecords]} t={t} />
        </>}
      </section>
      <section className={css.inspectorSection}>
        <h4>{t('inspector.candidate')}</h4>
        {state.selected === undefined ? <p className={css.muted}>{t('field.empty')}</p> : <SourceRefList refs={state.selected.sourceRefs} t={t} />}
      </section>
      {mode === 'task' && state.selectedExecution !== undefined
        ? <ExecutionInspectorSources execution={state.selectedExecution} t={t} /> : null}
    </> : null}
    {tab === 'history' ? <>
      {(state.suggestions?.dispositions.length ?? 0) === 0 ? null : <section className={css.inspectorSection}
        data-testid="experience-inspector-suggestion-history">
        <h4>{t('suggestion.inspector.decisions')}</h4>
        <ul className={css.resultList}>{state.suggestions!.dispositions.map(disposition => <li key={disposition.projectionReceiptId}>
          <strong>{t(`suggestion.decision.${disposition.decision}`)}</strong>
          {' · '}<time dateTime={disposition.decidedAt}>{formatDateTime(disposition.decidedAt)}</time>
        </li>)}</ul>
      </section>}
      <section className={css.inspectorSection}>
        <h4>{t('planning.history')}: {state.planningResults.length}</h4>
        {state.planningResults.length === 0 ? <p className={css.muted}>{t('planning.empty')}</p> : null}
        {state.planningResults.map(item => <button type="button" key={item.plan.usageId}
          className={css.historyButton} aria-current={state.selectedPlanning?.plan.usageId === item.plan.usageId}
          disabled={state.running} onClick={() => void store.selectPlanning(item.plan.usageId)}>
          <strong>{item.fingerprint.intent}</strong>
          <small>{item.plan.disposition} · {item.approvalRequest?.status ?? t('planning.noApproval')}</small>
        </button>)}
      </section>
      {mode === 'task' && state.selectedExecution !== undefined
        ? <ExecutionInspectorHistory execution={state.selectedExecution} t={t} /> : null}
      {state.forgetRequest === undefined ? null : <section className={css.inspectorSection} data-testid="experience-inspector-forget-history">
        <h4>{t('forget.latest')}</h4>
        <p><strong>{t('forget.result')}</strong> · {t(`forget.state.${state.forgetRequest.state}`)} · <time dateTime={state.forgetRequest.requestedAt}>{formatDateTime(state.forgetRequest.requestedAt)}</time></p>
        <ul className={css.resultList}>{state.forgetRequest.steps.map(step => <li key={step.stepResultId}>
          <strong>{t(`forget.phase.${step.phase}`)}</strong> · {t(`forget.status.${step.status}`)} · {t(forgetReasonLabel(step.reasonCode))}
        </li>)}</ul>
      </section>}
      <AuditInspector state={state} store={store} t={t} />
    </> : null}
    {tab === 'technical' ? <>
      {selectedSuggestion === undefined ? null : <section className={css.inspectorSection}
        data-testid="experience-inspector-suggestion-technical">
        <h4>{t('suggestion.inspector.identity')}</h4>
        <dl>
          <dt>{t('suggestion.inspector.groupId')}</dt><dd>{selectedSuggestion.suggestionGroupId}</dd>
          <dt>{t('suggestion.inspector.kernel')}</dt><dd>{selectedSuggestion.kernelIdentity}</dd>
          <dt>{t('suggestion.inspector.revision')}</dt><dd>{selectedSuggestion.revisionDigest}</dd>
          <dt>{t('suggestion.inspector.review')}</dt><dd>{selectedSuggestion.reviewDigest ?? t('field.empty')}</dd>
          <dt>{t('suggestion.inspector.detector')}</dt><dd>{selectedSuggestion.detectorVersions.join(', ')}</dd>
          <dt>{t('suggestion.inspector.materializer')}</dt><dd>{selectedSuggestion.materializerVersion}</dd>
          <dt>{t('suggestion.inspector.reasons')}</dt><dd>{selectedSuggestion.readinessReasons.join(', ') || t('field.empty')}</dd>
          <dt>{t('suggestion.inspector.missing')}</dt><dd>{selectedSuggestion.missingFields.join(', ') || t('field.empty')}</dd>
          <dt>{t('suggestion.inspector.related')}</dt><dd>{selectedSuggestion.relatedGroupIds.join(', ') || t('field.empty')}</dd>
          <dt>{t('suggestion.inspector.relatedVersions')}</dt>
          <dd>{selectedSuggestion.relatedExperienceVersionIds?.join(', ') || t('field.empty')}</dd>
          <dt>{t('suggestion.inspector.equivalenceDecision')}</dt>
          <dd>{selectedSuggestion.consolidationDetail?.decision ?? t('field.empty')}</dd>
          <dt>{t('suggestion.inspector.comparisonSet')}</dt>
          <dd>{selectedSuggestion.consolidationDetail?.activeComparisonSetDigest ?? t('field.empty')}</dd>
          <dt>{t('suggestion.inspector.correspondence')}</dt>
          <dd>{selectedSuggestion.consolidationDetail?.componentCorrespondence.length ?? 0}</dd>
        </dl>
      </section>}
      <section className={css.inspectorSection}>
        <h4>{t('inspector.technical')}</h4>
        <dl>
          <dt>{t('planning.planId')}</dt><dd data-testid="experience-inspector-plan-id">{state.selectedPlanning?.plan.usagePlanId ?? t('field.empty')}</dd>
          <dt>{t('planning.usageId')}</dt><dd>{state.selectedPlanning?.plan.usageId ?? t('field.empty')}</dd>
          <dt>{t('planning.digest')}</dt><dd>{state.selectedPlanning?.plan.contentDigest ?? t('field.empty')}</dd>
        </dl>
      </section>
      {state.inspection === undefined ? null : <section className={css.inspectorSection}>
        <h4>{t('inspector.episode')}</h4>
        <p data-testid="experience-episode-digest" className={css.digest}>{state.inspection.episode.episodeRef.contentDigest}</p>
      </section>}
      {state.selected === undefined ? null : <section className={css.inspectorSection}>
        <h4>{t('inspector.candidate')}</h4>
        <p>{state.selected.proposal.provider} / {state.selected.proposal.model}</p>
        <p data-testid="experience-proposal-session" className={css.digest}>{t('inspector.proposalSession')}: {state.selected.proposal.proposalSessionId}</p>
        <p className={css.digest}>{state.selected.proposal.sourceInputDigest}</p>
        <p className={css.digest}>{state.selected.proposal.disclosureDigest}</p>
      </section>}
      {mode === 'task' && state.selectedExecution !== undefined
        ? <ExecutionInspectorTechnical execution={state.selectedExecution} t={t} /> : null}
      {state.learning === undefined ? null : <LearningInspectorTechnical
        learning={state.learning}
        governance={state.learningGovernance}
        store={store}
        running={state.running}
        t={t}
      />}
      <RelationMapInspector state={state} store={store} t={t} />
      <EvaluationInspector state={state} store={store} t={t} />
      {state.forgetRequest === undefined ? null : <ForgetInspectorTechnical request={state.forgetRequest} t={t} />}
    </> : null}
  </>
}

/** Derived recommendation reason and per-version facts; raw codes stay in technical details. */
function PlanningRecommendationInspector({ state, t }: {
  readonly state: ReturnType<ExperienceStore['getSnapshot']>
  readonly t: Translate
}) {
  const planning = state.selectedPlanning
  return <section className={css.inspectorSection} data-testid="experience-inspector-planning-recommendation">
    <h4>{t('inspector.planningRecommendation')}</h4>
    {planning === undefined || planning.matchSet.candidates.length === 0
      ? <p className={css.muted}>{t('planning.noMatch')}</p>
      : <ul className={css.resultList}>{planning.matchSet.candidates.map(candidate => {
          const preflight = planning.preflights.find(item => item.experienceVersionId === candidate.experienceVersionId)
          const reasonText = planningReasonText(candidate, preflight, t)
          const environmentText = preflight === undefined || preflight.observations.length === 0
            ? t('planning.environment.noFacts')
            : preflight.observations.map(observation =>
                `${t(observationStatusLabel(observation.status))}：${observation.summary}`).join('；')
          return <li key={candidate.experienceVersionId}>
            <strong>{candidate.title}</strong>
            <p>{reasonText}</p>
            <p>{environmentText}</p>
            <p>{t(planningNextActionKey(planning, candidate, preflight))}</p>
          </li>
        })}</ul>}
    <details>
      <summary>{t('inspector.technicalReasonCodes')}</summary>
      <ul className={css.resultList}>{planning === undefined
        ? null
        : planning.matchSet.candidates.map(candidate => {
            const preflight = planning.preflights.find(item => item.experienceVersionId === candidate.experienceVersionId)
            return <li key={candidate.experienceVersionId}>
              <strong>{candidate.title}</strong>
              <p className={css.digest}>{candidate.reasonCodes.join(', ') || t('field.empty')}</p>
              <p className={css.digest}>{t('planning.retrieval.scores')}: BM25 {candidate.lexicalBm25Score ?? '—'} · cosine {candidate.semanticScore ?? '—'} · RRF {candidate.fusedScore ?? '—'}</p>
              {preflight === undefined ? null : <>
                <p className={css.digest}>{t('inspector.reasonCode')}: {preflight.reasonCodes.join(', ') || t('field.empty')}</p>
                <p className={css.digest}>{t('candidate.blockers')}: {preflight.blockers.join(', ') || t('field.empty')}</p>
              </>}
            </li>
          })}</ul>
      {planning?.matchSet.retrievalDecision === undefined ? null : <p className={css.digest}>
        {t('planning.retrieval.generation')}: {planning.matchSet.retrievalDecision.projectionGeneration ?? '—'} · {t('planning.retrieval.dense')}: {planning.matchSet.retrievalDecision.denseState}
        {planning.matchSet.retrievalDecision.abstentionReasonCodes.length === 0 ? null
          : ` · ${t('planning.retrieval.abstention')}: ${planning.matchSet.retrievalDecision.abstentionReasonCodes.join(', ')}`}
      </p>}
    </details>
  </section>
}

function RelationMapInspector({ state, store, t }: {
  readonly state: ReturnType<ExperienceStore['getSnapshot']>
  readonly store: ExperienceStore
  readonly t: Translate
}) {
  const map = state.relationMap
  const readiness = state.infrastructureReadiness
  return <section className={css.inspectorSection} data-testid="experience-relation-map">
    <h4>{t('relationMap.title')}</h4>
    {map === undefined ? <p className={css.muted}>{t('field.empty')}</p> : <>
      <dl><dt>{t('relationMap.nodes')}</dt><dd>{map.nodes.length}</dd>
        <dt>{t('relationMap.edges')}</dt><dd>{map.edges.length}</dd>
        <dt>{t('planning.digest')}</dt><dd className={css.digest}>{map.generationDigest}</dd></dl>
      {map.edges.length === 0 ? <p className={css.muted}>{t('relationMap.empty')}</p>
        : <ol className={css.relationCanvas} aria-label={t('relationMap.connections')}>
          {map.edges.map(edge => <li key={edge.relationId} className={css.relationEdge}>
            <span className={css.relationNode}><strong>{edge.source.kind}</strong><small>{edge.source.id}</small></span>
            <span className={css.relationConnector}>
              <span>{edge.relationType}</span><span aria-hidden="true">→</span>
              {edge.causalStatus === 'not_causal' ? null : <small>{t(`relationMap.causal.${edge.causalStatus}`)}</small>}
            </span>
            <span className={css.relationNode}><strong>{edge.target.kind}</strong><small>{edge.target.id}</small></span>
          </li>)}
        </ol>}
      {map.textFallback.length === 0 ? null : <details>
        <summary>{t('relationMap.textFallback')}</summary>
        {map.textFallback.map(line => <p key={line} className={css.digest}>{line}</p>)}
      </details>}
    </>}
    <h4>{t('readiness.title')}</h4>
    <p>{t(`readiness.${readiness?.decision ?? 'not_ready'}`)}</p>
    <p className={css.muted}>{t('readiness.description')}</p>
    <Button size="sm" variant="toolbar" disabled={state.running}
      onClick={() => void store.evaluateInfrastructureReadiness()}>{t('readiness.evaluate')}</Button>
    {readiness?.latestEvaluation === null || readiness?.latestEvaluation === undefined ? null
      : <p>{t('readiness.blockers')}: {readiness.latestEvaluation.blockers.join(', ') || t('field.empty')}</p>}
  </section>
}

function EvaluationInspector({ state, store, t }: {
  readonly state: ReturnType<ExperienceStore['getSnapshot']>
  readonly store: ExperienceStore
  readonly t: Translate
}) {
  const [cohortId, setCohortId] = useState('')
  const report = state.evaluationReport
  return <section className={css.inspectorSection} data-testid="experience-evaluation-report">
    <h4>{t('evaluation.title')}</h4>
    <p className={css.muted}>{t('evaluation.description')}</p>
    <label>{t('evaluation.cohort')}
      <input value={cohortId} onChange={event => setCohortId(event.currentTarget.value)} />
    </label>
    <Button size="sm" variant="toolbar" disabled={state.running || cohortId.trim() === ''}
      onClick={() => void store.loadEvaluationReport(cohortId.trim())}>{t('evaluation.load')}</Button>
    {report === undefined ? null : <>
      <p><strong>{report.comparable ? t('evaluation.comparable') : t('evaluation.notComparable')}</strong></p>
      {report.blockers.length === 0 ? null : <p>{t('evaluation.blockers')}: {report.blockers.join(', ')}</p>}
      {report.arms.map(arm => <details key={arm.comparisonArm}>
        <summary>{t(`evaluation.arm.${arm.comparisonArm}`)} · {arm.sampleCount}</summary>
        <dl><dt>{t('evaluation.successRate')}</dt><dd>{formatRate(arm.successRate, t)}</dd>
          <dt>{t('evaluation.successInterval')}</dt><dd>{formatInterval(arm.successRateWilson95, t)}</dd>
          <dt>{t('evaluation.resolvedSuccessRate')}</dt><dd>{formatRate(arm.resolvedSuccessRate, t)}</dd>
          <dt>{t('evaluation.unknown')}</dt><dd>{arm.unknownCount} · {formatRate(arm.unknownRate, t)}</dd>
          <dt>{t('evaluation.routeStability')}</dt><dd>{formatRate(arm.routeStabilityRate, t)}</dd>
          <dt>{t('evaluation.repeatedExploration')}</dt><dd>{formatNumber(arm.averageRepeatedExploration, t)}</dd>
          <dt>{t('evaluation.humanActions')}</dt><dd>{formatNumber(arm.averageHumanActions, t)}</dd>
          <dt>{t('evaluation.erroneousSideEffects')}</dt><dd>{formatRate(arm.erroneousSideEffectRate, t)}</dd>
          <dt>{t('evaluation.erroneousReuse')}</dt><dd>{formatRate(arm.erroneousReuseRate, t)}</dd>
          <dt>{t('evaluation.pollution')}</dt><dd>{formatRate(arm.pollutionIncidentRate, t)}</dd>
          <dt>{t('evaluation.inputTokens')}</dt><dd>{formatNumber(arm.averageInputTokens, t)}</dd>
          <dt>{t('evaluation.outputTokens')}</dt><dd>{formatNumber(arm.averageOutputTokens, t)}</dd>
          <dt>{t('evaluation.elapsed')}</dt><dd>{formatNumber(arm.averageElapsedMs, t)}</dd></dl>
      </details>)}
    </>}
  </section>
}

function formatRate(value: number | null, t: Translate): string {
  return value === null ? t('field.empty') : `${(value * 100).toFixed(1)}%`
}

function formatInterval(value: readonly [number, number] | null, t: Translate): string {
  return value === null ? t('field.empty') : `${formatRate(value[0], t)} – ${formatRate(value[1], t)}`
}

function formatNumber(value: number | null, t: Translate): string {
  return value === null ? t('field.empty') : new Intl.NumberFormat().format(value)
}

function AuditInspector({ state, store, t }: {
  readonly state: ReturnType<ExperienceStore['getSnapshot']>
  readonly store: ExperienceStore
  readonly t: Translate
}) {
  const subject = state.selectedPlanning === undefined
    ? state.version === undefined ? null : { kind: 'experience' as const, id: String(state.version.experienceId) }
    : { kind: 'usage' as const, id: String(state.selectedPlanning.plan.usageId) }
  const dossier = subject !== null && state.audit?.subject.kind === subject.kind && state.audit.subject.id === subject.id
    ? state.audit : undefined
  return <section className={css.inspectorSection} data-testid="experience-audit-dossier">
    <h4>{t('audit.title')}</h4>
    {subject === null ? <p className={css.muted}>{t('audit.selectSubject')}</p> : <>
      <Button disabled={state.running} onClick={() => void store.loadAudit(subject)}>{t('audit.load')}</Button>
      {dossier === undefined ? null : <>
        <dl>
          <dt>{t('audit.objects')}</dt><dd>{dossier.objects.length}</dd>
          <dt>{t('audit.sources')}</dt><dd>{dossier.sources.length}</dd>
          <dt>{t('audit.events')}</dt><dd>{dossier.timeline.length}</dd>
        </dl>
        {dossier.timeline.map(entry => <details key={entry.auditId}>
          <summary>{entry.action} · {formatDateTime(entry.recordedAt)}</summary>
          <dl>
            <dt>{t('audit.actor')}</dt><dd>{entry.actorId}</dd>
            <dt>{t('audit.objects')}</dt><dd>{entry.objectRefs.join(', ')}</dd>
            <dt>{t('audit.sources')}</dt><dd>{entry.sourceRefs.join(', ') || t('field.empty')}</dd>
            <dt>{t('planning.digest')}</dt><dd className={css.digest}>{entry.payloadDigest}</dd>
          </dl>
        </details>)}
        {dossier.nextCursor === null ? null : <Button disabled={state.running}
          onClick={() => void store.loadAudit(subject, dossier.nextCursor)}>{t('audit.more')}</Button>}
      </>}
    </>}
  </section>
}

function ForgetInspectorTechnical({ request, t }: {
  readonly request: NonNullable<ReturnType<ExperienceStore['getSnapshot']>['forgetRequest']>
  readonly t: Translate
}) {
  return <section className={css.inspectorSection} data-testid="experience-inspector-forget-technical">
    <h4>{t('forget.latest')}</h4>
    <dl>
      <dt>{t('forget.requestId')}</dt><dd>{request.forgetRequestId}</dd>
      <dt>{t('field.version')}</dt><dd>{request.currentVersionId}</dd>
      <dt>{t('forget.recallStoppedAt')}</dt><dd>{formatDateTime(request.canonicalRecallStoppedAt)}</dd>
      <dt>{t('planning.digest')}</dt><dd>{request.previewDigest}</dd>
    </dl>
    {request.steps.map(step => <details key={step.stepResultId}>
      <summary>{t(`forget.phase.${step.phase}`)} · {t(`forget.status.${step.status}`)}</summary>
      <dl>
        <dt>{t('inspector.reasonCode')}</dt><dd>{step.reasonCode}</dd>
        <dt>{t('inspector.sourceRef')}</dt><dd>{step.affectedRefs.join(', ') || t('field.empty')}</dd>
      </dl>
    </details>)}
    {request.contextTargets.map(target => <details key={target.contextDeliveryId}>
      <summary>{t('forget.phase.context_retirement')} · {t(`forget.status.${target.status}`)}</summary>
      <dl>
        <dt>{t('context.deliveryId')}</dt><dd>{target.contextDeliveryId}</dd>
        <dt>{t('inspector.sessionId')}</dt><dd>{target.sessionId}</dd>
        <dt>{t('forget.contextRetirementId')}</dt><dd>{target.contextRetirementId ?? t('field.empty')}</dd>
        <dt>{t('inspector.reasonCode')}</dt><dd>{target.reasonCode}</dd>
      </dl>
    </details>)}
  </section>
}

function forgetReasonLabel(reasonCode: string): ExperienceLocaleKey {
  switch (reasonCode) {
    case 'canonical_retrieval_stopped':
    case 'no_active_context':
    case 'active_context_retirement_pending':
    case 'session_surface_replaced':
    case 'all_active_contexts_retired':
    case 'context_retirement_failed':
    case 'session_surface_retirement_requested':
    case 'session_not_live_retirement_deferred':
    case 'session_surface_replacement_failed':
    case 'context_retirement_request_failed':
    case 'governed_content_vault_not_enabled':
    case 'projection_rebuild_pending':
    case 'projection_rebuilt_without_forgotten_series':
    case 'learning_projection_rebuild_failed':
    case 'forget_tombstone_committed':
      return `forget.reasonCode.${reasonCode}`
    default:
      return 'forget.reasonCode.unavailable'
  }
}

function LearningInspectorTechnical({ learning, governance, store, running, t }: {
  readonly learning: NonNullable<ReturnType<ExperienceStore['getSnapshot']>['learning']>
  readonly governance: ReturnType<ExperienceStore['getSnapshot']>['learningGovernance']
  readonly store: ExperienceStore
  readonly running: boolean
  readonly t: Translate
}) {
  const [demotionReason, setDemotionReason] = useState('')
  return <section className={css.inspectorSection} data-testid="experience-learning-projection">
    <h4>{t('learning.title')}</h4>
    <dl>
      <dt>{t('learning.generation')}</dt><dd>{learning.generation}</dd>
      <dt>{t('learning.sourceOffset')}</dt><dd>{learning.sourceOffset}</dd>
      <dt>{t('learning.builder')}</dt><dd>{learning.builderVersion}</dd>
    </dl>
    {LEARNING_CAPABILITIES.map(capability => {
      const policy = governance?.capabilities.find(item => item.capability === capability)
      const evaluation = [...(governance?.evaluations ?? [])].reverse()
        .find(item => item.capability === capability)
      return <details key={capability}>
      <summary>{t(`learning.capability.${capability}`)} · {learning.counts[capability]}
        {policy === undefined ? null : ` · ${t(`learning.level.${policy.currentLevel}`)}`}</summary>
      {learning.rows.filter(row => row.capability === capability).map(row => (
        <LearningPredictionRow key={row.predictionId} row={row} capability={capability} t={t} />
      ))}
      {evaluation === undefined ? null : <dl data-testid={`experience-learning-evaluation-${capability}`}>
        <dt>{t('learning.evaluation')}</dt><dd>{t(`learning.evaluation.${evaluation.outcome}`)}</dd>
        <dt>{t('learning.sampleCoverage')}</dt><dd>{evaluation.sampleCoverage}</dd>
      </dl>}
      <div className={css.actionRow}>
        <Button size="sm" variant="toolbar" disabled={running}
          onClick={() => void store.evaluateLearningCapability(capability)}>{t('learning.evaluate')}</Button>
        {policy?.currentLevel !== 'shadow' || evaluation?.outcome !== 'passed' ? null : <Button
          size="sm" variant="toolbar" disabled={running}
          onClick={() => void store.changeAutomationLevel(
            capability, 'promote', 'suggest', evaluation.unlockContractEvaluationId,
            t('learning.promoteReason'), 'none')}>{t('learning.promote')}</Button>}
      </div>
      {capability !== 'applicability' ? null : <p className={css.muted}
        data-testid="experience-learning-governance-object">{t('learning.governance.legacyCapabilityNote')}</p>}
      {policy?.currentLevel !== 'suggest' ? null : <>
        <label>{t('learning.demotionReason')}
          <input value={demotionReason} onChange={event => setDemotionReason(event.currentTarget.value)} />
        </label>
        <Button size="sm" variant="toolbar" disabled={running || demotionReason.trim() === ''}
          onClick={() => void store.changeAutomationLevel(
            capability, 'demote', 'shadow', null, demotionReason.trim(), 'metric_drift')}>
          {t('learning.demote')}
        </Button>
      </>}
    </details>
    })}
    <HistoryRankingGovernance learning={learning} governance={governance} store={store} running={running} t={t} />
    {learning.unsupportedCapabilities.length === 0 ? null
      : <p className={css.muted}>{t('learning.unsupported')}: {learning.unsupportedCapabilities.join(', ')}</p>}
  </section>
}

/** Reuses the Host governance owner and the existing receipt/readback store. */
function HistoryRankingGovernance({ learning, governance, store, running, t }: {
  readonly learning: NonNullable<ReturnType<ExperienceStore['getSnapshot']>['learning']>
  readonly governance: ReturnType<ExperienceStore['getSnapshot']>['learningGovernance']
  readonly store: ExperienceStore
  readonly running: boolean
  readonly t: Translate
}) {
  const [selectedId, setSelectedId] = useState('')
  const [preference, setPreference] = useState<'proposed' | 'baseline' | 'equivalent' | 'unknown' | ''>('')
  const [reason, setReason] = useState('')
  const [sourceId, setSourceId] = useState('')
  const subject = governance?.historyRanking
  if (subject === undefined) return null
  const rows = learning.rows.filter(row => row.predictor.version === LEARNING_RANKING_PREDICTOR_VERSION)
  const row = rows.find(item => String(item.predictionId) === selectedId)
  const ranking = row === undefined ? null : parseLearningRanking(row.prediction.ranking)
  const evaluation = [...subject.evaluations].reverse()[0]
  const receipt = store.getSnapshot().receipt
  const reviewed = receipt !== undefined && 'predictionId' in receipt && receipt.predictionId === selectedId
  const canReview = !running && !reviewed && preference !== '' && reason.trim() !== ''
    && ranking?.mode === 'shadow' && ranking.sourceUsageIds.includes(sourceId)
  return <details data-testid="experience-history-ranking-governance">
    <summary>{t('learning.ranking.governanceTitle')} · {t(`learning.level.${subject.capability.currentLevel}`)}</summary>
    <p className={css.muted}>{t('learning.ranking.reviewHelp')}</p>
    <label>{t('learning.prediction')}<select value={selectedId} onChange={event => {
      setSelectedId(event.currentTarget.value); setSourceId(''); setPreference(''); setReason('')
    }}><option value="">{t('learning.ranking.choose')}</option>{rows.map(item =>
      <option key={item.predictionId} value={item.predictionId}>{item.predictionId}</option>)}</select></label>
    {ranking === null ? null : <LearningRankingBlock ranking={ranking} t={t} />}
    <label>{t('learning.ranking.preference')}<select value={preference} onChange={event =>
      setPreference(event.currentTarget.value as typeof preference)}>
      <option value="">{t('learning.ranking.choose')}</option>
      {(['proposed', 'baseline', 'equivalent', 'unknown'] as const).map(value =>
        <option key={value} value={value}>{t(`learning.ranking.preference.${value}`)}</option>)}
    </select></label>
    <label>{t('learning.history.evidence')}<select value={sourceId} onChange={event => setSourceId(event.currentTarget.value)}>
      <option value="">{t('learning.ranking.choose')}</option>
      {ranking?.sourceUsageIds.map(id => <option key={id} value={id}>{id}</option>)}
    </select></label>
    <label>{t('learning.ranking.reviewReason')}<input value={reason} onChange={event => setReason(event.currentTarget.value)} /></label>
    <Button size="sm" variant="toolbar" disabled={!canReview} onClick={() => {
      if (row !== undefined && preference !== '') void store.reviewHistoryRanking(row, preference, reason.trim(), sourceId)
    }}>{t('learning.ranking.submitReview')}</Button>
    {canReview ? null : <p className={css.muted}>{t(reviewed ? 'learning.ranking.reviewed' : 'learning.ranking.reviewMissing')}</p>}
    {evaluation === undefined ? null : <dl>
      <dt>{t('learning.evaluation')}</dt><dd>{t(`learning.evaluation.${evaluation.outcome}`)}</dd>
      <dt>{t('learning.sampleCoverage')}</dt><dd>{evaluation.sampleCoverage}</dd>
    </dl>}
    <div className={css.actionRow}>
      <Button size="sm" variant="toolbar" disabled={running} onClick={() => void store.evaluateLearningCapability('history_ranking')}>{t('learning.evaluate')}</Button>
      {subject.capability.currentLevel !== 'shadow' || evaluation?.outcome !== 'passed' ? null :
        <Button size="sm" variant="toolbar" disabled={running} onClick={() => void store.changeAutomationLevel(
          'history_ranking', 'promote', 'suggest', evaluation.unlockContractEvaluationId, t('learning.promoteReason'), 'none')}>{t('learning.promote')}</Button>}
      {subject.capability.currentLevel !== 'suggest' ? null : <Button size="sm" variant="toolbar" disabled={running || reason.trim() === ''}
        onClick={() => void store.changeAutomationLevel('history_ranking', 'demote', 'shadow', null, reason.trim(), 'metric_drift')}>{t('learning.demote')}</Button>}
    </div>
  </details>
}

/** One prediction row plus the Host participation/ranking facts; hook-free for direct render tests. */
function LearningPredictionRow({ row, capability, t }: {
  readonly row: LearningPredictionView
  readonly capability: LearningCapability
  readonly t: Translate
}) {
  const isRankingRow = capability === 'applicability'
    && row.predictor.version === LEARNING_RANKING_PREDICTOR_VERSION
  const ranking = isRankingRow ? parseLearningRanking(row.prediction.ranking) : null
  const history = capability === 'applicability' && !isRankingRow
    ? parseLearningHistory(row.prediction.history)
    : null
  return <div className={css.learningRow}>
    <dl>
      <dt>{t('learning.prediction')}</dt><dd>{row.predictionId}</dd>
      <dt>{t('learning.humanLabels')}</dt><dd>{row.humanLabels.length}</dd>
      <dt>{t('learning.outcomes')}</dt><dd>{row.observedOutcomes.length}</dd>
    </dl>
    {capability !== 'applicability' ? null : ranking !== null
      ? <LearningRankingBlock ranking={ranking} t={t} />
      : history !== null
        ? <LearningHistoryBlock history={history} t={t} />
        : <p className={css.muted} data-testid="experience-learning-history-missing">{t('learning.history.noHistory')}</p>}
  </div>
}

/** Task-level participation outcome for one Host usage; never a component causal rate. */
function LearningHistoryBlock({ history, t }: {
  readonly history: LearningHistoryView
  readonly t: Translate
}) {
  return <details className={css.learningBlock} data-testid="experience-learning-history">
    <summary>{t('learning.history.title')}</summary>
    <dl>
      <dt>{t('learning.history.participation')}</dt>
      <dd>{t(learningParticipationKey(history.participation))}</dd>
      <dt>{t('learning.history.outcome')}</dt>
      <dd>{t(learningTaskOutcomeKey(history.taskOutcome))}</dd>
      <dt>{t('learning.history.attribution')}</dt>
      <dd>{t('learning.history.attribution.task_participation')}</dd>
      <dt>{t('learning.history.version')}</dt>
      <dd>{history.experienceVersionId}</dd>
      <dt>{t('learning.history.environment')}</dt>
      <dd>{history.environmentKey}</dd>
      <dt>{t('learning.history.components')}</dt>
      <dd>{history.componentRevisionIds.length === 0
        ? t('learning.history.components.none')
        : history.componentRevisionIds.join(', ')}</dd>
      <dt>{t('learning.history.usageId')}</dt>
      <dd>{history.usageId}</dd>
      <dt>{t('learning.history.taskDigest')}</dt>
      <dd className={css.digest}>{history.taskInputDigest}</dd>
    </dl>
    {history.evidenceRefs.length === 0 ? null
      : <div className={css.learningBlockSection}>
          <strong>{t('learning.history.evidence')}</strong>
          <ul>{history.evidenceRefs.map(ref => (
            <li key={ref.id} className={css.digest}>{ref.kind} · {ref.id}{ref.digest === null ? '' : ` · ${ref.digest}`}</li>
          ))}</ul>
        </div>}
    {history.reasonCodes.length === 0 ? null
      : <p className={css.digest}>{t('learning.history.reasonCodes')}: {history.reasonCodes.join(', ')}</p>}
    <p className={css.muted}>{t('learning.history.notCausal')}</p>
  </details>
}

/** Host baseline/proposed/applied comparison; array order is never re-sorted by the Client. */
function LearningRankingBlock({ ranking, t }: {
  readonly ranking: LearningRankingView
  readonly t: Translate
}) {
  const hasLicense = ranking.governanceDecisionId !== null && ranking.evaluationId !== null
  return <details className={css.learningBlock} data-testid="experience-learning-ranking">
    <summary>{t('learning.ranking.title')}</summary>
    <dl>
      <dt>{t('learning.ranking.mode')}</dt>
      <dd>{t(learningRankingModeKey(ranking.mode, hasLicense))}</dd>
      <dt>{t('learning.ranking.samples')}</dt>
      <dd>{ranking.sampleCount}</dd>
      <dt>{t('learning.ranking.baseline')}</dt>
      <dd><LearningVersionOrder ids={ranking.baselineVersionIds} t={t} /></dd>
      <dt>{t('learning.ranking.proposed')}</dt>
      <dd><LearningVersionOrder ids={ranking.proposedVersionIds} t={t} /></dd>
      <dt>{t('learning.ranking.applied')}</dt>
      <dd><LearningVersionOrder ids={ranking.appliedVersionIds} t={t} /></dd>
      <dt>{t('learning.ranking.instances')}</dt>
      <dd><LearningVersionOrder ids={ranking.sourceUsageIds} t={t} /></dd>
      <dt>{t('learning.ranking.governance')}</dt>
      <dd>{ranking.governanceDecisionId ?? t('learning.ranking.none')}</dd>
      <dt>{t('learning.ranking.evaluation')}</dt>
      <dd>{ranking.evaluationId ?? t('learning.ranking.none')}</dd>
    </dl>
    {ranking.reasonCodes.length === 0 ? null
      : <p className={css.digest}>{t('learning.history.reasonCodes')}: {ranking.reasonCodes.join(', ')}</p>}
    <p className={css.muted}>{t('learning.ranking.governanceNote')}</p>
  </details>
}

/** Preserve Host-provided ordering exactly; the Client never re-ranks array values. */
function LearningVersionOrder({ ids, t }: {
  readonly ids: readonly string[]
  readonly t: Translate
}) {
  if (ids.length === 0) return <em className={css.muted}>{t('learning.ranking.empty')}</em>
  return <ol className={css.learningOrder}>{ids.map((id, index) => (
    <li key={`${id}:${index}`} className={css.digest}>{index + 1}. {id}</li>
  ))}</ol>
}

function learningParticipationKey(participation: LearningParticipation): ExperienceLocaleKey {
  switch (participation) {
    case 'used': return 'learning.history.participation.used'
    case 'delivered_only': return 'learning.history.participation.delivered_only'
    case 'not_selected': return 'learning.history.participation.not_selected'
    case 'not_delivered': return 'learning.history.participation.not_delivered'
    case 'rejected': return 'learning.history.participation.rejected'
    case 'abandoned': return 'learning.history.participation.abandoned'
    case 'unverified': return 'learning.history.participation.unverified'
  }
}

function learningTaskOutcomeKey(outcome: LearningTaskOutcome): ExperienceLocaleKey {
  switch (outcome) {
    case null: return 'learning.history.outcome.unavailable'
    case 'success': return 'learning.history.outcome.success'
    case 'failure': return 'learning.history.outcome.failure'
    case 'unknown': return 'learning.history.outcome.unknown'
    case 'abandoned': return 'learning.history.outcome.abandoned'
  }
}

function learningRankingModeKey(mode: LearningRankingMode, hasLicense: boolean): ExperienceLocaleKey {
  switch (mode) {
    case 'shadow': return 'learning.ranking.mode.shadow'
    case 'suggest': return hasLicense ? 'learning.ranking.mode.suggest' : 'learning.ranking.mode.suggestMissing'
    case 'fallback': return 'learning.ranking.mode.fallback'
  }
}

function ExecutionInspectorOverview({ execution, t }: {
  readonly execution: UsageExecutionView
  readonly t: Translate
}) {
  const proposal = execution.revisionProposals.at(-1)
  return <section className={css.inspectorSection} data-testid="experience-inspector-execution-overview">
    <h4>{t('inspector.execution')}</h4>
    <dl>
      <dt>{t('execution.state')}</dt><dd>{execution.progress === null
        ? t('field.empty') : t(`execution.state.${execution.progress.state}`)}</dd>
      <dt>{t('verification.title')}</dt><dd>{execution.verification === null
        ? t('field.empty') : t(`verification.phase.${execution.verification.phase}`)}</dd>
      <dt>{t('settlement.outcome')}</dt><dd>{execution.settlement === null
        ? t('field.empty') : t(`outcome.${execution.settlement.outcome}`)}</dd>
      <dt>{t('revision.state')}</dt><dd>{proposal === undefined
        ? t('field.empty') : t(`revision.state.${proposal.state}`)}</dd>
    </dl>
  </section>
}

function ExecutionInspectorSources({ execution, t }: {
  readonly execution: UsageExecutionView
  readonly t: Translate
}) {
  const criteria = execution.verification?.criteria ?? []
  const revisionSources = execution.revisionProposals.flatMap(proposal => proposal.changes.flatMap(change => change.sourceRefs))
  return <>
    <section className={css.inspectorSection} data-testid="experience-inspector-verification-sources">
      <h4>{t('inspector.verification')}</h4>
      {criteria.length === 0 ? <p className={css.muted}>{t('field.empty')}</p> : <ul className={css.sourceList}>
        {criteria.map(item => <li key={item.criterionId}>
          <strong>{t(`verification.criterion.${item.criterionId}`)}</strong>
          <p className={css.digest}>{item.sourceRef ?? t('field.empty')}</p>
        </li>)}
      </ul>}
    </section>
    {revisionSources.length === 0 ? null : <section className={css.inspectorSection}>
      <h4>{t('inspector.revision')}</h4>
      <ul className={css.sourceList}>{[...new Set(revisionSources)].map(ref => <li key={ref} className={css.digest}>{ref}</li>)}</ul>
    </section>}
  </>
}

function ExecutionInspectorHistory({ execution, t }: {
  readonly execution: UsageExecutionView
  readonly t: Translate
}) {
  return <section className={css.inspectorSection} data-testid="experience-inspector-execution-history">
    <h4>{t('inspector.executionHistory')}</h4>
    {execution.progress === null ? <p className={css.muted}>{t('field.empty')}</p> : <>
      <ul className={css.resultList}>{execution.progress.checkpointResults.map((checkpoint, index) => <li key={`${checkpoint.checkpointRef}:${String(index)}`}>
        <strong>{t('execution.completedStep')} {index + 1}</strong> · {checkpoint.reason}
      </li>)}</ul>
      <p>{t('execution.transition')}: {t(`execution.transition.${execution.progress.transition}`)}</p>
    </>}
    {execution.settlement === null ? null : <p>
      <strong>{t('settlement.title')}</strong> · {t(`outcome.${execution.settlement.outcome}`)} · <time dateTime={execution.settlement.createdAt}>{formatDateTime(execution.settlement.createdAt)}</time>
    </p>}
    {execution.revisionProposals.map(proposal => <p key={proposal.revisionProposalId}>
      <strong>{t('revision.title')}</strong> · {t(`revision.state.${proposal.state}`)} · <time dateTime={proposal.createdAt}>{formatDateTime(proposal.createdAt)}</time>
    </p>)}
  </section>
}

function ExecutionInspectorTechnical({ execution, t }: {
  readonly execution: UsageExecutionView
  readonly t: Translate
}) {
  const progress = execution.progress
  const verification = execution.verification
  const settlement = execution.settlement
  return <>
    <section className={css.inspectorSection} data-testid="experience-inspector-execution-technical">
      <h4>{t('inspector.execution')}</h4>
      <dl>
        <dt>{t('planning.usageId')}</dt><dd>{execution.usageId}</dd>
        <dt>{t('inspector.progressId')}</dt><dd>{progress?.stepProgressId ?? t('field.empty')}</dd>
        <dt>{t('inspector.executionId')}</dt><dd>{progress?.executionId ?? t('field.empty')}</dd>
        <dt>{t('inspector.sessionId')}</dt><dd>{progress?.sessionId ?? t('field.empty')}</dd>
        <dt>{t('execution.revision')}</dt><dd>{progress?.controllerRevision ?? t('field.empty')}</dd>
        <dt>{t('inspector.stepRef')}</dt><dd>{progress?.stepRef ?? t('field.empty')}</dd>
        <dt>{t('inspector.guardDigest')}</dt><dd>{progress?.guardPolicyDigest ?? t('field.empty')}</dd>
      </dl>
    </section>
    <section className={css.inspectorSection}>
      <h4>{t('execution.correlations')}: {execution.correlations.length}</h4>
      {execution.correlations.length === 0 ? <p className={css.muted}>{t('field.empty')}</p> : execution.correlations.map(item => <details key={item.executionCorrelationId}>
        <summary>{item.toolName} · {item.resultState} · {item.externalEffectState}</summary>
        <dl>
          <dt>{t('inspector.correlationId')}</dt><dd>{item.executionCorrelationId}</dd>
          <dt>{t('inspector.callId')}</dt><dd>{item.callId}</dd>
          <dt>{t('inspector.eventSequence')}</dt><dd>{item.callEventSeq} → {item.resultEventSeq ?? t('field.empty')}</dd>
          <dt>{t('inspector.argumentsDigest')}</dt><dd>{item.argumentsDigest}</dd>
          <dt>{t('inspector.effect')}</dt><dd>{item.effectRef === null ? t('field.empty') : JSON.stringify(item.effectRef)}</dd>
        </dl>
      </details>)}
    </section>
    <section className={css.inspectorSection}>
      <h4>{t('inspector.verification')}</h4>
      <dl>
        <dt>{t('inspector.verificationRunId')}</dt><dd>{verification?.verificationRunId ?? t('field.empty')}</dd>
        <dt>{t('inspector.providerVersion')}</dt><dd>{verification?.providerVersion ?? t('field.empty')}</dd>
      </dl>
      {verification?.criteria.map(item => <details key={item.criterionId}>
        <summary>{item.criterionId} · {item.result}</summary>
        <dl>
          <dt>{t('inspector.reasonCode')}</dt><dd>{item.reasonCode}</dd>
          <dt>{t('inspector.sourceRef')}</dt><dd>{item.sourceRef ?? t('field.empty')}</dd>
          <dt>{t('inspector.integrityDigest')}</dt><dd>{item.integrityDigest}</dd>
          <dt>{t('inspector.observedValue')}</dt><dd>{JSON.stringify(item.boundedValue)}</dd>
        </dl>
      </details>)}
    </section>
    <section className={css.inspectorSection}>
      <h4>{t('inspector.settlement')}</h4>
      <dl>
        <dt>{t('inspector.settlementId')}</dt><dd>{settlement?.settlementId ?? t('field.empty')}</dd>
        <dt>{t('inspector.verificationRunId')}</dt><dd>{settlement?.verificationRunId ?? t('field.empty')}</dd>
      </dl>
    </section>
    {execution.revisionProposals.map(proposal => <RevisionInspectorTechnical key={proposal.revisionProposalId} proposal={proposal} t={t} />)}
  </>
}

function RevisionInspectorTechnical({ proposal, t }: {
  readonly proposal: RevisionProposalView
  readonly t: Translate
}) {
  return <section className={css.inspectorSection}>
    <h4>{t('inspector.revision')}</h4>
    <dl>
      <dt>{t('inspector.revisionProposalId')}</dt><dd>{proposal.revisionProposalId}</dd>
      <dt>{t('inspector.baseVersion')}</dt><dd>{proposal.baseVersionId}</dd>
      <dt>{t('inspector.sourceUsage')}</dt><dd>{proposal.sourceUsageId}</dd>
      <dt>{t('execution.revision')}</dt><dd>{proposal.revision}</dd>
      <dt>{t('inspector.publishedVersion')}</dt><dd>{proposal.publishedVersionId ?? t('field.empty')}</dd>
      <dt>{t('inspector.reasonCode')}</dt><dd>{proposal.diagnosis.reasonCodes.join(', ') || t('field.empty')}</dd>
    </dl>
    {proposal.changes.map(change => <details key={change.revisionChangeId}>
      <summary>{componentRoleText(change.semanticRole, t)} · {t(`revision.decision.${change.decision}`)}</summary>
      <dl>
        <dt>{t('inspector.changeId')}</dt><dd>{change.revisionChangeId}</dd>
        <dt>{t('inspector.componentId')}</dt><dd>{change.componentId}</dd>
        <dt>{t('inspector.sourceRef')}</dt><dd>{change.sourceRefs.join(', ')}</dd>
      </dl>
    </details>)}
  </section>
}

function PlanningPanel({ store, state, sessionId, activeStage, t }: {
  readonly store: ExperienceStore
  readonly state: ReturnType<ExperienceStore['getSnapshot']>
  readonly sessionId: string
  readonly activeStage: TaskStage
  readonly t: Translate
}) {
  const [taskText, setTaskText] = useState('')
  const [workspaceRoot, setWorkspaceRoot] = useState('')
  const [targetExposure, setTargetExposure] = useState<'local' | 'public'>('local')
  const [riskClass, setRiskClass] = useState<'standard' | 'medium' | 'high'>('medium')
  const [mustUseExperience, setMustUseExperience] = useState(false)
  const [requestedUseMode, setRequestedUseMode] = useState<'suggest' | 'guided'>('guided')
  const [confirmPlanningModel, setConfirmPlanningModel] = useState(false)
  const selected = state.selectedPlanning
  const planningConfig = state.planningConfiguration
  const automationConfig = state.automationConfiguration
  const modelProposal = planningConfig?.taskFingerprintProposalMode === 'model'
  const submitPlan = (): void => {
    if (taskText.trim() === '') return
    void store.planTask(sessionId, {
      text: taskText.trim(),
      workspaceRoot: workspaceRoot.trim() === '' ? null : workspaceRoot.trim(),
      targetExposure,
      mustUseExperience,
      riskClass,
      requiredCapabilities: [],
      requestedUseMode,
      overrideDecisionIds: [],
    }, modelProposal && confirmPlanningModel)
  }
  return <section aria-labelledby="experience-planning-heading" data-testid="experience-planning">
    <header className={css.workbenchHeader}>
      <div>
        <h2 id="experience-planning-heading">{t(`task.stage.${activeStage}`)}</h2>
        <p>{t(`task.stageDescription.${activeStage}`)}</p>
      </div>
      <Pill>{t(`task.stage.${currentTaskStage(state)}`)}</Pill>
    </header>
    <div className={css.surface}>
      {activeStage !== 'match' ? null : <>
        <div className={css.surfaceSection}>
          <h3>{t('planning.title')}</h3>
          <p className={css.muted}>{t('planning.description')}</p>
          {automationConfig === undefined ? null : <dl data-testid="experience-automation-readback">
            <dt>{t('settings.field.automaticSuggestionDetection')}</dt>
            <dd>{t(automationConfig.suggestionDetection.effective ? 'settings.enabled' : 'settings.disabled')}</dd>
            <dt>{t('settings.field.automaticRecall')}</dt>
            <dd>{t(automationConfig.recall.effective ? 'settings.enabled' : 'settings.disabled')}</dd>
            <dt>{t('settings.field.automaticContextInjection')}</dt>
            <dd>{automationConfig.contextInjection.effective}</dd>
            <dt>{t('settings.field.automaticToolExecution')}</dt>
            <dd>{automationConfig.toolExecution.availability === 'configured_but_unavailable'
              ? t('settings.effective.executionUnavailable') : t('settings.disabled')}</dd>
          </dl>}
          <div className={css.taskForm}>
            <div className={css.formGrid}>
              <label className={`${css.fieldLabel} ${css.fullWidth}`}>{t('planning.task')}
                <textarea value={taskText} required rows={4} onChange={event => setTaskText(event.currentTarget.value)} />
              </label>
              <label className={css.fieldLabel}>{t('planning.workspace')}
                <input value={workspaceRoot} placeholder={t('planning.workspacePlaceholder')}
                  onChange={event => setWorkspaceRoot(event.currentTarget.value)} />
              </label>
              <label className={css.fieldLabel}>{t('planning.exposure')}
                <select value={targetExposure} onChange={event => setTargetExposure(event.currentTarget.value as 'local' | 'public')}>
                  <option value="local">{t('planning.exposure.local')}</option>
                  <option value="public">{t('planning.exposure.public')}</option>
                </select>
              </label>
              <label className={css.fieldLabel}>{t('planning.risk')}
                <select value={riskClass} onChange={event => setRiskClass(event.currentTarget.value as 'standard' | 'medium' | 'high')}>
                  <option value="standard">{t('planning.risk.standard')}</option>
                  <option value="medium">{t('planning.risk.medium')}</option>
                  <option value="high">{t('planning.risk.high')}</option>
                </select>
              </label>
              <label className={css.fieldLabel}>{t('planning.useMode')}
                <select value={requestedUseMode} onChange={event => setRequestedUseMode(event.currentTarget.value as 'suggest' | 'guided')}>
                  <option value="suggest">{t('planning.useMode.suggest')}</option>
                  <option value="guided">{t('planning.useMode.guided')}</option>
                </select>
              </label>
              <label className={css.checkboxRow}><input type="checkbox" checked={mustUseExperience}
                onChange={event => setMustUseExperience(event.currentTarget.checked)} /> <span>{t('planning.mustUse')}</span></label>
            </div>
            {planningConfig === undefined ? null : <section className={css.notice}>
              <strong>{t('planning.proposalMode')}: {t(`planning.proposalMode.${planningConfig.taskFingerprintProposalMode}`)}</strong>
              {!modelProposal ? null : <>
                <p>{t('planning.modelRoute')}: {planningConfig.provider} / {planningConfig.model}
                  {' · '}{t('planning.modelTokens')}: {planningConfig.maxOutputTokens}</p>
                <label className={css.checkboxRow}><input type="checkbox" checked={confirmPlanningModel}
                  onChange={event => setConfirmPlanningModel(event.currentTarget.checked)} /> <span>{t('planning.confirmModel')}</span></label>
              </>}
            </section>}
            <div className={css.actionRow}>
              <Button variant="primary" data-testid="experience-plan-create" onClick={submitPlan}
                disabled={state.running || taskText.trim() === '' || planningConfig === undefined || (modelProposal && !confirmPlanningModel)}>
                {state.running ? t('planning.running') : t('planning.create')}
              </Button>
            </div>
          </div>
        </div>
      </>}
      {selected === undefined
        ? activeStage === 'match' ? null : <div className={css.emptyState}>{t('task.noPlan')}</div>
        : <PlanningReadback planning={selected} context={state.selectedContext}
            execution={state.selectedExecution} stage={activeStage} t={t} store={store} running={state.running} />}
    </div>
  </section>
}

/** Map a frozen Host reason code to an understandable label; never guess unknowns. */
function planningReasonLabel(code: string): ExperienceLocaleKey {
  switch (code) {
    case 'lexical_match_only':
      return 'planning.reason.lexical_match_only'
    case 'structural_match_only':
      return 'planning.reason.structural_match_only'
    case 'lexical_and_structural_match':
      return 'planning.reason.lexical_and_structural_match'
    case 'alias_match':
      return 'planning.reason.alias_match'
    case 'exact_signal_match':
      return 'planning.reason.exact_signal_match'
    case 'exact_signal_conflict':
      return 'planning.reason.exact_signal_conflict'
    case 'condition_invalidated_by_current_auth_contract':
      return 'planning.reason.condition_invalidated_by_current_auth_contract'
    case 'local_procedure_rejected':
      return 'planning.reason.local_procedure_rejected'
    case 'independent_build_check_retained':
      return 'planning.reason.independent_build_check_retained'
    case 'hard_scope_conflict':
      return 'planning.reason.hard_scope_conflict'
    case 'capability_mismatch':
      return 'planning.reason.capability_mismatch'
    case 'use_mode_not_allowed':
      return 'planning.reason.use_mode_not_allowed'
    case 'version_not_current':
      return 'planning.reason.version_not_current'
    case 'low_evidence_match':
      return 'planning.reason.low_evidence_match'
    case 'primary_hybrid_match':
      return 'planning.reason.primary_hybrid_match'
    case 'not_primary_candidate':
      return 'planning.reason.not_primary_candidate'
    case 'retrieval_projection_stale':
      return 'planning.reason.retrieval_projection_stale'
    case 'type_required_signal_missing':
      return 'planning.reason.type_required_signal_missing'
    case 'evidence_gate_not_met':
      return 'planning.reason.evidence_gate_not_met'
    default:
      return 'planning.reason.unknown'
  }
}

/** Map observation status to an explicit label; unknown/invalidated stay explicit. */
function observationStatusLabel(status: PlanningObservationView['status']): ExperienceLocaleKey {
  switch (status) {
    case 'observed':
      return 'planning.observation.observed'
    case 'not_applicable':
      return 'planning.observation.not_applicable'
    case 'invalidated':
      return 'planning.observation.invalidated'
    case 'unknown':
      return 'planning.observation.unknown'
  }
}

/** Host marks a required observation as unknown only for these fact classes. */
function requiredObservationUnknown(observations: readonly PlanningObservationView[]): boolean {
  return observations.some(observation => observation.status === 'unknown'
    && (observation.kind === 'repository_state' || observation.kind === 'build_artifact' || observation.kind === 'web_contract'))
}

/** Merge the same-version candidate and preflight confirmed reasons, dedupe, translate. */
function planningReasonText(
  candidate: MatchCandidateView,
  preflight: PreflightRecordView | undefined,
  t: Translate,
): string {
  const codes = [...candidate.reasonCodes, ...(preflight?.reasonCodes ?? []), ...(preflight?.blockers ?? [])]
  if (codes.length === 0) return t('planning.reason.none')
  return [...new Set(codes)].map(code => t(planningReasonLabel(code))).join('；')
}

/** One current decision per candidate, following the frozen Host→Client priority. */
function planningNextActionKey(
  planning: PlanningResultView,
  candidate: MatchCandidateView,
  preflight: PreflightRecordView | undefined,
): ExperienceLocaleKey {
  if (preflight !== undefined) {
    switch (preflight.disposition) {
      case 'blocked':
      case 'conflicting':
      case 'stale':
      case 'irrelevant':
        return 'planning.next.handleCondition'
      case 'adaptable':
        return 'planning.next.adaptable'
      case 'applicable':
        break
    }
    if (requiredObservationUnknown(preflight.observations)) {
      return 'planning.next.checkCondition'
    }
  }
  if (candidate.rejected && candidate.selectedComponentRevisionIds.length === 0) {
    return 'planning.next.handleCondition'
  }
  if (planning.approvalRequest?.status === 'pending') return 'planning.next.reviewPlan'
  if (planning.approvalRequest?.status === 'approved') return 'planning.next.useExisting'
  return 'planning.next.suggest'
}

function PlanningReadback({ planning, context, execution, stage, t, store, running }: {
  readonly planning: NonNullable<ReturnType<ExperienceStore['getSnapshot']>['selectedPlanning']>
  readonly context: ReturnType<ExperienceStore['getSnapshot']>['selectedContext']
  readonly execution: ReturnType<ExperienceStore['getSnapshot']>['selectedExecution']
  readonly stage: TaskStage
  readonly t: Translate
  readonly store: ExperienceStore
  readonly running: boolean
}) {
  const latestAdmission = context?.admissionAttempts.at(-1)
  const mustUseExperience = planning.fingerprint.hardConstraints.includes('must_use_experience:true')
  return <article data-testid="experience-plan-readback">
    {stage === 'match' ? <div className={css.surfaceSection}>
      <h3>{t('planning.match')}</h3>
      <p>{t('planning.match')}: {planning.matchSet.candidates.length}
        {planning.matchSet.noMatch ? ` · ${t('planning.noMatch')}` : ''}</p>
      {planning.matchSet.candidates.length === 0 ? <p className={css.muted}>{t('planning.noMatch')} · {mustUseExperience ? t('planning.noMatchMustUse') : t('planning.noMatchContinue')}</p>
        : <ul className={css.resultList}>{planning.matchSet.candidates.map(candidate => {
            const preflight = planning.preflights.find(item => item.experienceVersionId === candidate.experienceVersionId)
            const reasonText = planningReasonText(candidate, preflight, t)
            const environmentText = preflight === undefined || preflight.observations.length === 0
              ? t('planning.environment.noFacts')
              : preflight.observations.map(observation =>
                  `${t(observationStatusLabel(observation.status))}：${observation.summary}`).join('；')
            return <li key={candidate.experienceVersionId}>
              <strong>{candidate.title}</strong>
              {' · '}{candidate.rejected ? t('planning.rejected') : t('planning.matched')}
              {' · '}<span data-testid={`experience-match-reason-${candidate.experienceVersionId}`}>{reasonText}</span>
              {' · '}{environmentText}
              {' · '}{t(planningNextActionKey(planning, candidate, preflight))}
            </li>
          })}</ul>}
    </div> : null}
    {stage === 'preflight' ? <div className={css.surfaceSection}>
      <h3>{t('planning.preflight')}</h3>
      <p>{t('planning.preflight.count')}: {planning.preflights.length}</p>
      {planning.preflights.length === 0 ? <p className={css.muted}>{t('field.empty')}</p>
        : <ul className={css.resultList}>{planning.preflights.map(preflight => {
            const candidate = planning.matchSet.candidates.find(item => item.experienceVersionId === preflight.experienceVersionId)
            return <li key={preflight.experienceVersionId}>
              <strong>{candidate?.title ?? preflight.experienceVersionId}</strong>
              {' · '}{t(`planning.disposition.${preflight.disposition}`)}
              {preflight.observations.length === 0 ? null : <ul className={css.resultList}>
                {preflight.observations.map(observation => <li key={observation.observationId}>
                  <strong>{observation.kind}</strong>
                  {' · '}{t(observationStatusLabel(observation.status))}
                  {' · '}{observation.summary}
                </li>)}
              </ul>}
            </li>
          })}</ul>}
    </div> : null}
    {stage === 'plan' ? <div className={css.surfaceSection}>
      <h3>{t('planning.exactPlan')}</h3>
      <div className={css.summaryGrid}>
        <div className={css.fact}><span className={css.factLabel}>{t('planning.disposition')}</span>
          <strong className={css.factValue} data-testid="experience-plan-disposition">{planning.plan.disposition}</strong></div>
        <div className={css.fact}><span className={css.factLabel}>{t('planning.approval')}</span>
          <span className={css.factValue} data-testid="experience-plan-approval">{planning.approvalRequest?.status ?? t('planning.noApproval')}</span></div>
      </div>
      <p>{t('planning.planId')}: <span data-testid="experience-plan-id" className={css.digest}>{planning.plan.usagePlanId}</span></p>
      <p>{t('planning.digest')}: <span data-testid="experience-plan-digest" className={css.digest}>{planning.plan.contentDigest}</span></p>
      <p>{t('planning.usageId')}: <span data-testid="experience-usage-id" className={css.digest}>{planning.plan.usageId}</span></p>
      <ol className={css.stepList}>{planning.plan.orderedSteps.map(step => <li key={step.stepId}>{step.content}</li>)}</ol>
      <details><summary>{t('planning.selected')}: {planning.plan.selectedContributions.length}</summary>
        <ul>{planning.plan.selectedContributions.map(item => <li key={item.contributionId}>{item.role}: {item.content}</li>)}</ul>
      </details>
      <details><summary>{t('planning.discarded')}: {planning.plan.discardedContributions.length}</summary>
        <ul>{planning.plan.discardedContributions.map(item => <li key={item.contributionId}>{t(discardReasonLabel(item.reasonCode))}: {item.contributionId}</li>)}</ul>
      </details>
      <p>{t('planning.interaction')}: <span data-testid="experience-plan-interaction">{planning.interactionOutcome}</span></p>
      {planning.retryBinding === null ? null : <p>{t('planning.binding')}: <span data-testid="experience-plan-binding" className={css.digest}>{planning.retryBinding.bindingId}</span></p>}
      {planning.approvalRequest?.status !== 'pending' ? null : <p role="status" className={css.notice}>{t('planning.pendingHelp')}</p>}
    </div> : null}
    {stage === 'context' ? <div className={css.surfaceSection} data-testid="experience-context-readback">
      <h3>{t('context.title')}</h3>
      <p>{t('context.admissionCount')}: {context?.admissionAttempts.length ?? 0}</p>
      {latestAdmission === undefined ? null : <p>{t('context.latestAdmission')}:
        {' '}<span data-testid="experience-latest-admission-state">{latestAdmission.state}</span>
        {' · '}{latestAdmission.reasonCode}
        {' · '}<span className={css.digest}>{latestAdmission.admissionAttemptId}</span>
      </p>}
      {context?.snapshot === null || context?.snapshot === undefined ? <p>{t('context.notPrepared')}</p> : <>
        <div className={css.summaryGrid}>
          <div className={css.fact}><span className={css.factLabel}>{t('context.delivery')}</span>
            <strong className={css.factValue} data-testid="experience-context-delivery-status">{context.delivery?.deliveryStatus ?? t('field.empty')}</strong></div>
          <div className={css.fact}><span className={css.factLabel}>{t('context.sessionEvent')}</span>
            <span className={css.factValue}>{context.delivery?.sessionEventSeq ?? t('field.empty')}</span></div>
        </div>
        <p>{t('context.snapshot')}: <span className={css.digest}>{context.snapshot.contextSnapshotId}</span></p>
        <p>{t('context.scope')}: {context.snapshot.instructionScope} · {t('context.message')}: <span className={css.digest}>{context.snapshot.deliveryMessageId}</span></p>
        <p>{t('context.deliveryId')}: <span data-testid="experience-context-delivery-id" className={css.digest}>{context.delivery?.contextDeliveryId ?? t('field.empty')}</span></p>
        <details><summary>{t('context.modelContent')}: {context.snapshot.sections.length}</summary>
          {context.snapshot.sections.map(section => <section key={section.name}><strong>{section.name}</strong><pre className={css.recordContent}>{section.text}</pre></section>)}
        </details>
        <details><summary>{t('context.retirements')}: {context.retirements.length}</summary>
          <ul>{context.retirements.map(retirement => <li key={retirement.contextRetirementId}>{retirement.reason} · {retirement.status} · {retirement.replacedSessionEventSeq} → {retirement.replacementSessionEventSeq ?? t('field.empty')}</li>)}</ul>
        </details>
      </>}
    </div> : null}
    {stage === 'execution' ? <ExecutionProgressPanel planning={planning} execution={execution}
      store={store} running={running} t={t} /> : null}
    {stage === 'verification' ? <VerificationPanel execution={execution} store={store} running={running} t={t} /> : null}
    {stage === 'settlement' ? <SettlementPanel planning={planning} execution={execution}
      store={store} running={running} t={t} /> : null}
    {stage === 'revision' ? <RevisionPanel execution={execution} store={store} running={running} t={t} /> : null}
  </article>
}

function ExecutionProgressPanel({ planning, execution, store, running, t }: {
  readonly planning: NonNullable<ReturnType<ExperienceStore['getSnapshot']>['selectedPlanning']>
  readonly execution: ReturnType<ExperienceStore['getSnapshot']>['selectedExecution']
  readonly store: ExperienceStore
  readonly running: boolean
  readonly t: Translate
}) {
  const [reason, setReason] = useState('Reviewed current step outcome')
  const [targetStepRef, setTargetStepRef] = useState('')
  const [branchRef, setBranchRef] = useState('')
  const progress = execution?.progress
  const branches = planning.plan.selectedContributions.filter(item => item.role === 'branch' || item.role === 'failure_branch')
  if (progress === undefined || progress === null) return <div className={css.surfaceSection}>
    <h3>{t('execution.title')}</h3><p className={css.muted}>{t('execution.notStarted')}</p>
  </div>
  const terminal = ['completed', 'failed', 'unknown', 'aborted'].includes(progress.state)
  const currentStep = planning.plan.orderedSteps.find(item => item.stepId === progress.stepRef)
  return <div className={css.surfaceSection} data-testid="experience-execution-readback">
    <h3>{t('execution.title')}</h3>
    <div className={css.summaryGrid}>
      <div className={css.fact}><span className={css.factLabel}>{t('execution.state')}</span>
        <strong className={css.factValue} data-testid="experience-progress-state">{t(`execution.state.${progress.state}`)}</strong></div>
      <div className={css.fact}><span className={css.factLabel}>{t('execution.completed')}</span>
        <span className={css.factValue}>{progress.completedStepRefs.length} / {planning.plan.orderedSteps.length}</span></div>
      <div className={css.fact}><span className={css.factLabel}>{t('execution.step')}</span>
        <span className={css.factValue}>{progress.stepIndex + 1} · {currentStep?.content ?? t('field.empty')}</span></div>
      <div className={css.fact}><span className={css.factLabel}>{t('execution.effects')}</span>
        <span className={css.factValue}>{execution?.correlations.length ?? 0}</span></div>
    </div>
    <label className={css.fieldLabel}>{t('execution.reason')}
      <input value={reason} onChange={event => setReason(event.currentTarget.value)} />
    </label>
    <div className={css.actionRow}>
      <Button variant="primary" disabled={running || terminal || progress.state === 'paused' || reason.trim() === ''}
        data-testid="experience-progress-advance" onClick={() => void store.progressUsage('advance', reason.trim())}>
        {t('execution.advance')}
      </Button>
      <Button disabled={running || terminal || progress.state === 'paused' || reason.trim() === ''}
        onClick={() => void store.progressUsage('pause', reason.trim())}>{t('execution.pause')}</Button>
      <Button disabled={running || progress.state !== 'paused' || reason.trim() === ''}
        onClick={() => void store.progressUsage('resume', reason.trim())}>{t('execution.resume')}</Button>
      <Button disabled={running || terminal || reason.trim() === ''}
        onClick={() => void store.progressUsage('abort', reason.trim())}>{t('execution.abort')}</Button>
    </div>
    {branches.length === 0 ? null : <div className={css.formGrid}>
      <label className={css.fieldLabel}>{t('execution.branch')}
        <select value={branchRef} onChange={event => setBranchRef(event.currentTarget.value)}>
          <option value="">{t('field.empty')}</option>
          {branches.map(item => <option key={item.contributionId} value={item.contributionId}>{item.content}</option>)}
        </select>
      </label>
      <label className={css.fieldLabel}>{t('execution.targetStep')}
        <select value={targetStepRef} onChange={event => setTargetStepRef(event.currentTarget.value)}>
          <option value="">{t('field.empty')}</option>
          {planning.plan.orderedSteps.map(item => <option key={item.stepId} value={item.stepId}>{item.stepId}</option>)}
        </select>
      </label>
      <Button disabled={running || terminal || branchRef === '' || targetStepRef === '' || reason.trim() === ''}
        onClick={() => void store.progressUsage('deviate', reason.trim(), { branchRef, targetStepRef })}>
        {t('execution.deviate')}
      </Button>
    </div>}
  </div>
}

function VerificationPanel({ execution, store, running, t }: {
  readonly execution: ReturnType<ExperienceStore['getSnapshot']>['selectedExecution']
  readonly store: ExperienceStore
  readonly running: boolean
  readonly t: Translate
}) {
  const verification = execution?.verification
  return <div className={css.surfaceSection} data-testid="experience-verification-readback">
    <h3>{t('verification.title')}</h3>
    <p className={css.muted}>{t('verification.description')}</p>
    <div className={css.actionRow}><Button variant="primary" disabled={running || execution?.progress === null || execution === undefined}
      data-testid="experience-verify" onClick={() => void store.verifyUsage()}>{t('verification.run')}</Button></div>
    {verification === null || verification === undefined ? <p>{t('verification.empty')}</p> : <>
      <p>{t('verification.phase')}: <strong>{t(`verification.phase.${verification.phase}`)}</strong></p>
      <ul className={css.resultList}>{verification.criteria.map(item => <li key={item.criterionId}
        data-testid={`experience-criterion-${item.criterionId}`}>
        <strong>{t(`verification.criterion.${item.criterionId}`)}</strong> · {t(`verification.result.${item.result}`)}
      </li>)}</ul>
    </>}
  </div>
}

function SettlementPanel({ planning, execution, store, running, t }: {
  readonly planning: NonNullable<ReturnType<ExperienceStore['getSnapshot']>['selectedPlanning']>
  readonly execution: ReturnType<ExperienceStore['getSnapshot']>['selectedExecution']
  readonly store: ExperienceStore
  readonly running: boolean
  readonly t: Translate
}) {
  const settlement = execution?.settlement
  const base = planning.preflights.find(item => item.disposition === 'adaptable' || item.disposition === 'stale')
  return <div className={css.surfaceSection} data-testid="experience-settlement-readback">
    <h3>{t('settlement.title')}</h3>
    {settlement === null || settlement === undefined ? <>
      <p>{t('settlement.empty')}</p>
      <Button variant="primary" disabled={running || execution?.verification === null || execution === undefined}
        data-testid="experience-settle" onClick={() => void store.settleUsage()}>{t('settlement.commit')}</Button>
    </> : <>
      <div className={css.fact}><span className={css.factLabel}>{t('settlement.outcome')}</span>
        <strong className={css.factValue} data-testid="experience-settlement-outcome">{t(`outcome.${settlement.outcome}`)}</strong></div>
      {base === undefined || (execution?.revisionProposals.length ?? 0) > 0 ? null : <Button variant="primary" disabled={running}
        data-testid="experience-revision-propose" onClick={() => void store.proposeRevision(base.experienceVersionId)}>
        {t('revision.propose')}
      </Button>}
    </>}
  </div>
}

function RevisionPanel({ execution, store, running, t }: {
  readonly execution: ReturnType<ExperienceStore['getSnapshot']>['selectedExecution']
  readonly store: ExperienceStore
  readonly running: boolean
  readonly t: Translate
}) {
  const proposal = execution?.revisionProposals.at(-1)
  const [reason, setReason] = useState('Compared with current verifier authority')
  if (proposal === undefined) return <div className={css.surfaceSection}><h3>{t('revision.title')}</h3>
    <p>{t('revision.empty')}</p></div>
  return <div className={css.surfaceSection} data-testid="experience-revision-readback">
    <h3>{t('revision.title')}</h3>
    <p>{t('revision.diagnosis')}: <strong>{t(`revision.classification.${proposal.diagnosis.classification}`)}</strong></p>
    <p>{t('revision.state')}: <strong data-testid="experience-revision-state">{t(`revision.state.${proposal.state}`)}</strong></p>
    <label className={css.fieldLabel}>{t('revision.reason')}
      <input value={reason} onChange={event => setReason(event.currentTarget.value)} />
    </label>
    <ul className={css.resultList}>{proposal.changes.map(change => <li key={change.revisionChangeId}>
      <strong>{componentRoleText(change.semanticRole, t)}</strong> · {t(`revision.decision.${change.decision}`)}<p>{change.replacementContent}</p>
      {change.decision !== 'pending' ? null : <div className={css.actionRow}>
        <Button variant="primary" disabled={running || reason.trim() === ''}
          onClick={() => void store.decideRevision(change.revisionChangeId, 'accept', reason.trim())}>{t('revision.accept')}</Button>
        <Button disabled={running || reason.trim() === ''}
          onClick={() => void store.decideRevision(change.revisionChangeId, 'reject', reason.trim())}>{t('revision.reject')}</Button>
      </div>}
    </li>)}</ul>
    <Button variant="primary" disabled={running || proposal.state !== 'accepted'}
      data-testid="experience-revision-publish" onClick={() => void store.publishRevision()}>{t('revision.publish')}</Button>
    {proposal.state !== 'published' ? null : <p role="status">{t('revision.published')}</p>}
  </div>
}

function discardReasonLabel(reasonCode: string): ExperienceLocaleKey {
  return reasonCode === 'equivalent_content'
    ? 'planning.discardReason.equivalent_content'
    : 'planning.discardReason.experience_conflict'
}

function EligibilitySummary({ inspection, t }: {
  readonly inspection: NonNullable<ReturnType<ExperienceStore['getSnapshot']>['inspection']>
  readonly t: Translate
}) {
  const { termination, episodeRef } = inspection.episode
  const outcome = inspection.outcomeAssessment
  const trigger = inspection.extractionTrigger
  return (
    <section
      data-testid="experience-eligibility"
      data-eligibility-status={trigger.eligibilityStatus}
      data-outcome={outcome.outcome}
      className={css.eligibility}
    >
      <h4>{t('eligibility.title')}</h4>
      <p>{t('eligibility.episode')}: {episodeRef.sessionOrRunId} · {episodeRef.eventStart}–{episodeRef.eventEnd}</p>
      <p>{t('eligibility.termination')}: {t(`termination.${termination.reason}`)}</p>
      <p>{t('eligibility.outcome')}: {t(`outcome.${outcome.outcome}`)}</p>
      {outcome.manifestDigest === null ? null : <p className={css.digest}>{t('eligibility.manifestDigest')}: {outcome.manifestDigest}</p>}
      {outcome.criteria.length === 0 ? null : (
        <details>
          <summary>{t('eligibility.criteria')}: {outcome.criteria.length}</summary>
          <ul>{outcome.criteria.map(criterion => (
            <li key={criterion.criterionId}>
              <strong>{criterion.criterionId}</strong> · {criterion.result}
              {' · '}{t('field.sources')}: {criterion.evidenceRefIds.length}
            </li>
          ))}</ul>
        </details>
      )}
      {inspection.outcomeSourceRefs.length === 0 ? null : (
        <details>
          <summary>{t('eligibility.outcomeEvidence')}: {inspection.outcomeSourceRefs.length}</summary>
          <SourceRefList refs={inspection.outcomeSourceRefs} t={t} />
        </details>
      )}
      <p>{t('eligibility.status')}: <strong>{t(`eligibility.${trigger.eligibilityStatus}`)}</strong></p>
      <ul>{trigger.eligibilityReasons.map(reason => <li key={reason}>{t(`eligibility.reason.${reason}`)}</li>)}</ul>
      {termination.reason !== 'completed' ? null : <p>{t('eligibility.completedNotSuccess')}</p>}
      {inspection.publicationMode !== 'review_only' ? null : <p role="status">{t('eligibility.reviewOnly')}</p>}
    </section>
  )
}

function ProposalStatus({ state, disclosure, t }: {
  readonly state: ReturnType<ExperienceStore['getSnapshot']>
  readonly disclosure: NonNullable<ReturnType<ExperienceStore['getSnapshot']>['inspection']>['disclosure']
  readonly t: Translate
}) {
  if (state.proposalStatus === 'idle') return null
  const failed = state.proposalStatus === 'failed'
  const limitReached = state.proposalFailure?.code === 'proposal_output_limit'
  const usage = state.proposalFailure?.details
  return (
    <div
      aria-live="polite"
      role={failed ? 'alert' : 'status'}
      data-testid="experience-proposal-status"
      data-proposal-status={state.proposalStatus}
      className={css.proposalStatus}
    >
      <strong>{t(`proposal.status.${state.proposalStatus}`)}</strong>
      {!failed ? null : <p>{t('proposal.failed')}: {state.proposalFailure?.message ?? ''}</p>}
      {!limitReached ? null : (
        <>
          <p>{t('proposal.limitReached')}</p>
          <p>
            {t('proposal.limitUsage')}: {t('disclosure.effectiveOutputTokens')} {displayTokenLimit(disclosure.maxOutputTokens, t)}
            {' · '}{t('proposal.usage.input')} {numericDetail(usage?.inputTokens)}
            {' · '}{t('proposal.usage.output')} {numericDetail(usage?.outputTokens)}
            {' · '}{t('proposal.usage.reasoning')} {numericDetail(usage?.reasoningTokens)}
          </p>
          <p>{t('proposal.limitAction')}</p>
        </>
      )}
    </div>
  )
}

function OmissionDetails({ omissions, t }: {
  readonly omissions: readonly ExtractionOmissionView[]
  readonly t: Translate
}) {
  if (omissions.length === 0) return null
  const counts = new Map<ExtractionOmissionReason, number>()
  for (const omission of omissions) counts.set(omission.reason, (counts.get(omission.reason) ?? 0) + 1)
  return (
    <details data-testid="experience-omission-details">
      <summary>{t('disclosure.omissionDetails')}: {omissions.length}</summary>
      <ul>{[...counts].map(([reason, count]) => (
        <li key={reason}>{t(`disclosure.omissionReason.${reason}`)}: {count}</li>
      ))}</ul>
      <ol>{omissions.map((omission, index) => (
        <li key={`${omission.sourceRefId}:${omission.reason}:${String(index)}`} className={css.digest}>
          {t(`disclosure.omissionReason.${omission.reason}`)} · {omission.eventType} · {omission.sourceRefId}
        </li>
      ))}</ol>
    </details>
  )
}

function outputTokenLimitEquals(
  left: ProposalOutputTokenLimitInput | undefined,
  right: ProposalOutputTokenLimitInput,
): boolean {
  if (left?.mode !== right.mode) return false
  return left.mode !== 'custom' || right.mode !== 'custom' || left.maxTokens === right.maxTokens
}

function displayTokenLimit(value: number | null, t: Translate): string {
  return value === null ? t('disclosure.unset') : String(value)
}

function numericDetail(value: unknown): string {
  return Number.isSafeInteger(value) ? String(value) : '—'
}

function DisclosureSummary({ items, t }: {
  readonly items: readonly ExtractionEvidenceItem[]
  readonly t: Translate
}) {
  const counts = new Map<string, number>()
  for (const item of items) {
    const label = item.evidenceRole
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return (
    <div aria-label={t('disclosure.summary')}>
      <strong>{t('disclosure.summary')}</strong>
      <ul data-testid="experience-disclosure-summary">
        {[...counts].map(([label, count]) => <li key={label}>{label}: {count}</li>)}
      </ul>
    </div>
  )
}

function DisclosureItems({ items, t }: {
  readonly items: readonly ExtractionEvidenceItem[]
  readonly t: Translate
}) {
  return (
    <ol data-testid="experience-disclosure-records-preview">
      {items.map((item, index) => (
        <DisclosureItem key={item.itemId} item={item} index={index} t={t} />
      ))}
    </ol>
  )
}

function DisclosureItem({ item, index, t }: {
  readonly item: ExtractionEvidenceItem
  readonly index: number
  readonly t: Translate
}) {
  return (
    <li className={css.evidenceRecord}>
      <p><strong>{t('disclosure.record')} {index + 1} · {item.evidenceRole}</strong></p>
      <p>{t('disclosure.evidenceClass')}: {item.evidenceClass}</p>
      <time dateTime={item.sourceRef.occurredAt}>{formatDateTime(item.sourceRef.occurredAt)}</time>
      <pre data-testid="experience-disclosure-readable-section" className={css.recordContent}>{item.content}</pre>
      {item.projectionTruncated ? <p>{t('disclosure.truncated')}</p> : null}
      <details data-testid="experience-disclosure-raw-record">
        <summary>{t('disclosure.sourceDetails')}</summary>
        <small>{item.eventType} · {item.sourceRef.locator}</small>
        <p className={css.digest}>{item.sourceContentDigest}</p>
        <p className={css.digest}>{item.projectionDigest}</p>
      </details>
    </li>
  )
}

function CandidateEditor({ candidate, stage, running, t, setStage, store, error }: {
  readonly candidate: CandidateView
  readonly stage: CandidateFieldView['stage']
  readonly running: boolean
  readonly t: Translate
  readonly setStage: (stage: CandidateFieldView['stage']) => void
  readonly store: ExperienceStore
  readonly error?: string | undefined
}) {
  const fields = candidate.fields.filter(field => field.stage === stage)
  const [rejectionReason, setRejectionReason] = useState<CandidateRejectionReasonCode>('non_actionable_abstraction')
  const [pendingDisposition, setPendingDisposition] = useState<'reject' | 'withdraw' | null>(null)
  const [focusTarget, setFocusTarget] = useState<{ readonly field: string; readonly seq: number } | null>(null)
  const [lastFocusedField, setLastFocusedField] = useState<string | null>(null)
  const focusSeq = useRef(0)
  const stageProgress = fieldReviewProgress(fields)
  const overallProgress = fieldReviewProgress(candidate.fields)
  const allDecided = overallProgress.pending === 0
  const complete = candidate.fields.every(field => field.currentDecision?.decision === 'accept'
    || field.currentDecision?.decision === 'edit')
  const reviewOnly = candidate.extractionTrigger.eligibilityStatus !== 'eligible'
  const goToNextUnreviewed = (): void => {
    const next = nextUnreviewedField(candidate.fields, lastFocusedField)
    if (next === null) return
    const nextStage = candidate.fields.find(field => field.field === next)?.stage ?? stage
    if (nextStage !== stage) setStage(nextStage)
    focusSeq.current += 1
    setLastFocusedField(next)
    setFocusTarget({ field: next, seq: focusSeq.current })
  }
  return (
    <section aria-labelledby="candidate-heading" className={css.candidateReview}>
      <h3 id="candidate-heading">{candidate.title}</h3>
      <p data-testid="experience-candidate-state" data-candidate-state={candidate.state} data-candidate-revision={candidate.candidateRevision}>
        {t('candidate.state')}: {t(`candidate.state.${candidate.state}`)} · {t('candidate.revision')}: {candidate.candidateRevision}
      </p>
      <p>{t('eligibility.status')}: <strong>{t(`eligibility.${candidate.extractionTrigger.eligibilityStatus}`)}</strong></p>
      <p>{t('eligibility.outcome')}: {t(`outcome.${candidate.outcomeAssessment.outcome}`)}</p>
      <p>{t('candidate.hostEvidenceGrade')}: <strong>{candidate.evidenceGrade}</strong> · {t('candidate.hostDerived')}</p>
      {reviewOnly ? <p role="status">{t('eligibility.reviewOnly')}</p> : null}
      {candidate.missingEvidence.length === 0 ? null : (
        <section role="alert" data-testid="experience-missing-evidence">
          <h4>{t('candidate.missingEvidence')}</h4>
          <ul>{candidate.missingEvidence.map((item, index) => <li key={index}>{item}</li>)}</ul>
        </section>
      )}
      {candidate.publicationReadiness.blockers.length === 0 ? null : (
        <p data-testid="experience-publication-blockers">
          {t('candidate.blockers')}: {candidate.publicationReadiness.blockers.map(blocker => t(blockerLabel(blocker))).join(' · ')}
        </p>
      )}
      {candidate.state === 'proposed' ? <div className={css.actionRow}>
        <button type="button" disabled={running || pendingDisposition !== null} onClick={() => void store.submit()}>{t('action.startReview')}</button>
        <button type="button" disabled={running || pendingDisposition !== null} onClick={() => setPendingDisposition('withdraw')}>{t('action.withdrawCandidate')}</button>
      </div> : null}
      {candidate.state === 'in_review' ? (
        <>
          <div role="tablist" aria-label={t('review.stages')} className={css.reviewTabs}>
            {(['stable_kernel', 'scope_authority', 'validation_safety'] as const).map(item => (
              <button type="button" role="tab" aria-selected={stage === item} key={item} onClick={() => setStage(item)}>
                {t(`review.stage.${item}`)} · {candidate.fields.filter(field => field.stage === item
                  && field.currentDecision === null).length}
              </button>
            ))}
          </div>
          <ReviewToolbar
            progress={stageProgress}
            overall={overallProgress}
            hasPending={overallProgress.pending > 0}
            allDecided={allDecided}
            onNext={goToNextUnreviewed}
            t={t}
          />
          {error === undefined ? null : (
            <section role="alert" className={css.decisionFailure}>
              <p>{t('review.decisionFailed')}</p>
              <p className={css.digest}>{error}</p>
              <button type="button" disabled={running} onClick={() => void store.refresh()}>{t('review.refresh')}</button>
            </section>
          )}
          {allDecided ? <p role="status" data-testid="experience-review-complete">{t('review.allReviewed')}</p> : null}
          {fields.map(field => <FieldEditor
            key={`${candidate.candidateId}:${field.field}:${field.currentDecision?.decisionId ?? 'pending'}`}
            field={field}
            episodeRefs={candidate.sourceEpisodeRefs}
            sources={candidate.sourceRefs}
            running={running}
            t={t}
            store={store}
            focusTarget={focusTarget}
          />)}
          {reviewOnly ? null : (
            <button
              type="button"
              disabled={running || !candidate.publicationReadiness.ready}
              onClick={() => void store.accept()}
            >{t('action.acceptCandidate')}</button>
          )}
          {!complete ? <p>{t('review.incomplete')}</p> : null}
          {candidate.unresolvedFields.length > 0 ? <p>{t('review.unresolved')}</p> : null}
          <div className={css.actionRow}>
            <label>
              {t('candidate.rejectionReason')}
              <select
                name="candidate-rejection-reason"
                value={rejectionReason}
                onChange={event => setRejectionReason(event.currentTarget.value as CandidateRejectionReasonCode)}
              >
                {CANDIDATE_REJECTION_REASON_CODES.map(reason => (
                  <option key={reason} value={reason}>{t(`reason.${reason}`)}</option>
                ))}
              </select>
            </label>
            <button type="button" disabled={running || pendingDisposition !== null} onClick={() => setPendingDisposition('reject')}>{t('action.rejectCandidate')}</button>
            <button type="button" disabled={running || pendingDisposition !== null} onClick={() => setPendingDisposition('withdraw')}>{t('action.withdrawCandidate')}</button>
          </div>
        </>
      ) : null}
      {candidate.state === 'accepted' ? (
        <div className={css.actionRow}>
          <button type="button" disabled={running || pendingDisposition !== null || !candidate.publicationReadiness.ready} onClick={() => void store.publishCandidate()}>{t('action.publishCandidate')}</button>
          <button type="button" disabled={running || pendingDisposition !== null} onClick={() => setPendingDisposition('withdraw')}>{t('action.withdrawCandidate')}</button>
        </div>
      ) : null}
      {pendingDisposition === null ? null : (
        <section role="alert" className={css.confirmation}>
          <p>{pendingDisposition === 'reject' ? t('candidate.confirmReject') : t('candidate.confirmWithdraw')}</p>
          <div className={css.actionRow}>
            <button type="button" disabled={running} onClick={() => {
              const disposition = pendingDisposition
              setPendingDisposition(null)
              void (disposition === 'reject'
                ? store.reject(rejectionReason)
                : store.withdraw('user_withdrawn'))
            }}>{pendingDisposition === 'reject' ? t('candidate.confirmRejectAction') : t('candidate.confirmWithdrawAction')}</button>
            <button type="button" disabled={running} onClick={() => setPendingDisposition(null)}>{t('action.cancel')}</button>
          </div>
        </section>
      )}
      {candidate.state === 'published' ? <p>{t('candidate.published')}</p> : null}
      {candidate.dispositionReason === null ? null : <p>{t('candidate.disposition')}: {candidate.dispositionReason}</p>}
      {candidate.excludedSteps.length === 0 ? null : (
        <details>
          <summary>{t('candidate.excluded')}</summary>
          <ul>{candidate.excludedSteps.map((item, index) => <li key={index}>{item.summary}: {item.reason}</li>)}</ul>
        </details>
      )}
    </section>
  )
}

function blockerLabel(blocker: string): ExperienceLocaleKey {
  switch (blocker) {
    case 'extraction_not_eligible': return 'blocker.extraction_not_eligible'
    case 'missing_evidence': return 'blocker.missing_evidence'
    case 'unresolved_fields': return 'blocker.unresolved_fields'
    case 'field_decisions_incomplete': return 'blocker.field_decisions_incomplete'
    case 'field_rejected': return 'blocker.field_rejected'
    case 'evidence_grade_exceeds_sources': return 'blocker.evidence_grade_exceeds_sources'
    default: return 'blocker.unknown'
  }
}

function legacyWarningLabel(warning: string): ExperienceLocaleKey {
  return warning === 'pre_v3_active_state_unverified'
    ? 'version.warning.pre_v3_active_state_unverified'
    : 'version.warning.unknown'
}

function ReviewToolbar({ progress, overall, hasPending, allDecided, onNext, t }: {
  readonly progress: FieldReviewProgress
  readonly overall: FieldReviewProgress
  readonly hasPending: boolean
  readonly allDecided: boolean
  readonly onNext: () => void
  readonly t: Translate
}) {
  const reviewed = overall.accepted + overall.edited + overall.rejected
  return (
    <div className={css.reviewToolbar} data-testid="experience-review-progress">
      <span className={css.reviewSummary}>
        {t('review.accepted')}: {progress.accepted} · {t('review.edited')}: {progress.edited} · {t('review.rejected')}: {progress.rejected} · {t('review.pending')}: {progress.pending}
      </span>
      <span className={css.reviewSummary}>{t('review.reviewedCount', { reviewed, total: overall.total })}</span>
      <span className={css.reviewSummary}>{t('review.hasPending', { pending: overall.pending })}</span>
      {allDecided ? <span role="status">{t('review.allReviewed')}</span> : null}
      <button
        type="button"
        data-testid="experience-next-unreviewed"
        disabled={!hasPending}
        onClick={onNext}
      >{hasPending ? t('review.nextUnreviewed') : t('review.allReviewed')}</button>
    </div>
  )
}

function FieldEditor({ field, episodeRefs, sources, running, t, store, focusTarget }: {
  readonly field: CandidateFieldView
  readonly episodeRefs: readonly EpisodeRefView[]
  readonly sources: readonly SourceRefView[]
  readonly running: boolean
  readonly t: Translate
  readonly store: ExperienceStore
  readonly focusTarget?: { readonly field: string; readonly seq: number } | null
}) {
  const effectiveValue = field.currentDecision?.decision === 'edit'
    ? field.currentDecision.value
    : field.proposedValue
  const [revising, setRevising] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editDraft, setEditDraft] = useState<FieldEditDraft | null>(() => createFieldEditDraft(field.field, effectiveValue))
  const [effectiveSourceRefs, setEffectiveSourceRefs] = useState<readonly string[]>([])
  const [editIssue, setEditIssue] = useState<FieldEditIssue | null>(null)
  const [reason, setReason] = useState('')
  const articleRef = useRef<HTMLElement | null>(null)
  const changed = !fieldValuesEqual(field.proposedValue, effectiveValue)
  const decided = field.currentDecision !== null
  const showDecisionForm = !decided || revising
  const reasonMissing = reason.trim() === ''
  useEffect(() => {
    if (focusTarget?.field !== field.field) return
    articleRef.current?.focus()
    articleRef.current?.scrollIntoView({ block: 'center' })
  }, [focusTarget, field.field])
  const beginEditing = (): void => {
    setEditDraft(createFieldEditDraft(field.field, effectiveValue))
    setEffectiveSourceRefs([])
    setEditIssue(null)
    setEditing(true)
    setRevising(true)
  }
  const cancelEditing = (): void => {
    setEditing(false)
    setEffectiveSourceRefs([])
    setEditIssue(null)
  }
  return (
    <article ref={articleRef} tabIndex={-1} className={css.field} data-field={field.field}>
      <h4>{fieldLabel(field, t)}</h4>
      <small className={css.digest}>{field.field}</small>
      <CandidateFieldValue field={field} value={effectiveValue} t={t} />
      {!changed ? null : <FieldDiff field={field} proposed={field.proposedValue} effective={effectiveValue} t={t} />}
      {field.currentDecision?.decision === 'edit' ? (
        <details>
          <summary>{t('field.modelProposal')}</summary>
          <CandidateFieldValue field={field} value={field.proposedValue} t={t} />
          <p>{t('field.modelProposalSources')}: {field.proposedSourceRefs.length}</p>
          <CandidateEvidenceRefs
            ids={field.proposedSourceRefs}
            episodeRefs={episodeRefs}
            sourceRefs={sources}
            t={t}
          />
        </details>
      ) : null}
      <p>{t('field.sources')}: {field.sourceRefs.length} · {field.unresolved ? t('field.unresolved') : t('field.sourced')}</p>
      {field.sourceRefs.length === 0 ? null : (
        <CandidateEvidenceRefs
          ids={field.sourceRefs}
          episodeRefs={episodeRefs}
          sourceRefs={sources}
          t={t}
        />
      )}
      {decided ? (
        <p>
          {t('field.decision')}: {t(`decision.${field.currentDecision!.decision}`)} · {t('field.reason')}: {field.currentDecision!.reason}
        </p>
      ) : null}
      {decided && !revising ? (
        <button type="button" disabled={running} onClick={() => setRevising(true)}>{t('decision.revise')}</button>
      ) : null}
      {showDecisionForm ? (
        <>
          <CommonDecisionReasons value={reason} onPick={setReason} t={t} />
          <label>{t('field.reason')}<input
            name={`candidate-field-reason-${field.field}`}
            autoComplete="off"
            required
            value={reason}
            onChange={event => setReason(event.currentTarget.value)}
          /></label>
          {!reasonMissing ? null : <p>{t('field.reasonRequired')}</p>}
          <div className={css.actionRow}>
            <button type="button" disabled={running || reasonMissing} onClick={() => void store.decide(field.field, {
              decision: 'accept', reason,
            })}>{t('decision.accept')}</button>
            <button type="button" disabled={running || reasonMissing} onClick={() => void store.decide(
              field.field, { decision: 'reject', reason },
            )}>{t('decision.reject')}</button>
            {editDraft === null ? null : (
              <button type="button" disabled={running} onClick={() => editing ? cancelEditing() : beginEditing()}>
                {editing ? t('decision.cancelEdit') : t('decision.edit')}
              </button>
            )}
            {!decided || !revising ? null : (
              <button type="button" disabled={running} onClick={() => {
                cancelEditing()
                setRevising(false)
                setReason('')
              }}>{t('decision.cancelRevision')}</button>
            )}
          </div>
          {editDraft !== null ? null : <p>{t('field.editHostOwned')}</p>}
          {!editing ? null : (
            <section aria-label={t('field.editSection')} aria-busy={running} className={css.editor}>
              <fieldset disabled={running} className={css.editorControls}>
                <legend>{t('field.editSection')}</legend>
                <TypedFieldEditor field={field.field} draft={editDraft!} setDraft={setEditDraft} t={t} />
                <EffectiveSourceSelector
                  episodeRefs={episodeRefs}
                  sourceRefs={sources}
                  selected={effectiveSourceRefs}
                  setSelected={setEffectiveSourceRefs}
                  t={t}
                />
                {effectiveSourceRefs.length > 0 ? null : <p role="status">{t('field.effectiveSourceRequired')}</p>}
                {editIssue === null ? null : <p role="alert">{t(`field.editIssue.${editIssue}`)}</p>}
              </fieldset>
              <button
                type="button"
                disabled={running || reasonMissing || effectiveSourceRefs.length === 0}
                onClick={() => {
                  const resolved = resolveFieldEdit(editDraft!, effectiveSourceRefs)
                  if (!resolved.ok) {
                    setEditIssue(resolved.issue)
                    return
                  }
                  setEditIssue(null)
                  void store.decide(field.field, {
                    decision: 'edit',
                    value: resolved.value,
                    effectiveSourceRefs,
                    reason,
                  })
                }}
              >{t('decision.saveEdit')}</button>
            </section>
          )}
        </>
      ) : null}
    </article>
  )
}

function TypedFieldEditor({ field, draft, setDraft, t }: {
  readonly field: string
  readonly draft: FieldEditDraft
  readonly setDraft: (draft: FieldEditDraft) => void
  readonly t: Translate
}) {
  switch (draft.kind) {
    case 'text':
      return <label>{t('field.editedValue')}<textarea name={`candidate-field-value-${field}`} autoComplete="off" rows={4} value={draft.value} onChange={event => setDraft({
        kind: 'text', value: event.currentTarget.value,
      })} style={{ width: '100%' }} /></label>
    case 'record':
      return (
        <fieldset>
          <legend>{t('field.recordEntries')}</legend>
          {draft.entries.map((entry, index) => (
            <div key={index} className={css.recordEditorRow}>
              <label>{t('field.recordKey')}<input name={`candidate-field-${field}-key-${String(index)}`} autoComplete="off" value={entry.key} onChange={event => setDraft({
                kind: 'record',
                entries: draft.entries.map((item, itemIndex) => itemIndex === index
                  ? { ...item, key: event.currentTarget.value }
                  : item),
              })} /></label>
              <label>{t('field.recordValue')}<input name={`candidate-field-${field}-value-${String(index)}`} autoComplete="off" value={entry.value} onChange={event => setDraft({
                kind: 'record',
                entries: draft.entries.map((item, itemIndex) => itemIndex === index
                  ? { ...item, value: event.currentTarget.value }
                  : item),
              })} /></label>
              <button type="button" onClick={() => setDraft({
                kind: 'record', entries: draft.entries.filter((_, itemIndex) => itemIndex !== index),
              })}>{t('decision.removeEntry')}</button>
            </div>
          ))}
          <button type="button" onClick={() => setDraft({
            kind: 'record', entries: [...draft.entries, { key: '', value: '' }],
          })}>{t('decision.addEntry')}</button>
        </fieldset>
      )
    case 'privacy':
      return (
        <label>{t('field.editedValue')}<select name={`candidate-field-value-${field}`} value={draft.value} onChange={event => setDraft({
          kind: 'privacy', value: event.currentTarget.value as typeof draft.value,
        })}>
          <option value="public">{t('privacy.public')}</option>
          <option value="workspace">{t('privacy.workspace')}</option>
          <option value="restricted">{t('privacy.restricted')}</option>
        </select></label>
      )
    case 'use_modes':
      return (
        <fieldset>
          <legend>{t('field.editedValue')}</legend>
          {M2_ALLOWED_USE_MODES.map(mode => (
            <label key={mode}>
              <input
                type="checkbox"
                name={`candidate-field-${field}-use-mode`}
                checked={draft.values.includes(mode)}
                onChange={event => setDraft({
                  kind: 'use_modes',
                  values: event.currentTarget.checked
                    ? [...draft.values, mode]
                    : draft.values.filter(item => item !== mode),
                })}
              /> {t(`useMode.${mode}`)}
            </label>
          ))}
        </fieldset>
      )
    case 'component':
      return <label>{t('field.editedValue')}<textarea name={`candidate-field-value-${field}`} autoComplete="off" rows={6} value={draft.value.content} onChange={event => setDraft({
        kind: 'component', value: { ...draft.value, content: event.currentTarget.value },
      })} style={{ width: '100%' }} /></label>
  }
}

function EffectiveSourceSelector({ episodeRefs, sourceRefs, selected, setSelected, t }: {
  readonly episodeRefs: readonly EpisodeRefView[]
  readonly sourceRefs: readonly SourceRefView[]
  readonly selected: readonly string[]
  readonly setSelected: (sourceRefs: readonly string[]) => void
  readonly t: Translate
}) {
  return (
    <fieldset>
      <legend>{t('field.effectiveSources')}</legend>
      {[...episodeRefs.map(ref => ({ id: ref.episodeRefId as string, label: episodeSourceLabel(ref, t) })),
        ...sourceRefs.map(ref => ({ id: ref.sourceRefId as string, label: sourceLabel(ref, t) }))].map(source => (
        <label key={source.id} className={css.sourceChoice}>
          <input
            type="checkbox"
            name="candidate-field-effective-source"
            checked={selected.includes(source.id)}
            onChange={event => setSelected(event.currentTarget.checked
              ? [...selected, source.id]
              : selected.filter(item => item !== source.id))}
          /> {source.label}
        </label>
      ))}
    </fieldset>
  )
}

function FieldDiff({ field, proposed, effective, t }: {
  readonly field: CandidateFieldView
  readonly proposed: unknown
  readonly effective: unknown
  readonly t: Translate
}) {
  const diff = fieldTextDiff(proposed, effective)
  if (diff === null) {
    // Complex (structured) field: compare the two readable sides, never a meaningless JSON block.
    return (
      <section className={css.fieldDiff} data-testid="candidate-field-diff" data-diff-kind="structured">
        <p className={css.fieldDiffTitle}>{t('field.diffChanged')}</p>
        <div className={css.diffSide}>
          <p><strong>{t('field.diffOriginal')}</strong></p>
          <CandidateFieldValue field={field} value={proposed} t={t} />
          <p><strong>{t('field.diffEffective')}</strong></p>
          <CandidateFieldValue field={field} value={effective} t={t} />
        </div>
      </section>
    )
  }
  return (
    <section className={css.fieldDiff} data-testid="candidate-field-diff" data-diff-kind="text">
      <p className={css.fieldDiffTitle}>{t('field.diffChanged')}</p>
      {diff.map((segment, index) => (
        <p key={index} className={css.diffLine} data-diff-segment={segment.type}>
          <span className={segment.type === 'removed' ? css.diffRemoved
            : segment.type === 'added' ? css.diffAdded : css.diffUnchanged}>
            {segment.text}
          </span>
        </p>
      ))}
    </section>
  )
}

function CommonDecisionReasons({ value, onPick, t }: {
  readonly value: string
  readonly onPick: (reason: string) => void
  readonly t: Translate
}) {
  return (
    <div className={css.reasonChips} role="group" aria-label={t('field.commonReasons')}>
      <span className={css.reviewSummary}>{t('field.commonReasons')}:</span>
      {COMMON_DECISION_REASONS.map(key => {
        const text = t(key)
        return (
          <button
            key={key}
            type="button"
            className={css.reasonChip}
            aria-pressed={value === text}
            onClick={() => onPick(text)}
          >{text}</button>
        )
      })}
    </div>
  )
}

function CandidateFieldValue({ field, value, t }: {
  readonly field: CandidateFieldView
  readonly value: unknown
  readonly t: Translate
}) {
  if (field.field === 'sourceEpisodeRefs' || field.field === 'sourceRefs') {
    return <p>{t('field.boundSourcesBelow')}</p>
  }
  if (field.componentRole !== null && isDiagnosticComponentValue(value)) {
    return (
      <>
        <p className={css.readableValue}>{value.content}</p>
        <details>
          <summary>{t('field.technicalDetails')}</summary>
          <p>{t('field.componentKey')}: {value.componentKey}</p>
          <p>{t('field.componentRole')}: {value.role}</p>
        </details>
      </>
    )
  }
  if (field.field === 'proposedKind' && value === 'diagnostic') return <p>{t('kind.diagnostic')}</p>
  if (field.field === 'privacyClass' && (value === 'public' || value === 'workspace' || value === 'restricted')) {
    return <p>{t(`privacy.${value}`)}</p>
  }
  if (field.field === 'allowedUseModes' && Array.isArray(value)) {
    return <ul>{value.map(mode => <li key={String(mode)}>{isM2UseMode(mode) ? t(`useMode.${mode}`) : String(mode)}</li>)}</ul>
  }
  return <ReadableValue value={value} />
}

function CandidateEvidenceRefs({ ids, episodeRefs, sourceRefs, t }: {
  readonly ids: readonly string[]
  readonly episodeRefs: readonly EpisodeRefView[]
  readonly sourceRefs: readonly SourceRefView[]
  readonly t: Translate
}) {
  return (
    <ul>{ids.map(id => {
      const episode = episodeRefs.find(item => item.episodeRefId === id)
      if (episode !== undefined) {
        return <li key={id}>
          <strong>{t('sourceKind.episode')}</strong> · {episode.sessionOrRunId}
          <br />{t('field.eventRange')}: {episode.eventStart}–{episode.eventEnd}
          <br /><time dateTime={episode.occurredAt.start}>{formatDateTime(episode.occurredAt.start)}</time>
          {' – '}<time dateTime={episode.occurredAt.end}>{formatDateTime(episode.occurredAt.end)}</time>
          <details><summary>{t('field.technicalDetails')}</summary><p className={css.digest}>{id}<br />{episode.contentDigest}</p></details>
        </li>
      }
      const source = sourceRefs.find(item => item.sourceRefId === id)
      if (source !== undefined) {
        return <li key={id}>
          <strong>{t(`sourceKind.${source.sourceKind}`)}</strong> · {t(`sourceSystem.${source.sourceSystem}`)}
          <br /><span>{source.locator}</span>
          <br /><time dateTime={source.occurredAt}>{formatDateTime(source.occurredAt)}</time>
          <details><summary>{t('field.technicalDetails')}</summary><p className={css.digest}>{id}<br />{source.contentDigest}</p></details>
        </li>
      }
      return <li key={id} role="alert">{t('field.sourceUnavailable')}: <span className={css.digest}>{id}</span></li>
    })}</ul>
  )
}

function episodeSourceLabel(ref: EpisodeRefView, t: Translate): string {
  return `${t('sourceKind.episode')} · ${ref.sessionOrRunId} · ${String(ref.eventStart)}–${String(ref.eventEnd)}`
}

function sourceLabel(ref: SourceRefView, t: Translate): string {
  return `${t(`sourceKind.${ref.sourceKind}`)} · ${ref.locator}`
}

function isDiagnosticComponentValue(value: unknown): value is DiagnosticComponentInput {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).componentKey === 'string'
    && typeof (value as Record<string, unknown>).role === 'string'
    && typeof (value as Record<string, unknown>).content === 'string'
    && Array.isArray((value as Record<string, unknown>).sourceRefs)
}

function isM2UseMode(value: unknown): value is typeof M2_ALLOWED_USE_MODES[number] {
  return typeof value === 'string'
    && M2_ALLOWED_USE_MODES.includes(value as typeof M2_ALLOWED_USE_MODES[number])
}

function formatDateTime(value: string): string {
  return DATE_TIME_FORMAT.format(new Date(value))
}

function SourceRefList({ refs, unresolvedIds = [], t }: {
  readonly refs: readonly SourceRefView[]
  readonly unresolvedIds?: readonly string[]
  readonly t: Translate
}) {
  return (
    <ul>{refs.map(ref => (
      <li key={ref.sourceRefId}>
        <strong>{t(`sourceKind.${ref.sourceKind}`)}</strong> · {t(`sourceSystem.${ref.sourceSystem}`)}
        <br /><span className={css.digest}>{ref.locator}</span>
        <br /><time dateTime={ref.occurredAt}>{formatDateTime(ref.occurredAt)}</time>
        {ref.redactionState !== 'digest_only' ? null : <> · {t('field.digestOnly')}</>}
      </li>
    ))}{unresolvedIds.map(sourceRefId => (
      <li key={sourceRefId} className={css.digest}>{t('field.sourceUnavailable')}: {sourceRefId}</li>
    ))}</ul>
  )
}

function fieldLabel(field: CandidateFieldView, t: Translate): string {
  if (field.componentRole !== null) {
    const roleKey = DIAGNOSTIC_ROLE_LABELS[field.componentRole]
    return `${t('field.component')}: ${roleKey === undefined ? field.componentRole : t(roleKey)}`
  }
  const fieldName = field.field
  const labels: Readonly<Record<string, ExperienceLocaleKey>> = {
    proposedKind: 'field.proposedKind',
    sourceEpisodeRefs: 'field.sourceEpisodeRefs',
    sourceRefs: 'field.sourceRefs',
    title: 'field.title',
    intent: 'field.intent',
    scope: 'field.scope',
    validity: 'field.validity',
    authoritySpec: 'field.authoritySpec',
    privacyClass: 'field.privacyClass',
    riskAndEffectSpec: 'field.riskAndEffectSpec',
    allowedUseModes: 'field.allowedUseModes',
    evidenceGrade: 'field.evidenceGrade',
  }
  const key = labels[fieldName]
  return key === undefined ? fieldName : t(key)
}

const DIAGNOSTIC_ROLE_LABELS: Partial<Record<ComponentRole, ExperienceLocaleKey>> = {
  symptom_signature: 'componentRole.symptom_signature',
  environment_scope: 'componentRole.environment_scope',
  observed_fact: 'componentRole.observed_fact',
  hypothesis: 'componentRole.hypothesis',
  discriminator: 'componentRole.discriminator',
  misleading_signal: 'componentRole.misleading_signal',
  branch: 'componentRole.branch',
  resolution_candidate: 'componentRole.resolution_candidate',
  falsifier: 'componentRole.falsifier',
  recovery_verifier: 'componentRole.recovery_verifier',
}

function componentRoleText(role: ComponentRole, t: Translate): string {
  const key = DIAGNOSTIC_ROLE_LABELS[role]
  return key === undefined ? role : t(key)
}

function ReadableValue({ value }: { readonly value: unknown }) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return <p className={css.readableValue}>{String(value)}</p>
  }
  if (Array.isArray(value)) {
    return <ul>{value.map((item, index) => <li key={index}><ReadableValue value={item} /></li>)}</ul>
  }
  if (value !== null && typeof value === 'object') {
    return <dl>{Object.entries(value as Record<string, unknown>).map(([key, item]) => (
      <div key={key}><dt><strong>{key}</strong></dt><dd><ReadableValue value={item} /></dd></div>
    ))}</dl>
  }
  return <p className={css.readableValue}>—</p>
}

function EvidenceRecords({ records, t }: {
  readonly records: readonly BoundedSourceRecord[]
  readonly t: Translate
}) {
  return (
    <ul data-testid="experience-evidence-records">
      {records.map(record => (
        <li key={record.sourceRef.sourceRefId} className={css.evidenceRecord}>
          <p><strong>{t('inspector.eventType')}:</strong> {record.eventType}</p>
          <p>{record.excerpt}</p>
          <p className={css.digest}>{t('inspector.sourceRef')}: {record.sourceRef.sourceRefId}</p>
          <p className={css.digest}>{record.sourceRef.locator}<br />{record.sourceRef.contentDigest}</p>
        </li>
      ))}
    </ul>
  )
}

const DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' })

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Experience Map product copy. */
    'experience-map': ExperienceLocaleKey
  }
}
