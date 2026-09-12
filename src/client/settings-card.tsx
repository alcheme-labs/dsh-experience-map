import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {
  SettingsDescribeFace,
  SettingsSchemaService,
  SettingsScope,
  SettingsScopeSnapshot,
} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  Button,
  IconChevronDownOutline14,
  IconSearchOutline16,
  Input,
  Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  RUNTIME_SETTINGS_KEYS,
  type RuntimeSettings,
  validateRuntimeSettings,
} from '../runtime-settings-contract.js'
import type { AutomationConfigurationView } from '../types.js'
import type { ExperienceLocaleKey } from './locales.js'
import { callExperienceRpc } from './rpc.js'
import css from './settings-card.module.css'

const NS = 'experience-map'
type RuntimeKey = (typeof RUNTIME_SETTINGS_KEYS)[number]
type Translate = PropsLocale<typeof NS>['t']

interface ExperienceSettingsFace {
  readonly connection: ConnectionHandle
  readonly settingsScope: SettingsScope<RuntimeSettings>
  readonly settingsSchema: SettingsSchemaService
  readonly settingsDescribe: SettingsDescribeFace
}

type SettingsCardProps = PropsRuntime<'settings.plugin.item'>
  & PropsLocale<typeof NS>
  & InjectFace<ExperienceSettingsFace>

interface DraftValue {
  readonly value: unknown
  readonly reset: boolean
}

interface FieldSpec {
  readonly key: RuntimeKey
  readonly kind: 'boolean' | 'number' | 'text' | 'select'
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly options?: readonly string[]
}

interface GroupSpec {
  readonly id: 'behavior' | 'model' | 'embedding' | 'evidence' | 'planning' | 'learning'
  readonly advanced: boolean
  readonly fields: readonly FieldSpec[]
}

