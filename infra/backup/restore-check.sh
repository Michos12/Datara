#!/bin/sh
# Backup restore test (NFR-REL-03): dump the database, restore it into a scratch database on the
# same server, and compare the row count of every table. Exits non-zero on any difference.
#
#   Local (production compose):  sh infra/backup/restore-check.sh
#   Another target:              COMPOSE_FILE=docker-compose.yml DB_USER=... sh infra/backup/restore-check.sh
#
# On Render, restore a backup to a new database (Dashboard → database → Recovery), then run the
# same count comparison against it with psql (docs/08-deployment.md, "Verify a backup").
set -eu

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
DB_SERVICE="${DB_SERVICE:-db}"
DB_USER="${DB_USER:-insights_owner}"
DB_NAME="${DB_NAME:-customer_insights}"
SCRATCH="${DB_NAME}_restore_check"

run() { docker compose -f "$COMPOSE_FILE" exec -T "$DB_SERVICE" "$@"; }
counts() {
  run psql -U "$DB_USER" -d "$1" -At -c "
    SELECT string_agg(format('%s=%s', table_name,
             (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I', table_name), false, true, '')))[1]::text),
           ' ' ORDER BY table_name)
    FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
}

echo "dumping $DB_NAME…"
start=$(date +%s)
run pg_dump -U "$DB_USER" -d "$DB_NAME" -Fc -f /tmp/restore-check.dump
size=$(run sh -c 'du -h /tmp/restore-check.dump | cut -f1')
echo "restoring into $SCRATCH…"
run dropdb -U "$DB_USER" --if-exists "$SCRATCH"
run createdb -U "$DB_USER" "$SCRATCH"
run pg_restore -U "$DB_USER" -d "$SCRATCH" --exit-on-error /tmp/restore-check.dump
elapsed=$(( $(date +%s) - start ))

source_counts=$(counts "$DB_NAME")
restored_counts=$(counts "$SCRATCH")
run dropdb -U "$DB_USER" "$SCRATCH"
run rm -f /tmp/restore-check.dump

tables=$(echo "$source_counts" | wc -w | tr -d ' ')
rows=$(echo "$source_counts" | tr ' ' '\n' | cut -d= -f2 | awk '{ s += $1 } END { print s }')
if [ "$source_counts" = "$restored_counts" ]; then
  echo "OK: $tables tables, $rows rows restored identically (dump $size, ${elapsed}s)"
else
  echo "MISMATCH"
  echo "source:   $source_counts"
  echo "restored: $restored_counts"
  exit 1
fi
