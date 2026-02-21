#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env

/**
 * Deno-specific runner for the object hashing benchmark.
 *
 * This script executes the benchmark in Deno environment.
 *
 * Usage:
 *   deno run --allow-net --allow-read --allow-env scripts/benchmark-object-hashing/deno.ts
 */

import "./main.ts";
