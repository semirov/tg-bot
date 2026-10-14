#!/usr/bin/env bash
# Off-host copy of the memes-bot DB backup (TGB-113). Runs ON the home-server, pulls
# the newest encrypted dump from the production host and rotates the local copies.
#
# Why a pull and not a push from CI: the self-hosted runner is an OrbStack container
# on the dev node and cannot reach the home-server (its network has no return route
# from 192.168.215.0/24 — measured 2026-10-14, see TGB-113), while the home-server
# already holds an unrestricted key to the production host that its monitoring
# tunnels use. Pulling keeps the key where it already lives and moves ciphertext
# only: this script never sees a plaintext dump and holds no decryption key.
#
# Idempotent: the newest artifact is skipped when the local copy already has the same
# size and sha256; the exit code is 0 for "already up to date" too. A stale source
# (nothing newer than OFFSITE_MAX_AGE_HOURS) is a failure, not a warning — silent
# staleness is the failure mode this copy exists to prevent.
#
# Verified BEFORE promotion, like the CI side (TGB-113 re-review): the source's byte
# count and sha256 are read first, and the download is promoted only when both match.
# The age magic alone is not a completeness check — it sits at the START of the file,
# so a truncated or altered transfer keeps it. This matters more here than anywhere
# else: nothing downstream ever validates the off-host copy (the drill reads the CI
# artifact), so this script is its only gate. A source that cannot answer the size or
# the digest fails the run instead of degrading to a weaker check.
#
# Env: VPS_SSH_KEY        private key for the production host (required)
#      VPS_TARGET         user@host (root@185.238.169.171)
#      VPS_BACKUP_DIR     source directory (/opt/memes-bot/backups)
#      OFFSITE_DIR        destination (/home/filipp/backups/memes-bot)
#      OFFSITE_KEEP       copies kept (14 — the source keeps 3, this is the long tail)
#      OFFSITE_MAX_AGE_HOURS  refuse a source artifact older than this (48)
#      OFFSITE_DRY_RUN    "1" — list what would happen, change nothing
#
# Cron (home-server): see tools/backup/README.md.
# Test: tools/backup/offsite-pull.test.sh.
set -euo pipefail

VPS_SSH_KEY="${VPS_SSH_KEY:?VPS_SSH_KEY is not set — cannot reach the production host}"
VPS_TARGET="${VPS_TARGET:-root@185.238.169.171}"
VPS_BACKUP_DIR="${VPS_BACKUP_DIR:-/opt/memes-bot/backups}"
OFFSITE_DIR="${OFFSITE_DIR:-/home/filipp/backups/memes-bot}"
OFFSITE_KEEP="${OFFSITE_KEEP:-14}"
MAX_AGE_HOURS="${OFFSITE_MAX_AGE_HOURS:-48}"
PREFIX="memes-bot-db"
DRY_RUN="${OFFSITE_DRY_RUN:-0}"

die() { echo "!! offsite-pull: $1" >&2; exit 1; }

[ -f "$VPS_SSH_KEY" ] || die "key file not found: ${VPS_SSH_KEY}"
[ -s "$VPS_SSH_KEY" ] || die "key file is empty: ${VPS_SSH_KEY}"

SSH_BASE=(ssh -i "$VPS_SSH_KEY" \
  -o BatchMode=yes -o ConnectTimeout=15 \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=6 -o TCPKeepAlive=yes \
  -o StrictHostKeyChecking=accept-new)

# count_matching <dir> <glob> — how many entries match (0 when there are none)
count_matching() {
  local n=0 f
  for f in "$1"/$2; do
    [ -e "$f" ] || continue
    n=$((n + 1))
  done
  printf '%s' "$n"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else openssl dgst -sha256 "$1" | awk '{print $NF}'; fi
}

