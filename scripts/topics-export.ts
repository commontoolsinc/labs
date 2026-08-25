#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write
/**
 * Export every topic's authored content from a Topics space snapshot,
 * offline. The export is the restore payload `topics-restore.ts` consumes,
 * and the portable backup the content-safety plan calls for: it survives the
 * space becoming unusable, and it diffs against a later export.
 *
 * Usage:
 *   scripts/topics-export.ts <snapshot.sqlite> --out <export.json>
 *     [--topic-identity <id>]... [--board-identity <id>]
 *
 * The snapshot is a `VACUUM INTO` copy of the space store (the acquisition
 * step of docs/development/space-clone-rehearsal.md); everything here reads
 * it through `cf inspect`, so no server is involved. With no identity flags,
 * topics are selected by verb shape — a piece whose result offers
 * `addComment`, `addLink`, and `setBody` — and the board by `addTopic`; the
 * selected pattern identities are printed so an operator can confirm them
 * against the migration manifest, and explicit flags override the inference.
 *
 * Comment and link array elements are stored as links to entities of their
 * own, so the export resolves each element. Any deeper link inside a content
 * field aborts the export: recording a reference as if it were content is
 * exactly the silent corruption this tool exists to rule out.
 */

import {
  cfJson,
  findLink,
  LINKED_ARRAY_FIELDS,
  SCALAR_CONTENT_FIELDS,
  type TopicContent,
  type TopicExportRow,
  type TopicsExport,
} from "./topics-rehearsal-lib.ts";

interface EntityRow {
  id: string;
}

interface PieceInfo {
  id: string;
  pattern?: { identity?: string };
  input?: { id?: string };
  resultKeys?: string[];
}

interface ValueAt {
  exists: boolean;
  value?: unknown;
}

function usage(): never {
  console.error(
    "usage: topics-export.ts <snapshot.sqlite> --out <export.json> " +
      "[--topic-identity <id>]... [--board-identity <id>]",
  );
  Deno.exit(2);
}

const positional: string[] = [];
const topicIdentities: string[] = [];
let boardIdentity: string | undefined;
let outPath: string | undefined;
for (let i = 0; i < Deno.args.length; i++) {
  const arg = Deno.args[i];
  if (arg === "--out") outPath = Deno.args[++i];
  else if (arg === "--topic-identity") topicIdentities.push(Deno.args[++i]);
  else if (arg === "--board-identity") boardIdentity = Deno.args[++i];
  else if (arg.startsWith("--")) usage();
  else positional.push(arg);
}
const snapshot = positional[0];
if (!snapshot || positional.length > 1 || !outPath) usage();

const didMatch = /(did:key:[A-Za-z0-9]+)\.sqlite$/.exec(snapshot);
const spaceDid = didMatch ? didMatch[1] : null;

// A capped listing would hand the export a subset of the space's pieces, and a
// rollback payload missing topics reads exactly like a complete one. The limit
// is named past any plausible piece count so the cap never bites in practice —
// but a finite cap is still a cliff, and `cfJson` reads only stdout, so the
// notice `cf` writes to stderr would go by unseen. `--require-complete` turns
// the same condition into a nonzero exit, which `cf()` DOES raise: the export
// either covers every piece in the space or it does not get written.
const PIECE_LIMIT = 1_000_000;

const pieces = await cfJson<EntityRow[]>([
  "inspect",
  "entities",
  snapshot,
  "--kind",
  "piece",
  "--limit",
  String(PIECE_LIMIT),
  "--require-complete",
  "--json",
]);

const infos: PieceInfo[] = [];
for (const row of pieces) {
  infos.push(
    await cfJson<PieceInfo>(["inspect", "piece", snapshot, row.id, "--json"]),
  );
}

const hasVerbs = (info: PieceInfo, verbs: string[]) =>
  verbs.every((verb) => info.resultKeys?.includes(verb));
const isTopic = (info: PieceInfo) =>
  topicIdentities.length > 0
    ? topicIdentities.includes(info.pattern?.identity ?? "")
    : hasVerbs(info, ["addComment", "addLink", "setBody"]);
const isBoard = (info: PieceInfo) =>
  boardIdentity !== undefined
    ? info.pattern?.identity === boardIdentity
    : hasVerbs(info, ["addTopic"]);

const topicInfos = infos.filter(isTopic);
const boardInfos = infos.filter(isBoard);
if (boardInfos.length > 1) {
  console.error(
    `refusing: ${boardInfos.length} board-shaped pieces; ` +
      `name one with --board-identity:\n` +
      boardInfos.map((b) => `  ${b.id}  ${b.pattern?.identity}`).join("\n"),
  );
  Deno.exit(1);
}
if (topicInfos.length === 0) {
  console.error("refusing: no topic-shaped pieces found in the snapshot");
  Deno.exit(1);
}

