#!/usr/bin/env bash
# Restore drill for the memes-bot DB backup (TGB-113): prove that the off-site age
# artifact really decrypts, really restores into a clean PostgreSQL, and really holds
# what it claims — "a dump exists" is not evidence, "a restore works" is.
#
# Shape: takes an already downloaded artifact `memes-bot-db-<stamp>.sql.gz.age`
# (fetching the latest successful backup run is the workflow's job,
# .github/workflows/restore-drill.yml), checks the container image is the one the
# production stack pins (postgres:14 — the dump comes from server 14.24), restores
# into an ephemeral container with NO published ports and no network, and verifies.
#
# What is verified
#   1. freshness   — STAMP in the file name is not older than DRILL_MAX_AGE_HOURS;
#   2. integrity   — `age -d | gzip -t` over the whole stream (no plaintext on disk);
#   3. restore     — `age -d | gunzip | psql` into the throwaway instance;
#   4. parity      — per-table row counts taken from the dump's own COPY blocks
#                    (this is what the artifact contains) against the restored
#                    database; the table set is compared too. This is why the drill
#                    needs no production access at all: the dump is its own
#                    reference, so the check cannot silently drift with prod;
#   5. canaries    — tables that are non-empty in production (deterministic markers);
#   6. shape       — at least DRILL_EXPECT_TABLES tables, at least DRILL_MIN_ROWS rows;
#   7. exposure    — the ephemeral instance publishes no port (asserted, not assumed).
#
# THIS NEVER TOUCHES PRODUCTION. It only reads a local artifact and drives its own
# throwaway container. As a seat-belt it refuses to start on a host that already runs
# the production `memes-postgres` container (override only if you know why:
# DRILL_ALLOW_PROD_HOST=1). Restoring into the *running* stack is a different,
# gated operation — see tools/backup/README.md (single-instance rule, TRL-604).
#
# PII: the plaintext dump never reaches a disk (pipes only); every SQL statement is an
# aggregate (count(*)/pg_tables); the report carries table names, counts and versions.
# psql stderr is dropped during the restore (it can echo COPY values).
#
# Usage: restore-drill.sh <artifact.sql.gz.age> [outDir]
#        The report is written to [outDir]/restore-drill-report.txt unless DRILL_REPORT says
#        otherwise; nothing else is written there (the plaintext never reaches a disk).
# Env: BACKUP_AGE_KEY_FILE (required — the key is never passed in argv)
#      DRILL_MAX_AGE_HOURS (48), DRILL_EXPECT_TABLES (20), DRILL_MIN_ROWS (1)
#      DRILL_CANARIES ("client_session_entity:1 parser_settings_entity:1
#                      observatory_post_entity:1")
#      DRILL_PG_IMAGE (postgres:14-alpine), DRILL_PG_USER/PG_DB (postgress),
#      DRILL_PG_PASSWORD (change_me), DRILL_HEALTH_TIMEOUT (90)
#      DRILL_REPORT (path to also write the report to)
#
# Test: tools/backup/restore-drill.test.sh.
set -euo pipefail

usage() { echo "usage: restore-drill.sh <artifact.sql.gz.age> [outDir]" >&2; exit 2; }

ARTIFACT="${1:-}"
[ -n "$ARTIFACT" ] || usage
OUT_DIR="${2:-$(dirname "$ARTIFACT")}"
BACKUP_AGE_KEY_FILE="${BACKUP_AGE_KEY_FILE:?BACKUP_AGE_KEY_FILE is not set — no identity to decrypt with}"

MAX_AGE_HOURS="${DRILL_MAX_AGE_HOURS:-48}"
EXPECT_TABLES="${DRILL_EXPECT_TABLES:-20}"
MIN_ROWS="${DRILL_MIN_ROWS:-1}"
CANARIES="${DRILL_CANARIES:-client_session_entity:1 parser_settings_entity:1 observatory_post_entity:1}"
PG_IMAGE="${DRILL_PG_IMAGE:-postgres:14-alpine}"
PG_USER="${DRILL_PG_USER:-postgress}"
PG_DB="${DRILL_PG_DB:-postgress}"
PG_PASSWORD="${DRILL_PG_PASSWORD:-change_me}"
HEALTH_TIMEOUT="${DRILL_HEALTH_TIMEOUT:-90}"
PREFIX="memes-bot-db"

