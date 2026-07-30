/**
 * Tier 2 of the pattern-update regime: prove a new pattern can still READ the
 * state an older version of itself wrote.
 *
 * Tier 1 (`deno task pattern-compat`) proves the argument/result contract is
 * backward compatible. That is a statement about schemas, and schemas do not
 * describe everything a pattern writes: move where a field is STORED
 * (`.for('items')` → `.for('itemList')`) and the declared contract does not
 * change by a single byte, while every document written under the old name
 * becomes unreachable. No contract comparison can see that, and nothing
 * throws — only replaying a real prior state catches it.
 *
 * The other class this replays, the CFC additive-required migration refusing a
 * setup commit for a required field with no default (the 2026-07-22 estuary
 * brick), is already covered twice over — by Tier 1's schema check and by
 * `packages/runner/test/cfc-additive-default-preserves-old-doc.test.ts`, which
 * drives the same rejection over a legacy root. It is replayed here for the
 * PIPELINE rather than the guard: proving capture → snapshot → reopen →
 * materialize end to end needs a class whose correct outcome is already known
 * independently, or a green run would only be evidence about itself.
 *
 * The state is captured as a **SQLite space store**, not a bespoke JSON dump.
 * A space is one SQLite file, `snapshotSpaceStore` already writes a
 * crash-consistent copy of one, and restoring is a file copy — where a JSON
 * dump would need a re-writer that reconstructs docs, causes and links, and
 * getting causes wrong silently produces a fixture that is not the state that
 * was captured.
 *
 * Capture is deliberately file-backed: `StorageManager.emulate` runs a real
 * memory server against `:memory:`, which has no file to snapshot.
 */

import { fromFileUrl } from "@std/path/from-file-url";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  snapshotSpaceStore,
  spaceStorePath,
} from "@commonfabric/memory/v2/dump";
import { resolveSpaceStoreUrl } from "@commonfabric/memory/v2/storage-path";
import type { Signer } from "@commonfabric/memory/interface";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../../runner/src/storage/v2.ts";
import {
  type Cell,
  CHIP_UI,
  getPatternSetupIdentityRef,
  isCell,
  isStream,
  Runtime,
  TILE_UI,
  UI,
} from "@commonfabric/runner";
import type { RuntimeProgram } from "@commonfabric/runner";
// The comparison's two leaf cases. A materialized root is not plain data: at an
// `asCell`/`asStream` position it holds a live cell, and a durable doc may hold
// a fabric special object (bytes, an epoch). Neither survives a structural
// comparison unaided — see `comparableState`.
import { FabricSpecialObject } from "@commonfabric/data-model/interface";
import { taggedHashStringOf } from "@commonfabric/data-model/value-hash";
import { deepEqual } from "@commonfabric/utils/deep-equal";
// Relative into the runner's internals for the same reason as the test
// utilities below: `getMetaLink` and the link shape it returns are how the
// runtime itself reaches a root's argument document, and re-deriving that
// here would be a second spelling to drift.
import { getMetaLink } from "../../runner/src/link-utils.ts";
import type { NormalizedFullLink } from "../../runner/src/link-types.ts";
// Relative into the runner's test utilities: they are not part of the runner's
// public exports, and the loopback-server auth handshake has exactly one
// correct spelling — duplicating it here would be a second copy to drift.
import {
  TEST_MEMORY_SERVER_AUTH,
  testPrincipalSessionOpenAuthFactory,
} from "../../runner/test/memory-v2-test-utils.ts";

class LoopbackSessions implements SessionFactory {
  constructor(private readonly server: () => MemoryV2Server.Server) {}
  async create(spaceId: string, signer?: Signer) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.server()),
    });
    const session = await client.mount(
      spaceId,
      {},
      testPrincipalSessionOpenAuthFactory(signer),
    );
    return { client, session };
  }
}

class FileBackedStorageManager extends StorageManager {
  static make(as: Identity, server: MemoryV2Server.Server) {
    return new FileBackedStorageManager(
      { as, memoryHost: new URL("memory://") } as Options,
      server,
    );
  }
  private constructor(options: Options, server: MemoryV2Server.Server) {
    super(options, new LoopbackSessions(() => server));
  }
  override registerSpaceHost(): boolean {
    return false;
  }
}

function serverOver(storeDir: string): MemoryV2Server.Server {
  return new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
    store: new URL(`file://${storeDir}/`),
  });
}