async function argumentValue(info: PieceInfo): Promise<unknown> {
  const argumentId = info.input?.id;
  if (!argumentId) {
    throw new Error(`piece ${info.id} reports no argument entity`);
  }
  const at = await cfJson<ValueAt>([
    "inspect",
    "value-at",
    snapshot!,
    argumentId,
    "--json",
    "--full-depth",
  ]);
  if (!at.exists) throw new Error(`argument ${argumentId} does not exist`);
  return at.value;
}

async function resolveElement(
  topicFid: string,
  field: string,
  index: number,
  element: unknown,
): Promise<unknown> {
  const link = (element as { $link?: { id?: string } })?.$link;
  const resolved = link?.id
    ? (await cfJson<ValueAt>([
      "inspect",
      "value-at",
      snapshot!,
      link.id,
      "--json",
      "--full-depth",
    ])).value
    : element;
  const deeper = findLink(resolved);
  if (deeper) {
    throw new Error(
      `${topicFid} ${field}[${index}] holds a link at ${deeper}; ` +
        "the export cannot flatten it and refuses to record a reference " +
        "as content",
    );
  }
  return resolved;
}

// Fields this tool classifies; anything else an argument document carries is
// still exported raw and restored by `buildRestoreDocument`, and is worth a
// line in the summary so a schema that grew is noticed at export time.
const CLASSIFIED_FIELDS = new Set<string>([
  ...SCALAR_CONTENT_FIELDS,
  ...LINKED_ARRAY_FIELDS,
  "myName",
  "mentionable",
]);

const topics: TopicExportRow[] = [];
const unclassified = new Set<string>();
let commentTotal = 0;
let linkTotal = 0;
for (const info of topicInfos) {
  const raw = await argumentValue(info) as Record<string, unknown>;
  const content = { comments: [], links: [] } as TopicContent;
  for (const field of SCALAR_CONTENT_FIELDS) {
    const value = raw[field];
    const linkPath = value === undefined ? null : findLink(value);
    if (linkPath) {
      throw new Error(
        `${info.id} ${field} holds a link at ${linkPath}; refusing to ` +
          "record a reference as content",
      );
    }
    if (value !== undefined) content[field] = value;
  }
  for (const field of LINKED_ARRAY_FIELDS) {
    const elements = Array.isArray(raw[field]) ? raw[field] as unknown[] : [];
    const resolved: unknown[] = [];
    for (let i = 0; i < elements.length; i++) {
      resolved.push(await resolveElement(info.id, field, i, elements[i]));
    }
    content[field] = resolved;
  }
  for (const field of Object.keys(raw)) {
    if (!CLASSIFIED_FIELDS.has(field)) unclassified.add(field);
  }
  commentTotal += content.comments.length;
  linkTotal += content.links.length;
  topics.push({
    fid: info.id,
    patternIdentity: info.pattern?.identity ?? "",
    argumentId: info.input?.id ?? "",
    content,
    rawArgument: raw,
  });
}

let board: TopicsExport["board"] = null;
if (boardInfos.length === 1) {
  const info = boardInfos[0];
  const raw = await argumentValue(info) as Record<string, unknown>;
  board = {
    fid: info.id,
    patternIdentity: info.pattern?.identity ?? "",
    argumentId: info.input?.id ?? "",
    topicsLinks: Array.isArray(raw.topics) ? raw.topics as unknown[] : [],
  };
}

const topicsExport: TopicsExport = {
  version: 1,
  exportedAt: new Date().toISOString(),
  snapshot,
  spaceDid,
  board,
  topics,
  manifest: infos.map((info) => ({
    fid: info.id,
    patternIdentity: info.pattern?.identity ?? "",
    resultKeys: info.resultKeys ?? [],
  })),
};

await Deno.writeTextFile(
  outPath,
  JSON.stringify(topicsExport, null, 2) + "\n",
);

const identities = [...new Set(topicInfos.map((t) => t.pattern?.identity))];
console.log(`wrote ${outPath}`);
console.log(
  `topics: ${topics.length}  comments: ${commentTotal}  links: ${linkTotal}`,
);
console.log(`topic pattern identities: ${identities.join(", ")}`);
if (unclassified.size > 0) {
  console.log(
    `note: unclassified authored fields, carried raw and restored ` +
      `verbatim: ${[...unclassified].sort().join(", ")}`,
  );
}
if (board) {
  console.log(
    `board: ${board.fid} (${board.patternIdentity}), ` +
      `${board.topicsLinks.length} membership links`,
  );
} else {
  console.log("board: none selected");
}
