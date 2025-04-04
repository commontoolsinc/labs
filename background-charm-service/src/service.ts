import { Identity } from "@commontools/identity";
import { type Cell, storage } from "@commontools/runner";
import { type BGCharmEntry, getBGUpdaterCharmsCell } from "@commontools/utils";
import { log } from "./utils.ts";
import { SpaceManager } from "./space-manager.ts";
import { useCancelGroup } from "@commontools/runner";

export interface BackgroundCharmServiceOptions {
  identity: Identity;
  toolshedUrl: string;
}

export class BackgroundCharmService {
  private charmsCell: Cell<Cell<BGCharmEntry>[]> | null = null;
  private isRunning = false;
  private charmSchedulers: Map<string, SpaceManager> = new Map();
  private identity: Identity;
  private toolshedUrl: string;

  constructor(options: BackgroundCharmServiceOptions) {
    this.identity = options.identity;
    this.toolshedUrl = options.toolshedUrl;
  }

  async initialize() {
    storage.setRemoteStorage(new URL(this.toolshedUrl));
    storage.setSigner(this.identity);
    this.charmsCell = await getBGUpdaterCharmsCell();
    await storage.syncCell(this.charmsCell, true);
    await storage.synced();

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

    const dids = new Set(charms.map((c) => c.get().space));
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
        });
        this.charmSchedulers.set(did, scheduler);
        scheduler.start().catch((err) => {
          log(`${did} Scheduler failed to initialize: ${err}`);
          this.charmSchedulers.delete(did);
        });
      }

      // we are only filtering charms because until the FIXME above is fixed
      const didCharms = charms.filter((c) => c.get().space === did);
      addCancel(scheduler.watch(didCharms));
    }

    return cancel;
  }
}
