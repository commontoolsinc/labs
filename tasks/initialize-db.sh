#!/usr/bin/env bash
set -e

# This script runs a noop deno script to import @db/sqlite,
# ensuring the underlying binary has been fetched from the network.

# The sqlite dependency is only a @commontools/memory dependency.
# Execute within that directory.
cd packages/memory
script="import { Database } from '@db/sqlite';
const db = await new Database(':memory:');
await db.exec('CREATE TABLE foo (bar TEXT); INSERT INTO foo VALUES (\'baz\');');
await db.close();"
echo $script | deno run -A -
