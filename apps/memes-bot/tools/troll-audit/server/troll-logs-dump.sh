#!/bin/sh
#
# Складывает последние сутки логов контейнера в общий файл /var/log/memes-bot/bot.log.
# Запускается по крону раз в сутки; ротацию и срок хранения делает logrotate
# (файл после ротации получает дату в имени, поэтому разбирать логи удобно).
#
# Переменные CONTAINER и LOG_DIR позволяют переопределить контейнер и каталог.

set -eu

CONTAINER="${CONTAINER:-telegram-bot}"
LOG_DIR="${LOG_DIR:-/var/log/memes-bot}"
TARGET="${LOG_DIR}/bot.log"

mkdir -p "${LOG_DIR}"

{
    echo "### дамп логов ${CONTAINER} за последние 24 часа, $(date -u '+%F %T UTC')"
    docker logs --since 24h --timestamps "${CONTAINER}" 2>&1
} >> "${TARGET}"

echo "дамп записан: ${TARGET} (строк в файле: $(wc -l < "${TARGET}"))"
