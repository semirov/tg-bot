#!/usr/bin/env bash
# Build, push and deploy the memes-bot image to the target host (TGB-112).
#
# Usage: deploy.sh <version> [builtSha]
#
# The container definition is no longer passed on the command line. The stack is
# pinned in tools/deploy/docker-compose.prod.yml, which this script syncs to
# $DEPLOY_STACK_DIR on the target host and drives with `docker compose`. That matters:
# a bare `docker run` is what produced the undocumented prod this change replaces, and
# a bare recreate silently drops the caps, the second loopback publish and the
# healthcheck the cutover gate reads.
#
# All host-, path- and credential-shaped values come from DEPLOY_SECRETS_DIR (mounted
# read-only into the CI runner). Target file keys this script uses:
#   DEPLOY_HOST, DEPLOY_USER, DEPLOY_IMAGE, DEPLOY_SERVICE,
#   DEPLOY_PROJECT, DEPLOY_STACK_DIR, DEPLOY_COMPOSE_FILE, DEPLOY_ENV_FILE,
#   DEPLOY_INFRA_ENV_FILE, DEPLOY_SSH_KEY (preferred) or DEPLOY_PASSWORD,
#   optional: DEPLOY_FREEZE_MARKER, DEPLOY_LOG_WINDOW.
# DEPLOY_NETWORK and DEPLOY_CONTAINER are accepted and ignored: the compose file pins
# the network and names the containers (review m6), and the preflight reads those names
# from the rendered definition rather than from target.env.
# The target host refuses password auth, so DEPLOY_SSH_KEY is what actually works.
#
# Every value that is interpolated into an ssh argv or into a remote shell is checked
# against an allow-list first (review m1): the host by tools/ci/deploy-target-guard.sh,
# the user / service / project / version / log window below. target.env is shell code
# that has to be sourced, so write access to it already means execution — but nothing
# here should *look* like it tolerates a quote, a semicolon or a leading dash, because
# `ssh` rebuilds the remote command by joining argv with spaces.
#
# Fail-closed guards, in order — nothing docker- or ssh-shaped runs before them:
#   1. tools/ci/deploy-target-guard.sh — the target host resolves, is unambiguous, is
#      a bare address (no ssh-option or command injection) and is not on
#      tools/ci/retired-deploy-hosts.txt.
#   2. remote-preflight.sh --phase pre — on the target host: freeze marker absent, pinned
#      definition valid, every secret file (relay bot.env, infra.env and the definition's
#      bind-mount sources, e.g. redis.conf with its requirepass) not group/world readable,
#      the external network present, no container of the bot image outside the pinned
#      service, restart policy as pinned, publishes loopback-only, dependencies running.
#   3. remote-preflight.sh --phase post — after the recreate: the running image is the one
#      requested, exactly one container of that image on the host, health == healthy, no
#      getUpdates conflict, Nest start line present.
# IMPORTANT: the conflict counter is not the space-separated `409 Conflict` (which the app
# never emits — grammy formats `` `${message} (${error_code}: ${description})` ``, so the
# line reads "(409: Conflict: terminated by other getUpdates request…)", review B1). It
# matches grammY's shape and the bare description; see CONFLICT_PATTERN in the preflight.
#   ANY failure — including `docker compose up` itself — rolls the image back to the
#   previous tag and re-runs the same gate (review M1). If no previous image is known
#   (first start) there is nothing to roll back to and the run exits non-zero, loudly.
#
# What the guards can and cannot prove about "one live instance" — read this before
# trusting a green run:
#   CAN: no deploy targets a retired host; nothing on the target host runs this image
#   outside the pinned service; the recreated container is the requested version,
#   healthy, and did not lose a getUpdates race in the window (Telegram answers 409 to
#   the loser, so a non-zero count is real evidence of a second poller — read from the
#   real log shape, see above).
#   CANNOT: that no poller runs on any other machine, and that the MTProto
#   user-account session is not live elsewhere. There is no process-level signal for
#   either — a container-name/pgrep check on one host says nothing about another, and
#   the session is a Postgres row (ClientSessionEntity.isActive), not a file. The
#   evidence for those is the freeze marker + `restart=no` + stopped containers on the
#   giving host, and `isActive` being false before the new instance starts (TGB-112
#   security review A1; TRL-DOC-323 invariants I1-I3).
set -euo pipefail

export DOCKER_BUILDKIT=1

VERSION="${1:?usage: deploy.sh <version> [builtSha]}"
BUILT_SHA="${2:-}"
SECRETS_DIR="${DEPLOY_SECRETS_DIR:-/deploy-secrets}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_SRC="$REPO_ROOT/tools/deploy/docker-compose.prod.yml"
PREFLIGHT_SRC="$REPO_ROOT/tools/deploy/remote-preflight.sh"

