#!/usr/bin/env bash
# Host-side pre/post flight for the memes-bot stack (TGB-112).
#
# Runs ON the deploy target: tools/deploy/deploy.sh pipes it over ssh
# (`ssh "$DEPLOY_HOST" bash -s -- <flags>`) and it is also runnable locally against a
# stubbed `docker` — that is how tools/deploy/remote-preflight.test.sh proves every
# rule can actually fail (a check that cannot fail is not a check).
#
#   --phase pre   before any recreate: the freeze marker, the pinned definition, the
#                 mode of every secret file (the two env files AND redis.conf, which
#                 carries the requirepass) plus every bind-mount source, drift of the
#                 running containers away from that definition (a stray `docker run` of
#                 the same image is a second poller waiting to happen), restart policy,
#                 publish bindings (allow-list: loopback only), the external network, and
#                 the dependencies without which the bot only crash-loops.
#   --phase post  after the recreate: exactly one container of the bot image on this
#                 host, health == healthy (bounded wait), a getUpdates-conflict counter of
#                 0, the Nest start line present.
#
# The conflict counter reads grammY's own error shape, not a hand-written spelling:
# grammy 1.46.0 builds every `GrammyError` as `${message} (${error_code}: ${description})`
# (node_modules/grammy/out/core/error.js:26), so a lost getUpdates race appears as
#   Call to 'getUpdates' failed! (409: Conflict: terminated by other getUpdates request…
# and `bot.catch` (apps/memes-bot/.../bot.provider.ts) logs both that message and the bare
# description. CONFLICT_PATTERN below matches those two shapes and nothing else. The
# space-separated spelling `409 Conflict` does not occur in the app's output and must not
# come back: review B1 found it made this rule structurally green exactly where the
# single-poller invariant matters.
#
# What this script can and cannot prove about "one live instance" (TGB-112):
#   CAN — nothing on this host runs the bot image outside the pinned service; the
#   recreated container is healthy; it did not lose a getUpdates race in the window
#   (Telegram answers 409 to the loser, so a non-zero count is real evidence of a
#   second poller) — read from the real log shape, see CONFLICT_PATTERN below.
#   CANNOT — that no poller runs on another host, and that the MTProto user-account
#   session is not live elsewhere. No process-level signal exists for either: the
#   session is a Postgres row (ClientSessionEntity.isActive), not a file, and a
#   container-name/pgrep check on this host says nothing about any other machine. The
#   evidence for those lives in the freeze marker + stopped containers on the giving
#   host and in that row being false before this instance starts.
#
# Output policy: names, counters, statuses, modes — never a value from an env file, a
# log body, an argv or a DB row (TRL-327). One line per violated rule.
set -uo pipefail

PHASE=pre
MARKER=/opt/memes-bot/.frozen
STACK_DIR=/opt/memes-bot
COMPOSE_FILE=""
ENV_FILE=""
INFRA_ENV_FILE=""
PROJECT=memes-bot
SERVICE=telegram-bot
IMAGE=""
# Empty means "derive the pinned container names from the rendered compose file" — the
# definition is the source of truth, not this script (review m6). --reserved overrides.
RESERVED=""
RENDERED=""
WAIT=180
INTERVAL=5
LOG_WINDOW=15m

usage() {
  cat <<'USAGE'
usage: remote-preflight.sh --phase pre|post --image <repo> [options]
  --phase pre|post        which half of the deploy to assert (default: pre)
  --image <repo>          bot image repository without a tag (required)
  --stack-dir <dir>       stack directory on this host (default /opt/memes-bot)
  --compose-file <path>   pinned definition (default <stack-dir>/docker-compose.yml)
  --env-file <path>       app secret file (default <stack-dir>/bot.env)
  --infra-env-file <path> infra secret file (default <stack-dir>/infra.env)
  --marker <path>         freeze marker (default <stack-dir>/.frozen)
  --project <name>        compose project (default memes-bot)
  --service <name>        bot service/container (default telegram-bot)
  --reserved <list>       container names belonging to this stack (default: derived from
                          the rendered compose file)
  --wait <seconds>        post: budget for health to become healthy (default 180)
  --interval <seconds>    post: poll interval, 0 = single check (default 5)
  --log-window <dur>      post: docker logs --since window (default 15m)
Exits 0 when every rule holds, 1 otherwise (all violations are reported).
USAGE
}

