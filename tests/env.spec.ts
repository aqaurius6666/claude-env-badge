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
