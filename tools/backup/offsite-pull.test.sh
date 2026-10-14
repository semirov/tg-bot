#!/usr/bin/env bash
# Tests for tools/backup/offsite-pull.sh (TGB-113) with no production host.
#
# `ssh` is a PATH shim answering the four calls the script makes (list the newest
# archive, its size, its sha256, its bytes). What is checked: the newest archive lands
# in the off-site directory with ciphertext verified before it is promoted, the run is
# idempotent, a stale or non-ciphertext source is refused, and rotation keeps the last
# OFFSITE_KEEP of our naming while never touching the hand-made memes-final-* copies.
#
# Run: bash tools/backup/offsite-pull.test.sh
# bash 3.2 (macOS) compatible. Prints PASS/FAIL; exits 1 on failure.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PULL="$SCRIPT_DIR/offsite-pull.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/memes-offsite-pull-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1 — $2"; FAIL=$((FAIL + 1)); }

# count_matching <dir> <glob> — how many entries match (0 when there are none)
count_matching() {
  local n=0 f
  for f in "$1"/$2; do
    [ -e "$f" ] || continue
    n=$((n + 1))
  done
  printf '%s' "$n"
}

BIN="$WORK/bin"
mkdir -p "$BIN"

cat > "$BIN/ssh" <<'SHIM'
#!/usr/bin/env bash
echo "ssh" >> "${STUB_LOG:?}"
args=()
for a in "$@"; do args+=("$a"); done
i=0; target=""; cmd=""
while [ "$i" -lt "${#args[@]}" ]; do
  a="${args[$i]}"
  case "$a" in
    -i|-o|-p|-E|-F|-J|-b|-c|-D|-e|-L|-l|-m|-Q|-R|-S|-W|-w) i=$((i + 2)); continue;;
    -*) i=$((i + 1)); continue;;
  esac
  if [ -z "$target" ]; then target="$a"; else cmd="${cmd:+$cmd }$a"; fi
  i=$((i + 1))
done
case "$cmd" in
  *"ls -1t"*) printf '%s\n' "${STUB_NEWEST:-}"; exit 0;;
  *"wc -c"*)  printf '%s\n' "${STUB_BYTES:-0}"; exit 0;;
  *sha256sum*) printf '%s\n' "${STUB_SHA:-}"; exit 0;;
  cat\ *)
    case "${STUB_BODY:-age}" in
      age) { printf 'age-encryption.org/v1\n'; printf 'body\n'; } ;;
      plain) printf 'a plain dump\n' ;;
      empty) : ;;
    esac
    exit 0;;
esac
exit 0
SHIM
chmod +x "$BIN/ssh"

KEY="$WORK/id_ed25519"
printf 'SSH-KEY-PLACEHOLDER\n' > "$KEY"
chmod 600 "$KEY"

BODY="$WORK/body.age"
{ printf 'age-encryption.org/v1\n'; printf 'body\n'; } > "$BODY"
BODY_BYTES="$(wc -c < "$BODY" | tr -d ' ')"
if command -v sha256sum >/dev/null 2>&1; then
  BODY_SHA="$(sha256sum "$BODY" | cut -d' ' -f1)"
else
  BODY_SHA="$(shasum -a 256 "$BODY" | cut -d' ' -f1)"
fi

DEST="$WORK/offsite"
NEWEST="memes-bot-db-$(date -u +%Y%m%dT%H%M%SZ).sql.gz.age"

