#!/usr/bin/env bash
# Tests for tools/backup/db-backup.sh (TGB-113) with no host and no network.
#
# `ssh` is a PATH shim that answers the two phases separately (snapshot, download),
# and the repo is a copy inside a temp dir. What is checked: the happy path publishes
# ciphertext, a plaintext or truncated download is refused (fail-closed), a refused
# target never reaches a host at all, and a missing key stops the run.
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
mkdir -p "$BIN" "$SECRETS"
printf 'DASH-PRIVATE-KEY-PLACEHOLDER\n' > "$SECRETS/id_ed25519"
chmod 600 "$SECRETS/id_ed25519"

cat > "$BIN/ssh" <<'SHIM'
#!/usr/bin/env bash
# Stub ssh: log the call, find user@host, then act on the remote command. Remote
# commands here are `DEPLOY_DIR=… bash -s` (snapshot) and `cat <path>` (download).
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

case "$cmd" in
  cat\ *)
    case "${STUB_MODE:-happy}" in
      plaintext)
        printf '\037\213\010\000\000\000\000\000\000\003\053\111\055\056\341\002\000'
        exit 0;;
      garbage) printf 'partial download, no age magic\n'; exit 0;;
      network) echo "Connection reset by peer" >&2; exit 255;;
      *) printf 'age-encryption.org/v1\n'; printf 'fake ciphertext body\n'; exit 0;;
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

# --- target file --------------------------------------------------------------
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
  DEPLOY_SECRETS_DIR="$SECRETS" PATH="$BIN:/usr/bin:/bin" \
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
if grep -c 'ssh ' "$WORK/ssh.log" | grep -qx '2'; then
  pass "two ssh calls: snapshot and download"
else
  fail "ssh phases" "calls: $(wc -l < "$WORK/ssh.log" | tr -d ' ')"
fi

# --------------------------------------------- a plaintext download --------
write_target 192.0.2.10
: > "$WORK/ssh.log"
OUTD="$WORK/out-plain"
rc=0; STUB_MODE=plaintext run_backup "$OUTD" || rc=$?
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
rc=0; STUB_MODE=garbage run_backup "$OUTD" || rc=$?
if [ "$rc" -ne 0 ]; then pass "a download without the age magic fails the run"; else fail "garbage" "rc=0"; fi
if [ "$(count_matching "$OUTD" '*')" = "0" ]; then
  pass "no truncated artifact is promoted"
else
  fail "garbage sweep" "$(ls -1 "$OUTD" | tr '\n' ' ')"
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

echo
echo "Result: PASS=${PASS} FAIL=${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
