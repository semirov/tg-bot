#!/usr/bin/env bash
# Tests for tools/backup/db-backup.sh (TGB-113) with no host and no network.
#
# `ssh` is a PATH shim that answers the phases separately (snapshot, source size, source
# sha256, download), and the repo is a copy inside a temp dir. What is checked: the happy
# path publishes ciphertext that matches the SOURCE, and every way of lying about that
# fails closed — plaintext, a payload without the age magic, a **head-intact
# truncation** (the download cut short while the source still reports the full size;
# TGB-113 review §1 — the age magic lives at the start of the file, so this is the case
# the original suite could not see), a same-size sha256 mismatch, an unreadable source
# size, a dropped channel, a refused or unexpected target. A refused target must never
# reach a host at all.
#
# Run: bash tools/backup/db-backup.test.sh
# bash 3.2 (macOS) compatible. Prints PASS/FAIL; exits 1 on failure.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/memes-db-backup-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1 — $2"; FAIL=$((FAIL + 1)); }

shasum_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# count_matching <dir> <glob> — how many entries match (0 when there are none)
count_matching() {
  local n=0 f
  for f in "$1"/$2; do
    [ -e "$f" ] || continue
    n=$((n + 1))
  done
  printf '%s' "$n"
}

# --- a throwaway repo (the script runs tools/ci/deploy-target-guard.sh itself) ----
ROOT="$WORK/repo"
mkdir -p "$ROOT"
cp -R "$REPO_ROOT/tools" "$ROOT/tools"

BIN="$WORK/bin"
SECRETS="$WORK/secrets"
PAYLOADS="$WORK/payloads"
mkdir -p "$BIN" "$SECRETS" "$PAYLOADS"
printf 'DASH-PRIVATE-KEY-PLACEHOLDER\n' > "$SECRETS/id_ed25519"
chmod 600 "$SECRETS/id_ed25519"

# --- payloads ----------------------------------------------------------------
AGE_OK="$PAYLOADS/age.ok"
{ printf 'age-encryption.org/v1\n'; printf 'fake ciphertext body\n'; } > "$AGE_OK"
GZIP_BIN="$PAYLOADS/gzip.bin"
printf '\037\213\010\000\000\000\000\000\000\003\053\111\055\056\341\002\000' > "$GZIP_BIN"
GARBAGE="$PAYLOADS/garbage.txt"
printf 'partial download, no age magic\n' > "$GARBAGE"
# A head-intact truncation: the same age header, 60 % of the bytes.
AGE_TRUNCATED="$PAYLOADS/age.truncated"
head -c "$(( $(wc -c < "$AGE_OK") * 6 / 10 ))" "$AGE_OK" > "$AGE_TRUNCATED"

cat > "$BIN/ssh" <<'SHIM'
#!/usr/bin/env bash
# Stub ssh. Remote commands db-backup.sh issues:
#   DEPLOY_DIR=… bash -s         → snapshot (answers with the archive path)
#   wc -c < <path>               → byte count of the source file
#   sha256sum <path> | cut …     → sha256 of the source file
#   cat <path>                   → the download itself
# The size/sha answers describe $STUB_SOURCE_FILE (the truth on the host), while `cat`
# emits $STUB_PAYLOAD (what actually arrived) — that is how a truncation is simulated:
# payload = a prefix of the source, source still reports the full size.
echo "ssh $*" >> "${STUB_LOG:?}"
target=""; cmd=""
args=()
for a in "$@"; do args+=("$a"); done
i=0
while [ "$i" -lt "${#args[@]}" ]; do
  a="${args[$i]}"
  case "$a" in
    -i|-o|-p|-E|-F|-J|-b|-c|-D|-e|-L|-l|-m|-Q|-R|-S|-W|-w) i=$((i + 2)); continue;;
    -*) i=$((i + 1)); continue;;
  esac
  if [ -z "$target" ]; then target="$a"; else cmd="${cmd:+$cmd }$a"; fi
  i=$((i + 1))
done
cat >/dev/null || true   # swallow the script fed on stdin

src="${STUB_SOURCE_FILE:-$STUB_PAYLOAD}"

case "$cmd" in
  *"wc -c"*)
    [ "${STUB_SIZE_UNREADABLE:-0}" != "1" ] || exit 0
    printf '%s\n' "$(wc -c < "$src" | tr -d ' ')"
    exit 0;;
  *sha256sum*)
    [ "${STUB_SHA_UNREADABLE:-0}" != "1" ] || exit 0
    if [ -n "${STUB_SHA_OVERRIDE:-}" ]; then printf '%s\n' "$STUB_SHA_OVERRIDE"
    elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$src" | cut -d' ' -f1
    else shasum -a 256 "$src" | cut -d' ' -f1; fi
    exit 0;;
  cat\ *)
    case "${STUB_MODE:-happy}" in
      network) echo "Connection reset by peer" >&2; exit 255;;
      *) cat "$STUB_PAYLOAD"; exit 0;;
    esac;;
  *)
    [ "${STUB_MODE:-happy}" != "snapshot_fail" ] || { echo "ssh: connection timed out" >&2; exit 255; }
    if [ "${STUB_MODE:-happy}" = "weird_name" ]; then
      printf '/tmp/somewhere-else.sql.gz.age\n'
    else
      printf '/opt/memes-bot/backups/memes-bot-db-20261014T150156Z.sql.gz.age\n'
    fi
    exit 0;;