if [ -z "${DRILL_REPORT:-}" ] && [ -n "$OUT_DIR" ]; then
  mkdir -p "$OUT_DIR" 2>/dev/null || true
  DRILL_REPORT="$OUT_DIR/restore-drill-report.txt"
fi

CONTAINER="memes-restore-drill-pg-$$"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/memes-restore-drill.XXXXXX")"
DUMP_COUNTS="$WORK/dump-counts.tsv"   # table<TAB>rows, counted from the dump's COPY blocks
RESTORED_COUNTS="$WORK/restored-counts.tsv"
AWK="$WORK/count-copy.awk"
REPORT_TMP="$WORK/report.txt"

PASS=0
FAIL=0
ok()  { echo "PASS: $1"; printf 'PASS %s\n' "$1" >> "$REPORT_TMP"; PASS=$((PASS + 1)); }
bad() { echo "FAIL: $1 — $2"; printf 'FAIL %s — %s\n' "$1" "$2" >> "$REPORT_TMP"; FAIL=$((FAIL + 1)); }

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

die() { echo "FAIL: $1 — $2"; exit 1; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# --------------------------------------------------------------- preflight ---
command -v age >/dev/null 2>&1 || die "age" "not found in PATH"
[ -f "$BACKUP_AGE_KEY_FILE" ] || die "key" "BACKUP_AGE_KEY_FILE does not exist: ${BACKUP_AGE_KEY_FILE}"
[ -s "$BACKUP_AGE_KEY_FILE" ] || die "key" "BACKUP_AGE_KEY_FILE is empty: ${BACKUP_AGE_KEY_FILE}"
# The identity is a private key: a group/world readable copy is a leak, not a detail.
KEY_MODE="$(ls -l "$BACKUP_AGE_KEY_FILE" | cut -c1-10)"
case "$KEY_MODE" in
  *------*) ;;
  *) die "key" "BACKUP_AGE_KEY_FILE is readable by others (mode ${KEY_MODE}) — fix the mode first";;
esac
command -v docker >/dev/null 2>&1 || die "docker" "not found in PATH"
docker info >/dev/null 2>&1 || die "docker" "daemon is not reachable"
# Seat-belt: never run the drill where the stack itself runs.
if [ "${DRILL_ALLOW_PROD_HOST:-0}" != "1" ] \
   && docker ps -a --format '{{.Names}}' | grep -qx 'memes-postgres'; then
  die "host" "this engine runs the production memes-postgres container — the drill belongs on the CI node (DRILL_ALLOW_PROD_HOST=1 to override)"
fi

# ------------------------------------------------------- artifact checks ----
[ -f "$ARTIFACT" ] || die "artifact" "file not found: ${ARTIFACT}"
NAME="$(basename "$ARTIFACT")"
case "$NAME" in
  ${PREFIX}-*.sql.gz.age) ;;
  *) die "artifact" "unexpected artifact name: '${NAME}'";;
esac
if ! [[ "$NAME" =~ ^${PREFIX}-[0-9T]+Z\.sql\.gz\.age$ ]]; then
  die "artifact" "name does not match ${PREFIX}-<UTCstamp>.sql.gz.age: '${NAME}'"
fi
[ -s "$ARTIFACT" ] || die "artifact" "artifact is empty: ${NAME}"
head -c 64 "$ARTIFACT" | grep -q 'age-encryption.org/v1' \
  || die "artifact" "artifact is not age ciphertext: ${NAME}"

