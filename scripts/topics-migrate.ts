#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write --allow-env
/**
 * Drive one generation of a Topics board migration: `setsrc` every piece the
 * manifest recorded on a given pattern identity, serially, resumable, against
 * a clone or against production.
 *
 * Usage:
 *   scripts/topics-migrate.ts <store.sqlite> --manifest <manifest.tsv>
 *     --from <recorded-identity> --source <pattern.tsx>
 *     [--test <path>]... [--datafile <path>]... [--root <path>]
 *     [--repository <r>] [--api-url <url>] [--space <did>]
 *     [--dangerously-allow-incompatible-schema] [--plan-out <file>]
 *     [--dry-run | --verify]
 *
 * One generation per invocation, because the rehearsal script migrates
 * generation A's pieces, then generation B's, then the board: keeping the
 * transitions separable is what tells an operator which one stormed. The
 * store path is read offline through `cf inspect` and is never written by
 * this script; the writes go to `--api-url` through `cf piece setsrc`, with
 * the complete flag set repeated on every piece as the runbook requires.
 *
 * **Resume is the design, not a feature.** Resource exhaustion wedged the
 * server in the first real rehearsal and the runbook says it will happen
 * again on a 1 GB store, so a run that stops midway is expected. Every
 * invocation recomputes what remains by reading each piece's current pattern
 * identity out of the store and comparing it against what the manifest
 * recorded — a piece that has moved off its recorded identity is skipped.
 * Re-invoking after a stop therefore continues rather than restarting, and
 * costs nothing on the pieces that already landed. That comparison is the
 * check the runbook prescribes under "Driving the migration"; it asks
 * whether the piece left its recorded starting point, which the store
 * answers on its own, and not whether the piece already runs the candidate,
 * which it cannot.
 *
 * **This script does not judge the migration.** `setsrc` reports success for
 * a piece whose source committed but whose running instance failed to
 * refresh — the CLI prints a warning and exits zero — so a clean run here is
 * not evidence the board is healthy. `--verify` re-reads every piece in the
 * generation and reports its identity against the manifest, and the
 * runbook's `cf space verify --expect-migration` and `cf inspect churn`
 * steps remain the acceptance gate. Run `--verify` after the run returns,
 * never concurrently with it.
 *
 * **Liveness is classified after a failure, never probed before one.** The
 * same rehearsal measured `/api/meta` intermittently taking over 60 s while
 * the server was healthy and still completing writes, so a pre-flight
 * timeout would abort a working migration. When a `setsrc` fails, one store
 * read decides whether the failure was about that piece or about the server
 * having gone away, and the run stops either way with the distinction named.
 */

import {
  cf,
  cfInherit,
  cfJson,
  type ManifestRow,
  parseManifest,
  planMigration,
  type PlannedPiece,
} from "./topics-rehearsal-lib.ts";

interface PieceDescription {
  pattern?: { identity?: string };
}

function usage(message: string): never {
  console.error(`${message}

Usage:
  scripts/topics-migrate.ts <store.sqlite> --manifest <manifest.tsv>
    --from <recorded-identity> --source <pattern.tsx>
    [--test <path>]... [--datafile <path>]... [--root <path>]
    [--repository <r>] [--api-url <url>] [--space <did>]
    [--dangerously-allow-incompatible-schema] [--plan-out <file>]
    [--dry-run | --verify]`);
  Deno.exit(2);
}

let store: string | undefined;
let manifestPath: string | undefined;
let from: string | undefined;
let source: string | undefined;
let root: string | undefined;
let repository: string | undefined;
let apiUrl: string | undefined;
let space: string | undefined;
let planOut: string | undefined;
let dangerous = false;
let dryRun = false;
let verify = false;
const tests: string[] = [];
const datafiles: string[] = [];

for (let i = 0; i < Deno.args.length; i++) {
  const arg = Deno.args[i];
  if (arg === "--manifest") manifestPath = Deno.args[++i];
  else if (arg === "--from") from = Deno.args[++i];
  else if (arg === "--source") source = Deno.args[++i];
  else if (arg === "--test") tests.push(Deno.args[++i]);
  else if (arg === "--datafile") datafiles.push(Deno.args[++i]);
  else if (arg === "--root") root = Deno.args[++i];
  else if (arg === "--repository") repository = Deno.args[++i];
  else if (arg === "--api-url") apiUrl = Deno.args[++i];
  else if (arg === "--space") space = Deno.args[++i];
  else if (arg === "--plan-out") planOut = Deno.args[++i];
  else if (arg === "--dangerously-allow-incompatible-schema") dangerous = true;
  else if (arg === "--dry-run") dryRun = true;
  else if (arg === "--verify") verify = true;
  else if (arg.startsWith("-")) usage(`Unknown flag: ${arg}`);
  else if (store === undefined) store = arg;
  else usage(`Unexpected argument: ${arg}`);
}

if (store === undefined) usage("Missing the store path.");
if (manifestPath === undefined) usage(`Missing "--manifest".`);
if (from === undefined) usage(`Missing "--from".`);
if (!verify && source === undefined) usage(`Missing "--source".`);
if (dryRun && verify) usage(`"--dry-run" and "--verify" are separate modes.`);

