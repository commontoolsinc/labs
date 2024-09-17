#!/bin/bash
killall deno
deno run --allow-net --allow-read --allow-write --allow-env --allow-run server.ts &
deno run --allow-net --allow-read --allow-write --allow-env --allow-run main.ts
