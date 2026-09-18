#!/usr/bin/env bash
# Делает DOCKER_CONFIG writable на основе read-only /deploy-secrets/docker.
# docker/buildx пишут состояние в DOCKER_CONFIG, поэтому указывать на read-only
# каталог нельзя. Использование: `source tools/ci/docker-config.sh`.
SECRETS_DIR="${DEPLOY_SECRETS_DIR:-/deploy-secrets}"
if [ -f "$SECRETS_DIR/docker/config.json" ]; then
  _DOCKER_CONFIG_WRITABLE="$(mktemp -d)"
  cp "$SECRETS_DIR/docker/config.json" "$_DOCKER_CONFIG_WRITABLE/config.json"
  export DOCKER_CONFIG="$_DOCKER_CONFIG_WRITABLE"
fi
