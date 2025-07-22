import { RuntimeProgram } from "@commontools/runner";
import { CharmManager } from "../index.ts";
import { CharmController } from "./charm-controller.ts";
import { compileProgram } from "./utils.ts";

export class CharmsController {
  #manager: CharmManager;
  #disposed = false;

  constructor(manager: CharmManager) {
    this.#manager = manager;
  }

  manager(): CharmManager {
    this.disposeCheck();
    return this.#manager;
  }

  async create(
    program: RuntimeProgram | string,
    input?: object,
  ): Promise<CharmController> {
    this.disposeCheck();
    const recipe = await compileProgram(this.#manager, program);
    const charm = await this.#manager.runPersistent(recipe, input);
    await this.#manager.runtime.idle();
    await this.#manager.synced();
    return new CharmController(this.#manager, charm);
  }

  // Why is `CharmManager.get` async but `getCharms` sync?
  async get(charmId: string): Promise<CharmController> {
    this.disposeCheck();
    const cell = await this.#manager.get(charmId);
    if (!cell) {
      throw new Error(`Charm "${charmId}" not found.`);
    }
    return new CharmController(this.#manager, cell);
  }

  getAllCharms() {
    this.disposeCheck();
    const charms = this.#manager.getCharms().get();
    return charms.map((charm) => new CharmController(this.#manager, charm));
  }

  async remove(charmId: string): Promise<boolean> {
    this.disposeCheck();
    const removed = await this.#manager.remove(charmId);
    // Empty trash and ensure full synchronization
    if (removed) {
      await this.#manager.emptyTrash();
      await this.#manager.runtime.idle();
      await this.#manager.synced();
    }
    return removed;
  }

  async dispose() {
    this.disposeCheck();
    this.#disposed = true;
    await this.#manager.runtime.dispose();
  }

  private disposeCheck() {
    if (this.#disposed) {
      throw new Error("CharmsController has been disposed.");
    }
  }
}
