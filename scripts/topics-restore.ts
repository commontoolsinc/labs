#!/usr/bin/env -S deno run --allow-run --allow-read --allow-env
/**
 * Restore one topic's authored content from a `topics-export.ts` export,
 * against a live server — never through verbs, which stamp their own write
 * time and author and would falsify every timestamp and attribution being
 * restored. Writes land in the same piece, so identity and every crossref
 * edge survive.
 *
 * Usage:
 *   scripts/topics-restore.ts <export.json> --piece <fid>
 *     [--api-url <url>] [--space <did>] [--dry-run]
 *     [--allow-identity-mismatch]
 *
 * CF_API_URL and CF_IDENTITY are honored as everywhere else; --space
 * defaults to the DID recorded in the export. Every write is read back and
 * compared against the export before the script will exit zero.
 *
 * The restore is whole-topic by construction: `cf piece apply` REPLACES the
 * piece's input document (measured, not assumed — a partial apply zeroes
 * every field it omits), and no narrower CLI write path exists today, since
 * both sides of `cf set` validate the untouched remainder of the document
 * and refuse it — the input side judges the stored `mentionable` link
 * against its declared array type unresolved, and the result side demands
 * session-scoped fields no other session can see. So the script applies the
 * complete content in one call, then re-establishes the board link that a
 * document write cannot carry (`$link` values are refused by the same
 * validation), using `cf piece link` on the board recorded in the export.
 *
 * Two honest costs. Comment and link elements are re-written as plain
 * values, so their element entities are minted fresh: content, order,
 * timestamps, and attribution are exact, but a stored reference to an
 * individual old element is not preserved. And the deprecated `myName`
 * legacy link is not restored — it exists only as the pre-agentName
 * attribution fallback.
 *
 * The target's deployed pattern identity must match the export row's;
 * --allow-identity-mismatch overrides, which a restore after a deliberate
 * migration needs — the migration changed the identity on purpose.
 */

import {
  cf,
  cfApply,
  cfJson,
  deepEqual,
  LINKED_ARRAY_FIELDS,
  normalizeFid,
  SCALAR_CONTENT_FIELDS,
  type TopicsExport,
} from "./topics-rehearsal-lib.ts";

const CONTENT_FIELDS = [...SCALAR_CONTENT_FIELDS, ...LINKED_ARRAY_FIELDS];

function usage(): never {
  console.error(
    "usage: topics-restore.ts <export.json> --piece <fid> " +
      "[--api-url <url>] [--space <did>] [--dry-run] " +
      "[--allow-identity-mismatch]",
  );
  Deno.exit(2);
}

const positional: string[] = [];
let piece: string | undefined;
let apiUrl = Deno.env.get("CF_API_URL");
let space: string | undefined;
let dryRun = false;
let allowIdentityMismatch = false;
for (let i = 0; i < Deno.args.length; i++) {
  const arg = Deno.args[i];
  if (arg === "--piece") piece = Deno.args[++i];
  else if (arg === "--api-url") apiUrl = Deno.args[++i];
  else if (arg === "--space") space = Deno.args[++i];
  else if (arg === "--dry-run") dryRun = true;
  else if (arg === "--allow-identity-mismatch") allowIdentityMismatch = true;
  else if (arg.startsWith("--")) usage();
  else positional.push(arg);
}
const exportPath = positional[0];
if (!exportPath || positional.length > 1 || !piece || !apiUrl) usage();

const export_ = JSON.parse(
  await Deno.readTextFile(exportPath),
) as TopicsExport;
if (export_.version !== 1) {
  console.error(`unsupported export version: ${export_.version}`);
  Deno.exit(1);
}

const targetFid = normalizeFid(piece);
const row = export_.topics.find((t) => normalizeFid(t.fid) === targetFid);
if (!row) {
  console.error(
    `no topic ${targetFid} in ${exportPath} ` +
      `(${export_.topics.length} topics exported)`,
  );
  Deno.exit(1);
}