# --- 1. target guard: refuse before anything docker- or ssh-shaped runs ----------
bash "$REPO_ROOT/tools/ci/deploy-target-guard.sh" "$SECRETS_DIR/target.env"

# shellcheck disable=SC1091
source "$SECRETS_DIR/target.env"

: "${DEPLOY_HOST:?}"; : "${DEPLOY_USER:?}"; : "${DEPLOY_IMAGE:?}"
: "${DEPLOY_SERVICE:?}"; : "${DEPLOY_PROJECT:?}"
: "${DEPLOY_STACK_DIR:?}"; : "${DEPLOY_COMPOSE_FILE:?}"
: "${DEPLOY_ENV_FILE:?}"; : "${DEPLOY_INFRA_ENV_FILE:?}"

# Allow-lists for everything that ends up in an ssh argv or a remote shell (review m1).
# A leading '-' is refused explicitly: OpenSSH would read `user` as an option.
check_token() { # check_token <name> <value>
  case "$2" in
    '') echo "!! $1 is empty" >&2; exit 1 ;;
    -*|*[!A-Za-z0-9._-]*) echo "!! $1 may contain only letters, digits, dot, underscore and dash and must not start with a dash: refused" >&2; exit 1 ;;
  esac
}
check_token DEPLOY_USER "$DEPLOY_USER"
check_token DEPLOY_SERVICE "$DEPLOY_SERVICE"
check_token DEPLOY_PROJECT "$DEPLOY_PROJECT"
check_token VERSION "$VERSION"
case "${DEPLOY_CONTAINER:-}" in
  ''|*[!A-Za-z0-9._-]*) [ -z "${DEPLOY_CONTAINER:-}" ] || { echo "!! DEPLOY_CONTAINER may contain only letters, digits, dot, underscore and dash: refused" >&2; exit 1; } ;;
esac

[ -f "$COMPOSE_SRC" ] || { echo "!! missing pinned stack definition: $COMPOSE_SRC" >&2; exit 1; }
[ -f "$PREFLIGHT_SRC" ] || { echo "!! missing preflight: $PREFLIGHT_SRC" >&2; exit 1; }

# These paths reach a remote shell; keep them boring and absolute.
for p in "$DEPLOY_STACK_DIR" "$DEPLOY_COMPOSE_FILE" "$DEPLOY_ENV_FILE" "$DEPLOY_INFRA_ENV_FILE" \
         "${DEPLOY_FREEZE_MARKER:-$DEPLOY_STACK_DIR/.frozen}"; do
  case "$p" in
    /*) ;;
    *) echo "!! not an absolute path: $p" >&2; exit 1 ;;
  esac
  case "$p" in
    *[!A-Za-z0-9._/-]*) echo "!! refusing a path with unusual characters: $p" >&2; exit 1 ;;
  esac
done
LOG_WINDOW="${DEPLOY_LOG_WINDOW:-15m}"
# `docker logs --since` accepts a duration like 15m / 1h / 900s; nothing else, and a
# loose pattern would let `10m; id` through into the remote shell (review m1).
if ! [[ "$LOG_WINDOW" =~ ^[0-9]{1,4}[smhd]$ ]]; then
  echo "!! DEPLOY_LOG_WINDOW must be a duration like 15m / 1h / 900s (got ${#LOG_WINDOW} chars): refused" >&2
  exit 1
fi

# shellcheck source=/dev/null
source tools/ci/docker-config.sh

echo "==> Base image with dependencies"
DEPS_IMAGE="$(bash tools/ci/build-base.sh 20 | tail -1)"
echo "    $DEPS_IMAGE"

# The prod image is already built and pushed by the test job (tag sha-<commit>):
# reuse it instead of rebuilding webpack inside the deploy.
IMAGE_SHA="${DEPLOY_IMAGE}:sha-${BUILT_SHA}"
if [ -n "$BUILT_SHA" ] && docker pull "$IMAGE_SHA" >/dev/null 2>&1; then
  echo "==> Using the CI image: $IMAGE_SHA"
  docker tag "$IMAGE_SHA" "${DEPLOY_IMAGE}:${VERSION}"
else
  echo "==> sha-${BUILT_SHA:-?} not found — building ${DEPLOY_IMAGE}:${VERSION} (linux/amd64)"
  docker build --platform linux/amd64 \
    --build-arg DEPS_IMAGE="$DEPS_IMAGE" \
    -f apps/memes-bot/Dockerfile \
    -t "${DEPLOY_IMAGE}:${VERSION}" .
fi

echo "==> Pushing image ${VERSION}"
docker push "${DEPLOY_IMAGE}:${VERSION}"

# Transport to the server: a key when one is configured, otherwise a password through
# askpass. ServerAlive*: SSH to the prod VPS drops on idle (TRL-425) — keep the
# connection alive across a long remote script (pull/run/sleep/logs).
SSH_BASE=(ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=30 -o TCPKeepAlive=yes)
if [ -n "${DEPLOY_SSH_KEY:-}" ]; then
  SSH_BASE+=(-i "$DEPLOY_SSH_KEY")
  ssh_cmd() { "${SSH_BASE[@]}" "${DEPLOY_USER}@${DEPLOY_HOST}" "$@"; }
else
  echo "!! DEPLOY_SSH_KEY is not set — falling back to password auth. The target host" >&2
  echo "!! runs key-only SSH (PasswordAuthentication no); set the key in target.env." >&2
  ASKPASS="$(mktemp)"
  printf '#!/bin/sh\nprintf "%%s\\n" "$DEPLOY_PASSWORD"\n' > "$ASKPASS"
  chmod +x "$ASKPASS"
  trap 'rm -f "$ASKPASS"' EXIT
  export DEPLOY_PASSWORD
  export SSH_ASKPASS="$ASKPASS"
  export SSH_ASKPASS_REQUIRE=force
  # OpenSSH < 8.4 (for example the runner image's 8.2) does not understand
  # SSH_ASKPASS_REQUIRE and only starts askpass without a tty and with DISPLAY set.
  export DISPLAY="${DISPLAY:-:0}"
  ssh_cmd() { setsid -w "${SSH_BASE[@]}" -o PreferredAuthentications=password "${DEPLOY_USER}@${DEPLOY_HOST}" "$@"; }
fi

# tag_of <image ref> — the tag, or nothing when the reference has none (a registry
# with a port or an @digest). APP_VERSION degrades to "unknown"; it is informational,
# while the image reference itself is required by the compose file.
tag_of() {
  case "${1##*:}" in
    */*) printf '' ;;
    *) printf '%s' "${1##*:}" ;;
  esac
}

