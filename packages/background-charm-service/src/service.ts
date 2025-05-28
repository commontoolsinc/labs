import { Identity } from "@commontools/identity";
import { type Cell, type Runtime } from "@commontools/runner";
import {
  BG_CELL_CAUSE,
  BG_SYSTEM_SPACE_ID,
  type BGCharmEntry,
} from "./schema.ts";
import { getBGCharms, log } from "./utils.ts";
import { SpaceManager } from "./space-manager.ts";
import { useCancelGroup } from "@commontools/runner";

export interface BackgroundCharmServiceOptions {
  identity: Identity;
  toolshedUrl: string;
  runtime: Runtime;
  bgSpace?: string;
  bgCause?: string;
  workerTimeoutMs?: number;
}

export class BackgroundCharmService {
  private charmsCell: Cell<Cell<BGCharmEntry>[]> | null = null;
  private isRunning = false;
  private charmSchedulers: Map<string, SpaceManager> = new Map();
  private identity: Identity;
  private toolshedUrl: string;
  private runtime: Runtime;
  private bgSpace: string;
  private bgCause: string;
  private workerTimeoutMs?: number;

  constructor(options: BackgroundCharmServiceOptions) {
    this.identity = options.identity;
    this.toolshedUrl = options.toolshedUrl;
    this.runtime = options.runtime;
    this.bgSpace = options.bgSpace ?? BG_SYSTEM_SPACE_ID;
    this.bgCause = options.bgCause ?? BG_CELL_CAUSE;
    this.workerTimeoutMs = options.workerTimeoutMs;
  }

  async initialize() {
    // Storage URL and signer are already configured in the Runtime
    this.charmsCell = await getBGCharms({
      bgSpace: this.bgSpace,
      bgCause: this.bgCause,
      runtime: this.runtime,
    });
    await this.runtime.storage.syncCell(this.charmsCell, true);
    await this.runtime.storage.synced();

    if (this.isRunning) {
      log("Service is already running");
      return;
    }

    this.isRunning = true;
    this.charmsCell.sink((cs) => this.ensureCharms(cs));
  }

  stop() {
    // FIXME(ja): stop listening to the charms cell ?
    if (!this.isRunning) {
      log("Service is not running");
      return;
    }

    const promises = Array.from(this.charmSchedulers.values()).map(
      (scheduler) => scheduler.stop(),
    );
    return Promise.allSettled(promises);
  }

  // FIXME(ja): space managers should watch their own charms!
  // Note(ja): this assumes that sync won't return an empty
  // array / partial results!
  private ensureCharms(charms: Cell<BGCharmEntry>[]) {
    if (!this.isRunning) {
      log("ignoring charms update because service asked to stop");
      return;
    }

    // Charms that hit an e.g. Authorization Error are empty, and space
    // is undefined -- filter out any of these charms before creating
    // a worker
    const charmContents = charms.map((c) => c.get()).filter(Boolean);
    const enabledCharms = charmContents.filter((c) => !c.disabledAt);
    const dids = new Set(enabledCharms.map((c) => c.space));
    log(`monitoring ${dids.size} spaces`);

    const [cancel, addCancel] = useCancelGroup();

    for (const did of dids) {
      let scheduler = this.charmSchedulers.get(did);
      if (!scheduler) {
        // Should send a derived/non-top-level key
        // to each space once delegation is working.
        scheduler = new SpaceManager({
          did,
          toolshedUrl: this.toolshedUrl,
          identity: this.identity,
          timeoutMs: this.workerTimeoutMs,
        });
        this.charmSchedulers.set(did, scheduler);
        scheduler.start();
      }

      // we are only filtering charms because until the FIXME above is fixed
      const didCharms = charms.filter((c) => c.get().space === did);
      addCancel(scheduler.watch(didCharms));
    }

    const removedSpaces = new Set(this.charmSchedulers.keys()).difference(dids);
    for (const did of removedSpaces.values()) {
      // we are no longer monitoring this space
      const scheduler = this.charmSchedulers.get(did);
      this.charmSchedulers.delete(did);
      // we can't await this in our callback, but we can at least catch and log errors
      scheduler?.stop().catch((e) =>
        console.error(`Error stopping scheduler: ${e}`)
      );
      // TODO(@ubik2) I'm not sure if we need to call the cancel function returned by scheduler.watch
    }

    return cancel;
  }
}
