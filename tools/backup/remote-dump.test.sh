#!/usr/bin/env bash
# Tests for tools/backup/remote-dump.sh (TGB-113) with no host, no docker and no age.
#
# Everything external is a PATH shim: `docker` (emulating `exec … pg_dump`) and `age`
# (emulating encryption). What is checked: encryption happens at the source, the
# recipient reaches age, rotation keeps the last N and never touches the one-off
# artifacts — and above all fail-closed: a missing age or recipient must abort
# BEFORE the dump, and no plaintext may be left behind.
#
# Run: bash tools/backup/remote-dump.test.sh
# bash 3.2 (macOS) compatible. Prints PASS/FAIL; exits 1 on failure.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DUMP="$SCRIPT_DIR/remote-dump.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/memes-remote-dump-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

BIN="$WORK/bin"              # docker + age
BIN_NOAGE="$WORK/bin-noage"  # only docker
mkdir -p "$BIN" "$BIN_NOAGE"

# --------------------------------------------------------------- shims -----
cat > "$BIN/docker" <<'SHIM'
#!/usr/bin/env bash
echo "docker $*" >> "${MOCK_CALLS:?}"
if [ "${MOCK_PGDUMP_FAIL:-0}" = "1" ]; then
  echo "pg_dump: error: connection to server failed" >&2
  exit 1
fi
printf -- '-- fake dump\nCREATE TABLE memes_x (id int);\n'
exit 0
SHIM
cp "$BIN/docker" "$BIN_NOAGE/docker"

cat > "$BIN/age" <<'SHIM'
#!/usr/bin/env bash
echo "age $*" >> "${MOCK_CALLS:?}"
if [ "${MOCK_AGE_FAIL:-0}" = "1" ]; then
  echo "age: error: bad recipient" >&2
  exit 1
fi
if [ "${MOCK_AGE_EMPTY:-0}" = "1" ]; then exit 0; fi
# Emulate age ciphertext: the format magic followed by the (compressed) input.
printf 'age-encryption.org/v1\n'
cat
SHIM

chmod +x "$BIN/docker" "$BIN/age" "$BIN_NOAGE/docker"

# --------------------------------------------------------------- helpers ---
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

DST="$WORK/vps"
CALLS="$WORK/calls.log"
OUT="$WORK/out.log"
ERR="$WORK/err.log"

# fresh_stack — an empty "production host" with a recipient file
fresh_stack() {
  rm -rf "$DST"
  mkdir -p "$DST"
  printf '%s\n' 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' > "$DST/backup-recipient.txt"
  : > "$CALLS"
}

# a second PATH where `age` emits something without the age magic
mkdir -p "$WORK/bin-nonage"
cp "$BIN/docker" "$WORK/bin-nonage/docker"
cat > "$WORK/bin-nonage/age" <<'SHIM'
#!/usr/bin/env bash
printf 'this is not age output\n'
cat >/dev/null
SHIM
chmod +x "$WORK/bin-nonage/age"

# ------------------------------------------------------- happy path --------
fresh_stack
MOCK_CALLS="$CALLS" DEPLOY_DIR="$DST" PATH="$BIN:$PATH" bash "$DUMP" > "$OUT" 2> "$ERR"
rc=$?
if [ "$rc" -eq 0 ]; then pass "happy path exits 0"; else fail "happy path" "rc=$rc: $(cat "$ERR")"; fi

ARCHIVE="$(ls -1 "$DST/backups"/memes-bot-db-*.sql.gz.age 2>/dev/null | head -1)"
NAME="$(basename "${ARCHIVE:-none}")"
case "$NAME" in
  memes-bot-db-*.sql.gz.age) pass "archive name follows memes-bot-db-<UTCstamp>.sql.gz.age";;
  *) fail "archive name" "got '${NAME}'";;
esac
if printf '%s' "$NAME" | grep -Eq '^memes-bot-db-[0-9]{8}T[0-9]{6}Z\.sql\.gz\.age$'; then
  pass "archive name carries a UTC stamp"
else
  fail "archive stamp" "'${NAME}'"