# Sync the pinned stack definition to the host. The host copy is not the source of
# truth: overwriting it on every deploy is what makes "what runs" equal "what the repo
# pins" instead of "whatever was hand-edited last".
sync_stack_definition() {
  echo "==> Pinning the stack definition: $COMPOSE_SRC -> ${DEPLOY_HOST}:${DEPLOY_COMPOSE_FILE}"
  ssh_cmd "umask 077; install -d -m 700 '${DEPLOY_STACK_DIR}' && cat > '${DEPLOY_COMPOSE_FILE}.new' \
    && chmod 600 '${DEPLOY_COMPOSE_FILE}.new' && mv -f '${DEPLOY_COMPOSE_FILE}.new' '${DEPLOY_COMPOSE_FILE}'" \
    < "$COMPOSE_SRC"
}

# Record which image is deployed, so a manual `docker compose up -d` on the host does
# not silently roll prod back to whatever tag the file was last edited with.
record_deployed_image() {
  local ref="$1" ver="$2"
  if [ -n "$ver" ]; then
    printf 'MEMES_BOT_IMAGE=%s\nMEMES_BOT_VERSION=%s\n' "$ref" "$ver"
  else
    printf 'MEMES_BOT_IMAGE=%s\n' "$ref"
  fi | ssh_cmd "umask 077; cat > '${DEPLOY_STACK_DIR}/.env.new' && chmod 600 '${DEPLOY_STACK_DIR}/.env.new' \
        && mv -f '${DEPLOY_STACK_DIR}/.env.new' '${DEPLOY_STACK_DIR}/.env'"
}

PREFLIGHT_ARGS=(--image "$DEPLOY_IMAGE" --stack-dir "$DEPLOY_STACK_DIR"
  --compose-file "$DEPLOY_COMPOSE_FILE" --env-file "$DEPLOY_ENV_FILE"
  --infra-env-file "$DEPLOY_INFRA_ENV_FILE" --marker "${DEPLOY_FREEZE_MARKER:-$DEPLOY_STACK_DIR/.frozen}"
  --project "$DEPLOY_PROJECT" --service "$DEPLOY_SERVICE" --log-window "$LOG_WINDOW")

run_preflight() { ssh_cmd bash -s -- --phase "$1" "${PREFLIGHT_ARGS[@]}" < "$PREFLIGHT_SRC"; }

# Remember the tag to come back to before anything is recreated (the old script kept a
# `-prev` container alive for this; a stopped container is drift, a version pointer is
# not). If it is missing locally the rollback pulls it — the registry is the source of
# truth, not the disk.
PREV_REF="$(ssh_cmd "docker inspect --format '{{.Config.Image}}' '${DEPLOY_SERVICE}' 2>/dev/null || true" | tr -d '\r\n')"

sync_stack_definition

