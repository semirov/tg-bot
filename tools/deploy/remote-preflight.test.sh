#!/usr/bin/env bash
# Tests for tools/deploy/remote-preflight.sh (TGB-112).
#
# Every rule gets a negative case: the preflight must BITE when the host drifts even
# slightly away from the pinned definition. `docker` is replaced by a scenario-driven
# stub, so the whole matrix runs offline, with no host and no container.
#
# Run: bash tools/deploy/remote-preflight.test.sh
# bash 3.2 (macOS) compatible; runs inside the CI test image (node + node_modules
# present) or on a dev machine.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFLIGHT="$SCRIPT_DIR/remote-preflight.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/memes-preflight-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1 — $2"; FAIL=$((FAIL + 1)); }

IMAGE='cr.yandex/crp8g8jm3p8d780a8hk3/telegram-bot'
SECRET_MARKER='SECRETMARKER-dummy-value-never-printable'

# The real getUpdates-conflict line, built with the installed grammY rather than typed
# out by hand: review B1 found that the suite used to invent a spelling (`409 Conflict`)
# the producer never emits, which certified a structurally dead rule. Falls back to the
# verbatim string when grammy cannot be imported (the CI image has it; a bare host may
# not) and says so.
CONFLICT_LINE=""
node_conflict_line() {
  node -e "const {GrammyError} = require('$REPO_ROOT/node_modules/grammy/out/core/error.js');
    const e = new GrammyError(\"Call to 'getUpdates' failed!\",
      { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running' },
      'getUpdates', {});
    process.stdout.write(e.message);" 2>/dev/null
}
CONFLICT_LINE="$(node_conflict_line || true)"
if [ -n "$CONFLICT_LINE" ]; then
  echo "note: 409 fixture constructed from grammy $(node -e "process.stdout.write(require('$REPO_ROOT/node_modules/grammy/package.json').version)" 2>/dev/null)"
else
  CONFLICT_LINE="Call to 'getUpdates' failed! (409: Conflict: terminated by other getUpdates request; make sure that only one bot instance is running)"
  echo "note: grammy not importable here (no node/node_modules) — 409 fixture is the verbatim line captured from grammY 1.46.0"
fi
DESCRIPTION_LINE='Conflict: terminated by other getUpdates request; make sure that only one bot instance is running'

# --- the docker stub ----------------------------------------------------------
STUB="$WORK/bin/docker"
mkdir -p "$WORK/bin"
cat > "$STUB" <<'SH'
#!/usr/bin/env bash
# Scenario-driven `docker` stub: every file is optional and defaults to the "clean"
# value, so a test mutates exactly the one thing it is about.
S="${STUB_SCENARIO:?}"
emit() { [ -f "$S/$1" ] && cat "$S/$1"; return 0; }
rc_of() { [ -f "$S/$1" ] && cat "$S/$1" || printf '0'; }
case "${1:-}" in
  ps) emit ps ;;
  logs)
    [ "$(rc_of logs-rc)" != "0" ] && { echo "stub: log read failed" >&2; exit "$(rc_of logs-rc)"; }
    emit logs ;;
  exec) printf '%s\n' "${STUB_MTPROTO:-1}" ;;
  network)
    # $2 = inspect, $3 = name
    [ "$(rc_of network-rc)" != "0" ] && exit "$(rc_of network-rc)"
    printf '[]\n' ;;
  inspect)
    fmt=""
    shift
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --format) fmt="${2:-}"; shift 2 ;;
        *) shift ;;
      esac
    done
    case "$fmt" in
      *Mounts*) emit mounts ;;
      *RestartPolicy*) emit inspect ;;
      *) emit health ;;
    esac
    ;;
  compose)
    for a in "$@"; do
      if [ "$a" = config ]; then
        rc="$(rc_of compose-rc)"
        emit compose-rendered
        exit "$rc"
      fi
    done
    exit 0
    ;;
  version) echo "stub" ;;
  *) exit 0 ;;
esac
SH
chmod +x "$STUB"

# --- scenario scaffolding -----------------------------------------------------
STACK=""
SCEN=""

