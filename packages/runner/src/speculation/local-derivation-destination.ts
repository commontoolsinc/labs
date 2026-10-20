/**
 * Holds a client runtime's derived state for a space its principal cannot
 * write. A reactive computation writes its outputs where its inputs live, and
 * a principal granted READ there still runs the computation: the view they
 * read is made of those outputs. The space refuses the writes, so a derived
 * transaction is sealed into the replica's process-local layer instead of
 * being pushed. Reads see the held value through the ordinary pending
 * materialization; nothing is sent, synced, or kept past the runtime's life.
 * The store is the cache of derived state for principals who may write it,
 * and a principal who may not keeps a working copy of their own
 * (`docs/specs/memory-v2/03-commit-model.md` §3.8.3).
 *
 * A held derivation is replaced rather than accumulated. A newer whole-document
 * derivation of the same documents retires the older one, an authoritative
 * value arriving for a document it wrote retires it, and a grant of WRITE
 * retires every held derivation in the space and runs their writers again,
 * which then commit to the store.
 *
 * Only a transaction marked `derivedWrites` is held. Every other write — an
 * event append, a binding edit, a setup a host asks for — commits as it would
 * without this destination, so a refusal of one still reaches its author.
 */

import { type ACL, aclDocId } from "@commonfabric/memory/acl";
import type { CellScope } from "@commonfabric/memory/v2";
import { getLogger } from "@commonfabric/utils/logger";

import { spaceReaderRole } from "../cfc/space-membership.ts";
import type { Runtime } from "../runtime.ts";
import type { Action } from "../scheduler.ts";
import { createTransactionCommitReceipt } from "../storage/commit-receipt.ts";
import type {
  CommitError,
  IExtendedStorageTransaction,
  IStorageTransaction,
  ITransactionSealSink,
  MemorySpace,
  NativeStorageCommit,
  Result,
  SealedCommitVerdict,
  TransactionCommitOptions,
  TransactionCommitReceipt,
  TransactionSealDestination,
  Unit,
  URI,
} from "../storage/interface.ts";
import { isPermanentAuthorizationRefusal } from "../storage/rejection.ts";

const logger = getLogger("local-derivation", {
  enabled: true,
  level: "warn",
});

/** A principal's standing to write a space, as far as this runtime can tell. */
type WriteAccess = "granted" | "refused" | "unknown";

/** One derived transaction held in a space's process-local layer. */
type HeldDerivation = {
  space: MemorySpace;

  /** The replica-local seq the held pending writes are keyed by. */
  localSeq: number;

  resolveVerdict: (verdict: SealedCommitVerdict) => void;

  /**
   * The document instances the transaction wrote, and whether each was
   * written whole, which is what lets a later whole write stand in for it.
   */
  writtenDocs: Array<{ id: URI; scope?: CellScope; wholeDoc: boolean }>;

  /** The scheduler action whose run produced the derivation, when one did. */
  writer: Action | undefined;

  /** Resolves once the verdict has been applied to the replica. */
  settled: Promise<unknown>;
};

/** The replica's record of a space's access list, and whether it has loaded. */
type AccessListState = {
  loaded: boolean;
  load: Promise<void>;
};

const isAction = (value: unknown): value is Action =>
  typeof value === "function";

const docKey = (doc: { id: string; scope?: CellScope }): string =>
  `${doc.scope ?? ""}\0${doc.id}`;

/**
 * The seal destination that holds derived writes locally where the principal
 * cannot store them: one per client runtime, consulted for every transaction
 * the runtime mints while it seals into neither a wave nor the speculation
 * overlay.
 */
export class LocalDerivationDestination implements TransactionSealDestination {
  readonly #runtime: Runtime;

  /** space → localSeq → held derivation. */
  readonly #held = new Map<MemorySpace, Map<number, HeldDerivation>>();

  readonly #accessLists = new Map<MemorySpace, AccessListState>();

  /**
   * Spaces the store refused a derived write of for lack of a grant since
   * the replica's copy of their access list last changed: the list the
   * replica holds was behind the one the store decided by.
   */
  readonly #refused = new Set<MemorySpace>();

  /** space → cancel of the sink that re-reads the access list on change. */
  readonly #accessListSinks = new Map<MemorySpace, () => void>();

  /** space → release of the arrival wake installed on the replica. */
  readonly #arrivalReleases = new Map<MemorySpace, () => void>();

  #closed = false;

  /** Constructs an instance which holds derivations for `runtime`. */
  constructor(runtime: Runtime) {
    this.#runtime = runtime;
  }

