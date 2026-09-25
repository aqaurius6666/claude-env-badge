import { describe, expect, test } from 'bun:test'

import { Cache, expandHome, parseLabel, probe, type Run, sanitize } from '../hooks/label'

describe('sanitize / parseLabel', () => {
  test('first non-blank line, ANSI and control chars stripped', () =>
    expect(sanitize('\n\x1b[31mbilling-prod\x1b[0m\x07\nsecond')).toBe('billing-prod'))
  test('capped', () => expect(sanitize('x'.repeat(100))).toHaveLength(60))
  test('blank -> undefined', () => expect(sanitize(' \n\t')).toBeUndefined())
  test('plain text', () => expect(parseLabel('billing-prod · Admin\n')).toEqual({ text: 'billing-prod · Admin' }))
  test('json', () =>
    expect(parseLabel('{"text":"billing","tier":"prod","bold":true,"color":7}')).toEqual({
      text: 'billing',
      tier: 'prod',
      bold: true,
    }))
  test('json without text is plain text', () => expect(parseLabel('{"tier":"prod"}')).toEqual({ text: '{"tier":"prod"}' }))
  test('bare number is plain text', () => expect(parseLabel('123')).toEqual({ text: '123' }))
  test('json with empty text -> undefined', () => expect(parseLabel('{"text":"  "}')).toBeUndefined())
})

describe('expandHome', () => {
  test('any element', () => expect(expandHome(['~/a.sh', 'x', '~'], '/h')).toEqual(['/h/a.sh', 'x', '/h']))
  test('no home, untouched', () => expect(expandHome(['~/a.sh'], undefined)).toEqual(['~/a.sh']))
  test('~user untouched', () => expect(expandHome(['~bob/a'], '/h')).toEqual(['~bob/a']))
})

describe('probe', () => {
  const ok: Run = async () => ({ exitCode: 0, stdout: 'out\n', stderr: '' })
  test('ok', async () => expect(await probe(ok, ['x'], undefined, 10)).toBe('out\n'))
  test('non-zero', async () =>
    expect(await probe(async () => ({ exitCode: 2, stdout: 'x', stderr: '' }), ['x'], undefined, 10)).toBeUndefined())
  test('empty stdout', async () =>
    expect(await probe(async () => ({ exitCode: 0, stdout: '  \n', stderr: '' }), ['x'], undefined, 10)).toBeUndefined())
  test('rejection (timeout, cannot start)', async () =>
    expect(
      await probe(
        async () => {
          throw new Error('timeout')
        },
        ['x'],
        undefined,
        10,
      ),
    ).toBeUndefined())
  test('empty argv never runs', async () => {
    let n = 0
    await probe(
      async () => {
        n++
        return { exitCode: 0, stdout: 'x', stderr: '' }
      },
      [],
      undefined,
      10,
    )
    expect(n).toBe(0)
  })
  test('stdin and timeout passed through', async () => {
    let seen: unknown
    await probe(
      async (_a, init) => {
        seen = init
        return { exitCode: 0, stdout: 'x', stderr: '' }
      },
      ['x'],
      '{"a":1}',
      77,
    )
    expect(seen).toEqual({ stdin: '{"a":1}', timeoutMs: 77 })
  })
})

describe('Cache', () => {
  test('in-flight dedupe, TTL, negative caching, onChange', async () => {
    let t = 0
    const c = new Cache<string>(() => t)
    let calls = 0
    let result: string | undefined = 'a'
    const load = async () => {
      calls++
      return result
    }
    let changes = 0
    const onChange = () => changes++

    expect(c.peek('k').has).toBe(false)
    const p1 = c.get('k', 100, load, onChange)
    const p2 = c.get('k', 100, load, onChange)
    expect(await p1).toBe('a')
    expect(await p2).toBe('a')
    expect(calls).toBe(1)
    expect(changes).toBe(1) // first settle always notifies
    expect(c.peek('k')).toEqual({ has: true, fresh: true, value: 'a' })

    // fresh: no reload
    await c.get('k', 100, load, onChange)
    expect(calls).toBe(1)

    // stale, same value: reload but no redraw
    t = 200
    await c.get('k', 100, load, onChange)
    expect(calls).toBe(2)
    expect(changes).toBe(1)

    // stale, failing: negative-cached, redraw once, no respawn while fresh
    t = 400
    result = undefined
    await c.get('k', 100, load, onChange)
    await c.get('k', 100, load, onChange)
    expect(calls).toBe(3)
    expect(changes).toBe(2)
    expect(c.peek('k')).toEqual({ has: true, fresh: true, value: undefined })
  })

  test('a throwing load is a cached failure', async () => {
    const c = new Cache<string>(() => 0)
    let calls = 0
    const load = async (): Promise<string> => {
      calls++
      throw new Error('boom')
    }
    expect(await c.get('k', 1000, load)).toBeUndefined()
    expect(await c.get('k', 1000, load)).toBeUndefined()
    expect(calls).toBe(1)
  })

  test('stale value stays visible while refreshing', async () => {
    let t = 0
    const c = new Cache<string>(() => t)
    await c.get('k', 10, async () => 'old')
    t = 50
    let release!: (v: string) => void
    c.refresh('k', 10, () => new Promise<string>((r) => (release = r)))
    expect(c.peek('k')).toEqual({ has: true, fresh: false, value: 'old' })
    release('new')
    await Promise.resolve()
    await Promise.resolve()
    expect(c.peek('k').value).toBe('new')
  })
})