fi
if [ -s "${ARCHIVE:-/nonexistent}" ]; then pass "archive is not empty"; else fail "archive size" "empty or missing"; fi
if head -c 64 "${ARCHIVE:-/nonexistent}" 2>/dev/null | grep -q 'age-encryption.org/v1'; then
  pass "archive is age ciphertext"
else
  fail "archive format" "no age magic in ${NAME}"
fi
if printf '%s' "$(tail -1 "$OUT")" | grep -q '/backups/memes-bot-db-.*\.sql\.gz\.age$'; then
  pass "the script prints the absolute archive path as its last line"
else
  fail "stdout contract" "last line: $(tail -1 "$OUT")"
fi
if [ "$(count_matching "$DST/backups" '*')" = "$(count_matching "$DST/backups" '*.age')" ]; then
  pass "no plaintext file is left in backups/"
else
  fail "plaintext sweep" "$(ls -1 "$DST/backups" | tr '\n' ' ')"
fi
if grep -q 'exec memes-postgres' "$CALLS" && grep -q 'age -r age1' "$CALLS"; then
  pass "dump runs inside the db container and the recipient reaches age"
else
  fail "shim wiring" "docker/age were not called as expected"
fi
if grep -q 'pg_dump' "$CALLS" && ! grep -Eq 'POSTGRES_PASSWORD|PGPASSWORD' "$CALLS"; then
  pass "the container's own env expands the credentials (no secret in this argv)"
else
  fail "credential handling" "docker argv carried a credential"
fi

# ------------------------------------------------- fail-closed: no age -----
# A restricted PATH on purpose: a developer machine may well have a real `age`
# installed (the shims are only first on PATH), and this case must see no age at all.
fresh_stack
MOCK_CALLS="$CALLS" DEPLOY_DIR="$DST" PATH="$BIN_NOAGE:/usr/bin:/bin" bash "$DUMP" > "$OUT" 2> "$ERR"
rc=$?
if [ "$rc" -ne 0 ]; then pass "no age in PATH → non-zero"; else fail "no age" "rc=0"; fi
if grep -q 'age' "$ERR"; then pass "no age → the error names the cause"; else fail "no age message" "$(cat "$ERR")"; fi
if [ ! -d "$DST/backups" ] || [ "$(count_matching "$DST/backups" '*')" = "0" ]; then
  pass "no age → nothing is dumped (fail-closed)"
else
  fail "no age" "a dump was produced without encryption: $(ls -1 "$DST/backups")"
fi
if ! grep -q 'pg_dump' "$CALLS"; then
  pass "no age → the dump is never taken"
else
  fail "no age" "pg_dump ran anyway"
fi

# --------------------------------------- fail-closed: recipient missing ----
fresh_stack
rm -f "$DST/backup-recipient.txt"
MOCK_CALLS="$CALLS" DEPLOY_DIR="$DST" PATH="$BIN:$PATH" bash "$DUMP" > "$OUT" 2> "$ERR"
rc=$?
if [ "$rc" -ne 0 ] && grep -q 'recipient' "$ERR"; then
  pass "no recipient → non-zero with a clear message"
else
  fail "no recipient" "rc=$rc: $(cat "$ERR")"
fi
if ! grep -q 'pg_dump' "$CALLS"; then pass "no recipient → the dump is never taken"; else fail "no recipient" "pg_dump ran anyway"; fi

# ------------------------------------------------- a malformed recipient ----
fresh_stack
printf '%s\n' 'not-an-age-key' > "$DST/backup-recipient.txt"
MOCK_CALLS="$CALLS" DEPLOY_DIR="$DST" PATH="$BIN:$PATH" bash "$DUMP" > "$OUT" 2> "$ERR"
rc=$?
if [ "$rc" -ne 0 ] && grep -q 'public key' "$ERR"; then
  pass "a recipient that is not age1… is refused"
else
  fail "bad recipient" "rc=$rc: $(cat "$ERR")"
fi

# -------------------------------------------------- recipient via env ------
fresh_stack
rm -f "$DST/backup-recipient.txt"
MOCK_CALLS="$CALLS" DEPLOY_DIR="$DST" BACKUP_AGE_RECIPIENT='age1zzzz' PATH="$BIN:$PATH" \
  bash "$DUMP" > "$OUT" 2> "$ERR"