# What the source says a complete copy is. Both answers are mandatory: an empty one is
# a failed run, never a weaker check (a source without any of these three tools is not
# a source we can verify against).
remote_size() { # remote_size <remote-path>
  "${SSH_BASE[@]}" "$VPS_TARGET" "wc -c < $(printf '%q' "$1")" 2>/dev/null | tr -d ' \r'
}
remote_sha() { # remote_sha <remote-path> — hex digest, empty when the host offers no tool
  "${SSH_BASE[@]}" "$VPS_TARGET" \
    "f=$(printf '%q' "$1"); if command -v sha256sum >/dev/null 2>&1; then sha256sum \"\$f\" | cut -d' ' -f1; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 \"\$f\" | cut -d' ' -f1; elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 \"\$f\" | awk '{print \$NF}'; fi" \
    2>/dev/null | tr -d '\r\n'
}
local_size() { wc -c < "$1" | tr -d ' '; }

stamp_epoch() { # YYYYMMDDTHHMMSSZ → epoch
  local s="$1" iso
  iso="${s:0:4}-${s:4:2}-${s:6:2}T${s:9:2}:${s:11:2}:${s:13:2}Z"
  if date -u -d "$iso" +%s >/dev/null 2>&1; then date -u -d "$iso" +%s
  else date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$iso" +%s; fi
}

[ "$DRY_RUN" = "1" ] || mkdir -p "$OFFSITE_DIR"

# --- what is the newest archive on the source? ---------------------------------
REMOTE_PATH="$("${SSH_BASE[@]}" "$VPS_TARGET" \
  "ls -1t $(printf '%q' "$VPS_BACKUP_DIR")/${PREFIX}-*.sql.gz.age 2>/dev/null | head -1" | tr -d '\r')"
