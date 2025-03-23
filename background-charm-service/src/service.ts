import { Identity } from "@commontools/identity";
import { type Cell, storage } from "@commontools/runner";
import {
  type BGCharmEntry,
  getBGUpdaterCellCharmsCell,
} from "@commontools/utils";
import { log } from "./utils.ts";
import { env } from "./env.ts";
import { SpaceStation } from "./space-station.ts";

export class BackgroundCharmService {
  private charmsCell: Cell<Cell<BGCharmEntry>[]> | null = null;
  private isRunning = false;
  private spaceStation: Map<string, SpaceStation> = new Map();

  constructor() {
  }

  async initialize() {
    storage.setRemoteStorage(new URL(env.TOOLSHED_API_URL));
    storage.setSigner(await Identity.fromPassphrase(env.OPERATOR_PASS));
    this.charmsCell = await getBGUpdaterCellCharmsCell();
    await storage.syncCell(this.charmsCell, true);
    await storage.synced();
  }

  start() {
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

    const promises = Array.from(this.spaceStation.values()).map(
      (spaceStation) => spaceStation.stop(),
    );
    return Promise.allSettled(promises);
  }

  // FIXME(ja): spacestations should watch their own charms!
  // Note(ja): this assumes that sync won't return an empty
  // array / partial results!
  private ensureCharms(charms: Cell<BGCharmEntry>[]) {
    if (!this.isRunning) {
      log("ignoring charms update because service asked to stop");
      return;
    }

    const dids = charms.map((c) => c.get().space);
    console.log("ensureCharms", dids);

    for (const did of new Set(dids)) {
      let spaceStation = this.spaceStation.get(did);
      if (!spaceStation) {
        spaceStation = new SpaceStation({
          did,
          toolshedUrl: env.TOOLSHED_API_URL,
          operatorPass: env.OPERATOR_PASS,
        });
        this.spaceStation.set(did, spaceStation);
        spaceStation.start();
      }

      // we are only filtering charms because until the FIXME above is fixed
      const didCharms = charms.filter((c) => c.get().space === did);
      spaceStation.watch(didCharms);
    }
  }
}
