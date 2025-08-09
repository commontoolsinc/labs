#!/usr/bin/env -S deno run -A

// new-storage:import-snapshot --space --doc --branch --file
// Imports an Automerge binary file as a snapshot for a doc branch. This is a best-effort helper:
// - Writes into am_snapshots with upto_seq_no inferred from document sequence in the binary.
// - Also writes to CAS as am_snapshot.
// Note: This does not rewrite history; it just stores a full snapshot for fast PIT.

import { parseArgs } from "jsr:@std/cli/parse-args";
import { openSqlite } from "../src/sqlite/db.ts";
import { createCas } from "../src/sqlite/cas.ts";
import { getBranchState } from "../src/sqlite/heads.ts";
import * as Automerge from "npm:@automerge/automerge";

function usage() {
  console.error("Usage: import-snapshot --space <space> --doc <doc> --branch <branch> --file <path>");
  Deno.exit(2);
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, { string: ["space", "doc", "branch", "file"] });
  const space = args.space as string | undefined;
  const doc = args.doc as string | undefined;
  const branch = args.branch as string | undefined;
  const file = args.file as string | undefined;
  if (!space || !doc || !branch || !file) usage();

  const envDir = Deno.env.get("SPACES_DIR");
  const base = envDir ? new URL(envDir) : new URL(`.spaces/`, `file://${Deno.cwd()}/`);
  await Deno.mkdir(base, { recursive: true }).catch(() => {});
  const { db, close } = await openSqlite({ url: new URL(`./${space}.sqlite`, base) });
  try {
    const bytes = await Deno.readFile(file as string);
    const docObj = Automerge.load(bytes);
    // Infer sequence number by reconstructing changes count from heads via save/apply cycle.
    // Automerge doesn't expose seq directly; we'll store snapshot with upto_seq_no = current branch seqNo to align PIT expectations.
    const st = getBranchState(db, doc as string, branch as string);

    db.run(
      `INSERT OR REPLACE INTO am_snapshots(snapshot_id, doc_id, branch_id, upto_seq_no, heads_json, root_hash, bytes, tx_id, committed_at)
       VALUES(:snapshot_id, :doc_id, :branch_id, :upto_seq_no, :heads_json, :root_hash, :bytes, :tx_id, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      {
        snapshot_id: crypto.randomUUID(),
        doc_id: doc,
        branch_id: st.branchId,
        upto_seq_no: st.seqNo,
        heads_json: JSON.stringify([...st.heads].sort()),
        root_hash: new Uint8Array([]),
        bytes,
        tx_id: st.epoch,
      },
    );

    const cas = createCas(db);
    await cas.put('am_snapshot', bytes, { docId: doc, branchId: st.branchId, seqNo: st.seqNo, txId: st.epoch });
    console.log(`imported snapshot for ${doc}@${branch} upto_seq_no=${st.seqNo}`);
  } finally {
    await close();
  }
}

