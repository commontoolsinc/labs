import { Identity } from "@commonfabric/identity";
import {
  type Cell,
  type MemorySpace,
  type Runtime,
} from "@commonfabric/runner";
import {
  BG_CELL_CAUSE,
  BG_SYSTEM_SPACE_ID,
  type BGPieceEntry,
} from "./schema.ts";
import { getBGPieces } from "./utils.ts";
import { SpaceManager } from "./space-manager.ts";
import { useCancelGroup } from "@commonfabric/runner";

type SpaceManagerLike = Pick<SpaceManager, "start" | "stop" | "watch">;

export interface BackgroundPieceServiceOptions {
  identity: Identity;
  toolshedUrl: string;
  runtime: Runtime;
  bgSpace?: MemorySpace;
  bgCause?: string;
  workerTimeoutMs?: number;
  createSpaceManager?: (
    options: ConstructorParameters<typeof SpaceManager>[0],
  ) => SpaceManagerLike;
}

export class BackgroundPieceService {
  private piecesCell: Cell<Cell<BGPieceEntry>[]> | null = null;
  private isRunning = false;
  private pieceSchedulers: Map<string, SpaceManagerLike> = new Map();
  private identity: Identity;
  private toolshedUrl: string;
  private runtime: Runtime;
  private bgSpace: MemorySpace;
  private bgCause: string;
  private workerTimeoutMs?: number;
  private createSpaceManager: (
    options: ConstructorParameters<typeof SpaceManager>[0],
  ) => SpaceManagerLike;

  constructor(options: BackgroundPieceServiceOptions) {
    this.identity = options.identity;
    this.toolshedUrl = options.toolshedUrl;
    this.runtime = options.runtime;
    this.bgSpace = options.bgSpace ?? BG_SYSTEM_SPACE_ID;
    this.bgCause = options.bgCause ?? BG_CELL_CAUSE;
    this.workerTimeoutMs = options.workerTimeoutMs;
    this.createSpaceManager = options.createSpaceManager ??
      ((managerOptions) => new SpaceManager(managerOptions));
  }

  async initialize() {
    if (this.isRunning) {
      console.log("Service is already running");
      return;
    }

    // DISABLED UNDER SERVER-PRIMARY EXECUTION (owner ruling, 2026-07-31).
    //
    // This service is "a runtime that runs pieces on the server by pretending
    // to be a client" — precisely what server-primary execution abolishes, so
    // it is being sunset rather than migrated. `bgUpdater` is not in practical
    // use today and will come back in a simpler form; until then, under this
    // flag it simply does not run.
    //
    // The flag is the right gate because it is already the one this service
    // branches on, and the correspondence is exact: the ONLY configuration in
    // which the space executor competes with this service is flag-on, and
    // flag-on is also the only configuration in which `ensurePieces` acquires a
    // `LegacyBackgroundExclusion`. Bailing here — before any exclusion is taken
    // — is therefore not merely a disable. The exclusion is what *structurally
    // locks the executor out* of every space with a live bg registration
    // (`memory/v2/engine.ts` refuses to acquire OR renew an execution lease
    // while one is live, and the pool parks such a slot `state: "excluded"`).
    // Never acquiring it is what lets the executor into those spaces at all.
    //
    // Flag OFF is byte-identical to before: no exclusion was ever taken there
    // either, so legacy deployments keep today's behaviour exactly.
    if (this.runtime.experimental.serverPrimaryExecution) {
      console.log(
        "background piece service disabled: server-primary execution is on " +
          "(bgUpdater is sunset; the space executor owns these spaces)",
      );
      return;
    }

    // Storage URL and signer are already configured in the Runtime
    this.piecesCell = await getBGPieces({
      bgSpace: this.bgSpace,
      bgCause: this.bgCause,
      runtime: this.runtime,
    });
    await this.piecesCell.sync();
    await this.runtime.storageManager.synced();

    this.isRunning = true;
    this.piecesCell.sink((cs) => this.ensurePieces(cs));
  }

  stop(): Promise<PromiseSettledResult<void>[]> {
    // FIXME(ja): stop listening to the pieces cell ?
    if (!this.isRunning) {
      console.log("Service is not running");
      return Promise.resolve([]);
    }

    this.isRunning = false;
    const promises = Array.from(this.pieceSchedulers.values()).map(
      (scheduler) => scheduler.stop(),
    );
    return Promise.allSettled(promises);
  }

  // FIXME(ja): space managers should watch their own pieces!
  // Note(ja): this assumes that sync won't return an empty
  // array / partial results!
  private ensurePieces(pieces: readonly Cell<BGPieceEntry>[]) {
    if (!this.isRunning) {
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
      // we are only filtering pieces because until the FIXME above is fixed
      const didPieces = pieces.filter((c) => c.get()?.space === did);
      let scheduler = this.pieceSchedulers.get(did);
      if (!scheduler) {
        const backgroundExclusion = this.runtime.experimental
            .serverPrimaryExecution
          ? (() => {
            const provider = this.runtime.storageManager.open(
              did as MemorySpace,
            );
            return {
              acquire: (branch: string) =>
                provider.acquireLegacyBackgroundExclusion?.(branch) ??
                  Promise.resolve(undefined),
              renew: (branch: string, exclusionGeneration: number) =>
                provider.renewLegacyBackgroundExclusion?.(
                  branch,
                  exclusionGeneration,
                ) ?? Promise.resolve(undefined),
              release: (branch: string, exclusionGeneration: number) =>
                provider.releaseLegacyBackgroundExclusion?.(
                  branch,
                  exclusionGeneration,
                ) ?? Promise.resolve(undefined),
            };
          })()
          : undefined;
        // Should send a derived/non-top-level key
        // to each space once delegation is working.
        scheduler = this.createSpaceManager({
          did,
          toolshedUrl: this.toolshedUrl,
          identity: this.identity,
          timeoutMs: this.workerTimeoutMs,
          experimental: this.runtime.experimental,
          ...(backgroundExclusion === undefined ? {} : { backgroundExclusion }),
        });
        this.pieceSchedulers.set(did, scheduler);
        addCancel(scheduler.watch(didPieces));
        scheduler.start();
      } else {
        addCancel(scheduler.watch(didPieces));
      }
    }

    const removedSpaces = new Set(this.pieceSchedulers.keys()).difference(dids);
    for (const did of removedSpaces.values()) {
      // we are no longer monitoring this space
      const scheduler = this.pieceSchedulers.get(did);
      this.pieceSchedulers.delete(did);
      // we can't await this in our callback, but we can at least catch and log errors
      scheduler?.stop().catch((e) =>
        console.error(`Error stopping scheduler: ${e}`)
      );
      // TODO(@ubik2) I'm not sure if we need to call the cancel function returned by scheduler.watch
    }

    return cancel;
  }
}
