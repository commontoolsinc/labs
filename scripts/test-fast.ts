#!/usr/bin/env -S deno run --allow-read --allow-run
import { ALL_DISABLED, runTests } from "../tasks/test.ts";

const FAST_DISABLED = [
  ...ALL_DISABLED,
  "iframe-sandbox",
  "deno-web-test",
];

await runTests(FAST_DISABLED);
