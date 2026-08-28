import type { FabricValue, JSONSchema } from "@commonfabric/api";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import {
  type CrossTraversalSchemaMemo,
  type IMemorySpaceValueAttestation,
  MapSetStringToPathSelectors,
  type NormalizedFullLink,
  schemaMemoIdentityKey,
  type SchemaPathSelector,
  schemaTrackerKey,
  type TraverseResult,
} from "@commonfabric/runner/graph-query";

import {
  type CellScope,
  resolveScopeKey,
  type ScopeKeyIdentity,
  scopeOfScopeKey,
} from "../v2.ts";
import * as Engine from "./engine.ts";

/**
 * A cross-evaluation, per-document memo of schema-walk computation
 * (docs/plans/revision-keyed-schema-memo.md), the memory-side
 * implementation of the runner's {@link CrossTraversalSchemaMemo} seam.
 *
 * Entries are keyed by (branch, scope instance, id, document REVISION,
 * schema), so validity is by key construction: a commit to a document
 * strands every entry recorded at its previous revision, and no
 * invalidation machinery exists — retention is insertion-order LRU under
 * `maxEntries`. An entry carries the traversal result for its (document,
 * schema) subtree plus a manifest of the traversal's DIRECT effects — the
 * registrations and misses its own document's walk produced, and the
 * (document, schema) children it consumed. A hit replays the manifest
 * recursively through the child entries into the current walk's tracker
 * and miss recorder, resolving scoped addresses under the CURRENT
 * identity — effects are re-derived, never replayed from another
 * identity's resolution. Validation is the same recursion: a child whose
 * document changed has no entry at its current revision, which invalidates
 * exactly the ancestor chain from the change to the query root.
 *
 * Scoped reach gates sharing. A document's own instance is in the key, so
 * entries for scoped documents never collide across identities. An entry
 * for a SPACE-scoped document whose subtree reached user- or
 * session-scoped state (a registration, miss, or child under a non-space
 * instance) is `tainted` and keyed with the evaluating identity appended:
 * it serves only that identity, and taint climbs only the ancestor chain
 * of the scoped reach. Cross-identity sharing of the untainted rest also
 * rests on evaluation being recipient-blind — the invariant the query
 * evaluation cache documents (key-vocabulary.md §5): a per-recipient
 * filter inside evaluation must key or bypass this memo too.
 */
export type SchemaWalkMemoStore = {
  /** The engine the entries' revisions belong to. Sequence numbers
   * identify state only within their engine, so a different engine object
   * for the same space clears the store. */
  engine: Engine.Engine | null;
  entries: Map<string, SchemaWalkMemoEntry>;
  maxEntries: number;
  hits: number;
  misses: number;
  evictions: number;
  /** poison() signals — computations cut by walk-global state (value
   * cycles), whose frames and ancestors never became entries. */
  poisons: number;
};

export type SchemaWalkMemoDiagnostics = {
  entries: number;
  hits: number;
  misses: number;
  evictions: number;
  poisons: number;
};

/** ~5 board-sized corpora; a served entry is a few hundred bytes. */
const DEFAULT_MAX_ENTRIES = 32_768;

export const createSchemaWalkMemoStore = (
  maxEntries: number = DEFAULT_MAX_ENTRIES,
): SchemaWalkMemoStore => {
  // Validated here rather than defended against at each eviction: a
  // negative bound can never be satisfied, so an eviction loop holding to
  // it would run until the process died.
  if (!Number.isInteger(maxEntries) || maxEntries < 0) {
    throw new RangeError(
      `schema walk memo maxEntries must be a non-negative integer: ${maxEntries}`,
    );
  }
  return {
    engine: null,
    entries: new Map(),
    maxEntries,
    hits: 0,
    misses: 0,
    evictions: 0,
    poisons: 0,
  };
};

export const schemaWalkMemoDiagnostics = (
  store: SchemaWalkMemoStore,
): SchemaWalkMemoDiagnostics => ({
  entries: store.entries.size,
  hits: store.hits,
  misses: store.misses,
  evictions: store.evictions,
  poisons: store.poisons,
});

/** A registration or miss in scope-UNRESOLVED form: the instance is
 * re-resolved under the identity of the evaluation that replays it. */
type ManifestEffect = {
  id: string;
  scope: CellScope;
  selector: SchemaPathSelector;
};

type ManifestMiss = ManifestEffect & {
  referrer?: { id: string; scope: CellScope };
};