esac
SHIM
chmod +x "$BIN/ssh"

# --- fixtures the script reads ------------------------------------------------
EXPECTED="$WORK/expected-hosts.txt"
printf '# test fixtures\n192.0.2.10\n' > "$EXPECTED"

write_target() { # write_target <host>
  cat > "$SECRETS/target.env" <<EOF
DEPLOY_HOST=$1
DEPLOY_USER=root
DEPLOY_IMAGE=cr.example/telegram-bot
DEPLOY_SERVICE=telegram-bot
DEPLOY_PROJECT=memes-bot
DEPLOY_STACK_DIR=/opt/memes-bot
DEPLOY_COMPOSE_FILE=/opt/memes-bot/docker-compose.yml
DEPLOY_ENV_FILE=/opt/memes-bot/.env
DEPLOY_INFRA_ENV_FILE=/opt/memes-bot/infra.env
DEPLOY_SSH_KEY=$SECRETS/id_ed25519
EOF
  chmod 600 "$SECRETS/target.env"
}

run_backup() { # run_backup <outdir>
  STUB_LOG="$WORK/ssh.log" STUB_MODE="${STUB_MODE:-happy}" \
  STUB_PAYLOAD="${STUB_PAYLOAD:-$AGE_OK}" STUB_SOURCE_FILE="${STUB_SOURCE_FILE:-}" \
  STUB_SHA_OVERRIDE="${STUB_SHA_OVERRIDE:-}" \
  STUB_SIZE_UNREADABLE="${STUB_SIZE_UNREADABLE:-0}" STUB_SHA_UNREADABLE="${STUB_SHA_UNREADABLE:-0}" \
  DEPLOY_SECRETS_DIR="$SECRETS" PATH="$BIN:/usr/bin:/bin" \
  BACKUP_EXPECTED_HOSTS_FILE="${BACKUP_EXPECTED_HOSTS_FILE:-$EXPECTED}" \
  BACKUP_NET_RETRIES="${BACKUP_NET_RETRIES:-1}" BACKUP_NET_BACKOFF=0 \
    bash "$ROOT/tools/backup/db-backup.sh" "$1" > "$WORK/out.log" 2> "$WORK/err.log"
  return $?
}

# ---------------------------------------------------------- happy path --------
write_target 192.0.2.10
: > "$WORK/ssh.log"
OUTD="$WORK/out-happy"
rc=0; run_backup "$OUTD" || rc=$?
if [ "$rc" -eq 0 ]; then pass "happy path exits 0"; else fail "happy path" "rc=$rc: $(cat "$WORK/err.log")"; fi
ART="$OUTD/memes-bot-db-20261014T150156Z.sql.gz.age"
if [ -s "$ART" ]; then pass "the artifact lands in the output dir"; else fail "artifact missing" "$(ls -1 "$OUTD" 2>/dev/null | tr '\n' ' ')"; fi
if head -c 64 "$ART" 2>/dev/null | grep -q 'age-encryption.org/v1'; then
  pass "the artifact is age ciphertext"
else
  fail "artifact format" "no age magic"
fi
if [ "$(shasum_of "$ART")" = "$(shasum_of "$AGE_OK")" ]; then
  pass "the published artifact is byte-identical to the source"
else
  fail "byte identity" "the local copy differs from the source payload"
fi
if [ "$(count_matching "$OUTD" '*')" = "$(count_matching "$OUTD" '*.age')" ]; then
  pass "no partial or plaintext file is left behind"
else
  fail "leftovers" "$(ls -1 "$OUTD" | tr '\n' ' ')"
fi
if [ "$(tail -1 "$WORK/out.log")" = "$ART" ]; then
  pass "the script prints the artifact path as its last line"
else
  fail "stdout contract" "last line: $(tail -1 "$WORK/out.log")"
fi
if [ "$(grep -c 'bash -s' "$WORK/ssh.log")" = "1" ] && [ "$(grep -c 'cat /opt' "$WORK/ssh.log")" = "1" ]; then
  pass "both phases ran once: snapshot and download"
else
  fail "ssh phases" "snapshot=$(grep -c 'bash -s' "$WORK/ssh.log") download=$(grep -c 'cat /opt' "$WORK/ssh.log")"
