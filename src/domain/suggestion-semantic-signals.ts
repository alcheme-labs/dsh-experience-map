/** Strong, local-only semantic signals shared by suggestion detection and materialization. */

export interface ExplicitPreferenceSignal {
  readonly directive: string
  readonly modality: 'must' | 'must_not' | 'prefer' | 'avoid'
  readonly taskOrOutputScope: string | null
  readonly overridePolicy: string | null
  readonly exampleRole: 'positive_example' | 'negative_example'
}

export interface AuthoritativeFactSignal {
  readonly subject: string
  readonly predicate: string
  readonly value: string
  readonly qualifiers: string
  readonly validFrom: string | null
  readonly freshness: string | null
  readonly sourceAuthority: string | null
}

export interface StrategySignal {
  readonly text: string
  readonly options: readonly string[]
  readonly hasHardConstraint: boolean
  readonly hasDecisionCriterion: boolean
  readonly hasTradeoff: boolean
  readonly hasStopRule: boolean
  readonly hasEscalationRule: boolean
  readonly hasOutcomeMeasure: boolean
}

export interface CausalSignal {
  readonly statement: string
  readonly cause: string
  readonly effect: string
  readonly applicability: string | null
  readonly mechanism: string | null
  readonly competingExplanation: string | null
  readonly falsifier: string | null
}

/** Accept only an explicit persistent user directive; a one-off imperative is not a Preference. */
export function parseExplicitPreference(text: string): ExplicitPreferenceSignal | null {
  const normalized = compact(text)
  const persistent = /(?:以后|今后|从现在起|始终|总是|每次|默认|长期|from now on|always|whenever|every time|by default)/iu
  if (!persistent.test(normalized)) return null
  const modality = preferenceModality(normalized)
  if (modality === null) return null
  const scope = firstCapture(normalized, [
    /(?:对于|在|当)([^，。；]{2,100}?)(?:时|中|里)?[，, ]*(?=必须|务必|不要|禁止|绝不|优先|偏好|尽量|避免|默认)/u,
    /(?:when|whenever|for|on)\s+(.{2,100}?)(?=[,;]?\s*(?:always|never|must|prefer|avoid|do not))/iu,
  ])
  const explicitException = firstCapture(normalized, [
    /(?:除非|例外(?:是|为)?)[：:，, ]*([^。；;]+)/u,
    /(?:unless|except when|exception(?: is|:)?)[ ]+([^.;]+)/iu,
  ])
  const noException = /(?:无例外|没有例外|不设例外|no exceptions?)/iu.test(normalized)
  const directive = normalized
    .replace(/(?:除非|例外(?:是|为)?)[：:，, ].*$/u, '')
    .replace(/(?:unless|except when|exception(?: is|:)?)[ ].*$/iu, '')
    .trim()
  return {
    directive,
    modality,
    taskOrOutputScope: scope,
    overridePolicy: explicitException ?? (noException ? 'no_known_exception' : null),
    exampleRole: modality === 'must_not' || modality === 'avoid' ? 'negative_example' : 'positive_example',
  }
}

/**
 * Parse only an explicit typed tool envelope whose declared authority is bound
 * to the preceding tool-call detail. Arbitrary prose, model claims, and a tool
 * output that merely self-declares an unrelated authority never become Facts.
 */
export function parseAuthoritativeFact(text: string): AuthoritativeFactSignal | null {
  const separator = text.indexOf('\n\n')
  if (separator <= 0) return null
  const toolDetail = text.slice(0, separator)
  const toolOutput = text.slice(separator + 2)
  for (const candidate of jsonObjects(toolOutput)) {
    const root = asRecord(candidate)
    const fact = asRecord(root?.experienceFact)
      ?? (root?.kind === 'experience_fact' ? root : undefined)
    if (fact === undefined) continue
    const subject = nonEmptyString(fact.subject)
    const predicate = nonEmptyString(fact.predicate)
    const value = primitiveString(fact.value)
    if (subject === null || predicate === null || value === null) continue
    const sourceAuthority = nonEmptyString(fact.sourceAuthority)
    if (sourceAuthority !== null && !authorityMatchesToolDetail(sourceAuthority, toolDetail)) continue
    return {
      subject,
      predicate,
      value,
      qualifiers: nonEmptyString(fact.qualifiers) ?? 'none',
      validFrom: nonEmptyString(fact.validFrom) ?? nonEmptyString(fact.observedAt),
      freshness: nonEmptyString(fact.validUntil) ?? nonEmptyString(fact.freshness),
      sourceAuthority,
    }
  }
  return null
}

function authorityMatchesToolDetail(authority: string, detail: string): boolean {
  const normalizedAuthority = compact(authority).toLowerCase()
  const normalizedDetail = compact(detail).toLowerCase()
  return normalizedAuthority.length >= 2 && normalizedDetail.includes(normalizedAuthority)
}