export interface VintageRuntime {
  runtime: Runtime;
  /**
   * The store behind `runtime`, exposed so another harness can write into the
   * same file. The vintage capture hands this to the pattern-test runner so a
   * pattern's OWN tests populate the fixture — real state through real
   * handlers, rather than a bare materialized root with nothing in it.
   */
  storageManager: StorageManager;
  space: string;
  storeDir: string;
  /** Snapshot this space to `destPath`. Crash-consistent, runs no migrations. */
  snapshot(destPath: string): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * A runtime whose space lives in a real file, so it can be snapshotted.
 *
 * `storeDir` is the caller's to clean up. Pass an existing `fromSnapshot` to
 * start from a captured vintage instead of an empty space.
 */
export async function openFileBackedRuntime(
  signer: Identity,
  storeDir: string,
  fromSnapshot?: string,
): Promise<VintageRuntime> {
  const space = signer.did();
  const storeUrl = new URL(`file://${storeDir}/`);

  if (fromSnapshot !== undefined) {
    // Place the snapshot where the engine resolves this space's store. The
    // path encodes the DID, and restoring under the SAME DID is deliberate:
    // re-keying is an unbounded migration that would destroy the fidelity the
    // fixture exists to buy (CFC labels name the space, among other things).
    await seedSpaceStore(storeDir, space, fromSnapshot);
  }

  const server = serverOver(storeDir);
  const storageManager = FileBackedStorageManager.make(signer, server);
  const runtime = new Runtime({
    apiUrl: new URL("http://toolshed.test"),
    storageManager,
  });

  return {
    runtime,
    storageManager,
    space,
    storeDir,
    async snapshot(destPath: string) {
      // Everything must be durable before the copy, or the fixture records a
      // state the capture never actually reached.
      await runtime.idle();
      await runtime.storageManager.synced();
      const path = spaceStorePath(storeUrl, space);
      if (path === null) {
        throw new Error(
          `no space store for ${space} under ${storeDir} — nothing was written`,
        );
      }
      snapshotSpaceStore(path, destPath);
    },
    async dispose() {
      await runtime.dispose();
      await storageManager.close();
      // The server owns what the file actually is: a SQLite engine per space,
      // a read pool, and a scheduled refresh timer. `storageManager.close()`
      // only tears down the client side, so without this every case leaks its
      // engines and its timer past the case that opened them — and the temp
      // dir is removed out from under still-open handles.
      await server.close();
    },
  };
}

/**
 * Copy a snapshot into the place the engine looks for `space`'s store.
 *
 * The layout is resolved with `resolveSpaceStoreUrl`, the same helper the
 * server resolves through — directory mode nests one level deeper than
 * single-file mode, and rebuilding that rule here would rot silently. Note it
 * COMPUTES a path rather than stat-ing one, which is what this needs: the
 * destination does not exist yet.
 */
async function seedSpaceStore(
  storeDir: string,
  space: string,
  snapshotPath: string,
): Promise<void> {
  const target = fromFileUrl(
    resolveSpaceStoreUrl(new URL(`file://${storeDir}/`), space as never),
  );
  await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
    recursive: true,
  });
  await Deno.copyFile(snapshotPath, target);
}

/** The root key a fixture uses when it holds exactly one pattern. */
export const DEFAULT_VINTAGE_ROOT_KEY = "vintage-root";

/**
 * The cause of a captured space's root cell — shared by the harness helper
 * below and by the capture, which pins the test pattern's result cell to it.
 *
 * The cause is fixed rather than minted, because `PieceManager.setupPersistent`
 * otherwise defaults to `{ space, random: crypto.randomUUID() }` and the root's
 * entity id would differ on every capture — the fixture could then never be
 * re-read by id. (Root creation through `ensureDefaultPattern` bakes
 * `Date.now()` into its cause for the same reason, so a root fixture has to go
 * around that path.)
 *
 * `key` is what keeps that determinism from becoming ALIASING. `getCell`
 * derives the entity id as `createRef({}, cause)` (`runtime.ts`), and that
 * derivation does not include the space — so a single fixed cause would give
 * every root in every fixture the same entity id. Within one space store that
 * is a silent collision: materializing a second pattern would stamp its
 * identity over the first pattern's root, no error, and the fixture would
 * replay something nobody captured. One key per pattern keeps roots distinct
 * while each stays addressable across captures.
 */
export function vintageRootCause(
  key: string = DEFAULT_VINTAGE_ROOT_KEY,
): { stateContinuity: string } {
  return { stateContinuity: key };
}

