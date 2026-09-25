# env-badge

A Claude Code plugin that shows a small badge under each Bash tool row, naming the environment the command targets:

```
⚠ aws: prod-billing (default)
k8s: stg-cluster
```

It is a **nice-to-have for attention**: the badge makes it easy to notice that a command touches prod. It only draws the badge. It never changes tool output, the model's context, or permissions.

> **Warning: no badge does not mean safe.** The command parser is naive. It misses subshells, `bash -c`, heredocs, and commands inside script files. Never rely on the badge (or on its absence) to decide whether a command is allowed.

## How it works

1. **Match.** Each command is split into segments on `&&`, `||`, `;`, `|` and newlines. The first word of each segment is checked against the rules' `bins`.
2. **Named target.** The target is taken from a flag (`--profile x`), a `VAR=x cmd` prefix, or an earlier `export VAR=x`.
3. **Session default.** When the command names no target, the rule's `default` argv runs to find the current one, e.g. `kubectl config current-context`. The badge shows `…` while that runs, `?` if it fails, and ` (default)` once found. `…` and `?` are drawn dim with no tier, so an unknown target never looks safe.
4. **Label (optional).** A `label` script can turn a raw id into a friendlier name, e.g. an account id into an alias.
5. **Tier.** The shown name is matched against the tiers in order. The first match sets the color, bold and prefix.

Each row keeps the default it was first drawn with. So after `kubectl config use-context`, older rows still show the context they ran against.

> **Gotcha: pins live in memory only.** A resumed session draws its old rows with the *current* default, not the one they ran against.

## Built-in rules and tiers

| Rule | bins | flags | vars | default |
|---|---|---|---|---|
| `aws` | `aws` | `--profile` | `AWS_PROFILE` | `printenv AWS_PROFILE` |
| `k8s` | `kubectl`, `helm`, `k9s` | `--context`, `--kube-context` | | `kubectl config current-context` |

| Tier | match (case-insensitive) | style |
|---|---|---|
| `prod` | `prod\|prd` | red, bold, `⚠ ` prefix |
| `stg` | `stg\|stag` | yellow |
| `other` | `.*` | green |

## Configuration

Set options in `settings.json` under `pluginConfigs.env-badge.options`.

> **Gotcha: keep every value flat.** Values are strings, numbers, booleans and string lists; a nested object is ignored. That is why each rule and tier field is its own dotted key, like `"aws.bins"`.
>
> The engine hands a plugin only the keys `plugin.json` declares (`enabled`), so env-badge reads `pluginConfigs` from every settings source itself (user < project < local < flag < policy, last one wins per key). Edits apply on `/env-badge reload`.

```json
{
  "pluginConfigs": {
    "env-badge": {
      "options": {
        "rules": ["aws", "k8s", "tf"],
        "tf.bins": ["terraform", "tfccli"],
        "tf.vars": ["TF_WORKSPACE"],
        "tf.default": ["terraform", "workspace", "show"],

        "aws.label": ["~/bin/aws-alias"],

        "tiers": ["prod", "stg", "other"],
        "prod.match": "prod|prd|live",

        "format": "{prefix}{id}: {name}{default}"
      }
    }
  }
}
```

### Top-level keys

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Turn the badge off. |
| `tools` | `["Bash"]` | Tools that get a badge. |
| `rules` | `["aws", "k8s"]` | Rule ids, in order. Listing it **replaces** the built-in list, so include `aws`/`k8s` to keep them. |
| `tiers` | `["prod", "stg", "other"]` | Tier ids, checked in order. Also replaces the built-ins. |
| `format` | `{prefix}{id}: {name}{default}` | Badge text template. |
| `labelTimeoutMs` | `2000` | Timeout for `default` and `label` scripts. |
| `labelTtlMs` | `300000` | How long a label result is cached. |
| `defaultTtlMs` | `10000` | How long a session default is cached. |

Placeholders for `format`: `{prefix}`, `{id}`, `{name}`, `{raw}`, `{tier}`, `{default}`.

### Rule keys: `<id>.<field>`

| Field | Meaning |
|---|---|
| `bins` | Command names that trigger the rule. A path prefix is ignored (`/usr/bin/aws` matches `aws`). |
| `flags` | Flags that name the target, as `--flag x` or `--flag=x`. |
| `vars` | Env vars that name the target, from `VAR=x cmd` or `export VAR=x`. |
| `default` | Argv (no shell) that prints the session default. |
| `label` | Argv (no shell) for a label script. |

In `default` and `label`, any argv element starting with `~/` is expanded to `$HOME`.

### Tier keys: `<id>.<field>`

`match` (regex, case-insensitive), `color`, `bold`, `prefix`.

## Label scripts

The script gets JSON on stdin:

```json
{"kind": "aws", "name": "123456789012", "isDefault": false, "tierHint": "other", "command": "aws s3 ls --profile 123456789012"}
```

It can print plain text (the first non-empty line is used), or JSON:

```json
{"text": "billing-prod", "tier": "prod", "color": "red", "bold": true, "prefix": "⚠ "}
```

- Only `text` is required. `tier` pins a tier by id, and the other fields override that tier's style.
- Output is cleaned: first line only, ANSI and control characters removed, 60 characters max.
- Non-zero exit, timeout or empty output means the raw name is shown instead. Failures are cached too, so a broken script is not rerun on every redraw.

[`examples/aws-label.sh`](examples/aws-label.sh) maps account-id profiles to names. It has no exec bit, so run it through `sh`:

```json
"aws.label": ["sh", "~/path/to/claude-env-badge/examples/aws-label.sh"]
```

## Commands

`/env-badge doctor`, `/env-badge test`, `/env-badge reload`. `doctor` also lists option keys that no rule or tier reads, which is how a typo shows up.

## Surfaces

- **Terminal:** verified live.
- **Desktop, VS Code, mobile:** the badge tree validates in `claude plugin test`, but has not been checked live. `$.process` is CLI-only, so there `default` and `label` scripts fail, and the badge shows the raw name or `?`.

## Development

```sh
/plugin-types             # in Claude Code: writes API types to .claude/types
bun test .spec.ts         # unit specs; the filter keeps bun off register.test.tsx
claude plugin test        # hook tests in the plugin test kit
claude plugin validate    # checks the hook and API footprint
```

Live run in a terminal:

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir . --settings '{"pluginConfigs":{"env-badge":{"options":{"aws.label":["sh","'"$PWD"'/examples/aws-label.sh"]}}}}'
```

The script path is made absolute with `$PWD`, because label scripts are not guaranteed to run from the repo dir.