const GROUPS: readonly GroupSpec[] = [
  {
    id: 'behavior',
    advanced: false,
    fields: [
      { key: 'automaticSuggestionDetection', kind: 'boolean' },
      { key: 'recentSuggestionSessionLimit', kind: 'number', min: 1, max: 64 },
      { key: 'suggestionTtlMs', kind: 'number', min: 86_400_000, max: 7_776_000_000 },
      { key: 'automaticRecall', kind: 'boolean' },
      { key: 'automaticContextInjection', kind: 'select', options: [
        'never', 'after_current_plan_approval', 'eligible_high_confidence',
      ] },
      { key: 'automaticToolExecution', kind: 'select', options: ['disabled', 'when_eligible'] },
      { key: 'defaultTargetExposure', kind: 'select', options: ['local', 'public'] },
      { key: 'defaultRiskClass', kind: 'select', options: ['standard', 'medium', 'high'] },
      { key: 'defaultMustUseExperience', kind: 'boolean' },
    ],
  },
  {
    id: 'model',
    advanced: false,
    fields: [
      { key: 'enrichmentMode', kind: 'select', options: ['disabled', 'on_ambiguity', 'always'] },
      { key: 'generationRoute', kind: 'select', options: ['configured_dsh_provider', 'current_agent_model'] },
      { key: 'provider', kind: 'text' },
      { key: 'model', kind: 'text' },
      { key: 'reasoningEffort', kind: 'select', options: ['off', 'low', 'high', 'max'] },
      { key: 'maxTokens', kind: 'number', min: 1_024, max: 32_768 },
      { key: 'maxModelInputBytes', kind: 'number', min: 8_192, max: 524_288 },
    ],
  },
  {
    id: 'embedding',
    advanced: true,
    fields: [
      { key: 'embeddingProvider', kind: 'select', options: ['disabled', 'transformers_js'] },
      { key: 'embeddingModelPath', kind: 'text' },
      { key: 'embeddingModelId', kind: 'text' },
      { key: 'embeddingModelRevision', kind: 'text' },
      { key: 'embeddingArtifactPath', kind: 'text' },
      { key: 'embeddingArtifactSha256', kind: 'text' },
      { key: 'embeddingArtifactBytes', kind: 'number', min: 1, max: 2_147_483_647 },
      { key: 'embeddingTokenizerConfigBundleSha256', kind: 'text' },
      { key: 'embeddingNormalization', kind: 'select', options: ['l2'] },
      { key: 'embeddingMaxInputTokens', kind: 'number', min: 32, max: 32_768 },
      { key: 'embeddingTruncationPolicy', kind: 'select', options: ['truncate_end'] },
      { key: 'embeddingDimension', kind: 'number', min: 1, max: 4_096 },
      { key: 'embeddingDtype', kind: 'select', options: ['q8', 'fp32', 'fp16'] },
      { key: 'embeddingPooling', kind: 'select', options: ['mean', 'cls'] },
      { key: 'embeddingQueryPrefix', kind: 'text' },
      { key: 'embeddingPassagePrefix', kind: 'text' },
      { key: 'embeddingTimeoutMs', kind: 'number', min: 1_000, max: 300_000 },
      { key: 'embeddingSimilarityThreshold', kind: 'number', min: -1, max: 1, step: 0.01 },
      { key: 'embeddingMargin', kind: 'number', min: 0, max: 2, step: 0.001 },
      { key: 'equivalenceSimilarityThreshold', kind: 'number', min: 0.88, max: 1, step: 0.001 },
      { key: 'equivalenceMargin', kind: 'number', min: 0, max: 2, step: 0.001 },
    ],
  },
  {
    id: 'evidence',
    advanced: true,
    fields: [
      { key: 'maxRecords', kind: 'number', min: 1, max: 512 },
      { key: 'maxRecordBytes', kind: 'number', min: 256, max: 65_536 },
      { key: 'maxTotalBytes', kind: 'number', min: 1_024, max: 1_048_576 },
      { key: 'maxEvidenceItems', kind: 'number', min: 1, max: 256 },
      { key: 'maxEvidenceItemBytes', kind: 'number', min: 256, max: 16_384 },
      { key: 'maxEvidencePacketBytes', kind: 'number', min: 4_096, max: 262_144 },
      { key: 'maxInlineFieldBytes', kind: 'number', min: 256, max: 65_536 },
      { key: 'maxMarkdownProjectionBytes', kind: 'number', min: 4_096, max: 1_048_576 },
    ],
  },
  {
    id: 'planning',
    advanced: true,
    fields: [
      { key: 'retrievalCandidateLimit', kind: 'number', min: 1, max: 128 },
      { key: 'observationFreshnessMs', kind: 'number', min: 1_000, max: 86_400_000 },
      { key: 'planApprovalTtlMs', kind: 'number', min: 60_000, max: 86_400_000 },
      { key: 'planningHistoryLimit', kind: 'number', min: 1, max: 100 },
      { key: 'taskFingerprintMaxTokens', kind: 'number', min: 256, max: 4_096 },
      { key: 'maxPlanningTaskBytes', kind: 'number', min: 1_024, max: 262_144 },
      { key: 'admissionClaimLeaseMs', kind: 'number', min: 1_000, max: 300_000 },
      { key: 'verificationTimeoutMs', kind: 'number', min: 1_000, max: 120_000 },
    ],
  },
  {
    id: 'learning',
    advanced: true,
    fields: [
      { key: 'learningClaimLeaseMs', kind: 'number', min: 1_000, max: 300_000 },
      { key: 'learningRetryDelayMs', kind: 'number', min: 100, max: 300_000 },
      { key: 'learningBatchSize', kind: 'number', min: 1, max: 256 },
    ],
  },
]

/** Register the namespace card under the existing plugin-configuration keyed slot. */
export function registerExperienceSettings(ctx: Context): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const scope = ctx.settingsScope.bind<RuntimeSettings>({ namespace: NS })
  const describe = ctx.settingsScope.describe()
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: NS,
    locale: NS,
    inject: () => ({
      connection,
      settingsScope: scope,
      settingsSchema: ctx.settingsSchema,
      settingsDescribe: describe,
    }),
  }, ExperienceSettingsCard))
}