default_scenario() {
  local stack="$1" scen="$2"
  mkdir -p "$stack" "$scen"
  printf 'BOT_TOKEN=%s\nDATABASE_PASSWORD=%s\n' "$SECRET_MARKER" "$SECRET_MARKER" > "$stack/bot.env"
  printf 'POSTGRES_PASSWORD=%s\nREDIS_PASSWORD=%s\n' "$SECRET_MARKER" "$SECRET_MARKER" > "$stack/infra.env"
  printf 'requirepass %s\n' "$SECRET_MARKER" > "$stack/redis.conf"
  chmod 600 "$stack/bot.env" "$stack/infra.env" "$stack/redis.conf"
  cp "$REPO_ROOT/tools/deploy/docker-compose.prod.yml" "$stack/docker-compose.yml"

  printf 'telegram-bot|%s:0.41.4|Up 4 minutes|127.0.0.1:9464->9464/tcp, 127.0.0.1:3333->3333/tcp|memes-bot|telegram-bot\n' "$IMAGE" > "$scen/ps"
  printf 'memes-postgres|postgres:14|Up 6 minutes||memes-bot|postgres\n' >> "$scen/ps"
  printf 'memes-redis|redis:7-alpine|Up 6 minutes||memes-bot|redis\n' >> "$scen/ps"

  printf 'telegram-bot|unless-stopped|running|healthy\n' > "$scen/inspect"
  printf 'memes-postgres|unless-stopped|running|healthy\n' >> "$scen/inspect"
  printf 'memes-redis|unless-stopped|running|healthy\n' >> "$scen/inspect"

  printf 'healthy\n' > "$scen/health"
  printf '%s\n' "$stack/redis.conf" > "$scen/mounts"
  printf 'boot\nNest application successfully started\npolling\n' > "$scen/logs"
  printf '0\n' > "$scen/logs-rc"
  printf '0\n' > "$scen/compose-rc"
  printf '0\n' > "$scen/network-rc"
  {
    printf 'services:\n'
    printf '  telegram-bot:\n'
    printf '    container_name: telegram-bot\n'
    printf '    env_file:\n      - path: %s/bot.env\n        required: true\n' "$stack"
    printf '  postgres:\n    container_name: memes-postgres\n'
    printf '  redis:\n    container_name: memes-redis\n'
    printf '    volumes:\n      - type: bind\n        source: %s/redis.conf\n        target: /etc/redis/redis.conf\n' "$stack"
    printf 'networks:\n  memes-net:\n    external: true\n    name: memes-net\n'
  } > "$scen/compose-rendered"
}

# run_preflight <phase> <scenario> <stack> <outfile>
run_preflight() {
  local phase="$1" scen="$2" stack="$3" out="$4"
  env -i PATH="$WORK/bin:$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
    STUB_SCENARIO="$scen" \
    bash "$PREFLIGHT" \
      --phase "$phase" \
      --image "$IMAGE" \
      --stack-dir "$stack" \
      --compose-file "$stack/docker-compose.yml" \
      --env-file "$stack/bot.env" \
      --infra-env-file "$stack/infra.env" \
      --marker "$stack/.frozen" \
      --wait 0 --interval 0 --log-window 15m \
    >"$out" 2>&1
}

case_refused() {
  local label="$1" phase="$2" out="$WORK/out.$3"
  if run_preflight "$phase" "$SCEN" "$STACK" "$out"; then
    fail "$label" "expected non-zero exit, got 0"
  else
    pass "$label → refused"
  fi
}

case_passed() {
  local label="$1" phase="$2" out="$WORK/out.$3"
  if run_preflight "$phase" "$SCEN" "$STACK" "$out"; then
    pass "$label → accepted"
  else
    fail "$label" "$(tr '\n' '|' < "$out")"
  fi
}

scenario() { # scenario <name> — fresh stack + scenario, clean defaults
  local name="$1"
  STACK="$WORK/$name/stack"
  SCEN="$WORK/$name/scen"
  mkdir -p "$WORK/$name"
  default_scenario "$STACK" "$SCEN"
}

# --- B1: the conflict fixture itself -------------------------------------------------
# The dead spelling must match nothing on the real line, and the live pattern must match
# the wrapped grammY message and the bare description. This is the regression the review
# asked for: it can only pass against the real producer format.
DEAD_MATCHES="$(printf '%s\n' "$CONFLICT_LINE" | grep -c '409 Conflict' || true)"
LIVE_MATCHES="$(printf '%s\n' "$CONFLICT_LINE" | grep -cE '409: Conflict|Conflict: terminated by other getUpdates' || true)"
if [ "$DEAD_MATCHES" = 0 ] && [ "$LIVE_MATCHES" = 1 ]; then
  pass "the fixture is the real grammY line: '409 Conflict' matches 0, the live pattern 1"
