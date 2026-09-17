#!/bin/sh
#
# Настройка хранения логов тролль-бота на сервере.
#
# Задача: не утонуть в логах и всегда иметь последние ~2 суток для разбора.
# Делаем три вещи:
#   1) дампим вывод контейнера в файлы по датам (раз в сутки, за последние 24 часа);
#   2) ротация через logrotate: daily + rotate 2 (сегодня + два прошлых дня);
#   3) ограничиваем размер docker-логов, чтобы не забить диск.
#
# Скрипт идемпотентный: можно запускать повторно.

set -eu

CONTAINER="${CONTAINER:-telegram-bot}"
LOG_DIR="/var/log/memes-bot"
DUMP_SCRIPT="/usr/local/bin/troll-logs-dump"
CRON_FILE="/etc/cron.d/troll-logs"
LOGROTATE_FILE="/etc/logrotate.d/troll-logs"
DAEMON_JSON="/etc/docker/daemon.json"

echo "== 1. Каталог логов: ${LOG_DIR}"
mkdir -p "${LOG_DIR}"

echo "== 2. Скрипт дампа логов: ${DUMP_SCRIPT}"
cp "$(dirname "$0")/troll-logs-dump.sh" "${DUMP_SCRIPT}"
chmod 0755 "${DUMP_SCRIPT}"

echo "== 3. Cron: дамп раз в сутки в 23:55 UTC"
cat > "${CRON_FILE}" <<'CRON'
# Складываем последние сутки логов контейнера в файл с датой (23:55 UTC).
# Ротацию и срок хранения делает logrotate (см. /etc/logrotate.d/troll-logs).
55 23 * * * root /usr/local/bin/troll-logs-dump >/dev/null 2>&1
CRON
chmod 0644 "${CRON_FILE}"

echo "== 4. Logrotate: храним сегодня + два прошлых дня"
cat > "${LOGROTATE_FILE}" <<'LOGROTATE'
# Логи тролль-бота: один текущий файл, ротация раз в сутки, архивы с датой.
# rotate 2 = сегодня + два прошлых дня, дальше старое удаляется.
/var/log/memes-bot/bot.log {
    daily
    rotate 2
    dateext
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su root root
}
LOGROTATE
chmod 0644 "${LOGROTATE_FILE}"

echo "== 5. Docker: ограничение размера логов (для новых контейнеров)"
mkdir -p /etc/docker
cat > "${DAEMON_JSON}" <<'DAEMON'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "30m",
    "max-file": "10"
  }
}
DAEMON

echo "== 6. Проверка конфигурации logrotate"
logrotate -d "${LOGROTATE_FILE}" >/dev/null 2>&1 && echo "logrotate: ok" || echo "logrotate: проверь вручную"

echo "== 7. Первый дамп сейчас, чтобы логи были уже сегодня"
CONTAINER="${CONTAINER}" "${DUMP_SCRIPT}"

echo
echo "Готово."
echo "  свежие логи:      docker logs -f ${CONTAINER}"
echo "  файл за сутки:    ${LOG_DIR}/bot.log"
echo "  прошлые сутки:    ls -la ${LOG_DIR} (bot.log-ГГГГММДД.gz)"
echo "  ротация:          cat ${LOGROTATE_FILE}"
echo "  расписание дампа: cat ${CRON_FILE}"
echo
echo "Ограничения размера docker-логов (${DAEMON_JSON}) применятся к новым"
echo "контейнерам; для текущего они задаются ключами --log-opt при docker run."
