#!/usr/bin/env bash
# Tests for tools/backup/restore-drill.sh (TGB-113) with no docker, no age and no
# PostgreSQL.
#
# `docker` and `age` are PATH shims. `age -d` replays a fixture dump (gzip) built from
# a table/row fixture; the docker shim answers the readiness log, the aggregate queries
# and the parity query from that same fixture — so a correct drill must be green, and
# any single injected defect (a row lost, a table lost, a corrupt gzip, a published
# port, a failed restore) must turn exactly that check red.
#
# This is the point of the drill: it catches a backup that exists but cannot be relied
# on. The stub also records docker argv, so the test proves the throwaway instance is
# started with no published port and no network.
#
# Run: bash tools/backup/restore-drill.test.sh
# bash 3.2 (macOS) compatible. Prints PASS/FAIL; exits 1 on failure.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRILL="$SCRIPT_DIR/restore-drill.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/memes-restore-drill-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1 — $2"; FAIL=$((FAIL + 1)); }

FIX="$WORK/fixture"
BIN="$WORK/bin"
mkdir -p "$FIX" "$BIN"

# ------------------------------------------------------------------ shims ----
cat > "$BIN/docker" <<'SHIM'
#!/usr/bin/env bash
F="${MOCK_FIXTURE:?}"
echo "docker $*" >> "$F/docker.log"
sub="${1:-}"; shift || true
case "$sub" in
  info|run|rm) exit 0;;
  ps) printf '%s\n' "${MOCK_PS_NAMES:-}"; exit 0;;
  logs) echo "PostgreSQL init process complete; ready for start up."; echo "database system is ready to accept connections"; exit 0;;
  inspect)
    case "$*" in
      *NetworkSettings.Ports*) printf '%s\n' "${MOCK_PORTS:-\{\}}"; exit 0;;
    esac
    exit 0;;
  exec)
    while [ $# -gt 0 ] && [ "${1#-}" != "$1" ]; do shift; done
    shift || true              # container name
    cmd="${1:-}"; shift || true
    case "$cmd" in
      postgres) echo "postgres (PostgreSQL) 14.24"; exit 0;;
      psql)
        sql=""
        while [ $# -gt 0 ]; do
          case "$1" in
            -c) sql="${2:-}"; shift 2;;
            *) shift;;
          esac
        done
        if [ -z "$sql" ]; then cat >/dev/null; exit "${MOCK_RESTORE_RC:-0}"; fi
        case "$sql" in
          'select 1'*) echo 1; exit 0;;
          *pg_tables*) cut -f1 "$F/restored.tsv" 2>/dev/null; exit 0;;
          *'union all'*)
            printf '%s\n' "$sql" | sed 's/ union all /\n/g' | while IFS= read -r piece; do
              t="$(printf '%s' "$piece" | sed -n "s/^select '\([A-Za-z0-9_]*\)' as t.*/\1/p")"
              [ -n "$t" ] || continue
              n="$(awk -F'\t' -v t="$t" '$1 == t {print $2}' "$F/restored.tsv")"
              printf '%s|%s\n' "$t" "${n:-0}"
            done
            exit 0;;
          *'from "'*)
            t="$(printf '%s' "$sql" | sed -n 's/.*from "\([A-Za-z0-9_]*\)".*/\1/p')"
            awk -F'\t' -v t="$t" '$1 == t {print $2}' "$F/restored.tsv"
            exit 0;;
        esac
        exit 0;;
    esac
    exit 0;;
esac
exit 0
SHIM

cat > "$BIN/age" <<'SHIM'
#!/usr/bin/env bash
case "${1:-}" in
  --version) echo "1.3.2"; exit 0;;
esac
cat "$MOCK_GZIP"
exit 0
SHIM
chmod +x "$BIN/docker" "$BIN/age"

# -------------------------------------------------------------- fixture ------
regen() { # regen — rebuild the dump from the base table/row fixture and gzip it
  : > "$FIX/dump.sql"
  cp "$FIX/restored.base.tsv" "$FIX/restored.tsv"
  while IFS="$(printf '\t')" read -r t n; do
    [ -n "$t" ] || continue
    printf 'SET statement_timeout = 0;\nCREATE TABLE public.%s (id integer);\n' "$t" >> "$FIX/dump.sql"
    printf 'COPY public.%s (id) FROM stdin;\n' "$t" >> "$FIX/dump.sql"
    i=1
    while [ "$i" -le "$n" ]; do printf '%s\n' "$i" >> "$FIX/dump.sql"; i=$((i + 1)); done
    printf '\\.\n' >> "$FIX/dump.sql"
  done < "$FIX/restored.base.tsv"
  gzip -c "$FIX/dump.sql" > "$FIX/dump.sql.gz"
  cp "$FIX/dump.sql.gz" "$FIX/artifact.gz"
  if [ "${MOCK_GZIP_CORRUPT:-0}" = "1" ]; then
    # keep the first half only: a valid gzip header, a broken stream
    head -c "$(( $(wc -c < "$FIX/artifact.gz") / 2 ))" "$FIX/dump.sql.gz" > "$FIX/artifact.gz"
  fi
}

