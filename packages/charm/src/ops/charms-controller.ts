import {
  type JSONSchema,
  Runtime,
  RuntimeProgram,
  type Schema,
} from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache";
import { type NameSchema } from "@commontools/runner/schemas";
import { CharmManager } from "../index.ts";
import { CharmController } from "./charm-controller.ts";
import { compileProgram } from "./utils.ts";
import { createSession, Identity } from "@commontools/identity";
import { HttpProgramResolver } from "@commontools/js-compiler";
import { ACLManager } from "./acl-manager.ts";

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

  async create<U = T>(
    program: RuntimeProgram | string,
    options: CreateCharmOptions = {},
    cause: string | undefined = undefined,
  ): Promise<CharmController<U>> {
    this.disposeCheck();
    const recipe = await compileProgram(this.#manager, program);
    const charm = await this.#manager.runPersistent<U>(
      recipe,
      options.input,
      cause,
      undefined,
      { start: options.start ?? true },
    );
    await this.#manager.runtime.idle();
    await this.#manager.synced();
    return new CharmController<U>(this.#manager, charm);
  }

  async get<S extends JSONSchema = JSONSchema>(
    charmId: string,
    runIt: boolean,
    schema: S,
  ): Promise<CharmController<Schema<S>>>;
  async get<T = unknown>(
    charmId: string,
    runIt?: boolean,
    schema?: JSONSchema,
  ): Promise<CharmController<T>>;
  async get(
    charmId: string,
    runIt: boolean = false,
    schema?: JSONSchema,
  ): Promise<CharmController> {
    this.disposeCheck();
    const cell = await (await this.#manager.get(charmId, runIt, schema)).sync();
    return new CharmController(this.#manager, cell);
  }

  getAllCharms() {
    this.disposeCheck();
    const charms = this.#manager.getCharms().get();
    return charms.map((charm) => new CharmController(this.#manager, charm));
  }

  async remove(charmId: string): Promise<boolean> {
    this.disposeCheck();
    const charm = this.#manager.runtime.getCellFromEntityId(
      this.#manager.getSpace(),
      { "/": charmId },
    );
    const removed = await this.#manager.remove(charm);
    // Ensure full synchronization
    if (removed) {
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
    const session = await createSession({ identity, spaceName });
    const runtime = new Runtime({
      apiUrl: new URL(apiUrl),
      storageManager: StorageManager.open({
        as: session.as,
        address: new URL("/api/storage/memory", apiUrl),
        spaceIdentity: session.spaceIdentity,
      }),
    });

    const manager = new CharmManager(session, runtime);
    await manager.synced();
    return new CharmsController(manager);
  }

  acl(): ACLManager {
    return new ACLManager(this.#manager.runtime, this.#manager.getSpace());
  }

  /**
   * Ensures a default pattern exists for this space, creating it if necessary.
   * For home spaces, uses home.tsx; for other spaces, uses default-app.tsx.
   * This makes CLI-created spaces work the same as Shell-created spaces.
   *
   * @returns The default pattern charm, either existing or newly created
   */
  async ensureDefaultPattern(): Promise<CharmController<NameSchema>> {
    this.disposeCheck();

    // Check if default pattern already exists
    const existingPattern = await this.#manager.getDefaultPattern();
    if (existingPattern) {
      return new CharmController<NameSchema>(this.#manager, existingPattern);
    }

    // Determine which pattern to use based on space type
    const isHomeSpace =
      this.#manager.getSpace() === this.#manager.runtime.userIdentityDID;

    const patternConfig = isHomeSpace
      ? {
        name: "Home",
        urlPath: "/api/patterns/home.tsx",
        cause: "home-pattern",
      }
      : {
        name: "DefaultCharmList",
        urlPath: "/api/patterns/default-app.tsx",
        cause: "space-root",
      };

    // Construct the pattern URL from the API URL
    const patternUrl = new URL(
      patternConfig.urlPath,
      this.#manager.runtime.apiUrl,
    );

    try {
      // Load the pattern program from HTTP
      const program = await this.#manager.runtime.harness.resolve(
        new HttpProgramResolver(patternUrl.href),
      );

      // Create the pattern charm
      const charm = await this.create<NameSchema>(
        program,
        { start: true },
        patternConfig.cause,
      );

      // Link it as the default pattern in the space cell
      await this.#manager.linkDefaultPattern(charm.getCell());

      return charm;
    } catch (error) {
      throw new Error(
        `Failed to create default pattern from ${patternUrl.href}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
