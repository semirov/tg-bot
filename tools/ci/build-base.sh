#!/usr/bin/env bash
# Собирает и пушит базовый образ с зависимостями, если его ещё нет в реестре.
#
# Использование: build-base.sh [nodeVersion]   (по умолчанию 20)
# Тег образа — версия Node + первые 12 символов sha256 от package-lock.json:
# пока зависимости не менялись, CI переиспользует образ и не делает npm ci.
#
# Печатает имя образа в stdout (последней строкой); дублирует в файл .deps-image.
set -euo pipefail

export DOCKER_BUILDKIT=1

NODE_VERSION="${1:-20}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

IMAGE="${DEPS_IMAGE_BASE:-cr.yandex/crp8g8jm3p8d780a8hk3/telegram-bot-deps}"
HASH="$(sha256sum package-lock.json | cut -c1-12)"
TAG="${IMAGE}:node${NODE_VERSION}-${HASH}"
LATEST="${IMAGE}:node${NODE_VERSION}"

# Секреты реестра лежат в read-only mount; docker/buildx пишут в DOCKER_CONFIG,
# поэтому делаем writable-копию.
SECRETS_DIR="${DEPLOY_SECRETS_DIR:-/deploy-secrets}"
if [ -f "$SECRETS_DIR/docker/config.json" ]; then
  DOCKER_CONFIG_WRITABLE="$(mktemp -d)"
  cp "$SECRETS_DIR/docker/config.json" "$DOCKER_CONFIG_WRITABLE/config.json"
  export DOCKER_CONFIG="$DOCKER_CONFIG_WRITABLE"
fi

echo "$TAG" > .deps-image

if docker manifest inspect "$TAG" >/dev/null 2>&1; then
  echo "==> Базовый образ уже в реестре: $TAG" >&2
else
  echo "==> Сборка базового образа $TAG" >&2
  docker build --build-arg NODE_VERSION="$NODE_VERSION" \
    -f Dockerfile.deps -t "$TAG" -t "$LATEST" .
  echo "==> Push базового образа" >&2
  docker push "$TAG"
  docker push "$LATEST"
fi

echo "$TAG"