/** A stable root cell for a captured space, addressable across captures. */
export function vintageRoot<T>(
  vintage: VintageRuntime,
  schema: unknown,
  key: string = DEFAULT_VINTAGE_ROOT_KEY,
): Cell<T> {
  return vintage.runtime.getCell<T>(
    vintage.space as never,
    vintageRootCause(key),
    schema as never,
  );
}

/**
 * Cause of the doc a fixture stores its instantiation manifest under.
 *
 * The manifest lives INSIDE the store rather than in a sidecar file. A sidecar
 * would be a second artifact that can drift from the state it describes and
 * would need its own append-only discipline; an in-store doc travels in the
 * same file, is copied atomically with the state, and keeps "restore is a
 * single `Deno.copyFile`" true. The cost is one doc no pattern wrote —
 * acceptable for a fixture, and namespaced here so it cannot collide.
 */
export const VINTAGE_MANIFEST_CAUSE = {
  stateContinuity: "vintage-manifest",
} as const;

/** What a capture recorded about one pattern materialization. */
export interface VintageManifestEntry {
  identity: string;
  symbol: string;
  /** Entry filename, repo-root-relative (`/packages/patterns/system/home.tsx`). */
  main?: string;
  /** Entity id of the result cell the pattern was materialized onto. */
  cellId: string;
  space: string;
}

export interface VintageManifest {
  entries: VintageManifestEntry[];
}

/**
 * Schema for the manifest doc.
 *
 * Explicit rather than `undefined`: a schema-less read comes back as a
 * query-result proxy whose array elements resolve lazily, and iterating it gave
 * `undefined` entries — the manifest has to materialize as plain data before
 * anything reads it.
 */
const VINTAGE_MANIFEST_SCHEMA = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          identity: { type: "string" },
          symbol: { type: "string" },
          main: { type: "string" },
          cellId: { type: "string" },
          space: { type: "string" },
        },
        required: ["identity", "symbol", "cellId", "space"],
      },
    },
  },
  required: ["entries"],
} as const;

/** Write the manifest into the store, so it travels with the state. */
export async function writeVintageManifest(
  vintage: VintageRuntime,
  entries: readonly VintageManifestEntry[],
): Promise<void> {
  const cell = vintage.runtime.getCell<VintageManifest>(
    vintage.space as never,
    VINTAGE_MANIFEST_CAUSE,
    VINTAGE_MANIFEST_SCHEMA as never,
  );
  const { error } = await vintage.runtime.editWithRetry((tx) => {
    cell.withTx(tx).set({ entries: entries.map((e) => ({ ...e })) } as never);
  });
  if (error !== undefined) {
    throw new Error(`could not write vintage manifest: ${error.message}`);
  }
  await vintage.runtime.idle();
  // The snapshot copies the FILE, so the write has to be durable before it —
  // an in-flight manifest would produce a fixture whose state is real and whose
  // update targets are missing.
  await vintage.runtime.storageManager.synced();
}

/** Read a restored fixture's manifest. `undefined` = none recorded. */
export async function readVintageManifest(
  vintage: VintageRuntime,
): Promise<VintageManifest | undefined> {
  const cell = vintage.runtime.getCell<VintageManifest>(
    vintage.space as never,
    VINTAGE_MANIFEST_CAUSE,
    VINTAGE_MANIFEST_SCHEMA as never,
  );
  await cell.sync();
  try {
    const value = cell.get() as VintageManifest | undefined;
    if (value === undefined || !Array.isArray(value.entries)) return undefined;
    // Detach from the query-result proxy: its array elements resolve lazily,
    // and a caller that iterates the live view sees `undefined` entries.
    const entries = value.entries
      .map((entry) => (entry === undefined ? undefined : { ...entry }))
      .filter((entry): entry is VintageManifestEntry => entry !== undefined);
    return { entries };
  } catch {
    // An absent doc reads as a throw rather than undefined; for this question
    // the two are the same answer.
    return undefined;
  }
}

/**
 * The link to a root's durable ARGUMENT document.
 *
 * State a pattern RETURNS lives in the cells it owns (`.for('items')`); state
 * it RECEIVES lives in a separate document the root points at through its
 * `argument` meta link. The two travel different code paths on an update — the
 * result doc goes through the CFC schema merge, the argument through the
 * runner's setup validation — so a tier that only ever populates results
 * measures half the surface.
 *
 * Returned as a link rather than a `Cell` because callers need to build the
 * cell against their own transaction, and because the schema to read it under
 * is the question (a value stored under the OLD argument schema is exactly
 * what a NEW one may no longer accept).
 */