while [ "$#" -gt 0 ]; do  case "$1" in
    --phase) PHASE="${2:-}"; shift 2 ;;
    --image) IMAGE="${2:-}"; shift 2 ;;
    --stack-dir) STACK_DIR="${2:-}"; shift 2 ;;
    --compose-file) COMPOSE_FILE="${2:-}"; shift 2 ;;
    --env-file) ENV_FILE="${2:-}"; shift 2 ;;
    --infra-env-file) INFRA_ENV_FILE="${2:-}"; shift 2 ;;
    --marker) MARKER="${2:-}"; shift 2 ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    --service) SERVICE="${2:-}"; shift 2 ;;
    --reserved) RESERVED="${2:-}"; shift 2 ;;
    --wait) WAIT="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-}"; shift 2 ;;
    --log-window) LOG_WINDOW="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "!! remote-preflight: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ "$PHASE" = pre ] || [ "$PHASE" = post ] || { echo "!! remote-preflight: --phase must be pre or post" >&2; exit 2; }
[ -n "$IMAGE" ] || { echo "!! remote-preflight: --image is required" >&2; exit 2; }
[ -n "$COMPOSE_FILE" ] || COMPOSE_FILE="$STACK_DIR/docker-compose.yml"
[ -n "$ENV_FILE" ] || ENV_FILE="$STACK_DIR/bot.env"
[ -n "$INFRA_ENV_FILE" ] || INFRA_ENV_FILE="$STACK_DIR/infra.env"
[ -n "$MARKER" ] || MARKER="$STACK_DIR/.frozen"
: "$PROJECT"; : "$SERVICE"; : "${RESERVED:-}"; : "$WAIT"; : "$INTERVAL"; : "$LOG_WINDOW"

VIOLATIONS=0
fail() { echo "!! preflight(${PHASE}): $1" >&2; VIOLATIONS=$((VIOLATIONS + 1)); }
note() { echo "   $1"; }

# Field separator for docker's format strings. A tab cannot be used: it is IFS
# whitespace, so bash collapses runs of it and an empty field (a container with no
# published ports) would silently shift every later field.
SEP='|'

# grammY's GrammyError message and the bare Telegram description, as the app logs them.
# Constructor form verified against the installed grammy 1.46.0 in the test suite.
CONFLICT_PATTERN='409: Conflict|Conflict: terminated by other getUpdates'

