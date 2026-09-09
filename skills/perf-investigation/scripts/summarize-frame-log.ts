/**
 * Summarize a `CF_MEMORY_FRAME_LOG` capture: frames by type with their bytes,
 * roots, upserts and operations; the documents delivered, grouped by their
 * top-level keys; the selectors by how many roots used them; and with
 * `--timeline` every frame in order, with `--docs` the documents delivered
 * more than once.
 *
 * A capture holds frame records and `dir: "selector"` records; only the
 * former are frames, and the counts here say so. A document is identified by
 * its id together with its scope, branch and instance, so two documents that
 * share an id are two. Documents arrive as a sync's `upserts` or as a
 * `graph.query` response's `entities`, and both count as delivered.
 *
 *   deno run --allow-read summarize-frame-log.ts <log.jsonl> [--timeline] [--docs]
 */
type Record_ = Record<string, unknown>;
type DocRecord = {
  id?: unknown;
  scope?: unknown;
  branch?: unknown;
  scopeKey?: unknown;
  bytes?: unknown;
  keys?: unknown;
};

const [file, ...flags] = Deno.args;
if (file === undefined) {
  console.error(
    "usage: summarize-frame-log.ts <log.jsonl> [--timeline] [--docs]",
  );
  Deno.exit(2);
}
const records = (await Deno.readTextFile(file)).split("\n").filter(Boolean)
  .map((line) => JSON.parse(line) as Record_);
const frames = records.filter((record) => record.dir !== "selector");
const selectors = new Map<string, Record_>();
for (const record of records) {
  if (record.dir === "selector") selectors.set(String(record.hash), record);
}

const bytesOf = (record: { bytes?: unknown }): number =>
  typeof record.bytes === "number" && Number.isFinite(record.bytes)
    ? record.bytes
    : 0;
const identityOf = (doc: DocRecord): string =>
  [doc.id, doc.scope, doc.branch, doc.scopeKey]
    .map((part) => part === undefined ? "" : String(part)).join("\0");
const deliveredIn = (frame: Record_): DocRecord[] => {
  const sync = frame.sync as { upserts?: DocRecord[] } | undefined;
  const entities = frame.entities as DocRecord[] | undefined;
  return [...(sync?.upserts ?? []), ...(entities ?? [])];
};

type Bucket = {
  n: number;
  bytes: number;
  delivered: number;
  roots: number;
  ops: number;
};
const byType = new Map<string, Bucket>();
const keySets = new Map<string, { n: number; bytes: number }>();
const selectorUse = new Map<string, number>();
let deliveredTotal = 0;
let deliveredBytes = 0;
let outBytes = 0;
let inBytes = 0;
const docSeen = new Map<string, number>();
for (const frame of frames) {
  const key = `${frame.dir} ${frame.type}${
    frame.effectType ? "/" + frame.effectType : ""
  }`;
  const bucket = byType.get(key) ??
    { n: 0, bytes: 0, delivered: 0, roots: 0, ops: 0 };
  bucket.n++;
  bucket.bytes += bytesOf(frame);
  if (frame.dir === "out") outBytes += bytesOf(frame);
  else inBytes += bytesOf(frame);
  for (const doc of deliveredIn(frame)) {
    bucket.delivered++;
    deliveredTotal++;
    deliveredBytes += bytesOf(doc);
    const identity = identityOf(doc);
    docSeen.set(identity, (docSeen.get(identity) ?? 0) + 1);
    const keys = Array.isArray(doc.keys)
      ? [...doc.keys].sort().join(",")
      : String(doc.keys);
    const set = keySets.get(keys) ?? { n: 0, bytes: 0 };
    set.n++;
    set.bytes += bytesOf(doc);
    keySets.set(keys, set);
  }
  const watches = (frame.watches ?? frame.query) as
    | { roots: { selector: string }[] }[]
    | undefined;
  for (const watch of watches ?? []) {
    bucket.roots += watch.roots.length;
    for (const root of watch.roots) {
      selectorUse.set(root.selector, (selectorUse.get(root.selector) ?? 0) + 1);
    }
  }
  const commit = frame.commit as { operations: unknown[] } | undefined;
  if (commit) bucket.ops += commit.operations.length;
  byType.set(key, bucket);
}
const kb = (bytes: number) => (bytes / 1024).toFixed(0);
console.log(
  `frames ${frames.length} (${records.length - frames.length} selector ` +
    `records), out ${kb(outBytes)}KB, in ${kb(inBytes)}KB, documents ` +
    `delivered ${deliveredTotal} (${kb(deliveredBytes)}KB), distinct ` +
    `${docSeen.size}, delivered more than once: ${
      [...docSeen.values()].filter((n) => n > 1).length
    }`,
);
console.log("\n## by frame type");
for (const [key, b] of [...byType].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(
    `${String(b.n).padStart(6)}x ${
      kb(b.bytes).padStart(7)
    }KB roots=${b.roots} ` +
      `delivered=${b.delivered} ops=${b.ops}  ${key}`,
  );
}
console.log("\n## delivered documents by top-level keys");
for (
  const [keys, v] of [...keySets].sort((a, b) => b[1].n - a[1].n).slice(0, 25)
) {
  console.log(
    `${String(v.n).padStart(6)}x ${kb(v.bytes).padStart(7)}KB  ${keys}`,
  );
}
console.log("\n## selectors by use");
for (
  const [hash, n] of [...selectorUse].sort((a, b) => b[1] - a[1]).slice(0, 15)
) {
  const selector = selectors.get(hash);
  console.log(
    `${String(n).padStart(6)}x ${
      String(selector?.bytes).padStart(7)
    }B  ${hash}  ${JSON.stringify(selector?.selector).slice(0, 160)}`,
  );
}
if (flags.includes("--timeline")) {
  console.log("\n## timeline");
  for (const frame of frames) {
    const delivered = deliveredIn(frame).length;
    const watches = (frame.watches ?? frame.query) as
      | { roots: unknown[] }[]
      | undefined;
    const commit = frame.commit as
      | { operations: unknown[]; confirmedReads: number; pendingReads: number }
      | undefined;
    const extra = delivered > 0
      ? ` delivered=${delivered}`
      : watches
      ? ` watches=${watches.length} roots=${
        watches.reduce((sum, watch) => sum + watch.roots.length, 0)
      }`
      : commit
      ? ` ops=${commit.operations.length} reads=${commit.confirmedReads}+${commit.pendingReads}`
      : "";
    console.log(
      `${String(frame.t).padStart(7)}ms ${String(frame.dir).padEnd(3)} ${
        (String(frame.type) + (frame.effectType ? "/" + frame.effectType : ""))
          .padEnd(22)
      } ${String(bytesOf(frame)).padStart(9)}B${extra}`,
    );
  }
}
if (flags.includes("--docs")) {
  console.log("\n## documents delivered more than once");
  for (
    const [identity, n] of [...docSeen].filter(([, n]) => n > 1)
      .sort((a, b) => b[1] - a[1]).slice(0, 30)
  ) {
    const [id, scope, branch] = identity.split("\0");
    console.log(
      `${String(n).padStart(4)}x ${id}${scope ? ` scope=${scope}` : ""}${
        branch ? ` branch=${branch}` : ""
      }`,
    );
  }
}