STAMP="$(printf '%s' "$NAME" | sed -E "s/^${PREFIX}-([0-9T]+Z)\.sql\.gz\.age\$/\1/")"
stamp_epoch() { # YYYYMMDDTHHMMSSZ → epoch
  local s="$1" iso
  iso="${s:0:4}-${s:4:2}-${s:6:2}T${s:9:2}:${s:11:2}:${s:13:2}Z"
  if date -u -d "$iso" +%s >/dev/null 2>&1; then date -u -d "$iso" +%s
  else date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$iso" +%s; fi
}
STAMP_EPOCH="$(stamp_epoch "$STAMP")" || die "artifact" "cannot parse the STAMP in '${STAMP}'"
NOW_EPOCH="$(date -u +%s)"
AGE_HOURS=$(( (NOW_EPOCH - STAMP_EPOCH) / 3600 ))

ARTIFACT_BYTES="$(wc -c < "$ARTIFACT" | tr -d ' ')"
ARTIFACT_SHA="$(sha256_of "$ARTIFACT")"
AGE_VERSION="$(age --version 2>/dev/null || true)"

if [ "$AGE_HOURS" -le "$MAX_AGE_HOURS" ] && [ "$AGE_HOURS" -ge "-$MAX_AGE_HOURS" ]; then
  ok "freshness: artifact is ${AGE_HOURS}h old ≤ ${MAX_AGE_HOURS}h"
else
  bad "freshness" "artifact is ${AGE_HOURS}h old > ${MAX_AGE_HOURS}h (STAMP=${STAMP})"
fi

# --------------------------------------------------------- ephemeral PG -----
# No `-p`: nothing is published. `--network none`: the instance cannot talk to
# anything at all — reachable only through `docker exec`.
docker run -d --rm --name "$CONTAINER" --network none \
  -e POSTGRES_USER="$PG_USER" -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB="$PG_DB" \
  "$PG_IMAGE" >/dev/null

# Readiness: the official image starts a TEMPORARY server for initialisation and stops
# it again, so `pg_isready` can answer "ok" for a server that is already going away.
# Wait for the init phase to finish in the log first, then probe with a real query.
waited=0
until docker logs "$CONTAINER" 2>&1 | grep -q 'PostgreSQL init process complete'; do
  waited=$((waited + 1))
  [ "$waited" -le "$HEALTH_TIMEOUT" ] || break
  sleep 1
done

ready=0
while [ "$waited" -le "$HEALTH_TIMEOUT" ]; do
  if docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -tAq -U "$PG_USER" -d "$PG_DB" \
       -c 'select 1' >/dev/null 2>&1; then
    ready=1; break
  fi
  waited=$((waited + 1))
  sleep 1
done
[ "$ready" -eq 1 ] || die "pg" "postgres did not become ready within ${HEALTH_TIMEOUT}s"

# No `-i`: a scalar query must not eat the caller's stdin.
pg_sql() { docker exec "$CONTAINER" psql -v ON_ERROR_STOP=1 -tAq -U "$PG_USER" -d "$PG_DB" -c "$1"; }

QUOTED_PORTS="$(docker inspect "$CONTAINER" --format '{{json .NetworkSettings.Ports}}' 2>/dev/null || echo unknown)"
case "$QUOTED_PORTS" in
  '{}'|'null') ok "no_published_ports: the drill instance is not published" ;;
  *) bad "no_published_ports" "the drill instance publishes something: ${QUOTED_PORTS}" ;;
esac

# ------------------------------------------------------------ integrity -----
# Whole-stream gzip integrity of the *decrypted* artifact. The plaintext stays in the
# pipe; nothing is written to disk.
if age -d -i "$BACKUP_AGE_KEY_FILE" "$ARTIFACT" 2>"$WORK/age.err" | gzip -t; then
  ok "gzip_integrity: age -d | gzip -t passed"
else
  bad "gzip_integrity" "the decrypted stream is not a valid gzip stream (rc=${PIPESTATUS[0]:-?})"
  # age's own message never carries PII, but it is not printed either: the two causes
  # are named instead, so a log is not the place where a dump's content could surface.
  [ ! -s "$WORK/age.err" ] || echo "  hint: age reported an error — wrong identity for this artifact, or a corrupt file"
fi