# repo_of <image> — the repository part, tolerating registries with a port.
repo_of() {
  case "${1##*:}" in
    */*) printf '%s' "$1" ;;
    *) printf '%s' "${1%:*}" ;;
  esac
}

mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }

# check_secret <path> <label> — must exist and carry no group/world permission bits.
# Works for files and for a bind-mounted directory: this asserts *privacy*, so a future
# directory mount with a 700 mode is fine and one with 755 is not.
check_secret() {
  local f="$1" label="$2" m group other
  if [ ! -e "$f" ]; then
    fail "$label missing: $f"
    return
  fi
  m="$(mode_of "$f")" || { fail "$label mode could not be read: $f"; return; }
  case "$m" in
    [0-7][0-7][0-7]) ;;
    *) fail "$label has an unexpected mode ($m): $f"; return ;;
  esac
  group="$(printf '%s' "$m" | cut -c2)"
  other="$(printf '%s' "$m" | cut -c3)"
  if [ "$group" != 0 ] || [ "$other" != 0 ]; then
    fail "$label is group/world accessible (mode $m): $f"
  fi
}

dc() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }

# inspect_field <name> <template> — one container, one field.
inspect_field() {
  docker inspect --format "$2" "$1" 2>/dev/null || true
}

#===============================================================================
# Roster: one call, everything the drift and binding rules need.
#===============================================================================
roster() {
  docker ps -a --format "{{.Names}}${SEP}{{.Image}}${SEP}{{.Status}}${SEP}{{.Ports}}${SEP}{{.Label \"com.docker.compose.project\"}}${SEP}{{.Label \"com.docker.compose.service\"}}" 2>/dev/null || true
}

BOT_ROWS=0
BOT_RUNNING=0
STACK_NAMES=""
DEP_STOPPED=""

scan_roster() {
  local name image status ports proj service repo is_stack
  while IFS="$SEP" read -r name image status ports proj service; do
    [ -n "$name" ] || continue
    repo="$(repo_of "$image")"
    is_stack=0
    [ "$proj" = "$PROJECT" ] && is_stack=1
    case " $RESERVED " in *" $name "*) is_stack=1 ;; esac
    if [ "$repo" = "$IMAGE" ]; then
      is_stack=1
      # The single-instance rule that is actually falsifiable on this host.
      if [ "$name" != "$SERVICE" ]; then
        fail "container '$name' runs the bot image ($repo) outside the pinned service '$SERVICE' — that is the second poller this deploy must never create"
      fi
      BOT_ROWS=$((BOT_ROWS + 1))
      case "$status" in Up*) BOT_RUNNING=$((BOT_RUNNING + 1)) ;; esac
    fi
    [ "$is_stack" -eq 1 ] || continue
    if [ "$proj" != "$PROJECT" ]; then
      fail "container '$name' holds a reserved name but is not part of compose project '$PROJECT' (project='${proj:-<none>}') — drift"
    fi
    case " $STACK_NAMES " in
      *" $name "*) ;;
      *) STACK_NAMES="$STACK_NAMES $name" ;;
    esac
    check_publishes "$name" "$ports"
    # Dependencies the bot needs before it can do anything but crash-loop.
    case "$service" in
      postgres|redis)
        case "$status" in
          Up*) ;;
          *) DEP_STOPPED="$DEP_STOPPED $service" ;;
        esac
        ;;
    esac
  done <<EOF
$(roster)
EOF
}

# check_publishes <container> <docker ps ports column> — allow-list, not a deny-list:
# every publish must be bound to 127.0.0.1. `0.0.0.0:5432->5432/tcp`, `[::]:5432->…`,
# `10.0.0.5:5432->…` and `127.0.0.2:…` are all refused (SRV-199 class); a bare exposed
# port (`5353/tcp`, no publish) is fine (review m2).
check_publishes() {
  local name="$1" ports="$2" entry host
  [ -n "$ports" ] || return
  while IFS= read -r entry; do
    entry="$(printf '%s' "$entry" | tr -d ' ')"
    [ -n "$entry" ] || continue
    case "$entry" in
      *"->"*) ;;
      *) continue ;;   # exposed but unpublished
    esac
    host="${entry%%->*}"
    case "$host" in
      127.0.0.1:*) ;;
      *) fail "container '$name' publishes $host — only 127.0.0.1 publishes are allowed (SRV-199 class)" ;;
    esac
  done <<EOF
$(printf '%s' "$ports" | tr ',' '\n')
EOF
}

# stack_restart_policies <names> — restart policy + health of every stack container.
check_restart_and_drift() {
  local names="$1" name policy state health
  [ -n "$names" ] || return
  # shellcheck disable=SC2086  # word splitting is intended: names have no spaces
  while IFS="$SEP" read -r name policy state health; do
    [ -n "$name" ] || continue
    name="${name#/}"
    if [ "$policy" != "unless-stopped" ]; then
      fail "container '$name' has restart policy '$policy', not the pinned 'unless-stopped' — it will not come back after a reboot"
    fi
    if [ "$name" = "$SERVICE" ] && [ "$health" = none ]; then
      fail "container '$name' has no healthcheck — it was not created from the pinned definition (a bare 'docker run' cannot be gated)"
    fi
  done <<EOF
$(docker inspect --format "{{.Name}}${SEP}{{.HostConfig.RestartPolicy.Name}}${SEP}{{.State.Status}}${SEP}{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}" $names 2>/dev/null || true)
EOF
}

# check_mount_modes <names> — every bind-mount source of the stack must be private.
# The compose file's bind mounts are the files that carry secrets (redis.conf holds the
# requirepass); checking them here means a later `docker run -v` or a host edit that
# loosens a mode is caught at deploy time, not by an incident (review M2 / SRV-201).
check_mount_modes() {
  local names="$1" src
  [ -n "$names" ] || return
  # shellcheck disable=SC2086  # word splitting is intended: names have no spaces
  while IFS= read -r src; do
    [ -n "$src" ] || continue
    check_secret "$src" "bind-mount source"
  done <<EOF
$(docker inspect --format '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}{{"\n"}}{{end}}{{end}}' $names 2>/dev/null || true)
EOF
}

# reserved_from_config <rendered compose> — the pinned container_names. The definition
# is the source of truth for which names belong to this stack, so the runner does not
# hardcode a list that can drift (review m6).
reserved_from_config() {
  printf '%s\n' "$1" | sed -n 's/^[[:space:]]*container_name:[[:space:]]*//p' | tr '\n' ' '
}

