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

describe('targetsOf: flag forms and segment splits', () => {
  const cases: Array<[string, Array<{ kind: string; named: string | undefined }>]> = [
    ['kubectl --kube-context c get po', [{ kind: 'k8s', named: 'c' }]],
    ['aws --profile a s3 ls || kubectl --context c get po', [{ kind: 'aws', named: 'a' }, { kind: 'k8s', named: 'c' }]],
    ['aws --profile a s3 ls\nkubectl --context c get po', [{ kind: 'aws', named: 'a' }, { kind: 'k8s', named: 'c' }]],
    ['echo "aws --profile prod s3 ls"', []],
    ['awsx ls', []],
    ['aws-cli s3 ls', []],
  ]
  for (const [cmd, want] of cases) test(JSON.stringify(cmd), () => expect(targetsOf(cmd, rules)).toEqual(want))
})

// Naive parser: pin the README's known misses so a change in behavior is noticed.
describe("targetsOf: README's known misses", () => {
  test('bash -c: not detected', () => expect(targetsOf('bash -c "aws --profile prod s3 ls"', rules)).toEqual([]))
  test('subshell: not detected', () => expect(targetsOf('(aws --profile prod s3 ls)', rules)).toEqual([]))
  // newline split ignores heredoc bounds, so a body line starting with a bin counts as a call
  test('heredoc body line: misread as a command', () =>
    expect(targetsOf('cat <<EOF\naws --profile prod s3 ls\nEOF', rules)).toEqual([{ kind: 'aws', named: 'prod' }]))
})

// wrapper names are placeholders: bins are only matched as text, never executed
describe('targetsOf: extra bins inherit the rule', () => {
  const { rules: wrapped } = configOf({ 'aws.bins': ['aws', 'aws-ro'], 'k8s.bins': ['kubectl', 'kubectl-ro'] })
  const cases: Array<[string, Array<{ kind: string; named: string | undefined }>]> = [
    ['aws-ro s3 ls --profile=p', [{ kind: 'aws', named: 'p' }]],
    ['AWS_PROFILE=p aws-ro s3 ls', [{ kind: 'aws', named: 'p' }]],
    ['/home/x/.local/bin/aws-ro s3 ls', [{ kind: 'aws', named: undefined }]],
    ['kubectl-ro --context c get po', [{ kind: 'k8s', named: 'c' }]],
    ['aws-rox ls', []],
  ]
  for (const [cmd, want] of cases) test(cmd, () => expect(targetsOf(cmd, wrapped)).toEqual(want))
})
