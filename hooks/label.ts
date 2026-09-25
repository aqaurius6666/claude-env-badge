// Probe runner and cache for `<id>.default` and `<id>.label` argv.
// Pure: the caller injects `run` ($.process.run), so bun specs cover it without an engine.

export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type Run = (
  argv: readonly string[],
  init: { stdin?: string; timeoutMs: number },
) => Promise<RunResult>

// What a label script may answer; only `text` is required.
export type Label = {
  text: string
  tier?: string
  color?: string
  bold?: boolean
  prefix?: string
}

const MAX_LEN = 60

// No ANSI/control chars; keeps spacing (a prefix like "⚠ " needs its space).
function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\x00-\x1f\x7f]/g, '')
}

// First line, no ANSI/control chars, capped. Empty -> undefined (never an empty badge).
export function sanitize(s: string): string | undefined {
  const line = strip(s.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim()
  if (!line) return undefined
  return line.length > MAX_LEN ? `${line.slice(0, MAX_LEN - 1)}…` : line
}

// stdout is either plain text or JSON {text, tier?, color?, bold?, prefix?}.
export function parseLabel(stdout: string): Label | undefined {
  const trimmed = stdout.trim()
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed) as Record<string, unknown>
      if (j && typeof j === 'object' && typeof j.text === 'string') {
        const text = sanitize(j.text)
        if (!text) return undefined
        const out: Label = { text }
        if (typeof j.tier === 'string') out.tier = j.tier
        if (typeof j.color === 'string') out.color = j.color
        if (typeof j.bold === 'boolean') out.bold = j.bold
        if (typeof j.prefix === 'string') out.prefix = strip(j.prefix).slice(0, 8)
        return out
      }
    } catch {
      // not JSON: fall through to plain text
    }
  }
  const text = sanitize(stdout)
  return text ? { text } : undefined
}

// "~/x" -> "$HOME/x" in any argv element; no shell, so nobody else expands it.
export function expandHome(argv: readonly string[], home: string | undefined): string[] {
  if (!home) return [...argv]
  return argv.map((a) => (a === '~' || a.startsWith('~/') ? home + a.slice(1) : a))
}

// Non-zero exit, rejection (can't start, timeout, no process noun) or blank stdout -> undefined.
export async function probe(
  run: Run,
  argv: readonly string[],
  stdin: string | undefined,
  timeoutMs: number,
): Promise<string | undefined> {
  if (argv.length === 0) return undefined
  try {
    const r = await run(argv, stdin === undefined ? { timeoutMs } : { stdin, timeoutMs })
    if (r.exitCode !== 0) return undefined
    return r.stdout.trim() === '' ? undefined : r.stdout
  } catch {
    return undefined
  }
}

type Entry<V> = {
  value: V | undefined
  expiresAt: number
  inflight?: Promise<V | undefined>
}

// TTL cache with in-flight dedupe; failures (undefined) are cached too, so a broken
// script is not respawned on every redraw.
export class Cache<V> {
  private entries = new Map<string, Entry<V>>()

  constructor(private now: () => number = Date.now) {}

  // Last settled value, even if stale; `has` false until the first run settles,
  // `fresh` false while stale or a refresh is running.
  peek(key: string): { has: boolean; fresh: boolean; value: V | undefined } {
    const e = this.entries.get(key)
    if (!e || (e.inflight && e.expiresAt === 0)) return { has: false, fresh: false, value: undefined }
    return { has: true, fresh: !e.inflight && e.expiresAt > this.now(), value: e.value }
  }

  // Starts `load` when the key is missing or stale and none is running.
  // `onChange` fires once it settles with a value different from the last one.
  refresh(key: string, ttlMs: number, load: () => Promise<V | undefined>, onChange?: () => void): void {
    void this.get(key, ttlMs, load, onChange)
  }

  // Awaitable form of refresh: the fresh value, running `load` if needed.
  get(
    key: string,
    ttlMs: number,
    load: () => Promise<V | undefined>,
    onChange?: () => void,
  ): Promise<V | undefined> {
    const e = this.entries.get(key)
    if (e?.inflight) return e.inflight
    if (e && e.expiresAt > this.now()) return Promise.resolve(e.value)

    // first settle always notifies: the row drew a placeholder
    const first = e === undefined || e.expiresAt === 0
    const before = e?.value
    const entry: Entry<V> = e ?? { value: undefined, expiresAt: 0 }
    const inflight = load()
      .catch(() => undefined)
      .then((value) => {
        entry.value = value
        entry.expiresAt = this.now() + ttlMs
        delete entry.inflight
        if (onChange && (first || !same(before, value))) onChange()
        return value
      })
    entry.inflight = inflight
    this.entries.set(key, entry)
    return inflight
  }

  clear(): void {
    this.entries.clear()
  }

  dump(): Array<{ key: string; value: V | undefined; ttlLeftMs: number; running: boolean }> {
    const now = this.now()
    return [...this.entries].map(([key, e]) => ({
      key,
      value: e.value,
      ttlLeftMs: Math.max(0, e.expiresAt - now),
      running: e.inflight !== undefined,
    }))
  }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
