// `cf inspect` — offline autopsy of local memory v2 space DBs.
//
// Thin CLI surface over @commonfabric/state-inspector. Reads the durable SQLite
// store the server already wrote (no live runtime, no capture) and answers
// who/what/when + cross-space convergence questions. Every command takes --json.
//
// Space DBs are auto-discovered (no need to pass absolute paths): pass a DID or
// DID-prefix as <space>, or a file path. `cf inspect spaces` lists what's found.

import { Command } from "@cliffy/command";
import { Table } from "@cliffy/table";
import {
  annotate,
  buildCrossSpaceLinkIndex,
  type ConvergenceResult,
  convergence,
  convergenceScan,
  discoverSpaceDbs,
  entityHistory,
  getValueAt,
  hotEntities,
  listCommits,
  listSqliteFiles,
  openSpace,
  openSpaces,
  quickStats,
  resolveSpacePath,
  type SpaceRef,
  summarizeSpace,
} from "@commonfabric/state-inspector";

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}G`;
}

function out(json: boolean, data: unknown, render: () => void): void {
  if (json) console.log(JSON.stringify(data, null, 2));
  else render();
}

function splitPath(p?: string): string[] {
  return p ? p.split("/").filter(Boolean) : [];
}

// Resolve --all / --spaces / --dir into open spaces; caller must close them.
function resolveMultiSpaces(opts: {
  all?: boolean;
  spaces?: string;
  dir?: string;
}): SpaceRef[] {
  if (opts.dir) return openSpaces(listSqliteFiles(opts.dir));
  if (opts.all) return openSpaces(discoverSpaceDbs().map((s) => s.path));
  if (opts.spaces) {
    const discovered = discoverSpaceDbs();
    const paths = opts.spaces
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => resolveSpacePath(t, discovered));
    return openSpaces(paths);
  }
  throw new Error("provide --all, --spaces <a,b,…>, or --dir <dir>");
}

function relTag(r: ConvergenceResult): string {
  return r.relationship === "cross-space-linked"
    ? "DRIFT"
    : r.relationship === "no-cross-space-link"
    ? "instance?"
    : "?";
}

export const inspect = new Command()
  .name("inspect")
  .description(
    "Offline autopsy of local memory v2 space DBs (state, history, convergence).",
  )
  .default("help")
  .globalOption("--json", "Output machine-readable JSON.")
  /* inspect spaces */
  .command("spaces", "List discovered local space DBs with quick stats.")
  .option("--dir <dir:string>", "Extra directory to search for *.sqlite files.")
  .action((options) => {
    const discovered = discoverSpaceDbs(
      options.dir ? { dirs: [options.dir] } : {},
    );
    const rows = discovered.map((s) => {
      const stats = quickStats(s.path);
      return {
        did: s.did,
        path: s.path,
        sizeBytes: s.sizeBytes,
        commits: stats?.commits ?? null,
        entities: stats?.entities ?? null,
        lastActivity: stats?.lastActivity ?? null,
      };
    });
    out(!!options.json, rows, () => {
      if (rows.length === 0) {
        console.log(
          "no space DBs found (set MEMORY_DIR, pass --dir, or run from a repo with cache/memory/…).",
        );
        return;
      }
      console.log(
        Table.from([
          ["DID", "SIZE", "COMMITS", "ENTITIES", "LAST ACTIVITY"],
          ...rows.map((r) => [
            r.did,
            humanSize(r.sizeBytes),
            String(r.commits ?? "?"),
            String(r.entities ?? "?"),
            r.lastActivity ?? "?",
          ]),
        ]).toString(),
      );
    });
  })
  /* inspect summary */
  .command("summary <space:string>", "Space overview: commits, sessions, hot ops.")
  .action((options, space) => {
    const s = openSpace(resolveSpacePath(space));
    try {
      const sum = summarizeSpace(s);
      out(!!options.json, sum, () => {
        console.log(`space: ${sum.path}`);
        console.log(
          `commits: ${sum.commits}` +
            (sum.commitSeqRange
              ? ` (seq ${sum.commitSeqRange[0]}–${sum.commitSeqRange[1]})`
              : ""),
        );
        console.log(`sessions: ${sum.sessions}`);
        console.log(`entities: ${sum.entities}  revisions: ${sum.revisions}`);
        console.log(
          `ops: ${Object.entries(sum.ops).map(([k, v]) => `${k}=${v}`).join(" ")}`,
        );
        console.log(
          `branches: ${sum.branches.map((b) => `${b.name || "(default)"}@${b.head_seq}`).join(" ")}`,
        );
        console.log(`scheduler tables: ${sum.hasSchedulerTables ? "yes" : "no"}`);
      });
    } finally {
      s.close();
    }
  })
  /* inspect commits */
  .command("commits <space:string>", "Recent commits (who committed, ops, reads).")
  .option("--session <prefix:string>", "Filter by session id prefix.")
  .option("--limit <n:number>", "Max rows.", { default: 50 })
  .action((options, space) => {
    const s = openSpace(resolveSpacePath(space));
    try {
      const rows = listCommits(s, { session: options.session, limit: options.limit });
      out(!!options.json, rows, () => {
        for (const r of rows) {
          console.log(
            `#${r.seq}\t${r.session.slice(0, 14)}\tlocal=${r.localSeq}\tops=${r.ops}\treads=${r.reads}\t${r.createdAt}`,
          );
        }
      });
    } finally {
      s.close();
    }
  })
  /* inspect hot */
  .command("hot <space:string>", "Entities ranked by write count (contention proxy).")
  .option("--limit <n:number>", "Max rows.", { default: 20 })
  .option("--branch <branch:string>", "Branch (default: '').")
  .action((options, space) => {
    const s = openSpace(resolveSpacePath(space));
    try {
      const rows = hotEntities(s, { limit: options.limit, branch: options.branch });
      out(!!options.json, rows, () => {
        for (const r of rows) {
          console.log(`${r.writes}\twrites\t${r.sessions} sessions\t${r.id}\t(${r.scope})`);
        }
      });
    } finally {
      s.close();
    }
  })
  /* inspect history */
  .command("history <space:string> <entity:string>", "Every write that touched an entity.")
  .option("--scope <scope:string>", "Scope key (default: space).")
  .option("--branch <branch:string>", "Branch (default: '').")
  .option("--limit <n:number>", "Max rows.", { default: 200 })
  .action((options, space, entity) => {
    const s = openSpace(resolveSpacePath(space));
    try {
      const rows = entityHistory(s, {
        id: entity,
        scope: options.scope,
        branch: options.branch,
        limit: options.limit,
      });
      out(!!options.json, rows, () => {
        for (const r of rows) {
          console.log(
            `seq=${r.seq}\tcommit=${r.commitSeq}\t${r.op}\t${r.session.slice(0, 14)}\tlocal=${r.localSeq}\t${r.createdAt}`,
          );
        }
      });
    } finally {
      s.close();
    }
  })
  /* inspect value-at */
  .command(
    "value-at <space:string> <entity:string>",
    "Reconstructed value of an entity at a seq.",
  )
  .option("--seq <n:number>", "Reconstruct as of this commit seq (default: latest).")
  .option("--path <path:string>", "Navigate into value, e.g. value/count.")
  .option("--scope <scope:string>", "Scope key (default: space).")
  .option("--branch <branch:string>", "Branch (default: '').")
  .option("--doc", "Show the whole document, not just value.")
  .action((options, space, entity) => {
    const s = openSpace(resolveSpacePath(space));
    try {
      const res = getValueAt(
        s,
        { id: entity, scope: options.scope, branch: options.branch, atSeq: options.seq },
        splitPath(options.path),
      );
      const shown = options.doc ? res.document : res.value;
      out(!!options.json, { exists: res.exists, value: annotate(shown) }, () => {
        if (!res.exists) console.log("(absent at this seq)");
        else if (shown === undefined) console.log("(entity present, but nothing at that path)");
        else console.log(JSON.stringify(annotate(shown), null, 2));
      });
    } finally {
      s.close();
    }
  })
  /* inspect converge */
  .command("converge <entity:string>", "Compare an entity's value across spaces.")
  .option("--all", "Use all discovered spaces.")
  .option("--spaces <list:string>", "Comma-separated DIDs/prefixes/paths.")
  .option("--dir <dir:string>", "Directory of *.sqlite files.")
  .option("--path <path:string>", "Navigate into value, e.g. value/count.")
  .option("--scope <scope:string>", "Scope key (default: space).")
  .option("--branch <branch:string>", "Branch (default: '').")
  .action((options, entity) => {
    const refs = resolveMultiSpaces(options);
    try {
      const index = buildCrossSpaceLinkIndex(refs, {
        scope: options.scope,
        branch: options.branch,
      });
      const r = convergence(
        refs,
        { id: entity, scope: options.scope, branch: options.branch, path: splitPath(options.path) },
        index,
      );
      out(!!options.json, r, () => {
        console.log(
          `verdict: ${r.verdict.toUpperCase()}` +
            (r.relationship && r.relationship !== "n/a" ? `  [${r.relationship}]` : ""),
        );
        console.log(`entity:  ${r.id}` + (r.path.length ? `  path=/${r.path.join("/")}` : ""));
        for (const v of r.views) {
          if (!v.present) {
            console.log(`  ${v.label}\tABSENT`);
            continue;
          }
          const cluster = r.clusters.findIndex((c) => c.valueKey === v.valueKey) + 1;
          console.log(
            `  ${v.label}\thead=${v.headSeq}\trevs=${v.revisions}\tlast=${(v.lastSession ?? "?").slice(0, 14)}\tcluster#${cluster}`,
          );
        }
        console.log(`note: ${r.caveat}`);
      });
    } finally {
      for (const ref of refs) ref.space.close();
    }
  })
  /* inspect converge-scan */
  .command("converge-scan", "Find entities present in >=2 spaces that diverge.")
  .option("--all", "Use all discovered spaces.")
  .option("--spaces <list:string>", "Comma-separated DIDs/prefixes/paths.")
  .option("--dir <dir:string>", "Directory of *.sqlite files.")
  .option("--limit <n:number>", "Max findings.", { default: 50 })
  .option("--branch <branch:string>", "Branch (default: '').")
  .action((options) => {
    const refs = resolveMultiSpaces(options);
    try {
      const result = convergenceScan(refs, { limit: options.limit, branch: options.branch });
      out(!!options.json, result, () => {
        console.log(
          `shared entities (in >=2 spaces): ${result.sharedEntities}  examined: ${result.examined}`,
        );
        console.log(
          `cross-space link edges: ${result.crossSpaceLinkEdges}  ` +
            `(${result.linkedFindings} real-drift / ${result.unlinkedFindings} likely-independent)`,
        );
        console.log(`findings (diverged/partial): ${result.findings.length}`);
        for (const f of result.findings) {
          const present = f.views.filter((v) => v.present).length;
          const missing = f.views.length - present;
          console.log(
            `  ${f.verdict.toUpperCase()}\t${relTag(f)}\t${f.id}\tpresent=${present}` +
              (missing ? `\tmissing=${missing}` : "") +
              `\tclusters=${f.clusters.length}`,
          );
        }
      });
    } finally {
      for (const ref of refs) ref.space.close();
    }
  });
