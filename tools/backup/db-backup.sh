#!/usr/bin/env bash
# Memes-bot DB backup, CI side (TGB-113): snapshot the database on the production
# host, pull the ciphertext to the CI node and verify that what we are about to
# publish really is age ciphertext.
#
# The dump is encrypted at the source (tools/backup/remote-dump.sh) and the plaintext
# never leaves the host, so this side never holds a key and cannot decrypt what it
# publishes. The check here is fail-closed in the other direction: if a `.sql.gz`
# (plaintext) arrives, the run fails and nothing is published.
#
# SSH resilience follows the deploy path (TGB-112 / TRL-148): keepalive on the long
# CI↔host channel, a retried snapshot phase, and a streamed `ssh … cat` download into
# `<local>.part` that is only promoted by an atomic `mv` once the age magic is there
# (a truncated transfer can never be published as a "successful" backup).
#
# Usage: db-backup.sh [outDir]
# Credentials come from $DEPLOY_SECRETS_DIR/target.env — the same file the deploy
# reads (DEPLOY_HOST, DEPLOY_USER, DEPLOY_SSH_KEY, DEPLOY_STACK_DIR, …). They are
# mounted read-only into the self-hosted runner, so this run needs no GitHub secret.
# Tuning: BACKUP_NET_RETRIES (3), BACKUP_NET_BACKOFF ("5 15 30"), BACKUP_KEEP (3),
#         BACKUP_CONTAINER (memes-postgres).
#
# Test: tools/backup/db-backup.test.sh.
set -euo pipefail

SECRETS_DIR="${DEPLOY_SECRETS_DIR:-/deploy-secrets}"
TARGET_FILE="$SECRETS_DIR/target.env"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Same guard as the deploy: a stale or hand-edited target file must not be able to
# point the backup at a host that was retired (TGB-112 moved prod off 38.180.69.206).
bash "$ROOT/tools/ci/deploy-target-guard.sh" "$TARGET_FILE"

# shellcheck disable=SC1090
source "$TARGET_FILE"

: "${DEPLOY_HOST:?}"; : "${DEPLOY_USER:?}"; : "${DEPLOY_STACK_DIR:?}"
# Key-only host: a password fallback would need a secret this job has no business
# reading, so require the key explicitly.
: "${DEPLOY_SSH_KEY:?DEPLOY_SSH_KEY is not set in $TARGET_FILE — cannot reach the host}"
if [ ! -r "$DEPLOY_SSH_KEY" ]; then
  # The path in target.env is the runner's (mounted) one. Running this by hand on
  # another node means ssh falls back to the agent's key — say so instead of leaving
  # the operator with an unexplained "identity file not accessible" warning.
  echo "    note: no readable key at the configured path — ssh will use the agent's key"
fi

OUT_DIR="${1:-$ROOT/backups}"
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR" 2>/dev/null || true

# The only way a value reaches a remote command (same discipline as deploy.sh).
qq() { printf '%q' "$1"; }

SSH_COMMON=(
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=6
  -o TCPKeepAlive=yes
  -o ConnectTimeout=15
  -o StrictHostKeyChecking=accept-new
  -o BatchMode=yes
)
SSH_BASE=(ssh -i "$DEPLOY_SSH_KEY" "${SSH_COMMON[@]}")
TARGET="${DEPLOY_USER}@${DEPLOY_HOST}"

NET_RETRIES="${BACKUP_NET_RETRIES:-3}"
NET_BACKOFFS="${BACKUP_NET_BACKOFF:-5 15 30}"
PREFIX="memes-bot-db"
AGE_MAGIC='age-encryption.org/v1'

is_age_file() { [ -s "$1" ] && head -c 64 "$1" | grep -q "$AGE_MAGIC"; }
# First two bytes of gzip (1f 8b): a plaintext dump, reported as such instead of a
# vague "not age".
is_gzip_file() { [ "$(head -c 2 "$1" 2>/dev/null | od -An -tx1 | tr -d ' \n')" = "1f8b" ]; }

net_backoff() { # delay for attempt N (the last value is the ceiling)
  local i=1 last=30
  for d in $NET_BACKOFFS; do
    last="$d"
    if [ "$i" -eq "$1" ]; then printf '%s' "$d"; return 0; fi
    i=$((i + 1))
  done
  printf '%s' "$last"
}

