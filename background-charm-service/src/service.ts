import { Identity } from "@commontools/identity";
import { type Cell, storage } from "@commontools/runner";
import {
  type BGCharmEntry,
  getBGUpdaterCellCharmsCell,
} from "@commontools/utils";
import { log } from "./utils.ts";
import { env } from "./env.ts";
import { SpaceManager } from "./space-manager.ts";

export class BackgroundCharmService {
  private charmsCell: Cell<Cell<BGCharmEntry>[]> | null = null;
  private isRunning = false;
  private charmSchedulers: Map<string, SpaceManager> = new Map();

  constructor() {
  }

  async initialize() {
    storage.setRemoteStorage(new URL(env.TOOLSHED_API_URL));
    storage.setSigner(await Identity.fromPassphrase(env.OPERATOR_PASS));
    this.charmsCell = await getBGUpdaterCellCharmsCell();
    await storage.syncCell(this.charmsCell, true);
    await storage.synced();

    if (this.isRunning) {
      log("Service is already running");
      return;
    }

    this.isRunning = true;
    this.charmsCell.sink((cs) => this.ensureCharms(cs.get()));
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

    for (const did of dids) {
      let scheduler = this.charmSchedulers.get(did);
      if (!scheduler) {
        scheduler = new SpaceManager({
          did,
          toolshedUrl: env.TOOLSHED_API_URL,
          operatorPass: env.OPERATOR_PASS,
        });
        this.charmSchedulers.set(did, scheduler);
        scheduler.start();
      }

      // we are only filtering charms because until the FIXME above is fixed
      const didCharms = charms.filter((c) => c.get().space === did);
      scheduler.watch(didCharms);
    }
  }
}