space ??= export_.spaceDid ?? undefined;
if (!space) {
  console.error("no --space given and the export records no space DID");
  Deno.exit(2);
}
const addr = ["--piece", targetFid, "--space", space, "--api-url", apiUrl];

const listing = await cfJson<{ pattern?: { identity?: string } }>([
  "piece",
  "verbs",
  ...addr,
  "--json",
]);
const liveIdentity = listing.pattern?.identity ?? "(unresolved)";
if (liveIdentity !== row.patternIdentity) {
  const message = `deployed pattern identity ${liveIdentity} differs from ` +
    `the export's ${row.patternIdentity}`;
  if (!allowIdentityMismatch) {
    console.error(
      `refusing: ${message}. After a deliberate migration, re-run with ` +
        "--allow-identity-mismatch.",
    );
    Deno.exit(1);
  }
  console.error(`proceeding despite mismatch: ${message}`);
}

async function liveValue(field: string): Promise<unknown> {
  // A read of an absent optional path fails rather than returning null;
  // treat that as "absent" so it compares against an absent export value.
  try {
    return await cfJson<unknown>(["get", "-q", ...addr, "--input", field]);
  } catch {
    return undefined;
  }
}

const restoreDoc: Record<string, unknown> = {};
const differing: string[] = [];
for (const field of CONTENT_FIELDS) {
  const wanted = (row.content as Record<string, unknown>)[field];
  if (wanted === undefined) continue;
  restoreDoc[field] = wanted;
  if (!deepEqual(await liveValue(field), wanted)) differing.push(field);
}

const rawMentionable = (row.rawArgument as Record<string, unknown> | undefined)
  ?.mentionable;
const boardFid = export_.board?.fid;
const wantsMentionable = rawMentionable !== undefined;
const liveMentionable = await cfJson<unknown>([
  "get",
  "-q",
  ...addr,
  "--input",
  "--select",
  "mentionable@",
]).catch(() => undefined);
const mentionableMissing = wantsMentionable && liveMentionable === undefined;

if (differing.length === 0 && !mentionableMissing) {
  console.log("nothing to restore: every content field matches the export");
  Deno.exit(0);
}
for (const field of differing) console.log(`${field}: differs from export`);
if (mentionableMissing) console.log("mentionable: board link absent");
if (dryRun) {
  console.log(`dry run: ${differing.length} field(s) would be restored`);
  Deno.exit(0);
}

await cfApply(addr, restoreDoc);
// The apply replaced the whole document, so a board link that was present a
// moment ago is gone now — relink whenever the export says one belongs,
// never on the pre-apply reading.
if (wantsMentionable) {
  if (!boardFid) {
    console.error(
      "mentionable was linked but the export records no board; " +
        "re-link it by hand with `cf piece link <board>/topics " +
        `${targetFid}/mentionable\``,
    );
  } else {
    await cf([
      "piece",
      "link",
      "--space",
      space,
      "--api-url",
      apiUrl,
      `${normalizeFid(boardFid)}/topics`,
      `${targetFid}/mentionable`,
    ]);
  }
}

let failed = 0;
for (const field of Object.keys(restoreDoc)) {
  const after = await liveValue(field);
  if (deepEqual(after, restoreDoc[field])) {
    console.log(`${field}: restored`);
  } else {
    console.error(`${field}: WROTE BUT READBACK DIFFERS from export`);
    failed++;
  }
}
if (wantsMentionable) {
  const after = await cfJson<unknown>([
    "get",
    "-q",
    ...addr,
    "--input",
    "--select",
    "mentionable@",
  ]).catch(() => undefined);
  if (after === undefined) {
    console.error("mentionable: board link NOT re-established");
    failed++;
  } else {
    console.log("mentionable: board link present");
  }
}
if ((row.rawArgument as Record<string, unknown> | undefined)?.myName) {
  console.log("myName: not restored (deprecated legacy link)");
}

console.log(`restored ${Object.keys(restoreDoc).length} field(s)`);
if (failed > 0) Deno.exit(1);
