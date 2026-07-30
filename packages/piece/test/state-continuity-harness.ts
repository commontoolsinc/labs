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
  listSpaceStores,
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
  getPatternSetupIdentityRef,
  Runtime,
} from "@commonfabric/runner";
import {
  companionFileName,
  companionSpace,
  vintageCompanionDir,
} from "./vintage-layout.ts";
import type { RuntimeProgram } from "@commonfabric/runner";
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
  /** The PRIMARY space: the signer's own, and the one a fixture is named for. */
  space: string;
  /**
   * Every space this runtime was restored WITH, primary and companions alike,
   * sorted. Empty for a fresh store.
   *
   * Read at open, before anything can write, so it answers "what did this
   * fixture CARRY" rather than "what has been touched since" — the engine opens
   * a store with `{ create: true }`, so by the time a replay has read anything
   * the answer would already have changed.
   *
   * It is a DIAGNOSIS, not a control: "carries the space" does not imply "holds
   * the root", since a store that opened but never committed restores as a
   * valid empty database. `vintageHoldsRoot` is the control; this is what lets
   * a failure say "the fixture does not carry did:key:…" instead of leaving the
   * reader to work out why a root was not there.
   */
  restoredSpaces: readonly string[];
  storeDir: string;
  /**
   * Snapshot EVERY space this runtime wrote — the primary to `destPath`, the
   * rest into its companion directory. Crash-consistent, runs no migrations.
   *
   * Not atomic: it writes the primary first, then one companion at a time, so a
   * caller that publishes into a shared tree has to clean up after a partial
   * write itself (`captureVintage` does).
   */
  snapshot(destPath: string): Promise<void>;
  dispose(): Promise<void>;
}

