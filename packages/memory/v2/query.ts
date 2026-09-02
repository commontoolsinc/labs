import type { FabricValue, JSONSchema } from "@commonfabric/api";
import {
  internPathSelector,
  internSchemaAsTaggedHashString,
  REJECTING_SELECTOR,
} from "@commonfabric/data-model-schema";
import {
  createGraphQueryWalkStats,
  createSchemaMemo,
  GraphQueryWalk,
  type GraphQueryWalkStats,
  type IAttestation,
  MapSetStringToPathSelectors,
  type ObjectStorageManager,
  type SchemaMemo,
  type SchemaPathSelector,
  schemaTrackerCoversSelector,
  schemaTrackerKey,
  sinkMetaLinkedDocKeys,
} from "@commonfabric/runner/graph-query";
import { isObjectNotArray } from "@commonfabric/utils/types";

import { collectExternalSchemaRefHashes } from "../../runner/src/schema-decompose.ts";
import {
  lookupSchemaDocument,
  registerSchemaDocument,
} from "../../runner/src/schema-registry.ts";
import { isSubschema } from "../../runner/src/schema-walk.ts";
import type { MemorySpace, MIME, URI } from "../interface.ts";
import { mapLinkSchemas } from "./schema-table-links.ts";
import {
  canResolveScopeKey,
  type CellScope,
  type CommitClass,
  type EntitySnapshot,
  getServerExecutionConfig,
  type GraphQuery,
  type GraphQueryRoot,
  isScopeKey,
  resolveScopeKey,
  type ScopeKey,
  type ScopeKeyIdentity,
  scopeOfScopeKey,
  toDocumentSelector,
} from "../v2.ts";
import * as Engine from "./engine.ts";

const DEFAULT_SCOPE: CellScope = "space";

/**
 * Query/watch doc keys are per scope INSTANCE (scopes.md §7 M2, stage E):
 * the middle segment is the shared scope_key vocabulary, resolved against
 * the querying session's identity — the same identity the manager resolves
 * scoped reads with, so a key names exactly the instance the tracked read
 * saw. Per tracked-graph state the identity is fixed, so this re-keying
 * partitions state exactly as the scope-NAME form did (key-vocabulary.md
 * §2).
 */
export type QueryDocKey = `${string}/${ScopeKey}/${string}`;

export type TrackedGraphState = {
  branch: string;
  tracker: MapSetStringToPathSelectors;

  /** Value-link dead-ends the query's walks read as ABSENT (see
   * GraphQueryWalkOptions.onMissedDoc): keyed like the tracker, never
   * delivered — a miss keeps the graph reactive to the document's later
   * creation (the wake pass and the dirty refresh consult it) without
   * putting an absence marker on the wire. */
  missed: MapSetStringToPathSelectors;

  /** missKey → the REFERRER keys whose links dead-ended on it. A miss
   * lives while any referrer attributes it: a referrer that is
   * re-walked clears its attributions first, so a link edited away
   * retires the miss instead of leaving a stale wake (an
   * attribution-less miss — defensive, no known producer — retires
   * only on its own arrival). */
  missedBy: Map<string, Set<string>>;

  /** referrerKey → the miss keys it attributed (the reverse index the
   * re-walk clears by). */
  missesOf: Map<string, Set<string>>;

  entities: Map<QueryDocKey, EntitySnapshot>;
  memo: SchemaMemo;
  manager: EngineObjectManager;

  /** Every doc key a query has NAMED as a root, absent roots included —
   * the persistent role record. A refresh re-walk consults it: a named
   * document is owed its full family on every visit (and a healed absent
   * root its first), while a merely tracked document keeps the crossing
   * shape it was reached with, so delivery does not depend on update
   * history. */
  roots: Set<string>;

  /** Doc keys registered for delivery-on-next-commit: the internal-rail
   * documents of crossing-reached pieces, keyed but never loaded at
   * registration. A commit leaving one with a live, deliverable snapshot
   * promotes it — delivered whole, moved into the tracker, its own
   * internal links registered here in turn — so a subscriber stays
   * reactive to every derived cell of every piece it can see while
   * receiving only the ones that change. A deletion is not a promotion:
   * the registration stays, and the recreation promotes it. */
  lazy: Set<string>;

  /** lazyKey → the REFERRER keys whose manifests registered it, and the
   * reverse index — the same lifecycle the miss attribution runs: a
   * referrer about to be re-walked releases its registrations first, the
   * re-walk re-records the entries its manifest still carries, and a
   * registration whose last referrer lets go retires with it, so a
   * dropped manifest entry stops waking the session and is never
   * delivered as an unreachable document. */
  lazyBy: Map<string, Set<string>>;
  lazyOf: Map<string, Set<string>>;

  /** Root doc keys whose FULL metadata family this state has chased —
   * recorded when a query NAMES a document and its walk visits it. A
   * crossing records reach in the tracker but only the crossing rails of
   * the family, so coverage of a later query that names the document
   * requires this record too: reach without family is not coverage for a
   * root (see isGraphQueryCoveredByState). */
  rootFamilies: Set<string>;
};

/**
 * The costliest single root of one query evaluation.
 *
 * A query's roots are the union of every watch's roots on a branch, so a
 * slow `watch.add` reports its duration against a watch COUNT and says
 * nothing about which declaration spent it. This names the root that did.
 *
 * It names the root that PAID, which is not always the root to blame.
 * Roots share coverage within an evaluation: the first to reach a document
 * is charged for it, and a later root that would have reached the same
 * document is skipped instead. So where several roots declare overlapping
 * closures, the whole cost lands on whichever ran first, and bounding that
 * one root moves the charge to the next rather than removing it. Read a
 * large `slowestRoot` as "the cost is reachable from here", and confirm a
 * suspected cause by checking that narrowing it lowers the request's own
 * elapsed time — not merely that it lowers this root's.
 */
export type SlowestQueryRoot = {
  id: string;
  scope: CellScope;

  /** The explicit scope INSTANCE the root named, on the lease-holder reads
   * that may name one. Roots alike in every other field but this one are
   * different reads of different instances, so without it the record
   * cannot say which instance cost the time. */
  entityScopeKey?: ScopeKey;

  /** The selector's path, slash-joined; empty for a whole-document root. */
  path: string;

  /** The selector schema's interned tagged hash, absent when the root
   * declares none. The hash rather than the schema itself: a board root's
   * schema runs to kilobytes, and the hash is how the registry names it. */
  schema?: string;

  elapsedMs: number;

  /** Engine documents read while visiting this root. */
  reads: number;

  /** The walk this root ran, as counters: how many documents it crossed
   * (`dagTraversals`), what kind of structure it crossed them through, and
   * how much the schema memo saved. `elapsedMs` says a root was expensive;
   * this says what it did to get that way — a wide root crossing thousands
   * of documents and one deep root re-walking a schema are the same
   * duration and different bugs. */
  walk: GraphQueryWalkStats;
};

/** One root's share of the walk counters its evaluation accumulated. */
const walkStatsDelta = (
  after: GraphQueryWalkStats,
  before: GraphQueryWalkStats,
): GraphQueryWalkStats => ({
  coveredSelectorSkips: after.coveredSelectorSkips -
    before.coveredSelectorSkips,
  schemaTraversals: after.schemaTraversals - before.schemaTraversals,
  pointerTraversals: after.pointerTraversals - before.pointerTraversals,
  arrayTraversals: after.arrayTraversals - before.arrayTraversals,
  objectTraversals: after.objectTraversals - before.objectTraversals,
  dagTraversals: after.dagTraversals - before.dagTraversals,
  getDocAtPathCalls: after.getDocAtPathCalls - before.getDocAtPathCalls,
  schemaMemoHits: after.schemaMemoHits - before.schemaMemoHits,
});

/**
 * What one query cost: the walk's own counters, plus how many documents the
 * query read out of the engine, plus which of its roots was the expensive
 * one.
 */
export type QueryTraversalStats = GraphQueryWalkStats & {
  managerReads: number;

  /** Roots this evaluation visited. A cache hit visits none. */
  rootsVisited: number;

  /** Summed elapsed time of those visits. Roots are visited in sequence,
   * so this is directly comparable with the caller's own elapsed
   * measurement, and what it leaves over is everything outside the root
   * loop — entity assembly and schema-closure staging. Read the two
   * together: they say whether a slow evaluation was slow at a root at
   * all. */
  rootsElapsedMs: number;

  /** The costliest one, absent when no root was visited. */
  slowestRoot?: SlowestQueryRoot;
};

const createQueryTraversalStats = (): QueryTraversalStats => ({
  managerReads: 0,
  rootsVisited: 0,
  rootsElapsedMs: 0,
  ...createGraphQueryWalkStats(),
});

/**
 * Run one root's evaluation, charging what it cost to `stats` and keeping
 * the costliest root seen so far.
 *
 * Two clock reads and one counter read per root, paid unconditionally,
 * because which evaluation turns out to be the slow one is not knowable
 * before it runs. The overhead is bounded by the same factor that makes a
 * query large: a root cheap enough for two `performance.now()` calls to
 * register against it did no document reads.
 */