export async function vintageArgumentLink(
  vintage: VintageRuntime,
  resultSchema: unknown,
  rootKey: string = DEFAULT_VINTAGE_ROOT_KEY,
): Promise<NormalizedFullLink> {
  const root = vintageRoot<Record<string, unknown>>(
    vintage,
    resultSchema,
    rootKey,
  );
  await root.sync();
  const link = getMetaLink(root as never, "argument");
  if (link === undefined) {
    throw new Error(
      "vintage root has no argument meta link — it was never set up, so " +
        "there is no durable argument to capture or replay",
    );
  }
  return link;
}

/** What a cycle in a materialized root becomes. Structural, so two of them
 * compare equal, and JSON-safe, so a report can print it. */
const CYCLE = Object.freeze({ "[cycle]": true });

/**
 * A materialized root, detached and reduced to something two of can be
 * COMPARED.
 *
 * A materialized root is not plain data, and three of the things in it defeat a
 * structural comparison outright:
 *
 * - **A live cell.** At every `asCell`/`asStream` position — the six handler
 *   streams on `home.tsx`'s root, among others — the read yields a `Cell`,
 *   whose own enumerable properties include `runtime`. A generic deep copy
 *   therefore copies the whole runtime object graph into the snapshot, cycles
 *   and all. Measured on the committed `home.tsx` fixture: the copy is cyclic
 *   (`scheduler` → `runtime` → back), `JSON.stringify` on it throws, and the
 *   copy compares UNEQUAL to the live cell it came from because one side is a
 *   plain object and the other a class instance — so every stream key reports
 *   as stranded and printing the finding takes the run down with it. Reduced
 *   here to the DOCUMENT the cell points at, which is the durable thing about
 *   it: a stream that moved to a different doc still shows up, and the schema
 *   is deliberately dropped, being a view rather than data.
 * - **A fabric special object** (`FabricBytes`, an epoch). These hold their
 *   state in private fields, so a structural comparison sees two objects with
 *   no properties and calls them equal REGARDLESS of contents —
 *   `deepEqual`'s own documentation says so, and it is the quietest way a
 *   comparison can pass. Reduced to a tagged content hash, which is the
 *   data-model's own notion of equality for them (`valueEqual` ends in the same
 *   hash) without needing a comparator that also has to survive link sigils.
 * - **A cycle.** Even with cells reduced, the data itself may point back at
 *   itself; `deepEqual` recurses until the stack ends. Cut with a marker rather
 *   than by sharing the copy, so what comes out of here is acyclic — which is
 *   what lets a failure report stringify it.
 *
 * Everything else is copied plainly, and `bigint` and `undefined` pass through
 * as themselves — the two values a JSON round-trip could not carry.
 *
 * Idempotent: run over its own output it returns an equal structure, so a
 * caller that normalizes early and a caller that normalizes late agree.
 */
export function comparableState(value: unknown): unknown {
  // Cycle detection is per-PATH, not per-value: a shared subtree is expanded at
  // each place it appears, which keeps the copy an honest picture of what was
  // read. Only a genuine loop is cut.
  const onPath = new Set<object>();
  const walk = (current: unknown): unknown => {
    if (current === null || typeof current !== "object") return current;
    if (current instanceof FabricSpecialObject) {
      return { "[fabric]": taggedHashStringOf(current) };
    }
    if (isCell(current) || isStream(current)) {
      const link = current.getAsNormalizedFullLink();
      return {
        "[cell]": {
          space: link.space,
          id: link.id,
          path: [...link.path],
        },
      };
    }
    if (onPath.has(current)) return CYCLE;
    onPath.add(current);
    try {
      if (Array.isArray(current)) return current.map(walk);
      const copy: Record<string, unknown> = {};
      for (const key of Object.keys(current)) {
        copy[key] = walk((current as Record<string, unknown>)[key]);
      }
      return copy;
    } finally {
      onPath.delete(current);
    }
  };
  return walk(value);
}

