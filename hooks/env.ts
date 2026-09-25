// Pure parser: which envs a shell command targets. No $ access, so it tests alone.

import type { Rule } from './config'

export type Target = {
  // the rule's id: "aws", "k8s", ...
  kind: string
  // what the command named; undefined when it named nothing and the session default applies
  named: string | undefined
}

function flagValue(tokens: string[], flags: string[]): string | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    for (const f of flags) {
      if (t === f) return tokens[i + 1]
      if (t.startsWith(`${f}=`)) return t.slice(f.length + 1)
    }
  }
  return undefined
}

function unquote(s: string): string {
  return s.replace(/^(['"])(.*)\1$/, '$2')
}

// Gotcha: naive split, no subshells/heredocs/quoted separators. Good enough to label, never to authorize.
function segments(command: string): string[][] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim().split(/\s+/).filter(Boolean).map(unquote))
    .filter((t) => t.length > 0)
}

function assignment(token: string): [string, string] | undefined {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token)
  return m ? [m[1]!, m[2]!] : undefined
}

// Cheap pre-check so a render of `ls -la` never builds segments.
export function mentionsAny(command: string, rules: Rule[]): boolean {
  return rules.some((r) => r.bins.some((b) => command.includes(b)))
}

export function targetsOf(command: string, rules: Rule[]): Target[] {
  const out: Target[] = []
  const seen = new Set<string>()
  // `export VAR=x; cmd` carries into later segments
  const exported = new Map<string, string>()

  for (let tokens of segments(command)) {
    if (tokens[0] === 'export') {
      for (const t of tokens.slice(1)) {
        const a = assignment(t)
        if (a) exported.set(a[0], a[1])
      }
      continue
    }

    const prefixed = new Map<string, string>()
    let a: [string, string] | undefined
    while (tokens[0] && (a = assignment(tokens[0]))) {
      prefixed.set(a[0], a[1])
      tokens = tokens.slice(1)
    }

    const bin = (tokens[0] ?? '').split('/').pop() ?? ''
    const rule = rules.find((r) => r.bins.includes(bin))
    if (!rule) continue

    let named = flagValue(tokens, rule.flags)
    for (const v of rule.vars) named ??= prefixed.get(v) ?? exported.get(v)

    const key = `${rule.id}:${named ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind: rule.id, named })
  }
  return out
}