else
  fail "409 fixture provenance" "dead=$DEAD_MATCHES live=$LIVE_MATCHES line=$(printf '%s' "$CONFLICT_LINE" | cut -c1-60)…"
fi
DESC_MATCHES="$(printf '%s\n' "$DESCRIPTION_LINE" | grep -cE '409: Conflict|Conflict: terminated by other getUpdates' || true)"
if [ "$DESC_MATCHES" = 1 ]; then
  pass "the live pattern also covers the bare description shape bot.catch logs"
else
  fail "description shape" "matches=$DESC_MATCHES"
fi

# --- PRE: positive -------------------------------------------------------------
scenario pre-clean
case_passed "pre clean host" pre 01

# --- PRE: the freeze marker ---------------------------------------------------
scenario pre-frozen
touch "$STACK/.frozen"
case_refused "pre freeze marker present" pre 02
if grep -q 'frozen' "$WORK/out.02"; then
  pass "freeze refusal names the marker"
else
  fail "freeze refusal message" "$(tr '\n' '|' < "$WORK/out.02")"
fi

scenario pre-marker-elsewhere
touch "$WORK/pre-marker-elsewhere/marker-only"
if env -i PATH="$WORK/bin:$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" STUB_SCENARIO="$SCEN" \
  bash "$PREFLIGHT" --phase pre --image "$IMAGE" --stack-dir "$STACK" \
    --compose-file "$STACK/docker-compose.yml" --env-file "$STACK/bot.env" \
    --infra-env-file "$STACK/infra.env" --marker "$WORK/pre-marker-elsewhere/marker-only" \
    --wait 0 --interval 0 >"$WORK/out.03" 2>&1; then
  fail "pre custom marker path" "expected refusal"
else
  pass "pre custom marker path honored → refused"
fi

# --- PRE: drift away from the pinned definition -------------------------------
scenario pre-stray-bot-image
printf 'telegram-bot|%s:0.41.4|Up 4 minutes|127.0.0.1:9464->9464/tcp|memes-bot|telegram-bot\n' "$IMAGE" > "$SCEN/ps"
printf 'telegram-bot-2|%s:0.41.3|Up 9 minutes|||\n' "$IMAGE" >> "$SCEN/ps"
printf 'memes-postgres|postgres:14|Up 6 minutes||memes-bot|postgres\n' >> "$SCEN/ps"
printf 'memes-redis|redis:7-alpine|Up 6 minutes||memes-bot|redis\n' >> "$SCEN/ps"
case_refused "pre second container from the bot image (stray docker run)" pre 04

# m5: the same rule with NO pinned container — this is what isolates the per-container
# rule from the aggregate BOT_ROWS <= 1 check (mutation of the rule used to stay green).
scenario pre-stray-no-pinned
printf 'telegram-bot-2|%s:0.41.3|Up 9 minutes|||\n' "$IMAGE" > "$SCEN/ps"
printf 'memes-postgres|postgres:14|Up 6 minutes||memes-bot|postgres\n' >> "$SCEN/ps"
printf 'memes-redis|redis:7-alpine|Up 6 minutes||memes-bot|redis\n' >> "$SCEN/ps"
case_refused "pre stray bot-image container with no pinned service at all" pre 05
if grep -q "runs the bot image" "$WORK/out.05"; then
  pass "the stray refusal is the per-container rule, not the aggregate count"
else
  fail "stray rule attribution" "$(tr '\n' '|' < "$WORK/out.05")"
fi

scenario pre-stray-reserved-name
printf 'memes-postgres|postgres:14|Up 1 minute||other-project|postgres\n' > "$SCEN/ps"
printf 'telegram-bot|%s:0.41.4|Up 4 minutes|127.0.0.1:9464->9464/tcp|memes-bot|telegram-bot\n' "$IMAGE" >> "$SCEN/ps"
printf 'memes-redis|redis:7-alpine|Up 6 minutes||memes-bot|redis\n' >> "$SCEN/ps"
case_refused "pre reserved container name held by another project" pre 06

scenario pre-restart-policy
printf 'telegram-bot|no|running|healthy\n' > "$SCEN/inspect"
printf 'memes-postgres|unless-stopped|running|healthy\n' >> "$SCEN/inspect"
printf 'memes-redis|unless-stopped|running|healthy\n' >> "$SCEN/inspect"
case_refused "pre restart policy no (would not survive a reboot)" pre 07

