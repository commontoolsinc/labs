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
  buildInspectorBundle,
  buildSpaceGraph,
  convergence,
  type ConvergenceResult,
  convergenceScan,
  describePiece,
  diffEntity,
  discoverSpaceDbs,
  entityHistory,
  entityTimeline,
  getValueAt,
  graphToDot,
  groupDiscoveredSpaces,
  type GroupedSpace,
  hotEntities,
  listCommits,
  listEntityModels,
  listScopes,
  listSqliteFiles,
  openSpace,
  openSpaces,
  quickStats,
  renderInspectorHtml,
  resolveSpacePath,
  type Scope,
  scopeOverlay,
  type SpaceGraph,
  type SpaceRef,
  spaceTimeline,
  subgraphAround,
  summarize,
  summarizeSpace,
  valueAsIdentity,
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

// did:key:z6Mk…wQ2n  ->  z6Mk…wQ2n  (compact, still recognizable)
function shortDid(did: string): string {
  const tail = did.startsWith("did:key:") ? did.slice("did:key:".length) : did;
  return tail.length > 14 ? `${tail.slice(0, 8)}…${tail.slice(-4)}` : tail;
}

// A scope as a compact, human label: "space", "user z6Mk…", "session z6Mk…/abc".
function fmtScope(s: Scope): string {
  if (s.kind === "space") return "space";
  if (s.kind === "user") return `user ${shortDid(s.principal ?? "?")}`;
  if (s.kind === "session") {
    return `session ${shortDid(s.principal ?? "?")}/${
      (s.sessionId ?? "").slice(0, 8)
    }`;
  }
  return decodeURIComponent(s.raw).slice(0, 40);
}