const chargeRootVisit = (
  root: GraphQueryRoot,
  manager: EngineObjectManager,
  stats: QueryTraversalStats,
  visit: () => void,
): void => {
  const startedAt = performance.now();
  const readsBefore = manager.readCount;
  const walkBefore = { ...stats };
  try {
    visit();
  } finally {
    // Charged from `finally`, so a root that throws is attributed too: a
    // slow failing root is at least as interesting as a slow passing one.
    const elapsedMs = performance.now() - startedAt;
    stats.rootsVisited++;
    stats.rootsElapsedMs += elapsedMs;
    if (
      stats.slowestRoot === undefined ||
      elapsedMs > stats.slowestRoot.elapsedMs
    ) {
      stats.slowestRoot = {
        id: root.id,
        scope: root.scope ?? DEFAULT_SCOPE,
        ...(root.entityScopeKey === undefined
          ? {}
          : { entityScopeKey: root.entityScopeKey }),
        path: root.selector.path.join("/"),
        ...(root.selector.schema === undefined ? {} : {
          schema: internSchemaAsTaggedHashString(root.selector.schema),
        }),
        elapsedMs,
        reads: manager.readCount - readsBefore,
        walk: walkStatsDelta(stats, walkBefore),
      };
    }
  }
};

/**
 * The identity a manager's tracked-graph keys resolve against: the
 * querying session's own (the same identity the manager threads into every
 * scoped engine read).
 */
const identityOf = (manager: EngineObjectManager): ScopeKeyIdentity => ({
  principal: manager.principal,
  sessionId: manager.sessionId,
});

export class EngineObjectManager implements ObjectStorageManager {
  #attestations = new Map<string, IAttestation>();
  #details = new Map<string, {
    seq: number;
    document: NonNullable<Engine.EntityState["document"]>;
  }>();
  #missing = new Set<string>();
  #readCount = 0;

  readonly #engine: Engine.Engine;
  readonly #branch: string;
  readonly #readSeq?: number;

  constructor(
    engine: Engine.Engine,
    branch: string,
    readonly principal?: string,
    readonly sessionId?: string,
    readSeq?: number,
  ) {
    this.#engine = engine;
    this.#branch = branch;
    this.#readSeq = readSeq;
  }

  /** The scope INSTANCE an address resolves to for this manager: the
   * explicit key where the caller named one (protocol.md §2's read row),
   * else the manager's own bound identity. Cache keys use it, so an
   * explicit foreign instance never collides with the manager's own
   * (partition-equal to the scope-name form at cardinality 1 —
   * key-vocabulary.md §2). */
  #scopeKeyFor(scope: CellScope, explicit?: ScopeKey): ScopeKey {
    return explicit ??
      resolveScopeKey(scope, {
        principal: this.principal,
        sessionId: this.sessionId,
      });
  }

  readState(
    id: string,
    scope: CellScope = DEFAULT_SCOPE,
    scopeKey?: ScopeKey,
  ): Engine.EntityState | null {
    return Engine.readState(this.#engine, {
      id,
      scope,
      ...(scopeKey === undefined ? {} : { scopeKey }),
      principal: this.principal,
      sessionId: this.sessionId,
      branch: this.#branch,
      ...(this.#readSeq === undefined ? {} : { seq: this.#readSeq }),
    });
  }

  /** The class of the commit at `seq` (the covering commit of a snapshot
   * whose seq that is — one seq names exactly one commit), or undefined
   * for seq 0 / an unknown seq. Memoized per engine; see
   * {@link Engine.commitClassOfSeq}. */
  coverClassOf(seq: number): CommitClass | undefined {
    return Engine.commitClassOfSeq(this.#engine, seq);
  }

  load(
    address: {
      id: string;
      type?: string;
      scope?: CellScope;
      scopeKey?: ScopeKey;
    },
  ): IAttestation | null {
    const type = address.type ?? "application/json";
    const scope = address.scope ?? DEFAULT_SCOPE;
    const scopeKey = this.#scopeKeyFor(scope, address.scopeKey);
    const key = `${scopeKey}/${address.id}/${type}`;
    if (this.#attestations.has(key)) {
      return this.#attestations.get(key)!;
    }
    if (this.#missing.has(key)) {
      return null;
    }
    if (type !== "application/json") {
      this.#missing.add(key);
      return null;
    }

    const state = this.readState(address.id, scope, scopeKey);
    this.#readCount++;
    if (state === null || state.document === null) {
      this.#missing.add(key);
      return null;
    }

    const attestation: IAttestation = {
      address: {
        id: address.id as URI,
        scope,
        type: type as MIME,
        path: [],
      },
      value: state.document,
    };
    this.#attestations.set(key, attestation);
    this.#details.set(key, {
      seq: state.seq,
      document: state.document,
    });
    return attestation;
  }

  detail(
    address: {
      id: string;
      type?: string;
      scope?: CellScope;
      scopeKey?: ScopeKey;
    },
  ) {
    const scope = address.scope ?? DEFAULT_SCOPE;
    return this.#details.get(
      `${this.#scopeKeyFor(scope, address.scopeKey)}/${address.id}/${
        address.type ?? "application/json"
      }`,
    );
  }

  get readCount(): number {
    return this.#readCount;
  }

  loadedAddresses(): Array<
    { id: string; type: string; scope: CellScope; scopeKey: ScopeKey }
  > {
    // The cache key is `scopeKey/id/type`, and only the scopeKey prefix
    // is delimiter-safe (canonical scope keys percent-encode `/`; ids
    // and MIME types carry raw slashes routinely). Take id and type from
    // the attestation's own address and parse ONLY the prefix — a
    // key.split("/") here corrupted slash-bearing ids, so extension
    // bookkeeping missed the actual tracked document.
    return [...this.#attestations.entries()].map(([key, attestation]) => {
      const separator = key.indexOf("/");
      const scopeKey = key.slice(0, separator) as ScopeKey;
      return {
        id: attestation.address.id,
        type: attestation.address.type ?? "application/json",
        scope: attestation.address.scope ?? scopeOfScopeKey(scopeKey),
        scopeKey,
      };
    });
  }

  invalidateIds(ids: Iterable<string>, scope: CellScope = DEFAULT_SCOPE): void {
    // Own-instance invalidation: the manager caches under its own bound
    // identity's keys (plus explicitly named instances, which dirty
    // marking addresses by exact key through the same construction).
    const scopeKey = this.#scopeKeyFor(scope);
    for (const id of ids) {
      const key = `${scopeKey}/${id}/application/json`;
      this.#attestations.delete(key);
      this.#details.delete(key);
      this.#missing.delete(key);
    }
  }

  mergeFrom(other: EngineObjectManager): void {
    for (const key of other.#missing) {
      this.#attestations.delete(key);
      this.#details.delete(key);
      this.#missing.add(key);
    }
    for (const [key, value] of other.#attestations) {
      this.#attestations.set(key, value);
      const detail = other.#details.get(key);
      if (detail !== undefined) {
        this.#details.set(key, detail);
      }
      this.#missing.delete(key);
    }
  }
}

export type QueryGraphReuseContext = {
  managers?: Map<string, EngineObjectManager>;
};

/** Source of fresh ids for {@link canonicalSelectorId}. */
let nextCanonicalSelectorId = 0;

/** Ids already issued, keyed by canonical (interned) selector instance. */
const canonicalSelectorIds = new WeakMap<SchemaPathSelector, number>();

/**
 * Returns the canonical selector identity for evaluation-cache keys.
 * Interning gives structurally equal selectors one canonical instance
 * (`internPathSelector`), so reference identity is structural equality and
 * the id is exact. Canonical instances are weakly held, so an id can lapse
 * with its selector and a re-interned equal reappears under a fresh id —
 * that costs a cache miss, never a wrong hit.
 */
const canonicalSelectorId = (selector: SchemaPathSelector): number => {
  const interned = internPathSelector(selector);
  let id = canonicalSelectorIds.get(interned);
  if (id === undefined) {
    id = nextCanonicalSelectorId++;
    canonicalSelectorIds.set(interned, id);
  }
  return id;
};

const evaluationQueryKey = (query: GraphQuery): string =>
  JSON.stringify([
    query.branch ?? "",
    query.roots
      .map((root) => [
        root.id,
        root.scope ?? DEFAULT_SCOPE,
        root.entityScopeKey ?? "",
        canonicalSelectorId(toDocumentSelector(root.selector)),
      ])
      .map((parts) => JSON.stringify(parts))
      .toSorted(),
  ]);

const evaluationIdentityKey = (options: TrackGraphOptions): string =>
  JSON.stringify([options.principal ?? null, options.sessionId ?? null]);

/**
 * Bounds an evaluation cache's entry COUNT — the cardinality backstop for
 * adversarial query-shape churn, not the memory bound. Memory is bounded
 * by the server's cross-space retained-entity budget, which evicts by
 * weight (see Server's evaluation-cache budget).
 *
 * The bound holds by eviction: at the cap a new shape displaces the oldest
 * entry (Map insertion order — the order the weight budget evicts in too)
 * rather than going unrecorded, so a full cache keeps recording instead of
 * freezing at whatever filled it first. Insertion-order eviction serves a
 * repeated cycle of shapes only while the whole cycle fits under the cap.
 */
export const EVALUATION_CACHE_MAX_ENTRIES = 16;

export type QueryEvaluationCacheDiagnostics = {
  seq: number;
  entries: number;
  weight: number;

  /** Total serves: the sum of the three per-class hit counters. */
  hits: number;

  misses: number;
  rotations: number;

  /** Entries displaced at the entry cap by a newer shape. */
  capEvictions: number;

  /** Entries removed by the server's cross-space weight budget. */
  budgetEvictions: number;

  /** Serves of a scope-pure entry (identical for every identity). */
  hitsPure: number;

  /** Serves of an absent-residue entry — the recording identity's own
   * re-ask included (its keys need no rewrite, but the entry is the
   * same class). */
  hitsAbsentResidue: number;

  /** Serves of a tainted entry to the identity it is keyed to. */
  hitsIdentity: number;

  /** Absent-residue shares refused because a residue doc is PRESENT
   * for the requester. A refusal is not a miss by itself: the call
   * then serves from the identity entry (an identity hit) or
   * evaluates in full (a miss). */
  residueRefusals: number;

  /** Live scope-pure entries. This count and the two below it are the live
   * entries by share class; together with the hit split they are the
   * production measure of how often scoped reach actually forecloses
   * cross-identity sharing. */
  entriesPure: number;

  /** Live absent-residue entries. */
  entriesAbsentResidue: number;

  /** Live tainted entries, each keyed to one identity. */
  entriesTainted: number;
};

