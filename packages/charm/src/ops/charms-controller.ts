import {
  type JSONSchema,
  Runtime,
  RuntimeProgram,
  type Schema,
} from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache";
import { CharmManager } from "../index.ts";
import { CharmController } from "./charm-controller.ts";
import { compileProgram } from "./utils.ts";
import { ANYONE, Identity } from "@commontools/identity";

export interface CreateCharmOptions {
  input?: object;
  start?: boolean;
}

export class CharmsController<T = unknown> {
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
    options: CreateCharmOptions = {},
  ): Promise<CharmController<T>> {
    this.disposeCheck();
    const recipe = await compileProgram(this.#manager, program);
    const charm = await this.#manager.runPersistent<T>(
      recipe,
      options.input,
      undefined,
      undefined,
      { start: options.start ?? true },
    );
    await this.#manager.runtime.idle();
    await this.#manager.synced();
    return new CharmController<T>(this.#manager, charm);
  }

  async get<S extends JSONSchema = JSONSchema>(
    charmId: string,
    schema: S,
  ): Promise<CharmController<Schema<S>>>;
  async get<T = unknown>(
    charmId: string,
    schema?: JSONSchema,
  ): Promise<CharmController<T>>;
  async get(charmId: string, schema?: JSONSchema): Promise<CharmController> {
    this.disposeCheck();
    const cell = await this.#manager.get(charmId, false, schema);
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

  async start(charmId: string): Promise<void> {
    this.disposeCheck();
    await this.#manager.startCharm(charmId);
  }

  async stop(charmId: string): Promise<void> {
    this.disposeCheck();
    await this.#manager.stopCharm(charmId);
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

  static async initialize({ apiUrl, identity, spaceName }: {
    apiUrl: URL;
    identity: Identity;
    spaceName: string;
  }): Promise<CharmsController> {
    const account = spaceName.startsWith("~")
      ? identity
      : await Identity.fromPassphrase(ANYONE);
    const user = await account.derive(spaceName);
    const session = {
      private: account.did() === identity.did(),
      name: spaceName,
      space: user.did(),
      as: user,
    };

    const runtime = new Runtime({
      storageManager: StorageManager.open({
        as: session.as,
        address: new URL("/api/storage/memory", apiUrl),
      }),
      blobbyServerUrl: apiUrl.toString(),
    });

    const manager = new CharmManager(session, runtime);
    await manager.synced();
    return new CharmsController(manager);
  }
}