/** Read one piece's current pattern identity out of the store, offline. */
async function currentIdentity(id: string): Promise<string | undefined> {
  const description = await cfJson<PieceDescription>([
    "inspect",
    "piece",
    store!,
    id,
    "--json",
  ]);
  return description.pattern?.identity;
}

/**
 * Read every selected piece's current identity. Serial rather than
 * concurrent: these are reads against one SQLite file that a server may hold
 * open, and the runbook's whole posture toward this store is one reader at a
 * time.
 */
async function readCurrentIdentities(
  rows: readonly ManifestRow[],
): Promise<Map<string, string | undefined>> {
  const identities = new Map<string, string | undefined>();
  for (const row of rows) {
    try {
      identities.set(row.id, await currentIdentity(row.id));
    } catch {
      identities.set(row.id, undefined);
    }
  }
  return identities;
}

const manifest = parseManifest(await Deno.readTextFile(manifestPath));
const selected = manifest.filter((row) => row.identity === from);
if (selected.length === 0) {
  console.error(
    `No manifest row carries identity ${from}. The manifest holds ` +
      `${manifest.length} rows across ` +
      `${new Set(manifest.map((row) => row.identity)).size} identities.`,
  );
  Deno.exit(1);
}

const identities = await readCurrentIdentities(selected);
const plan = planMigration(selected, (id) => identities.get(id));
const pending = plan.filter((p) => p.disposition === "pending");
const moved = plan.filter((p) => p.disposition === "moved");
const missing = plan.filter((p) => p.disposition === "missing");

console.log(
  `Generation ${from}: ${selected.length} recorded — ` +
    `${pending.length} pending, ${moved.length} already moved, ` +
    `${missing.length} missing.`,
);

/** Write the ids still to be done, so a stop leaves a resumable artifact. */
async function writePlan(remaining: readonly PlannedPiece[]): Promise<void> {
  if (planOut === undefined) return;
  await Deno.writeTextFile(
    planOut,
    remaining.map((p) => p.id).join("\n") + (remaining.length ? "\n" : ""),
  );
  console.log(`Remaining ids written to ${planOut} (${remaining.length}).`);
}

if (missing.length > 0) {
  for (const piece of missing) console.error(`missing from store: ${piece.id}`);
  console.error(
    `Stopping: the store does not describe ${missing.length} manifest ` +
      `piece(s). A manifest that does not match the store cannot say what ` +
      `has been migrated.`,
  );
  Deno.exit(1);
}

if (verify) {
  for (const piece of plan) {
    console.log(
      `${piece.disposition === "moved" ? "moved  " : "PENDING"} ${piece.id} ` +
        `${piece.recorded} → ${piece.current ?? "(unresolved)"}`,
    );
  }
  await writePlan(pending);
  console.log(
    pending.length === 0
      ? `Every piece in generation ${from} has moved off its recorded identity.`
      : `${pending.length} of ${selected.length} still carry the recorded identity.`,
  );
  Deno.exit(pending.length === 0 ? 0 : 1);
}

if (dryRun) {
  for (const piece of pending) console.log(`would migrate ${piece.id}`);
  await writePlan(pending);
  Deno.exit(0);
}

if (pending.length === 0) {
  console.log(`Nothing to do: generation ${from} has already moved.`);
  Deno.exit(0);
}

const commonFlags = [
  ...tests.flatMap((path) => ["--test", path]),
  ...datafiles.flatMap((path) => ["--datafile", path]),
  ...(root === undefined ? [] : ["--root", root]),
  ...(repository === undefined ? [] : ["--repository", repository]),
  ...(apiUrl === undefined ? [] : ["--api-url", apiUrl]),
  ...(space === undefined ? [] : ["--space", space]),
  ...(dangerous ? ["--dangerously-allow-incompatible-schema"] : []),
];

for (const [index, piece] of pending.entries()) {
  const position = `(${index + 1}/${pending.length})`;
  console.log(`\n=== setsrc ${piece.id} ${position} ===`);
  const code = await cfInherit([
    "piece",
    "setsrc",
    source!,
    "--piece",
    piece.id,
    ...commonFlags,
  ]);
  if (code === 0) continue;

  // Classify only now: whether the store is still readable separates a
  // refusal about this piece from the server having gone away.
  let storeReadable = true;
  try {
    await cf(["inspect", "piece", store!, piece.id, "--json"]);
  } catch {
    storeReadable = false;
  }
  console.error(
    `\nStopped at ${piece.id} ${position}: setsrc exited ${code}. ` +
      (storeReadable
        ? `The store still reads, so this is a refusal about this piece — ` +
          `its own error is above.`
        : `The store no longer reads either, so treat this as the server ` +
          `having gone away rather than a verdict on this piece.`),
  );
  await writePlan(pending.slice(index));
  console.error(
    `${index} landed before the stop; ${pending.length - index} not ` +
      `attempted. Re-invoke the same command to continue — the pieces that ` +
      `landed are skipped on the recomputed plan.`,
  );
  Deno.exit(1);
}

await writePlan([]);
console.log(
  `\nApplied ${pending.length} piece(s) in generation ${from}. ` +
    `This is not an acceptance verdict: re-run with --verify, then run ` +
    `cf space verify --expect-migration and cf inspect churn.`,
);