# check_env_file_reference <compose file> <rendered compose> <expected env file> — the
# definition target.env points at must be the one compose loads. The pinned file is the
# primary evidence: compose v5 resolves `env_file` away in `config` (the rendered output
# carries the resolved `environment:` and no path at all), so a check that greps the
# rendered text for the path is version-dependent and false-positives on the host
# (found on 185 with compose v5.5.1, 2026-10-14). When the render does carry paths
# (older compose), they are asserted exactly.
check_env_file_reference() {
  local file="$1" rendered="$2" expected="$3" base declared=0
  base="$(basename "$expected")"
  if [ -f "$file" ]; then
    if grep -qE '^[[:space:]]*env_file:' "$file" && grep -qF "$base" "$file"; then
      declared=1
    fi
  fi
  if [ "$declared" -eq 0 ]; then
    fail "the pinned definition ($file) does not declare the app env file target.env points at ($base) — they disagree"
    return
  fi
  case "$rendered" in
    *"env_file"*)
      case "$rendered" in
        *"$expected"*|*"$base"*) ;;
        *) fail "the rendered definition references a different env file than target.env ($base) — they disagree" ;;
      esac
      ;;
  esac
}

# bind_sources_from_config <rendered compose> — every `type: bind` source path.
bind_sources_from_config() {
  printf '%s\n' "$1" | awk '
    /^[[:space:]]*-[[:space:]]*type:[[:space:]]*bind/ { want = 1; next }
    /^[[:space:]]*-[[:space:]]*type:/                  { want = 0 }
    want && /^[[:space:]]*source:/ { sub(/^[[:space:]]*source:[[:space:]]*/, ""); print; want = 0 }
  '
}

# check_config_bind_sources <rendered compose> — every bind source the definition mounts
# must be a private file (mode: no group/other bits). Fails closed when the definition
# has bind mounts this parser cannot name.
check_config_bind_sources() {
  local rendered="$1" src found=0
  while IFS= read -r src; do
    [ -n "$src" ] || continue
    found=1
    check_secret "$src" "bind-mount source (definition)"
  done <<EOF
$(bind_sources_from_config "$rendered")
EOF
  if [ "$found" -eq 0 ] && printf '%s\n' "$rendered" | grep -q 'type: bind'; then
    fail "the definition declares bind mounts that this preflight could not name — refusing (fail-closed)"
  fi
}