/**
 * Caches whole tracked-graph evaluations per (query shape, engine seq).
 *
 * The WHOLE evaluation is the smallest soundly shareable unit: within one
 * walk, an already-covered (doc, selector) skips its subtree — including
 * the tracker registrations that subtree would record — so any per-document
 * slice of a walk's effects depends on what its siblings covered first, and
 * replaying one standalone under-registers coverage. A complete evaluation
 * carries no such context.
 *
 * Entries are valid only at the engine seq they were evaluated at; a seq
 * advance rotates the whole cache. Staleness is therefore structural — no
 * write hooks, no dependency tracking — and the sharing this buys is
 * exactly where the cost multiplies: many sessions establishing the same
 * watch corpus between two commits (a reconnect stampede after a process
 * death is this, at its worst).
 *
 * Fresh evaluations alone consult it: a session's first watch group per
 * branch, a whole-set establishment (session resume), and `graph.query`.
 * A later `watch.add` in the same session EXTENDS that session's tracked
 * graph (`extendTrackedGraph`), and an extension's walk depends on what the
 * session already covers, so it is neither served nor recorded. A page
 * load that grows its watch set batch by batch therefore records one
 * entry — its first batch — and re-walks the rest on every load; what the
 * cache covers is many sessions establishing one corpus, not one session's
 * incremental establishment.
 *
 * Scope purity decides who may share an entry. An evaluation whose whole
 * reach — tracked, missed, and loaded — resolved under the `space` scope is
 * identical for every identity and is shared across them; one that touched
 * a session- or user-scoped instance is keyed to the evaluating identity
 * (key-vocabulary.md §5's identity-bound invariant — the same value-bleed
 * rule `assertSchemaMemoIdentity` enforces for the inner schema memos).
 * ACL changes are themselves commits, so a grant or revocation rotates the
 * cache before any post-change evaluation could be served from it.
 *
 * Cross-identity sharing rests on evaluation being recipient-blind: the
 * walk consults the requesting identity only to resolve scope instances,
 * never to shape what a document contributes, so scope classification
 * alone decides who an entry may serve. CFC enforcement lives outside
 * this path (the runtime's flow-label and sink-ceiling dials; the
 * server's sqlite read labeling annotates results rather than filtering
 * them). A per-recipient filter inside evaluation would invalidate
 * shared entries invisibly — clearance differs between identities at
 * one seq, so rotation cannot fence it and scope keys cannot classify
 * it — and must therefore key this cache by its filtering context or
 * bypass it (key-vocabulary.md §5, the identity-bound inventory).
 */
export type QueryEvaluationCache = {
  /** The engine the entries were evaluated against. A sequence number
   * identifies state only within its engine, so a different engine object
   * for the same space rotates the cache exactly as a seq advance does —
   * both entry points accept a caller-supplied engine. */
  engine: Engine.Engine | null;

  seq: number;
  entries: Map<
    string,
    { state: TrackedGraphState; share: StateScopeClass; weight: number }
  >;

  /** Sum of entry weights (retained entity count — the proxy for the
   * parsed documents an entry keeps alive). The server enforces its
   * cross-space budget against this. */
  weight: number;

  /** Serves of a scope-pure entry. This counter and the two below it are the
   * per-class serve counters, which diagnostics report summed as `hits`;
   * {@link QueryEvaluationCacheDiagnostics} defines each class. */
  hitsPure: number;

  /** Serves of an absent-residue entry. */
  hitsAbsentResidue: number;

  /** Serves of a tainted entry to the identity it is keyed to. */
  hitsIdentity: number;

  /** Absent-residue shares refused because a residue doc is present. */
  residueRefusals: number;

  /** Evaluations that found no usable entry. */
  misses: number;

  /** Times the cache was rotated out — a newer engine seq, or a different
   * engine object for the same space. */
  rotations: number;

  /** Entries displaced at EVALUATION_CACHE_MAX_ENTRIES by a newer shape. */
  capEvictions: number;

  /** Entries the server's weight budget removed (its enforcement pass
   * counts here; the cache itself never evicts by weight). */
  budgetEvictions: number;
};

export const createQueryEvaluationCache = (): QueryEvaluationCache => ({
  engine: null,
  seq: -1,
  entries: new Map(),
  weight: 0,
  hitsPure: 0,
  hitsAbsentResidue: 0,
  hitsIdentity: 0,
  residueRefusals: 0,
  misses: 0,
  rotations: 0,
  capEvictions: 0,
  budgetEvictions: 0,
});

export const queryEvaluationCacheDiagnostics = (
  cache: QueryEvaluationCache,
): QueryEvaluationCacheDiagnostics => {
  const entriesByClass = { "pure": 0, "absent-residue": 0, "tainted": 0 };
  for (const { share } of cache.entries.values()) {
    entriesByClass[share.kind]++;
  }
  return {
    seq: cache.seq,
    entries: cache.entries.size,
    weight: cache.weight,
    hits: cache.hitsPure + cache.hitsAbsentResidue + cache.hitsIdentity,
    misses: cache.misses,
    rotations: cache.rotations,
    capEvictions: cache.capEvictions,
    budgetEvictions: cache.budgetEvictions,
    hitsPure: cache.hitsPure,
    hitsAbsentResidue: cache.hitsAbsentResidue,
    hitsIdentity: cache.hitsIdentity,
    residueRefusals: cache.residueRefusals,
    entriesPure: entriesByClass["pure"],
    entriesAbsentResidue: entriesByClass["absent-residue"],
    entriesTainted: entriesByClass["tainted"],
  };
};

/**
 * How an evaluation's reach constrains who may share its cache entry.
 *
 * `pure`: every key resolved under the space scope — the result is
 * identical for every identity. `absent-residue`: identity-dependent ONLY
 * through scoped value-link dead-ends (`missed` keys — docs that were
 * ABSENT), which is the shape a live corpus actually produces: per-session
 * draft cells linked from shared documents that no fresh session has ever
 * written. Such an entry serves another identity by REWRITING those keys
 * to the requester's own instances — sound because the keys are the only
 * identity-dependent part of the state (nothing was delivered from them,
 * nothing was traversed under them) — after verifying each is absent for
 * the requester too. `tainted`: scoped PRESENT data reached the tracker,
 * or a key did not classify; the entry stays keyed to its identity.
 */
type StateScopeClass =
  | { kind: "pure" }
  | {
    kind: "absent-residue";
    residue: { key: QueryDocKey; id: string; scope: CellScope }[];
  }
  | { kind: "tainted" };

/** Exported for testing (the malformed-key guard is unreachable through
 * a real walk while the scope-key vocabulary holds). */
export const classifyStateScope = (
  state: TrackedGraphState,
): StateScopeClass => {
  for (const [key] of state.tracker) {
    if (fromDocKey(key as QueryDocKey).scopeKey !== "space") {
      return { kind: "tainted" };
    }
  }
  for (const address of state.manager.loadedAddresses()) {
    // Both halves checked deliberately: an explicit entity_scope_key can
    // pair a non-space scope NAME with an aliased key, and such a load
    // must never classify as shared. (Explicit foreign keys are
    // lease-holder-only, and that whole session class bypasses the cache
    // — this guards the invariant locally as well.)
    if (address.scopeKey !== "space" || address.scope !== "space") {
      return { kind: "tainted" };
    }
  }
  for (const key of state.lazy) {
    // A scoped lazy registration binds this state to one identity's
    // instance exactly as a scoped tracker entry would — its promotion
    // would read and deliver that instance.
    if (fromDocKey(key as QueryDocKey).scopeKey !== "space") {
      return { kind: "tainted" };
    }
  }
  const residue: { key: QueryDocKey; id: string; scope: CellScope }[] = [];
  for (const [key] of state.missed) {
    // The scope-key vocabulary is closed (isScopeKey), so a key that is
    // not the space instance necessarily recovers a session or user
    // scope; fromDocKey throws on anything outside the vocabulary.
    const { id, scope, scopeKey } = fromDocKey(key as QueryDocKey);
    if (scopeKey === "space") continue;
    residue.push({ key: key as QueryDocKey, id, scope });
  }
  return residue.length === 0
    ? { kind: "pure" }
    : { kind: "absent-residue", residue };
};

/**
 * Serve an `absent-residue` entry to `options`' identity: verify each
 * residue doc is ABSENT for the requester too, then clone with the
 * residue's miss keys rewritten to the requester's instances — so the
 * clone's wake and dirty-refresh reactivity points at the docs the OWNING
 * session would create, not the recording session's.
 *
 * The absence probes are load-bearing and cannot be skipped for a
 * different identity: the requester's instance may have existed since
 * before the entry was recorded (the recording walk never looked at it).
 * They are also sufficient — entries live only within one engine seq, and
 * absence cannot change without a commit. A present instance returns
 * null: the caller evaluates normally, and that evaluation's tracker then
 * carries the scoped doc, keying its own entry to the identity.
 */
