// List every ingest channel this deployment has minted.
//
// Why: a minted token is a durable append capability into a user's space, and
// the registration lives in the toolshed's own service space where no user can
// see it. Without this, "what have we handed out, to whom, and is any of it
// still in use" is unanswerable — which matters most on the day the answer
// determines what has to be retired (see `retire-ingest-channels.ts`).
//
// This is the only production reader of the global registration index, which
// exists precisely so channels are enumerable for audit.
//
// Usage:
//   deno task audit-ingest-channels                  # human-readable
//   deno task audit-ingest-channels --json           # machine-readable
//   deno task audit-ingest-channels --repair-indexes # backfill by-space index
import { parseArgs } from "@std/cli/parse-args";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import env from "@/env.ts";
import { identity } from "@/lib/identity.ts";
import {
  getLastSeen,
  getRegistration,
  getRegistrationIndex,
  type IngestRegistration,
  RegistrationConflictError,
  saveRegistration,
} from "@/routes/ingest/ingest.utils.ts";

export const stateOf = (r: IngestRegistration): string =>
  r.revoked ? "revoked" : r.enabled ? "active" : "disabled";

export interface ChannelRow {
  id: string;
  space: string;
  installId: string;
  owner: string;
  state: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastSeenAt: string | null;
}

/** The audit rows, ordered as the index holds them. Pure over the runtime. */
export async function collectRows(
  runtime: Runtime,
  serviceSpace: string,
  /**
   * Re-write each live registration it walks, which repairs the per-space
   * index. Channels provisioned before that index existed carry no entry, so
   * the space's current owner cannot see them in `cf ingest ls --space` — and
   * an operator-provisioned channel has no `owner`, so nobody else can either.
   * Off by default: an audit should not write unless asked.
   *
   * LIMIT, and it is load-bearing for a pre-enablement sweep: this walks the
   * global audit index, so it cannot recover a registration that is missing
   * FROM that index — a channel whose best-effort index write was lost before
   * indexing became mandatory is invisible here. Establishing a source of
   * truth that can find those is a prerequisite for enabling self-serve on a
   * deployment that has provisioned channels before this change.
   */
  repairIndexes = false,
): Promise<ChannelRow[]> {
  const ids = await getRegistrationIndex(runtime, serviceSpace);
  const rows: ChannelRow[] = [];
  for (const id of ids) {
    const r = await getRegistration(runtime, serviceSpace, id);
    // An id that does not resolve is skipped rather than trusted.
    if (!r) continue;
    if (repairIndexes && r.enabled && r.revoked === undefined) {
      // Same revision, so this loses to any concurrent lifecycle write rather
      // than clobbering it.
      try {
        await saveRegistration(runtime, serviceSpace, r, r.revision ?? 0);
      } catch (error) {
        // A channel that moved under us is already being maintained, so a lost
        // precondition is benign. Anything else means the repair did NOT
        // happen, and a repair that reports success while leaving a channel
        // undiscoverable is worse than one that fails.
        if (!(error instanceof RegistrationConflictError)) throw error;
      }
    }
    rows.push({
      id: r.id,
      space: r.space,
      installId: r.installId,
      // Operator-provisioned channels carry no verified owner — worth seeing,
      // since those are exactly the ones no user can revoke for themselves.
      owner: r.owner ?? "<operator-provisioned>",
      state: stateOf(r),
      createdAt: r.createdAt,
      expiresAt: r.expiresAt ?? null,
      revokedAt: r.revoked?.at ?? null,
      lastSeenAt: await getLastSeen(runtime, serviceSpace, id),
    });
  }
  return rows;
}

export function render(rows: ChannelRow[], json: boolean): string[] {
  const out: string[] = [];
  if (json) {
    out.push(JSON.stringify({ channels: rows }, null, 2));
    return out;
  }
  out.push("\nIngest channels\n");
  if (rows.length === 0) out.push("  none.\n");
  for (const row of rows) {
    out.push(`  ${row.id}   [${row.state}]`);
    out.push(`    space:     ${row.space}`);
    out.push(`    installId: ${row.installId}`);
    out.push(`    owner:     ${row.owner}`);
    out.push(
      `    created:   ${row.createdAt}   last seen: ${
        row.lastSeenAt ?? "never"
      }`,
    );
    if (row.revokedAt) out.push(`    revoked:   ${row.revokedAt}`);
    out.push("");
  }
  const live = rows.filter((r) => r.state === "active").length;
  out.push(`  ${rows.length} channel(s), ${live} active.\n`);
  return out;
}

/** The whole command minus argv parsing and runtime construction. */
export async function runAudit(
  runtime: Runtime,
  serviceSpace: string,
  flags: { json?: boolean; "repair-indexes"?: boolean },
): Promise<string[]> {
  return render(
    await collectRows(runtime, serviceSpace, Boolean(flags["repair-indexes"])),
    Boolean(flags.json),
  );
}

/** Build the runtime this command talks to. Replaced in tests. */
export const defaultRuntime = (): Runtime =>
  new Runtime({
    apiUrl: new URL(env.MEMORY_URL),
    storageManager: StorageManager.open({
      memoryHost: new URL(env.MEMORY_URL),
      as: identity,
    }),
  });

export async function main(
  args: string[],
  makeRuntime: () => Runtime = defaultRuntime,
  serviceSpace: string = identity.did(),
  log: (line: string) => void = console.log,
): Promise<number> {
  const flags = parseArgs(args, { boolean: ["json", "repair-indexes"] });
  const runtime = makeRuntime();
  try {
    for (const line of await runAudit(runtime, serviceSpace, flags)) log(line);
    return 0;
  } finally {
    await runtime.dispose();
  }
}

if (import.meta.main) Deno.exit(await main(Deno.args));
