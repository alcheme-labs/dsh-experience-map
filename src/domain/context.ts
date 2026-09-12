import { brandedId } from '../ids.js'
import { digest } from './planning.js'
import type {
  ContextSnapshotSectionView,
  ContextSnapshotView,
  PlanningObservationView,
  PlanningResultView,
} from '../types.js'

const ASSEMBLER_VERSION = 'experience-context-v1' as const

/** Stable digest over the current fact fields that must survive a fresh observation timestamp. */
export function observationFactDigest(observation: PlanningObservationView): string {
  return digest({
    kind: observation.kind,
    providerVersion: observation.providerVersion,
    status: observation.status,
    summary: observation.summary,
    values: observation.values,
    sourceRefs: observation.sourceRefs,
    reasonCode: observation.reasonCode,
  })
}

/** Canonical set of current facts independent of how many Preflights cite them. */
export function observationFactDigests(observations: readonly PlanningObservationView[]): string[] {
  return [...new Set(observations.map(observationFactDigest))].sort()
}

/** Build the exact minimal sections that an approved current plan contributes. */
export function contextSections(planning: PlanningResultView): ContextSnapshotSectionView[] {
  const plan = planning.plan
  const sections: ContextSnapshotSectionView[] = []
  addSection(sections, '使用范围', [
    '这些经验只适用于当前 Usage。当前任务、环境事实或权限变化时停止沿用。',
    `UsagePlan: ${String(plan.usagePlanId)} revision ${String(plan.planRevision)}`,
  ], [String(plan.usagePlanId), ...plan.preflightIds.map(String)])
  addSection(sections, '已确认前提', plan.premises, selectedRefs(planning, 'premise'))
  addSection(sections, '允许步骤', plan.orderedSteps.map(step => step.content),
    plan.orderedSteps.map(step => step.componentRevisionId))
  addSection(sections, '约束与禁止动作', contextConstraints(planning), selectedRefs(planning, 'constraint'))
  addSection(sections, '待验证假设', plan.hypotheses, selectedRefs(planning, 'hypothesis'))
  addSection(sections, '失败与恢复分支', plan.recovery, selectedRefs(planning, 'recovery'))
  addSection(sections, '验收与权威读回', plan.verification, selectedRefs(planning, 'verification'))
  const unknown = planning.preflights.flatMap(preflight => preflight.observations
    .filter(observation => observation.status === 'unknown' || observation.status === 'invalidated')
    .map(observation => `${observation.kind}: ${observation.summary} (${observation.reasonCode ?? observation.status})`))
  addSection(sections, '未知与降级', unique(unknown), planning.preflights.flatMap(preflight =>
    preflight.observations.filter(observation => observation.status !== 'observed')
      .map(observation => observation.contentDigest)))
  return sections
}

function contextConstraints(planning: PlanningResultView): string[] {
  const contributions = planning.plan.selectedContributions
    .filter(item => item.contributionType === 'constraint')
  const selectedContent = new Set(contributions.map(item => item.content))
  return [
    ...contributions.map(item => {
      switch (item.role) {
        case 'misleading_signal':
          return `禁止把以下误导信号当作事实或成功依据：${item.content}`
        case 'discriminator':
          return `先检查以下判别条件，再选择路线：${item.content}`
        case 'falsifier':
          return `若以下反证成立，必须推翻相关假设：${item.content}`
        case 'forbidden_condition':
          return `禁止条件：${item.content}`
        default:
          return `约束：${item.content}`
      }
    }),
    ...planning.plan.constraints
      .filter(value => !selectedContent.has(value))
      .map(value => `用户或计划附加约束：${value}`),
  ]
}

/** Render only the ContextSnapshot sections that will enter the model request. */
export function renderContext(sections: readonly ContextSnapshotSectionView[]): string {
  return [
    '<experience-context scope="current_usage">',
    '以下内容来自已批准且经过当前适用性检查的 Experience Map，不是用户本轮亲自输入。',
    ...sections.flatMap(section => [
      `## ${section.name}`,
      section.text,
    ]),
    '</experience-context>',
  ].join('\n\n')
}

/** Finalize one immutable snapshot after Harness has assigned the delivery MessageId. */
export function materializeContextSnapshot(
  planning: PlanningResultView,
  sections: readonly ContextSnapshotSectionView[],
  contextSnapshotId: string,
  deliveryMessageId: string,
  materializedAt: string,
): ContextSnapshotView {
  const selected = planning.plan.selectedContributions
  const versionRefs = unique(selected.map(item => item.experienceVersionId))
  const componentRefs = unique(selected.map(item => item.componentRevisionId))
  const matchReasons = unique(planning.matchSet.candidates
    .filter(candidate => versionRefs.includes(candidate.experienceVersionId))
    .flatMap(candidate => candidate.reasonCodes))
  const applicabilityResults = planning.preflights.map(preflight =>
    `${String(preflight.experienceVersionId)}:${preflight.disposition}:${preflight.reasonCodes.join(',')}`)
  const currentFactRefs = unique(planning.preflights.flatMap(preflight =>
    preflight.observations.map(observation => observation.contentDigest)))
  const provenanceRefs = unique([
    ...planning.preflights.map(preflight => String(preflight.preflightId)),
    ...planning.preflights.flatMap(preflight => preflight.observations.flatMap(observation => observation.sourceRefs)),
  ])
  const snapshot = {
    contextSnapshotId: brandedId<'ExperienceContextSnapshotId'>(contextSnapshotId, 'contextSnapshotId'),
    usageId: planning.plan.usageId,
    usagePlanId: planning.plan.usagePlanId,
    planRevision: planning.plan.planRevision,
    instructionScope: 'current_usage' as const,
    deliveryMessageId,
    experienceVersionRefs: versionRefs,
    selectedComponentRevisionRefs: componentRefs,
    matchReasons,
    applicabilityResults,
    currentFactRefs,
    sections,
    provenanceRefs,
    assemblerVersion: ASSEMBLER_VERSION,
    materializedAt,
  }
  return { ...snapshot, contentDigest: digest(renderContext(sections)) }
}

function addSection(
  target: ContextSnapshotSectionView[],
  name: string,
  values: readonly string[],
  sourceRefs: readonly string[],
): void {
  const body = unique(values.map(value => value.trim()).filter(Boolean))
  if (body.length === 0) return
  const text = body.map(value => `- ${value}`).join('\n')
  target.push({ name, text, contentDigest: digest(text), sourceRefs: unique(sourceRefs) })
}

function selectedRefs(
  planning: PlanningResultView,
  type: PlanningResultView['plan']['selectedContributions'][number]['contributionType'],
): string[] {
  return planning.plan.selectedContributions
    .filter(item => item.contributionType === type)
    .map(item => String(item.componentRevisionId))
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}
