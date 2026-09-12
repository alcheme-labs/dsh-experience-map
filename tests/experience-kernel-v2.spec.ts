import { describe, expect, it } from 'vitest'
import {
  EXPERIENCE_KERNEL_IDENTITY_VERSION,
  experienceKernelIdentity,
  projectExperienceKernel,
} from '../src/domain/experience-kernel.js'
import type { ComponentRole, ExperienceComponentInput } from '../src/types.js'

describe('CORR-E1 role-aware Experience Kernel v2', () => {
  it('retains component roles and ordered component identity for every Experience kind', () => {
    expect(EXPERIENCE_KERNEL_IDENTITY_VERSION).toBe('experience-kernel-identity-v2')
    const cases = [
      source('procedure', [
        component('goal_signature', '启动服务'), component('entry_condition', '本地权限有效'),
        component('step', '读取配置', 'procedure:step:1'), component('step', '启动服务', 'procedure:step:2'),
        component('checkpoint', '进程存在'), component('verifier', 'RPC 200'),
      ]),
      source('diagnostic', [
        component('symptom_signature', 'EADDRINUSE'), component('environment_scope', '本地'),
        component('discriminator', '确认端口 owner'), component('resolution_candidate', '停止 owned process'),
        component('recovery_verifier', 'socket restored'),
      ]),
      source('preference_policy', [
        component('directive', '使用中文'), component('modality', 'must'),
        component('subject_scope', 'current user'), component('task_or_output_scope', 'technical replies'),
        component('authority_source', 'user'),
      ]),
      source('fact', [
        component('subject', 'Node'), component('predicate', 'version'),
        component('object_or_value', '22'), component('valid_from', '2099-01-01'),
      ]),
      source('strategy', [
        component('decision_point', 'choose index'), component('hard_constraint', 'offline'),
        component('outcome_measure', 'harmful recall = 0'),
      ]),
      source('causal', [
        component('cause_or_intervention', 'disable cache'), component('effect_or_metric', 'latency falls'),
        component('applicability_condition', 'cache stale'), component('mechanism', 'avoid stale read'),
      ]),
    ] as const

    for (const item of cases) {
      const values = Object.values(projectExperienceKernel(item).typeSpecific).flat().map(decode)
      expect(values.every(value => typeof value.role === 'string' && typeof value.value === 'string'), item.kind).toBe(true)
    }
    const procedure = projectExperienceKernel(cases[0])
    const steps = procedure.typeSpecific.orderedActions!.map(decode)
    expect(steps).toEqual([
      { role: 'step', ordinal: 0, value: '读取配置' },
      { role: 'step', ordinal: 1, value: '启动服务' },
    ])
  })

  it('changes exact identity for role, polarity, order, action, scope, outcome, and verifier flips', () => {
    const base = source('procedure', [
      component('goal_signature', 'deploy app'),
      component('entry_condition', 'write enabled'),
      component('forbidden_condition', 'must not delete data'),
      component('step', 'read config', 'procedure:step:1'),
      component('step', 'build app', 'procedure:step:2'),
      component('checkpoint', 'build passed'),
      component('verifier', 'authenticated RPC 200'),
    ])
    const variants = [
      { ...base, components: replace(base.components, 'entry_condition', { role: 'forbidden_condition' }) },
      { ...base, components: replace(base.components, 'forbidden_condition', { content: 'must delete data' }) },
      { ...base, components: [base.components[0]!, base.components[1]!, base.components[2]!,
        base.components[4]!, base.components[3]!, base.components[5]!, base.components[6]!] },
      { ...base, components: replace(base.components, 'step', { content: 'write config' }) },
      { ...base, scope: { ...base.scope, workspaceRoot: '/workspace/other' } },
      { ...base, components: replace(base.components, 'checkpoint', { content: 'build failed' }) },
      { ...base, components: replace(base.components, 'verifier', { content: 'port open' }) },
    ]
    for (const variant of variants) {
      expect(experienceKernelIdentity(variant)).not.toBe(experienceKernelIdentity(base))
    }
  })

  it('normalizes harmless Unicode and whitespace without turning evolving evidence into a new Series', () => {
    const procedure = source('procedure', [
      component('goal_signature', 'Build   App'), component('step', 'Ａ\t→\nＢ'), component('verifier', 'OK'),
    ])
    const formatted = source('procedure', [
      component('goal_signature', 'Build App'), component('step', 'A → B'), component('verifier', 'OK'),
    ])
    expect(experienceKernelIdentity(formatted)).toBe(experienceKernelIdentity(procedure))
    expect(experienceKernelIdentity({
      ...formatted,
      components: formatted.components.map((item, index) => ({ ...item, componentKey: `renamed:${String(index)}` })),
    })).toBe(experienceKernelIdentity(procedure))

    const fact = source('fact', [
      component('subject', 'Node'), component('predicate', 'version'),
      component('object_or_value', '22'), component('qualifiers', 'arm64'),
      component('valid_from', 'generation-1'), component('source_evidence', 'node --version'),
    ])
    expect(experienceKernelIdentity({
      ...fact,
      components: replace(fact.components, 'object_or_value', { content: '24' }),
    })).toBe(experienceKernelIdentity(fact))

    const preference = source('preference_policy', [
      component('directive', 'answer in Chinese'), component('modality', 'must'),
      component('subject_scope', 'user'), component('task_or_output_scope', 'technical reply'),
      component('authority_source', 'session user'), component('override_policy', 'explicit English request'),
    ])
    expect(experienceKernelIdentity({
      ...preference,
      components: replace(preference.components, 'authority_source', { content: 'imported profile owner' }),
    })).toBe(experienceKernelIdentity(preference))

    const causal = source('causal', [
      component('cause_or_intervention', 'disable cache'), component('effect_or_metric', 'latency falls'),
      component('applicability_condition', 'stale cache'), component('mechanism', 'avoid old read'),
      component('causal_grade', 'observed'),
    ])
    expect(experienceKernelIdentity({
      ...causal,
      components: replace(causal.components, 'causal_grade', { content: 'controlled' }),
    })).toBe(experienceKernelIdentity(causal))
  })
})

function source(
  kind: 'procedure' | 'diagnostic' | 'preference_policy' | 'fact' | 'strategy' | 'causal',
  components: readonly Pick<ExperienceComponentInput, 'componentKey' | 'role' | 'content'>[],
) {
  return { kind, scope: { workspaceRoot: '/workspace/shared', taskFamily: 'test-family' }, components }
}

function component(role: ComponentRole, content: string, componentKey = `component:${role}`) {
  return { componentKey, role, content }
}

function replace(
  components: readonly Pick<ExperienceComponentInput, 'componentKey' | 'role' | 'content'>[],
  role: ComponentRole,
  patch: Partial<Pick<ExperienceComponentInput, 'componentKey' | 'role' | 'content'>>,
) {
  let replaced = false
  return components.map(item => {
    if (replaced || item.role !== role) return item
    replaced = true
    return { ...item, ...patch }
  })
}

function decode(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>
}