/** Render the Experience Map namespace inside Settings > Plugins. */
export function ExperienceSettingsCard(props: SettingsCardProps) {
  const settingsSource = useMemo(() => ({
    subscribe: props.settingsScope.subscribe.bind(props.settingsScope),
    getSnapshot: props.settingsScope.getSnapshot.bind(props.settingsScope),
  }), [props.settingsScope])
  const snapshot = useSyncExternalStore(
    settingsSource.subscribe,
    settingsSource.getSnapshot,
    settingsSource.getSnapshot,
  )
  const [cardOpen, setCardOpen] = useState(false)
  const [openGroups, setOpenGroups] = useState<ReadonlySet<GroupSpec['id']>>(
    () => new Set(['behavior', 'model']),
  )
  const [query, setQuery] = useState('')
  const [drafts, setDrafts] = useState<Partial<Record<RuntimeKey, DraftValue>>>({})
  const [draftRevision, setDraftRevision] = useState<number | undefined>()
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [automationConfiguration, setAutomationConfiguration] = useState<AutomationConfigurationView>()
  const saveStarted = useRef(false)
  const dirty = Object.keys(drafts).length > 0
  const validation = useMemo(
    () => validateDraft(props.settingsSchema, props.settingsDescribe, snapshot, drafts, props.t),
    [drafts, props.settingsDescribe, props.settingsSchema, props.t, snapshot],
  )
  useEffect(() => {
    if (saving) saveStarted.current = true
    else if (saveStarted.current && !dirty && failure === null) {
      saveStarted.current = false
      setCardOpen(false)
    }
  }, [dirty, failure, saving])
  useEffect(() => {
    let active = true
    void callExperienceRpc(props.connection, 'automation/config', {}).then(result => {
      if (active && result.ok) setAutomationConfiguration(result.value as AutomationConfigurationView)
    })
    return () => { active = false }
  }, [props.connection, snapshot])

  const stage = (key: RuntimeKey, value: unknown, reset = false) => {
    if (Object.keys(drafts).length === 0) setDraftRevision(snapshot.revision)
    setDrafts(current => ({ ...current, [key]: { value, reset } }))
    setFailure(null)
  }
  const discard = () => {
    setDrafts({})
    setDraftRevision(undefined)
    setFailure(null)
  }
  const save = async () => {
    if (!dirty || validation !== null || saving || !snapshot.writable) return
    setSaving(true)
    setFailure(null)
    const ops: Array<
      { readonly op: 'unset'; readonly path: readonly string[] }
      | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
    > = []
    for (const key of RUNTIME_SETTINGS_KEYS) {
      const draft = drafts[key]
      if (draft === undefined) continue
      ops.push(draft.reset
        ? { op: 'unset', path: [key] }
        : { op: 'set', path: [key], value: coerceDraft(key, draft.value) })
    }
    try {
      await props.settingsScope.mutate(ops, draftRevision)
      setDrafts({})
      setDraftRevision(undefined)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const title = props.t('settings.title')
  return (
    <li className={`${css.card} ${cardOpen ? css.cardOpen : ''}`} data-testid="experience-settings-card">
      <button
        type="button"
        className={css.cardHeader}
        aria-expanded={cardOpen}
        aria-label={`${props.t(cardOpen ? 'settings.collapse' : 'settings.expand')}: ${title}`}
        onClick={() => { setCardOpen(value => !value) }}
      >
        <span className={css.cardHeading}>
          <span className={css.cardTitle}>{title}</span>
          <span className={css.cardDescription}>{props.t('settings.description')}</span>
        </span>
        {dirty ? <Pill>{props.t('settings.unsaved')}</Pill> : null}
        <IconChevronDownOutline14 className={cardOpen ? css.chevronOpen : css.chevron} />
      </button>
      {cardOpen ? (
        <div className={css.body}>
          <Availability snapshot={snapshot} t={props.t} />
          {snapshot.status === 'ready' ? (
            <>
              <div className={css.summary}>
                <div>
                  <strong>{props.t('settings.liveTitle')}</strong>
                  <p>{props.t('settings.liveDescription')}</p>
                </div>
                <span className={css.revision}>{props.t('settings.revision')}: {snapshot.revision ?? '—'}</span>
              </div>
              {automationConfiguration === undefined ? null
                : <AutomationEffectiveState value={automationConfiguration} t={props.t} />}
              <Input
                type="search"
                icon={<IconSearchOutline16 />}
                value={query}
                className={css.search ?? ''}
                placeholder={props.t('settings.search')}
                aria-label={props.t('settings.search')}
                onChange={event => { setQuery(event.currentTarget.value) }}
              />
              <div className={css.groups}>
                {GROUPS.map(group => (
                  <SettingsGroup
                    key={group.id}
                    group={group}
                    query={query}
                    open={openGroups.has(group.id)}
                    snapshot={snapshot}
                    drafts={drafts}
                    disabled={!snapshot.writable || saving}
                    t={props.t}
                    onToggle={() => {
                      setOpenGroups(current => {
                        const next = new Set(current)
                        if (next.has(group.id)) next.delete(group.id)
                        else next.add(group.id)
                        return next
                      })
                    }}
                    onStage={stage}
                  />
                ))}
              </div>
              <div className={css.footer}>
                <div className={css.feedback}>
                  {validation === null ? null : <span role="alert">{validation}</span>}
                  {failure === null ? null : <span role="alert">{props.t('settings.saveFailed')}: {failure}</span>}
                </div>
                <Button variant="outline" size="sm" disabled={!dirty || saving} onClick={discard}>
                  {props.t('settings.discard')}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!dirty || validation !== null || saving || !snapshot.writable}
                  onClick={() => { void save() }}
                >
                  {props.t(saving ? 'settings.saving' : 'settings.save')}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

function AutomationEffectiveState({ value, t }: {
  readonly value: AutomationConfigurationView
  readonly t: Translate
}) {
  return <section className={css.effective} aria-label={t('settings.effective.title')}
    data-testid="experience-automation-effective-state">
    <strong>{t('settings.effective.title')}</strong>
    <dl>
      <dt>{t('settings.field.automaticSuggestionDetection')}</dt>
      <dd>{t(value.suggestionDetection.effective ? 'settings.enabled' : 'settings.disabled')}</dd>
      <dt>{t('settings.field.automaticRecall')}</dt>
      <dd>{t(value.recall.effective ? 'settings.enabled' : 'settings.disabled')}</dd>
      <dt>{t('settings.field.automaticContextInjection')}</dt>
      <dd>{value.contextInjection.effective}</dd>
      <dt>{t('settings.field.automaticToolExecution')}</dt>
      <dd>{value.toolExecution.availability === 'configured_but_unavailable'
        ? t('settings.effective.executionUnavailable') : t('settings.disabled')}</dd>
      <dt>{t('settings.field.enrichmentMode')}</dt>
      <dd>{value.enrichment.availability === 'configured_but_unavailable'
        ? t('settings.effective.enrichmentUnavailable') : t('settings.disabled')}</dd>
      <dt>{t('settings.effective.reranker')}</dt>
      <dd>{value.reranker.availability === 'configured_but_unavailable'
        ? t('settings.effective.rerankerUnavailable') : t('settings.disabled')}</dd>
    </dl>
  </section>
}

function Availability({ snapshot, t }: {
  readonly snapshot: SettingsScopeSnapshot<RuntimeSettings>
  readonly t: Translate
}) {
  if (snapshot.status === 'loading') return <p className={css.notice} role="status">{t('settings.loading')}</p>
  if (snapshot.status === 'unavailable') return <p className={css.notice} role="status">{t('settings.unavailable')}</p>
  if (!snapshot.writable) return <p className={css.notice} role="status">{t('settings.readOnly')}</p>
  return null
}

function SettingsGroup(props: {
  readonly group: GroupSpec
  readonly query: string
  readonly open: boolean
  readonly snapshot: SettingsScopeSnapshot<RuntimeSettings>
  readonly drafts: Partial<Record<RuntimeKey, DraftValue>>
  readonly disabled: boolean
  readonly t: Translate
  readonly onToggle: () => void
  readonly onStage: (key: RuntimeKey, value: unknown, reset?: boolean) => void
}) {
  const query = props.query.trim().toLocaleLowerCase()
  const fields = props.group.fields.filter(field => query === ''
    || field.key.toLocaleLowerCase().includes(query)
    || props.t(`settings.field.${field.key}` as ExperienceLocaleKey).toLocaleLowerCase().includes(query))
  if (fields.length === 0) return null
  const open = query !== '' || props.open
  return (
    <section className={css.group}>
      <button type="button" className={css.groupHeader} aria-expanded={open} onClick={props.onToggle}>
        <span>
          <strong>{props.t(`settings.group.${props.group.id}` as ExperienceLocaleKey)}</strong>
          <small>{props.t(`settings.group.${props.group.id}.description` as ExperienceLocaleKey)}</small>
        </span>
        {props.group.advanced ? <Pill>{props.t('settings.advanced')}</Pill> : null}
        <IconChevronDownOutline14 className={open ? css.chevronOpen : css.chevron} />
      </button>
      {open ? (
        <div className={css.fieldGrid}>
          {fields.map(field => (
            <SettingsField
              key={field.key}
              spec={field}
              snapshot={props.snapshot}
              draft={props.drafts[field.key]}
              disabled={props.disabled}
              t={props.t}
              onStage={props.onStage}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}

function SettingsField(props: {
  readonly spec: FieldSpec
  readonly snapshot: SettingsScopeSnapshot<RuntimeSettings>
  readonly draft: DraftValue | undefined
  readonly disabled: boolean
  readonly t: Translate
  readonly onStage: (key: RuntimeKey, value: unknown, reset?: boolean) => void
}) {
  const { spec, snapshot } = props
  const inherited = inheritedValue(snapshot, spec.key)
  const value = props.draft === undefined
    ? snapshot.value?.[spec.key]
    : props.draft.reset ? inherited : props.draft.value
  const overridden = props.draft?.reset === true ? false
    : props.draft !== undefined || hasOwn(snapshot.user, spec.key)
  const id = `experience-setting-${spec.key}`
  return (
    <div className={css.field}>
      <div className={css.fieldHead}>
        <label htmlFor={id}>{props.t(`settings.field.${spec.key}` as ExperienceLocaleKey)}</label>
        <span className={css.fieldActions}>
          {overridden ? <Pill>{props.t('settings.overridden')}</Pill> : <span>{props.t('settings.inherited')}</span>}
          <button
            type="button"
            disabled={props.disabled || (!overridden && props.draft === undefined)}
            onClick={() => { props.onStage(spec.key, inherited, true) }}
          >
            {props.t('settings.reset')}
          </button>
        </span>
      </div>
      {spec.kind === 'boolean' ? (
        <label className={css.toggle} htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            disabled={props.disabled}
            onChange={event => { props.onStage(spec.key, event.currentTarget.checked) }}
          />
          <span>{props.t(value === true ? 'settings.enabled' : 'settings.disabled')}</span>
        </label>
      ) : spec.kind === 'select' ? (
        <select
          id={id}
          className={css.select}
          value={typeof value === 'string' ? value : ''}
          disabled={props.disabled}
          onChange={event => { props.onStage(spec.key, event.currentTarget.value) }}
        >
          {spec.options?.map(option => <option key={option} value={option}>
            {selectOptionLabel(spec.key, option, props.t)}
          </option>)}
        </select>
      ) : (
        <Input
          id={id}
          type={spec.kind === 'number' ? 'number' : 'text'}
          min={spec.min}
          max={spec.max}
          step={spec.kind === 'number' ? spec.step ?? 1 : undefined}
          value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
          disabled={props.disabled}
          onChange={event => { props.onStage(spec.key, event.currentTarget.value) }}
        />
      )}
      <p className={css.fieldHint}>
        {spec.kind === 'number' ? props.t('settings.range', { min: spec.min, max: spec.max }) : null}
        {spec.kind === 'number' ? ' · ' : null}
        {props.t('settings.inheritedValue')}: {displayValue(inherited, props.t)}
      </p>
      {spec.key === 'automaticContextInjection' && value === 'eligible_high_confidence'
        ? <p className={css.warning}>{props.t('settings.contextApprovalWarning')}</p> : null}
      {spec.key === 'automaticToolExecution' && value === 'when_eligible'
        ? <p className={css.warning}>{props.t('settings.toolExecutionUnavailable')}</p> : null}
      {spec.key === 'generationRoute' && value === 'current_agent_model'
        ? <p className={css.warning}>{props.t('settings.currentAgentModelUnavailable')}</p> : null}
    </div>
  )
}

function selectOptionLabel(key: RuntimeKey, option: string, t: Translate): string {
  if ([
    'enrichmentMode', 'generationRoute', 'automaticContextInjection', 'automaticToolExecution',
  ].includes(key)) {
    return t(`settings.option.${option}` as ExperienceLocaleKey)
  }
  return option
}

function validateDraft(
  schema: SettingsSchemaService,
  describe: SettingsDescribeFace,
  snapshot: SettingsScopeSnapshot<RuntimeSettings>,
  drafts: Partial<Record<RuntimeKey, DraftValue>>,
  t: Translate,
): string | null {
  if (snapshot.status !== 'ready' || snapshot.value === undefined) return null
  const candidate = { ...snapshot.value } as Record<RuntimeKey, unknown>
  for (const key of RUNTIME_SETTINGS_KEYS) {
    const draft = drafts[key]
    if (draft === undefined) continue
    candidate[key] = draft.reset ? inheritedValue(snapshot, key) : coerceDraft(key, draft.value)
  }
  const serializedSchema = describe.getSnapshot().view?.namespaces
    .find(namespace => namespace.ns === NS)?.schema
  if (serializedSchema === undefined) return t('settings.schemaUnavailable')
  const schemaFailure = schema.validate(schema.rehydrate(serializedSchema), candidate)
  if (schemaFailure !== undefined) return schemaFailure
  try {
    validateRuntimeSettings(candidate as unknown as RuntimeSettings)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function coerceDraft(key: RuntimeKey, value: unknown): unknown {
  const spec = GROUPS.flatMap(group => group.fields).find(field => field.key === key)
  if (spec?.kind !== 'number') return typeof value === 'string' ? value.trim() : value
  if (typeof value === 'number') return value
  const parsed = Number(value)
  return spec.step === undefined
    ? (Number.isSafeInteger(parsed) ? parsed : Number.NaN)
    : (Number.isFinite(parsed) ? parsed : Number.NaN)
}

function inheritedValue(snapshot: SettingsScopeSnapshot<RuntimeSettings>, key: RuntimeKey): unknown {
  return hasOwn(snapshot.base, key)
    ? (snapshot.base as Partial<RuntimeSettings>)[key]
    : undefined
}

function hasOwn(value: unknown, key: string): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, key)
}

function displayValue(value: unknown, t: Translate): string {
  if (value === true) return t('settings.enabled')
  if (value === false) return t('settings.disabled')
  return value === undefined ? '—' : String(value)
}
import type { Context } from '@deepseek-ai/cordis'
