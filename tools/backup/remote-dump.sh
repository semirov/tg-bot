#!/usr/bin/env bash
# Runs ON the production host (185.238.169.171): dump the memes-bot database,
# encrypt it with age (ChaCha20-Poly1305, X25519) at the source, rotate the
# archives. Prints the absolute path of the fresh archive as the last line.
#
# TGB-113: the memes DB had no recurring backup at all — the only dumps were the
# three one-off artifacts taken while moving off 38.180.69.206. This is the same
# recipe as the troll contour (TRL-241 / TRL-DOC-103), deliberately, so the two
# contours stay comparable: `pg_dump | gzip | age`, the plaintext never reaches a
# disk (not even as an intermediate `.sql.gz`), and the off-site artifact is
# ciphertext only. The dump carries PII and the MTProto session row, and the repo
# is public, so encryption is the only barrier between the artifact and that data.
#
# Fail-closed: no `age`, or no plausible public recipient → exit BEFORE the dump is
# taken. A caller that receives `.sql.gz` instead of `.sql.gz.age` has a broken
# configuration; tools/backup/db-backup.sh refuses to publish it.
#
# Env: DEPLOY_DIR                 stack dir on the host (/opt/memes-bot)
#      BACKUP_KEEP                archives kept locally (3)
#      BACKUP_CONTAINER           db container (memes-postgres)
#      BACKUP_AGE_RECIPIENT       public age key (wins over the file)
#      BACKUP_AGE_RECIPIENT_FILE  file holding it ($DIR/backup-recipient.txt)
#
# Test: tools/backup/remote-dump.test.sh.
set -euo pipefail

# Dumps are private by construction: even though the payload is ciphertext and the
# stack directory is 0700, nothing here should be group/world readable.
umask 077

DIR="${DEPLOY_DIR:-/opt/memes-bot}"
KEEP="${BACKUP_KEEP:-3}"
CONTAINER="${BACKUP_CONTAINER:-memes-postgres}"
RECIPIENT_FILE="${BACKUP_AGE_RECIPIENT_FILE:-$DIR/backup-recipient.txt}"
PREFIX="memes-bot-db"

die() { echo "!! remote-dump: $1" >&2; exit 1; }

cd "$DIR"
mkdir -p backups

# --- fail-closed guards: tool and recipient BEFORE any dump work happens --------
command -v age >/dev/null 2>&1 \
  || die "age is not installed on this host (cannot encrypt) — refusing, no plaintext fallback"

if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  RECIPIENT="$BACKUP_AGE_RECIPIENT"
elif [ -f "$RECIPIENT_FILE" ]; then
  RECIPIENT="$(tr -d '[:space:]' < "$RECIPIENT_FILE")"
else
  die "no age recipient (neither BACKUP_AGE_RECIPIENT nor $RECIPIENT_FILE) — refusing, no plaintext fallback"
fi
case "$RECIPIENT" in
  age1*) ;;
  *) die "the age recipient does not look like a public key — refusing (fail-closed)";;
esac

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="backups/${PREFIX}-${STAMP}.sql.gz.age"
TMP="${FILE}.tmp"

# Encrypt in the stream: pg_dump | gzip | age > tmp. The credentials stay inside the
# container ($POSTGRES_USER/$POSTGRES_DB are expanded by the container's own shell,
# never in this argv). Publish only verified ciphertext.
cleanup() { [ ! -e "$TMP" ] || rm -f "$TMP"; }
trap cleanup EXIT INT TERM

docker exec "$CONTAINER" sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  | gzip \
  | age -r "$RECIPIENT" > "$TMP"

[ -s "$TMP" ] || die "empty ciphertext — the dump was not produced"
head -c 64 "$TMP" | grep -q 'age-encryption.org/v1' \
  || die "the stream is not age ciphertext — refusing to publish"

mv -f "$TMP" "$FILE"
trap - EXIT INT TERM

# Rotation: keep the last $KEEP archives. Only our own naming, so the one-off
# `memes-final-*.sql.gz.age` artifacts of the TGB-112 move are never touched.
ls -1t backups/${PREFIX}-*.sql.gz.age 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "$DIR/$FILE"