const cloneWithRewrittenResidue = (
  engine: Engine.Engine,
  space: string,
  state: TrackedGraphState,
  residue: { key: QueryDocKey; id: string; scope: CellScope }[],
  options: TrackGraphOptions,
): { state: TrackedGraphState | null; probeReads: number } => {
  const identity: ScopeKeyIdentity = {
    principal: options.principal,
    sessionId: options.sessionId,
  };
  const mapping = new Map<string, string>();
  let probeReads = 0;
  for (const { key, id, scope } of residue) {
    const requesterScopeKey = resolveScopeKey(scope, identity);
    const requesterKey = `${space}/${requesterScopeKey}/${id}`;
    if (requesterKey !== key) {
      probeReads++;
      const probe = Engine.readState(engine, {
        id,
        scope,
        scopeKey: requesterScopeKey,
        principal: options.principal,
        sessionId: options.sessionId,
        branch: state.branch,
      });
      if (probe !== null && probe.document !== null) {
        // Refused — but the probes already performed are reads this call
        // made, and the caller's statistics must carry them.
        return { state: null, probeReads };
      }
      mapping.set(key, requesterKey);
    }
  }
  const clone = cloneTrackedGraphStateForIdentity(engine, state, options);
  if (mapping.size === 0) {
    return { state: clone, probeReads };
  }
  const missed = new MapSetStringToPathSelectors(true);
  for (const [key, selectors] of clone.missed) {
    const mapped = mapping.get(key) ?? key;
    for (const selector of selectors) {
      missed.add(mapped, selector);
    }
  }
  const missedBy = new Map<string, Set<string>>();
  for (const [key, referrers] of clone.missedBy) {
    missedBy.set(mapping.get(key) ?? key, referrers);
  }
  const missesOf = new Map<string, Set<string>>();
  for (const [referrer, misses] of clone.missesOf) {
    missesOf.set(
      referrer,
      new Set([...misses].map((miss) => mapping.get(miss) ?? miss)),
    );
  }
  return { state: { ...clone, missed, missedBy, missesOf }, probeReads };
};

/**
 * Clone for a cache hit: `cloneTrackedGraphState` rebound to the
 * requesting identity. Only scope-pure entries are ever cloned across
 * identities, so every key, entity, memo entry, and manager cache line in
 * the source resolved identically to what this identity's own evaluation
 * would have produced; the rebind exists so the clone's LATER operations —
 * refreshes, extensions — resolve scoped reach against the session that
 * owns it. The cloned memo is a fresh Map, so the identity binding the
 * schema-memo tripwire tracks starts unbound and binds to the new owner.
 */
const cloneTrackedGraphStateForIdentity = (
  engine: Engine.Engine,
  state: TrackedGraphState,
  options: TrackGraphOptions,
): TrackedGraphState => {
  const clone = cloneTrackedGraphState(engine, state);
  if (
    clone.manager.principal === options.principal &&
    clone.manager.sessionId === options.sessionId
  ) {
    return clone;
  }
  const manager = new EngineObjectManager(
    engine,
    state.branch,
    options.principal,
    options.sessionId,
  );
  manager.mergeFrom(state.manager);
  return { ...clone, manager };
};

export type TrackGraphOptions = {
  readSeq?: number;
  principal?: string;
  sessionId?: string;

  /** Serve/record whole evaluations through this cache (current-seq reads
   * only; a `readSeq` read bypasses it). See {@link QueryEvaluationCache}
   * for the sharing and rotation rules. */
  evaluationCache?: QueryEvaluationCache;

  /**
   * `queryGraph` only (server-execution v2 stage A, OW17's wire leg):
   * annotate every returned snapshot with its scope INSTANCE
   * (`EntitySnapshot.scopeKey`). Set for a session whose lease-holder
   * read exemption is live — the one session class whose result may
   * legitimately hold two instances of one (branch, id, scope) — and
   * never otherwise, so the OFF-arm result shape is unchanged.
   */
  keyedSnapshots?: boolean;
};

export const cloneTrackedGraphState = (
  engine: Engine.Engine,
  state: TrackedGraphState,
): TrackedGraphState => {
  const tracker = state.tracker.clone();
  const missed = state.missed.clone();
  const missedBy = new Map(
    [...state.missedBy].map(([key, refs]) => [key, new Set(refs)] as const),
  );
  const missesOf = new Map(
    [...state.missesOf].map(([key, misses]) => [key, new Set(misses)] as const),
  );

  const manager = new EngineObjectManager(
    engine,
    state.branch,
    state.manager.principal,
    state.manager.sessionId,
  );
  manager.mergeFrom(state.manager);

  return {
    branch: state.branch,
    tracker,
    missed,
    missedBy,
    missesOf,
    entities: new Map(state.entities),
    memo: new Map(state.memo),
    manager,
    roots: new Set(state.roots),
    lazy: new Set(state.lazy),
    lazyBy: new Map(
      [...state.lazyBy].map(([key, refs]) => [key, new Set(refs)] as const),
    ),
    lazyOf: new Map(
      [...state.lazyOf].map(([key, registered]) =>
        [key, new Set(registered)] as const
      ),
    ),
    rootFamilies: new Set(state.rootFamilies),
  };
};

const snapshotForDocKey = (
  space: string,
  manager: EngineObjectManager,
  branch: string,
  key: QueryDocKey,
): EntitySnapshot | null => {
  if (!key.startsWith(`${space}/`)) {
    return null;
  }
  const { id, scope, scopeKey } = fromDocKey(key);
  const type = "application/json";
  const detail = manager.detail({ id, type, scope, scopeKey });
  const state = detail === undefined
    ? manager.readState(id, scope, scopeKey)
    : null;
  const seq = detail?.seq ?? state?.seq ?? 0;
  // The covering commit's class (speculation.md §4's arrival-witness
  // predicate, RULED 2026-08-22), ON arm only: the OFF-arm snapshot —
  // and therefore every OFF-arm frame — stays byte-identical.
  const coverClass = getServerExecutionConfig()
    ? manager.coverClassOf(seq)
    : undefined;
  return {
    branch,
    id,
    ...(scope !== DEFAULT_SCOPE ? { scope } : {}),
    seq,
    document: detail?.document === undefined
      ? state?.document === null || state?.document === undefined
        ? null
        : state.document
      : detail.document,
    ...(coverClass === undefined ? {} : { coverClass }),
  } satisfies EntitySnapshot;
};

/** The tracked doc key for a query root: the explicit instance where the
 * root names one (protocol.md §2's read row), else the session identity's
 * own — one construction for track/extend/coverage so the three never
 * disagree on which instance a root means. */
const rootDocKey = (
  space: string,
  root: GraphQuery["roots"][number],
  identity: ScopeKeyIdentity,
): QueryDocKey =>
  root.entityScopeKey !== undefined
    ? `${space}/${root.entityScopeKey}/${root.id}`
    : toDocKey(space, root.id, root.scope ?? DEFAULT_SCOPE, identity);

const entitiesFromTracker = (
  space: string,
  tracker: MapSetStringToPathSelectors,
  manager: EngineObjectManager,
  branch: string,
): Map<QueryDocKey, EntitySnapshot> => {
  const entities = new Map<QueryDocKey, EntitySnapshot>();
  for (const [key] of tracker) {
    const snapshot = snapshotForDocKey(
      space,
      manager,
      branch,
      key as QueryDocKey,
    );
    if (snapshot !== null) {
      entities.set(key as QueryDocKey, snapshot);
    }
  }
  return entities;
};

// Per-version cache of document scans for embedded schema refs, so a
// version delivered again — by another session, query, or refresh — is
// not rescanned. Only canonical `"space"`-scoped snapshots are cached: a
// user- or session-scoped doc key names different content per principal,
// and sharing scans across principals could hand one principal's refs to
// another. Bounded; on overflow the cache clears and repopulates from
// live deliveries.
const SCHEMA_REF_SCAN_CACHE_MAX_ENTRIES = 4096;
const schemaRefScanCaches = new WeakMap<
  Engine.Engine,
  Map<QueryDocKey, { seq: number; refs: ReadonlySet<string> }>
>();

// Per-version record of schema documents that verified in this engine's
// store (`docKey -> seq`), so revalidating an established delivery state
// costs one map lookup per unchanged document. A version change drops the
// entry's usefulness by construction (the seq comparison fails).
const verifiedSchemaDocCaches = new WeakMap<
  Engine.Engine,
  Map<QueryDocKey, number>
>();

const EMPTY_SCHEMA_REFS: ReadonlySet<string> = new Set();

/**
 * The external schema-ref hashes a delivered document carries. For a
 * delivered schema document — decided by content-addressed identity,
 * since `cid:` also holds blobs: a document is a schema document exactly
 * when its id is the schema interning of its value — the document's own
 * hash is the single ref, and the closure walk verifies it and follows
 * its refs; its value is not link-scanned, because schema keywords such
 * as `default` may carry link-shaped DATA that is not a link position.
 * Every other document is scanned for link schemas anywhere in its value.
 */
const scanSnapshotSchemaRefs = (
  engine: Engine.Engine,
  key: QueryDocKey,
  snapshot: EntitySnapshot,
): ReadonlySet<string> => {
  const cacheable = (snapshot.scope ?? DEFAULT_SCOPE) === DEFAULT_SCOPE;
  let cache = schemaRefScanCaches.get(engine);
  if (cache === undefined) {
    cache = new Map();
    schemaRefScanCaches.set(engine, cache);
  }
  if (cacheable) {
    const cached = cache.get(key);
    if (cached !== undefined && cached.seq === snapshot.seq) {
      return cached.refs;
    }
  }
  const refs = new Set<string>();
  const doc = snapshot.document;
  if (isObjectNotArray(doc)) {
    const { id } = fromDocKey(key);
    let isSchemaDocument = false;
    if (id.startsWith("cid:")) {
      const hash = id.slice("cid:".length);
      const inner = (doc as { value?: unknown }).value;
      if (
        isSubschema(inner) &&
        internSchemaAsTaggedHashString(inner as JSONSchema) === hash
      ) {
        isSchemaDocument = true;
        refs.add(hash);
      }
    }
    if (!isSchemaDocument) {
      // Link positions only: an `$alias`-shaped record in a document is
      // plain data to this layer, so its `schema` member is never a
      // delivery obligation — data that merely looks like a binding must
      // not fail a query over an unresolvable ref inside it.
      mapLinkSchemas(doc as FabricValue, (schema) => {
        for (
          const hash of collectExternalSchemaRefHashes(schema as JSONSchema)
        ) {
          refs.add(hash);
        }
        return schema;
      });
    }
  }
  const result = refs.size === 0 ? EMPTY_SCHEMA_REFS : refs;
  if (cacheable) {
    if (cache.size >= SCHEMA_REF_SCAN_CACHE_MAX_ENTRIES) cache.clear();
    cache.set(key, { seq: snapshot.seq, refs: result });
  }
  return result;
};