fresh_offsite() {
  rm -rf "$DEST"
  mkdir -p "$DEST"
  printf 'x' > "$DEST/memes-final-20261014T164114Z.sql.gz.age"
  printf 'x' > "$DEST/memes-bot-db-20260101T000000Z.sql.gz.age"
  printf 'x' > "$DEST/memes-bot-db-20260102T000000Z.sql.gz.age"
  printf 'x' > "$DEST/memes-bot-db-20260103T000000Z.sql.gz.age"
  # Rotation picks the newest by mtime (`ls -1t`), and files created within the same
  # second tie — which made "which two are dropped" depend on the filesystem: the
  # assertion passed on APFS and failed on overlayfs. Explicit ascending timestamps make
  # the test assert a decision instead of a coincidence.
  touch -t 202601010000 "$DEST/memes-bot-db-20260101T000000Z.sql.gz.age"
  touch -t 202601020000 "$DEST/memes-bot-db-20260102T000000Z.sql.gz.age"
  touch -t 202601030000 "$DEST/memes-bot-db-20260103T000000Z.sql.gz.age"
  : > "$WORK/ssh.log"
}

run_pull() {
  STUB_LOG="$WORK/ssh.log" STUB_NEWEST="${STUB_NEWEST-/opt/memes-bot/backups/$NEWEST}" \
  STUB_BYTES="${STUB_BYTES-$BODY_BYTES}" STUB_SHA="${STUB_SHA-$BODY_SHA}" \
  STUB_BODY="${STUB_BODY:-age}" \
  VPS_SSH_KEY="$KEY" VPS_TARGET=root@192.0.2.10 OFFSITE_DIR="$DEST" OFFSITE_KEEP="${OFFSITE_KEEP:-2}" \
  OFFSITE_MAX_AGE_HOURS="${OFFSITE_MAX_AGE_HOURS:-48}" OFFSITE_DRY_RUN="${OFFSITE_DRY_RUN:-0}" \
  PATH="$BIN:/usr/bin:/bin" \
    bash "$PULL" > "$WORK/out.log" 2> "$WORK/err.log"
  return $?
}

# ---------------------------------------------------------- happy path --------
fresh_offsite
rc=0; run_pull || rc=$?
if [ "$rc" -eq 0 ]; then pass "a pull from the source succeeds"; else fail "happy path" "rc=$rc: $(cat "$WORK/err.log")"; fi
if [ -s "$DEST/$NEWEST" ]; then pass "the newest archive lands in the off-site dir"; else fail "artifact" "$(ls -1 "$DEST" | tr '\n' ' ')"; fi
if head -c 64 "$DEST/$NEWEST" 2>/dev/null | grep -q 'age-encryption.org/v1'; then
  pass "the stored copy is age ciphertext"
else
  fail "ciphertext" "no age magic in the stored file"
fi
if [ "$(ls -l "$DEST/$NEWEST" | cut -c1-10)" = "-rw-------" ]; then
  pass "the off-site copy is mode 0600"
else
  fail "mode" "$(ls -l "$DEST/$NEWEST" | cut -c1-10)"
fi
if grep -q "$NEWEST" "$DEST/SHA256SUMS.memes-bot"; then
  pass "the SHA256SUMS manifest is refreshed"
else
  fail "manifest" "$(cat "$DEST/SHA256SUMS.memes-bot" 2>/dev/null)"
fi
if [ -s "$DEST/.last-success" ] && grep -q "artifact=$NEWEST" "$DEST/.last-success"; then
  pass "a heartbeat records the last successful pull"
else
  fail "heartbeat" "$(cat "$DEST/.last-success" 2>/dev/null || echo missing)"
fi
if grep -q "$NEWEST" "$DEST/SHA256SUMS.memes-bot" \
   && ! grep -q 'memes-bot-db-20260101T000000Z' "$DEST/SHA256SUMS.memes-bot"; then
  pass "the manifest lists only what rotation kept"
else
  fail "manifest accuracy" "$(cut -c1-20,67- "$DEST/SHA256SUMS.memes-bot" | tr '\n' ' ')"
fi
KEPT="$(count_matching "$DEST" 'memes-bot-db-*.sql.gz.age')"
if [ "$KEPT" = "2" ]; then pass "rotation keeps OFFSITE_KEEP archives (2)"; else fail "rotation" "kept=${KEPT}"; fi
if [ -f "$DEST/memes-final-20261014T164114Z.sql.gz.age" ]; then
  pass "rotation never touches the hand-made memes-final-* copies"
