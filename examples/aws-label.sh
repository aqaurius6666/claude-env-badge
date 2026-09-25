#!/bin/sh
# env-badge label hook example.
# stdin:  {"kind":"aws","name":"<raw profile>","isDefault":false,"tierHint":"other","command":"..."}
# stdout: one line of text, or JSON {"text","tier?","color?","bold?","prefix?"}.
# Non-zero exit or empty stdout -> the badge keeps the raw name.
# Wire it up:  "aws.label": ["sh", "~/path/to/aws-label.sh"]

input=$(cat)
name=$(printf '%s' "$input" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')
role=${name#*-}

case "$name" in
  111111111111-*) echo "billing-prod · ${role%Role}" ;;
  222222222222-*) printf '{"text":"sandbox · %s","tier":"other","color":"cyan"}\n' "${role%Role}" ;;
  *) echo "$name" ;;
esac