/**
 * A captured root's state, read the way the version that WROTE it saw it.
 *
 * Read under the root's OWN stored result schema, which it carries in meta — so
 * the writing version's view of its data is recoverable without its source, and
 * without this replay having to decide what that view should be.
 *
 * The schema is what makes the read DETERMINISTIC rather than a report on what
 * happens to be resident. A schema-driven read pulls exactly what the schema
 * descends into; a schema-less `.get()` resolves whatever is already loaded,
 * which is the shape of bug that made a cross-space profile read as absent
 * (#3830). It is not that a schema-less read comes back empty — measured on the
 * committed `home.tsx` fixture it returns every key, and MORE of some of them:
 * `$UI` materializes, where under the stored schema (`unknown` at that key) it
 * reads as `undefined`. It is that what it returns depends on load order.
 *
 * Returns a copy detached and reduced by `comparableState`: the live value is a
 * query-result proxy that re-reads through the transaction, so holding it across
 * a materialize would compare the new state against itself.
 */
export async function readVintageState(
  vintage: VintageRuntime,
  cellId: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = vintage.runtime.getCellFromEntityId(
      vintage.space as never,
      cellId as never,
      [],
      undefined as never,
    );
    await raw.sync();
    const storedSchema = raw.getMetaRaw("schema");
    if (storedSchema === undefined) return undefined;
    const typed = vintage.runtime.getCellFromEntityId(
      vintage.space as never,
      cellId as never,
      [],
      storedSchema as never,
    );
    await typed.sync();
    const value = typed.get();
    // `comparableState`, not a JSON round-trip and not a generic deep copy. The
    // live value is a query-result proxy that re-reads through the transaction,
    // so it has to be detached — but a JSON round-trip is lossy on exactly the
    // values a durable doc may hold (`FabricBytes` and epoch wrappers collapse
    // to `{}`, a `bigint` throws), and a generic copy drags the runtime object
    // graph in behind every live cell.
    const detached = comparableState(value);
    // Narrow rather than cast. A root is an object in practice, but asserting
    // it would hand `strandedKeys` a non-object to enumerate — and "no keys"
    // reads exactly like "nothing stranded".
    if (typeof detached !== "object" || detached === null) return undefined;
    return detached as Record<string, unknown>;
  } catch {
    // A cell that cannot be read is `undefined`, not a throw. The caller treats
    // that as a FAILURE for this entry (a recorded root the fixture does not
    // hold), which is the right verdict — but only if it can be reported. Left
    // throwing, one unreadable cell would abort the whole vintage and take
    // every remaining target and fixture with it.
    return undefined;
  }
}

/**
 * The result keys that hold a RENDERING rather than state.
 *
 * Taken from the runner's own constants rather than spelled as strings here:
 * the set of UI variants is the runtime's to define, and a copy would silently
 * stop matching the day a variant is added.
 */
const RENDERINGS: ReadonlySet<string> = new Set([UI, TILE_UI, CHIP_UI]);

/**
 * Keys whose value the update did not preserve.
 *
 * Only keys present BEFORE are compared: an update may legitimately ADD a
 * field (that is what `Default<>` is for), so a new key is not a finding. An
 * existing key whose value changed is — that is data the old version wrote and
 * the new one no longer reads back.
 *
 * The RENDERINGS are excluded, and nothing else. A root's `$UI`/`$TILE_UI`/
 * `$CHIP_UI` is a projection the setup recomputes, and the stored rendering and
 * a fresh one are not the same artifact even when nothing about the data
 * changed: measured on the committed `default-app.tsx` fixture, a COMMENT-only
 * edit to `piece-grid.tsx` reports `$UI` as stranded — `children: [null]` where
 * the vintage held it against `children: [[]]` freshly rendered — and the same
 * edit to `note.tsx` reports `$UI` and `$TILE_UI`, one side carrying a
 * `type: "vnode"` tag the other does not. Comparing those keys says nothing
 * about data and reds every pattern edit, so the gate would be turned off
 * within a week of landing.
 *
 * That is the whole list, and it is deliberately not "derived values" in
 * general: `$NAME` is derived too and stayed equal across both of those edits,
 * so it is compared — it is a cheap tell that the data behind it went missing.
 * The cost is real and worth naming: a root whose only key is a rendering
 * (`profile-picker.tsx`) has nothing left for this check to compare, and rests
 * on the refusal, completion and reads-as-something checks instead.
 *
 * Everything else is compared by SHAPE rather than by name. A value the
 * comparison cannot see through — a live cell, a fabric special object, a cycle
 * — is reduced by `comparableState` on both sides rather than skipped.
 *
 * Both sides go through it here rather than only at the call site: the before
 * state arrives already reduced, but the after state is whatever the
 * materialize returned — a LIVE root value — and comparing a detached copy
 * against a live one reports every cell-valued key as stranded. It is
 * idempotent, so normalizing the already-normalized side costs a walk and
 * removes a way to hold this wrong.
 *
 * Compared with `deepEqual`, not stringified. Serialization is the wrong
 * instrument twice over: it is key-order sensitive, so two equivalent objects
 * whose properties were emitted in a different order would report as stranded,
 * and it cannot represent everything a durable doc may hold — a `bigint` throws.
 *
 * `deepEqual` rather than the data-model's `valueEqual`, which is the more
 * obvious choice. `valueEqual` refuses a materialized root outright — measured,
 * it throws `Cannot compare value {"/":{"link@1":{…}}}` — but NOT for the
 * reason that message reads as: a link sigil compares fine, and the value it
 * actually refused was a live CELL, rendered through its `toJSON()` and so
 * printed as the sigil it points at. That is the same fact `comparableState`
 * exists for. Both comparators work once the reduction has run, and this one is
 * kept because it needs no value to be a well-formed `FabricValue` and
 * short-circuits instead of hashing a whole VNode tree; the one class it cannot
 * judge, a fabric special object with its state in private fields, is reduced
 * to a content hash before it gets here rather than being compared by it.
 */