[ -n "$REMOTE_PATH" ] || die "no ${PREFIX}-*.sql.gz.age on ${VPS_TARGET}:${VPS_BACKUP_DIR} — the dump job is not producing"
case "$REMOTE_PATH" in
  /*.sql.gz.age) ;;
  *) die "unexpected path from the source host (not an absolute .sql.gz.age path)";;
esac

NAME="$(basename "$REMOTE_PATH")"
[[ "$NAME" =~ ^${PREFIX}-[0-9T]+Z\.sql\.gz\.age$ ]] \
  || die "unexpected artifact name from the source host: '${NAME}'"

STAMP="$(printf '%s' "$NAME" | sed -E "s/^${PREFIX}-([0-9T]+Z)\.sql\.gz\.age\$/\1/")"
AGE_HOURS=$(( ($(date -u +%s) - $(stamp_epoch "$STAMP")) / 3600 ))
[ "$AGE_HOURS" -le "$MAX_AGE_HOURS" ] \
  || die "the newest source artifact is ${AGE_HOURS}h old (> ${MAX_AGE_HOURS}h): ${NAME}"

LOCAL="$OFFSITE_DIR/$NAME"

write_heartbeat() { # write_heartbeat <state> — refreshed on every successful run
  {
    date -u +%Y-%m-%dT%H:%M:%SZ
    echo "artifact=${NAME} bytes=${REMOTE_BYTES} sha256=${REMOTE_SHA} kept=${KEPT}/${OFFSITE_KEEP} rotated=${REMOVED} state=$1"
  } > "$OFFSITE_DIR/.last-success"
  chmod 600 "$OFFSITE_DIR/.last-success" 2>/dev/null || true
}

# --- what the source claims (mandatory: both answers, before anything is promoted) ---
REMOTE_BYTES="$(remote_size "$REMOTE_PATH")"
case "$REMOTE_BYTES" in ''|*[!0-9]*) die "could not read the size of ${REMOTE_PATH} on the source host";; esac
REMOTE_SHA="$(remote_sha "$REMOTE_PATH")"
case "$REMOTE_SHA" in
  ''|*[!0-9a-f]*) die "the source host answered no sha256 for ${REMOTE_PATH} (no sha256sum/shasum/openssl?) — refusing to store an unverified copy (fail-closed)";;
esac

# --- already pulled? (size first — cheap — then the digest) --------------------
if [ -f "$LOCAL" ] && [ "$(local_size "$LOCAL")" = "$REMOTE_BYTES" ] \
   && [ "$(sha256_of "$LOCAL")" = "$REMOTE_SHA" ]; then
  KEPT="$(count_matching "$OFFSITE_DIR" "${PREFIX}-*.sql.gz.age")"
  REMOVED=0
  # The heartbeat is refreshed here too: the run succeeded and the off-host copy is
  # verified, which is what the timestamp is read for (a stale heartbeat means the
  # cron stopped, not that the source changed).
  write_heartbeat "up-to-date"
  echo "==> up to date: ${NAME} (${REMOTE_BYTES} bytes, ${AGE_HOURS}h old)"
  echo "==> heartbeat: $(head -1 "$OFFSITE_DIR/.last-success")"
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "==> would pull ${NAME} (${REMOTE_BYTES} bytes, sha256 ${REMOTE_SHA}, ${AGE_HOURS}h old) → ${LOCAL}"
  exit 0
fi

# --- pull: ciphertext only, promoted by an atomic mv ---------------------------
TMP="${LOCAL}.part"
cleanup() { rm -f "$TMP" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

"${SSH_BASE[@]}" "$VPS_TARGET" "cat $(printf '%q' "$REMOTE_PATH")" > "$TMP"

[ -s "$TMP" ] || die "empty download from the source host — nothing was written"
head -c 64 "$TMP" | grep -q 'age-encryption.org/v1' \
  || die "the downloaded file is not age ciphertext — refusing to store it (fail-closed)"
[ "$(local_size "$TMP")" = "$REMOTE_BYTES" ] \
  || die "truncated download: the source has ${REMOTE_BYTES} B, the download is $(local_size "$TMP") B — refusing to store it (fail-closed)"
[ "$(sha256_of "$TMP")" = "$REMOTE_SHA" ] \
  || die "the download's sha256 does not match the source — refusing to store it (fail-closed)"

mv -f "$TMP" "$LOCAL"
chmod 600 "$LOCAL" 2>/dev/null || true
trap - EXIT INT TERM
echo "==> pulled ${NAME} (${REMOTE_BYTES} bytes, sha256 ${REMOTE_SHA}, ${AGE_HOURS}h old)"

# --- rotation: only this contour's naming, the one-off memes-final-* stay -------
REMOVED=0
if ls -1t "$OFFSITE_DIR"/${PREFIX}-*.sql.gz.age >/dev/null 2>&1; then
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    rm -f "$old"
    REMOVED=$((REMOVED + 1))
  done <<EOF
$(ls -1t "$OFFSITE_DIR"/${PREFIX}-*.sql.gz.age | tail -n +$((OFFSITE_KEEP + 1)))
EOF
fi

KEPT="$(count_matching "$OFFSITE_DIR" "${PREFIX}-*.sql.gz.age")"

# --- manifest (same convention as the hand-made copies: SHA256SUMS.memes-bot) ---
# Written after rotation so it describes what is actually there.
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$OFFSITE_DIR" && sha256sum ./*.sql.gz.age > SHA256SUMS.memes-bot)
else
  (cd "$OFFSITE_DIR" && shasum -a 256 ./*.sql.gz.age > SHA256SUMS.memes-bot)
fi
chmod 600 "$OFFSITE_DIR/SHA256SUMS.memes-bot" 2>/dev/null || true

# --- heartbeat (TGB-113 review §M10) --------------------------------------------
# The pull fails loudly, but its only *signal* is this log: a silently stopped cron
# would age the recovery point while the CI drill keeps passing against its own
# artifact. The timestamp file is what a monitoring check (or a human) reads — and it
# is refreshed on the no-op path too, so "older than a day" really does mean the cron
# stopped. The dashboard/exporter side is SRV-215.
write_heartbeat "pulled"

echo "==> offsite copy: ${KEPT}/${OFFSITE_KEEP} kept, ${REMOVED} rotated out, dir=$(printf '%s' "$OFFSITE_DIR")"
echo "==> heartbeat: $(head -1 "$OFFSITE_DIR/.last-success")"
