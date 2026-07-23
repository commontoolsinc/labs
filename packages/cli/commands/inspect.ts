// `cf inspect` — offline autopsy of local memory v2 space DBs.
//
// Thin CLI surface over @commonfabric/state-inspector. Reads the durable SQLite
// store the server already wrote (no live runtime, no capture) and answers
// who/what/when + cross-space convergence questions. Data commands take --json;
// the HTML renderer rejects it.
//
// Space DBs are auto-discovered (no need to pass absolute paths): pass a DID,
// DID-prefix, a space NAME (resolved the same way the runtime derives it), or a
// file path as <space>. `cf inspect spaces` lists what's found.

import { Command, ValidationError } from "@cliffy/command";
import { Table } from "@cliffy/table";
import {
  annotate,
  buildCrossSpaceLinkIndex,
  buildInspectorBundle,
  buildSpaceGraph,
  contendedEntities,
  convergence,
  type ConvergenceResult,
  convergenceScan,
  // Remote acquisition (`cf inspect --remote` / `pull`).
  defaultCacheDir,
  describeIdentity,
  describePiece,
  diffEntity,
  discoverSpaceDbs,
  entityConflicts,
  entityHistory,
  entityTimeline,
  fetchSpaceDb,
  getValueAt,
  graphToDot,
  groupDiscoveredSpaces,
  type GroupedSpace,
  hotEntities,
  listCommits,
  listEntityModels,
  listRemoteSpaces,
  listScopes,
  listSqliteFiles,
  openSpace,
  openSpaces,
  quickStats,
  type RemoteSpace,
  renderInspectorHtml,
  type RequestSigner,
  resolveSpace,
  type Scope,
  scopeOverlay,
  type SpaceGraph,
  spaceParticipants,
  type SpaceRef,
  spaceTimeline,
  subgraphAround,
  summarize,
  summarizeSpace,
  valueAsIdentity,
} from "@commonfabric/state-inspector";
import { signFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import { loadIdentity } from "../lib/identity.ts";
import { hasJsonArgument } from "../lib/json-output.ts";

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

// ── Remote acquisition (`cf inspect --remote`) ──────────────────────────────
// The autopsy stays 100% offline; --remote only changes where the SQLite file
// comes from: instead of the local on-disk store, fetch a read-only snapshot
// from a toolshed dump endpoint into the local cache, then open it as usual.

interface RemoteOpts {
  remote?: string | boolean;
  identity?: string;
}

// Resolve the remote base URL from --remote (its value, or CF_API_URL when the
// flag is given bare). Returns null when not in remote mode.
function remoteBaseUrl(options: RemoteOpts): string | null {
  const r = options.remote;
  if (r === undefined || r === false) return null;
  if (r === true) {
    const env = Deno.env.get("CF_API_URL");
    if (!env) {
      throw new Error(
        "--remote needs a URL, e.g. --remote https://host (or set CF_API_URL).",
      );
    }
    return env;
  }
  return r;
}

// Build a CF1 first-party request signer from --identity / CF_IDENTITY. Returns
// undefined when no key is configured; the request then goes out unsigned and
// the server replies 401 (the dump endpoint has no unauthenticated mode) — we
// let it fail with the actionable "set CF_IDENTITY" message rather than block
// here, so the missing-key case is reported the same way as a bad key.
async function remoteSigner(
  options: RemoteOpts,
): Promise<RequestSigner | undefined> {
  const path = options.identity ?? Deno.env.get("CF_IDENTITY");
  if (!path) return undefined;
  const identity = await loadIdentity(path);
  return ({ url, method }) =>
    signFirstPartyHttpRequest({ url: new URL(url), method, signer: identity });
}

// Map a token (full DID, prefix, or substring) to a full space DID on a remote,
// via the remote listing — exact match wins, else unique substring. A full DID
// resolves exactly; a `did:key:z6Mk…` PREFIX resolves like any other prefix
// (mirroring local resolution) instead of being sent verbatim and 404ing.
async function resolveRemoteDid(
  token: string,
  base: string,
  sign: RequestSigner | undefined,
): Promise<string> {
  const spaces = await listRemoteSpaces(base, { sign });
  const exact = spaces.filter((s) => s.space === token);
  const matches = exact.length
    ? exact
    : spaces.filter((s) => s.space.includes(token));
  if (matches.length === 1) return matches[0].space;
  if (matches.length === 0) {
    throw new Error(
      `no remote space matches "${token}" (run: inspect spaces --remote).`,
    );
  }
  throw new Error(
    `"${token}" is ambiguous across ${matches.length} remote spaces; use a full DID.`,
  );
}

// Open a space by token: from the remote (fetch + cache) when --remote is set,
// otherwise from the local on-disk store.
async function openByToken(
  token: string,
  options: RemoteOpts,
): Promise<ReturnType<typeof openSpace>> {
  const base = remoteBaseUrl(options);
  // Local path: resolveSpace handles DID / prefix / path / space-name (#4398).
  if (!base) return openSpace(await resolveSpace(token));
  const sign = await remoteSigner(options);
  const did = await resolveRemoteDid(token, base, sign);
  return openSpace(await fetchSpaceDb(did, base, { sign }));
}

// Resolve --all / --spaces / --dir (and --remote) into open spaces; caller must
// close them.
async function resolveMultiSpaces(opts: {
  all?: boolean;
  spaces?: string;
  dir?: string;
  remote?: string | boolean;
  identity?: string;
}): Promise<SpaceRef[]> {
  const base = remoteBaseUrl(opts);
  if (base) {
    const sign = await remoteSigner(opts);
    let dids: string[];
    if (opts.all) {
      dids = (await listRemoteSpaces(base, { sign })).map((s) => s.space);
    } else if (opts.spaces) {
      dids = await Promise.all(
        opts.spaces.split(",").map((t) => t.trim()).filter(Boolean)
          .map((t) => resolveRemoteDid(t, base, sign)),
      );
    } else {
      throw new Error("with --remote, provide --all or --spaces <a,b,…>.");
    }
    const paths: string[] = [];
    for (const did of dids) paths.push(await fetchSpaceDb(did, base, { sign }));
    return openSpaces(paths);
  }
  if (opts.dir) return openSpaces(listSqliteFiles(opts.dir));
  if (opts.all) return openSpaces(discoverSpaceDbs().map((s) => s.path));
  if (opts.spaces) {
    const discovered = discoverSpaceDbs();
    const paths = await Promise.all(
      opts.spaces
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => resolveSpace(t, discovered)),
    );
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
  .error((error, command) => {
    const args = command.getMainCommand().getRawArgs();
    if (hasJsonArgument(args)) {
      throw error;
    }
  })
  .globalOption("--json", "Output machine-readable JSON.")
  .globalOption(
    "--remote [url:string]",
    "Inspect a remote toolshed: fetch read-only space snapshots into a local " +
      "cache instead of reading on-disk DBs. Bare --remote uses CF_API_URL.",
  )
  .globalOption(
    "--identity <path:string>",
    "Identity keyfile used to sign --remote dump requests (default CF_IDENTITY).",
  )
  .action(function (options) {
    if (options.json) {
      throw new ValidationError(
        'Option "--json" requires an inspect data subcommand.',
      );
    }
    this.showHelp();
  })
  /* inspect spaces */
  .command(
    "spaces",
    "List space DBs: local on-disk by default, or a remote toolshed's with " +
      "--remote.",
  )
  .option("--dir <dir:string>", "Extra directory to search for *.sqlite files.")
  .action(async (options) => {
    // --remote: list the spaces the remote will dump (no per-space stats, since
    // those need the DB which we don't fetch just to list).
    const base = remoteBaseUrl(options);
    if (base) {
      const sign = await remoteSigner(options);
      const spaces = await listRemoteSpaces(base, { sign });
      out(!!options.json, { remote: base, spaces }, () => {
        if (spaces.length === 0) {
          console.log(`no spaces available at ${base}.`);
          return;
        }
        console.log(`${spaces.length} space(s) at ${base}:`);
        console.log(
          Table.from([
            ["DID", "SIZE", "MODIFIED"],
            ...spaces.map((s: RemoteSpace) => [
              s.space,
              humanSize(s.sizeBytes),
              new Date(s.mtimeMs).toISOString(),
            ]),
          ]).toString(),
        );
        console.log(
          "\ntip: `inspect summary <did> --remote` fetches + inspects one; " +
            "`inspect pull --all --remote` caches them all.",
        );
      });
      return;
    }

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
  /* inspect pull */
  .command(
    "pull [space:string]",
    "Download remote space snapshot(s) into the local cache for offline " +
      "inspection. Pass a space, or --all. Requires --remote.",
  )
  .option("--all", "Pull every space the remote exposes.")
  .option("--force", "Re-download even if a cached copy exists.")
  .action(async (options, space) => {
    const base = remoteBaseUrl(options);
    if (!base) {
      throw new Error("pull requires --remote <url> (or CF_API_URL).");
    }
    const sign = await remoteSigner(options);
    const cacheDir = defaultCacheDir(base);

    let dids: string[];
    if (options.all) {
      dids = (await listRemoteSpaces(base, { sign })).map((s) => s.space);
    } else if (space) {
      dids = [await resolveRemoteDid(space, base, sign)];
    } else {
      throw new Error("provide a <space> or --all.");
    }

    const pulled: { did: string; path: string }[] = [];
    for (const did of dids) {
      const path = await fetchSpaceDb(did, base, {
        sign,
        force: options.force,
      });
      pulled.push({ did, path });
    }
    out(!!options.json, { remote: base, cacheDir, pulled }, () => {
      console.log(`pulled ${pulled.length} space(s) into ${cacheDir}:`);
      for (const p of pulled) console.log(`  ${p.did}`);
      console.log(
        "\nnow inspect them offline, e.g. `inspect summary <did-prefix>`.",
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
  /* inspect identity */
  .command(
    "identity <did:string>",
    "One identity's whole world: its spaces + the scopes it owns in each.",
  )
  .option("--dir <dir:string>", "Extra directory to search for *.sqlite files.")
  .action((options, did) => {
    const discovered = discoverSpaceDbs(
      options.dir ? { dirs: [options.dir] } : {},
    );
    const w = describeIdentity(discovered, did);
    out(!!options.json, w, () => {
      console.log(
        `● identity ${shortDid(did)}` +
          (w.homePresent ? "" : "  (home absent/empty locally)"),
      );
      console.log(
        `  ${w.totals.presentSpaces}/${w.totals.spaces} spaces present · ` +
          `${w.totals.spacesWithScopedState} with per-user/session state · ` +
          `${w.totals.scopedEntities} scoped entities`,
      );
      for (const s of w.spaces) {
        const head = `  ${s.role.padEnd(7)} ${shortDid(s.did)}` +
          (s.present
            ? `  entities=${s.entities ?? 0}`
            : "  (absent — referenced, no local DB)");
        console.log(head);
        for (const sc of s.ownedScopes) {
          console.log(
            `      ${sc.kind === "session" ? "session" : "user"}${
              sc.kind === "session"
                ? ` /${(sc.sessionId ?? "").slice(0, 8)}`
                : ""
            }  entities=${sc.entities} revs=${sc.revisions}`,
          );
        }
      }
      if (w.totals.scopedEntities > 0) {
        console.log(
          "\ntip: `inspect value-at <space> <id> --as " + shortDid(did) +
            "…` reads a cell as this identity.",
        );
      }
    });
  })
  /* inspect summary */
  .command(
    "summary <space:string>",
    "Space overview: commits, sessions, hot ops.",
  )
  .action(async (options, space) => {
    const s = await openByToken(space, options);
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
  .action(async (options, space) => {
    const s = await openByToken(space, options);
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
  /* inspect users */
  .command(
    "users <space:string>",
    "Identities that touched this space (committers + per-user/session scopes).",
  )
  .option("--branch <branch:string>", "Branch (default: '').")
  .action(async (options, space) => {
    const s = await openByToken(space, options);
    try {
      const ps = spaceParticipants(s, { branch: options.branch });
      out(!!options.json, ps, () => {
        if (ps.length === 0) {
          console.log("(no identifiable participants — bare/empty sessions)");
          return;
        }
        console.log(`${ps.length} identit${ps.length === 1 ? "y" : "ies"}:`);
        for (const p of ps) {
          console.log(
            `  ${p.isOwner ? "★" : "·"} ${shortDid(p.did)}` +
              `\tcommits=${p.commits} sessions=${p.sessions}` +
              (p.userEntities ? `  user-cells=${p.userEntities}` : "") +
              (p.sessionEntities
                ? `  session-cells=${p.sessionEntities}`
                : "") +
              (p.isOwner ? "  (owner — this is their home)" : ""),
          );
        }
        console.log(
          "\ntip: `inspect identity <DID>` opens a user's whole world " +
            "(home + profiles + the spaces they act in).",
        );
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
  .action(async (options, space) => {
    const s = await openByToken(space, options);
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
  .action(async (options, space) => {
    const s = await openByToken(space, options);
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
  /* inspect conflicts */
  .command(
    "conflicts <space:string> [entity:string]",
    "Contested entities (≥2 writer sessions); with an entity: stale-read analysis.",
  )
  .option("--branch <branch:string>", "Branch (default: '').")
  .option("--scope <scope:string>", "Scope key (default: space).")
  .option("--limit <n:number>", "Max contested entities.", { default: 100 })
  .action(async (options, space, entity) => {
    const s = await openByToken(space, options);
    try {
      if (entity) {
        const c = entityConflicts(s, entity, {
          branch: options.branch,
          scope: options.scope,
        });
        out(!!options.json, c, () => {
          console.log(
            `${c.id}\n${c.writers.length} writes by ${c.writerPrincipals} ` +
              `identit${
                c.writerPrincipals === 1 ? "y" : "ies"
              } / ${c.writerSessions} sessions` +
              (c.multiUser
                ? "  · MULTI-USER"
                : "  · single-user (multi-session)") +
              (c.interleaved ? "  · INTERLEAVED" : ""),
          );
          for (const w of c.writers) {
            console.log(
              `  seq=${w.seq}\t${w.op}\t${
                fmtSession(w.session)
              }\t${w.createdAt}`,
            );
          }
          if (c.staleReads.length) {
            console.log(
              `\n⚠ ANOMALOUS stale reads — the engine validates confirmed ` +
                `reads before committing, so a healthy store has none. Each ` +
                `here is a committed read the engine's own check would reject:`,
            );
            for (const sr of c.staleReads) {
              console.log(
                `  commit #${sr.readerCommitSeq} by ${
                  fmtSession(sr.readerSession)
                } ` +
                  `read @seq ${sr.readAtSeq} but missed ${sr.missedWriteOp} ` +
                  `@seq ${sr.missedWriteSeq} by ${
                    fmtSession(sr.missedWriteSession)
                  }` +
                  (sr.readerAlsoWrote
                    ? "  ⚠ then wrote (lost-update risk)"
                    : ""),
              );
            }
          } else {
            console.log("\n(no anomalous stale reads — store is consistent)");
          }
        });
        return;
      }
      const rows = contendedEntities(s, {
        branch: options.branch,
        scope: options.scope,
        limit: options.limit,
      });
      out(!!options.json, rows, () => {
        if (rows.length === 0) {
          console.log(
            "(no contested entities — no cell written by ≥2 sessions)",
          );
          return;
        }
        const mu = rows.filter((r) => r.multiUser).length;
        console.log(
          `${rows.length} contested entit${rows.length === 1 ? "y" : "ies"} ` +
            `(written by ≥2 sessions)  ·  ${mu} MULTI-USER (≥2 identities):`,
        );
        for (const r of rows) {
          console.log(
            `  ${r.multiUser ? "★" : r.interleaved ? "⇄" : "·"} ${r.id}\t` +
              `${r.principals} users / ${r.sessions} sessions\t${r.writes} writes` +
              (r.multiUser ? "  MULTI-USER" : ""),
          );
        }
        console.log(
          "\ntip: `inspect conflicts <space> <entity>` for the writer timeline + stale reads.",
        );
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
  .action(async (options, space) => {
    const s = await openByToken(space, options);
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
  .action(async (options, space, entity) => {
    const s = await openByToken(space, options);
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
  .option("--dot", "Emit Graphviz DOT (pipe to: dot -Tsvg).", {
    conflicts: ["json"],
  })
  .option("--limit <n:number>", "Max entities to reconstruct.", {
    default: 5000,
  })
  .action(async (options, space) => {
    const s = await openByToken(space, options);
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
            // External targets carry the real id in `entityId` and the target
            // space in `space`; print the space DID (not the qualified node key).
            const desc = t
              ? (e.external
                ? `${shortDid(t.entityId)} (external)`
                : `${t.kind} ${t.label}`)
              : "?";
            console.log(
              `  ${arrow(e.kind).padEnd(9)} ${desc}${
                e.external ? ` @${shortDid(t?.space ?? "")} [cross-space]` : ""
              }${e.label ? `  (${e.label})` : ""}`,
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
  .action(async (options, space) => {
    if (options.json) {
      throw new ValidationError(
        'Option "--json" and the "html" command are mutually exclusive.',
      );
    }
    const s = await openByToken(space, options);
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
  .action(async (options, space, entity) => {
    const s = await openByToken(space, options);
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
    "APPROXIMATE this identity's view: the most-specific stored scope that holds " +
      "the id (session⊕user⊕space). Not the runtime read — use `overlay` for ground truth.",
  )
  .option("--session <sid:string>", "With --as: a specific session id.")
  .option("--branch <branch:string>", "Branch (default: '').")
  .option("--doc", "Show the whole document, not just value.")
  .action(async (options, space, entity) => {
    const s = await openByToken(space, options);
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
            `≈ approx. from scope: ${r.resolvedKind} ` +
              `(most-specific stored; NOT a runtime read — see \`overlay\`)` +
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
  .action(async (options, space, entity) => {
    const s = await openByToken(space, options);
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
  .action(async (options, space, entity) => {
    const s = await openByToken(space, options);
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
  .action(async (options, space, entity) => {
    const s = await openByToken(space, options);
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
  .action(async (options, entity) => {
    const refs = await resolveMultiSpaces(options);
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
  .action(async (options) => {
    const refs = await resolveMultiSpaces(options);
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