/** A document revision a frame's computation read: the reason the frame's
 * entry stops being valid when that document changes. Registrations and
 * misses both put their documents here — a walk reads what it registers,
 * and reads the absence it records. */
type ReadRevision = {
  id: string;
  scope: CellScope;
  revision: string;
};

/** A (document, path, schema) subtree this entry's traversal consumed.
 * `entryKey` is the child's stored key when its frame became an entry —
 * usable directly while nothing has committed since (the validation
 * stamp fast path); after a commit, validation re-resolves the child at
 * its current revision instead. */
type ChildDep = {
  id: string;
  scope: CellScope;
  pathKey: string;
  schemaKey: string;
  entryKey: string | undefined;
};

export type SchemaWalkMemoEntry = {
  result: TraverseResult<FabricValue>;
  registrations: ManifestEffect[];
  misses: ManifestMiss[];
  readRevs: ReadRevision[];
  children: ChildDep[];
  tainted: boolean;
  /** The engine seq this entry's revisions were last confirmed current
   * at. Revisions move only with commits, so an entry stamped at the
   * current seq validates by entry presence alone — no engine reads. */
  validatedAt: number;
};

type Frame = {
  id: string;
  scope: CellScope;
  pathKey: string;
  schemaKey: string;
  registrations: ManifestEffect[];
  misses: ManifestMiss[];
  readRevs: Map<string, ReadRevision>;
  children: ChildDep[];
  childKeys: Set<string>;
  tainted: boolean;
  /** The computation was cut short by walk-global state, or lost a child
   * frame to an error: its effects are not a standalone computation's,
   * and neither this frame nor any ancestor may become an entry. */
  poisoned: boolean;
};

/** The walk's schema tracker with capture: every registration the
 * traversal makes is offered to the active session's open frame before it
 * lands. Replay writes through `addWithoutCapture`, so a served subtree's
 * registrations never re-enter the frame that is serving it. `clone()` is
 * inherited and returns a PLAIN tracker — states cached or cloned from a
 * capturing walk carry no capture hook. */
export class CapturingSchemaTracker extends MapSetStringToPathSelectors {
  #session: SchemaWalkMemoSession | undefined;

  constructor() {
    super(true);
  }

  bind(session: SchemaWalkMemoSession): void {
    this.#session = session;
  }

  public override add(key: string, value: SchemaPathSelector) {
    this.#session?.captureRegistration(key, value);
    super.add(key, value);
  }

  addWithoutCapture(key: string, value: SchemaPathSelector): void {
    super.add(key, value);
  }
}

/** `${space}/${scope_key}/${id}` → its parts. The space and the scope-key
 * segment never contain "/" (their parts are encodeURIComponent-encoded),
 * so the first two separators are exact and the remainder is the id,
 * which can contain "/". */
const parseTrackerKey = (
  key: string,
): { id: string; scope: CellScope; scopeKey: string } => {
  const first = key.indexOf("/");
  const second = key.indexOf("/", first + 1);
  const scopeKey = key.slice(first + 1, second);
  return {
    id: key.slice(second + 1),
    scope: scopeOfScopeKey(scopeKey),
    scopeKey,
  };
};

/** Injective over the segments (JSON escapes the separator). */
const pathKeyOf = (path: readonly string[]): string => JSON.stringify(path);

/** Boolean schemas are legal and common (`schema: true` roots); the
 * interner takes only object schemas, so the two get sentinel keys of
 * their own. */
const schemaKeyOf = (schema: JSONSchema): string =>
  typeof schema === "boolean"
    ? (schema ? "B:true" : "B:false")
    : internSchemaAsTaggedHashString(schema);

/**
 * One evaluation's view of a {@link SchemaWalkMemoStore}: the frame stack
 * that attributes captured effects, the per-evaluation revision and
 * validation caches, and the replay machinery. Constructed by `trackGraph`
 * per evaluation and handed to the walk as its
 * {@link CrossTraversalSchemaMemo}.
 */
export class SchemaWalkMemoSession implements CrossTraversalSchemaMemo {
  readonly #store: SchemaWalkMemoStore;
  readonly #engine: Engine.Engine;
  readonly #space: string;
  readonly #branch: string;
  readonly #identity: ScopeKeyIdentity;
  readonly #identityKey: string;
  readonly #tracker: CapturingSchemaTracker;
  #missRecorder:
    | ((
      missKey: string,
      selector: SchemaPathSelector,
      referrerKey: string | undefined,
    ) => void)
    | undefined;
  readonly #frames: Frame[] = [];
  /** scopeKey|id → revision component, one row read per document per
   * evaluation. `"A"` = the document is absent — a revision state of its
   * own: entries recorded against absence stay valid exactly while the
   * document stays absent, and its creation strands them by key. */
  readonly #revisions = new Map<string, string>();
  readonly #validated = new Map<string, boolean>();
  readonly #replayed = new Set<string>();
  /** entryKey -> the child entry keys THIS evaluation's validation
   * resolved, which replay then follows — the two passes must agree on
   * which stored subtree stands for each dependency. */
  readonly #resolvedChildren = new Map<string, string[]>();
  readonly #currentSeq: number;