# On a host where nothing of this stack runs yet the compose file cannot even render
# (the image pointer is required), and there is no running image to regress — so seed
# the pointer now. Every later deploy writes it only after the post gate passes.
if [ -z "$PREV_REF" ]; then
  echo "==> First start on ${DEPLOY_HOST}: seeding the image pointer"
  record_deployed_image "${DEPLOY_IMAGE}:${VERSION}" "$VERSION"
fi

echo "==> Preflight (pre) on ${DEPLOY_HOST}"
if ! run_preflight pre; then
  echo "!! preflight refused the deploy to ${DEPLOY_HOST} — nothing was recreated" >&2
  exit 1
fi

# Roll back to the image that was running before this deploy, then re-run the same gate.
# Called from every failure path — including a failed recreate, which used to abort the
# script under `set -e` and leave the container stopped with no rollback at all
# (review M1: the header promised a rollback the code did not perform).
rollback_to_prev() {
  echo "!! rolling ${DEPLOY_SERVICE} back to ${PREV_REF:-<unknown>} on ${DEPLOY_HOST}" >&2
  if [ -z "$PREV_REF" ]; then
    echo "!! no previous image is known (first start?) — there is nothing to roll back to" >&2
    return 1
  fi
  if ! ssh_cmd bash -s <<REMOTE
set -euo pipefail
cd '${DEPLOY_STACK_DIR}'
docker image inspect '${PREV_REF}' >/dev/null 2>&1 || docker pull '${PREV_REF}' >/dev/null
MEMES_BOT_IMAGE='${PREV_REF}' MEMES_BOT_VERSION='$(tag_of "$PREV_REF")' \
  docker compose -p '${DEPLOY_PROJECT}' -f '${DEPLOY_COMPOSE_FILE}' up -d --no-deps '${DEPLOY_SERVICE}'
REMOTE
  then
    echo "!! the rollback recreate itself failed — prod needs a human, now" >&2
    return 1
  fi
  record_deployed_image "$PREV_REF" "$(tag_of "$PREV_REF")" || true
  if run_preflight post; then
    echo "==> rollback to ${PREV_REF} is healthy" >&2
    return 0
  fi
  echo "!! the rollback did not confirm healthy — prod needs a human, now" >&2
  return 1
}

echo "==> Deploying ${VERSION} (${DEPLOY_SERVICE}) on ${DEPLOY_HOST}"
UP_FAILED=0
if ! ssh_cmd bash -s <<REMOTE
set -euo pipefail
cd '${DEPLOY_STACK_DIR}'
docker pull '${DEPLOY_IMAGE}:${VERSION}' >/dev/null
MEMES_BOT_IMAGE='${DEPLOY_IMAGE}:${VERSION}' MEMES_BOT_VERSION='${VERSION}' \
  docker compose -p '${DEPLOY_PROJECT}' -f '${DEPLOY_COMPOSE_FILE}' up -d --no-deps '${DEPLOY_SERVICE}'
docker compose -p '${DEPLOY_PROJECT}' -f '${DEPLOY_COMPOSE_FILE}' ps --format '{{.Name}} | {{.Image}} | {{.Status}}' || true
REMOTE
then
  UP_FAILED=1
  echo "!! the recreate failed on ${DEPLOY_HOST} — the container may be down; rolling back" >&2
fi

# The request went out; check that what is running is what was asked for. A compose run
# against a stale image pointer would otherwise pass the health gate and silently
# deploy nothing.
RUNNING_REF=""
if [ "$UP_FAILED" -eq 0 ]; then
  RUNNING_REF="$(ssh_cmd "docker inspect --format '{{.Config.Image}}' '${DEPLOY_SERVICE}' 2>/dev/null || true" | tr -d '\r\n')"
  case "$RUNNING_REF" in
    *":${VERSION}") echo "    running image: ${RUNNING_REF}" ;;
    *) echo "!! ${DEPLOY_SERVICE} runs '${RUNNING_REF:-<nothing>}', not ${DEPLOY_IMAGE}:${VERSION}" >&2
       RUNNING_REF="" ;;
  esac
fi

if [ "$UP_FAILED" -eq 0 ] && [ -n "$RUNNING_REF" ]; then
  echo "==> Preflight (post) on ${DEPLOY_HOST}"
fi
if [ "$UP_FAILED" -eq 0 ] && [ -n "$RUNNING_REF" ] && run_preflight post; then
  # Only now: the pointer must never advertise an image that has not passed the gate.
  record_deployed_image "${DEPLOY_IMAGE}:${VERSION}" "$VERSION"
  echo "==> Deploy ${VERSION} confirmed healthy"
else
  rollback_to_prev || true
  exit 1
fi

# The server has little disk: old image tags pile up and can fill the partition. Prune
# images older than 72 hours (the current and previous release stay, and a rollback
# pulls its tag again if it is gone).
echo "==> Pruning old images"
ssh_cmd "docker image prune -af --filter 'until=72h' | tail -2; df -h / | tail -1"
