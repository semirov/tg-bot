# DB backup and restore drill (memes-bot)

Operational runbook for the memes-bot database backup contour. Task: TGB-113.
The recipe is the troll contour's (TRL-241 / TRL-DOC-103, `troll_tg_bot/tools/backup/`),
deliberately unchanged in shape so the two stay comparable; what differs is where the
secrets live (see *Credentials*). Decisions live in Lific, this file holds the
operational instructions only.

## What and why

The dump contains PII (users, requests, published posts) and the **MTProto session
row** (`client_session_entity`) — that row is state, not just data. The repository is
public, so an unencrypted artifact is not an option:

- the dump is **age encrypted at the source** (ChaCha20-Poly1305, X25519) on the
  production host;
- the plaintext never reaches a disk anywhere: only `pg_dump | gzip | age`;
- every copy that leaves the host is ciphertext, and the copy that CI publishes can
  only be decrypted by the holder of the identity.

## Files and flows

| Layer | File / location |
| --- | --- |
| Snapshot + encryption on the host | `tools/backup/remote-dump.sh` → `/opt/memes-bot/backups/memes-bot-db-<UTCstamp>.sql.gz.age` (rotation: last 3) |
| Fetch to the CI node | `tools/backup/db-backup.sh` (ssh keepalive/retries; promoted only when the age magic plus the source **byte count and sha256** match; fails closed on plaintext, on a truncation or on a digest mismatch) |
| Host pin | `tools/backup/expected-hosts.txt` — the positive counterpart to `tools/ci/retired-deploy-hosts.txt`: the dump may only come from these hosts |
| Publication | `.github/workflows/backup.yml` → artifact `memes-bot-db-<run_id>`, `retention-days: 3` |
| Restore drill | `tools/backup/restore-drill.sh` + `.github/workflows/restore-drill.yml` (weekly + manual) |
| Off-host copy | `tools/backup/offsite-pull.sh`, run on the home-server (cron) → `/home/filipp/backups/memes-bot/` (rotation: last 14; the source's byte count **and** sha256 are verified **before** the file is promoted, and a source that cannot answer either fails the run) |
| Alert | `tools/backup/notify-failure.sh` → GitHub issue, deduplicated by title |

## Cadence and retention

| Copy | Where | Cadence | Kept |
| --- | --- | --- | --- |
| Source | `/opt/memes-bot/backups` on `185.238.169.171` | 02:30 UTC daily (`backup.yml`) | 3 (`BACKUP_KEEP`) |
| CI artifact | GitHub Actions artifact | with every backup run | 3 days |
| Off-host | `/home/filipp/backups/memes-bot` on the home-server | every day, 04:00 UTC (cron: `30 4 * * *`) | 14 (`OFFSITE_KEEP`) |
| Drill | on the CI node (throwaway container + tmpfs) | weekly, Sunday 03:30 UTC (`restore-drill.yml`) | report: 3 days |

The off-host copy keeps the long tail on purpose: the source retention is short, and a
problem noticed a week later must still have a dump to go back to.

## Credentials

- **age recipient (public)** — `/opt/memes-bot/backup-recipient.txt` (0644) on the
  production host. It is the *same* recipient as the troll contour's; no second key
  pair exists. Public, so it holds nothing secret.
- **age identity (private)** — `~/.deploy-secrets/backup-age-identity.txt` (0600) on
  the dev node, which is also mounted read-only into the self-hosted runner as
  `$DEPLOY_SECRETS_DIR/backup-age-identity.txt`. Only the drill job materializes it
  (into `$RUNNER_TEMP`, 0600); the backup job cannot decrypt what it publishes. Losing
  this file makes every existing `.age` archive unreadable — keep the offline copy.
- **production credentials** — `$DEPLOY_SECRETS_DIR/target.env` (0600), the same file
  `tools/deploy/deploy.sh` uses. They are mounted on the runner, so the backup and
  drill workflows need **no GitHub secret at all**.
- **off-host pull key** — the home-server uses the key its monitoring tunnel already
  has (`/usr/ha/monitoring/bot-metrics-tunnel/id_ed25519`); the pull moves ciphertext
  only and needs no decryption key. It is installed at
  `/usr/ha/backup/memes-bot-offsite-pull.sh` and driven by the crontab entry below.

> If the identity file is not on the node the drill runs on, the drill fails with
> `no age identity at …` and sends the failure issue. It never "passes" without it.

`age` itself is provisioned by the drill workflow: the self-hosted runner is an
Ubuntu 20.04 container whose repositories have **no** `age` package ("Unable to locate
package age" — measured 2026-10-14), so the workflow pins the upstream release
(v1.2.1, arm64) and verifies its sha256 before installing it, once per container. The
host runs the distribution package (1.0.0) — the two are format-compatible, and the
drill also proves that: the cross-version decrypt is exercised on every run.

Running the backup by hand on the dev node prints a note about the configured key
path: `target.env` names the runner's mounted path, so a manual run falls back to the
ssh agent's key — it is the same key.

## Running the backup by hand

```bash
# on the dev node (has docker, ssh and the mounted secrets)
DEPLOY_SECRETS_DIR=~/.deploy-secrets bash tools/backup/db-backup.sh /tmp/backup-out
# → prints the local path of the encrypted artifact
```

CI runs the same script; a manual `workflow_dispatch` of `Backup` does the same on the
runner.

## Restore drill

```
Actions → DB restore drill → Run workflow        # or weekly, Sunday 03:30 UTC
```

It takes the artifact of the **last successful backup run**, decrypts it
(`age -d | gzip -t` for integrity, no plaintext on disk), restores it into a throwaway
`postgres:14-alpine` with **no published port and no network**, and then checks:

| Check | Meaning |
| --- | --- |
| freshness | the STAMP in the file name is not older than `DRILL_MAX_AGE_HOURS` (48) |
| gzip integrity | the decrypted stream is a complete gzip stream |
| restore | `age -d | gunzip | psql` runs to completion |
| parity | per-table row counts from the dump's own COPY blocks == the restored counts |
| canaries | `client_session_entity` (the MTProto session row), `parser_settings_entity`, `user_request_entity` and `observatory_post_entity` are above their floors |
| shape | at least `DRILL_EXPECT_TABLES` (24 of the recorded 26) tables and at least `DRILL_MIN_ROWS` (100000) rows |
| verifier image | the throwaway server reports the source's major version (14.x) |
| exposure | the throwaway instance publishes no port, runs with no network, and keeps PGDATA on a tmpfs (asserted, not assumed) |

The **absolute floors** are the deliberate guard (TGB-113 review §M5): row parity is
measured against the dump itself, so it cannot notice a database that is empty *at the
source* as well. They are recorded from the production base of 2026-10-14 — 26 tables,
280,860 rows (`observatory_post_entity` alone 180,323, `user_request_entity` 12,068) —
and set just inside it: 24 tables (losing more than two is not a migration accident) and
roughly a third of the rows, because a drop that large is an incident rather than noise.
Lower a floor only as a deliberate decision, and say why in the commit.

The verifier image is pinned by digest (not by the floating `postgres:14-alpine` tag),
so a green drill cannot be explained by an image that moved underneath it; if the
digest ever resolves to another major the `pg_verifier` check turns red.

Local run (needs docker + age):

```bash
BACKUP_AGE_KEY_FILE=~/.deploy-secrets/backup-age-identity.txt \
  bash tools/backup/restore-drill.sh /path/to/memes-bot-db-<stamp>.sql.gz.age /tmp/drill-out
```

The parity check is why the drill needs **no production access**: the dump is its own
reference, so a green drill cannot be explained away by "prod was empty at the time".
A green drill on an artifact older than the freshness window still fails — it is a
check on the *contour*, not only on the file.

## What the report exposes (public repository)

This repository is public, so the job summary and the uploaded drill report are world
readable. They contain the artifact **name, byte count and sha256**, **table names** and
**per-table row counts**, plus the PostgreSQL/age versions — counters and identifiers,
never values from the dump (the project's data rule allows exactly this projection). The
one item worth being deliberate about is the per-table detail: it is a real (if small)
disclosure about production *volume*, so it is a conscious decision, recorded here. To
drop it to pass/fail, set `DRILL_REPORT_VERBOSE=0`; the check results and the totals
stay.

## Restoring into the running stack (read this first)

The database holds the gramjs MTProto session row. Restoring a dump into a **live**
bot can start a second live login for the same account — the single-instance failure
class of TRL-604 (the deploy guards in `tools/deploy/remote-preflight.sh` exist for the
same reason).

Two rules:

1. **Stop the poller before restoring into production.** `docker compose -p memes-bot
   … stop telegram-bot` (or the delivered `deploy.sh` freeze marker), restore, then
   start it again and watch `getUpdates` for a 409 conflict. Never restore into a
   running stack.
2. **A drill never touches production.** It restores into its own throwaway container
   and refuses to start on a host that runs `memes-postgres` (override only with
   `DRILL_ALLOW_PROD_HOST=1`, and only if you know why).

Manual restore of the real stack:

```bash
age -d -i ~/.deploy-secrets/backup-age-identity.txt memes-bot-db-<stamp>.sql.gz.age \
  | gunzip | ssh -i ~/.deploy-secrets/id_ed25519 root@185.238.169.171 \
  "docker exec -i memes-postgres sh -c 'psql -U \$POSTGRES_USER -d \$POSTGRES_DB'"
```

Take a fresh dump **before** any restore: the restore overwrites what is there now.

## Off-host copy (home-server)

The backup workflow cannot push to the home-server: the self-hosted runner is an
OrbStack container on the dev node and has no route to the home-server's network, while
the home-server already holds a key to the production host (its monitoring tunnels use
it). So the home-server pulls:

```bash
# on the home-server, from a checkout of this repo (the user owns /usr/ha — no sudo)
install -d -m 755 /usr/ha/backup
scp tools/backup/offsite-pull.sh home-server:/tmp/ && \
  ssh home-server 'install -m 755 /tmp/offsite-pull.sh /usr/ha/backup/memes-bot-offsite-pull.sh'
mkdir -p ~/logs
crontab -l > ~/crontab.bak && (crontab -l; echo \
  '30 4 * * * VPS_SSH_KEY=/usr/ha/monitoring/bot-metrics-tunnel/id_ed25519 /usr/ha/backup/memes-bot-offsite-pull.sh >> /home/filipp/logs/memes-bot-offsite-pull.log 2>&1') \
  | crontab -
```

`OFFSITE_MAX_AGE_HOURS` (48) makes a stale source a failure, so a broken dump job
surfaces in `~/logs/memes-bot-offsite-pull.log` instead of a silently aging copy. The
script is idempotent and moves ciphertext only.

## Failure handling

- A failed scheduled run opens (or comments on) an issue titled
  `[auto] Scheduled DB backup failed` / `[auto] Restore drill failed`.
- A broken contour **skips a backup** — it never falls back to an unencrypted dump:
  no `age` or no recipient on the host aborts before the dump, and plaintext, a
  truncated transfer or a digest mismatch aborts before publication.
- **The off-host pull is the quiet one.** It fails loudly in its own log, but nothing
  outside the home-server watches it; check the heartbeat:

  ```bash
  ssh home-server 'cat /home/filipp/backups/memes-bot/.last-success'
  # → timestamp + artifact=<name> bytes=<n> kept=<n>/14
  ```

  The heartbeat is refreshed by every successful run, **including a no-op one** (the
  run verified the copy; nothing had changed), so a heartbeat older than a day means the
  cron itself stopped — and the recovery point is aging while the CI drill keeps passing
  against its own artifact. Wiring this into the
  home-server monitoring is tracked as [SRV-215](https://wiki.semirov.dev/SRV/issues/SRV-215)
  (Triage, anomaly).
- If the source host itself is lost, the home-server copy is the recovery point.

## Rollback of this contour

- **Workflows:** disable or delete `.github/workflows/backup.yml` /
  `restore-drill.yml` — independent of each other, and neither is on the deploy path
  (`ci.yml` is unaffected).
- **Host:** the recipient file and `age` are inert without the scripts; delete
  `/opt/memes-bot/backup-recipient.txt` to stop new dumps from being produced.
- **Home-server:** remove the cron line and the installed script.
- **Artifacts:** do not delete the last encrypted dump until a newer verified restore
  exists — see the rule in the `deploy-verify-rollback` skill.

## Tests

```bash
bash tools/backup/remote-dump.test.sh
bash tools/backup/db-backup.test.sh
bash tools/backup/restore-drill.test.sh
bash tools/backup/offsite-pull.test.sh
bash tools/backup/notify-failure.test.sh
```

All five run inside the test image on every push (step "Backup contour" in
`.github/workflows/ci.yml`) and again at the start of the backup and drill jobs.