export function strandedKeys(
  before: Record<string, unknown>,
  after: unknown,
): string[] {
  const beforeState = comparableState(before) as Record<string, unknown>;
  const afterState = comparableState(after);
  const afterView = typeof afterState === "object" && afterState !== null
    ? afterState as Record<string, unknown>
    : undefined;
  const stranded: string[] = [];
  for (const key of Object.keys(beforeState)) {
    if (RENDERINGS.has(key)) continue;
    if (!deepEqual(beforeState[key], afterView?.[key])) stranded.push(key);
  }
  return stranded;
}

/**
 * Whether a root value counts as STATE rather than nothing.
 *
 * One predicate, shared by the pre-check below and by the replay's post-check on
 * each migrated root — the two ask the same question, and answering it two ways
 * is how "the root reads as something" comes to mean different things at the two
 * ends of the same run.
 */
export function isPresentRootValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  // An object with no keys is what a fresh space yields for a doc nobody
  // wrote, so it is not evidence either.
  return typeof value !== "object" ||
    Object.keys(value as Record<string, unknown>).length > 0;
}

/**
 * Whether a restored fixture's root already holds state.
 *
 * This is a CONTROL, and the replay gate is unsound without one. A fixture that
 * did not restore — truncated, empty, or seeded where the engine does not look
 * — presents to the runtime as a fresh empty space, and materializing today's
 * source onto a fresh empty space succeeds. The replay would then read green
 * having proved nothing at all: emptiness is indistinguishable from a fixture
 * that was never there.
 *
 * The evidence is "the root holds a value", NOT "the root carries a matching
 * patternIdentity stamp". A vintage is captured by running the pattern's own
 * TESTS, and the test harness roots its graph with `runtime.run`, so the stamp
 * at the root belongs to the TEST pattern rather than to the pattern the
 * fixture is named for — an identity check would reject every fixture the
 * capture produces.
 */
export async function vintageRootHasState(
  vintage: VintageRuntime,
  rootKey: string = DEFAULT_VINTAGE_ROOT_KEY,
): Promise<boolean> {
  const root = vintageRoot<Record<string, unknown>>(
    vintage,
    undefined,
    rootKey,
  );
  await root.sync();
  try {
    return isPresentRootValue(root.get());
  } catch {
    // An absent doc reads as a throw rather than `undefined`, and for this
    // question the two are the same answer: nothing was captured here.
    return false;
  }
}

/** Read a vintage's stored argument under `schema` (`undefined` = raw). */
export async function readVintageArgument(
  vintage: VintageRuntime,
  link: NormalizedFullLink,
  schema: unknown,
): Promise<unknown> {
  const cell = vintage.runtime.getCellFromLink(link).asSchema(schema as never);
  await cell.sync();
  return cell.get();
}

/**
 * A readable message for anything thrown out of a setup commit.
 *
 * Not every rejection on this path is an `Error`: the storage layer surfaces
 * plain `{ name, message, reason }` records, and `String()` renders those as
 * "[object Object]" — which would still satisfy a `toBeDefined()` assertion
 * while destroying the one thing a caller needs to tell a real migration
 * refusal from an unrelated failure. Chase `cause`/`reason` so the CFC token
 * survives the re-wraps between the merge and here.
 */