/**
 * Thrown when a query result's schema-document closure cannot be
 * assembled from the delivering space's own store: a referenced document
 * is missing, or its stored content does not hash to its id. The commit
 * boundary preserves installed documents, so this is a violated writer
 * or storage invariant, never a transient condition. A request-shaped
 * evaluation answers its caller with the diagnostic (a QueryError); the
 * fan-out refresh logs it and skips the affected session's frame.
 */
export class SchemaClosureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaClosureError";
  }
}

/**
 * The read-side delivery guarantee, enforced at the result-assembly
 * boundary: every schema reference embedded in the documents being
 * delivered — a link schema anywhere in a document's value, or a delivered
 * schema document's own refs — must resolve to a verified schema document
 * in this space, and the whole closure joins the delivered set and the
 * watch set. A missing or forged closure document fails the query loudly
 * ({@link SchemaClosureError}): the write-side guarantee installs closures
 * with their referrers, so a hole is a consistency bug to surface, never
 * to repair around.
 *
 * Two-phase: the walk verifies everything into staging and returns the
 * tracker keys and snapshots to add — the caller commits them only after
 * the whole closure verified, so the walk itself mutates nothing. A
 * refresh whose traversal already advanced its tracker before a failure
 * is healed by the session's forced full re-evaluation instead (the
 * server marks it on the skipped frame). `established` extends
 * validation over previously
 * delivered snapshots (a refresh): a corrupted dependency fails the
 * refresh even when its referrer did not change, and the per-version scan
 * and verification caches make an unchanged established set cost map
 * lookups.
 *
 * Verification is against THIS space's stored content — a verified copy in
 * the realm registry never stands in for the space's own (the
 * space-boundary rule in `docs/specs/content-addressed-schemas.md`).
 */
const assembleSchemaDocClosures = (
  space: string,
  engine: Engine.Engine,
  manager: EngineObjectManager,
  branch: string,
  tracker: MapSetStringToPathSelectors,
  delivered: ReadonlyMap<QueryDocKey, EntitySnapshot>,
  established?: ReadonlyMap<QueryDocKey, EntitySnapshot>,
): {
  trackerAdds: QueryDocKey[];
  additions: Map<QueryDocKey, EntitySnapshot>;
} => {
  const pending: string[] = [];
  const seen = new Set<string>();
  const enqueue = (hash: string) => {
    if (!seen.has(hash)) {
      seen.add(hash);
      pending.push(hash);
    }
  };
  for (const [key, snapshot] of delivered) {
    for (const hash of scanSnapshotSchemaRefs(engine, key, snapshot)) {
      enqueue(hash);
    }
  }
  if (established !== undefined) {
    for (const [key, snapshot] of established) {
      if (delivered.has(key)) continue;
      for (const hash of scanSnapshotSchemaRefs(engine, key, snapshot)) {
        enqueue(hash);
      }
    }
  }
  let verified = verifiedSchemaDocCaches.get(engine);
  if (verified === undefined) {
    verified = new Map();
    verifiedSchemaDocCaches.set(engine, verified);
  }
  const trackerAdds: QueryDocKey[] = [];
  const additions = new Map<QueryDocKey, EntitySnapshot>();
  while (pending.length > 0) {
    const hash = pending.pop()!;
    const id = `cid:${hash}`;
    const key = toDocKey(space, id, DEFAULT_SCOPE, identityOf(manager));
    manager.load({ id, scope: DEFAULT_SCOPE, type: "application/json" });
    const snapshot = snapshotForDocKey(space, manager, branch, key);
    const doc = snapshot?.document;
    const inner = isObjectNotArray(doc)
      ? (doc as { value?: unknown }).value
      : undefined;
    if (snapshot === null || inner === undefined) {
      throw new SchemaClosureError(
        `Query result requires schema document ${id}, which is not stored ` +
          `in this space. Every embedded schema ref must resolve within ` +
          `the delivered set (docs/specs/content-addressed-schemas.md).`,
      );
    }
    // This exact version verified here before: skip re-hashing, but keep
    // the registry entry warm (a registry clear may have dropped it).
    let registered = verified.get(key) === snapshot.seq
      ? lookupSchemaDocument(hash)
      : undefined;
    if (registered === undefined) {
      try {
        registered = registerSchemaDocument(hash, inner as JSONSchema);
      } catch {
        throw new SchemaClosureError(
          `Schema document ${id} did not verify in this space: its stored ` +
            `content does not hash to its id.`,
        );
      }
      if (verified.size >= SCHEMA_REF_SCAN_CACHE_MAX_ENTRIES) verified.clear();
      verified.set(key, snapshot.seq);
    }
    for (const dep of collectExternalSchemaRefHashes(registered)) {
      enqueue(dep);
    }
    if (!tracker.has(key)) {
      trackerAdds.push(key);
      if (!delivered.has(key)) {
        additions.set(key, snapshot);
      }
    }
  }
  return { trackerAdds, additions };
};

/**
 * Validates the schema references a query's root selectors carry, loudly:
 * every referenced document, transitively through its closure, must be
 * stored in this space with content that verifies against its id. A
 * compliant client emits a selector reference only after verifying the
 * closure persisted here, so an unresolvable reference is a protocol
 * violation answered with the diagnostic — never the lenient
 * selects-nothing wait that link schemas inside delivered documents get.
 * Validation registers each document as it verifies, so the traversal
 * behind the selector resolves without re-reading. It reads through the
 * caller's manager, so a historical query (`atSeq`) bounds resolution the
 * same way it bounds every other read: the referenced document must exist
 * and verify at that sequence.
 */
const validateSelectorSchemaRefs = (
  space: string,
  manager: EngineObjectManager,
  branch: string,
  roots: GraphQuery["roots"],
): void => {
  const pending: string[] = [];
  for (const root of roots) {
    const schema = root.selector?.schema;
    if (schema === undefined || typeof schema === "boolean") continue;
    for (const hash of collectExternalSchemaRefHashes(schema as JSONSchema)) {
      pending.push(hash);
    }
  }
  if (pending.length === 0) return;
  const seen = new Set<string>();
  while (pending.length > 0) {
    const hash = pending.pop()!;
    if (seen.has(hash)) continue;
    seen.add(hash);
    const id = `cid:${hash}`;
    const key = toDocKey(space, id, DEFAULT_SCOPE, identityOf(manager));
    manager.load({ id, scope: DEFAULT_SCOPE, type: "application/json" });
    const snapshot = snapshotForDocKey(space, manager, branch, key);
    const doc = snapshot?.document;
    const inner = isObjectNotArray(doc)
      ? (doc as { value?: unknown }).value
      : undefined;
    if (snapshot === null || inner === undefined) {
      throw new SchemaClosureError(
        `Selector references schema document ${id}, which is not stored ` +
          `in this space. A selector reference must name a persisted ` +
          `closure (docs/specs/content-addressed-schemas.md).`,
      );
    }
    let interned: JSONSchema;
    try {
      interned = registerSchemaDocument(hash, inner as JSONSchema);
    } catch {
      throw new SchemaClosureError(
        `Selector references schema document ${id} that did not verify ` +
          `in this space: its stored content does not hash to its id.`,
      );
    }
    for (const dep of collectExternalSchemaRefHashes(interned)) {
      pending.push(dep);
    }
  }
};

/** The walk-side recorder over a graph state's miss structures: records
 * the miss's selector and its referrer attribution (see
 * GraphQueryWalkOptions.onMissedDoc for the contract). */
const missRecorderFor = (
  state: Pick<TrackedGraphState, "missed" | "missedBy" | "missesOf">,
): (
  missKey: string,
  selector: SchemaPathSelector,
  referrerKey: string | undefined,
) => void =>
(missKey, selector, referrerKey) => {
  state.missed.add(missKey, selector);
  if (referrerKey === undefined) return;
  let refs = state.missedBy.get(missKey);
  if (refs === undefined) {
    refs = new Set();
    state.missedBy.set(missKey, refs);
  }
  refs.add(referrerKey);
  let misses = state.missesOf.get(referrerKey);
  if (misses === undefined) {
    misses = new Set();
    state.missesOf.set(referrerKey, misses);
  }
  misses.add(missKey);
};

/** Retire one miss outright: the target arrived (or every referrer let
 * go) — drop its selectors and both attribution directions. */
const retireMiss = (
  state: Pick<TrackedGraphState, "missed" | "missedBy" | "missesOf">,
  missKey: string,
): void => {
  state.missed.delete(missKey);
  const refs = state.missedBy.get(missKey);
  if (refs !== undefined) {
    for (const referrerKey of refs) {
      const misses = state.missesOf.get(referrerKey);
      if (misses === undefined) continue;
      misses.delete(missKey);
      if (misses.size === 0) state.missesOf.delete(referrerKey);
    }
    state.missedBy.delete(missKey);
  }
};

