---
status: historical
created: 2026-08-04
archived: 2026-08-04
reason: "Rehearsal record of the first two-toolchain vintage capture (CT-1941): procedure, capture script, and measurements."
---

# Two-toolchain vintage rehearsal — 2026-06-18 `home.tsx` (CT-1941)

The Tier-2 state-continuity gate captured every fixture by compiling the old
pattern with the **current** in-process toolchain, so it structurally could not
hold the failure class that has broken production repeatedly: a stored source
the current toolchain no longer compiles. This records the first capture that
closed that gap — `system/home.tsx` as of `d5d115cda` (2026-06-18), whose
import closure fails to compile today on two counts (`cf-cell-context`, retired
by #5132; `safeDateNow`, removed) — and what replaying it measured.

The live procedure this rehearsal produced is documented in
`docs/specs/pattern-update-testing.md` ("Adopting an externally captured
fixture"); the adopter is `tasks/vintage-adopt.ts`. This document is the
point-in-time record: the exact capture script, the numbers, and the findings.

## Shape

1. **Capture** runs out of process, in a disposable git worktree at the old
   revision, under that revision's own pinned toolchain. It produces a plain
   space-store SQLite via `VACUUM INTO`.
2. **Adopt** runs in the current tree: opens the snapshot (memory migrations
   run here, exactly as reopening a real old space does), derives the recorded
   root from its capture cause, verifies the stored `patternIdentity`, writes
   the in-store manifest + restore-control doc, emits a pinned fixture.
3. **Replay** is the unmodified gate: `deno task pattern-vintage`.

## Capture procedure (as executed)

```
git -C <repo> worktree add <scratch>/rev-d5d115cda d5d115cda --detach
cd <scratch>/rev-d5d115cda
mise trust && mise install deno@2.8.1   # that revision pins 2.8.1
mise x deno@2.8.1 -- deno run --allow-ffi --allow-read --allow-write \
  --allow-env --allow-net capture-vintage.ts
```

The committed `deno.lock` was respected — no `--no-lock`, no regeneration.
`@db/sqlite` is absent from that revision's root import map, so the VACUUM
helper lived in a second untracked file under `packages/memory/` (whose own
import map has it): a `vacuumInto(src, dest)` / `readHeadIds(path)` pair over
`Database` from `@db/sqlite`.

Facts about that revision the script had to fit (none hold at today's HEAD):

- No `openFileBackedRuntime`, no state-continuity harness, no
  `packages/memory/v2/dump.ts` — snapshotting is a hand-rolled `VACUUM INTO`.
- `EmulatedStorageManager.emulate()` is in-memory only, but the protected
  constructor accepts a server factory, so a ~20-line subclass passes
  `new MemoryV2Server.Server({ store, authorizeSessionOpen })` with a
  directory-mode store URL. The old `Server` has no `sessionOpenAuth` option;
  the trivial `authorizeSessionOpen` closure from `emulate()` suffices.
- The home-space branch in `PiecesController` requires the session's space DID
  to equal the signer's DID: `createSession({ identity, spaceDid: did })`,
  NOT the `spaceName` arm.
- `ensureDefaultPattern` resolves its program over HTTP; the script reproduces
  its tail verbatim with `FileSystemProgramResolver` rooted at
  `packages/patterns` (home imports `../self.tsx`). The `"home-pattern"` cause
  string is load-bearing — it is what makes the root's entity id derivable at
  adopt time.
- The signer is `Identity.fromPassphrase("pattern vintage fixture")` — the
  same passphrase every committed fixture uses, so the space DID matches what
  the replay derives.

The capture script (verbatim; compiles only against that revision's APIs,
which is why it is recorded here rather than committed as source):

```ts
// CT-1941 one-off vintage capture: materialize the home pattern at rev
// d5d115cda into a file-backed emulated memory-v2 store, verify the
// sub-pattern children instantiated, then VACUUM the space sqlite into a
// snapshot fixture.

import { createSession, Identity } from "@commonfabric/identity";
import { type Cell, NAME, Runtime } from "@commonfabric/runner";
import { type NameSchema, nameSchema } from "@commonfabric/runner/schemas";
import {
  EmulatedStorageManager,
  type Options,
} from "@commonfabric/runner/storage/cache.deno";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { PieceManager } from "@commonfabric/piece";
import { readHeadIds, vacuumInto } from "./packages/memory/capture-vacuum.ts";

const OLD_ROOT = "<the worktree>";
const STORE_DIR = "<scratch>/store";
const SNAPSHOT_PATH = "<scratch>/home-d5d115cda.sqlite";

// File-backed variant of the loopback-emulated storage manager: same trivial
// session-open authorization as EmulatedStorageManager.emulate(), but the
// server persists to a directory-mode store URL (engine appends
// engine-v3/<encoded-did>.sqlite).
class FileEmulatedStorageManager extends EmulatedStorageManager {
  constructor(
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
    store: URL,
  ) {
    super(
      { ...options, memoryHost: new URL("memory://") },
      () =>
        new MemoryV2Server.Server({
          store,
          authorizeSessionOpen(message) {
            const principal = (message.authorization as {
              principal?: unknown;
            })?.principal;
            return typeof principal === "string" ? principal : undefined;
          },
        }),
    );
  }
}

const signer = await Identity.fromPassphrase("pattern vintage fixture");
const did = signer.did();

await Deno.mkdir(STORE_DIR, { recursive: true });
const storageManager = new FileEmulatedStorageManager(
  { as: signer },
  new URL(`file://${STORE_DIR}/`),
);
const runtime = new Runtime({
  apiUrl: new URL("http://toolshed.test"),
  storageManager,
});
const session = await createSession({ identity: signer, spaceDid: did });
const manager = new PieceManager(session, runtime);
await manager.synced();

const space = manager.getSpace();
if (space !== runtime.userIdentityDID) {
  throw new Error("space !== runtime.userIdentityDID — not the home space");
}

// ---- ensureDefaultPattern tail (pieces-controller.ts:330-449 at this rev),
// with the HTTP resolver swapped for the filesystem one.
const program = await runtime.harness.resolve(
  new FileSystemProgramResolver(
    `${OLD_ROOT}/packages/patterns/system/home.tsx`,
    `${OLD_ROOT}/packages/patterns`,
  ),
);
const pattern = await runtime.patternManager.compilePattern(program, { space });
const entryRef = runtime.patternManager.getArtifactEntryRef(pattern);

await runtime.editWithRetry((tx) => {
  const spaceCellWithTx = manager.getSpaceCellContents().withTx(tx);
  const defaultPatternCell = spaceCellWithTx.key("defaultPattern");
  if (defaultPatternCell.get()?.get()) return;
  const pieceCell = runtime.getCell<NameSchema>(
    space,
    "home-pattern", // load-bearing: the adopter re-derives the root from this
    nameSchema,
    tx,
  );
  runtime.run(tx, pattern, {}, pieceCell);
  defaultPatternCell.set(pieceCell.withTx(tx));
});

const finalPattern = await manager.getDefaultPattern(false);
if (!finalPattern) throw new Error("no default pattern");
await manager.startPiece(finalPattern);
await runtime.idle();
await manager.synced();
await runtime.idle(); // settle sub-pattern instantiation
await manager.synced();

// ---- Verification: refuse to snapshot unless embedded children exist.
// (Walk the resolved result for nested objects carrying a $NAME.)
const resultCell = (finalPattern as Cell<NameSchema>).asSchema(
  { type: "object", additionalProperties: true } as never,
) as Cell<Record<string, unknown>>;
await resultCell.sync();
const value = resultCell.get() as Record<string, unknown>;
const childNames: string[] = [];
const seen = new Set<object>();
(function walk(node: unknown, depth: number, isRoot: boolean) {
  if (!node || typeof node !== "object" || depth > 40) return;
  if (seen.has(node as object)) return;
  seen.add(node as object);
  if (!isRoot) {
    const name = (node as Record<string, unknown>)[NAME];
    if (typeof name === "string") childNames.push(name);
  }
  const entries = Array.isArray(node) ? node : Object.values(node as object);
  for (const item of entries) {
    try {
      walk(item, depth + 1, false);
    } catch (_e) { /* proxied stream reads can throw */ }
  }
})(value, 0, true);
if (childNames.length === 0) {
  throw new Error("no embedded sub-pattern children — refusing to snapshot");
}

// ---- Teardown so the WAL is checkpointed, then snapshot.
await runtime.dispose();
await storageManager.close();
const engineDir = `${STORE_DIR}/engine-v3`;
let storeFile: string | undefined;
for (const entry of Deno.readDirSync(engineDir)) {
  if (entry.isFile && entry.name.endsWith(".sqlite")) {
    storeFile = `${engineDir}/${entry.name}`;
  }
}
if (!storeFile) throw new Error("no space store written");
vacuumInto(storeFile, SNAPSHOT_PATH);
console.log(JSON.stringify({
  did,
  patternIdentity: entryRef?.identity,
  childNames,
  headCounts: readHeadIds(SNAPSHOT_PATH).length,
}));
```

## Measurements

- Capture verified **before** snapshotting: all four home children
  instantiated (`Favorites Manager`, `My Self`, `Choose a profile`,
  `Create Profile`). Snapshot: 3.2 MB raw, 95 heads = 93 `of:` + 2 `cid:`
  compile-cache entries, **zero `computed:`** — the `computed:` id kind
  postdates this revision, so its absence is era-correct, not a defect.
- The June pattern identity is `f7Eojq_4T5E1hhfzRKJQdqON826TunWquJKYwrtdS80`
  (filesystem-resolved). The same source served over HTTP hashes differently
  (`C9Y2rIrEK…` — the identity a real estuary space of that era records),
  the known served-vs-local identity split. Either works for the gate: it only
  needs to differ from today's.
- **Cause-derived entity ids are stable across the six-week gap**: the current
  tree re-derived `of:fid1:brERQlTY-8w6YcwsmA-WJ_9UmmJDzWP6GmkLCLeUGRw` from
  the `"home-pattern"` cause, byte-identical to what the June tree minted.
- The two DDL migrations since June (`head.op` backfill from #4894,
  scheduler-v2 rebuild from #4288) ran silently on adopt. Adopted fixture
  after compaction: 1.2 MB — the smallest pinned fixture in the tree.
- **Replay exercises the rot class**: during the update, the runtime attempts
  to load the vintage's children by identity from their in-store source
  closures and fails with exactly the predicted errors
  (`pattern-load-error` × 2: `cf-cell-context`, `safeDateNow`). The gate
  completes green — a fresh boot re-instantiates children from today's
  compiled home — which is itself a finding: the gate has no eyes on
  by-identity load failures.
- Two harness accommodations were needed, both live-documented in the spec:
  presence accepts `patternIdentity` as well as `patternSetupIdentity`
  (the setup marker postdates every genuinely-old store), and the adopter
  stamps the restore-control doc a native capture gets from its test run.

## CT-1939 relevance (why this vintage, why now)

A live estuary home space (June-era, displaced to current on 2026-07-23)
rendered every embedded sub-pattern blank with no console output; its root was
healthy and re-materialized, but no child piece entities existed (CT-1939).
This rehearsal ran the closest approximation yet to that sequence — genuine
June store, today's roll-forward (`materializeOnCell`, the production repair
call), fresh boot through `PieceManager.getDefaultPattern(true)` — and it
**healed completely**: all four children re-created, `computed:` heads minted
by today's toolchain, despite the mid-update load failures.

That eliminates "old store + roll-forward + fresh boot" as sufficient
conditions for the blanking. Surviving candidates, recorded on CT-1939: CFC
enforcement (on for estuary, off in every harness path) and the
runtime-client worker boot route; the served-route compile
(`deriveSystemPatternSource` over HTTP) and updater-initiated timing also
remain untested. The probe that measured this (restore → update → fresh-boot →
enumerate children) was a throwaway variant of `tasks/vintage-adopt.ts`'s
open-and-derive sequence plus `materializeOnCell` and a
`PieceManager.getDefaultPattern(true)` boot; rebuilding it from those parts is
a few minutes' work against the committed fixture.
