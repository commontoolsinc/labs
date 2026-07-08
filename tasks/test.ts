#!/usr/bin/env -S deno run --allow-read --allow-run --allow-env
// Entry point for the root `deno task test`. The implementation lives in
// workspace-tests.ts because `deno coverage` skips files whose names end in
// test.ts, and the coverage-debt metric scores an unmeasured file as fully
// uncovered.
import { main } from "./workspace-tests.ts";

if (import.meta.main) {
  await main();
}