function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 8;) {
    depth++;
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (typeof current !== "object") {
      parts.push(String(current));
      break;
    }
    const record = current as {
      message?: unknown;
      name?: unknown;
      cause?: unknown;
      reason?: unknown;
    };
    if (typeof record.message === "string") parts.push(record.message);
    else if (typeof record.name === "string") parts.push(record.name);
    current = record.cause ?? record.reason;
  }
  return parts.length > 0 ? parts.join(": ") : String(error);
}

/** What materializing a candidate over a captured vintage did. */
export interface MaterializeOutcome {
  /** The setup-commit rejection, if the candidate could not be applied. */
  error?: string;
  /** The root's value after a successful materialize. */
  value?: Record<string, unknown>;
  /**
   * The candidate's compiled result schema. Handed back so a caller that needs
   * to address the root afterwards reads it off the pattern that was actually
   * materialized, rather than compiling a second time and trusting the two to
   * agree.
   */
  resultSchema: unknown;
  /** The candidate's compiled argument schema, for the same reason. */
  argumentSchema: unknown;
  /**
   * Identity of the pattern that was materialized — the artifact entry ref's
   * identity, not a hash of the source text. A fixture is NAMED with this, so
   * taking it off the compiled artifact is what makes the name provenance
   * rather than a guess: it records the version that actually wrote the state.
   */
  identity: string;
}

/**
 * Materialize `program` onto a captured vintage's root, the way production
 * does.
 *
 * This is the production ROOT REPAIR call, not a bare `runtime.setup`:
 * `PiecesController` commits the candidate's identity onto the root and then
 * runs `runSynced(root.withTx(), pattern, undefined, { expectedPatternIdentity })`
 * (`pieces-controller.ts` — the cold-start repair and the roll-forward
 * materialize both spell it this way). Two things about that shape matter
 * here and neither holds for a bare setup:
 *
 * - `expectedPatternIdentity` is what makes `runSynced` THROW on a
 *   setup-commit rejection instead of logging and continuing. Without it a
 *   refused migration reads as a successful materialize over a dead root —
 *   the gate would be green on exactly the failure it exists to catch.
 * - Stamping the identity first is the update itself. Passing a ref the root
 *   does not carry fails the precondition rather than the migration, which
 *   would be a green-for-the-wrong-reason.
 */
export async function materializeOver(
  vintage: VintageRuntime,
  program: RuntimeProgram,
  rootKey: string = DEFAULT_VINTAGE_ROOT_KEY,
): Promise<MaterializeOutcome> {
  return await materializeOnCell(
    vintage,
    program,
    (v, schema) => vintageRoot<Record<string, unknown>>(v, schema, rootKey),
  );
}

/**
 * Materialize `program` onto a cell chosen by `locate`, through the production
 * repair call.
 *
 * The indirection exists so the replay can target a cell recorded in a
 * fixture's manifest rather than only the well-known vintage root. `locate`
 * receives the compiled result schema, because a root has to be read under the
 * schema of the pattern being applied to it.
 *
 * `symbol` names WHICH artifact in the module to apply. A module contributes
 * more than one instantiable pattern — its default export, plus every
 * transformer hoist (`__cfPattern_N`, the body of a `map`/`filter`/`flatMap`) —
 * and a stored root records the one it was materialized from. Defaulting to the
 * entry export would apply the module's ROOT pattern to a nested pattern's
 * cell, which can refuse a valid migration or, worse, accept an invalid one
 * having checked the wrong artifact.
 */
