#!/bin/sh
# Local PostgreSQL for the indexer. Rerun-safe. Needs a running server you may create databases on (psql/createdb on PATH).
#   schema.sql   the blueprint's reference DDL, verbatim (schema `maskbid`, group roles, row level security)
#   logins       maskbid_indexer_app (writes projections) and maskbid_api_app (reads them); no passwords, so this
#                relies on local trust authentication. Anywhere else, create your own logins and set DATABASE_URL.
set -e
cd "$(dirname "$0")"
DB=${MASKBID_DB:-maskbid}
psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1 || createdb "$DB"
psql -d "$DB" -tAc "SELECT 1 FROM pg_namespace WHERE nspname='maskbid'" | grep -q 1 || psql -v ON_ERROR_STOP=1 -q -d "$DB" -f schema.sql
psql -v ON_ERROR_STOP=1 -q -d "$DB" <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='maskbid_indexer_app') THEN CREATE ROLE maskbid_indexer_app LOGIN IN ROLE maskbid_indexer; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='maskbid_api_app') THEN CREATE ROLE maskbid_api_app LOGIN IN ROLE maskbid_api; END IF;
END $$;
SQL
# The deployment row belongs to the database owner; the indexer login can only read it.
SOURCE_COMMIT=${SOURCE_COMMIT:-$(git rev-parse HEAD)} node src/index.ts --deployment-sql | psql -v ON_ERROR_STOP=1 -q -d "$DB"
echo "database $DB ready for chain ${CHAIN_ID:-1313161555}"