else
  fail "rotation" "the one-off copy was removed"
fi
if [ "$(count_matching "$DEST" '*.part')" = "0" ]; then
  pass "no partial file is left behind"
else
  fail "partials" "$(ls -1 "$DEST")"
fi

# -------------------------------------------------------- idempotent ---------
CALLS_BEFORE="$(grep -c '^ssh' "$WORK/ssh.log" || true)"
rc=0; run_pull || rc=$?
CALLS_AFTER="$(grep -c '^ssh' "$WORK/ssh.log" || true)"
if [ "$rc" -eq 0 ] && grep -q 'up to date' "$WORK/out.log"; then
  pass "a second run is a no-op (already up to date)"
else
  fail "idempotency" "rc=$rc: $(cat "$WORK/out.log")"
fi
if [ "$((CALLS_AFTER - CALLS_BEFORE))" -le 3 ]; then
  pass "the no-op run does not re-download the payload"
else
  fail "idempotency" "the payload was fetched again ($((CALLS_AFTER - CALLS_BEFORE)) calls)"
fi

# ------------------------------------------------- nothing on the source -----
fresh_offsite
rc=0; STUB_NEWEST='' run_pull || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'the dump job is not producing' "$WORK/err.log"; then
  pass "an empty source fails the run"
else
  fail "empty source" "rc=$rc: $(cat "$WORK/err.log")"
fi

# ------------------------------------------------------- a stale artifact ----
fresh_offsite
rc=0; STUB_NEWEST='/opt/memes-bot/backups/memes-bot-db-20200101T000000Z.sql.gz.age' run_pull || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'old' "$WORK/err.log"; then
  pass "a stale source artifact fails the run"
else
  fail "staleness" "rc=$rc: $(cat "$WORK/err.log")"
fi

# ------------------------------------------------ non-ciphertext download ----
fresh_offsite
rc=0; STUB_BODY=plain run_pull || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'not age ciphertext' "$WORK/err.log"; then
  pass "a non-ciphertext download is refused"
else
  fail "ciphertext guard" "rc=$rc: $(cat "$WORK/err.log")"
fi
if [ ! -f "$DEST/$NEWEST" ]; then
  pass "nothing is stored when the download is not ciphertext"
else
  fail "promotion" "the file was stored anyway"
fi

# ------------------------------------------------- an empty download body ----
fresh_offsite
rc=0; STUB_BODY=empty run_pull || rc=$?
if [ "$rc" -ne 0 ]; then pass "an empty download fails the run"; else fail "empty body" "rc=0"; fi

# ------------------------------------------------------ a foreign name -------
fresh_offsite
rc=0; STUB_NEWEST='/opt/memes-bot/backups/something-else.sql.gz.age' run_pull || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'unexpected artifact name' "$WORK/err.log"; then
  pass "a name outside the contract is refused"
else
  fail "name contract" "rc=$rc: $(cat "$WORK/err.log")"
fi

# -------------------------------------------------------------- dry run ------
fresh_offsite
rc=0; OFFSITE_DRY_RUN=1 run_pull || rc=$?
if [ "$rc" -eq 0 ] && [ ! -f "$DEST/$NEWEST" ] && grep -q 'would pull' "$WORK/out.log"; then
  pass "a dry run reports without changing anything"
else
  fail "dry run" "rc=$rc: $(cat "$WORK/out.log")"
fi

# --------------------------------------------------- missing key is fatal ----
fresh_offsite
rc=0
STUB_LOG="$WORK/ssh.log" VPS_SSH_KEY="$WORK/no-such-key" OFFSITE_DIR="$DEST" PATH="$BIN:/usr/bin:/bin" \
  bash "$PULL" > "$WORK/out.log" 2> "$WORK/err.log" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'key file not found' "$WORK/err.log"; then
  pass "a missing key stops the run"
else
  fail "missing key" "rc=$rc: $(cat "$WORK/err.log")"
fi

echo
echo "Result: PASS=${PASS} FAIL=${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
