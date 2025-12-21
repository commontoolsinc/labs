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

// Schema for mutex-based synchronization of default pattern creation
const defaultPatternMutexSchema = {
  type: "object",
  properties: {
    requestId: { type: "string", default: "" },
    lastActivity: { type: "number", default: 0 },
  },
  default: {},
  required: ["requestId", "lastActivity"],
} as const satisfies JSONSchema;

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
   * Uses a mutex pattern to prevent race conditions when multiple processes
   * attempt to create the default pattern simultaneously.
   *
   * @returns The default pattern charm, either existing or newly created
   */
  async ensureDefaultPattern(): Promise<CharmController<NameSchema>> {
    this.disposeCheck();

    const MUTEX_TIMEOUT = 10000; // 10 seconds for pattern creation
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 500;
    const requestId = crypto.randomUUID();

    // Get mutex cell in space for synchronization
    const mutexCell = this.#manager.runtime.getCell(
      this.#manager.getSpace(),
      { defaultPatternMutex: true },
      defaultPatternMutexSchema,
    );

    // Try to get existing pattern first (outside mutex)
    const existingPattern = await this.#manager.getDefaultPattern();
    if (existingPattern) {
      // Validate it's not a dangling reference to a deleted charm
      const charmEntityId = existingPattern.entityId;
      if (charmEntityId?.["/"] !== undefined) {
        try {
          // Try to verify the charm exists by getting it
          // getDefaultPattern already runs the charm, so if we got here it works
          return new CharmController<NameSchema>(
            this.#manager,
            existingPattern,
          );
        } catch {
          console.warn(
            `Default pattern points to deleted charm, will recreate`,
          );
          // Fall through to creation logic
        }
      }
    }

    // Attempt to claim mutex with retries
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      let claimed = false;

      await this.#manager.runtime.editWithRetry((tx) => {
        const mutex = mutexCell.withTx(tx).get();
        const now = Date.now();

        // Can claim if no one is processing or previous request timed out
        const canClaim = !mutex.requestId ||
          (mutex.lastActivity < now - MUTEX_TIMEOUT);

        if (canClaim) {
          mutexCell.withTx(tx).update({
            requestId,
            lastActivity: now,
          });
          claimed = true;
        }
      });

      // If we didn't claim, wait and check if someone else created the pattern
      if (!claimed) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        // Check if pattern was created while we waited
        const retryPattern = await this.#manager.getDefaultPattern();
        if (retryPattern) {
          return new CharmController<NameSchema>(this.#manager, retryPattern);
        }
        continue; // Try to claim again
      }

      // We have the mutex, now create the pattern
      try {
        // Double-check after claiming mutex (prevents duplicate creation)
        const doubleCheck = await this.#manager.getDefaultPattern();
        if (doubleCheck) {
          // Someone else created it, release mutex and return
          await this.#releaseMutex(mutexCell, requestId);
          return new CharmController<NameSchema>(this.#manager, doubleCheck);
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

        const patternUrl = new URL(
          patternConfig.urlPath,
          this.#manager.runtime.apiUrl,
        );

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

        // Release mutex on success
        await this.#releaseMutex(mutexCell, requestId);

        return charm;
      } catch (error) {
        // Release mutex on error
        await this.#releaseMutex(mutexCell, requestId);

        throw new Error(
          `Failed to create default pattern: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    throw new Error(
      "Failed to claim mutex for default pattern creation after maximum retries",
    );
  }

  /**
   * Releases the default pattern creation mutex.
   * Only releases if we still own the mutex (requestId matches).
   */
  async #releaseMutex(
    // deno-lint-ignore no-explicit-any
    mutexCell: any,
    ownRequestId: string,
  ): Promise<void> {
    await this.#manager.runtime.editWithRetry((tx) => {
      const mutex = mutexCell.withTx(tx).get();
      // Only release if we still own the mutex
      if (mutex.requestId === ownRequestId) {
        mutexCell.withTx(tx).update({
          requestId: "",
          lastActivity: 0,
        });
      }
    });
  }
}
