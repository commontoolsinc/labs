import { RuntimeProgram } from "@commontools/runner";
import { CharmManager } from "../index.ts";
import { CharmController } from "./charm-controller.ts";
import { compileProgram } from "./utils.ts";

export class CharmsController {
  #manager: CharmManager;

  constructor(manager: CharmManager) {
    this.#manager = manager;
  }

  manager(): CharmManager {
    return this.#manager;
  }

  async create(
    program: RuntimeProgram | string,
    input?: object,
  ): Promise<CharmController> {
    const recipe = await compileProgram(this.#manager, program);
    const charm = await this.#manager.runPersistent(recipe, input);
    await this.#manager.runtime.idle();
    await this.#manager.synced();
    return new CharmController(this.#manager, charm);
  }

  // Why is `CharmManager.get` async but `getCharms` sync?
  async get(charmId: string): Promise<CharmController> {
    const cell = await this.#manager.get(charmId);
    if (!cell) {
      throw new Error(`Charm "${charmId}" not found.`);
    }
    return new CharmController(this.#manager, cell);
  }

  getAllCharms() {
    const charms = this.#manager.getCharms().get();
    return charms.map((charm) => new CharmController(this.#manager, charm));
  }
}
