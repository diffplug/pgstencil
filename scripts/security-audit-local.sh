#!/bin/bash
#
# Run the security audit locally, against the same prompt files CI uses
# (`.github/audit/`). Nothing is duplicated here: if this and
# `.github/workflows/security-audit.yml` ever disagree, it is a bug in one of
# them, not a drift in the prompts.
#
# The report lands in ./audit-report.md, which .gitignore covers.
#
# Usage:
#   scripts/security-audit-local.sh

set -euo pipefail

cd "$(dirname "$0")/.."
AUDIT_DIR=.github/audit
OUT=audit-report.md

if ! command -v claude >/dev/null 2>&1; then
  echo "error: the \`claude\` CLI is not on PATH." >&2
  exit 1
fi

for f in _preamble security; do
  [ -f "$AUDIT_DIR/$f.md" ] || { echo "error: missing $AUDIT_DIR/$f.md" >&2; exit 1; }
done

echo "==> security -> $OUT (--model opus)"
rm -f "$OUT"
# Same model and the same tool grants as CI. Local and CI must agree here, or a
# local run stops being a rehearsal of the nightly.
if ! claude -p "$(cat "$AUDIT_DIR/_preamble.md"; echo; cat "$AUDIT_DIR/security.md")" \
  --model opus \
  --allowed-tools "Read,Write,Edit,Bash,Grep,Glob" \
  --disallowed-tools "Task,Agent,Workflow"; then
  echo "==> the auditor process failed" >&2
  exit 1
fi

if [ ! -s "$OUT" ]; then
  echo "==> no $OUT was produced — in CI that is an INCONCLUSIVE audit, not a FAIL" >&2
  exit 1
fi

# Same sentinel CI reads, for the same reason: the agent appends findings as it
# determines them, so a report without its last line is one that stopped early —
# and its first line may already say PASS. Last non-blank line, not `tail -n1`:
# a trailing blank line after the sentinel still ends a finished report.
if [ "$(sed -e '/^[[:space:]]*$/d' "$OUT" | tail -n1)" != "<!-- END OF REPORT -->" ]; then
  echo "==> the audit was cut off before finishing $OUT — findings kept, its verdict line covers less than it appears to" >&2
  case "$(head -n1 "$OUT")" in 'VERDICT: FAIL'*) echo "==> the audit reports FAIL" >&2 ;; esac
  exit 1
fi

# The same grammar CI applies in .github/workflows/security-audit.yml, and for
# the same reason: a failure with an appended explanation is still a finding, so
# only the PASS arm matches exactly. Drifting from CI here would report a real
# finding as an unreadable report.
case "$(head -n1 "$OUT")" in
  'VERDICT: PASS') echo "==> wrote $OUT"; exit 0 ;;
  'VERDICT: FAIL'*) echo "==> the audit reports FAIL" >&2; exit 1 ;;
  'VERDICT: INCONCLUSIVE') echo "==> the audit could not determine every check" >&2; exit 1 ;;
  *) echo "==> the audit produced no readable verdict" >&2; exit 1 ;;
esac