/** Every companion store beside `fixturePath`, as `[space, path]`. */
async function companionStores(
  fixturePath: string,
): Promise<[string, string][]> {
  const dir = vintageCompanionDir(fixturePath);
  const found: [string, string][] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile) continue;
      // A name this repo could not have written is not a companion — skipping
      // it cannot lose a real space, and every root whose space did not restore
      // is reported by the replay anyway.
      const space = companionSpace(entry.name);
      if (space === undefined) continue;
      found.push([space, `${dir}/${entry.name}`]);
    }
  } catch (error) {
    // No companion directory means a single-space fixture, which is the common
    // case and not a problem. Anything else must surface.
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  // Sorted so a restore is reproducible rather than directory-order dependent.
  found.sort(([left], [right]) => left.localeCompare(right));
  return found;
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
    // Companions restore under the DID they were captured in, for the same
    // reason and more strictly: a cross-space child's recorded root names that
    // DID, so re-keying would leave the root unaddressable rather than merely
    // relabelled.
    for (const [companion, path] of await companionStores(fromSnapshot)) {
      await seedSpaceStore(storeDir, companion, path);
    }
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
    // Enumerated from disk rather than assumed from `fromSnapshot`, so this is
    // what actually landed where the engine looks — the thing the replay needs
    // to know.
    restoredSpaces: fromSnapshot === undefined
      ? []
      : listSpaceStores(storeUrl).map((info) => info.space).sort(),
    storeDir,
    async snapshot(destPath: string) {
      // Everything must be durable before the copy, or the fixture records a
      // state the capture never actually reached. `idle()` waits for scheduler
      // quiescence and no further, and compiled/source closure write-backs —
      // including the cross-space replication a companion store would carry —
      // are tracked separately and drained only here. A fixture is read by a
      // FRESH runtime, which is precisely the case that flush exists for.
      await runtime.idle();
      await runtime.patternManager.flushCompileCacheWrites();
      await runtime.storageManager.synced();
      const path = spaceStorePath(storeUrl, space);
      if (path === null) {
        throw new Error(
          `no space store for ${space} under ${storeDir} — nothing was written`,
        );
      }
      snapshotSpaceStore(path, destPath);
      // Every OTHER space the run wrote travels too, enumerated from the store
      // itself rather than from what an observer recorded: the two can disagree,
      // and the copy has to be a statement about what is on disk.
      //
      // "Has a store file" is NOT "holds state" — the engine opens with
      // `{ create: true }`, so merely reaching a space leaves an empty database
      // behind, and copying one carries nothing. That is why the replay's
      // per-root control is `vintageHoldsRoot` and not a question about spaces.
      const companionDir = vintageCompanionDir(destPath);
      const companions = listSpaceStores(storeUrl).filter((info) =>
        info.space !== space
      );
      if (companions.length > 0) {
        await Deno.mkdir(companionDir, { recursive: true });
      }
      for (const info of companions) {
        // `listSpaceStores` just stat'd this file, so re-resolving it cannot
        // legitimately come back null; `!` rather than a branch nothing can
        // reach. `snapshotSpaceStore` throws on a path that is not there.
        snapshotSpaceStore(
          spaceStorePath(storeUrl, info.space)!,
          `${companionDir}/${companionFileName(info.space)}`,
        );
      }
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
 * Whether the fixture actually HOLDS the root a manifest entry names.
 *
 * The control that has to run per entry, before today's source is applied to
 * it. "The fixture carries this space" is not the same claim: a space store
 * that opened but never committed is a valid empty database, an entity id is
 * content-derived and so names a cell in any space, and a cell nobody wrote
 * reads as absent rather than as an error. Materializing onto one of those
 * SUCCEEDS — the root then holds today's defaults, `isPresentRootValue` is
 * satisfied, and the entry counts as updated cleanly over state that was never
 * there. Measured: with a companion store truncated to zero bytes, a break that
 * the gate is built to catch replays with no failures at all.
 *
 * The evidence is the SETUP MARKER, not a value. The runner stamps
 * `patternSetupIdentity` under the same condition that reports an instantiation
 * to the capture observer (`runner.ts` — deliberately the same, so the store
 * cannot label roots the observer missed or vice versa), so every manifest
 * entry's cell carries one by construction. A value check would instead depend
 * on the pattern's result shape, and a root whose result is legitimately `{}`
 * would read as missing.
 */
export async function vintageHoldsRoot(
  vintage: VintageRuntime,
  space: string,
  cellId: string,
): Promise<boolean> {
  const cell = vintage.runtime.getCellFromEntityId(
    space as never,
    cellId as never,
    [],
    undefined as never,
  );
  try {
    await cell.sync();
    return getPatternSetupIdentityRef(cell as Cell<unknown>) !== undefined;
  } catch {
    // An absent doc surfaces as a throw rather than `undefined`, and for this
    // question the two are the same answer: nothing was captured here.
    return false;
  }
}

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
 * `options.symbol` names WHICH artifact in the module to apply. A module
 * contributes more than one instantiable pattern — its default export, plus
 * every transformer hoist (`__cfPattern_N`, the body of a `map`/`filter`/
 * `flatMap`) — and a stored root records the one it was materialized from.
 * Defaulting to the entry export would apply the module's ROOT pattern to a
 * nested pattern's cell, which can refuse a valid migration or, worse, accept
 * an invalid one having checked the wrong artifact.
 *
 * `options.space` is the space to COMPILE in, which production takes from the
 * root being updated (`pattern-updater.ts` compiles with the piece's space).
 * It is not cosmetic: it selects the space a `cf:` fabric import resolves
 * against and the space the compiled/source closure is persisted into
 * (`compileViaCellCache`), so compiling a cross-space root's candidate in the
 * fixture's primary space could resolve a different closure than the one that
 * root actually loads. Defaults to the primary space, which is where a
 * single-space fixture's roots live.
 */
export async function materializeOnCell(
  vintage: VintageRuntime,
  program: RuntimeProgram,
  locate: (
    vintage: VintageRuntime,
    resultSchema: unknown,
  ) => Cell<Record<string, unknown>>,
  options: { symbol?: string; space?: string } = {},
): Promise<MaterializeOutcome> {
  const { runtime } = vintage;
  const { symbol, space = vintage.space } = options;
  const entryPattern = await runtime.patternManager.compilePattern(program, {
    space: space as never,
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
