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
# `<local>.part` that is promoted by an atomic `mv` only once it matches the SOURCE:
# the age magic, the byte count from `wc -c` and the sha256 (asked for with a
# sha256sum/shasum/openssl fallback; a host that answers neither is refused rather than
# verified weakly). The age magic alone is not a completeness check: it sits at the
# START of the file, so a head-intact truncation passes it while failing to decrypt
# (TGB-113 review §1: a 55 % prefix of a real artifact looked "ready"; only the weekly
# drill would have noticed). Every mismatch is a retried phase, and the run fails closed
# if it cannot be resolved.
#
# Usage: db-backup.sh [outDir]
# Credentials come from $DEPLOY_SECRETS_DIR/target.env — the same file the deploy
# reads (DEPLOY_HOST, DEPLOY_USER, DEPLOY_SSH_KEY, DEPLOY_STACK_DIR, …). They are
# mounted read-only into the self-hosted runner, so this run needs no GitHub secret.
# Tuning: BACKUP_NET_RETRIES (3), BACKUP_NET_BACKOFF ("5 15 30"), BACKUP_KEEP (3),
#         BACKUP_CONTAINER (memes-postgres),
#         BACKUP_EXPECTED_HOSTS_FILE (tools/backup/expected-hosts.txt).
#
# Test: tools/backup/db-backup.test.sh.
set -euo pipefail

SECRETS_DIR="${DEPLOY_SECRETS_DIR:-/deploy-secrets}"
TARGET_FILE="$SECRETS_DIR/target.env"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTED_HOSTS_FILE="${BACKUP_EXPECTED_HOSTS_FILE:-$ROOT/tools/backup/expected-hosts.txt}"

# ssh carries every phase below; say so here instead of three retried phases later.
command -v ssh >/dev/null 2>&1 || { echo "!! ssh is not in PATH — cannot reach the backup host" >&2; exit 1; }

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

# Positive counterpart to the deny-list: the deny-list only says which hosts are
# wrong, so a stale-but-well-formed target file could dump a *different* database and
# publish it under a memes-bot name. Nothing would be disclosed (the artifact is
# encrypted), the backup would just be mislabelled and useless for a restore. The list
# is an assertion, not a secret: moving prod means updating it, exactly like the
# deny-list. An empty list refuses instead of allowing everything.
assert_expected_host() { # assert_expected_host <host>
  local host_lc entries=0 line
  host_lc="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  [ -f "$EXPECTED_HOSTS_FILE" ] || { echo "!! expected-host list not found: ${EXPECTED_HOSTS_FILE}" >&2; return 1; }
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
    [ -n "$line" ] || continue
    entries=$((entries + 1))
    if [ "$line" = "$host_lc" ]; then
      echo "==> expected host: $1 accepted"
      return 0
    fi
  done < "$EXPECTED_HOSTS_FILE"
  [ "$entries" -gt 0 ] || { echo "!! the expected-host list has no entries — refusing (fail-closed)" >&2; return 1; }
  echo "!! DEPLOY_HOST $1 is not on the expected-host list (${EXPECTED_HOSTS_FILE}) — refusing" >&2
  return 1
}

assert_expected_host "$DEPLOY_HOST" || exit 1

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

local_size() { wc -c < "$1" | tr -d ' '; }
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
# What the source says a complete copy is. Both answers are mandatory: empty output
# fails the attempt instead of letting an unverified file through, and the digest is
# requested with a fallback chain rather than skipped when one tool is missing.
remote_size() { # remote_size <remote-path>
  "${SSH_BASE[@]}" "$TARGET" "wc -c < $(qq "$1")" 2>/dev/null | tr -d ' \r'
}
remote_sha() { # remote_sha <remote-path> — hex digest, empty when the host offers no tool
  "${SSH_BASE[@]}" "$TARGET" \
    "f=$(qq "$1"); if command -v sha256sum >/dev/null 2>&1; then sha256sum \"\$f\" | cut -d' ' -f1; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 \"\$f\" | cut -d' ' -f1; elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 \"\$f\" | awk '{print \$NF}'; fi" \
    2>/dev/null | tr -d '\r\n'
}

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
  local attempt=1 rc reason delay expected_size expected_sha

  while :; do
    rc=0; reason=""

    # What a complete copy looks like, read from the host before the payload so a
    # mismatch is judged against the source of this very attempt.
    expected_size="$(remote_size "$remote")"
    expected_sha="$(remote_sha "$remote")"

    rm -f "$tmp"
    if [ -z "$expected_size" ]; then
      rc=1; reason="could not read the source size (host unreachable, or the file is gone)"
    elif [ -z "$expected_sha" ]; then
      rc=1; reason="the host answered no sha256 (sha256sum/shasum/openssl all missing?) — refusing to publish an unverified artifact (fail-closed)"
    elif ! "${SSH_BASE[@]}" "$TARGET" "cat $(qq "$remote")" > "$tmp"; then
      rc=1; reason="ssh channel dropped"
    elif [ ! -s "$tmp" ]; then
      rc=1; reason="empty file"
    elif ! is_age_file "$tmp"; then
      if is_gzip_file "$tmp"; then
        rc=1; reason="PLAINTEXT (gzip) instead of age ciphertext (fail-closed)"
      else
        rc=1; reason="not age ciphertext (partial or corrupt download)"
      fi
    elif [ "$(local_size "$tmp")" != "$expected_size" ]; then
      rc=1; reason="truncated download: ${expected_size} B on the host, $(local_size "$tmp") B here (fail-closed)"
    elif [ "$(sha256_of "$tmp")" != "$expected_sha" ]; then
      rc=1; reason="sha256 mismatch against the host (fail-closed)"
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

# fetch_dump already checked, but this file is what the artifact upload will pick up —
# check it once more against the source (a race, a bad mv, or a rotation on the host
# between the two phases must not slip through as a "successful" backup).
PUBLISHED_RC=0
if ! is_age_file "$LOCAL"; then
  if is_gzip_file "$LOCAL"; then
    echo "!! the published artifact is PLAINTEXT (gzip), not age ciphertext: ${LOCAL}" >&2
  else
    echo "!! the published artifact is not age ciphertext: ${LOCAL}" >&2
  fi
  PUBLISHED_RC=1
else
  FINAL_SIZE="$(remote_size "$REMOTE_PATH")"
  FINAL_SHA="$(remote_sha "$REMOTE_PATH")"
  if [ -z "$FINAL_SIZE" ] || [ "$(local_size "$LOCAL")" != "$FINAL_SIZE" ]; then
    echo "!! the published artifact does not match the source (${FINAL_SIZE:-?} B on the host, $(local_size "$LOCAL") B here): ${LOCAL}" >&2
    PUBLISHED_RC=1
  elif [ -z "$FINAL_SHA" ] || [ "$(sha256_of "$LOCAL")" != "$FINAL_SHA" ]; then
    echo "!! the published artifact's sha256 is missing from the source or does not match it: ${LOCAL}" >&2
    PUBLISHED_RC=1
  fi
fi
[ "$PUBLISHED_RC" -eq 0 ] || exit 1

chmod 600 "$LOCAL" 2>/dev/null || true
echo "==> Backup ready: $LOCAL ($(du -h "$LOCAL" | cut -f1), $(local_size "$LOCAL") B, sha256 $(sha256_of "$LOCAL"))"
echo "$LOCAL"
