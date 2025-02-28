#!/usr/bin/env bash

cd common-builder
deno test
cd -

cd common-charm
deno test
cd -

# DISABLED until tests pass (memory_test.ts)
# cd common-cli
# deno test
# cd -

# DISABLED until we get jsx in tests working
#cd common-html
#deno test
#cd -

# DISABLED until we get browser tests working
# cd common-identity
# deno task test-browser
# cd -

# DISABLED until we get browser tests working
# cd common-iframe-sandbox
# deno task test-browser
# cd -

cd common-memory
deno task test
cd -

cd common-os-ui
deno test
cd -

# DISABLED due to redis dependency, handled in different CI flow
# cd toolshed
# deno task test
# cd -
