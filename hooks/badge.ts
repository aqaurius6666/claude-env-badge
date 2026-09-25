// command -> badges: parse, session default, label script, tier, format.
// Pure: `run` is injected, so bun specs cover it without an engine.

import { type Config, type Rule, tierOf } from './config'
import { targetsOf } from './env'
import { Cache, type Label, parseLabel, probe, type Run, sanitize } from './label'

export type Badge = {
  key: string
  text: string
  color?: string
  bold: boolean
  // placeholder (default still resolving) or unknown (default probe failed): drawn dim
  dim: boolean
  tier?: string
  // for /env-badge test and doctor
  kind: string
  raw?: string
  isDefault: boolean
}

// Rows pinned per tool_use_id: an old row keeps the default it was drawn with
// even after `kubectl config use-context`. Bounded so a long session can't grow it forever.
const MAX_PINS = 2000

export class Resolver {
  readonly defaults: Cache<string>
  readonly labels: Cache<Label>
  private pins = new Map<string, string | undefined>()

  constructor(
    readonly cfg: Config,
    now: () => number = Date.now,
  ) {
    this.defaults = new Cache(now)
    this.labels = new Cache(now)
  }

  // Sync, from cache; a miss starts the probe and draws a placeholder now.
  // `onChange` fires when a probe settles with something new to draw.
  // `run` is passed per call: it closes over the dispatch's `$`.
  badges(command: string, rowId: string, run: Run, onChange: () => void): Badge[] {
    return targetsOf(command, this.cfg.rules).map(({ kind, named }) => {
      const rule = this.rule(kind)
      let raw = named
      let pending = false
      if (named === undefined) {
        const pinKey = `${rowId}:${kind}`
        if (this.pins.has(pinKey)) {
          raw = this.pins.get(pinKey)
        } else {
          const d = this.peekDefault(rule, run, onChange)
          // pin only a fresh value: a stale one may predate a context switch
          if (d.fresh) this.pin(pinKey, d.value)
          raw = d.value
          pending = !d.has
        }
      }
      const label =
        raw === undefined ? undefined : this.peekLabel(rule, raw, named === undefined, command, run, onChange)
      return this.build(rule, raw, named === undefined, pending, label)
    })
  }

  // Awaited form for /env-badge test: fresh default and label for each target.
  async explain(command: string, run: Run): Promise<Badge[]> {
    const out: Badge[] = []
    for (const { kind, named } of targetsOf(command, this.cfg.rules)) {
      const rule = this.rule(kind)
      const raw =
        named ??
        (await this.defaults.get(`default:${kind}`, this.cfg.defaultTtlMs, () => this.loadDefault(rule, run)))
      const label =
        raw === undefined
          ? undefined
          : await this.labels.get(`label:${kind}:${raw}`, this.cfg.labelTtlMs, () =>
              this.loadLabel(rule, raw, named === undefined, command, run),
            )
      out.push(this.build(rule, raw, named === undefined, false, label))
    }
    return out
  }

  clear(): void {
    this.defaults.clear()
    this.labels.clear()
    this.pins.clear()
  }

  pinCount(): number {
    return this.pins.size
  }

  private rule(kind: string): Rule {
    return this.cfg.rules.find((r) => r.id === kind)!
  }

  private pin(key: string, value: string | undefined): void {
    this.pins.set(key, value)
    if (this.pins.size > MAX_PINS) this.pins.delete(this.pins.keys().next().value!)
  }

  private peekDefault(
    rule: Rule,
    run: Run,
    onChange: () => void,
  ): { has: boolean; fresh: boolean; value: string | undefined } {
    const key = `default:${rule.id}`
    this.defaults.refresh(key, this.cfg.defaultTtlMs, () => this.loadDefault(rule, run), onChange)
    return this.defaults.peek(key)
  }

  private peekLabel(
    rule: Rule,
    raw: string,
    isDefault: boolean,
    command: string,
    run: Run,
    onChange: () => void,
  ): Label | undefined {
    if (rule.label.length === 0) return undefined
    const key = `label:${rule.id}:${raw}`
    this.labels.refresh(key, this.cfg.labelTtlMs, () => this.loadLabel(rule, raw, isDefault, command, run), onChange)
    return this.labels.peek(key).value
  }

  private async loadDefault(rule: Rule, run: Run): Promise<string | undefined> {
    const out = await probe(run, rule.default, undefined, this.cfg.labelTimeoutMs)
    return out === undefined ? undefined : sanitize(out)
  }

  private async loadLabel(
    rule: Rule,
    raw: string,
    isDefault: boolean,
    command: string,
    run: Run,
  ): Promise<Label | undefined> {
    if (rule.label.length === 0) return undefined
    const stdin = JSON.stringify({
      kind: rule.id,
      name: raw,
      isDefault,
      tierHint: tierOf(this.cfg.tiers, raw)?.id,
      command,
    })
    const out = await probe(run, rule.label, stdin, this.cfg.labelTimeoutMs)
    return out === undefined ? undefined : parseLabel(out)
  }

  private build(rule: Rule, raw: string | undefined, isDefault: boolean, pending: boolean, label?: Label): Badge {
    const name = label?.text ?? raw
    // tier on what is shown (the label), never the raw id; unknown default has no tier
    const tier = name === undefined ? undefined : tierOf(this.cfg.tiers, name, label?.tier)
    const vars: Record<string, string> = {
      prefix: label?.prefix ?? tier?.prefix ?? '',
      id: rule.id,
      name: name ?? (pending ? '…' : '?'),
      raw: raw ?? '',
      tier: tier?.id ?? '',
      default: isDefault ? ' (default)' : '',
    }
    const text = this.cfg.format.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m)
    return {
      key: `${rule.id}:${raw ?? ''}`,
      text,
      color: label?.color ?? tier?.color,
      bold: label?.bold ?? tier?.bold ?? false,
      dim: name === undefined,
      tier: tier?.id,
      kind: rule.id,
      raw,
      isDefault,
    }
  }
}