/** Detect a decision frame, not an ordinary list: alternatives, a constraint, and a criterion are mandatory. */
export function parseStrategySignal(text: string): StrategySignal | null {
  const normalized = compact(text)
  const labels = [...normalized.matchAll(/(?:方案|选项|option)\s*([A-Z一二三四五1-9])/giu)]
    .map(match => match[1]!.toUpperCase())
  const options = [...new Set(labels)]
  const hasHardConstraint = /(?:硬约束|约束|必须|不能|hard constraint|constraint|must not|must)/iu.test(normalized)
  const hasDecisionCriterion = /(?:选择标准|决策标准|依据|criterion|criteria|choose based on)/iu.test(normalized)
  if (options.length < 2 || !hasHardConstraint || !hasDecisionCriterion) return null
  return {
    text: normalized,
    options,
    hasHardConstraint,
    hasDecisionCriterion,
    hasTradeoff: /(?:权衡|取舍|代价|trade-?off|cost versus|benefit versus)/iu.test(normalized),
    hasStopRule: /(?:停止条件|止损|满足.+则停止|stop when|stop if|stop rule)/iu.test(normalized),
    hasEscalationRule: /(?:升级条件|转人工|请用户决定|escalat|ask the user)/iu.test(normalized),
    hasOutcomeMeasure: /(?:成功指标|结果指标|衡量|度量|outcome measure|success metric|measure by)/iu.test(normalized),
  }
}

/** Detect an explicit cause/effect claim; evidence strength is decided later and never inferred here. */
export function parseCausalSignal(text: string): CausalSignal | null {
  const normalized = compact(text)
  const relation = causalRelation(normalized)
  if (relation === null) return null
  const applicability = firstCapture(normalized, [
    /(?:当|如果|在)([^，。；]{2,100}?)(?:时|下|中)[，, ]*/u,
    /(?:when|if|under)\s+(.{2,100}?)[,;]\s*/iu,
  ])
  if (applicability === null) return null
  return {
    statement: normalized,
    ...relation,
    applicability,
    mechanism: firstCapture(normalized, [/(?:机制|通过)[：:，, ]*([^。；;]+)/u, /(?:mechanism|by)[：:, ]+([^.;]+)/iu]),
    competingExplanation: firstCapture(normalized, [
      /(?:也可能|另一种解释|替代解释|混杂因素)[：:，, ]*([^。；;]+)/u,
      /(?:could also|alternative explanation|confounder)[：:, ]+([^.;]+)/iu,
    ]),
    falsifier: firstCapture(normalized, [
      /(?:证伪条件|若.+则否定|如果.+则否定)[：:，, ]*([^。；;]+)/u,
      /(?:falsifier|would disprove|disprove if)[：:, ]+([^.;]+)/iu,
    ]),
  }
}

function preferenceModality(text: string): ExplicitPreferenceSignal['modality'] | null {
  if (/(?:尽量不要|避免|avoid)/iu.test(text)) return 'avoid'
  if (/(?:禁止|绝不|不要|不得|never|must not|do not)/iu.test(text)) return 'must_not'
  if (/(?:必须|务必|一定要|required|must)/iu.test(text)) return 'must'
  if (/(?:优先|偏好|prefer)/iu.test(text)) return 'prefer'
  return null
}

function causalRelation(text: string): Pick<CausalSignal, 'cause' | 'effect'> | null {
  for (const pattern of [
    /(.{2,160}?)(?:导致|造成|使得)(.{2,160}?)(?:[。；;]|$)/u,
    /because\s+(.{2,160}?),?\s+(?:therefore|so|it causes?|it results? in)\s+(.{2,160}?)(?:[.;]|$)/iu,
    /(.{2,160}?)\s+(?:causes?|results? in|leads? to)\s+(.{2,160}?)(?:[.;]|$)/iu,
  ]) {
    const match = pattern.exec(text)
    if (match !== null) return { cause: compact(match[1]!), effect: compact(match[2]!) }
  }
  return null
}

function firstCapture(text: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const value = pattern.exec(text)?.[1]?.trim()
    if (value !== undefined && value !== '') return value
  }
  return null
}

function jsonObjects(text: string): unknown[] {
  const values: unknown[] = []
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let quoted = false
    let escaped = false
    for (let index = start; index < text.length; index += 1) {
      const char = text[index]!
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
        continue
      }
      if (char === '"') quoted = true
      else if (char === '{') depth += 1
      else if (char === '}' && --depth === 0) {
        try { values.push(JSON.parse(text.slice(start, index + 1)) as unknown) } catch { /* not JSON */ }
        break
      }
    }
  }
  return values
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? compact(value) : null
}

function primitiveString(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : compact(value)
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : null
}

function compact(value: string): string {
  return value.normalize('NFKC').replace(/[\t\n\r ]+/gu, ' ').trim()
}
