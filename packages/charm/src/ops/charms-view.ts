import { RuntimeProgram } from "@commontools/runner";
import { CharmManager } from "../index.ts";
import { CharmView } from "./charm-view.ts";
import { compileProgram } from "./utils.ts";

export class CharmsView {
  #manager: CharmManager;

  constructor(manager: CharmManager) {
    this.#manager = manager;
  }

  async create(program: RuntimeProgram, input?: object): Promise<CharmView> {
    const recipe = await compileProgram(this.#manager, program);
    const charm = await this.#manager.runPersistent(recipe, input);
    await this.#manager.runtime.idle();
    await this.#manager.synced();
    return new CharmView(this.#manager, charm);
  }

  // Why is `CharmManager.get` async but `getCharms` sync?
  async get(charmId: string): Promise<CharmView> {
    const cell = await this.#manager.get(charmId);
    if (!cell) {
      throw new Error(`Charm "${charmId}" not found.`);
    }
    return new CharmView(this.#manager, cell);
  }

  getAllCharms() {
    const charms = this.#manager.getCharms().get();
    return charms.map((charm) => new CharmView(this.#manager, charm));
  }
}