// Session ids look like `session:did:key:<space>:<uuid>` (often %-encoded).
// Surface the short space DID + uuid head instead of a uniform truncation.
function fmtSession(s: string): string {
  const decoded = decodeURIComponent(s);
  const m = decoded.match(/^session:(did:key:)?([^:]+):([0-9a-f-]+)/i);
  if (m) {
    const did = m[2];
    const short = did.length > 12 ? `${did.slice(0, 6)}…${did.slice(-4)}` : did;
    return `${short}/${m[3].slice(0, 8)}`;
  }
  return decoded.length > 22 ? `${decoded.slice(0, 21)}…` : decoded;
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
  /* inspect group */
  .command(
    "group",
    "Group discovered space DBs into per-user worlds (home → profiles → main).",
  )
  .option("--dir <dir:string>", "Extra directory to search for *.sqlite files.")
  .option(
    "--did <prefix:string>",
    "Expand one user's world fully (match the principal DID).",
  )
  .action((options) => {
    const discovered = discoverSpaceDbs(
      options.dir ? { dirs: [options.dir] } : {},
    );
    const result = groupDiscoveredSpaces(discovered);
    out(!!options.json, result, () => {
      if (result.groups.length === 0 && result.ungrouped.length === 0) {
        console.log("no space DBs found.");
        return;
      }
      const roleCounts = (g: { spaces: GroupedSpace[] }) => {
        const c = { home: 0, profile: 0, main: 0, unknown: 0, absent: 0 };
        for (const s of g.spaces) {
          c[s.role]++;
          if (!s.present) c.absent++;
        }
        return c;
      };
      const tag = (s: GroupedSpace) =>
        `${s.role.padEnd(7)} ${shortDid(s.did)}` +
        (s.present
          ? `  commits=${s.commits ?? 0} entities=${s.entities ?? 0}` +
            (s.empty ? "  (placeholder/empty)" : "")
          : "  (absent — referenced, no local DB)") +
        (s.evidence.length ? `  · ${s.evidence.join("; ")}` : "");

      // Focused view: expand the matching group(s) fully.
      if (options.did) {
        const matches = result.groups.filter((g) =>
          g.principal.includes(options.did!)
        );
        if (matches.length === 0) {
          console.log(`no group principal matches "${options.did}".`);
          return;
        }
        for (const g of matches) {
          console.log(
            `● user ${shortDid(g.principal)}` +
              (g.homePresent ? "" : "  (home absent/empty locally)"),
          );
          for (const s of g.spaces) console.log(`   ${tag(s)}`);
        }
        return;
      }

      // Default: one compact line per group, biggest first.
      console.log(
        `${result.groups.length} user group(s)` +
          (result.ungrouped.length
            ? `, ${result.ungrouped.length} ungrouped`
            : "") +
          `  —  use --did <prefix> to expand one`,
      );
      for (const g of result.groups) {
        const c = roleCounts(g);
        console.log(
          `● ${shortDid(g.principal)}  ` +
            `home=${g.homePresent ? "present" : "absent"}  ` +
            `profiles=${c.profile}  main=${c.main}` +
            (c.absent ? `  (+${c.absent} absent)` : ""),
        );
      }
    });
  })
  /* inspect summary */
  .command(
    "summary <space:string>",
    "Space overview: commits, sessions, hot ops.",
  )
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
          `ops: ${
            Object.entries(sum.ops).map(([k, v]) => `${k}=${v}`).join(" ")
          }`,
        );
        console.log(
          `branches: ${
            sum.branches.map((b) => `${b.name || "(default)"}@${b.head_seq}`)
              .join(" ")
          }`,
        );
        console.log(
          `scheduler: ${
            !sum.hasSchedulerTables
              ? "absent"
              : sum.schedulerObservations > 0
              ? `${sum.schedulerObservations} observations`
              : "tables present, empty (persistentSchedulerState off)"
          }`,
        );
      });
    } finally {
      s.close();
    }
  })
  /* inspect scopes */
  .command(
    "scopes <space:string>",
    "Per-identity scopes in a space: shared/space + per-user + per-session.",
  )
  .option("--branch <branch:string>", "Branch (default: '').")
  .action((options, space) => {
    const s = openSpace(resolveSpacePath(space));
    try {
      const scopes = listScopes(s, { branch: options.branch });
      out(!!options.json, scopes, () => {
        const space2 = scopes.find((x) => x.kind === "space");
        console.log(
          `${scopes.length} scope(s)` +
            (space2
              ? `  ·  shared 'space' has ${space2.entities} entities`
              : ""),
        );
        for (const sc of scopes) {
          console.log(
            `  ${
              fmtScope(sc).padEnd(34)
            } entities=${sc.entities}\trevs=${sc.revisions}`,
          );
        }
        if (scopes.some((x) => x.kind !== "space")) {
          console.log(
            "\ntip: `inspect value-at <space> <id> --as <DID>` reads as that identity;",
          );
          console.log(
            "     `inspect overlay <space> <id>` shows a cell across all scopes.",
          );
        }
      });
    } finally {
      s.close();
    }
  })
  /* inspect commits */
  .command(
    "commits <space:string>",
    "Recent commits (who committed, ops, reads).",
  )
  .option("--session <prefix:string>", "Filter by session id prefix.")
  .option("--limit <n:number>", "Max rows.", { default: 50 })
  .action((options, space) => {
    const s = openSpace(resolveSpacePath(space));
    try {
      const rows = listCommits(s, {
        session: options.session,
        limit: options.limit,
      });
      out(!!options.json, rows, () => {
        for (const r of rows) {
          console.log(
            `#${r.seq}\t${
              fmtSession(r.session)
            }\tlocal=${r.localSeq}\tops=${r.ops}\treads=${r.reads}\t${r.createdAt}`,
          );
        }
      });
    } finally {
      s.close();
    }
  })
  /* inspect hot */
  .command(
    "hot <space:string>",
    "Entities ranked by write count (contention proxy).",
  )
  .option("--limit <n:number>", "Max rows.", { default: 20 })
  .option("--branch <branch:string>", "Branch (default: '').")
  .action((options, space) => {
    const s = openSpace(resolveSpacePath(space));
    try {
      const rows = hotEntities(s, {
        limit: options.limit,
        branch: options.branch,
      });
      out(!!options.json, rows, () => {
        for (const r of rows) {
          console.log(
            `${r.writes}\twrites\t${r.sessions} sessions\t${r.id}\t(${r.scope})`,
          );
        }
      });
    } finally {
      s.close();
    }
  })
  /* inspect entities */
  .command(
    "entities <space:string>",
    "What's in the space: entities by kind, with lineage.",
  )
  .option(
    "--kind <kind:string>",
    "Filter: piece | module | stream | schema | owned-cell | free-cell | unknown.",
  )
  .option("--branch <branch:string>", "Branch (default: '').")
  .option("--limit <n:number>", "Max entities to reconstruct.", {
    default: 5000,
  })
  .action((options, space) => {
    const s = openSpace(resolveSpacePath(space));
    try {
      let rows = listEntityModels(s, {
        limit: options.limit,
        branch: options.branch,
      });
      if (options.kind) rows = rows.filter((r) => r.kind === options.kind);
      out(!!options.json, rows, () => {
        if (rows.length === 0) {
          console.log("(no entities)");
          return;
        }
        // A compact comprehension legend, then the table.
        const counts = new Map<string, number>();
        for (const r of rows) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
        console.log(
          [...counts.entries()].map(([k, n]) => `${k}=${n}`).join("  "),
        );
        console.log(
          Table.from([
            ["KIND", "LABEL", "OWN", "REVS", "LINKS", "ID"],
            ...rows.map((r) => [
              r.kind,
              r.label.length > 34 ? `${r.label.slice(0, 33)}…` : r.label,
              r.owned ? "↳" : "",
              String(r.revisions ?? 0),
              String(r.links ?? 0),
              r.id,
            ]),
          ]).toString(),
        );
      });
    } finally {
      s.close();
    }
  })
  /* inspect piece */
  .command(
    "piece <space:string> <entity:string>",
    "A piece's pattern, input, result, and owned cells.",
  )
  .option("--branch <branch:string>", "Branch (default: '').")
  .option("--scope <scope:string>", "Scope key (default: space).")
  .option("--code", "Include the full pattern TS source.")
  .action((options, space, entity) => {
    const s = openSpace(resolveSpacePath(space));
    try {
      const piece = describePiece(s, entity, {
        branch: options.branch,
        scope: options.scope,
        includeCode: !!options.code,
      });
      out(!!options.json, piece, () => {
        if ("error" in piece) {
          console.log(`(${piece.error})`);
          return;
        }
        console.log(`piece:   ${piece.name}  [${piece.regime}]`);
        console.log(`id:      ${piece.id}`);
        if (piece.pattern) {
          const p = piece.pattern;
          console.log(
            `pattern: ${p.filename ?? "(unresolved)"}` +
              (p.symbol ? ` · ${p.symbol}` : "") +
              (p.codeLines ? ` · ${p.codeLines} lines` : "") +
              (p.id ? `  ${p.id}` : ""),
          );
        }
        if (piece.input) {
          console.log(`input:   ${piece.input.summary}  ${piece.input.id}`);
        }
        console.log(`result:  {${piece.resultKeys.join(", ")}}`);
        if (piece.schemaKeys.length) {
          console.log(`schema:  {${piece.schemaKeys.join(", ")}}`);
        }
        if (piece.ownedCells.length) {
          console.log(`owned cells (${piece.ownedCells.length}):`);
          for (const c of piece.ownedCells) {
            console.log(
              `  ${c.kind.padEnd(10)} ${
                c.summary.length > 40 ? `${c.summary.slice(0, 39)}…` : c.summary
              }\t${c.id}`,
            );
          }
        }
        if (piece.pattern?.code) {
          console.log(
            `\n--- ${piece.pattern.filename} ---\n${piece.pattern.code}`,
          );
        }
      });
    } finally {
      s.close();
    }
  })
  /* inspect graph */
  .command(
    "graph <space:string>",
    "Entity graph: nodes (pieces/cells/streams/modules) + edges (pattern/argument/owns/link).",
  )
  .option("--branch <branch:string>", "Branch (default: '').")
  .option("--scope <scope:string>", "Scope key (default: space).")
  .option("--root <entity:string>", "Restrict to one entity's neighborhood.")
  .option("--depth <n:number>", "Hops around --root.", { default: 2 })
  .option("--no-links", "Omit data-link edges (keep structural edges only).")
  .option("--dot", "Emit Graphviz DOT (pipe to: dot -Tsvg).")
  .option("--limit <n:number>", "Max entities to reconstruct.", {
    default: 5000,
  })
  .action((options, space) => {
    const s = openSpace(resolveSpacePath(space));
    try {
      let g: SpaceGraph = buildSpaceGraph(s, {
        branch: options.branch,
        scope: options.scope,
        limit: options.limit,
        includeLinks: options.links !== false,
      });
      if (options.root) g = subgraphAround(g, options.root, options.depth);
      if (options.dot) {
        console.log(graphToDot(g));
        return;
      }
      out(!!options.json, g, () => {
        console.log(`space: ${g.space}`);
        console.log(
          `nodes: ${g.nodes.length}  {${
            Object.entries(g.stats.nodesByKind)
              .map(([k, n]) => `${k}=${n}`).join(" ")
          }}`,
        );
        console.log(
          `edges: ${g.edges.length}  {${
            Object.entries(g.stats.edgesByKind)
              .filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(" ")
          }}` + (g.stats.externalEdges
            ? `  (${g.stats.externalEdges} cross-space)`
            : ""),
        );
        // Adjacency, grouped by source, pieces first (most informative).
        const labelOf = new Map(g.nodes.map((n) => [n.id, n]));
        const bySource = new Map<string, typeof g.edges>();
        for (const e of g.edges) {
          (bySource.get(e.from) ?? bySource.set(e.from, []).get(e.from)!).push(
            e,
          );
        }
        const order = [...bySource.keys()].sort((a, b) => {
          const ka = labelOf.get(a)?.kind === "piece" ? 0 : 1;
          const kb = labelOf.get(b)?.kind === "piece" ? 0 : 1;
          return ka - kb;
        });
        const arrow = (k: string) =>
          k === "pattern"
            ? "⟶pattern"
            : k === "argument"
            ? "⟶arg"
            : k === "owns"
            ? "⟶owns"
            : "·link";
        for (const src of order.slice(0, options.root ? 9999 : 40)) {
          const n = labelOf.get(src)!;
          console.log(`\n${n.kind} ${shortDid(src)}  ${n.label}`);
          for (const e of bySource.get(src)!) {
            const t = labelOf.get(e.to);
            console.log(
              `  ${arrow(e.kind).padEnd(9)} ${
                t ? `${t.kind} ${t.label}` : "?"
              }${e.external ? ` @${shortDid(e.to)} [cross-space]` : ""}${
                e.label ? `  (${e.label})` : ""
              }`,
            );
          }
        }
        if (!options.root && order.length > 40) {
          console.log(
            `\n… ${order.length - 40} more sources (use --root or --json)`,
          );
        }
      });
    } finally {
      s.close();
    }
  })
  /* inspect html */
  .command(
    "html <space:string>",
    "Emit a self-contained HTML inspector (open in a browser).",
  )
  .option("--branch <branch:string>", "Branch (default: '').")
  .option("--scope <scope:string>", "Scope key (default: space).")
  .option("--out <file:string>", "Write to a file instead of stdout.")
  .option(
    "--app-url <url:string>",
    "Live shell base origin for deep links (e.g. https://host).",
  )
  .action((options, space) => {
    const s = openSpace(resolveSpacePath(space));
    try {
      const bundle = buildInspectorBundle(s, {
        branch: options.branch,
        scope: options.scope,
        generatedAt: new Date().toISOString(),
        liveBase: options.appUrl,
      });
      const html = renderInspectorHtml(bundle);
      if (options.out) {
        Deno.writeTextFileSync(options.out, html);
        const pieces = bundle.details.filter((d) => d.kind === "piece").length;
        console.error(
          `wrote ${options.out}  (${bundle.details.length} entities, ${pieces} pieces)`,
        );
      } else {
        console.log(html);
      }
    } finally {
      s.close();
    }
  })
  /* inspect history */
  .command(
    "history <space:string> <entity:string>",
    "Every write that touched an entity.",
  )
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
            `seq=${r.seq}\tcommit=${r.commitSeq}\t${r.op}\t${
              fmtSession(r.session)
            }\tlocal=${r.localSeq}\t${r.createdAt}`,
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
  .option(
    "--seq <n:number>",
    "Reconstruct as of this commit seq (default: latest).",
  )
  .option("--path <path:string>", "Navigate into value, e.g. value/count.")
  .option("--scope <scope:string>", "Raw scope key (default: space).")
  .option(
    "--as <did:string>",
    "Read AS this identity (overlay session⊕user⊕space).",
  )
  .option("--session <sid:string>", "With --as: a specific session id.")
  .option("--branch <branch:string>", "Branch (default: '').")
  .option("--doc", "Show the whole document, not just value.")
  .action((options, space, entity) => {
    const s = openSpace(resolveSpacePath(space));
    try {
      // --as composes the per-identity overlay; otherwise a single raw scope.
      if (options.as) {
        const r = valueAsIdentity(s, {
          id: entity,
          identity: options.as,
          sessionId: options.session,
          branch: options.branch,
          atSeq: options.seq,
        });
        out(!!options.json, r, () => {
          if (!r.exists) {
            console.log("(absent for this identity)");
            return;
          }
          console.log(
            `resolved from: ${r.resolvedKind}` +
              (r.overrides ? "  (overrides a more-general scope)" : ""),
          );
          console.log(JSON.stringify(r.value, null, 2));
        });
        return;
      }
      const res = getValueAt(
        s,
        {
          id: entity,
          scope: options.scope,
          branch: options.branch,
          atSeq: options.seq,
        },
        splitPath(options.path),
      );
      const shown = options.doc ? res.document : res.value;
      out(
        !!options.json,
        { exists: res.exists, value: annotate(shown) },
        () => {
          if (!res.exists) console.log("(absent at this seq)");
          else if (shown === undefined) {
            console.log("(entity present, but nothing at that path)");
          } else console.log(JSON.stringify(annotate(shown), null, 2));
        },
      );
    } finally {
      s.close();
    }
  })
  /* inspect overlay */
  .command(
    "overlay <space:string> <entity:string>",
    "An entity's value across EVERY scope (per-user/session divergence).",
  )
  .option("--branch <branch:string>", "Branch (default: '').")
  .action((options, space, entity) => {
    const s = openSpace(resolveSpacePath(space));
    try {
      const o = scopeOverlay(s, entity, { branch: options.branch });
      out(!!options.json, o, () => {
        if (o.variants.length === 0) {
          console.log("(entity absent)");
          return;
        }
        console.log(
          `${entity}` +
            (o.overridden
              ? o.divergent
                ? `  —  ${o.variants.length} scopes, DIVERGENT`
                : `  —  ${o.variants.length} scopes, identical`
              : "  —  single scope"),
        );
        for (const v of o.variants) {
          const label = v.kind === "space"
            ? "space"
            : v.kind === "user"
            ? `user ${shortDid(v.principal ?? "?")}`
            : v.kind === "session"
            ? `session ${shortDid(v.principal ?? "?")}/${
              (v.sessionId ?? "").slice(0, 8)
            }`
            : v.scope;
          console.log(`  ${label.padEnd(34)} ${v.summary}`);
        }
      });
    } finally {
      s.close();
    }
  })
  /* inspect diff */
  .command(
    "diff <space:string> <entity:string>",
    "What changed in an entity between two seqs.",
  )
  .option("--from <n:number>", "From seq (default: entity's birth / seq 0).")
  .option("--to <n:number>", "To seq (default: latest).")
  .option("--path <path:string>", "Focus inside value, e.g. items/0/title.")
  .option("--doc", "Diff the whole document, not just value.")
  .option("--scope <scope:string>", "Scope key (default: space).")
  .option("--branch <branch:string>", "Branch (default: '').")
  .action((options, space, entity) => {
    const s = openSpace(resolveSpacePath(space));
    try {
      const d = diffEntity(s, {
        id: entity,
        scope: options.scope,
        branch: options.branch,
        fromSeq: options.from,
        toSeq: options.to,
        path: splitPath(options.path),
        doc: !!options.doc,
      });
      out(!!options.json, d, () => {
        const range = `${d.fromSeq ?? "birth"} → ${d.toSeq ?? "latest"}`;
        console.log(`diff ${d.id}  (${range})`);
        if (!d.fromExists && d.toExists) console.log("  (created in range)");
        if (d.fromExists && !d.toExists) console.log("  (deleted in range)");
        if (d.changes.length === 0) {
          console.log("  (no changes)");
          return;
        }
        for (const c of d.changes) {
          const at = c.path || "(root)";
          if (c.kind === "changed") {
            console.log(
              `  ~ ${at}: ${summarize(c.before)} → ${summarize(c.after)}`,
            );
          } else if (c.kind === "added") {
            console.log(`  + ${at}: ${summarize(c.after)}`);
          } else {
            console.log(`  - ${at}: ${summarize(c.before)}`);
          }
        }
      });
    } finally {
      s.close();
    }
  })
  /* inspect timeline */
  .command(
    "timeline <space:string> [entity:string]",
    "How a space grew (no entity), or how one entity evolved (with entity).",
  )
  .option("--scope <scope:string>", "Scope key (default: space).")
  .option("--branch <branch:string>", "Branch (default: '').")
  .option("--limit <n:number>", "Max rows.", { default: 500 })
  .action((options, space, entity) => {
    const s = openSpace(resolveSpacePath(space));
    try {
      if (entity) {
        const steps = entityTimeline(s, {
          id: entity,
          scope: options.scope,
          branch: options.branch,
          limit: options.limit,
        });
        out(!!options.json, steps, () => {
          console.log(`timeline of ${entity}  (${steps.length} writes)`);
          for (const st of steps) {
            console.log(
              `  seq=${st.seq}\t${st.op}\t${
                st.changes ? `${st.changes} changes` : "—"
              }\t${st.summary}\t${fmtSession(st.session)}\t${st.createdAt}`,
            );
          }
        });
      } else {
        const entries = spaceTimeline(s, {
          scope: options.scope,
          branch: options.branch,
          limit: options.limit,
        });
        out(!!options.json, entries, () => {
          console.log(`space growth  (${entries.length} commits)`);
          for (const e of entries) {
            console.log(
              `  #${e.commitSeq}\t+${e.created} new\t${e.touched} touched\t` +
                `Σ${e.cumulativeEntities}\t${
                  fmtSession(e.session)
                }\t${e.createdAt}`,
            );
          }
        });
      }
    } finally {
      s.close();
    }
  })
  /* inspect converge */
  .command(
    "converge <entity:string>",
    "Compare an entity's value across spaces.",
  )
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
        {
          id: entity,
          scope: options.scope,
          branch: options.branch,
          path: splitPath(options.path),
        },
        index,
      );
      out(!!options.json, r, () => {
        console.log(
          `verdict: ${r.verdict.toUpperCase()}` +
            (r.relationship && r.relationship !== "n/a"
              ? `  [${r.relationship}]`
              : ""),
        );
        console.log(
          `entity:  ${r.id}` +
            (r.path.length ? `  path=/${r.path.join("/")}` : ""),
        );
        for (const v of r.views) {
          if (!v.present) {
            console.log(`  ${v.label}\tABSENT`);
            continue;
          }
          const cluster = r.clusters.findIndex((c) =>
            c.valueKey === v.valueKey
          ) + 1;
          console.log(
            `  ${v.label}\thead=${v.headSeq}\trevs=${v.revisions}\tlast=${
              v.lastSession ? fmtSession(v.lastSession) : "?"
            }\tcluster#${cluster}`,
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
      const result = convergenceScan(refs, {
        limit: options.limit,
        branch: options.branch,
      });
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
            `  ${f.verdict.toUpperCase()}\t${
              relTag(f)
            }\t${f.id}\tpresent=${present}` +
              (missing ? `\tmissing=${missing}` : "") +
              `\tclusters=${f.clusters.length}`,
          );
        }
      });
    } finally {
      for (const ref of refs) ref.space.close();
    }
  });