rc=$?
if [ "$rc" -eq 0 ] && ls -1 "$DST/backups"/memes-bot-db-*.sql.gz.age >/dev/null 2>&1; then
  pass "BACKUP_AGE_RECIPIENT is used when the file is absent"
else
  fail "env recipient" "rc=$rc: $(cat "$ERR")"
fi

# ------------------------------------------------ empty ciphertext ---------
fresh_stack
MOCK_CALLS="$CALLS" DEPLOY_DIR="$DST" MOCK_AGE_EMPTY=1 PATH="$BIN:$PATH" bash "$DUMP" > "$OUT" 2> "$ERR"
rc=$?
if [ "$rc" -ne 0 ] && [ "$(count_matching "$DST/backups" '*')" = "0" ]; then
  pass "empty ciphertext → failure and nothing published"
else
  fail "empty ciphertext" "rc=$rc, dir: $(ls -1 "$DST/backups" 2>/dev/null | tr '\n' ' ')"
fi

# ------------------------------------------------ ciphertext not age -------
fresh_stack
MOCK_CALLS="$CALLS" DEPLOY_DIR="$DST" PATH="$WORK/bin-nonage:$PATH" bash "$DUMP" > "$OUT" 2> "$ERR"
rc=$?
if [ "$rc" -ne 0 ] && [ "$(count_matching "$DST/backups" '*')" = "0" ]; then
  pass "output without the age magic → failure and nothing published"
else
  fail "non-age output" "rc=$rc, dir: $(ls -1 "$DST/backups" 2>/dev/null | tr '\n' ' ')"
fi

# ---------------------------------------------------- pg_dump fails --------
fresh_stack
MOCK_CALLS="$CALLS" DEPLOY_DIR="$DST" MOCK_PGDUMP_FAIL=1 PATH="$BIN:$PATH" bash "$DUMP" > "$OUT" 2> "$ERR"
rc=$?
if [ "$rc" -ne 0 ] && [ "$(count_matching "$DST/backups" '*')" = "0" ]; then
  pass "a failed pg_dump leaves no archive"
else
  fail "pg_dump failure" "rc=$rc, dir: $(ls -1 "$DST/backups" 2>/dev/null | tr '\n' ' ')"
fi

# ---------------------------------------------------------- rotation -------
fresh_stack
mkdir -p "$DST/backups"
# KEEP=1: two older archives of our naming plus a one-off artifact that must survive.
printf 'x' > "$DST/backups/memes-bot-db-20260101T000000Z.sql.gz.age"
printf 'x' > "$DST/backups/memes-bot-db-20260102T000000Z.sql.gz.age"
printf 'x' > "$DST/backups/memes-final-20261014T164114Z.sql.gz.age"
sleep 1
MOCK_CALLS="$CALLS" DEPLOY_DIR="$DST" BACKUP_KEEP=1 PATH="$BIN:$PATH" bash "$DUMP" > "$OUT" 2> "$ERR"
rc=$?
KEPT_OURS="$(count_matching "$DST/backups" 'memes-bot-db-*.sql.gz.age')"
if [ "$rc" -eq 0 ] && [ "$KEPT_OURS" = "1" ]; then
  pass "rotation keeps BACKUP_KEEP archives (1 left of 3)"
else
  fail "rotation" "rc=$rc, kept=${KEPT_OURS}"
fi
if [ -f "$DST/backups/memes-final-20261014T164114Z.sql.gz.age" ]; then
  pass "rotation never touches the one-off memes-final-* artifacts"
else
  fail "rotation" "the one-off artifact was deleted"
fi
if [ "$(basename "$(ls -1 "$DST/backups"/memes-bot-db-*.sql.gz.age)")" != "memes-bot-db-20260102T000000Z.sql.gz.age" ]; then
  pass "rotation kept the newest archive"
else
  fail "rotation" "the newest archive was rotated out"
fi

echo
echo "Result: PASS=${PASS} FAIL=${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