scenario pre-no-healthcheck
printf 'telegram-bot|unless-stopped|running|none\n' > "$SCEN/inspect"
printf 'memes-postgres|unless-stopped|running|healthy\n' >> "$SCEN/inspect"
printf 'memes-redis|unless-stopped|running|healthy\n' >> "$SCEN/inspect"
case_refused "pre bot container without a healthcheck (not from the pinned file)" pre 08

# --- m2: publishes are an allow-list, not a deny-list -------------------------
scenario pre-public-publish-any
printf 'memes-postgres|postgres:14|Up 6 minutes|0.0.0.0:5432->5432/tcp|memes-bot|postgres\n' > "$SCEN/ps"
printf 'telegram-bot|%s:0.41.4|Up 4 minutes|127.0.0.1:9464->9464/tcp|memes-bot|telegram-bot\n' "$IMAGE" >> "$SCEN/ps"
printf 'memes-redis|redis:7-alpine|Up 6 minutes||memes-bot|redis\n' >> "$SCEN/ps"
case_refused "pre 0.0.0.0 publish (SRV-199 class)" pre 09

scenario pre-public-publish-specific-ip
printf 'memes-postgres|postgres:14|Up 6 minutes|10.0.0.5:5432->5432/tcp|memes-bot|postgres\n' > "$SCEN/ps"
printf 'telegram-bot|%s:0.41.4|Up 4 minutes|127.0.0.1:9464->9464/tcp|memes-bot|telegram-bot\n' "$IMAGE" >> "$SCEN/ps"
printf 'memes-redis|redis:7-alpine|Up 6 minutes||memes-bot|redis\n' >> "$SCEN/ps"
case_refused "pre publish on a specific non-loopback address" pre 10

scenario pre-public-publish-loopback-alias
printf 'telegram-bot|%s:0.41.4|Up 4 minutes|127.0.0.2:9464->9464/tcp|memes-bot|telegram-bot\n' "$IMAGE" > "$SCEN/ps"
printf 'memes-postgres|postgres:14|Up 6 minutes||memes-bot|postgres\n' >> "$SCEN/ps"
printf 'memes-redis|redis:7-alpine|Up 6 minutes||memes-bot|redis\n' >> "$SCEN/ps"
case_refused "pre publish on 127.0.0.2 (not 127.0.0.1)" pre 11

scenario pre-exposed-not-published
printf 'telegram-bot|%s:0.41.4|Up 4 minutes|9464/tcp, 5353/tcp|memes-bot|telegram-bot\n' "$IMAGE" > "$SCEN/ps"
printf 'memes-postgres|postgres:14|Up 6 minutes||memes-bot|postgres\n' >> "$SCEN/ps"
printf 'memes-redis|redis:7-alpine|Up 6 minutes||memes-bot|redis\n' >> "$SCEN/ps"
case_passed "pre exposed-but-unpublished ports are fine" pre 12

# --- M2: secret files, including the definition's bind sources ----------------
scenario pre-env-mode
chmod 644 "$STACK/bot.env"
case_refused "pre group/world readable app env file" pre 13

scenario pre-infra-env-mode
chmod 640 "$STACK/infra.env"
case_refused "pre group readable infra env file" pre 14

scenario pre-env-missing
rm -f "$STACK/bot.env"
case_refused "pre app env file missing" pre 15

scenario pre-redis-conf-mode
chmod 644 "$STACK/redis.conf"
case_refused "pre redis.conf (requirepass) group/world readable" pre 16
if grep -q 'bind-mount source' "$WORK/out.16"; then
  pass "the redis.conf refusal comes from the pinned bind-mount source"
else
  fail "redis.conf rule attribution" "$(tr '\n' '|' < "$WORK/out.16")"
fi

scenario pre-bind-source-drift
# A host that hand-mounts an extra secret without the pinned mode: caught by the
# inspect-based scan, not by the definition (review M2's stronger half).
printf '%s\n' "$STACK/redis.conf" "$WORK/pre-bind-source-drift/extra.env" > "$SCEN/mounts"
printf 'TOKEN=%s\n' "$SECRET_MARKER" > "$WORK/pre-bind-source-drift/extra.env"
chmod 644 "$WORK/pre-bind-source-drift/extra.env"
case_refused "pre extra bind mount with a world-readable source" pre 17