# --------------------------------------------------------------- restore ----
# The dump is its own reference: count the rows of every COPY block while it streams
# past, then compare with what the database ended up holding. `print` passes every
# line through untouched, so the same single pass still feeds psql.
cat > "$AWK" <<'AWK'
# Rows per table from a plain-SQL pg_dump: inside a COPY block every line is one row
# (a value's own newline is escaped); the block ends at a lone `\.` (a data line
# starting with a backslash is escaped as `\\`, so `\.` cannot occur as data).
{
  if (cur != "") {
    if ($0 == "\\.") { cur = "" } else { n[cur]++ }
  } else if ($0 ~ /^COPY /) {
    t = $2
    sub(/^public\./, "", t)
    gsub(/"/, "", t)
    cur = t
    if (!(t in n)) { n[t] = 0; order[++k] = t }
  }
  print
}
END {
  for (i = 1; i <= k; i++) printf "%s\t%d\n", order[i], n[order[i]] > out
}
AWK

# psql errors are dropped (a COPY context can echo values); age's stderr is kept (it
# carries key/format errors and no PII).
if age -d -i "$BACKUP_AGE_KEY_FILE" "$ARTIFACT" 2>"$WORK/age.err" \
     | gunzip -c \
     | awk -v out="$DUMP_COUNTS" -f "$AWK" \
     | docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -q -U "$PG_USER" -d "$PG_DB" \
       >/dev/null 2>/dev/null; then
  ok "restore: age -d | gunzip | psql passed"
else
  rc=$?
  bad "restore" "the restore failed (rc=${rc}); details are withheld to avoid leaking PII"
fi

# ------------------------------------------------------- integrity checks ---
TABLES="$(pg_sql "select tablename from pg_tables where schemaname='public' order by 1" 2>/dev/null || true)"
TABLE_COUNT="$(printf '%s\n' "$TABLES" | grep -c . || true)"
case "$TABLE_COUNT" in
  ''|*[!0-9]*)
    bad "tables" "got '${TABLE_COUNT}', expected at least ${EXPECT_TABLES}";;
  *)
    if [ "$TABLE_COUNT" -ge "$EXPECT_TABLES" ]; then
      ok "tables: ${TABLE_COUNT} >= ${EXPECT_TABLES}"
    else
      bad "tables" "got ${TABLE_COUNT}, expected at least ${EXPECT_TABLES}"
    fi;;
esac

for canary in $CANARIES; do
  tbl="${canary%%:*}"; min="${canary##*:}"
  n="$(pg_sql "select count(*) from \"${tbl}\"" 2>/dev/null || echo ERR)"
  case "$n" in
    ''|*[!0-9]*) bad "canary ${tbl}" "could not read the row count ('${n}')";;
    *) if [ "$n" -ge "$min" ]; then ok "canary ${tbl}=${n} ≥ ${min}"
       else bad "canary ${tbl}" "rows=${n} < ${min}"; fi;;
  esac
done

# ------------------------------------------------------------- parity -------
# counts restored, one query for every table found in the dump
DUMP_TABLES="$(cut -f1 "$DUMP_COUNTS" 2>/dev/null || true)"
DUMP_TABLE_COUNT="$(printf '%s\n' "$DUMP_TABLES" | grep -c . || true)"
PARITY_SQL=""
while IFS= read -r tbl; do
  [ -n "$tbl" ] || continue
  piece="select '${tbl}' as t, count(*)::text as n from \"${tbl}\""
  if [ -z "$PARITY_SQL" ]; then PARITY_SQL="$piece"; else PARITY_SQL="$PARITY_SQL union all $piece"; fi
done <<EOF
$DUMP_TABLES
EOF

if [ -n "$PARITY_SQL" ]; then
  pg_sql "$PARITY_SQL" 2>/dev/null | awk -F'|' '{print $1"\t"$2}' > "$RESTORED_COUNTS" || true
fi

if [ ! -s "$DUMP_COUNTS" ]; then
  bad "parity" "the dump yielded no COPY blocks — nothing to compare (truncated artifact?)"