fi
if [ "$(grep -c 'wc -c' "$WORK/ssh.log")" -ge 2 ] && [ "$(grep -c 'sha256sum' "$WORK/ssh.log")" -ge 2 ]; then
  pass "the source size and sha256 are read (before the download and again before publishing)"
else
  fail "source comparison" "size reads=$(grep -c 'wc -c' "$WORK/ssh.log") sha reads=$(grep -c 'sha256sum' "$WORK/ssh.log")"
fi
if [ "$(grep -c 'expected host: 192.0.2.10 accepted' "$WORK/out.log")" = "1" ]; then
  pass "an expected host passes the positive pin"
else
  fail "host pin" "$(head -2 "$WORK/out.log")"
fi

# --------------------------------------------- a plaintext download --------
write_target 192.0.2.10
: > "$WORK/ssh.log"
OUTD="$WORK/out-plain"
rc=0; STUB_PAYLOAD="$GZIP_BIN" run_backup "$OUTD" || rc=$?
if [ "$rc" -ne 0 ]; then pass "a plaintext (gzip) download fails the run"; else fail "plaintext" "rc=0"; fi
if grep -q 'PLAINTEXT' "$WORK/err.log"; then pass "the failure names the plaintext"; else fail "plaintext message" "$(cat "$WORK/err.log")"; fi
if [ "$(count_matching "$OUTD" '*')" = "0" ]; then
  pass "nothing is published when the download is plaintext (fail-closed)"
else
  fail "plaintext sweep" "$(ls -1 "$OUTD" | tr '\n' ' ')"
fi

# ------------------------------------------- a truncated / bad download -----
write_target 192.0.2.10
: > "$WORK/ssh.log"
OUTD="$WORK/out-garbage"
rc=0; STUB_PAYLOAD="$GARBAGE" run_backup "$OUTD" || rc=$?
if [ "$rc" -ne 0 ]; then pass "a download without the age magic fails the run"; else fail "garbage" "rc=0"; fi
if [ "$(count_matching "$OUTD" '*')" = "0" ]; then
  pass "no truncated artifact is promoted"
else
  fail "garbage sweep" "$(ls -1 "$OUTD" | tr '\n' ' ')"
fi

# ------------------------------- a HEAD-INTACT truncation (TGB-113 review §1) ---
# The download is a prefix of the source: the 64-byte age magic is intact, the byte
# count is not. The original `is_age_file` gate promoted exactly this and published an
# undecryptable artifact as a successful backup.
write_target 192.0.2.10
: > "$WORK/ssh.log"
OUTD="$WORK/out-truncated"
rc=0; STUB_PAYLOAD="$AGE_TRUNCATED" STUB_SOURCE_FILE="$AGE_OK" run_backup "$OUTD" || rc=$?
if [ "$rc" -ne 0 ]; then pass "a head-intact truncation fails the run"; else fail "truncation" "rc=0 — an incomplete artifact was published"; fi
if grep -q 'truncated download' "$WORK/err.log"; then
  pass "the failure names the byte mismatch against the source"
else
  fail "truncation message" "$(cat "$WORK/err.log")"
fi
if [ "$(count_matching "$OUTD" '*')" = "0" ]; then
  pass "a head-intact truncation is never published"
else
  fail "truncation sweep" "$(ls -1 "$OUTD" | tr '\n' ' ')"
fi
if head -c 64 "$AGE_TRUNCATED" | grep -q 'age-encryption.org/v1'; then
  pass "the truncation fixture really keeps the age magic (the old gate would pass it)"
else
  fail "fixture" "the truncation fixture does not keep the header — the case would not bite"
fi

# --------------------------------- a same-size sha256 mismatch ---------------
write_target 192.0.2.10
: > "$WORK/ssh.log"
OUTD="$WORK/out-shamismatch"
rc=0; STUB_SHA_OVERRIDE='0000000000000000000000000000000000000000000000000000000000000000' run_backup "$OUTD" || rc=$?
if [ "$rc" -ne 0 ]; then pass "a same-size sha256 mismatch fails the run"; else fail "sha mismatch" "rc=0"; fi
if grep -q 'sha256 mismatch' "$WORK/err.log"; then
  pass "the failure names the digest mismatch"
else
  fail "sha message" "$(cat "$WORK/err.log")"
fi
if [ "$(count_matching "$OUTD" '*')" = "0" ]; then
  pass "nothing is published when the digest disagrees"
else
  fail "sha sweep" "$(ls -1 "$OUTD" | tr '\n' ' ')"
fi

# -------------------------------------- the source says nothing about size ---
write_target 192.0.2.10
: > "$WORK/ssh.log"
OUTD="$WORK/out-nosize"
rc=0; STUB_SIZE_UNREADABLE=1 run_backup "$OUTD" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'could not read the source size' "$WORK/err.log"; then
  pass "an unreadable source size is a failed attempt, not an unverified publish"
