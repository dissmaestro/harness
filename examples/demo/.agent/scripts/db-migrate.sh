#!/usr/bin/env bash
# @name: db-migrate
# @description: Create a new timestamped SQL migration file in migrations/
# @tags: database, sql, migration, schema
# @arg name: string (required) — short migration name, e.g. add_users_table
set -euo pipefail
name="${1:?name is required}"
mkdir -p migrations
file="migrations/$(date +%Y%m%d%H%M%S)_${name}.sql"
printf -- '-- migrate:up\n\n-- migrate:down\n' > "$file"
echo "created $file"
