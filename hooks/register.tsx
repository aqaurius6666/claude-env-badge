// Display only: ui.render on ToolUse plus /env-badge. No tool.call, no model context.

import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import { Resolver } from './badge'
import { type Config, configOf, optionsOf, SOURCES } from './config'
import { mentionsAny } from './env'
import { expandHome, type Run } from './label'

const HELP = [
  '/env-badge doctor       effective config, unknown keys, settings vs received options, caches',
  '/env-badge test <cmd>   parse <cmd> and run its default/label probes now',
  '/env-badge reload       clear caches and pinned rows, redraw',
].join('\n')

function runner($: EngineInterface): Run {
  return async (argv, init) => $.process.run(expandHome(argv, await $.env.get('HOME')), init)
}

function redraw($: EngineInterface): () => void {
  return () => {
    try {
      $.ui.invalidate('ui.render')
    } catch {
      // over the 10/s cap: the next settle or repaint catches up
    }
  }
}

function json(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (x instanceof RegExp ? `/${x.source}/${x.flags}` : x))
}

type Sources = Partial<Record<(typeof SOURCES)[number], unknown>>
type Loaded = { cfg: Config; options: PluginOptions; sources: Sources; resolver: Resolver }

async function load($: EngineInterface, declared: PluginOptions): Promise<Loaded> {
  const sources: Sources = {}
  for (const source of SOURCES) {
    try {
      sources[source] = await $.settings.read({ source })
    } catch (err) {
      sources[source] = { error: String(err) }
    }
  }
  const options = optionsOf(declared, SOURCES.map((s) => sources[s]))
  const cfg = configOf(options)
  return { cfg, options, sources, resolver: new Resolver(cfg) }
}

// register has no $, so settings are read on first use; /env-badge reload reads them again.
// Lives as long as this module load (a reload starts a fresh environment).
let loaded: Promise<Loaded> | undefined

function current($: EngineInterface, declared: PluginOptions): Promise<Loaded> {
  loaded ??= load($, declared)
  return loaded
}

export const register: Register = (on, declared) => {
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const drawn = await next(e)
    const { cfg, resolver } = await current($, declared)
    if (!cfg.enabled || !cfg.tools.includes(e.props.tool)) return drawn

    const command = (e.props.input as { command?: unknown } | undefined)?.command
    // cheap gate: most Bash rows never reach the parser
    if (typeof command !== 'string' || !mentionsAny(command, cfg.rules)) return drawn

    const badges = resolver.badges(command, e.props.tool_use_id, runner($), redraw($))
    if (badges.length === 0) return drawn

    const { Box, Text } = await $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {drawn}
        <Box marginLeft={2} gap={2}>
          {badges.map((b) => (
            <Text key={b.key} color={b.color} bold={b.bold} dimColor={b.dim}>
              {b.text}
            </Text>
          ))}
        </Box>
      </Box>
    )
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'env-badge',
      description: 'Env badge: doctor, test <cmd>, reload',
      argumentHint: 'doctor | test <cmd> | reload',
    })
    return next(e)
  })

  on('command.run', { command: 'env-badge' }, async ($, e) => {
    const args = e.args.trim()
    const sub = args.split(/\s+/)[0] ?? ''
    if (sub === 'reload') {
      loaded = undefined
      await current($, declared)
      $.ui.invalidate('ui.render')
      return { text: 'env-badge: settings re-read, caches and pinned rows cleared' }
    }
    const l = await current($, declared)
    if (sub === 'doctor') return { text: doctor(l, declared) }
    if (sub === 'test') return { text: await explain($, l.resolver, args.slice(sub.length).trim()) }
    return { text: sub ? `unknown: ${args}\n${HELP}` : HELP }
  })
}

async function explain($: EngineInterface, resolver: Resolver, cmd: string): Promise<string> {
  if (!cmd) return 'usage: /env-badge test <cmd>'
  const badges = await resolver.explain(cmd, runner($))
  if (badges.length === 0) return `no rule matches: ${cmd}`
  return badges
    .map(
      (b) =>
        `${b.text}    [${b.kind}] raw=${b.raw ?? '?'}${b.isDefault ? ' (default)' : ''} tier=${b.tier ?? '-'} color=${b.color ?? '-'}${b.bold ? ' bold' : ''}`,
    )
    .join('\n')
}

function doctor({ cfg, options, sources, resolver }: Loaded, declared: PluginOptions): string {
  const lines = [
    `enabled: ${cfg.enabled}   tools: ${cfg.tools.join(', ')}`,
    `format: ${cfg.format}`,
    `labelTimeoutMs: ${cfg.labelTimeoutMs}   labelTtlMs: ${cfg.labelTtlMs}   defaultTtlMs: ${cfg.defaultTtlMs}`,
    'rules:',
    ...cfg.rules.map(
      (r) =>
        `  ${r.id}: bins=${r.bins.join(',') || '-'} flags=${r.flags.join(',') || '-'} vars=${r.vars.join(',') || '-'} default=${json(r.default)} label=${json(r.label)}`,
    ),
    'tiers:',
    ...cfg.tiers.map(
      (t) => `  ${t.id}: match=/${t.match.source}/${t.match.flags} color=${t.color}${t.bold ? ' bold' : ''} prefix=${json(t.prefix)}`,
    ),
    `unknown keys: ${cfg.unknownKeys.length ? cfg.unknownKeys.join(', ') : 'none'}`,
    `options from engine (declared userConfig only): ${json(declared)}`,
    `options merged with settings: ${json(options)}`,
  ]

  for (const source of SOURCES) {
    const s = sources[source] as { error?: string; pluginConfigs?: Record<string, { options?: unknown }> } | undefined
    if (s?.error) lines.push(`settings[${source}]: unreadable (${s.error})`)
    for (const [key, v] of Object.entries(s?.pluginConfigs ?? {})) {
      if (key !== 'env-badge' && !key.startsWith('env-badge@')) continue
      const opts = (v?.options ?? {}) as Record<string, unknown>
      const nested = Object.keys(opts).filter((k) => {
        const x = opts[k]
        return typeof x === 'object' && x !== null && !Array.isArray(x)
      })
      lines.push(`settings[${source}].pluginConfigs["${key}"].options: ${json(opts)}`)
      if (nested.length) lines.push(`  ! nested object value(s) ${nested.join(', ')}: ignored, use dotted keys`)
    }
  }

  lines.push(`pinned rows: ${resolver.pinCount()}`)
  for (const [name, cache] of [
    ['defaults', resolver.defaults],
    ['labels', resolver.labels],
  ] as const) {
    const d = cache.dump()
    lines.push(`${name} cache: ${d.length ? '' : 'empty'}`)
    for (const x of d) lines.push(`  ${x.key} = ${json(x.value) ?? 'undefined'}  ttl ${Math.round(x.ttlLeftMs / 1000)}s${x.running ? ' (running)' : ''}`)
  }
  return lines.join('\n')
}
