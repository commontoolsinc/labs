#!/usr/bin/env -S deno run --allow-read --allow-run
import { ALL_DISABLED, runTests } from "../tasks/workspace-tests.ts";

const FAST_DISABLED = [
  ...ALL_DISABLED,
  "iframe-sandbox",
  "deno-web-test",
];

const passed = await runTests(FAST_DISABLED);
if (!passed) Deno.exit(1);
