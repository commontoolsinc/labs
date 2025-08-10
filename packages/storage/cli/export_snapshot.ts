#!/usr/bin/env -S deno run -A

// new-storage:export-snapshot --space --doc --branch --seq --out
// Exports Automerge binary for a document branch at a specific seq to a file.

import { parseArgs } from "jsr:@std/cli/parse-args";
import { openSqlite } from "../src/sqlite/db.ts";
import { getAutomergeBytesAtSeq } from "../src/sqlite/pit.ts";

function usage() {
  console.error(
    "Usage: export-snapshot --space <space> --doc <doc> --branch <branch> --seq <n> --out <file>",
  );
  Deno.exit(2);
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["space", "doc", "branch", "out", "seq"],
    alias: {},
    default: {},
  });
  const space = args.space as string | undefined;
  const doc = args.doc as string | undefined;
  const branch = args.branch as string | undefined;
  const out = args.out as string | undefined;
  const seqStr = args.seq as string | undefined;

  if (!space || !doc || !branch || !out || !seqStr) usage();
  const seq = Number(seqStr);
  if (!Number.isFinite(seq) || seq < 0) usage();

  const envDir = Deno.env.get("SPACES_DIR");
  const base = envDir
    ? new URL(envDir)
    : new URL(`.spaces/`, `file://${Deno.cwd()}/`);
  await Deno.mkdir(base, { recursive: true }).catch(() => {});
  const { db, close } = await openSqlite({
    url: new URL(`./${space}.sqlite`, base),
  });
  try {
    const bytes = getAutomergeBytesAtSeq(
      db,
      null,
      doc as string,
      branch as string,
      seq,
    );
    await Deno.writeFile(out as string, bytes);
    console.log(`wrote ${bytes.length} bytes to ${out}`);
  } finally {
    await close();
  }
}