# Phase 1 — snapshot on the host. remote-dump.sh prints the absolute path of the
# fresh archive as its last line. Idempotent (a new STAMP per attempt), so a dropped
# connection is retried safely.
snapshot_remote() {
  local attempt=1 rc out delay
  while :; do
    rc=0
    out="$(
      "${SSH_BASE[@]}" "$TARGET" \
        "DEPLOY_DIR=$(qq "$DEPLOY_STACK_DIR") BACKUP_KEEP=$(qq "${BACKUP_KEEP:-3}") BACKUP_CONTAINER=$(qq "${BACKUP_CONTAINER:-memes-postgres}") bash -s" \
        < "$ROOT/tools/backup/remote-dump.sh" | tail -1
    )" || rc=$?
    if [ "$rc" -eq 0 ] && [[ "$out" == /*.sql.gz.age ]]; then
      printf '%s' "$out"; return 0
    fi
    if [ "$attempt" -ge "$NET_RETRIES" ]; then
      echo "!! snapshot on ${DEPLOY_HOST}: failed after ${NET_RETRIES} attempts (rc=${rc})" >&2
      return 1
    fi
    delay="$(net_backoff "$attempt")"
    echo "    retrying snapshot $((attempt + 1))/${NET_RETRIES} in ${delay}s" >&2
    attempt=$((attempt + 1))
    sleep "$delay"
  done
}

# Phase 2 — download. Streamed `ssh … cat` rather than scp: the same keepalive channel,
# a broken transfer is a non-zero ssh exit, and the partial file stays in `.part`.
fetch_dump() {
  local remote="$1" local_final="$2" tmp="${2}.part"
  local attempt=1 rc reason delay

  while :; do
    rc=0; reason=""
    rm -f "$tmp"
    if ! "${SSH_BASE[@]}" "$TARGET" "cat $(qq "$remote")" > "$tmp"; then
      rc=1; reason="ssh channel dropped"
    elif [ ! -s "$tmp" ]; then
      rc=1; reason="empty file"
    elif is_age_file "$tmp"; then
      :
    elif is_gzip_file "$tmp"; then
      rc=1; reason="PLAINTEXT (gzip) instead of age ciphertext (fail-closed)"
    else
      rc=1; reason="not age ciphertext (partial or corrupt download)"
    fi
    if [ "$rc" -eq 0 ]; then
      mv -f "$tmp" "$local_final"
      return 0
    fi
    rm -f "$tmp"
    if [ "$attempt" -ge "$NET_RETRIES" ]; then
      echo "!! download: failed after ${NET_RETRIES} attempts (${reason})" >&2
      return 1
    fi
    delay="$(net_backoff "$attempt")"
    echo "    retrying download $((attempt + 1))/${NET_RETRIES} (${reason}) in ${delay}s" >&2
    attempt=$((attempt + 1))
    sleep "$delay"
  done
}

echo "==> Snapshotting the database on ${DEPLOY_HOST}"
REMOTE_PATH="$(snapshot_remote)" || {
  echo "!! could not snapshot ${DEPLOY_HOST}: no off-site backup was created" >&2
  exit 1
}
echo "    $REMOTE_PATH"

# The remote naming is part of the contract (remote-dump.sh). Anything else is not ours.
LOCAL_NAME="$(basename "$REMOTE_PATH")"
if [[ ! "$LOCAL_NAME" =~ ^${PREFIX}-[0-9TZ]+\.sql\.gz\.age$ ]]; then
  echo "!! unexpected archive name from ${DEPLOY_HOST}: '${LOCAL_NAME}'" >&2
  exit 1
fi
LOCAL="$OUT_DIR/$LOCAL_NAME"

echo "==> Downloading the archive → ${LOCAL}"
if ! fetch_dump "$REMOTE_PATH" "$LOCAL"; then
  echo "!! could not download from ${DEPLOY_HOST}: no off-site backup was created" >&2
  echo "    (the archive is intact on the host: ${REMOTE_PATH})" >&2
  exit 1
fi

# fetch_dump already checked, but the file is what the artifact upload will pick up —
# check the published file once more (a race or a bad mv must not slip through).
if ! is_age_file "$LOCAL"; then
  if is_gzip_file "$LOCAL"; then
    echo "!! the published artifact is PLAINTEXT (gzip), not age ciphertext: ${LOCAL}" >&2
  else
    echo "!! the published artifact is not age ciphertext: ${LOCAL}" >&2
  fi
  exit 1
fi

chmod 600 "$LOCAL" 2>/dev/null || true
echo "==> Backup ready: $LOCAL ($(du -h "$LOCAL" | cut -f1))"
echo "$LOCAL"
