/**
 * The service's top level: watches the registry of background pieces and
 * keeps one `SpaceManager` running per space that has an enabled piece in it.
 */

import { Identity } from "@commonfabric/identity";
import {
  type Cell,
  type MemorySpace,
  type Runtime,
  useCancelGroup,
} from "@commonfabric/runner";

import {
  BG_CELL_CAUSE,
  BG_SYSTEM_SPACE_ID,
  type BGPieceEntry,
} from "./schema.ts";
import { SpaceManager } from "./space-manager.ts";
import { getBGPieces } from "./utils.ts";

/**
 * The part of a `SpaceManager` the service drives, so that a test can stand
 * one in.
 */
type SpaceManagerLike = Pick<SpaceManager, "start" | "stop" | "watch">;

/** Options for constructing a `BackgroundPieceService`. */
export interface BackgroundPieceServiceOptions {
  /** Identity each space's worker runs as. */
  identity: Identity;

  /** URL of the toolshed the workers talk to. */
  toolshedUrl: string;

  /** Runtime the service reads the registry through. */
  runtime: Runtime;

  /** Space holding the registry; the system space by default. */
  bgSpace?: MemorySpace;

  /** Cause of the registry cell; `BG_CELL_CAUSE` by default. */
  bgCause?: string;

  /**
   * How long a worker request may run before it fails, in milliseconds; each
   * space's manager passes it on to its worker controller.
   */
  workerTimeoutMs?: number;

  /**
   * Factory for a space's manager, which constructs a `SpaceManager` by
   * default; a test hands in one that builds a stand-in.
   */
  createSpaceManager?: (
    options: ConstructorParameters<typeof SpaceManager>[0],
  ) => SpaceManagerLike;
}

/**
 * Orchestrator of background piece execution. Once initialized it watches the
 * registry cell, starts a `SpaceManager` for each space with an enabled entry,
 * hands each manager the entries for its space, and stops the manager of a
 * space that no longer has one.
 */
export class BackgroundPieceService {
  #piecesCell: Cell<Cell<BGPieceEntry>[]> | null = null;
  #isRunning = false;
  #pieceSchedulers: Map<string, SpaceManagerLike> = new Map();
  #identity: Identity;
  #toolshedUrl: string;
  #runtime: Runtime;
  #bgSpace: MemorySpace;
  #bgCause: string;
  #workerTimeoutMs?: number;
  #createSpaceManager: (
    options: ConstructorParameters<typeof SpaceManager>[0],
  ) => SpaceManagerLike;

  /**
   * Constructs an instance from `options`, which runs nothing until
   * `initialize()`.
   */
  constructor(options: BackgroundPieceServiceOptions) {
    this.#identity = options.identity;
    this.#toolshedUrl = options.toolshedUrl;
    this.#runtime = options.runtime;
    this.#bgSpace = options.bgSpace ?? BG_SYSTEM_SPACE_ID;
    this.#bgCause = options.bgCause ?? BG_CELL_CAUSE;
    this.#workerTimeoutMs = options.workerTimeoutMs;
    this.#createSpaceManager = options.createSpaceManager ??
      ((managerOptions) => new SpaceManager(managerOptions));
  }

  /**
   * Syncs the registry cell and starts watching it; from then on every change
   * to the registry reconciles the set of space managers. A second call while
   * running does nothing.
   */
  async initialize() {
    if (this.#isRunning) {
      console.log("Service is already running");
      return;
    }

    // Storage URL and signer are already configured in the Runtime
    this.#piecesCell = await getBGPieces({
      bgSpace: this.#bgSpace,
      bgCause: this.#bgCause,
      runtime: this.#runtime,
    });
    await this.#piecesCell.sync();
    await this.#runtime.storageManager.synced();

    this.#isRunning = true;
    this.#piecesCell.sink((cs) => this.#ensurePieces(cs));
  }

  /**
   * Stops every space manager, and returns how each stop settled. Stops
   * nothing when the service is not running.
   */
  stop(): Promise<PromiseSettledResult<void>[]> {
    // FIXME(ja): stop listening to the pieces cell ?
    if (!this.#isRunning) {
      console.log("Service is not running");
      return Promise.resolve([]);
    }

    this.#isRunning = false;
    const promises = Array.from(this.#pieceSchedulers.values()).map(
      (scheduler) => scheduler.stop(),
    );
    return Promise.allSettled(promises);
  }

  /**
   * Helper for `initialize()`, which reconciles the space managers against
   * the registry's entries: starts a manager for each space with an enabled
   * entry, hands every manager the entries for its space, and stops the
   * manager of a space with no enabled entry left. Returns the `Cancel` that
   * undoes the watches it registered, which the registry sink runs before the
   * next invocation so that each round's watches replace the last; returns
   * nothing when the service is not running.
   */
  #ensurePieces(pieces: readonly Cell<BGPieceEntry>[]) {
    // FIXME(ja): space managers should watch their own pieces!
    // Note(ja): this assumes that sync won't return an empty
    // array / partial results!
    if (!this.#isRunning) {
      console.log("ignoring pieces update because service asked to stop");
      return;
    }

    // Pieces that hit an e.g. Authorization Error are empty, and space
    // is undefined -- filter out any of these pieces before creating
    // a worker
    const pieceContents = pieces.map((c) => c.get()).filter(Boolean);
    const enabledPieces = pieceContents.filter((c) => !c.disabledAt);
    const dids = new Set(enabledPieces.map((c) => c.space));
    console.log(`monitoring ${dids.size} spaces`);

    const [cancel, addCancel] = useCancelGroup();

    for (const did of dids) {
      let scheduler = this.#pieceSchedulers.get(did);
      if (!scheduler) {
        // Should send a derived/non-top-level key
        // to each space once delegation is working.
        scheduler = this.#createSpaceManager({
          did,
          toolshedUrl: this.#toolshedUrl,
          identity: this.#identity,
          timeoutMs: this.#workerTimeoutMs,
          experimental: this.#runtime.experimental,
        });
        this.#pieceSchedulers.set(did, scheduler);
        scheduler.start();
      }

      // we are only filtering pieces because until the FIXME above is fixed
      const didPieces = pieces.filter((c) => c.get()?.space === did);
      addCancel(scheduler.watch(didPieces));
    }

    const removedSpaces = new Set(this.#pieceSchedulers.keys()).difference(
      dids,
    );
    for (const did of removedSpaces.values()) {
      // we are no longer monitoring this space
      const scheduler = this.#pieceSchedulers.get(did);
      this.#pieceSchedulers.delete(did);
      // we can't await this in our callback, but we can at least catch and log errors
      scheduler?.stop().catch((e) =>
        console.error(`Error stopping scheduler: ${e}`)
      );
      // TODO(@ubik2) I'm not sure if we need to call the cancel function returned by scheduler.watch
    }

    return cancel;
  }
}