/** Record one lazy registration with its referrer, both directions. */
const recordLazy = (
  state: Pick<TrackedGraphState, "lazy" | "lazyBy" | "lazyOf">,
  lazyKey: string,
  referrerKey: string,
): void => {
  state.lazy.add(lazyKey);
  let refs = state.lazyBy.get(lazyKey);
  if (refs === undefined) {
    refs = new Set();
    state.lazyBy.set(lazyKey, refs);
  }
  refs.add(referrerKey);
  let registered = state.lazyOf.get(referrerKey);
  if (registered === undefined) {
    registered = new Set();
    state.lazyOf.set(referrerKey, registered);
  }
  registered.add(lazyKey);
};

/** Drop one lazy key outright — promoted, or its last referrer let go. */
const retireLazyKey = (
  state: Pick<TrackedGraphState, "lazy" | "lazyBy" | "lazyOf">,
  lazyKey: string,
): void => {
  state.lazy.delete(lazyKey);
  const refs = state.lazyBy.get(lazyKey);
  if (refs !== undefined) {
    for (const referrerKey of refs) {
      const registered = state.lazyOf.get(referrerKey);
      if (registered === undefined) continue;
      registered.delete(lazyKey);
      if (registered.size === 0) state.lazyOf.delete(referrerKey);
    }
    state.lazyBy.delete(lazyKey);
  }
};

/** A referrer is about to be re-walked: its lazy registrations no longer
 * stand (the walk re-records the ones its manifest still carries). A
 * registration whose last referrer lets go retires with it. */
const releaseReferrerLazy = (
  state: Pick<TrackedGraphState, "lazy" | "lazyBy" | "lazyOf">,
  referrerKey: string,
): void => {
  const registered = state.lazyOf.get(referrerKey);
  if (registered === undefined) return;
  state.lazyOf.delete(referrerKey);
  for (const lazyKey of registered) {
    const refs = state.lazyBy.get(lazyKey);
    if (refs === undefined) continue;
    refs.delete(referrerKey);
    if (refs.size === 0) {
      state.lazyBy.delete(lazyKey);
      state.lazy.delete(lazyKey);
    }
  }
};

/** A referrer is about to be re-walked: its previous attributions no
 * longer stand (the walk re-records the ones that still dead-end). A
 * miss whose last attribution goes retires with it. */
const releaseReferrerMisses = (
  state: Pick<TrackedGraphState, "missed" | "missedBy" | "missesOf">,
  referrerKey: string,
): void => {
  const misses = state.missesOf.get(referrerKey);
  if (misses === undefined) return;
  state.missesOf.delete(referrerKey);
  for (const missKey of misses) {
    const refs = state.missedBy.get(missKey);
    if (refs === undefined) continue;
    refs.delete(referrerKey);
    if (refs.size === 0) {
      state.missedBy.delete(missKey);
      state.missed.delete(missKey);
    }
  }
};

export const trackGraph = (
  space: string,
  engine: Engine.Engine,
  query: GraphQuery,
  reuse?: QueryGraphReuseContext,
  options: TrackGraphOptions = {},
): {
  serverSeq: number;
  state: TrackedGraphState;
  stats: QueryTraversalStats;
} => {
  const branch = query.branch ?? "";
  // Historical reads bypass the cache (entries are current-seq only), and
  // so does the lease-holder exemption class: an exempt evaluation judges
  // the CURRENT live lease, which is host state that can move without a
  // commit — seq rotation cannot fence it, so those evaluations are never
  // cached or served.
  const cache = options.readSeq === undefined && options.keyedSnapshots !== true
    ? options.evaluationCache
    : undefined;
  let cacheKeys: { pure: string; identity: string } | undefined;
  let refusalProbeReads = 0;
  if (cache !== undefined) {
    const currentSeq = Engine.serverSeq(engine);
    if (cache.engine !== engine || cache.seq !== currentSeq) {
      cache.engine = engine;
      cache.seq = currentSeq;
      cache.entries.clear();
      cache.weight = 0;
      cache.rotations++;
    }
    const queryKey = evaluationQueryKey(query);
    cacheKeys = {
      pure: `P${queryKey}`,
      identity: `I${evaluationIdentityKey(options)}${queryKey}`,
    };
    const pureEntry = cache.entries.get(cacheKeys.pure);
    let served: TrackedGraphState | null = null;
    let probeReads = 0;
    if (pureEntry !== undefined) {
      if (pureEntry.share.kind === "absent-residue") {
        const rewritten = cloneWithRewrittenResidue(
          engine,
          space,
          pureEntry.state,
          pureEntry.share.residue,
          options,
        );
        served = rewritten.state;
        probeReads = rewritten.probeReads;
        if (served === null) {
          cache.residueRefusals++;
        } else {
          cache.hitsAbsentResidue++;
        }
      } else {
        served = cloneTrackedGraphStateForIdentity(
          engine,
          pureEntry.state,
          options,
        );
        cache.hitsPure++;
      }
    }
    if (served === null) {
      // Either no shared entry, or its residue is PRESENT for this
      // identity and the share was refused. The identity's own earlier
      // evaluation — tainted, keyed to exactly this (principal,
      // sessionId) — still answers; without this lookup a shared entry
      // would shadow it and the identity would re-evaluate every time.
      const identityEntry = cache.entries.get(cacheKeys.identity);
      if (identityEntry !== undefined) {
        served = cloneTrackedGraphStateForIdentity(
          engine,
          identityEntry.state,
          options,
        );
        cache.hitsIdentity++;
      }
    }
    if (served !== null) {
      // A hit ran no traversal, and its stats say so — but the residue
      // absence probes ARE engine reads, and they report as such.
      return {
        serverSeq: currentSeq,
        state: served,
        stats: { ...createQueryTraversalStats(), managerReads: probeReads },
      };
    }
    // A refused share's probes were still reads this call performed; the
    // full evaluation below reports them alongside its own.
    refusalProbeReads = probeReads;
    cache.misses++;
  }
  const managerKey = options.readSeq === undefined
    ? `${branch}\0${options.principal ?? ""}\0${options.sessionId ?? ""}`
    : `${branch}\0${options.readSeq}\0${options.principal ?? ""}\0${
      options.sessionId ?? ""
    }`;
  let manager = reuse?.managers?.get(managerKey);
  if (manager === undefined) {
    manager = new EngineObjectManager(
      engine,
      branch,
      options.principal,
      options.sessionId,
      options.readSeq,
    );
    reuse?.managers?.set(managerKey, manager);
  }
  const schemaTracker = new MapSetStringToPathSelectors(true);
  const missState = {
    missed: new MapSetStringToPathSelectors(true),
    missedBy: new Map<string, Set<string>>(),
    missesOf: new Map<string, Set<string>>(),
  };
  const sharedMemo = createSchemaMemo();
  const stats = createQueryTraversalStats();
  const roots = new Set<string>();
  const rootFamilies = new Set<string>();
  const lazyState = {
    lazy: new Set<string>(),
    lazyBy: new Map<string, Set<string>>(),
    lazyOf: new Map<string, Set<string>>(),
  };
  const readCountBefore = manager.readCount;
  const walk = new GraphQueryWalk({
    manager,
    space: space as MemorySpace,
    schemaTracker,
    onMissedDoc: missRecorderFor(missState),
    lazyInternalSink: (key, referrerKey) =>
      recordLazy(lazyState, key, referrerKey),
    identity: identityOf(manager),
    memo: sharedMemo,
    stats,
  });

  validateSelectorSchemaRefs(space, manager, branch, query.roots);

  for (const root of query.roots) {
    chargeRootVisit(root, manager, stats, () => {
      const selector = toDocumentSelector(root.selector);
      const rootScope = root.scope ?? DEFAULT_SCOPE;
      // A root naming an explicit instance (protocol.md §2's read row —
      // lease-holder only, admission enforced at the server layer) reads
      // and tracks THAT instance; traversal beyond the root resolves under
      // the session identity as today (per-run deep threading is the
      // Phase 2 fan-out work).
      const loaded = manager.load({
        id: root.id,
        scope: rootScope,
        ...(root.entityScopeKey === undefined
          ? {}
          : { scopeKey: root.entityScopeKey }),
        type: "application/json",
      });
      const rootKey = rootDocKey(space, root, identityOf(manager));
      roots.add(rootKey);
      if (loaded !== null) {
        walk.visit(loaded, selector, rootKey);
        // The visit chased the named document's full family; an absent
        // root is still a ROOT (recorded above) but records no family —
        // its later creation owes it one.
        rootFamilies.add(rootKey);
      } else {
        schemaTracker.add(rootKey, selector);
      }
    });
  }

  const entities = entitiesFromTracker(space, schemaTracker, manager, branch);
  const staged = assembleSchemaDocClosures(
    space,
    engine,
    manager,
    branch,
    schemaTracker,
    entities,
  );
  for (const key of staged.trackerAdds) {
    schemaTracker.add(key, REJECTING_SELECTOR);
  }
  for (const [key, snapshot] of staged.additions) {
    entities.set(key, snapshot);
  }

  stats.managerReads = manager.readCount - readCountBefore +
    refusalProbeReads;

  const state: TrackedGraphState = {
    branch,
    tracker: schemaTracker,
    ...missState,
    entities,
    memo: sharedMemo,
    manager,
    roots,
    ...lazyState,
    rootFamilies,
  };
  if (cache !== undefined && cacheKeys !== undefined) {
    // The cache keeps its own clone: the state returned below belongs to
    // the caller's session, whose refreshes and extensions mutate it.
    const share = classifyStateScope(state);
    const weight = state.entities.size;
    const key = share.kind === "tainted" ? cacheKeys.identity : cacheKeys.pure;
    const previous = cache.entries.get(key);
    if (
      previous === undefined &&
      cache.entries.size >= EVALUATION_CACHE_MAX_ENTRIES
    ) {
      // A new shape at the cap displaces the oldest entry; re-recording a
      // present key (a refused absent-residue share re-evaluated) replaces
      // in place and grows nothing.
      const oldestKey = cache.entries.keys().next().value!;
      const oldest = cache.entries.get(oldestKey)!;
      cache.entries.delete(oldestKey);
      cache.weight -= oldest.weight;
      cache.capEvictions++;
    }
    cache.entries.set(key, {
      state: cloneTrackedGraphState(engine, state),
      share,
      weight,
    });
    cache.weight += weight - (previous?.weight ?? 0);
  }
  return {
    serverSeq: Engine.serverSeq(engine),
    state,
    stats,
  };
};

