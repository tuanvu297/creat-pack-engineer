#!/bin/bash
# Runs the gateway RPC SQL integration tests on a real local PostgreSQL.
# The Muse VM user is root and PostgreSQL refuses to run as root, and the
# workspace mounts restrict the postgres user's access — so the test tree is
# copied to /tmp, made world-readable, and executed as the postgres user.
# Nothing here touches any deployed system.
set -euo pipefail
SRC_GW="$HOME/workspace/agy-glseo-route-qualify-20261027/gateway-candidate"
SRC_TOOLS="$HOME/workspace/agy-glseo-route-qualify-20261027/gateway-candidate/test-tools"
DST=/tmp/agy-gw-test
rm -rf "$DST" /tmp/agy-gw-pgdata
mkdir -p "$DST"
cp -r "$SRC_GW/." "$DST/gateway-candidate"
mkdir -p "$DST/tools"
cp -r "$SRC_TOOLS/node_modules" "$DST/tools/node_modules"
cp "$SRC_TOOLS/package.json" "$DST/tools/package.json" 2>/dev/null || true
cp "$DST/gateway-candidate/test/sql/run-rpc-tests.mjs" "$DST/tools/run-rpc-tests.mjs"
chmod -R a+rx "$DST"
chown -R postgres:postgres "$DST" 2>/dev/null || chown -R postgres "$DST"
su postgres -s /bin/bash -c "cd $DST/tools && GW_ROOT=$DST/gateway-candidate node $DST/tools/run-rpc-tests.mjs" 2>&1 | grep -v Warning
