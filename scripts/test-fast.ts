#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net
import {
  RECORDS_DIR_VARIABLE,
  recordsDir,
} from "@commonfabric/test-support/records";
import {
  finishRunRecording,
  startRunRecording,
} from "../tasks/test-records.ts";
import { ALL_DISABLED, runTests } from "../tasks/workspace-tests.ts";

const FAST_DISABLED = [
  ...ALL_DISABLED,
  "iframe-sandbox",
  "deno-web-test",
];

const recording = await startRunRecording();
if (recording.mode === "own" && recordsDir() === undefined) {
  Deno.env.set(RECORDS_DIR_VARIABLE, recording.spool.dir);
}
let passed = false;
try {
  passed = await runTests(FAST_DISABLED);
} finally {
  await finishRunRecording(recording);
}
if (!passed) Deno.exit(1);