# The fixture mirrors the production shape closely enough to be meaningful: the MTProto
# session row is a single row (a canary), a content table is not.
printf 'client_session_entity\t1\n' > "$FIX/restored.base.tsv"
printf 'observatory_post_entity\t3\n' >> "$FIX/restored.base.tsv"
printf 'user_entity\t2\n' >> "$FIX/restored.base.tsv"
regen

KEY="$WORK/identity.txt"
printf '%s\n' 'AGE-SECRET-KEY-PLACEHOLDER' > "$KEY"
chmod 600 "$KEY"

FRESH_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OLD_STAMP="20200101T000000Z"

make_artifact() { # make_artifact <path> [age-magic]
  if [ "${2:-age}" = "age" ]; then
    { printf 'age-encryption.org/v1\n'; printf 'body\n'; } > "$1"
  else
    printf 'not an encrypted dump\n' > "$1"
  fi
}

run_drill() { # run_drill <artifact> [outdir]
  MOCK_FIXTURE="$FIX" MOCK_GZIP="$FIX/artifact.gz" MOCK_PORTS="${MOCK_PORTS-{}}" \
  MOCK_RESTORE_RC="${MOCK_RESTORE_RC:-0}" MOCK_PS_NAMES="${MOCK_PS_NAMES:-}" \
  BACKUP_AGE_KEY_FILE="$KEY" PATH="$BIN:/usr/bin:/bin" \
  DRILL_EXPECT_TABLES="${DRILL_EXPECT_TABLES:-3}" \
  DRILL_CANARIES="${DRILL_CANARIES:-client_session_entity:1 observatory_post_entity:1}" \
  DRILL_MIN_ROWS="${DRILL_MIN_ROWS:-1}" DRILL_HEALTH_TIMEOUT=10 \
    bash "$DRILL" "$1" "$2" > "$WORK/report.out" 2> "$WORK/report.err"
  return $?
}

# ------------------------------------------------------------ happy path -----
: > "$FIX/docker.log"
ART="$WORK/memes-bot-db-${FRESH_STAMP}.sql.gz.age"
make_artifact "$ART"
OUTD="$WORK/out-happy"
rc=0; run_drill "$ART" "$OUTD" || rc=$?
if [ "$rc" -eq 0 ]; then pass "a restorable artifact passes the drill"; else fail "happy path" "rc=$rc: $(cat "$WORK/report.out" "$WORK/report.err")"; fi
if grep -q 'result: OK' "$WORK/report.out"; then pass "the report says OK"; else fail "report" "$(tail -5 "$WORK/report.out")"; fi
if grep -q 'restore: age -d | gunzip | psql passed' "$WORK/report.out"; then pass "the restore step is reported"; else fail "restore step" "missing"; fi
if grep -q 'gzip_integrity: age -d | gzip -t passed' "$WORK/report.out"; then pass "gzip integrity is checked separately"; else fail "gzip integrity" "missing"; fi
if grep -q 'parity_rows: 3/3 tables match the dump' "$WORK/report.out"; then
  pass "every table matches the dump row for row"
else
  fail "parity" "$(grep 'parity' "$WORK/report.out" | tr '\n' ' ')"
fi
if grep -q 'artifact_sha256: [0-9a-f]\{64\}' "$WORK/report.out"; then pass "the report carries the artifact sha256"; else fail "sha256" "missing"; fi
if grep -q 'dump_tables: 3  restored_tables: 3' "$WORK/report.out"; then pass "the report carries both table sets"; else fail "table counts" "missing"; fi
if grep -q 'canary client_session_entity=1' "$WORK/report.out"; then pass "the session row is checked as a canary"; else fail "canary" "$(grep canary "$WORK/report.out" | tr '\n' ' ')"; fi
if grep -q -- '--network none' "$FIX/docker.log"; then pass "the throwaway instance runs with no network"; else fail "network" "not pinned"; fi
if grep -q -- '-p ' "$FIX/docker.log"; then fail "published port" "the drill instance publishes a port"; else pass "nothing is published on the drill instance"; fi
if grep -q 'no_published_ports' "$WORK/report.out"; then pass "the absence of published ports is asserted"; else fail "exposure check" "missing"; fi

# ------------------------------------------------------- a lost row set ------
regen
printf 'client_session_entity\t1\n' > "$FIX/restored.tsv"
printf 'observatory_post_entity\t2\n' >> "$FIX/restored.tsv"   # one row short
printf 'user_entity\t2\n' >> "$FIX/restored.tsv"
rc=0; run_drill "$ART" "$WORK/out-mismatch" || rc=$?
if [ "$rc" -ne 0 ]; then pass "a restored table that lost a row fails the drill"; else fail "parity mismatch" "rc=0"; fi
if grep -q 'FAIL parity_rows' "$WORK/report.out" && grep -q 'mismatch: observatory_post_entity — dump=3 restored=2' "$WORK/report.out"; then
  pass "the mismatch is named with both counts (names and numbers only)"
