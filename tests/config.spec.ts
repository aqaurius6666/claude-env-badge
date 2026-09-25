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
})