# check_external_networks <rendered compose> — an `external: true` network that does not
# exist makes the first `up` fail after the old container is already gone. `compose config`
# cannot see that, `docker network inspect` can (review m4). Fail closed if the block is
# unparsable: better a false alarm at deploy time than a half-dead stack.
check_external_networks() {
  local rendered="$1" names name
  names="$(printf '%s\n' "$rendered" | awk '
    /^networks:/            { in_net = 1; next }
    /^[a-zA-Z]/ && !/^networks:/ { in_net = 0 }
    in_net && /external: true/ { if (cur != "") print cur; cur = "" }
    in_net && /^  [^ ]+:/   { cur = $1; sub(/:$/, "", cur) }
  ')"
  if [ -z "$names" ] && printf '%s\n' "$rendered" | grep -q 'external: true'; then
    fail "the definition declares an external network that this preflight could not name — refusing (fail-closed)"
    return
  fi
  for name in $names; do
    if docker network inspect "$name" >/dev/null 2>&1; then
      note "external network present: $name"
    else
      fail "external network '$name' does not exist on this host — the first 'up' would fail (review m4)"
    fi
  done
}

#===============================================================================
# PRE — assert before anything is recreated.
#===============================================================================
phase_pre() {
  if [ ! -e "$MARKER" ]; then
    note "freeze marker absent: $MARKER"
  else
    fail "freeze marker present ($MARKER) — this host is frozen; starting the bot here would break single-instance discipline (TGB-112 / TRL-DOC-323 §7.1)"
  fi

  if [ ! -d "$STACK_DIR" ]; then
    fail "stack directory missing: $STACK_DIR"
  fi
  if [ ! -f "$COMPOSE_FILE" ]; then
    fail "pinned definition missing: $COMPOSE_FILE"
  fi

  command -v docker >/dev/null 2>&1 || fail "docker is not on PATH"

  if [ -f "$COMPOSE_FILE" ] && command -v docker >/dev/null 2>&1; then
    if dc config -q >/dev/null 2>&1; then
      note "docker compose config: valid"
    else
      fail "docker compose config failed for $COMPOSE_FILE (rendered with $(basename "$ENV_FILE"))"
    fi
    # NOTE: this capture is a *variable*, never printed. Compose resolves `env_file` into
    # the service `environment:` and prints the resulting VALUES — running
    # `docker compose config` by hand on a host with real env files is a credential leak
    # (observed once while building this rule, 2026-10-14). Keep it inside the script.
    RENDERED="$(dc config 2>/dev/null || true)"
    check_env_file_reference "$COMPOSE_FILE" "$RENDERED" "$ENV_FILE"
  fi

  check_secret "$ENV_FILE" "app env file"
  check_secret "$INFRA_ENV_FILE" "infra env file"

  if [ -n "$RENDERED" ]; then
    # redis.conf carries the requirepass and is mounted read-only; it is a secret file
    # like the two env files, and used to be the only one nobody checked (review M2).
    # The sources come from the definition, so no relative path is assumed here.
    check_config_bind_sources "$RENDERED"
    check_external_networks "$RENDERED"
    if [ -z "$RESERVED" ]; then
      RESERVED="$(reserved_from_config "$RENDERED")"
      if [ -n "$RESERVED" ]; then
        note "pinned container names from the definition: $RESERVED"
      else
        fail "the rendered definition declares no container_name — cannot tell this stack's containers from drift (review m6)"
      fi
    fi
  fi

  scan_roster
  check_restart_and_drift "$STACK_NAMES"
  check_mount_modes "$STACK_NAMES"

  [ "$BOT_ROWS" -le 1 ] || fail "$BOT_ROWS containers on this host use the bot image — exactly one is allowed"

  if [ -n "$DEP_STOPPED" ]; then
    fail "dependency container(s) not running:$DEP_STOPPED — the bot would only crash-loop"
  elif [ -z "$STACK_NAMES" ]; then
    fail "none of the stack containers exist yet (postgres/redis must be up before the bot is deployed)"
  fi
  return 0
}