export const extendTrackedGraph = (
  space: string,
  engine: Engine.Engine,
  state: TrackedGraphState,
  query: GraphQuery,
): {
  serverSeq: number;
  updates: Map<QueryDocKey, EntitySnapshot>;
  stats: QueryTraversalStats;
} => {
  const manager = state.manager;
  const stats = createQueryTraversalStats();
  const readCountBefore = manager.readCount;
  const previouslyLoaded = new Set(
    manager.loadedAddresses().map((address) =>
      `${address.scopeKey}\0${address.id}`
    ),
  );
  const touched = new Set<QueryDocKey>();

  validateSelectorSchemaRefs(space, manager, state.branch, query.roots);

  for (const root of query.roots) {
    chargeRootVisit(root, manager, stats, () => {
      const selector = toDocumentSelector(root.selector);
      const rootScope = root.scope ?? DEFAULT_SCOPE;
      const rootKey = rootDocKey(space, root, identityOf(manager));
      state.roots.add(rootKey);
      touched.add(rootKey);
      const visited = evaluateTrackedDocument(
        space,
        manager,
        {
          id: root.id,
          scope: rootScope,
          ...(root.entityScopeKey === undefined
            ? {}
            : { scopeKey: root.entityScopeKey }),
        },
        selector,
        state.tracker,
        missRecorderFor(state),
        state.memo,
        stats,
        undefined,
        (key, referrerKey) => recordLazy(state, key, referrerKey),
      );
      // The visit chased the named document's full family; an absent
      // root records nothing, so its later creation re-evaluates it.
      if (visited) state.rootFamilies.add(rootKey);
    });
  }

  for (const address of manager.loadedAddresses()) {
    const key = `${address.scopeKey}\0${address.id}`;
    if (previouslyLoaded.has(key)) {
      continue;
    }
    touched.add(`${space}/${address.scopeKey}/${address.id}`);
  }

  const updates = new Map<QueryDocKey, EntitySnapshot>();
  for (const key of touched) {
    if (!state.tracker.has(key)) {
      continue;
    }
    const snapshot = snapshotForDocKey(
      space,
      manager,
      state.branch,
      key,
    );
    if (snapshot === null) {
      continue;
    }
    updates.set(key, snapshot);
  }

  // Assembly validates before anything commits to `state.entities`; the
  // caller stages the whole graph state (`cloneTrackedGraphState`), which
  // covers the tracker mutations the traversal above already made.
  const staged = assembleSchemaDocClosures(
    space,
    engine,
    manager,
    state.branch,
    state.tracker,
    updates,
  );
  for (const key of staged.trackerAdds) {
    state.tracker.add(key, REJECTING_SELECTOR);
  }
  for (const [key, snapshot] of staged.additions) {
    updates.set(key, snapshot);
  }
  for (const [key, snapshot] of updates) {
    state.entities.set(key, snapshot);
  }

  stats.managerReads = manager.readCount - readCountBefore;

  return {
    serverSeq: Engine.serverSeq(engine),
    updates,
    stats,
  };
};

export const isGraphQueryCoveredByState = (
  space: string,
  state: TrackedGraphState,
  query: GraphQuery,
): boolean =>
  query.roots.every((root) => {
    const selector = toDocumentSelector(root.selector);
    const rootKey = rootDocKey(space, root, identityOf(state.manager));
    // Reach without family is not coverage for a NAMED root: a crossing
    // may have recorded the selector while chasing only the crossing
    // rails, and naming the document entitles the caller to its full
    // family (extendTrackedGraph's visit supplies it, cheaply, when the
    // selector itself is already covered).
    return schemaTrackerCoversSelector(state.tracker, rootKey, selector) &&
      state.rootFamilies.has(rootKey);
  });

export const queryGraph = (
  space: string,
  engine: Engine.Engine,
  query: GraphQuery,
  reuse?: QueryGraphReuseContext,
  options: TrackGraphOptions = {},
): {
  serverSeq: number;
  entities: EntitySnapshot[];

  /** What the evaluation cost. Carried out so the server can attribute a
   * slow `graph.query` to a root; it is not part of the wire result, and
   * the caller drops it before responding. */
  stats: QueryTraversalStats;
} => {
  const tracked = trackGraph(space, engine, query, reuse, {
    ...options,
    readSeq: query.atSeq,
  });
  const entities = options.keyedSnapshots === true
    ? [...tracked.state.entities.entries()].map(([key, snapshot]) => ({
      ...snapshot,
      scopeKey: fromDocKey(key as QueryDocKey).scopeKey,
    }))
    : [...tracked.state.entities.values()];
  return {
    serverSeq: tracked.serverSeq,
    stats: tracked.stats,
    entities: entities
      .toSorted((left, right) => left.id.localeCompare(right.id)),
  };
};

