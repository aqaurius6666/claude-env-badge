import { describe, expect, test } from 'bun:test'

import { Resolver } from '../hooks/badge'
import { configOf } from '../hooks/config'
import type { Run } from '../hooks/label'

type Call = { argv: readonly string[]; stdin?: string }

// fake host: printenv AWS_PROFILE / kubectl current-context / a label script
function host(env: { aws?: string; k8s?: string; label?: (stdin: string) => string | undefined }) {
  const calls: Call[] = []
  const run: Run = async (argv, init) => {
    calls.push({ argv, stdin: init.stdin })
    const cmd = argv.join(' ')
    const out =
      cmd === 'printenv AWS_PROFILE'
        ? env.aws
        : cmd === 'kubectl config current-context'
          ? env.k8s
          : argv[0] === '/label.sh'
            ? env.label?.(init.stdin ?? '')
            : undefined
    return out === undefined ? { exitCode: 1, stdout: '', stderr: 'nope' } : { exitCode: 0, stdout: `${out}\n`, stderr: '' }
  }
  return { run, calls }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('Resolver.badges', () => {
  test('named profile: drawn at once, tier from name', () => {
    const r = new Resolver(configOf({}))
    const [b] = r.badges('aws --profile poc-prod-billing s3 ls', 'row1', host({}).run, () => {})
    expect(b).toMatchObject({ text: '⚠ aws: poc-prod-billing', color: 'red', bold: true, dim: false, tier: 'prod' })
  })

  test('default: placeholder, then resolved and pinned to the row', async () => {
    const h = host({ k8s: 'stg-eks' })
    let redraws = 0
    const r = new Resolver(configOf({}))
    const first = r.badges('kubectl get po', 'row1', h.run, () => redraws++)
    expect(first[0]).toMatchObject({ text: 'k8s: … (default)', dim: true })
    await tick()
    expect(redraws).toBe(1)
    const second = r.badges('kubectl get po', 'row1', h.run, () => redraws++)
    expect(second[0]).toMatchObject({ text: 'k8s: stg-eks (default)', color: 'yellow', dim: false })

    // context switched: a new row sees it once the TTL lapses, rowA keeps what it was drawn with
    let t = 0
    const later = new Resolver(configOf({ defaultTtlMs: 100 }), () => t)
    const h2 = host({ k8s: 'stg-eks' })
    later.badges('kubectl get po', 'rowA', h2.run, () => {})
    await tick()
    later.badges('kubectl get po', 'rowA', h2.run, () => {}) // fresh: pins rowA = stg-eks
    t = 200
    const h3 = host({ k8s: 'prd-eks' })
    // stale value drawn while refreshing, not pinned
    expect(later.badges('kubectl get po', 'rowB', h3.run, () => {})[0]!.text).toBe('k8s: stg-eks (default)')
    await tick()
    expect(later.badges('kubectl get po', 'rowA', h3.run, () => {})[0]!.text).toBe('k8s: stg-eks (default)')
    expect(later.badges('kubectl get po', 'rowB', h3.run, () => {})[0]!.text).toBe('⚠ k8s: prd-eks (default)')
  })

  test('default probe fails: "?" dim, never empty', async () => {
    const r = new Resolver(configOf({}))
    const h = host({})
    r.badges('aws s3 ls', 'row1', h.run, () => {})
    await tick()
    expect(r.badges('aws s3 ls', 'row1', h.run, () => {})[0]).toMatchObject({
      text: 'aws: ? (default)',
      dim: true,
      color: undefined,
    })
  })

  test('label: raw first, then relabeled; tier computed on the label', async () => {
    const h = host({
      label: (stdin) => {
        const j = JSON.parse(stdin) as { name: string }
        return j.name === '123456789012-AdminRole' ? 'billing-prod · Admin' : undefined
      },
    })
    let redraws = 0
    const r = new Resolver(configOf({ 'aws.label': ['/label.sh'] }))
    const cmd = 'aws --profile 123456789012-AdminRole s3 ls'
    expect(r.badges(cmd, 'row1', h.run, () => redraws++)[0]).toMatchObject({
      text: 'aws: 123456789012-AdminRole',
      tier: 'other',
    })
    await tick()
    expect(redraws).toBe(1)
    expect(r.badges(cmd, 'row1', h.run, () => redraws++)[0]).toMatchObject({
      text: '⚠ aws: billing-prod · Admin',
      tier: 'prod',
      color: 'red',
    })
    const stdin = JSON.parse(h.calls.find((c) => c.argv[0] === '/label.sh')!.stdin!)
    expect(stdin).toEqual({ kind: 'aws', name: '123456789012-AdminRole', isDefault: false, tierHint: 'other', command: cmd })
  })

  test('label json can pin tier and style', async () => {
    const h = host({ label: () => '{"text":"sandbox","tier":"prod","color":"magenta","prefix":"!! "}' })
    const r = new Resolver(configOf({ 'aws.label': ['/label.sh'] }))
    await r.explain('aws --profile x s3 ls', h.run)
    expect(r.badges('aws --profile x s3 ls', 'row1', h.run, () => {})[0]).toMatchObject({
      text: '!! aws: sandbox',
      tier: 'prod',
      color: 'magenta',
      bold: true,
    })
  })

  test('broken label script: raw name kept, not respawned per redraw', async () => {
    const h = host({ label: () => undefined })
    const r = new Resolver(configOf({ 'aws.label': ['/label.sh'] }))
    for (let i = 0; i < 5; i++) {
      r.badges('aws --profile stg-a s3 ls', `row${i}`, h.run, () => {})
      await tick()
    }
    expect(h.calls.filter((c) => c.argv[0] === '/label.sh')).toHaveLength(1)
    expect(r.badges('aws --profile stg-a s3 ls', 'row9', h.run, () => {})[0]!.text).toBe('aws: stg-a')
  })

  test('custom format', () => {
    const r = new Resolver(configOf({ format: '[{tier}] {id}={name} ({raw})' }))
    expect(r.badges('aws --profile prd-1 s3 ls', 'r', host({}).run, () => {})[0]!.text).toBe('[prod] aws=prd-1 (prd-1)')
  })

  test('clear drops caches and pins', async () => {
    const r = new Resolver(configOf({}))
    const h = host({ aws: 'a' })
    r.badges('aws s3 ls', 'row1', h.run, () => {})
    await tick()
    r.badges('aws s3 ls', 'row1', h.run, () => {})
    expect(r.pinCount()).toBe(1)
    r.clear()
    expect(r.pinCount()).toBe(0)
    expect(r.defaults.dump()).toEqual([])
  })
})

describe("Resolver.badges with the owner's real config", () => {
  const OWNER_OPTIONS = {
    'aws.bins': ['aws', 'safe-aws'],
    'k8s.bins': ['kubectl', 'helm', 'k9s', 'safe-kubectl'],
  }

  test('prod tier and style reached via safe-aws', () => {
    const r = new Resolver(configOf(OWNER_OPTIONS))
    const [b] = r.badges('safe-aws --profile poc-prod-billing s3 ls', 'row1', host({}).run, () => {})
    expect(b).toMatchObject({ text: '⚠ aws: poc-prod-billing', color: 'red', bold: true, dim: false, tier: 'prod' })
  })

  test('stg tier and style reached via safe-kubectl', () => {
    const r = new Resolver(configOf(OWNER_OPTIONS))
    const [b] = r.badges('safe-kubectl --context poc-stg-eks get po', 'row1', host({}).run, () => {})
    expect(b).toMatchObject({ text: 'k8s: poc-stg-eks', color: 'yellow', bold: false, dim: false, tier: 'stg' })
  })

  test('other tier and style reached via safe-aws', () => {
    const r = new Resolver(configOf(OWNER_OPTIONS))
    const [b] = r.badges('safe-aws --profile sandbox-dev s3 ls', 'row1', host({}).run, () => {})
    expect(b).toMatchObject({ text: 'aws: sandbox-dev', color: 'green', bold: false, dim: false, tier: 'other' })
  })

  test('(default) suffix when safe-aws names no profile', async () => {
    const r = new Resolver(configOf(OWNER_OPTIONS))
    const h = host({ aws: 'prd-billing' })
    r.badges('safe-aws s3 ls', 'row1', h.run, () => {})
    await tick()
    const [b] = r.badges('safe-aws s3 ls', 'row1', h.run, () => {})
    expect(b).toMatchObject({ text: '⚠ aws: prd-billing (default)', isDefault: true, tier: 'prod' })
  })

  test('… placeholder while the default probe is pending has no tier', () => {
    const r = new Resolver(configOf(OWNER_OPTIONS))
    const h = host({ k8s: 'prd-eks' })
    const [b] = r.badges('safe-kubectl get po', 'row1', h.run, () => {})
    expect(b).toMatchObject({ text: 'k8s: … (default)', dim: true, tier: undefined, color: undefined })
  })

  test('? when the default probe fails has no tier', async () => {
    const r = new Resolver(configOf(OWNER_OPTIONS))
    const h = host({})
    r.badges('safe-aws s3 ls', 'row1', h.run, () => {})
    await tick()
    const [b] = r.badges('safe-aws s3 ls', 'row1', h.run, () => {})
    expect(b).toMatchObject({ text: 'aws: ? (default)', dim: true, tier: undefined, color: undefined })
  })

  test('format placeholders resolve for a safe-kubectl badge', () => {
    const r = new Resolver(configOf({ ...OWNER_OPTIONS, format: '[{tier}] {id}={name} raw={raw}{default}' }))
    const [b] = r.badges('safe-kubectl --context stg-eks get po', 'row1', host({}).run, () => {})
    expect(b.text).toBe('[stg] k8s=stg-eks raw=stg-eks')
  })
})