  /**
   * Whether an effect completion sealing here asserts its writes whole. It
   * does not: a completion commits to the store, where the ordinary no-op
   * elision diffs against the right view.
   */
  get authoritativeCompletions(): false {
    return false;
  }

  /** DIAGNOSTIC (tests): the derivations held for `space`. */
  heldCount(space: MemorySpace): number {
    return this.#held.get(space)?.size ?? 0;
  }

  /**
   * DIAGNOSTIC (tests): what this runtime's principal may write in `space`,
   * once its access list has loaded.
   */
  writeAccess(space: MemorySpace): WriteAccess {
    return this.#writeAccess(space);
  }

  /** Holds a derived transaction, or forwards any other to the store. */
  seal(
    tx: IExtendedStorageTransaction,
    options?: TransactionCommitOptions,
  ): Promise<Result<Unit, CommitError>> | TransactionCommitReceipt {
    if (this.#closed || tx.tx.derivedWrites !== true) {
      return tx.tx.commit(options);
    }
    const spaces = tx.tx.writtenSpaces?.() ?? [];
    const loads = spaces
      .filter((space) => this.#writeAccess(space) === "unknown")
      .map((space) => this.#ensureAccessList(space));
    if (loads.length === 0) return this.#decide(tx, options, spaces);
    // The decision waits for the access lists it turns on, which is what
    // keeps a cold runtime's first derivation from being pushed and refused
    // while its list is still arriving.
    return createTransactionCommitReceipt((async () => {
      await Promise.all(loads);
      const decided = this.#decide(tx, options, spaces);
      return "settled" in decided ? await decided.settled : await decided;
    })());
  }

  /**
   * Withdraws every held derivation and releases the watches. The replica
   * may already be closing, so the rollback is best-effort.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [space, held] of this.#held) {
      for (const entry of held.values()) {
        entry.resolveVerdict({
          withdrawn: {
            message: `held derivation in ${space} released: runtime closed`,
            superseded: true,
          },
        });
      }
      held.clear();
    }
    this.#held.clear();
    for (const cancel of this.#accessListSinks.values()) {
      try {
        cancel();
      } catch {
        // sink cancellation is best-effort during teardown
      }
    }
    this.#accessListSinks.clear();
    for (const release of this.#arrivalReleases.values()) {
      try {
        release();
      } catch {
        // observer release is best-effort during teardown
      }
    }
    this.#arrivalReleases.clear();
    this.#accessLists.clear();
    this.#refused.clear();
  }

  /** Helper for {@link seal}, which holds or forwards once access is known. */
  #decide(
    tx: IExtendedStorageTransaction,
    options: TransactionCommitOptions | undefined,
    spaces: readonly MemorySpace[],
  ): Promise<Result<Unit, CommitError>> | TransactionCommitReceipt {
    if (spaces.some((space) => this.#writeAccess(space) === "refused")) {
      return this.#hold(tx);
    }
    return this.#forward(tx, options, spaces);
  }

  /**
   * Helper for {@link seal}, which commits `tx` to the store and learns from
   * a refusal: a grant refusal says the store's access list is ahead of the
   * replica's, so later derivations into the same spaces are held.
   */
  #forward(
    tx: IExtendedStorageTransaction,
    options: TransactionCommitOptions | undefined,
    spaces: readonly MemorySpace[],
  ): TransactionCommitReceipt {
    const receipt = tx.tx.commit(options);
    receipt.settled.then((result) => {
      if (
        result.error !== undefined &&
        isPermanentAuthorizationRefusal(result.error)
      ) {
        for (const space of spaces) this.#refused.add(space);
      }
    }, () => {});
    return receipt;
  }

  /**
   * Helper for {@link seal}, which seals `tx` into the replica's local layer
   * as whole-document writes and registers what it holds.
   */
  async #hold(
    tx: IExtendedStorageTransaction,
  ): Promise<Result<Unit, CommitError>> {
    const inner = tx.tx;
    if (
      inner.sealInto === undefined ||
      inner.markWholeDocumentWrites === undefined
    ) {
      return {
        error: {
          name: "StorageTransactionAborted",
          message: "a derived write the principal cannot store could not " +
            "be held locally: the storage transaction does not support " +
            "sealing whole-document writes",
          reason: new Error("local-derivation-unsupported"),
        },
      };
    }
    const held: HeldDerivation[] = [];
    const collector: ITransactionSealSink = {
      sealSpaceCommit: (
        space: MemorySpace,
        native: NativeStorageCommit,
        source: IStorageTransaction,
      ): Promise<Result<Unit, CommitError>> => {
        const replica = this.#runtime.storageManager.open(space).replica;
        if (replica.sealNative === undefined) {
          return Promise.resolve({
            error: {
              name: "StorageTransactionAborted",
              message: `space replica for ${space} does not support ` +
                "sealing, so a derived write there cannot be held locally",
              reason: new Error("local-derivation-unsupported"),
            },
          });
        }
        const { promise, resolve } = Promise.withResolvers<
          SealedCommitVerdict
        >();
        const sealed = replica.sealNative(native, source, promise, {
          speculative: true,
        });
        const writtenDocs = new Map<
          string,
          { id: URI; scope?: CellScope; wholeDoc: boolean }
        >();
        for (
          const op of sealed.commit.operations as Array<
            { id?: string; scope?: CellScope; op?: string }
          >
        ) {
          if (typeof op.id !== "string") continue;
          const key = docKey({ id: op.id, scope: op.scope });
          const wholeDoc = op.op === "set" || op.op === "delete";
          const existing = writtenDocs.get(key);
          if (existing === undefined) {
            writtenDocs.set(key, {
              id: op.id as URI,
              scope: op.scope,
              wholeDoc,
            });
          } else if (!wholeDoc) {
            existing.wholeDoc = false;
          }
        }
        const writer = source.sourceAction;
        held.push({
          space,
          localSeq: sealed.localSeq,
          resolveVerdict: resolve,
          writtenDocs: [...writtenDocs.values()],
          writer: isAction(writer) ? writer : undefined,
          settled: sealed.settled.catch(() => undefined),
        });
        return Promise.resolve({ ok: {} });
      },
    };
    let result: Result<Unit, CommitError>;
    try {
      // The held writes are materialized over the confirmed value on every
      // read, and that value moves under them, so each says what the run
      // computed rather than how that differed from what it ran over.
      inner.markWholeDocumentWrites();
      result = await inner.sealInto(collector);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      result = {
        error: {
          name: "StorageTransactionAborted",
          message: `holding a derived write locally failed: ${message}`,
          reason: cause,
        },
      };
    }
    if (result.error) {
      for (const entry of held) {
        entry.resolveVerdict({
          withdrawn: {
            message: `holding a derived write locally failed: ` +
              result.error.message,
          },
        });
      }
      return result;
    }
    if (this.#closed) {
      for (const entry of held) {
        entry.resolveVerdict({
          withdrawn: {
            message: "held derivation released: runtime closed while sealing",
            superseded: true,
          },
        });
      }
      return { ok: {} };
    }
    for (const entry of held) this.#register(entry);
    return { ok: {} };
  }