export const refreshTrackedGraph = (
  space: string,
  engine: Engine.Engine,
  state: TrackedGraphState,
  dirtyIds: ReadonlySet<string>,
): {
  serverSeq: number;
  updates: Map<QueryDocKey, EntitySnapshot>;
  stats: QueryTraversalStats;
} | null => {
  const affectedDocs = new Map<QueryDocKey, Set<SchemaPathSelector>>();
  // Dirty docs the query had MISSED, kept apart from the tracked ones:
  // their re-evaluation routes a still-absent outcome back into the miss
  // set (never the tracker, whose entries reach the wire).
  const affectedMisses = new Map<QueryDocKey, Set<SchemaPathSelector>>();
  const lazyHits = new Set<QueryDocKey>();
  const promotedLazy = new Set<QueryDocKey>();
  const invalidations = new Map<CellScope, Set<string>>();
  const identity = identityOf(state.manager);
  for (const dirtyId of dirtyIds) {
    // Dirtiness arrives keyed by scope INSTANCE (M4, stage F): the dirty
    // key's scope_key segment IS the tracked doc key's middle segment, so
    // the affected-tracker lookup is a direct join — no session-identity
    // re-resolution, and another principal's instance simply never
    // matches this state's tracker.
    const { id, scopeKey, scope } = fromDirtyKey(dirtyId);
    // The manager's read cache keys by (scope name, id) under its ONE
    // bound identity, so invalidate only dirtiness aimed at THIS
    // identity's own instance — a foreign instance was never cached here.
    if (
      canResolveScopeKey(scope, identity) &&
      resolveScopeKey(scope, identity) === scopeKey
    ) {
      let scopedIds = invalidations.get(scope);
      if (scopedIds === undefined) {
        scopedIds = new Set();
        invalidations.set(scope, scopedIds);
      }
      scopedIds.add(id);
    }
    const key: QueryDocKey = `${space}/${scopeKey}/${id}`;
    if (state.lazy.has(key)) lazyHits.add(key);
    const selectors = state.tracker.get(key);
    if (selectors !== undefined && selectors.size > 0) {
      affectedDocs.set(key, new Set(selectors));
    }
    // A dirty doc the query's walks MISSED (read as absent) re-fires the
    // query exactly like a tracked one: this is the arrival half of the
    // dead-end read contract — the write that creates the document is the
    // event that heals every read that dead-ended on it. Without this, a
    // first-hydration miss on a quiet space starves for the session's
    // life (OW45 arm B).
    const missedSelectors = state.missed.get(key);
    if (missedSelectors !== undefined && missedSelectors.size > 0) {
      affectedMisses.set(key, new Set(missedSelectors));
    }
  }
  if (
    affectedDocs.size === 0 && affectedMisses.size === 0 &&
    lazyHits.size === 0
  ) {
    return null;
  }

  const manager = new EngineObjectManager(
    engine,
    state.branch,
    state.manager.principal,
    state.manager.sessionId,
  );
  const sharedMemo = createSchemaMemo();
  const stats = createQueryTraversalStats();
  const readCountBefore = manager.readCount;

  const recorder = missRecorderFor(state);
  for (const key of affectedDocs.keys()) {
    state.tracker.delete(key);
    // The re-walk below re-records this referrer's still-live misses and
    // lazy registrations; attributions from its PREVIOUS walk no longer
    // stand, so a link or manifest entry edited away retires its miss or
    // registration instead of leaving a stale wake.
    releaseReferrerMisses(state, key);
    releaseReferrerLazy(state, key);
  }

  for (const [key, selectors] of affectedDocs) {
    const { id, scope, scopeKey } = fromDocKey(key);
    const role = state.roots.has(key) ? "root" as const : "crossing" as const;
    for (const selector of selectors) {
      const visited = evaluateTrackedDocument(
        space,
        manager,
        { id, scope, scopeKey },
        selector,
        state.tracker,
        recorder,
        sharedMemo,
        stats,
        undefined,
        (lazyKey, referrerKey) => recordLazy(state, lazyKey, referrerKey),
        role,
      );
      // A named root that was absent when first tracked earns its family
      // on the visit that finds it born.
      if (visited && role === "root") state.rootFamilies.add(key);
    }
  }
  // Re-evaluate the dirtied misses. A BORN target is visited — it enters
  // the tracker (and the update assembly below delivers it) — and its
  // miss retires; a still-absent one keeps its miss and attributions
  // untouched (the throwaway sink swallows the absent re-registration:
  // a miss never migrates into the tracker, whose entries reach the
  // wire).
  const stillAbsent = new MapSetStringToPathSelectors(true);
  for (const [key, selectors] of affectedMisses) {
    const { id, scope, scopeKey } = fromDocKey(key);
    const role = state.roots.has(key) ? "root" as const : "crossing" as const;
    for (const selector of selectors) {
      const visited = evaluateTrackedDocument(
        space,
        manager,
        { id, scope, scopeKey },
        selector,
        state.tracker,
        recorder,
        sharedMemo,
        stats,
        stillAbsent,
        (lazyKey, referrerKey) => recordLazy(state, lazyKey, referrerKey),
        role,
      );
      if (visited && role === "root") state.rootFamilies.add(key);
    }
    // Retirement is decided by THIS evaluation's own outcome — the
    // throwaway sink received the key iff the doc was still absent. The
    // tracker is no witness here: the same key can be an absent watch
    // ROOT whose re-evaluation just re-added its seq-0 marker, and
    // retiring the miss on that would lose the link-derived selector's
    // closure when the doc is finally born.
    if (!stillAbsent.has(key)) {
      retireMiss(state, key);
    }
  }

  // Promote lazily registered documents this batch touched — including
  // ones the re-walks above JUST registered (a piece created together
  // with its computed cells in one batch: healing the piece's miss
  // registers its cells, and the same batch's dirtiness delivers them).
  // Promotion requires a deliverable snapshot: a registration whose
  // document this batch DELETED stays lazy — still dirty interest — so
  // the recreation that follows promotes it then. A key both tracked and
  // lazily registered is already live; the stale lazy entry just
  // retires.
  for (const dirtyId of dirtyIds) {
    const { id, scopeKey } = fromDirtyKey(dirtyId);
    const key: QueryDocKey = `${space}/${scopeKey}/${id}`;
    if (!state.lazy.has(key)) continue;
    if (state.tracker.has(key)) {
      // Tracked delivery supersedes the lazy lifecycle: retire the
      // registration and BOTH attribution directions, not just the flat
      // membership, or the reverse edges outlive it through clones.
      retireLazyKey(state, key);
      continue;
    }
    const snapshot = snapshotForDocKey(space, manager, state.branch, key);
    if (snapshot === null || snapshot.document === null) continue;
    retireLazyKey(state, key);
    state.tracker.add(key, REJECTING_SELECTOR);
    promotedLazy.add(key);
  }

  const touched = new Set<QueryDocKey>(affectedDocs.keys());
  for (const key of affectedMisses.keys()) touched.add(key);
  for (const key of promotedLazy) touched.add(key);
  for (const address of manager.loadedAddresses()) {
    const key: QueryDocKey = `${space}/${address.scopeKey}/${address.id}`;
    const previous = state.entities.get(key);
    const detail = manager.detail({
      id: address.id,
      scope: address.scope,
      scopeKey: address.scopeKey,
    });
    if (previous !== undefined && detail?.seq === previous.seq) {
      continue;
    }
    touched.add(key);
  }

  const updates = new Map<QueryDocKey, EntitySnapshot>();
  for (const key of touched) {
    if (!state.tracker.has(key)) {
      continue;
    }
    const snapshot = snapshotForDocKey(
      space,
      manager,
      state.branch,
      key,
    );
    if (snapshot === null) {
      continue;
    }
    updates.set(key, snapshot);
  }

  // `established` extends validation over the whole previously delivered
  // state, so a corrupted dependency fails the refresh even when its
  // referrer did not change. A throw here can leave this graph's tracker
  // partially advanced; the caller marks the session for a full
  // re-evaluation, which re-diffs everything on the next successful pass
  // rather than trusting increments computed over the failure.
  const staged = assembleSchemaDocClosures(
    space,
    engine,
    manager,
    state.branch,
    state.tracker,
    updates,
    state.entities,
  );
  for (const key of staged.trackerAdds) {
    state.tracker.add(key, REJECTING_SELECTOR);
  }
  for (const [key, snapshot] of staged.additions) {
    updates.set(key, snapshot);
  }

  // A promoted document's own derived cells register lazily in turn, so
  // the subscription's reach grows exactly as far as commits take it.
  for (const key of promotedLazy) {
    const snapshot = updates.get(key);
    if (snapshot === undefined) continue;
    const { id, scope } = fromDocKey(key);
    sinkMetaLinkedDocKeys(
      {
        address: {
          space: space as MemorySpace,
          id: id as URI,
          scope,
          path: [],
        },
        value: snapshot.document,
      } as Parameters<typeof sinkMetaLinkedDocKeys>[0],
      "internal",
      identity,
      (lazyKey: string, referrerKey: string) => {
        if (!state.tracker.has(lazyKey)) {
          recordLazy(state, lazyKey, referrerKey);
        }
      },
    );
  }

  for (const [key, snapshot] of updates) {
    state.entities.set(key, snapshot);
  }
  for (const [scope, ids] of invalidations) {
    state.manager.invalidateIds(ids, scope);
  }
  state.manager.mergeFrom(manager);

  stats.managerReads = manager.readCount - readCountBefore;

  return {
    serverSeq: Engine.serverSeq(engine),
    updates,
    stats,
  };
};

const evaluateTrackedDocument = (
  space: string,
  manager: EngineObjectManager,
  address: { id: string; scope?: CellScope; scopeKey?: ScopeKey },
  selector: SchemaPathSelector,
  schemaTracker: MapSetStringToPathSelectors,
  onMissedDoc: (
    missKey: string,
    selector: SchemaPathSelector,
    referrerKey: string | undefined,
  ) => void,
  sharedMemo: SchemaMemo,
  stats: QueryTraversalStats,
  // Where an ABSENT document's selector lands. A watch ROOT records in
  // the tracker — absence is delivered as the seq-0 marker entity — while
  // a re-evaluated MISS must NOT migrate into the delivered set: a
  // dirtied-but-still-absent target (a creation and deletion coalesced
  // into one batch, say) keeps waiting for a real arrival, so its
  // caller passes a sink the wire never sees.
  absentSink: MapSetStringToPathSelectors = schemaTracker,
  lazyInternalSink?: (key: string, referrerKey: string) => void,
  role: "root" | "crossing" = "root",
): boolean => {
  const docKey: QueryDocKey = address.scopeKey !== undefined
    ? `${space}/${address.scopeKey}/${address.id}`
    : toDocKey(
      space,
      address.id,
      address.scope ?? DEFAULT_SCOPE,
      identityOf(manager),
    );
  const loaded = manager.load(address);
  if (loaded === null || loaded.value === undefined) {
    absentSink.add(docKey, internPathSelector(selector));
    return false;
  }
  // A fresh walk per document, so each starts with an empty pointer-cycle
  // tracker while sharing the query's reach and its memoized schema results.
  new GraphQueryWalk({
    manager,
    space: space as MemorySpace,
    schemaTracker,
    onMissedDoc,
    lazyInternalSink,
    identity: identityOf(manager),
    memo: sharedMemo,
    stats,
  }).visit(loaded, selector, docKey, role);
  return true;
};

export const toDocKey = (
  space: string,
  id: string,
  scope: CellScope = DEFAULT_SCOPE,
  identity: ScopeKeyIdentity,
): QueryDocKey => schemaTrackerKey(space, id, scope, identity);

export const fromDocKey = (key: QueryDocKey): {
  space: string;
  id: string;
  scope: CellScope;
  scopeKey: ScopeKey;
} => {
  // The SPACE (a did) and the scope-key segment (its parts are
  // encodeURIComponent-encoded) never contain "/", so the first two
  // separators are exact and everything after them is the ID — which CAN
  // contain "/" (module-derived handler ids, `data:` ids). The scope
  // NAME is recovered from the instance key because readers resolve rows
  // by (scope, session identity) as before. The instance key itself is
  // returned too: the M4/M1 paths (stage F) address rows by exact
  // instance rather than re-resolving from the session.
  const [space, scopeKey, ...rest] = key.split("/");
  if (rest.length > 0 && isScopeKey(scopeKey)) {
    return {
      space,
      scope: scopeOfScopeKey(scopeKey),
      scopeKey,
      id: rest.join("/"),
    };
  }
  throw new Error(`invalid memory v2 query doc key: ${key}`);
};

/**
 * Wake/sync dirty keys are per scope INSTANCE (scopes.md §7 M4, stage F):
 * `${scope_key}\0${id}`, the same shared vocabulary storage rows and
 * query doc keys use. Dirtiness and delivery both key by scope_key, so a
 * commit to one principal's instance touches only the sessions tracking
 * THAT instance (protocol.md §3) — the scope-NAME form collapsed every
 * principal's instances onto one key, quadratic waste once one server
 * hosts every instance. At cardinality 1 per session the re-keyed form
 * partitions exactly as the name form did (key-vocabulary.md §2).
 */
// Relocated to the shared browser-safe vocabulary surface (v2.ts, beside
// resolveScopeKey) so client-bundled modules can key with it; re-exported
// here for this module's existing importers.
export { toDirtyKey } from "../v2.ts";

export const fromDirtyKey = (
  key: string,
): { id: string; scopeKey: ScopeKey; scope: CellScope } => {
  const separator = key.indexOf("\0");
  if (separator > 0) {
    const scopeKey = key.slice(0, separator);
    if (isScopeKey(scopeKey)) {
      return {
        scopeKey,
        scope: scopeOfScopeKey(scopeKey),
        id: key.slice(separator + 1),
      };
    }
  }
  throw new Error(`invalid memory v2 dirty key: ${key}`);
};
