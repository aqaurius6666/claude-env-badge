// Flat settings keys -> typed config.
//
// Every rule/tier field is its own dotted key ("aws.bins", "prod.color"): options
// values stay strings, numbers, booleans and string lists.

export type Rule = {
  id: string
  bins: string[]
  flags: string[]
  // VAR=x prefixes and `export VAR=x` in the command itself
  vars: string[]
  // argv run (no shell) for the session default when the command names none
  default: string[]
  // argv run with the target as JSON on stdin; stdout replaces the shown name
  label: string[]
}

export type Tier = {
  id: string
  match: RegExp
  color: string
  bold: boolean
  prefix: string
}

export type Config = {
  enabled: boolean
  tools: string[]
  rules: Rule[]
  tiers: Tier[]
  format: string
  labelTimeoutMs: number
  labelTtlMs: number
  defaultTtlMs: number
  // keys the user wrote that no rule/tier/top-level field reads; shown by /env-badge doctor
  unknownKeys: string[]
}

type Options = Readonly<Record<string, string | number | boolean | readonly string[]>>

const BUILTIN_RULES: Record<string, Omit<Rule, 'id'>> = {
  aws: {
    bins: ['aws'],
    flags: ['--profile'],
    vars: ['AWS_PROFILE'],
    default: ['printenv', 'AWS_PROFILE'],
    label: [],
  },
  k8s: {
    bins: ['kubectl', 'helm', 'k9s'],
    flags: ['--context', '--kube-context'],
    vars: [],
    default: ['kubectl', 'config', 'current-context'],
    label: [],
  },
}

const BUILTIN_TIERS: Record<string, Omit<Tier, 'id'>> = {
  prod: { match: /prod|prd/i, color: 'red', bold: true, prefix: '⚠ ' },
  stg: { match: /stg|stag/i, color: 'yellow', bold: false, prefix: '' },
  other: { match: /.*/, color: 'green', bold: false, prefix: '' },
}

const TOP_LEVEL = new Set([
  'enabled',
  'tools',
  'rules',
  'tiers',
  'format',
  'labelTimeoutMs',
  'labelTtlMs',
  'defaultTtlMs',
])
const RULE_FIELDS = ['bins', 'flags', 'vars', 'default', 'label'] as const
const TIER_FIELDS = ['match', 'color', 'bold', 'prefix'] as const

function list(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === 'string') return [v]
  return undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function regex(v: unknown): RegExp | undefined {
  if (typeof v !== 'string') return undefined
  try {
    return new RegExp(v, 'i')
  } catch {
    return undefined
  }
}

export function configOf(options: Options): Config {
  const o = options as Record<string, unknown>
  const ruleIds = list(o.rules) ?? Object.keys(BUILTIN_RULES)
  const tierIds = list(o.tiers) ?? Object.keys(BUILTIN_TIERS)

  const rules: Rule[] = ruleIds.map((id) => {
    const base = BUILTIN_RULES[id] ?? { bins: [], flags: [], vars: [], default: [], label: [] }
    return {
      id,
      bins: list(o[`${id}.bins`]) ?? base.bins,
      flags: list(o[`${id}.flags`]) ?? base.flags,
      vars: list(o[`${id}.vars`]) ?? base.vars,
      default: list(o[`${id}.default`]) ?? base.default,
      label: list(o[`${id}.label`]) ?? base.label,
    }
  })

  const tiers: Tier[] = tierIds.map((id) => {
    const base = BUILTIN_TIERS[id] ?? { match: /$^/, color: 'white', bold: false, prefix: '' }
    return {
      id,
      match: regex(o[`${id}.match`]) ?? base.match,
      color: str(o[`${id}.color`]) ?? base.color,
      bold: typeof o[`${id}.bold`] === 'boolean' ? (o[`${id}.bold`] as boolean) : base.bold,
      prefix: str(o[`${id}.prefix`]) ?? base.prefix,
    }
  })

  const known = new Set(TOP_LEVEL)
  for (const id of ruleIds) for (const f of RULE_FIELDS) known.add(`${id}.${f}`)
  for (const id of tierIds) for (const f of TIER_FIELDS) known.add(`${id}.${f}`)

  return {
    enabled: o.enabled !== false,
    tools: list(o.tools) ?? ['Bash'],
    rules,
    tiers,
    format: str(o.format) ?? '{prefix}{id}: {name}{default}',
    labelTimeoutMs: num(o.labelTimeoutMs) ?? 2000,
    labelTtlMs: num(o.labelTtlMs) ?? 5 * 60_000,
    defaultTtlMs: num(o.defaultTtlMs) ?? 10_000,
    unknownKeys: Object.keys(o).filter((k) => !known.has(k)),
  }
}

export const SOURCES = ['user', 'project', 'local', 'flag', 'policy'] as const

// Gotcha: register's `options` only carries keys plugin.json's userConfig declares, so
// "aws.bins" never arrives there. Read pluginConfigs ourselves, one source at a time in
// rising precedence, and let each key win from the last source that sets it.
export function optionsOf(declared: Options, sources: readonly unknown[]): Options {
  const out: Record<string, unknown> = { ...declared }
  for (const s of sources) {
    const configs = (s as { pluginConfigs?: Record<string, { options?: unknown }> } | undefined)?.pluginConfigs ?? {}
    for (const [key, v] of Object.entries(configs)) {
      if (key !== 'env-badge' && !key.startsWith('env-badge@')) continue
      const opts = v?.options
      if (opts && typeof opts === 'object' && !Array.isArray(opts)) Object.assign(out, opts)
    }
  }
  return out as Options
}

export function tierOf(tiers: Tier[], text: string, pinned?: string): Tier | undefined {
  if (pinned) {
    const t = tiers.find((x) => x.id === pinned)
    if (t) return t
  }
  return tiers.find((t) => t.match.test(text))
}
