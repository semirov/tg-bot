#!/usr/bin/env bash
# Fail-closed guard for the memes-bot deploy target (TGB-112; TRL-604 failure class).
#
# Why this exists: the memes bot is a long-polling grammY runner and, in the same
# process, a gramjs MTProto userbot whose session is a Postgres row. Two instances
# sharing one bot token conflict on getUpdates against live prod; a second login can
# invalidate the parser session (recovery = an interactive owner re-login).
# tools/deploy/deploy.sh used to take its host straight from
# $DEPLOY_SECRETS_DIR/target.env with no guard at all, so a stale copy of that file —
# or a copy-pasted ssh — was enough to start a second instance.
#
# Contract (every check fails closed):
#   1. exactly one DEPLOY_HOST assignment in the target file (shell `source` would
#      silently take the last one, so a duplicate is refused instead of guessed);
#   2. DEPLOY_HOST is a bare IPv4 address or hostname: no scheme, path, port, user@,
#      whitespace or shell metacharacter, and no leading `-`. deploy.sh puts the host
#      into an `ssh` argv, where `-oProxyCommand=...` is an option injection and
#      `host; cmd` is a command injection;
#   3. DEPLOY_HOST is not listed in tools/ci/retired-deploy-hosts.txt;
#   4. that deny-list exists and has at least one entry (an empty list would silently
#      allow everything, which is the failure this guard is supposed to prevent).
#
# Usage:
#   deploy-target-guard.sh                   # target read from $DEPLOY_TARGET_ENV
#   deploy-target-guard.sh <target.env>      # target read from a file (deploy.sh path)
#   deploy-target-guard.sh --host <host>     # check a bare host string
#
# Output: the accepted host and nothing else — never another field of the file.
# Exit: 0 = accepted, 1 = refused.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DENYLIST="${DEPLOY_RETIRED_HOSTS_FILE:-$SCRIPT_DIR/retired-deploy-hosts.txt}"

err() { echo "!! deploy-target-guard: $1" >&2; exit 1; }

TMP_TARGET=""
# shellcheck disable=SC2329  # invoked via `trap ... EXIT` below
cleanup() { [ -z "$TMP_TARGET" ] || rm -f "$TMP_TARGET"; return 0; }
trap cleanup EXIT

HOST_MODE=0
TARGET_FILE=""
if [ "${1:-}" = "--host" ]; then
  [ -n "${2:-}" ] || err "--host needs a host argument"
  HOST_MODE=1
  HOST="$2"
elif [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  cat <<'USAGE'
usage: deploy-target-guard.sh [<target.env> | --host <host>]
  reads DEPLOY_HOST from $DEPLOY_TARGET_ENV (default), from a target.env file, or
  from --host; exits non-zero when the target is empty, ambiguous, malformed or on
  tools/ci/retired-deploy-hosts.txt.
USAGE
  exit 0
elif [ "$#" -ge 1 ] && [ -n "${1:-}" ]; then
  [ -f "$1" ] || err "target.env not found: $1"
  TARGET_FILE="$1"
else
  # Materialize the env secret into a private temp file, then resolve it with the
  # same shell `source` semantics as deploy.sh.
  TMP_TARGET="$(mktemp "${TMPDIR:-/tmp}/deploy-target-guard.XXXXXX")"
  chmod 600 "$TMP_TARGET"
  printf '%s\n' "${DEPLOY_TARGET_ENV:-}" > "$TMP_TARGET"
  TARGET_FILE="$TMP_TARGET"
fi

if [ "$HOST_MODE" -eq 0 ]; then
  # Ambiguous target: more than one DEPLOY_HOST assignment. Shell `source` would
  # silently take the last one, so fail closed instead of guessing.
  HOST_ASSIGNMENTS="$(grep -cE '^[[:space:]]*(export[[:space:]]+)?DEPLOY_HOST[[:space:]]*=' "$TARGET_FILE" || true)"
  [ "$HOST_ASSIGNMENTS" -le 1 ] || \
    err "multiple DEPLOY_HOST assignments (${HOST_ASSIGNMENTS}) — ambiguous target (fail-closed)"

  # deploy.sh `source`s the target file, so `DEPLOY_HOST=1.2.3.4; something` runs that
  # `something` while still resolving to a perfectly valid host — the value check below
  # cannot see it. Refuse the line itself.
  BAD_LINES="$(grep -nE '^[[:space:]]*(export[[:space:]]+)?DEPLOY_HOST[[:space:]]*=' "$TARGET_FILE" \
    | sed 's/#.*$//' | grep -cE '[;|&`]|\$\(' || true)"
  [ "${BAD_LINES:-0}" -eq 0 ] || \
    err "DEPLOY_HOST line carries a shell command separator or substitution (${BAD_LINES} line(s)) — refused (fail-closed)"

  # Resolve with real shell semantics (quotes, inline `#comment`, trailing whitespace,
  # `export`). Sourcing happens in a subshell: no effect on this shell.
  # shellcheck disable=SC1090,SC1091  # runtime path (secret temp file or argv)
  HOST="$( set -a; . "$TARGET_FILE" >/dev/null 2>&1; printf '%s' "${DEPLOY_HOST-}" )"
fi

[ -n "${HOST:-}" ] || err "DEPLOY_HOST is empty or unset — deploy target unknown (fail-closed)"

# --- 2. the host must be a bare address: safe to interpolate into an ssh argv ----
case "$HOST" in
  *[!A-Za-z0-9.-]*)
    err "DEPLOY_HOST contains characters that are not valid in a host name (${#HOST} chars) — refused" ;;
esac
case "$HOST" in
  [A-Za-z0-9]*) ;;
  *) err "DEPLOY_HOST must start with a letter or digit (a leading '-' would be read as an ssh option) — refused" ;;
esac
case "$HOST" in
  *..* | .* | *.) err "DEPLOY_HOST is not a well-formed host name — refused" ;;
esac

# --- 3./4. retired-host deny-list ------------------------------------------------
[ -f "$DENYLIST" ] || err "retired-host deny-list not found: $DENYLIST"

DENY_ENTRIES=0
HOST_LC="$(printf '%s' "$HOST" | tr '[:upper:]' '[:lower:]')"
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%#*}"
  line="$(printf '%s' "$line" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
  [ -n "$line" ] || continue
  DENY_ENTRIES=$((DENY_ENTRIES + 1))
  if [ "$line" = "$HOST_LC" ]; then
    err "host ${HOST} is on the retired-host deny-list (TGB-112) — deploy stopped"
  fi
done < "$DENYLIST"
[ "$DENY_ENTRIES" -gt 0 ] || err "retired-host deny-list has no entries — refusing (fail-closed)"

echo "==> deploy-target-guard: target ${HOST} accepted"
exit 0
