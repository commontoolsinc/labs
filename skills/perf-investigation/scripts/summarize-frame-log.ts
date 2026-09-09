/**
 * Summarize a `CF_MEMORY_FRAME_LOG` capture: frames by type with their bytes,
 * roots, upserts and operations; the documents delivered, grouped by their
 * top-level keys; the selectors by how many roots used them; and with
 * `--timeline` every frame in order, with `--docs` the documents delivered
 * more than once.
 *
 *   deno run --allow-read summarize-frame-log.ts <log.jsonl> [--timeline] [--docs]
 */
const [file, ...flags] = Deno.args;
const lines = (await Deno.readTextFile(file)).split("\n").filter(Boolean).map((
  l,
) => JSON.parse(l));
const selectors = new Map<string, any>();
const byType = new Map<
  string,
  { n: number; bytes: number; upserts: number; roots: number; ops: number }
>();
const keySets = new Map<string, { n: number; bytes: number }>();
const selectorUse = new Map<string, number>();
let upsertTotal = 0, upsertBytes = 0, outBytes = 0, inBytes = 0;
const docSeen = new Map<string, number>();
for (const f of lines) {
  if (f.dir === "selector") {
    selectors.set(f.hash, f);
    continue;
  }
  const key = `${f.dir} ${f.type}${f.effectType ? "/" + f.effectType : ""}`;
  const b = byType.get(key) ?? { n: 0, bytes: 0, upserts: 0, roots: 0, ops: 0 };
  b.n++;
  b.bytes += f.bytes;
  if (f.dir === "out") outBytes += f.bytes;
  else inBytes += f.bytes;
  if (f.sync) {
    b.upserts += f.sync.upserts.length;
    upsertTotal += f.sync.upserts.length;
    for (const u of f.sync.upserts) {
      upsertBytes += u.bytes;
      docSeen.set(u.id, (docSeen.get(u.id) ?? 0) + 1);
      const ks = Array.isArray(u.keys)
        ? u.keys.slice().sort().join(",")
        : String(u.keys);
      const k = keySets.get(ks) ?? { n: 0, bytes: 0 };
      k.n++;
      k.bytes += u.bytes;
      keySets.set(ks, k);
    }
  }
  if (f.watches) {
    for (const w of f.watches) {
      b.roots += w.roots.length;
      for (const r of w.roots) {
        selectorUse.set(r.selector, (selectorUse.get(r.selector) ?? 0) + 1);
      }
    }
  }
  if (f.commit) b.ops += f.commit.operations.length;
  byType.set(key, b);
}
console.log(
  `frames ${lines.length}, out ${(outBytes / 1024).toFixed(0)}KB, in ${
    (inBytes / 1024).toFixed(0)
  }KB, upserts ${upsertTotal} (${
    (upsertBytes / 1024).toFixed(0)
  }KB), distinct docs ${docSeen.size}, docs delivered >1x: ${
    [...docSeen.values()].filter((n) => n > 1).length
  }`,
);
console.log("\n## by frame type");
for (const [k, b] of [...byType].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(
    `${String(b.n).padStart(6)}x ${
      (b.bytes / 1024).toFixed(0).padStart(7)
    }KB roots=${b.roots} upserts=${b.upserts} ops=${b.ops}  ${k}`,
  );
}
console.log("\n## upsert docs by top-level keys");
for (
  const [k, v] of [...keySets].sort((a, b) => b[1].n - a[1].n).slice(0, 25)
) {
  console.log(
    `${String(v.n).padStart(6)}x ${
      (v.bytes / 1024).toFixed(0).padStart(7)
    }KB  ${k}`,
  );
}
console.log("\n## selectors by use");
for (
  const [h, n] of [...selectorUse].sort((a, b) => b[1] - a[1]).slice(0, 15)
) {
  const s = selectors.get(h);
  console.log(
    `${String(n).padStart(6)}x ${String(s?.bytes).padStart(7)}B  ${h}  ${
      JSON.stringify(s?.selector).slice(0, 160)
    }`,
  );
}
if (flags.includes("--timeline")) {
  console.log("\n## timeline");
  for (const f of lines) {
    if (f.dir === "selector") continue;
    const extra = f.sync
      ? ` upserts=${f.sync.upserts.length}`
      : f.watches
      ? ` watches=${f.watches.length} roots=${
        f.watches.reduce((a: number, w: any) => a + w.roots.length, 0)
      }`
      : f.commit
      ? ` ops=${f.commit.operations.length} reads=${f.commit.confirmedReads}+${f.commit.pendingReads}`
      : "";
    console.log(
      `${String(f.t).padStart(7)}ms ${f.dir.padEnd(3)} ${
        (f.type + (f.effectType ? "/" + f.effectType : "")).padEnd(22)
      } ${String(f.bytes).padStart(9)}B${extra}`,
    );
  }
}
if (flags.includes("--docs")) {
  console.log("\n## docs delivered more than once");
  for (
    const [id, n] of [...docSeen].filter(([, n]) => n > 1).sort((a, b) =>
      b[1] - a[1]
    ).slice(0, 30)
  ) console.log(`${String(n).padStart(4)}x ${id}`);
}
