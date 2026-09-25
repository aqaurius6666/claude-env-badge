// bun test: pure parser. Named *.spec.ts so `claude plugin test` (which runs *.test.ts[x]) skips it.
import { describe, expect, test } from 'bun:test'

import { configOf } from '../hooks/config'
import { mentionsAny, targetsOf } from '../hooks/env'

const { rules } = configOf({})

describe('targetsOf', () => {
  const cases: Array<[string, Array<{ kind: string; named: string | undefined }>]> = [
    ['aws s3 ls', [{ kind: 'aws', named: undefined }]],
    ['aws --profile prod-billing s3 ls', [{ kind: 'aws', named: 'prod-billing' }]],
    ['aws s3 ls --profile=stg-api', [{ kind: 'aws', named: 'stg-api' }]],
    ['AWS_PROFILE=prd-x aws sts get-caller-identity', [{ kind: 'aws', named: 'prd-x' }]],
    ['export AWS_PROFILE=stg-a; aws s3 ls', [{ kind: 'aws', named: 'stg-a' }]],
    ['/usr/local/bin/aws --profile "q-1" ec2 describe-instances', [{ kind: 'aws', named: 'q-1' }]],
    ['kubectl --context poc-prd-eks get pods', [{ kind: 'k8s', named: 'poc-prd-eks' }]],
    ['helm list --kube-context=stg-eks', [{ kind: 'k8s', named: 'stg-eks' }]],
    [
      'kubectl get ns && aws --profile a s3 ls | head',
      [
        { kind: 'k8s', named: undefined },
        { kind: 'aws', named: 'a' },
      ],
    ],
    // same target twice -> one badge
    ['aws --profile a s3 ls; aws --profile a s3 ls', [{ kind: 'aws', named: 'a' }]],
    ['echo aws is great', []],
    ['ls -la', []],
  ]
  for (const [cmd, want] of cases) test(cmd, () => expect(targetsOf(cmd, rules)).toEqual(want))
})

describe('mentionsAny', () => {
  test('gate passes bins anywhere', () => expect(mentionsAny('cd x && kubectl get po', rules)).toBe(true))
  test('gate rejects unrelated', () => expect(mentionsAny('git status', rules)).toBe(false))
})

// The owner's real pluginConfigs.env-badge.options: safe-aws / safe-kubectl are
// read-only wrappers taking the same flags as aws / kubectl.
describe("targetsOf with the owner's real config", () => {
  const { rules: ownerRules } = configOf({
    'aws.bins': ['aws', 'safe-aws'],
    'k8s.bins': ['kubectl', 'helm', 'k9s', 'safe-kubectl'],
  })

  const cases: Array<[string, Array<{ kind: string; named: string | undefined }>]> = [
    ['safe-aws s3 ls --profile p', [{ kind: 'aws', named: 'p' }]],
    ['safe-aws s3 ls --profile=p', [{ kind: 'aws', named: 'p' }]],
    ['AWS_PROFILE=p safe-aws s3 ls', [{ kind: 'aws', named: 'p' }]],
    ['export AWS_PROFILE=p; safe-aws s3 ls', [{ kind: 'aws', named: 'p' }]],
    ['safe-kubectl --context c get po', [{ kind: 'k8s', named: 'c' }]],
    ['safe-kubectl --kube-context c get po', [{ kind: 'k8s', named: 'c' }]],
    ['safe-kubectl --kube-context=c get po', [{ kind: 'k8s', named: 'c' }]],
    ['/Users/x/.local/bin/safe-aws s3 ls --profile p', [{ kind: 'aws', named: 'p' }]],
    // segments split on && || ; | and newlines
    ['safe-aws --profile a s3 ls && safe-kubectl --context c get po', [{ kind: 'aws', named: 'a' }, { kind: 'k8s', named: 'c' }]],
    ['safe-aws --profile a s3 ls || safe-kubectl --context c get po', [{ kind: 'aws', named: 'a' }, { kind: 'k8s', named: 'c' }]],
    ['safe-aws --profile a s3 ls ; safe-kubectl --context c get po', [{ kind: 'aws', named: 'a' }, { kind: 'k8s', named: 'c' }]],
    ['safe-aws --profile a s3 ls | cat', [{ kind: 'aws', named: 'a' }]],
    ['safe-aws --profile a s3 ls\nsafe-kubectl --context c get po', [{ kind: 'aws', named: 'a' }, { kind: 'k8s', named: 'c' }]],
    // multiple rules in one command, already covered above; one more combo
    ['safe-kubectl --context c get po && safe-aws --profile a s3 ls', [{ kind: 'k8s', named: 'c' }, { kind: 'aws', named: 'a' }]],
    // quoted values pass through unquote()
    ['safe-aws --profile "q-1" ec2 describe-instances', [{ kind: 'aws', named: 'q-1' }]],
    // negative: bin only mentioned as an argument, not as the command itself
    ['echo safe-aws', []],
    ['echo "safe-aws --profile prod s3 ls"', []],
    // negative: near-miss bin names, not an exact match
    ['safe-awsx ls', []],
    ['aws-safe s3 ls', []],
  ]
  for (const [cmd, want] of cases) test(cmd, () => expect(targetsOf(cmd, ownerRules)).toEqual(want))

  describe("README's known misses, pinned as current behavior", () => {
    // `bash -c "..."`: the naive tokenizer never looks inside the quoted script,
    // so the leading token is "bash", not a recognized bin -> no target at all.
    test('bash -c: not detected', () => {
      expect(targetsOf('bash -c "safe-aws --profile prod s3 ls"', ownerRules)).toEqual([])
    })

    // subshell `( ... )`: the leading "(" is glued to the bin token and is not
    // stripped the way a path prefix is -> no target at all.
    test('subshell: not detected', () => {
      expect(targetsOf('(safe-aws --profile prod s3 ls)', ownerRules)).toEqual([])
    })

    // heredoc body: segments() also splits on newlines with no idea of heredoc
    // boundaries, so a line inside the heredoc body that happens to start with a
    // known bin is misread as a real invocation of it.
    test('heredoc body line starting with a bin: misread as a real command', () => {
      const cmd = 'cat <<EOF\nsafe-aws --profile prod s3 ls\nEOF'
      expect(targetsOf(cmd, ownerRules)).toEqual([{ kind: 'aws', named: 'prod' }])
    })
  })
})