  constructor(options: {
    store: SchemaWalkMemoStore;
    engine: Engine.Engine;
    space: string;
    branch: string;
    identity: ScopeKeyIdentity;
    tracker: CapturingSchemaTracker;
  }) {
    this.#store = options.store;
    this.#engine = options.engine;
    this.#space = options.space;
    this.#branch = options.branch;
    this.#identity = options.identity;
    this.#identityKey = schemaMemoIdentityKey(options.identity);
    this.#tracker = options.tracker;
    this.#currentSeq = Engine.serverSeq(options.engine);
    options.tracker.bind(this);
  }

  /** Tee the walk's miss recorder: capture for the open frame, then
   * record live. The wrapped recorder is also the replay target. */
  wrapMissRecorder(
    recorder: (
      missKey: string,
      selector: SchemaPathSelector,
      referrerKey: string | undefined,
    ) => void,
  ): (
    missKey: string,
    selector: SchemaPathSelector,
    referrerKey: string | undefined,
  ) => void {
    this.#missRecorder = recorder;
    return (missKey, selector, referrerKey) => {
      this.#captureMiss(missKey, selector, referrerKey);
      recorder(missKey, selector, referrerKey);
    };
  }

  captureRegistration(key: string, selector: SchemaPathSelector): void {
    const frame = this.#frames.at(-1);
    if (frame === undefined) return;
    const { id, scope, scopeKey } = parseTrackerKey(key);
    frame.registrations.push({ id, scope, selector });
    this.#captureReadRev(frame, id, scope);
    if (scopeKey !== "space") frame.tainted = true;
  }

