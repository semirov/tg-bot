#!/usr/bin/env bash
# Failure alert for the scheduled backup and the restore drill (TGB-113).
#
# A scheduled job that fails quietly is worse than no job: the only signal would be a
# red run nobody watches. This opens a GitHub issue (or comments on the one already
# open) with the link to the failed run. It uses the workflow's own github.token with
# issues:write — no new secret, no external channel.
#
# Idempotent: while an open issue with $BACKUP_ALERT_TITLE exists, a comment is added
# instead of a second issue, so a run of failures does not spam the tracker.
#
# Usage: notify-failure.sh <run-url> [repo]
# Env: GH_TOKEN (required), GITHUB_REPOSITORY, BACKUP_ALERT_TITLE/LABEL/KIND/OUTCOME/HINT.
#
# Test: tools/backup/notify-failure.test.sh.
set -euo pipefail

RUN_URL="${1:?usage: notify-failure.sh <run-url> [repo]}"
REPO="${2:-${GITHUB_REPOSITORY:-}}"
TITLE="${BACKUP_ALERT_TITLE:-[auto] Scheduled DB backup failed}"
LABEL="${BACKUP_ALERT_LABEL:-bug}"
KIND="${BACKUP_ALERT_KIND:-The scheduled **DB backup**}"
OUTCOME="${BACKUP_ALERT_OUTCOME:-no off-site artifact was created}"
HINT="${BACKUP_ALERT_HINT:-\`/opt/memes-bot/backups/*.sql.gz.age\` on the production host, CI↔host connectivity, the 'Dump database from the host' step (\`tools/backup/db-backup.sh\`)}"

fail() { echo "!! $1" >&2; exit 1; }

[ -n "$REPO" ] || fail "no repository (argument or GITHUB_REPOSITORY)"
command -v gh >/dev/null 2>&1 || fail "gh is not in PATH — alert not sent"
[ -n "${GH_TOKEN:-}" ] || fail "GH_TOKEN is not set — alert not sent (needs issues:write)"

BODY="$(
  cat <<EOF
${KIND} ended in failure — ${OUTCOME}.

- failed run: ${RUN_URL}
- UTC: $(date -u +%Y-%m-%dT%H:%M:%SZ)

What to check: ${HINT}.
Close the issue by hand once the cause is understood.
EOF
)"

# Dedup by title. A failed lookup or a non-numeric answer means "create a new issue":
# a duplicate is better than silence.
# gh has no --arg, so the title is escaped into the jq program as a string literal: a
# quote in it would otherwise break the lookup and silently degrade to "create a new
# issue" (TGB-113 review §M11). No jq binary is required — gh embeds its own.
JQ_TITLE="$(printf '%s' "$TITLE" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
existing="$(
  gh issue list --repo "$REPO" --state open --limit 100 \
    --json number,title \
    --jq "[.[] | select(.title == \"${JQ_TITLE}\")] | .[0].number // empty" 2>/dev/null || true
)"
case "$existing" in
  ''|*[!0-9]*) existing="";;
esac

if [ -n "$existing" ]; then
  gh issue comment "$existing" --repo "$REPO" --body "$BODY"
  echo "==> alert: comment on the open issue #${existing}"
  exit 0
fi

if gh issue create --repo "$REPO" --title "$TITLE" --body "$BODY" --label "$LABEL" 2>/dev/null; then
  echo "==> alert: opened an issue titled '${TITLE}' (label: ${LABEL})"
else
  gh issue create --repo "$REPO" --title "$TITLE" --body "$BODY"
  echo "==> alert: opened an issue titled '${TITLE}' (no label)"
fi
