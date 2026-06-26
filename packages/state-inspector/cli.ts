#!/usr/bin/env -S deno run --allow-read --allow-ffi --allow-env
// Thin CLI over the inspector library. Agent-first: every command also takes
// --json so a caller can consume structured output. This is a prototype entry
// point; the intent is to later surface the same commands as `cf inspect …`.
//
//   deno task inspect summary  <db>
//   deno task inspect commits  <db> [--session <prefix>] [--limit <n>]
//   deno task inspect hot      <db> [--limit <n>] [--branch <b>]
//   deno task inspect history  <db> <entity-id> [--scope <s>] [--branch <b>]
//   deno task inspect value-at <db> <entity-id> [--seq <n>] [--path a/b/c]
//                              [--scope <s>] [--branch <b>] [--doc]

import { openSpace } from "./db.ts";
import { annotate } from "./decode.ts";
import {
  entityHistory,
  hotEntities,
  listCommits,
  summarizeSpace,
} from "./queries.ts";
import { getValueAt } from "./reconstruct.ts";

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const str = (v: string | boolean | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;
const num = (v: string | boolean | undefined): number | undefined =>
  typeof v === "string" ? Number(v) : undefined;

function out(json: boolean, data: unknown, render: () => void) {
  if (json) console.log(JSON.stringify(data, null, 2));
  else render();
}

const USAGE = `cf state-inspector (prototype)

  summary  <db>
  commits  <db> [--session <prefix>] [--limit <n>] [--json]
  hot      <db> [--limit <n>] [--branch <b>] [--json]
  history  <db> <entity-id> [--scope <s>] [--branch <b>] [--limit <n>] [--json]
  value-at <db> <entity-id> [--seq <n>] [--path a/b/c] [--scope <s>]
                            [--branch <b>] [--doc] [--json]
`;

function main(argv: string[]): number {
  const { positional, flags } = parseArgs(argv);
  const [cmd, dbPath, ...rest] = positional;
  const json = flags.json === true;

  if (!cmd || cmd === "help" || flags.help) {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  if (!dbPath) {
    console.error("error: missing <db> path\n");
    console.log(USAGE);
    return 1;
  }

  const space = openSpace(dbPath);
  try {
    switch (cmd) {
      case "summary": {
        const s = summarizeSpace(space);
        out(json, s, () => {
          console.log(`space: ${s.path}`);
          console.log(
            `commits: ${s.commits}` +
              (s.commitSeqRange
                ? ` (seq ${s.commitSeqRange[0]}–${s.commitSeqRange[1]})`
                : ""),
          );
          console.log(`sessions: ${s.sessions}`);
          console.log(`entities: ${s.entities}  revisions: ${s.revisions}`);
          console.log(
            `ops: ${Object.entries(s.ops).map(([k, v]) => `${k}=${v}`).join(" ")}`,
          );
          console.log(
            `scopes: ${s.scopes.map((sc) => `${sc.scope_key}=${sc.count}`).join(" ")}`,
          );
          console.log(
            `branches: ${s.branches.map((b) => `${b.name || "(default)"}@${b.head_seq}`).join(" ")}`,
          );
          console.log(`scheduler tables: ${s.hasSchedulerTables ? "yes" : "no"}`);
        });
        return 0;
      }
      case "commits": {
        const rows = listCommits(space, {
          session: str(flags.session),
          limit: num(flags.limit),
        });
        out(json, rows, () => {
          for (const r of rows) {
            console.log(
              `#${r.seq}\t${r.session.slice(0, 14)}\tlocal=${r.localSeq}\tops=${r.ops}\treads=${r.reads}\t${r.createdAt}`,
            );
          }
        });
        return 0;
      }
      case "hot": {
        const rows = hotEntities(space, {
          limit: num(flags.limit),
          branch: str(flags.branch),
        });
        out(json, rows, () => {
          for (const r of rows) {
            console.log(
              `${r.writes}\twrites\t${r.sessions} sessions\t${r.id}\t(${r.scope})`,
            );
          }
        });
        return 0;
      }
      case "history": {
        const id = rest[0];
        if (!id) {
          console.error("error: history needs <entity-id>");
          return 1;
        }
        const rows = entityHistory(space, {
          id,
          scope: str(flags.scope),
          branch: str(flags.branch),
          limit: num(flags.limit),
        });
        out(json, rows, () => {
          for (const r of rows) {
            console.log(
              `seq=${r.seq}\tcommit=${r.commitSeq}\t${r.op}\t${r.session.slice(0, 14)}\tlocal=${r.localSeq}\t${r.createdAt}`,
            );
          }
        });
        return 0;
      }
      case "value-at": {
        const id = rest[0];
        if (!id) {
          console.error("error: value-at needs <entity-id>");
          return 1;
        }
        const path = str(flags.path)
          ? str(flags.path)!.split("/").filter(Boolean)
          : [];
        const res = getValueAt(
          space,
          {
            id,
            scope: str(flags.scope),
            branch: str(flags.branch),
            atSeq: num(flags.seq),
          },
          path,
        );
        const shown = flags.doc === true ? res.document : res.value;
        out(json, { exists: res.exists, value: annotate(shown) }, () => {
          if (!res.exists) {
            console.log("(absent at this seq)");
            return;
          }
          if (shown === undefined) {
            console.log("(entity present, but nothing at that path)");
            return;
          }
          console.log(JSON.stringify(annotate(shown), null, 2));
        });
        return 0;
      }
      default:
        console.error(`unknown command: ${cmd}\n`);
        console.log(USAGE);
        return 1;
    }
  } finally {
    space.close();
  }
}

if (import.meta.main) {
  Deno.exit(main(Deno.args));
}
