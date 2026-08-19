#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --allow-env --allow-net
/**
 * Runs a command and spools one record from its exit code:
 *
 *   deno task run-recorded <kind> <scope> <name> -- <command...>
 *
 * This is the producer for command-level checks — format, lint, the
 * whole-tree type check, every repository gate — and the escape hatch for
 * anything future that has no native reporter. The command's exit code is
 * the wrapper's exit code; recording failures warn and change nothing.
 *
 * Inside an enclosing run (CF_TEST_RECORDS_DIR set, as CI jobs do) the
 * wrapper joins it as a producer. Otherwise, with a personal key present,
 * it owns a run of its own: it stamps a spool, ships it afterward, and
 * sweeps for orphans. With neither, it only runs the command.
 */

import { FragmentWriter } from "@commonfabric/test-support/records";
import {
  finishRunRecording,
  recordingChildEnv,
  startRunRecording,
} from "./test-records.ts";

function usage(): never {
  console.error(
    "usage: deno task run-recorded <kind> <scope> <name> -- <command...>",
  );
  Deno.exit(2);
}

async function main(): Promise<void> {
  const args = [...Deno.args];
  const kind = args.shift();
  const scope = args.shift();
  const name = args.shift();
  // Empty identity components are rejected here, loudly: the record schema
  // requires non-empty parts, so a record built from one would be dropped
  // by every reader and the command would silently vanish from history.
  if (
    kind === undefined || kind.length === 0 ||
    scope === undefined || scope.length === 0 ||
    name === undefined || name.length === 0
  ) {
    usage();
  }
  if (args.shift() !== "--") usage();
  if (args.length === 0) usage();

  const recording = await startRunRecording();
  const childEnv = recordingChildEnv(recording);

  // A root deno task runs with the workspace root as its working
  // directory and the invoker's directory in INIT_CWD. The wrapped
  // command belongs where the caller stood — a member-directory step
  // wrapping `deno task <member task>` must resolve that member's task.
  const initCwd = Deno.env.get("INIT_CWD");
  const childCwd = initCwd !== undefined && initCwd.length > 0
    ? initCwd
    : Deno.cwd();

  const startedAt = performance.now();
  let code = 1;
  try {
    const child = new Deno.Command(args[0]!, {
      args: args.slice(1),
      cwd: childCwd,
      env: childEnv,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    code = (await child.status).code;
  } catch (error) {
    console.error(`run-recorded: cannot run ${args[0]}: ${error}`);
    code = 127;
  }
  const durationMs = performance.now() - startedAt;

  try {
    const dir = recording.mode === "join"
      ? recording.dir
      : recording.mode === "own"
      ? recording.spool.dir
      : undefined;
    if (dir !== undefined) {
      const writer = FragmentWriter.open(dir);
      writer?.append({
        line: "record",
        test: { k: kind, s: scope, n: name },
        outcome: code === 0 ? "pass" : "fail",
        durationMs: Math.round(durationMs),
      });
      writer?.close();
    }
    await finishRunRecording(recording);
  } catch (error) {
    console.warn(`test records: recording ${name} failed: ${error}`);
  }

  Deno.exit(code);
}

if (import.meta.main) {
  await main();
}