scenario pre-redis-conf-mode-no-containers
# Isolates the definition-derived half of M2: with no container on the host the runtime
# bind-mount scan has nothing to inspect, so only the definition's own bind source can
# catch a world-readable redis.conf.
chmod 644 "$STACK/redis.conf"
: > "$SCEN/ps"
: > "$SCEN/inspect"
: > "$SCEN/mounts"
case_refused "pre world-readable redis.conf with no container to inspect" pre 18
if grep -q 'bind-mount source (definition)' "$WORK/out.18"; then
  pass "the refusal came from the definition's bind source, not from a running container"
else
  fail "definition-half attribution" "$(tr '\n' '|' < "$WORK/out.18")"
fi

# --- PRE: the pinned definition itself ----------------------------------------
scenario pre-compose-invalid
printf '1\n' > "$SCEN/compose-rc"
case_refused "pre docker compose config fails" pre 19

scenario pre-compose-missing
rm -f "$STACK/docker-compose.yml"
case_refused "pre pinned definition missing" pre 20

scenario pre-env-drift
printf 'services:\n  telegram-bot:\n    container_name: telegram-bot\n    env_file:\n      - path: /somewhere/else.env\nnetworks:\n  memes-net:\n    external: true\n    name: memes-net\n' > "$SCEN/compose-rendered"
sed -i.bak 's#env_file: \[\./bot.env\]#env_file: [./somewhere-else.env]#' "$STACK/docker-compose.yml"
rm -f "$STACK/docker-compose.yml.bak"
case_refused "pre target.env and compose file disagree on the env file" pre 21

scenario pre-env-v5-render
# compose v5 resolves env_file into environment and prints no path at all (measured on
# 185 with v5.5.1): the rule must rely on the pinned file, not on the render.
printf 'services:\n  telegram-bot:\n    container_name: telegram-bot\n    environment:\n      BOT_TOKEN: <resolved-by-compose>\nnetworks:\n  memes-net:\n    external: true\n    name: memes-net\n' > "$SCEN/compose-rendered"
case_passed "pre env-file rule works when the render carries no env_file paths (compose v5)" pre 35

# --- m4: the external network must exist --------------------------------------
scenario pre-network-missing
printf '1\n' > "$SCEN/network-rc"
case_refused "pre external network does not exist" pre 22
if grep -q 'external network' "$WORK/out.22"; then
  pass "the network refusal names the external network"
else
  fail "network refusal message" "$(tr '\n' '|' < "$WORK/out.21")"
fi

# --- PRE: dependencies --------------------------------------------------------
scenario pre-dep-exited
printf 'memes-postgres|postgres:14|Exited (0) 2 minutes ago||memes-bot|postgres\n' > "$SCEN/ps"
printf 'telegram-bot|%s:0.41.4|Up 4 minutes|127.0.0.1:9464->9464/tcp|memes-bot|telegram-bot\n' "$IMAGE" >> "$SCEN/ps"
printf 'memes-redis|redis:7-alpine|Up 6 minutes||memes-bot|redis\n' >> "$SCEN/ps"
case_refused "pre postgres not running" pre 23

scenario pre-empty-host
: > "$SCEN/ps"
: > "$SCEN/inspect"
case_refused "pre nothing of the stack exists yet" pre 24

# --- POST ---------------------------------------------------------------------
scenario post-clean
case_passed "post clean start" post 24

scenario post-two-instances
printf 'telegram-bot|%s:0.41.4|Up 1 minute|127.0.0.1:9464->9464/tcp|memes-bot|telegram-bot\n' "$IMAGE" > "$SCEN/ps"
printf 'telegram-bot-old|%s:0.41.3|Up 1 minute|||\n' "$IMAGE" >> "$SCEN/ps"
printf 'memes-postgres|postgres:14|Up 6 minutes||memes-bot|postgres\n' >> "$SCEN/ps"
printf 'memes-redis|redis:7-alpine|Up 6 minutes||memes-bot|redis\n' >> "$SCEN/ps"
case_refused "post a second container from the bot image" post 25

# --- B1: the conflict counter must fire on the real line ----------------------
scenario post-conflict-real-grammy
printf 'boot\nNest application successfully started\n%s\n' "$CONFLICT_LINE" > "$SCEN/logs"
case_refused "post real grammY getUpdates conflict line" post 26
if grep -qE 'getUpdates-conflicts=1' "$WORK/out.26"; then
  pass "the conflict counter reads 1 on the real line (was structurally 0 before the fix)"