export async function materializeOnCell(
  vintage: VintageRuntime,
  program: RuntimeProgram,
  locate: (
    vintage: VintageRuntime,
    resultSchema: unknown,
  ) => Cell<Record<string, unknown>>,
  symbol?: string,
): Promise<MaterializeOutcome> {
  const { runtime } = vintage;
  const entryPattern = await runtime.patternManager.compilePattern(program, {
    space: vintage.space as never,
  });
  const entryRef = runtime.patternManager.getArtifactEntryRef(entryPattern);
  if (entryRef === undefined) {
    throw new Error("compiled candidate has no artifact entry ref");
  }
  // `compilePattern` registers the whole evaluated module — exports and
  // `__cfReg` hoists alike — so the named artifact is resolvable in-index
  // under the identity just compiled.
  const selected = symbol === undefined || symbol === entryRef.symbol
    ? entryPattern
    : runtime.patternManager.artifactFromIdentitySync(
      entryRef.identity,
      symbol,
    ) as typeof entryPattern | undefined;
  if (selected === undefined) {
    // Fails CLOSED rather than falling back to the entry pattern: a stored root
    // naming a symbol today's module does not define is a migration hazard to
    // report, not one to paper over.
    //
    // ABSENCE is all this catches, and hoist symbols have a second failure mode
    // it does not. `__cfPattern_N` is positional, so inserting an earlier `map`
    // REBINDS the name instead of removing it — measured: with one `map` the
    // hoist `__cfPattern_1` carried result `{shout}`, and after an earlier `map`
    // was added the same name carried `{other}` while `{shout}` moved to
    // `__cfPattern_2`. A root recorded as `__cfPattern_1` then resolves here to a
    // DIFFERENT nested pattern and this branch never fires. The schema merge
    // catches it only when the two bodies differ in shape. That is a property of
    // positional addressing which `PatternUpdater` shares, not something this
    // gate can fix; selecting the recorded symbol is still strictly better than
    // applying the module's entry export to every nested root.
    return {
      error:
        `today's ${program.main} defines no "${symbol}"; the stored root ` +
        `names an artifact this version does not have`,
      resultSchema: entryPattern.resultSchema,
      argumentSchema: entryPattern.argumentSchema,
      identity: entryRef.identity,
    };
  }
  const pattern = selected;
  // The ref the RUNNER will write, not the one the caller asked by. `setup()`
  // stamps `getArtifactEntryRef(pattern)`, and that map is first-write-wins — so
  // an artifact exported under two names has ONE canonical symbol, decided by
  // export enumeration order, which need not be the name the fixture recorded.
  // Deriving the stamp and the completion comparison from anything else makes a
  // cosmetic export reorder read as a failed migration: measured, flipping
  // `export { Row }` and `export { Row as RowAlias }` reported "setup did not
  // complete for …#Row: the root carries …#RowAlias" for a swap that in fact
  // succeeded, on the same artifact object.
  //
  // Constrained to the identity just compiled. `setArtifactEntryRef` is
  // first-write-wins over the whole session, so an artifact re-registered under a
  // changed identity keeps its original ref — and stamping THAT would write a
  // root's pointer to a version this replay did not compile. Taking the canonical
  // ref only when its identity agrees keeps the alias fix (same module, different
  // name) without inheriting a stale one.
  const canonical = runtime.patternManager.getArtifactEntryRef(pattern);
  const ref = canonical?.identity === entryRef.identity
    ? canonical
    : { identity: entryRef.identity, symbol: symbol ?? entryRef.symbol };
  const root = locate(vintage, pattern.resultSchema);
  await root.sync();

  const { error: stampError } = await runtime.editWithRetry((tx) => {
    root.withTx(tx).setMetaRaw("patternIdentity", {
      identity: ref.identity,
      symbol: ref.symbol,
    });
  });
  if (stampError !== undefined) {
    throw new Error(
      `could not stamp candidate identity: ${stampError.message}`,
    );
  }

  const schemas = {
    resultSchema: pattern.resultSchema,
    argumentSchema: pattern.argumentSchema,
    identity: ref.identity,
  };
  try {
    await runtime.runSynced(root.withTx(), pattern, undefined, {
      expectedPatternIdentity: ref,
    });
    await runtime.idle();
  } catch (error) {
    return { error: describeError(error), ...schemas };
  }
  // `expectedPatternIdentity` makes a rejected setup COMMIT throw, but a swap
  // whose setup itself fails (the candidate refusing the root's stored
  // arguments, say) is only LOGGED as `pattern-swap-setup-error` — `runSynced`
  // returns normally and the migration reads as applied. The completion marker
  // is the honest signal: `setup()` stamps `patternSetupIdentity` only once it
  // has staged the schema, arguments, internal cells, and result projection, so
  // a root that does not carry the candidate's ref was not actually migrated.
  await root.sync();
  const staged = getPatternSetupIdentityRef(root as Cell<unknown>);
  if (staged?.identity !== ref.identity || staged?.symbol !== ref.symbol) {
    return {
      error: `setup did not complete for ${ref.identity}#${ref.symbol}: the ` +
        `root carries ${
          staged === undefined
            ? "no setup marker"
            : `${staged.identity}#${staged.symbol}`
        }`,
      ...schemas,
    };
  }
  await root.pull();
  return {
    value: root.get() as Record<string, unknown> | undefined,
    ...schemas,
  };
}

export type { RuntimeProgram };