else
  fail "unreadable size" "rc=$rc: $(cat "$WORK/err.log")"
fi
if [ "$(count_matching "$OUTD" '*')" = "0" ]; then
  pass "nothing is published when the source cannot be measured"
else
  fail "size sweep" "$(ls -1 "$OUTD" | tr '\n' ' ')"
fi

# --------------------------------------------- a dropped payload channel -----
write_target 192.0.2.10
: > "$WORK/ssh.log"
OUTD="$WORK/out-network"
rc=0; STUB_MODE=network run_backup "$OUTD" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'ssh channel dropped' "$WORK/err.log"; then
  pass "a dropped download channel fails the phase it belongs to"
else
  fail "network phase" "rc=$rc: $(cat "$WORK/err.log")"
fi

# -------------------------------------------------- the snapshot fails -----
write_target 192.0.2.10
: > "$WORK/ssh.log"
OUTD="$WORK/out-snapfail"
rc=0; STUB_MODE=snapshot_fail run_backup "$OUTD" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'could not snapshot' "$WORK/err.log"; then
  pass "a failed snapshot stops the run with a clear message"
else
  fail "snapshot failure" "rc=$rc: $(cat "$WORK/err.log")"
fi
if [ "$(count_matching "$OUTD" '*')" = "0" ]; then
  pass "a failed snapshot publishes nothing"
else
  fail "snapshot sweep" "$(ls -1 "$OUTD" | tr '\n' ' ')"
fi

# ------------------------------------------ an unexpected remote name ------
write_target 192.0.2.10
: > "$WORK/ssh.log"
OUTD="$WORK/out-badname"
rc=0; STUB_MODE=weird_name run_backup "$OUTD" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'unexpected archive name' "$WORK/err.log"; then
  pass "a name outside the contract is refused"
else
  fail "name contract" "rc=$rc: $(cat "$WORK/err.log")"
fi

# ------------------------------------------------------ key is missing -----
write_target 192.0.2.10
printf 'DEPLOY_SSH_KEY=\n' >> "$SECRETS/target.env"
: > "$WORK/ssh.log"
OUTD="$WORK/out-nokey"
rc=0; run_backup "$OUTD" || rc=$?
if [ "$rc" -ne 0 ] && [ "$(wc -l < "$WORK/ssh.log" | tr -d ' ')" = "0" ]; then
  pass "a missing key stops the run before any ssh call"
else
  fail "missing key" "rc=$rc, ssh calls: $(wc -l < "$WORK/ssh.log" | tr -d ' ')"
fi

# --------------------------------------------------- a refused target ------
write_target 38.180.69.206   # retired by TGB-112 (tools/ci/retired-deploy-hosts.txt)
: > "$WORK/ssh.log"
OUTD="$WORK/out-retired"
rc=0; run_backup "$OUTD" || rc=$?
if [ "$rc" -ne 0 ]; then pass "a retired host is refused"; else fail "retired host" "rc=0"; fi
if [ "$(wc -l < "$WORK/ssh.log" | tr -d ' ')" = "0" ]; then
  pass "a refused target never reaches a host"
else
  fail "guard order" "ssh was called for a refused target"
fi

# ------------------------- a well-formed host that is not the memes host -----
# The deny-list only knows which hosts are wrong; this pin says which one is right, so a
# stale target file cannot quietly dump somebody else's database (TGB-113 review §M8).
write_target 192.0.2.99
: > "$WORK/ssh.log"
OUTD="$WORK/out-unexpected"
rc=0; run_backup "$OUTD" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'is not on the expected-host list' "$WORK/err.log"; then
  pass "a well-formed but unexpected host is refused"
else
  fail "host pin" "rc=$rc: $(cat "$WORK/err.log")"
fi
if [ "$(wc -l < "$WORK/ssh.log" | tr -d ' ')" = "0" ]; then
  pass "an unexpected host is refused before any ssh call"
else
  fail "host pin order" "ssh was called for an unexpected host"
fi

# ------------------------------------------------- an empty expected list ----
EMPTY_LIST="$WORK/empty-hosts.txt"
: > "$EMPTY_LIST"
write_target 192.0.2.10
: > "$WORK/ssh.log"
OUTD="$WORK/out-emptylist"
rc=0; BACKUP_EXPECTED_HOSTS_FILE="$EMPTY_LIST" run_backup "$OUTD" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'no entries' "$WORK/err.log"; then
  pass "an empty expected-host list refuses instead of allowing everything"
else
  fail "empty list" "rc=$rc: $(cat "$WORK/err.log")"
fi

echo
echo "Result: PASS=${PASS} FAIL=${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
