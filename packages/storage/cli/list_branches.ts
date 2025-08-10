#!/usr/bin/env -S deno run -A

// new-storage:list-branches --space <space>

import { parseArgs } from "jsr:@std/cli/parse-args";
import { openSqlite } from "../src/sqlite/db.ts";

function usage() {
  console.error("Usage: list-branches --space <space>");
  Deno.exit(2);
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, { string: ["space"] });
  const space = args.space as string | undefined;
  if (!space) usage();

  const envDir = Deno.env.get("SPACES_DIR");
  const base = envDir
    ? new URL(envDir)
    : new URL(`.spaces/`, `file://${Deno.cwd()}/`);
  const { db, close } = await openSqlite({
    url: new URL(`./${space}.sqlite`, base),
  });
  try {
    const rows = db.prepare(
      `SELECT d.doc_id AS doc, b.name AS branch, h.seq_no AS seq_no
       FROM branches b
       JOIN docs d ON (b.doc_id = d.doc_id)
       JOIN am_heads h ON (h.branch_id = b.branch_id)
       ORDER BY d.doc_id, b.name`,
    ).all() as Array<{ doc: string; branch: string; seq_no: number }>;
    for (const r of rows) console.log(`${r.doc}\t${r.branch}\t${r.seq_no}`);
  } finally {
    await close();
  }
}