else
  fail "mismatch report" "$(grep -i 'mismatch\|parity' "$WORK/report.out" | tr '\n' ' ')"
fi

# ------------------------------------------------------- a lost table --------
printf 'client_session_entity\t1\n' > "$FIX/restored.tsv"
printf 'user_entity\t2\n' >> "$FIX/restored.tsv"    # observatory_post_entity gone
rc=0; run_drill "$ART" "$WORK/out-losttable" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'FAIL parity_tables' "$WORK/report.out"; then
  pass "a table missing from the restore fails the table-set check"
else
  fail "table set" "rc=$rc: $(grep parity "$WORK/report.out" | tr '\n' ' ')"
fi

# --------------------------------------------------------- corrupt gzip ------
regen
export MOCK_GZIP_CORRUPT=1
regen
unset MOCK_GZIP_CORRUPT
FRESH_STAMP2="$(date -u +%Y%m%dT%H%M%SZ)"
ART2="$WORK/memes-bot-db-${FRESH_STAMP2}.sql.gz.age"
make_artifact "$ART2"
rc=0; run_drill "$ART2" "$WORK/out-corrupt" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'FAIL gzip_integrity' "$WORK/report.out"; then
  pass "a corrupt gzip stream fails the integrity check"
else
  fail "corrupt gzip" "rc=$rc: $(grep gzip "$WORK/report.out" | tr '\n' ' ')"
fi
regen

# ------------------------------------------------------- restore fails -------
export MOCK_RESTORE_RC=1
rc=0; run_drill "$ART" "$WORK/out-restorefail" || rc=$?
unset MOCK_RESTORE_RC
if [ "$rc" -ne 0 ] && grep -q 'FAIL restore' "$WORK/report.out"; then
  pass "a failed psql restore fails the drill"
else
  fail "restore failure" "rc=$rc"
fi

# -------------------------------------------------- a published port ---------
export MOCK_PORTS='{"5432/tcp":[{"HostIp":"0.0.0.0","HostPort":"5432"}]}'
rc=0; run_drill "$ART" "$WORK/out-ports" || rc=$?
unset MOCK_PORTS
if [ "$rc" -ne 0 ] && grep -q 'FAIL no_published_ports' "$WORK/report.out"; then
  pass "a published port on the drill instance fails the exposure check"
else
  fail "exposure" "rc=$rc: $(grep published "$WORK/report.out" | tr '\n' ' ')"
fi

# ------------------------------------------------------- stale artifact ------
ART_OLD="$WORK/memes-bot-db-${OLD_STAMP}.sql.gz.age"
make_artifact "$ART_OLD"
rc=0; run_drill "$ART_OLD" "$WORK/out-old" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'FAIL freshness' "$WORK/report.out"; then
  pass "an artifact older than the freshness window fails"
else
  fail "freshness" "rc=$rc: $(grep freshness "$WORK/report.out" | tr '\n' ' ')"
fi

# ------------------------------------------------------- refusing inputs -----
rc=0; run_drill "$WORK/not-an-artifact.txt" "$WORK/out-name" || rc=$?
if [ "$rc" -ne 0 ]; then pass "an unexpected artifact name is refused"; else fail "name" "rc=0"; fi

mkdir -p "$WORK/plain"
ART_PLAIN="$WORK/plain/memes-bot-db-${FRESH_STAMP}.sql.gz.age"
make_artifact "$ART_PLAIN" plain
rc=0; run_drill "$ART_PLAIN" "$WORK/out-plain" || rc=$?
if [ "$rc" -ne 0 ]; then pass "a file without the age magic is refused"; else fail "plain artifact" "rc=0"; fi

rc=0
BACKUP_AGE_KEY_FILE="$WORK/missing-key.txt" MOCK_FIXTURE="$FIX" MOCK_GZIP="$FIX/artifact.gz" \
  PATH="$BIN:/usr/bin:/bin" bash "$DRILL" "$ART" "$WORK/out-nokey" > "$WORK/report.out" 2>&1 || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'does not exist' "$WORK/report.out"; then
  pass "a missing identity stops the drill"
else
  fail "missing key" "rc=$rc: $(tail -2 "$WORK/report.out")"
fi

chmod 644 "$KEY"
rc=0; run_drill "$ART" "$WORK/out-lax" || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'readable by others' "$WORK/report.out"; then
  pass "an identity readable by others is refused"
else
  fail "key mode" "rc=$rc: $(tail -2 "$WORK/report.out")"
fi
chmod 600 "$KEY"

# ------------------------------------------- the drill refuses to run on prod --
export MOCK_PS_NAMES='memes-postgres'
rc=0; run_drill "$ART" "$WORK/out-prod" || rc=$?
unset MOCK_PS_NAMES
if [ "$rc" -ne 0 ] && grep -q 'production memes-postgres' "$WORK/report.out"; then
  pass "the drill refuses to run on a host that runs the stack"
else
  fail "prod seat-belt" "rc=$rc: $(tail -2 "$WORK/report.out")"
fi

echo
echo "Result: PASS=${PASS} FAIL=${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
