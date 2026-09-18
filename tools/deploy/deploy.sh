#!/usr/bin/env bash
# Сборка и деплой образа на сервер.
#
# Использование: deploy.sh <version>
# Секреты берутся из read-only каталога DEPLOY_SECRETS_DIR (по умолчанию
# /deploy-secrets), который монтируется в контейнер раннера. В репозиторий
# секреты не попадают и в лог не печатаются.
#
# /deploy-secrets/target.env:
#   DEPLOY_HOST=...
#   DEPLOY_USER=...
#   DEPLOY_PASSWORD=...            # либо DEPLOY_SSH_KEY=/deploy-secrets/deploy_ed25519
#   DEPLOY_IMAGE=cr.yandex/<id>/telegram-bot
#   DEPLOY_CONTAINER=telegram-bot
#   DEPLOY_NETWORK=app-net
#   DEPLOY_ENV_FILE=/root/bot.env
# /deploy-secrets/docker/config.json  — креды registry для docker push
set -euo pipefail

VERSION="${1:?usage: deploy.sh <version>}"
SECRETS_DIR="${DEPLOY_SECRETS_DIR:-/deploy-secrets}"

# shellcheck disable=SC1091
source "$SECRETS_DIR/target.env"

: "${DEPLOY_HOST:?}"; : "${DEPLOY_USER:?}"; : "${DEPLOY_IMAGE:?}"
: "${DEPLOY_CONTAINER:?}"; : "${DEPLOY_NETWORK:?}"; : "${DEPLOY_ENV_FILE:?}"

if [ -d "$SECRETS_DIR/docker" ]; then
  export DOCKER_CONFIG="$SECRETS_DIR/docker"
fi

echo "==> Сборка образа ${DEPLOY_IMAGE}:${VERSION} (linux/amd64)"
docker build --platform linux/amd64 \
  -f apps/memes-bot/Dockerfile \
  -t "${DEPLOY_IMAGE}:${VERSION}" .

echo "==> Push образа"
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
  "${DEPLOY_IMAGE}:${VERSION}" >/dev/null
sleep 20
echo "--- status ---"
docker ps --format '{{.Names}} | {{.Image}} | {{.Status}}' | grep "${DEPLOY_CONTAINER}" || true
echo "--- logs ---"
docker logs --tail 60 "${DEPLOY_CONTAINER}" 2>&1
REMOTE

echo "==> Проверка здоровья и уведомления о старте"
LOG_DUMP="$(ssh_cmd "docker logs --tail 200 '${DEPLOY_CONTAINER}' 2>&1")"
if ! grep -q 'Nest application successfully started' <<<"$LOG_DUMP"; then
  echo "!! Приложение не подтвердило успешный старт — откат"
  ssh_cmd "docker rm -f '${DEPLOY_CONTAINER}'; docker rename '${DEPLOY_CONTAINER}-prev' '${DEPLOY_CONTAINER}'; docker start '${DEPLOY_CONTAINER}'" || true
  exit 1
fi

echo "==> Деплой ${VERSION} завершён успешно"
