// claude plugin test: the mod as the engine loads it. The engine passes only declared userConfig
// here (no aws.label), so the label-script path is covered by tests/badge.spec.ts and a live run.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

// the engine's own row, beneath the plugin: nothing answers ui.render in a test otherwise
function world(on: On, run: (argv: readonly string[]) => { exitCode: number; stdout: string } = () => ({ exitCode: 1, stdout: '' })) {
  mock.env(on, { HOME: '/home/t' })
  on('ui.render', { component: 'ToolUse' }, async ($, e) => {
    const { Text } = await $.ui.resolve(e)
    return <Text>⏺ Bash</Text>
  })
  on('process.run', ($, e) => ({ value: { ...run(e.argv), stderr: '' } }))
}

function slash(args: string) {
  return {
    command: 'env-badge',
    args,
    origin: { kind: 'composer' as const },
    presentation: { isFullscreen: false, columns: 80 },
  }
}

function row(command: string, tool = 'Bash') {
  return {
    plugin: 'env-badge',
    component: 'ToolUse' as const,
    props: {
      tool_use_id: `toolu_${command.length}_${tool}`,
      tool,
      input: { command },
      isRunning: true,
      isErrored: false,
      isInterrupted: false,
    },
  }
}

test('named prod profile: red bold badge on every surface', async ($, on) => {
  world(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...row('aws --profile poc-prod-billing s3 ls'), surface })
    const badge = await ui.find({ type: 'Text', text: /aws: poc-prod-billing/ })
    expect(badge?.text).toBe('⚠ aws: poc-prod-billing')
    expect(badge?.props).toMatchObject({ color: 'red', bold: true })
    await ui.unmount()
  }
})

test('session default resolves after the probe and redraws', async ($, on) => {
  const seen: string[] = []
  world(on, (argv) => {
    seen.push(argv.join(' '))
    const ctx = argv.join(' ') === 'kubectl config current-context'
    return { exitCode: ctx ? 0 : 1, stdout: ctx ? 'poc-stg-eks\n' : '' }
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...row('kubectl get pods -A'), surface })
    const badge = await ui.find({ type: 'Text', text: /k8s:/ })
    expect(badge?.text).toBe('k8s: poc-stg-eks (default)')
    expect(badge?.props).toMatchObject({ color: 'yellow' })
    await ui.unmount()
  }
  // cached across rows and surfaces: one probe
  expect(seen.filter((s) => s === 'kubectl config current-context')).toHaveLength(1)
})

test('unrelated rows and other tools are left alone', async ($, on) => {
  world(on)
  for (const r of [row('git status'), row('echo hi'), row('aws --profile prd s3 ls', 'Read')]) {
    const ui = await $.ui.mount({ ...r, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /(aws|k8s): / })).toBeUndefined()
    await ui.unmount()
  }
})

test('/env-badge test explains a command', async ($, on) => {
  world(on)
  const { text } = await $.command.run(slash('test AWS_PROFILE=stg-api aws s3 ls'))
  expect(text).toContain('aws: stg-api')
  expect(text).toContain('tier=stg')
  const help = await $.command.run(slash(''))
  expect(help.text).toContain('/env-badge doctor')
})

// The owner's real pluginConfigs.env-badge.options ({"aws.bins": ["aws", "safe-aws"],
// "k8s.bins": [...,"safe-kubectl"]}) cannot be exercised through this kit: the kit
// only ever hands register() the declared userConfig defaults (none here, since this
// plugin.json has no userConfig block), and there is no settings.json or `mock` noun
// that feeds `options`. `TestOptions.plugins` cannot stand in either: an inline
// plugin's `register` is re-parsed as a standalone, self-contained module (see the
// probe below) and cannot import '../hooks/register' or close over a test-file
// constant, so it cannot wrap the real module with different options.
//
// safe-aws -> aws badge and safe-kubectl -> k8s badge with the owner's real options
// are covered end-to-end at the Resolver level instead, in
// tests/badge.spec.ts ("Resolver.badges with the owner's real config").
test('kit delivers only declared userConfig: no pluginConfigs reach the primary module', async ($, on) => {
  world(on)
  const { text } = await $.command.run(slash('doctor'))
  // options received holds nothing but the universal `enabled` flag every plugin gets
  expect(text).toContain('options received: {"enabled":true}')
  // bins are still the untouched builtins: no safe-aws, no safe-kubectl
  expect(text).toContain('aws: bins=aws ')
  expect(text).toContain('k8s: bins=kubectl,helm,k9s ')
})
