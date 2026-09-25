import { describe, expect, test } from 'bun:test'

import { configOf, tierOf } from '../hooks/config'

describe('configOf', () => {
  test('defaults', () => {
    const c = configOf({})
    expect(c.enabled).toBe(true)
    expect(c.tools).toEqual(['Bash'])
    expect(c.rules.map((r) => r.id)).toEqual(['aws', 'k8s'])
    expect(c.tiers.map((t) => t.id)).toEqual(['prod', 'stg', 'other'])
    expect(c.unknownKeys).toEqual([])
  })

  test('dotted keys override one field, keep the rest', () => {
    const c = configOf({ 'aws.label': ['~/l.sh'], 'aws.bins': 'aws2', 'prod.color': 'magenta', 'prod.bold': false })
    const aws = c.rules.find((r) => r.id === 'aws')!
    expect(aws.label).toEqual(['~/l.sh'])
    expect(aws.bins).toEqual(['aws2'])
    expect(aws.flags).toEqual(['--profile'])
    const prod = c.tiers.find((t) => t.id === 'prod')!
    expect(prod).toMatchObject({ color: 'magenta', bold: false, prefix: '⚠ ' })
  })

  test('custom rule and tier', () => {
    const c = configOf({
      rules: ['aws', 'gcp'],
      'gcp.bins': ['gcloud'],
      'gcp.flags': ['--project'],
      tiers: ['live', 'other'],
      'live.match': 'live|billing',
      'live.color': 'red',
    })
    expect(c.rules.find((r) => r.id === 'gcp')).toMatchObject({ bins: ['gcloud'], flags: ['--project'], default: [] })
    expect(tierOf(c.tiers, 'billing-prod')?.id).toBe('live')
    expect(tierOf(c.tiers, 'dev')?.id).toBe('other')
  })

  test('unknown and typo keys are reported, bad regex falls back', () => {
    const c = configOf({ 'aws.lable': ['x'], 'prod.match': '(', labelTimeoutMs: 500 })
    expect(c.unknownKeys).toEqual(['aws.lable'])
    expect(c.labelTimeoutMs).toBe(500)
    expect(tierOf(c.tiers, 'prd-eks')?.id).toBe('prod')
  })

  test('tierOf honors a pinned tier', () => {
    const c = configOf({})
    expect(tierOf(c.tiers, 'dev-sandbox', 'prod')?.id).toBe('prod')
    expect(tierOf(c.tiers, 'dev-sandbox', 'nope')?.id).toBe('other')
  })

  // wrapper bins (e.g. a read-only aws-ro) added next to a builtin; names are placeholders, never executed
  describe('extra bins on a builtin rule', () => {
    const WRAPPED = {
      'aws.bins': ['aws', 'aws-ro'],
      'k8s.bins': ['kubectl', 'helm', 'k9s', 'kubectl-ro'],
    }

    test('bins set, builtin flags/vars/default kept', () => {
      const c = configOf(WRAPPED)
      expect(c.rules.find((r) => r.id === 'aws')).toMatchObject({
        bins: ['aws', 'aws-ro'],
        flags: ['--profile'],
        vars: ['AWS_PROFILE'],
        default: ['printenv', 'AWS_PROFILE'],
      })
      expect(c.rules.find((r) => r.id === 'k8s')).toMatchObject({
        bins: ['kubectl', 'helm', 'k9s', 'kubectl-ro'],
        flags: ['--context', '--kube-context'],
        default: ['kubectl', 'config', 'current-context'],
      })
      expect(c.unknownKeys).toEqual([])
    })

    test('bins replaces the builtin list, not appends', () => {
      const c = configOf({ 'aws.bins': ['aws-ro'] })
      expect(c.rules.find((r) => r.id === 'aws')!.bins).toEqual(['aws-ro'])
    })
  })

  describe('non-flat and unknown values', () => {
    test('a nested object value for a rule field is dropped, builtin kept, key still known', () => {
      // configOf's own field readers (list/str/num) only accept strings, numbers,
      // booleans and string lists; a nested object satisfies none of them and
      // falls back to the builtin. (The engine dropping the whole options block
      // for any nested value, as the README warns, happens before configOf ever
      // sees it, so that behavior is not exercised here.)
      const c = configOf({ 'aws.bins': { nope: true } } as any)
      const aws = c.rules.find((r) => r.id === 'aws')!
      expect(aws.bins).toEqual(['aws'])
      // 'aws.bins' is a documented rule field, so it is not reported as an unknown key
      expect(c.unknownKeys).toEqual([])
    })

    test('a nested object value for a top-level field is dropped, default kept', () => {
      const c = configOf({ format: { nope: true } } as any)
      expect(c.format).toBe('{prefix}{id}: {name}{default}')
    })

    test('unknown keys not matching any rule/tier/top-level field are reported', () => {
      const c = configOf({ 'gcp.bins': ['gcloud'], nonsense: 'x' })
      // 'gcp' is not a listed rule id, so 'gcp.bins' is unknown; so is 'nonsense'
      expect(c.unknownKeys.sort()).toEqual(['gcp.bins', 'nonsense'])
    })
  })
})