  /**
   * Helper for {@link seal}, which records `entry` and retires the held
   * derivations it stands in for: one whose every document `entry` wrote
   * whole reads the same with or without its layer, so it goes.
   */
  #register(entry: HeldDerivation): void {
    let held = this.#held.get(entry.space);
    if (held === undefined) {
      held = new Map();
      this.#held.set(entry.space, held);
    }
    const covered = new Set(
      entry.writtenDocs.filter((doc) => doc.wholeDoc).map(docKey),
    );
    for (const older of [...held.values()]) {
      if (
        older.localSeq >= entry.localSeq || older.writtenDocs.length === 0 ||
        !older.writtenDocs.every((doc) => covered.has(docKey(doc)))
      ) {
        continue;
      }
      held.delete(older.localSeq);
      older.resolveVerdict({
        withdrawn: {
          message: "held derivation superseded by a newer derivation of " +
            "the same documents",
          superseded: true,
        },
      });
    }
    held.set(entry.localSeq, entry);
    this.#ensureArrivalObserver(entry.space);
  }

  /**
   * Helper for {@link seal}, which returns the principal's standing in
   * `space` from the access list the replica holds: `unknown` until the list
   * has been asked for and has arrived, `granted` for an owner or writer and
   * for a space with no list, which refuses nothing by one, and `refused`
   * otherwise, or while a refusal from the store stands.
   */
  #writeAccess(space: MemorySpace): WriteAccess {
    if (this.#refused.has(space)) return "refused";
    const state = this.#accessLists.get(space);
    if (state === undefined || !state.loaded) return "unknown";
    const acl = this.#runtime.storageManager.open(space).replica
      .getDocument(aclDocId(space) as URI, "space")?.value;
    if (acl === undefined) return "granted";
    const role = spaceReaderRole(acl as ACL, this.#runtime.userIdentityDID);
    return role === "owner" || role === "writer" ? "granted" : "refused";
  }

  /**
   * Helper for {@link seal}, which loads `space`'s access list into the
   * replica once and keeps it watched, so that a change to it is acted on.
   */
  #ensureAccessList(space: MemorySpace): Promise<void> {
    const existing = this.#accessLists.get(space);
    if (existing !== undefined) return existing.load;
    const aclId = aclDocId(space) as URI;
    const state: AccessListState = { loaded: false, load: Promise.resolve() };
    const report = (error: unknown) => {
      logger.warn("access-list-load-failed", () => [
        `the access list of ${space} could not be loaded; derived writes ` +
        "there go to the store until it arrives",
        error,
      ]);
    };
    state.load = Promise.resolve(
      this.#runtime.storageManager.open(space).sync(
        aclId,
        { path: [], schema: false },
        "space",
      ),
    ).then((result) => {
      if (result?.error !== undefined) report(result.error);
    }, report).finally(() => {
      state.loaded = true;
    });
    this.#accessLists.set(space, state);
    this.#watchAccessList(space, aclId);
    return state.load;
  }

  /**
   * Helper for {@link seal}, which re-reads `space`'s access list whenever
   * it changes. A change retires a refusal decided by the old list, and a
   * grant of WRITE releases what is held and runs the writers again.
   */
  #watchAccessList(space: MemorySpace, aclId: URI): void {
    try {
      const cell = this.#runtime.getCellFromLink<unknown>({
        space,
        id: aclId,
        path: [],
      });
      // The sink reports the current value once at subscription; only the
      // changes after that are acted on.
      let primed = false;
      const cancel = cell.sink(() => {
        if (!primed) {
          primed = true;
          return;
        }
        if (this.#closed) return;
        this.#refused.delete(space);
        if (this.#writeAccess(space) === "granted") {
          this.#release(space, "the principal may now write the space");
        }
      });
      this.#accessListSinks.set(space, cancel);
    } catch (error) {
      logger.warn("access-list-watch-failed", () => [
        `the access list of ${space} could not be watched; a grant made ` +
        "while this runtime runs reaches it only through a reload",
        error,
      ]);
    }
  }

  /**
   * Helper for the access-list watch, which withdraws every derivation held
   * for `space` and runs their writers again, which commit to the store now
   * that the principal may write it.
   */
  #release(space: MemorySpace, reason: string): void {
    const held = this.#held.get(space);
    if (held === undefined || held.size === 0) return;
    const writers = new Set<Action>();
    for (const entry of held.values()) {
      if (entry.writer !== undefined) writers.add(entry.writer);
      entry.resolveVerdict({
        withdrawn: {
          message: `held derivation in ${space} released: ${reason}`,
          superseded: true,
        },
      });
    }
    held.clear();
    for (const writer of writers) {
      this.#runtime.scheduler.invalidateAction(writer);
    }
  }

  /**
   * Helper for {@link seal}, which installs the replica's arrival wake for
   * `space`: a frame that moves the confirmed seq of a document a held
   * derivation wrote retires that derivation, since the store now holds an
   * authoritative value for it. A wake another destination installed is
   * left alone.
   */
  #ensureArrivalObserver(space: MemorySpace): void {
    if (this.#arrivalReleases.has(space)) return;
    const replica = this.#runtime.storageManager.open(space).replica;
    if (typeof replica.speculationRetirementView !== "function") return;
    const observable = replica as {
      speculationArrivalObserver:
        | ((arrived: readonly { id: URI; scope?: CellScope }[]) => void)
        | undefined;
    };
    if (observable.speculationArrivalObserver !== undefined) return;
    const observer = (arrived: readonly { id: URI; scope?: CellScope }[]) => {
      if (this.#closed) return;
      const held = this.#held.get(space);
      if (held === undefined || held.size === 0) return;
      const arrivedKeys = new Set(arrived.map(docKey));
      for (const entry of [...held.values()]) {
        if (!entry.writtenDocs.some((doc) => arrivedKeys.has(docKey(doc)))) {
          continue;
        }
        held.delete(entry.localSeq);
        entry.resolveVerdict({
          withdrawn: {
            message: "held derivation retired: an authoritative value " +
              "arrived for a document it wrote",
            superseded: true,
          },
        });
      }
    };
    observable.speculationArrivalObserver = observer;
    this.#arrivalReleases.set(space, () => {
      if (observable.speculationArrivalObserver === observer) {
        observable.speculationArrivalObserver = undefined;
      }
    });
  }
}