else
  if [ "$DUMP_TABLE_COUNT" -ne "$TABLE_COUNT" ]; then
    bad "parity_tables" "the dump has ${DUMP_TABLE_COUNT} table(s) with data blocks, the restored database has ${TABLE_COUNT}"
  else
    ok "parity_tables: ${DUMP_TABLE_COUNT}/${TABLE_COUNT} tables"
  fi

  MATCHED=0
  MISMATCHED=0
  DUMP_TOTAL=0
  RESTORED_TOTAL=0
  {
    printf '\n%-34s %10s %10s\n' "table" "dump" "restored"
    printf '%-34s %10s %10s\n' "----------------------------------" "----------" "----------"
  } >> "$REPORT_TMP"
  while IFS="$(printf '\t')" read -r tbl expected; do
    [ -n "$tbl" ] || continue
    actual="$(awk -F'\t' -v t="$tbl" '$1 == t {print $2}' "$RESTORED_COUNTS" 2>/dev/null || true)"
    case "$actual" in ''|*[!0-9]*) actual="ERR";; esac
    if [ "$actual" = "$expected" ]; then MATCHED=$((MATCHED + 1))
    else
      MISMATCHED=$((MISMATCHED + 1))
      echo "  mismatch: ${tbl} — dump=${expected} restored=${actual}" >> "$REPORT_TMP"
    fi
    case "$expected" in ''|*[!0-9]*) expected=0;; esac
    DUMP_TOTAL=$((DUMP_TOTAL + expected))
    case "$actual" in ''|*[!0-9]*) actual=0;; esac
    RESTORED_TOTAL=$((RESTORED_TOTAL + actual))
    printf '%-34s %10s %10s\n' "$tbl" "$expected" "$actual" >> "$REPORT_TMP"
  done < "$DUMP_COUNTS"

  if [ "$MISMATCHED" -eq 0 ]; then
    ok "parity_rows: ${MATCHED}/${MATCHED} tables match the dump (dump=${DUMP_TOTAL} rows, restored=${RESTORED_TOTAL} rows)"
  else
    bad "parity_rows" "${MISMATCHED} table(s) differ from the dump (details are in the report)"
  fi

  if [ "$DUMP_TOTAL" -ge "$MIN_ROWS" ] && [ "$DUMP_TOTAL" -gt 0 ]; then
    ok "total_rows: ${DUMP_TOTAL} ≥ ${MIN_ROWS}"
  else
    bad "total_rows" "the dump carries ${DUMP_TOTAL} row(s) < ${MIN_ROWS} (looks like an empty dump)"
  fi
fi

PG_VERSION="$(docker exec "$CONTAINER" postgres --version 2>/dev/null | sed 's/^postgres //' || echo unknown)"

# ----------------------------------------------------------------- report ---
DURATION="${SECONDS:-0}"
{
  echo
  echo "restore-drill report"
  echo "artifact: ${NAME}"
  echo "artifact_bytes: ${ARTIFACT_BYTES}"
  echo "artifact_sha256: ${ARTIFACT_SHA}"
  echo "artifact_stamp: ${STAMP} (age: ${AGE_HOURS}h)"
  echo "age_version: ${AGE_VERSION:-unknown}"
  echo "pg_version: ${PG_VERSION:-unknown}"
  echo "dump_tables: ${DUMP_TABLE_COUNT:-0}  restored_tables: ${TABLE_COUNT}"
  echo "canaries: ${CANARIES}"
  echo "expect_tables: ${EXPECT_TABLES}  min_rows: ${MIN_ROWS}"
  echo "result: $([ "$FAIL" -eq 0 ] && echo OK || echo FAIL) (pass=${PASS} fail=${FAIL})"
  echo "duration_s: ${DURATION}"
} >> "$REPORT_TMP"

cat "$REPORT_TMP"
if [ -n "${DRILL_REPORT:-}" ]; then
  cp "$REPORT_TMP" "$DRILL_REPORT"
fi

echo
echo "Result: PASS=${PASS} FAIL=${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
