#!/usr/bin/env bash
# Tests for tools/backup/notify-failure.sh (TGB-113) with no GitHub.
#
# `gh` is a PATH shim. What is checked: a failed scheduled run opens an issue that
# names the run, an already-open issue gets a comment instead of a duplicate (a run of
# failures must not spam the tracker), a missing token or a missing gh fails loudly —
# the alert must never look sent when it was not.
#
# Run: bash tools/backup/notify-failure.test.sh
# bash 3.2 (macOS) compatible. Prints PASS/FAIL; exits 1 on failure.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NOTIFY="$SCRIPT_DIR/notify-failure.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/memes-notify-failure-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1 — $2"; FAIL=$((FAIL + 1)); }

BIN="$WORK/bin"
mkdir -p "$BIN"

cat > "$BIN/gh" <<'SHIM'
#!/usr/bin/env bash
echo "gh $*" >> "${STUB_LOG:?}"
case "${1:-}" in
  issue)
    case "${2:-}" in
      list) printf '%s\n' "${STUB_EXISTING:-}"; exit 0;;
      create)
        if [ "${STUB_NO_LABEL:-0}" = "1" ]; then
          case "$*" in *--label*) exit 1;; esac
        fi
        printf 'https://github.com/semirov/tg-bot/issues/1\n'; exit 0;;
      comment) printf 'https://github.com/semirov/tg-bot/issues/%s\n' "${3:-}"; exit 0;;
    esac;;
esac
exit 0
SHIM
chmod +x "$BIN/gh"

RUN_URL='https://github.com/semirov/tg-bot/actions/runs/12345'

run_notify() {
  GH_TOKEN="${GH_TOKEN-gh-token-placeholder}" GITHUB_REPOSITORY=semirov/tg-bot \
  STUB_LOG="$WORK/gh.log" STUB_EXISTING="${STUB_EXISTING:-}" STUB_NO_LABEL="${STUB_NO_LABEL:-0}" \
  PATH="$BIN:/usr/bin:/bin" \
    bash "$NOTIFY" "$RUN_URL" > "$WORK/out.log" 2> "$WORK/err.log"
  return $?
}

# ------------------------------------------------- creates a new issue --------
: > "$WORK/gh.log"
rc=0; run_notify || rc=$?
if [ "$rc" -eq 0 ]; then pass "the alert path exits 0"; else fail "notify" "rc=$rc: $(cat "$WORK/err.log")"; fi
if grep -q 'issue create' "$WORK/gh.log"; then pass "no open issue → one is created"; else fail "create" "$(cat "$WORK/gh.log")"; fi
if grep -q -- "--label bug" "$WORK/gh.log"; then pass "the alert carries the label"; else fail "label" "$(cat "$WORK/gh.log")"; fi
if grep -q "$RUN_URL" "$WORK/gh.log"; then pass "the body links the failed run"; else fail "run link" "missing"; fi

# -------------------------------------------------- comments on the open one ---
: > "$WORK/gh.log"
rc=0; STUB_EXISTING=42 run_notify || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'issue comment 42' "$WORK/gh.log" && ! grep -q 'issue create' "$WORK/gh.log"; then
  pass "an open issue gets a comment, not a second issue"
else
  fail "dedup" "$(cat "$WORK/gh.log")"
fi

# --------------------------------------------- garbage from the lookup ---------
: > "$WORK/gh.log"
rc=0; STUB_EXISTING='not-a-number' run_notify || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'issue create' "$WORK/gh.log"; then
  pass "an unusable lookup answer still produces a new issue"
else
  fail "lookup fallback" "$(cat "$WORK/gh.log")"
fi

# ------------------------------------------------ a missing label is survived --
: > "$WORK/gh.log"
rc=0; STUB_NO_LABEL=1 run_notify || rc=$?
if [ "$rc" -eq 0 ] && [ "$(grep -c 'issue create' "$WORK/gh.log")" = "2" ]; then
  pass "a repository without the label still gets the issue"
else
  fail "label fallback" "$(cat "$WORK/gh.log")"
fi

# ------------------------------------------------------ missing token ---------
: > "$WORK/gh.log"
rc=0; GH_TOKEN='' run_notify || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'GH_TOKEN is not set' "$WORK/err.log"; then
  pass "a missing token fails the alert loudly"
else
  fail "token" "rc=$rc: $(cat "$WORK/err.log")"
fi
if [ "$(wc -l < "$WORK/gh.log" | tr -d ' ')" = "0" ]; then
  pass "nothing is attempted without a token"
else
  fail "token" "gh was called anyway"
fi

# --------------------------------------------------------- gh missing ---------
rc=0
GH_TOKEN=placeholder GITHUB_REPOSITORY=semirov/tg-bot STUB_LOG="$WORK/gh.log" PATH="/usr/bin:/bin" \
  bash "$NOTIFY" "$RUN_URL" > "$WORK/out.log" 2> "$WORK/err.log" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'gh is not in PATH' "$WORK/err.log"; then
  pass "a missing gh fails the alert loudly"
else
  fail "gh missing" "rc=$rc: $(cat "$WORK/err.log")"
fi

# --------------------------------------------------- usage is enforced --------
rc=0; PATH="$BIN:/usr/bin:/bin" GH_TOKEN=placeholder bash "$NOTIFY" > "$WORK/out.log" 2> "$WORK/err.log" || rc=$?
if [ "$rc" -ne 0 ]; then pass "no run url → non-zero"; else fail "usage" "rc=0"; fi

echo
echo "Result: PASS=${PASS} FAIL=${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