  /** A frame read this document (registered it, or recorded its
   * absence), so the frame's entry depends on its revision — including
   * documents read through pointer chains that never get frames of their
   * own. */
  #captureReadRev(frame: Frame, id: string, scope: CellScope): void {
    const revKey = `${scope}|${id}`;
    if (!frame.readRevs.has(revKey)) {
      frame.readRevs.set(revKey, {
        id,
        scope,
        revision: this.#revisionOf(scope, id),
      });
    }
  }

  #captureMiss(
    missKey: string,
    selector: SchemaPathSelector,
    referrerKey: string | undefined,
  ): void {
    const frame = this.#frames.at(-1);
    if (frame === undefined) return;
    const miss = parseTrackerKey(missKey);
    const referrer = referrerKey === undefined
      ? undefined
      : parseTrackerKey(referrerKey);
    frame.misses.push({
      id: miss.id,
      scope: miss.scope,
      selector,
      ...(referrer === undefined
        ? {}
        : { referrer: { id: referrer.id, scope: referrer.scope } }),
    });
    this.#captureReadRev(frame, miss.id, miss.scope);
    if (
      miss.scopeKey !== "space" ||
      (referrer !== undefined && referrer.scopeKey !== "space")
    ) {
      frame.tainted = true;
    }
  }

  #revisionOf(scope: CellScope, id: string): string {
    const scopeKey = resolveScopeKey(scope, this.#identity);
    const cacheKey = `${scopeKey}|${id}`;
    const cached = this.#revisions.get(cacheKey);
    if (cached !== undefined) return cached;
    const head = Engine.readRevision(this.#engine, {
      id,
      scopeKey,
      branch: this.#branch,
    });
    const revision = head === null || head.op === "delete"
      ? "A"
      : `${head.seq}.${head.opIndex}`;
    this.#revisions.set(cacheKey, revision);
    return revision;
  }

  #entryKey(
    scope: CellScope,
    id: string,
    pathKey: string,
    revision: string,
    schemaKey: string,
    tainted: boolean,
  ): string {
    const scopeKey = resolveScopeKey(scope, this.#identity);
    const base =
      `${this.#branch}|${scopeKey}|${id}|${pathKey}|${revision}|${schemaKey}`;
    return tainted ? `${base}|I${this.#identityKey}` : base;
  }

  /** The entry for (scope, id, path, schema) at the document's CURRENT
   * revision: the untainted key first, then this identity's tainted key. */
  #entryFor(
    scope: CellScope,
    id: string,
    pathKey: string,
    schemaKey: string,
  ): { key: string; entry: SchemaWalkMemoEntry } | undefined {
    const revision = this.#revisionOf(scope, id);
    const pureKey = this.#entryKey(
      scope,
      id,
      pathKey,
      revision,
      schemaKey,
      false,
    );
    const pure = this.#store.entries.get(pureKey);
    if (pure !== undefined) return { key: pureKey, entry: pure };
    const taintedKey = this.#entryKey(
      scope,
      id,
      pathKey,
      revision,
      schemaKey,
      true,
    );
    const tainted = this.#store.entries.get(taintedKey);
    return tainted === undefined
      ? undefined
      : { key: taintedKey, entry: tainted };
  }

  /** Validate `entry`'s transitive closure. An entry stamped at the
   * current seq needs only entry PRESENCE down the closure (revisions
   * move only with commits); a stale stamp re-checks every read revision
   * and re-resolves each child at its current revision, then stamps.
   *
   * A key reads as INVALID while its own closure is being checked, so a
   * dependency cycle resolves to "recompute it" rather than recursing
   * forever or resting on an assumption a later failure would falsify.
   * Stored entries cannot form such a cycle today — a value cycle
   * poisons every frame containing it, and poisoned frames are never
   * stored — so this costs nothing and needs no cycle bookkeeping. */
  #validate(key: string, entry: SchemaWalkMemoEntry): boolean {
    const known = this.#validated.get(key);
    if (known !== undefined) return known;
    this.#validated.set(key, false);
    const stamped = entry.validatedAt === this.#currentSeq;
    if (!stamped) {
      for (const read of entry.readRevs) {
        if (this.#revisionOf(read.scope, read.id) !== read.revision) {
          return false;
        }
      }
    }
    const resolved: string[] = [];
    for (const child of entry.children) {
      let childKey: string | undefined;
      let childEntry: SchemaWalkMemoEntry | undefined;
      if (stamped && child.entryKey !== undefined) {
        childKey = child.entryKey;
        childEntry = this.#store.entries.get(childKey);
      } else {
        const found = this.#entryFor(
          child.scope,
          child.id,
          child.pathKey,
          child.schemaKey,
        );
        childKey = found?.key;
        childEntry = found?.entry;
      }
      if (
        childKey === undefined || childEntry === undefined ||
        !this.#validate(childKey, childEntry)
      ) {
        return false;
      }
      resolved.push(childKey);
    }
    this.#resolvedChildren.set(key, resolved);
    entry.validatedAt = this.#currentSeq;
    this.#validated.set(key, true);
    return true;
  }

  #replay(key: string, entry: SchemaWalkMemoEntry): void {
    if (this.#replayed.has(key)) return;
    this.#replayed.add(key);
    for (const registration of entry.registrations) {
      this.#tracker.addWithoutCapture(
        schemaTrackerKey(
          this.#space,
          registration.id,
          registration.scope,
          this.#identity,
        ),
        registration.selector,
      );
    }
    const recorder = this.#missRecorder;
    if (recorder !== undefined) {
      for (const miss of entry.misses) {
        recorder(
          schemaTrackerKey(this.#space, miss.id, miss.scope, this.#identity),
          miss.selector,
          miss.referrer === undefined ? undefined : schemaTrackerKey(
            this.#space,
            miss.referrer.id,
            miss.referrer.scope,
            this.#identity,
          ),
        );
      }
    }
    // Follow the exact child entries validation resolved for this
    // evaluation, so the effects replayed are the ones validation vouched
    // for.
    for (const childKey of this.#resolvedChildren.get(key) ?? []) {
      const child = this.#store.entries.get(childKey);
      if (child !== undefined) this.#replay(childKey, child);
    }
  }

  #recordChild(
    frame: Frame,
    child: ChildDep,
    childTainted: boolean,
  ): void {
    const dedupeKey =
      `${child.scope}|${child.id}|${child.pathKey}|${child.schemaKey}`;
    if (!frame.childKeys.has(dedupeKey)) {
      frame.childKeys.add(dedupeKey);
      frame.children.push(child);
    }
    if (childTainted || child.scope !== "space") frame.tainted = true;
  }

  #depOfFrame(frame: Frame, entryKey: string | undefined): ChildDep {
    return {
      id: frame.id,
      scope: frame.scope,
      pathKey: frame.pathKey,
      schemaKey: frame.schemaKey,
      entryKey,
    };
  }

  #depOf(
    doc: IMemorySpaceValueAttestation,
    schema: JSONSchema,
    entryKey?: string,
  ): ChildDep {
    return {
      id: doc.address.id,
      scope: doc.address.scope ?? "space",
      pathKey: pathKeyOf(doc.address.path),
      schemaKey: schemaKeyOf(schema),
      entryKey,
    };
  }

  lookup(
    doc: IMemorySpaceValueAttestation,
    schema: JSONSchema,
    _link?: NormalizedFullLink,
  ): TraverseResult<FabricValue> | undefined {
    const dep = this.#depOf(doc, schema);
    const found = this.#entryFor(
      dep.scope,
      dep.id,
      dep.pathKey,
      dep.schemaKey,
    );
    if (found === undefined || !this.#validate(found.key, found.entry)) {
      this.#store.misses++;
      return undefined;
    }
    this.#replay(found.key, found.entry);
    this.#store.hits++;
    // Recency: a served entry moves to the young end of the LRU order.
    this.#store.entries.delete(found.key);
    this.#store.entries.set(found.key, found.entry);
    const frame = this.#frames.at(-1);
    if (frame !== undefined) {
      this.#recordChild(
        frame,
        { ...dep, entryKey: found.key },
        found.entry.tainted,
      );
    }
    return found.entry.result;
  }

  enter(
    doc: IMemorySpaceValueAttestation,
    schema: JSONSchema,
    _link?: NormalizedFullLink,
  ): void {
    this.#frames.push({
      id: doc.address.id,
      scope: doc.address.scope ?? "space",
      pathKey: pathKeyOf(doc.address.path),
      schemaKey: schemaKeyOf(schema),
      registrations: [],
      misses: [],
      readRevs: new Map(),
      children: [],
      childKeys: new Set(),
      tainted: false,
      poisoned: false,
    });
  }

  exit(
    _doc: IMemorySpaceValueAttestation,
    _schema: JSONSchema,
    result: TraverseResult<FabricValue>,
    _link?: NormalizedFullLink,
  ): void {
    const frame = this.#frames.pop();
    if (frame === undefined) return;
    let storedKey: string | undefined;
    if (!frame.poisoned) {
      const revision = this.#revisionOf(frame.scope, frame.id);
      const key = this.#entryKey(
        frame.scope,
        frame.id,
        frame.pathKey,
        revision,
        frame.schemaKey,
        frame.tainted,
      );
      const previous = this.#store.entries.get(key);
      if (previous !== undefined) this.#store.entries.delete(key);
      this.#store.entries.set(key, {
        result,
        registrations: frame.registrations,
        misses: frame.misses,
        readRevs: [...frame.readRevs.values()],
        children: frame.children,
        tainted: frame.tainted,
        validatedAt: this.#currentSeq,
      });
      storedKey = key;
      while (this.#store.entries.size > this.#store.maxEntries) {
        const oldest = this.#store.entries.keys().next().value!;
        this.#store.entries.delete(oldest);
        this.#store.evictions++;
      }
    }
    const parent = this.#frames.at(-1);
    if (parent !== undefined) {
      this.#recordChild(
        parent,
        this.#depOfFrame(frame, storedKey),
        frame.tainted,
      );
      if (frame.poisoned) parent.poisoned = true;
    }
  }

  abandon(): void {
    this.#frames.pop();
    // A frame vanished mid-computation, so whatever contains it did not
    // observe a completed child.
    const parent = this.#frames.at(-1);
    if (parent !== undefined) parent.poisoned = true;
  }

  poison(): void {
    this.#store.poisons++;
    const frame = this.#frames.at(-1);
    if (frame !== undefined) frame.poisoned = true;
  }

  dependency(
    doc: IMemorySpaceValueAttestation,
    schema: JSONSchema,
    _link?: NormalizedFullLink,
  ): void {
    const frame = this.#frames.at(-1);
    if (frame === undefined) return;
    const dep = this.#depOf(doc, schema);
    const found = this.#entryFor(
      dep.scope,
      dep.id,
      dep.pathKey,
      dep.schemaKey,
    );
    // An unknown child taints conservatively: the entry (if this frame
    // stores one) narrows to this identity, and a parent whose child
    // entry is missing fails validation at lookup regardless.
    this.#recordChild(
      frame,
      { ...dep, entryKey: found?.key },
      found === undefined ? true : found.entry.tainted,
    );
  }
}
