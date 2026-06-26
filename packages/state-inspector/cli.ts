#!/usr/bin/env -S deno run --allow-read --allow-ffi --allow-env
// Thin CLI over the inspector library. Agent-first: every command also takes
// --json so a caller can consume structured output. This is a prototype entry
// point; the intent is to later surface the same commands as `cf inspect …`.
//
// Single-space:
//   inspect summary  <db>
//   inspect commits  <db> [--session <prefix>] [--limit <n>]
//   inspect hot      <db> [--limit <n>] [--branch <b>]
//   inspect history  <db> <entity-id> [--scope <s>] [--branch <b>]
//   inspect value-at <db> <entity-id> [--seq <n>] [--path a/b/c] [--doc]
// Multi-space (cross-space convergence):
//   inspect converge      <entity-id> --spaces a.sqlite,b.sqlite [--path a/b/c]
//   inspect converge      <entity-id> --dir <dir-of-sqlite>
//   inspect converge-scan --dir <dir> [--limit <n>] [--branch <b>]

import { openSpace } from "./db.ts";
import { annotate, summarize } from "./decode.ts";
import {
  entityHistory,
  hotEntities,
  listCommits,
  summarizeSpace,
} from "./queries.ts";
import { getValueAt } from "./reconstruct.ts";
import {
  convergence,
  convergenceScan,
  listSqliteFiles,
  openSpaces,
  type SpaceRef,
} from "./multispace.ts";

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
const splitPath = (v: string | boolean | undefined): string[] =>
  str(v) ? str(v)!.split("/").filter(Boolean) : [];

function out(json: boolean, data: unknown, render: () => void) {
  if (json) console.log(JSON.stringify(data, null, 2));
  else render();
}

const USAGE = `cf state-inspector (prototype)

single-space:
  summary  <db>
  commits  <db> [--session <prefix>] [--limit <n>] [--json]
  hot      <db> [--limit <n>] [--branch <b>] [--json]
  history  <db> <entity-id> [--scope <s>] [--branch <b>] [--limit <n>] [--json]
  value-at <db> <entity-id> [--seq <n>] [--path a/b/c] [--scope <s>]
                            [--branch <b>] [--doc] [--json]

cross-space convergence:
  converge      <entity-id> (--spaces a,b,… | --dir <dir>) [--path a/b/c]
                            [--scope <s>] [--branch <b>] [--json]
  converge-scan (--spaces a,b,… | --dir <dir>) [--limit <n>] [--scope <s>]
                            [--branch <b>] [--json]
`;

function resolveSpaces(flags: Record<string, string | boolean>): SpaceRef[] {
  const dir = str(flags.dir);
  const spaces = str(flags.spaces);
  if (dir) return openSpaces(listSqliteFiles(dir));
  if (spaces) return openSpaces(spaces.split(",").map((s) => s.trim()).filter(Boolean));
  throw new Error("provide --spaces a,b,… or --dir <dir>");
}

function runMultiSpace(cmd: string, rest: string[], flags: Record<string, string | boolean>, json: boolean): number {
  let refs: SpaceRef[];
  try {
    refs = resolveSpaces(flags);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }
  if (refs.length === 0) {
    console.error("error: no space DBs resolved");
    return 1;
  }
  try {
    if (cmd === "converge") {
      const id = rest[0];
      if (!id) {
        console.error("error: converge needs <entity-id>");
        return 1;
      }
      const result = convergence(refs, {
        id,
        scope: str(flags.scope),
        branch: str(flags.branch),
        path: splitPath(flags.path),
      });
      out(json, result, () => {
        console.log(`verdict: ${result.verdict.toUpperCase()}`);
        console.log(`entity:  ${result.id}  scope=${result.scope}  branch=${result.branch || "(default)"}` +
          (result.path.length ? `  path=/${result.path.join("/")}` : ""));
        for (const v of result.views) {
          if (!v.present) {
            console.log(`  ${v.label}\tABSENT`);
            continue;
          }
          const cluster = result.clusters.findIndex((c) => c.valueKey === v.valueKey) + 1;
          console.log(
            `  ${v.label}\thead=${v.headSeq}\trevs=${v.revisions}\tlast=${(v.lastSession ?? "?").slice(0, 14)}@${v.lastWriteAt ?? "?"}\tcluster#${cluster}`,
          );
        }
        if (result.clusters.length > 1) {
          console.log("clusters:");
          result.clusters.forEach((c, i) =>
            console.log(`  #${i + 1} [${c.labels.length}]\t${summarize(c.value)}`)
          );
        }
        console.log(`note: ${result.caveat}`);
      });
      return 0;
    }
    if (cmd === "converge-scan") {
      const result = convergenceScan(refs, {
        scope: str(flags.scope),
        branch: str(flags.branch),
        limit: num(flags.limit),
      });
      out(json, result, () => {
        console.log(`shared entities (in >=2 spaces): ${result.sharedEntities}  examined: ${result.examined}`);
        console.log(`findings (diverged/partial): ${result.findings.length}`);
        for (const f of result.findings) {
          const present = f.views.filter((v) => v.present).map((v) => v.label);
          const absent = f.views.filter((v) => !v.present).map((v) => v.label);
          console.log(
            `  ${f.verdict.toUpperCase()}\t${f.id}\tpresent=[${present.join(",")}]` +
              (absent.length ? `\tmissing=[${absent.join(",")}]` : "") +
              `\tclusters=${f.clusters.length}`,
          );
        }
      });
      return 0;
    }
    console.error(`unknown command: ${cmd}`);
    return 1;
  } finally {
    for (const r of refs) r.space.close();
  }
}

function main(argv: string[]): number {
  const { positional, flags } = parseArgs(argv);
  const [cmd, ...rest] = positional;
  const json = flags.json === true;

  if (!cmd || cmd === "help" || flags.help) {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }

  if (cmd === "converge" || cmd === "converge-scan") {
    return runMultiSpace(cmd, rest, flags, json);
  }

  // Single-space commands take <db> as the first positional.
  const dbPath = rest[0];
  const tail = rest.slice(1);
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
        const id = tail[0];
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
        const id = tail[0];
        if (!id) {
          console.error("error: value-at needs <entity-id>");
          return 1;
        }
        const res = getValueAt(
          space,
          {
            id,
            scope: str(flags.scope),
            branch: str(flags.branch),
            atSeq: num(flags.seq),
          },
          splitPath(flags.path),
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
