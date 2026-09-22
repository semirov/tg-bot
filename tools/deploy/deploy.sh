#!/usr/bin/env bash
# Сборка и деплой образа на сервер.
#
# Использование: deploy.sh <version> [builtSha]
#
# Все параметры окружения (хост, доступы, имена образа/контейнера/сети, файл env)
# и креды registry берутся из каталога секретов DEPLOY_SECRETS_DIR, который
# монтируется в контейнер CI read-only. В репозиторий секреты не попадают и в
# лог не печатаются. Ожидаемые переменные: DEPLOY_HOST, DEPLOY_USER,
# DEPLOY_PASSWORD или DEPLOY_SSH_KEY, DEPLOY_IMAGE, DEPLOY_CONTAINER,
# DEPLOY_NETWORK, DEPLOY_ENV_FILE; креды registry — в каталоге секретов.
set -euo pipefail

export DOCKER_BUILDKIT=1

VERSION="${1:?usage: deploy.sh <version> [builtSha]}"
BUILT_SHA="${2:-}"
SECRETS_DIR="${DEPLOY_SECRETS_DIR:-/deploy-secrets}"

# shellcheck disable=SC1091
source "$SECRETS_DIR/target.env"

: "${DEPLOY_HOST:?}"; : "${DEPLOY_USER:?}"; : "${DEPLOY_IMAGE:?}"
: "${DEPLOY_CONTAINER:?}"; : "${DEPLOY_NETWORK:?}"; : "${DEPLOY_ENV_FILE:?}"

# shellcheck source=/dev/null
source tools/ci/docker-config.sh

echo "==> Базовый образ с зависимостями"
DEPS_IMAGE="$(bash tools/ci/build-base.sh 20 | tail -1)"
echo "    $DEPS_IMAGE"

# Прод-образ уже собран и запушен test-job'ом (тег sha-<commit>): переиспользуем
# его, чтобы не собирать webpack повторно в деплое.
IMAGE_SHA="${DEPLOY_IMAGE}:sha-${BUILT_SHA}"
if [ -n "$BUILT_SHA" ] && docker pull "$IMAGE_SHA" >/dev/null 2>&1; then
  echo "==> Используем образ из CI: $IMAGE_SHA"
  docker tag "$IMAGE_SHA" "${DEPLOY_IMAGE}:${VERSION}"
else
  echo "==> Образ sha-${BUILT_SHA:-?} не найден — сборка ${DEPLOY_IMAGE}:${VERSION} (linux/amd64)"
  docker build --platform linux/amd64 \
    --build-arg DEPS_IMAGE="$DEPS_IMAGE" \
    -f apps/memes-bot/Dockerfile \
    -t "${DEPLOY_IMAGE}:${VERSION}" .
fi

echo "==> Push образа ${VERSION}"
docker push "${DEPLOY_IMAGE}:${VERSION}"

# Транспорт к серверу: ключ, если задан, иначе пароль через askpass.
SSH_BASE=(ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
if [ -n "${DEPLOY_SSH_KEY:-}" ]; then
  SSH_BASE+=(-i "$DEPLOY_SSH_KEY")
  ssh_cmd() { "${SSH_BASE[@]}" "${DEPLOY_USER}@${DEPLOY_HOST}" "$@"; }
else
  ASKPASS="$(mktemp)"
  printf '#!/bin/sh\nprintf "%%s\\n" "$DEPLOY_PASSWORD"\n' > "$ASKPASS"
  chmod +x "$ASKPASS"
  trap 'rm -f "$ASKPASS"' EXIT
  export DEPLOY_PASSWORD
  export SSH_ASKPASS="$ASKPASS"
  export SSH_ASKPASS_REQUIRE=force
  # OpenSSH < 8.4 (например, в образе раннера 8.2) не понимает SSH_ASKPASS_REQUIRE
  # и запускает askpass только при отсутствии tty и заданном DISPLAY.
  export DISPLAY="${DISPLAY:-:0}"
  ssh_cmd() { setsid -w "${SSH_BASE[@]}" -o PreferredAuthentications=password "${DEPLOY_USER}@${DEPLOY_HOST}" "$@"; }
fi

echo "==> Перезапуск контейнера ${DEPLOY_CONTAINER} на ${DEPLOY_HOST}"
ssh_cmd "bash -s" <<REMOTE
set -euo pipefail
docker pull "${DEPLOY_IMAGE}:${VERSION}" >/dev/null
docker rm -f "${DEPLOY_CONTAINER}-prev" >/dev/null 2>&1 || true
docker stop "${DEPLOY_CONTAINER}" >/dev/null
docker rename "${DEPLOY_CONTAINER}" "${DEPLOY_CONTAINER}-prev"
docker run -d --name "${DEPLOY_CONTAINER}" --restart unless-stopped \
  --network "${DEPLOY_NETWORK}" --env-file "${DEPLOY_ENV_FILE}" \
  -e APP_VERSION="${VERSION}" \
  -e METRICS_PORT=9464 \
  -p 127.0.0.1:9464:9464 \
  "${DEPLOY_IMAGE}:${VERSION}" >/dev/null
sleep 20
echo "--- status ---"
docker ps --format '{{.Names}} | {{.Image}} | {{.Status}}' | grep "${DEPLOY_CONTAINER}" || true
echo "--- logs ---"
docker logs --tail 60 "${DEPLOY_CONTAINER}" 2>&1
# На сервере ограниченный диск: старые теги образов копятся и могут забить
# раздел. Чистим образы старше 72 часов (текущий и предыдущий релиз остаются).
echo "--- prune старых образов ---"
docker image prune -af --filter "until=72h" | tail -2
df -h / | tail -1
REMOTE

echo "==> Проверка здоровья и уведомления о старте"
LOG_DUMP="$(ssh_cmd "docker logs --tail 200 '${DEPLOY_CONTAINER}' 2>&1")"
if ! grep -q 'Nest application successfully started' <<<"$LOG_DUMP"; then
  echo "!! Приложение не подтвердило успешный старт — откат"
  ssh_cmd "docker rm -f '${DEPLOY_CONTAINER}'; docker rename '${DEPLOY_CONTAINER}-prev' '${DEPLOY_CONTAINER}'; docker start '${DEPLOY_CONTAINER}'" || true
  exit 1
fi

echo "==> Деплой ${VERSION} завершён успешно"