#===============================================================================
# POST — assert after the recreate.
#===============================================================================
wait_for_health() {
  local elapsed=0 state
  while :; do
    state="$(inspect_field "$SERVICE" '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"
    case "$state" in
      healthy) note "health: healthy"; return 0 ;;
      none) fail "container '$SERVICE' reports no healthcheck — it was not created from the pinned definition"; return 1 ;;
    esac
    if [ "$elapsed" -ge "$WAIT" ]; then
      fail "container '$SERVICE' did not become healthy within ${WAIT}s (last status: ${state:-unknown})"
      return 1
    fi
    [ "$INTERVAL" -gt 0 ] || { fail "container '$SERVICE' is '$state', not healthy, and --interval 0 forbids waiting"; return 1; }
    sleep "$INTERVAL"
    elapsed=$((elapsed + INTERVAL))
  done
}

phase_post() {
  scan_roster
  if [ "$BOT_RUNNING" -eq 1 ]; then
    note "exactly one running container from the bot image on this host"
  else
    fail "$BOT_RUNNING running container(s) from the bot image on this host — expected exactly 1"
  fi

  if [ "$BOT_ROWS" -ge 1 ]; then
    check_restart_and_drift "$STACK_NAMES"
    wait_for_health || true
  fi

  # Read the window once. Counting a pipe whose read failed would report a green 0 for
  # the headline signal, which is exactly the B1 failure mode with a different cause
  # (review m3), so an unreadable log is a violation, not a zero.
  local logs logs_rc conflicts started
  logs="$(docker logs --since "$LOG_WINDOW" "$SERVICE" 2>&1)"
  logs_rc=$?
  if [ "$logs_rc" -ne 0 ]; then
    fail "docker logs --since $LOG_WINDOW $SERVICE failed (rc=$logs_rc) — the conflict and start-line counters were not read (not 'clean')"
    note "log window $LOG_WINDOW: unread"
  else
    conflicts="$(printf '%s\n' "$logs" | grep -cE "$CONFLICT_PATTERN" || true)"
    started="$(printf '%s\n' "$logs" | grep -c 'Nest application successfully started' || true)"
    note "log window $LOG_WINDOW: getUpdates-conflicts=${conflicts:-?} start-line=${started:-?} (counters only, no log body)"
    [ "${conflicts:-1}" = 0 ] || fail "a getUpdates conflict appears ${conflicts} time(s) in the last $LOG_WINDOW — a second poller is talking to Telegram with this token"
    [ "${started:-0}" -ge 1 ] || fail "the Nest start line is absent from the last $LOG_WINDOW — the app never reported a successful start"
  fi

  # Advisory (never blocking): the MTProto singleton is the app's own signal, and it
  # can legitimately be 0 for a while after a fresh start.
  local mtproto
  mtproto="$(docker exec "$SERVICE" node -e "fetch('http://127.0.0.1:'+(process.env.METRICS_PORT||9464)+'/metrics').then(r=>r.text()).then(t=>console.log(/^memes_bot_mtproto_connected\{[^}]*\}\s+1\$/m.test(t)?1:0)).catch(()=>console.log('n/a'))" 2>/dev/null || true)"
  note "advisory: memes_bot_mtproto_connected=${mtproto:-n/a} (0/n-a just after start is not a failure; the cutover gate asserts it)"
  return 0
}

case "$PHASE" in
  pre) phase_pre ;;
  post) phase_post ;;
esac

if [ "$VIOLATIONS" -gt 0 ]; then
  echo "!! preflight(${PHASE}): ${VIOLATIONS} violation(s) — refusing" >&2
  exit 1
fi
echo "==> preflight(${PHASE}): all checks passed"
exit 0