else
  fail "conflict counter" "$(tr '\n' '|' < "$WORK/out.26")"
fi
if grep -qE '409-Conflict' "$WORK/out.26"; then
  fail "old counter label" "the dead '409-Conflict' label is still in the output"
else
  pass "the dead '409-Conflict' spelling is gone from the output"
fi

scenario post-conflict-description-only
printf 'boot\nNest application successfully started\n%s\n' "$DESCRIPTION_LINE" > "$SCEN/logs"
case_refused "post conflict logged as the bare Telegram description" post 27

scenario post-unhealthy
printf 'starting\n' > "$SCEN/health"
case_refused "post container never becomes healthy" post 28

scenario post-no-start-line
printf 'boot\npolling\n' > "$SCEN/logs"
case_refused "post Nest start line absent" post 29

scenario post-health-none
printf 'telegram-bot|unless-stopped|running|none\n' > "$SCEN/inspect"
printf 'memes-postgres|unless-stopped|running|healthy\n' >> "$SCEN/inspect"
printf 'memes-redis|unless-stopped|running|healthy\n' >> "$SCEN/inspect"
printf 'none\n' > "$SCEN/health"
case_refused "post bot container has no healthcheck" post 30

scenario post-not-running
printf 'telegram-bot|%s:0.41.4|Exited (1) 10 seconds ago||memes-bot|telegram-bot\n' "$IMAGE" > "$SCEN/ps"
printf 'memes-postgres|postgres:14|Up 6 minutes||memes-bot|postgres\n' >> "$SCEN/ps"
printf 'memes-redis|redis:7-alpine|Up 6 minutes||memes-bot|redis\n' >> "$SCEN/ps"
case_refused "post no running container from the bot image" post 31

# --- m3: an unreadable log is a violation, not a green zero -------------------
scenario post-log-unreadable
printf '1\n' > "$SCEN/logs-rc"
case_refused "post docker logs fails (counters unread)" post 32
if grep -q 'were not read' "$WORK/out.32"; then
  pass "the unreadable log is reported as unread, not as 0"
else
  fail "unreadable-log message" "$(tr '\n' '|' < "$WORK/out.32")"
fi

# --- m6: reserved names come from the definition, not from a hardcoded list ----
scenario pre-reserved-derived
printf 'services:\n  telegram-bot:\n    container_name: telegram-bot\n    env_file:\n      - path: %s/bot.env\n  postgres:\n    container_name: memes-postgres\n  redis:\n    container_name: memes-redis\nnetworks:\n  memes-net:\n    external: true\n    name: memes-net\n' "$STACK" > "$SCEN/compose-rendered"
printf 'stray-name|%s:0.41.4|Up 1 minute||other-project|telegram-bot\n' "$IMAGE" > "$SCEN/ps"
printf 'memes-postgres|postgres:14|Up 6 minutes||memes-bot|postgres\n' >> "$SCEN/ps"
printf 'memes-redis|redis:7-alpine|Up 6 minutes||memes-bot|redis\n' >> "$SCEN/ps"
case_refused "pre a name derived from the definition is caught when unlabelled" pre 33

scenario pre-reserved-empty
printf 'services:\n  telegram-bot:\n    env_file:\n      - path: %s/bot.env\nnetworks:\n  memes-net:\n    external: true\n    name: memes-net\n' "$STACK" > "$SCEN/compose-rendered"
case_refused "pre definition without container_name (cannot tell drift)" pre 34

# --- output discipline: no secret value, no log body --------------------------
LEAK=0
for f in "$WORK"/out.*; do
  [ -f "$f" ] || continue
  if grep -q "$SECRET_MARKER" "$f"; then LEAK=1; fi
done
if [ "$LEAK" -eq 0 ]; then
  pass "no secret value from bot.env/infra.env/redis.conf appears in any output"
else
  fail "output discipline" "secret marker leaked into $WORK/out.*"
fi
if grep -q 'terminated by other getUpdates request; make sure' "$WORK/out.26" 2>/dev/null; then
  fail "output discipline" "a log line (not a counter) reached the output"
else
  pass "log content is reported as counters only, never as a body"
fi
if grep -qE 'advisory: memes_bot_mtproto_connected=' "$WORK/out.24" 2>/dev/null; then
  pass "MTProto metric is reported as an advisory counter"
else
  fail "post advisory metric" "$(tr '\n' '|' < "$WORK/out.24")"
fi

echo
echo "Result: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
