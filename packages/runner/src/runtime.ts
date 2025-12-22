import {
  StaticCache,
  StaticCacheFS,
  StaticCacheHTTP,
} from "@commontools/static";
import { RuntimeTelemetry } from "@commontools/runner";
import type {
  AnyCell,
  JSONSchema,
  Module,
  NodeFactory,
  Recipe,
  Schema,
} from "./builder/types.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { RecipeEnvironment, setRecipeEnvironment } from "./builder/env.ts";
import type {
  CommitError,
  DID,
  IExtendedStorageTransaction,
  IStorageManager,
  IStorageProvider,
  MemorySpace,
} from "./storage/interface.ts";
import { type Cell, createCell } from "./cell.ts";
import { createRef, EntityId } from "./create-ref.ts";
import { Action, Scheduler } from "./scheduler.ts";
import { Engine } from "./harness/index.ts";
import {
  CellLink,
  isCellLink,
  isNormalizedFullLink,
  type NormalizedFullLink,
  NormalizedLink,
  parseLink,
} from "./link-utils.ts";
import { RecipeManager } from "./recipe-manager.ts";
import { ModuleRegistry } from "./module.ts";
import { Runner } from "./runner.ts";
import { registerBuiltins } from "./builtins/index.ts";
import { ExtendedStorageTransaction } from "./storage/extended-storage-transaction.ts";
import { toURI } from "./uri-utils.ts";
import { isDeno } from "@commontools/utils/env";
import { popFrame, pushFrame } from "./builder/recipe.ts";
import type { Frame } from "./builder/types.ts";
import type { ConsoleMessage } from "./interface.ts";

// @ts-ignore - This is temporary to debug integration test
Error.stackTraceLimit = 500;

export const DEFAULT_MAX_RETRIES = 5;

export type { IExtendedStorageTransaction, IStorageProvider, MemorySpace };

export type ConsoleHandler = (
  message: ConsoleMessage,
) => any[];

export type ErrorWithContext = Error & {
  action: Action;
  charmId: string;
  space: MemorySpace;
  recipeId: string;
  spellId: string | undefined;
};

export type ErrorHandler = (error: ErrorWithContext) => void;
export type NavigateCallback = (target: Cell<any>) => void;

export interface RuntimeOptions {
  apiUrl: URL;
  storageManager: IStorageManager;
  consoleHandler?: ConsoleHandler;
  errorHandlers?: ErrorHandler[];
  recipeEnvironment?: RecipeEnvironment;
  navigateCallback?: NavigateCallback;
  debug?: boolean;
  telemetry?: RuntimeTelemetry;
}

export const spaceCellSchema: JSONSchema = {
  type: "object",
  properties: {
    allCharms: {
      type: "array",
      items: { not: true, asCell: true },
    },
    recentCharms: {
      type: "array",
      items: { not: true, asCell: true },
    },
    defaultPattern: { not: true, asCell: true },
  },
} as JSONSchema;

export const homeSpaceCellSchema: JSONSchema = {
  type: "object",
  properties: {
    // Include all space cell properties
    allCharms: {
      type: "array",
      items: { not: true, asCell: true },
    },
    recentCharms: {
      type: "array",
      items: { not: true, asCell: true },
    },
    defaultPattern: { not: true, asCell: true },
    // Plus home-space-specific properties
    favorites: {
      type: "array",
      items: {
        type: "object",
        properties: {
          cell: { not: true, asCell: true },
          tag: { type: "string", default: "" },
        },
        required: ["cell"],
      },
      asCell: true,
    },
    journal: {
      type: "array",
      items: {
        type: "object",
        properties: {
          timestamp: { type: "number" },
          eventType: { type: "string" },
          subject: { not: true, asCell: true },
          snapshot: {
            type: "object",
            properties: {
              name: { type: "string", default: "" },
              schemaTag: { type: "string", default: "" },
              valueExcerpt: { type: "string", default: "" },
            },
          },
          narrative: { type: "string", default: "" },
          tags: { type: "array", items: { type: "string" }, default: [] },
          space: { type: "string" },
        },
        required: ["timestamp", "eventType", "space"],
      },
      default: [],
      asCell: true,
    },
  },
} as JSONSchema;

export interface SpaceCellContents {
  allCharms: Cell<unknown[]>;
  recentCharms: Cell<unknown[]>;
  defaultPattern: Cell<unknown>;
}

/**
 * Contents of the home space cell (where space DID = user identity DID).
 * Home space contains user-specific data like favorites that persists across all spaces.
 * See docs/common/HOME_SPACE.md for more details.
 */
export interface HomeSpaceCellContents extends SpaceCellContents {
  favorites: Cell<{ cell: Cell<unknown>; tag: string }[]>;
  journal: Cell<{
    timestamp: number;
    eventType: string;
    subject?: Cell<unknown>;
    snapshot?: { name?: string; schemaTag?: string; valueExcerpt?: string };
    narrative?: string;
    tags?: string[];
    space: string;
  }[]>;
}

/**
 * Main Runtime class that orchestrates all services in the runner package.
 *
 * This class eliminates the singleton pattern by providing a single entry point
 * for creating and managing all runner services with proper dependency injection.
 *
 * Usage:
 * ```typescript
 * const runtime = new Runtime({
 *   apiUrl: 'https://storage.example.com',
 *   consoleHandler: customConsoleHandler,
 *   errorHandlers: [customErrorHandler]
 * });
 *
 * // Access services through the runtime instance
 * await runtime.storage.loadCell(cellLink);
 * await runtime.scheduler.idle();
 * const recipe = await runtime.recipeManager.compileRecipe(source);
 * ```
 */
export class Runtime {
  readonly id: string;
  readonly scheduler: Scheduler;
  readonly recipeManager: RecipeManager;
  readonly moduleRegistry: ModuleRegistry;
  readonly harness: Engine;
  readonly runner: Runner;
  readonly navigateCallback?: NavigateCallback;
  readonly cfc: ContextualFlowControl;
  readonly staticCache: StaticCache;
  readonly storageManager: IStorageManager;
  readonly telemetry: RuntimeTelemetry;
  readonly apiUrl: URL;
  readonly userIdentityDID: DID;
  private defaultFrame?: Frame;

  constructor(options: RuntimeOptions) {
    this.id = options.storageManager.id;
    this.apiUrl = new URL(options.apiUrl);
    this.staticCache = isDeno()
      ? new StaticCacheFS()
      : new StaticCacheHTTP(new URL("/static", this.apiUrl));

    this.telemetry = options.telemetry ?? new RuntimeTelemetry();

    // Create harness first (no dependencies on other services)
    this.harness = new Engine(this);

    this.storageManager = options.storageManager;
    this.userIdentityDID = options.storageManager.as.did() as DID;
    this.moduleRegistry = new ModuleRegistry(this);
    this.recipeManager = new RecipeManager(this);
    this.runner = new Runner(this);
    this.cfc = new ContextualFlowControl();

    // Create core services with dependencies injected
    this.scheduler = new Scheduler(
      this,
      options.consoleHandler,
      options.errorHandlers,
    );

    // Register built-in modules with runtime injection
    registerBuiltins(this);

    // Set this runtime as the current runtime for global cell compatibility
    // Removed setCurrentRuntime call - no longer using singleton pattern

    // Set the navigate callback
    this.navigateCallback = options.navigateCallback;

    // Handle recipe environment configuration
    if (options.recipeEnvironment) {
      // This is still a singleton. TODO(seefeld): Fix this.
      setRecipeEnvironment(options.recipeEnvironment);
    }

    if (options.debug) {
      console.log("Runtime initialized with services:", {
        scheduler: !!this.scheduler,
        storageManager: !!this.storageManager,
        recipeManager: !!this.recipeManager,
        moduleRegistry: !!this.moduleRegistry,
        harness: !!this.harness,
        runner: !!this.runner,
        telemetry: !!this.telemetry,
      });
    }

    // Push a default frame with this runtime so builder functions can access it
    this.defaultFrame = pushFrame({ runtime: this });
  }

  /**
   * Wait for all pending operations to complete
   */
  idle(): Promise<void> {
    return this.scheduler.idle();
  }

  /**
   * Clean up resources and cancel all operations
   */
  async dispose(): Promise<void> {
    // Stop all running docs
    this.runner.stopAll();

    // Clear module registry
    this.moduleRegistry.clear();

    // Cancel all storage operations
    await this.storageManager.close();

    // Wait for any pending operations
    await this.scheduler.idle();

    // Pop the default frame
    if (this.defaultFrame) {
      popFrame(this.defaultFrame);
      this.defaultFrame = undefined;
    }

    // Clear the current runtime reference
    // Removed setCurrentRuntime call - no longer using singleton pattern
  }

  async [Symbol.asyncDispose]() {
    await this.dispose();
  }

  /**
   * Creates a storage transaction that can be used to read / write data into
   * locally replicated memory spaces. Transaction allows reading from many
   * multiple spaces but writing only to one space.
   */
  edit(): IExtendedStorageTransaction {
    return new ExtendedStorageTransaction(this.storageManager.edit());
  }

  /**
   * Creates a storage transaction that can be used to read / write data into
   * locally replicated memory spaces. Transaction allows reading from many
   * multiple spaces but writing only to one space.
   *
   * If the transaction fails, it will be retried up to maxRetries times.
   *
   * @param fn - Function to execute with the transaction.
   * @param maxRetries - Maximum number of retries.
   * @returns Promise<boolean> that resolves to true on success, or false after exhausting retries.
   */
  editWithRetry<T = void>(
    fn: (tx: IExtendedStorageTransaction) => T,
    maxRetries: number = DEFAULT_MAX_RETRIES,
  ): Promise<
    { ok: T; error?: undefined } | { ok?: undefined; error: CommitError }
  > {
    const tx = this.edit();
    const result = fn(tx);
    return tx.commit().then(({ error }) => {
      if (error) {
        if (maxRetries > 0) {
          return this.editWithRetry<T>(fn, maxRetries - 1);
        } else {
          return { error };
        }
      }
      return { ok: result };
    });
  }

  /**
   * Returns the given transaction if it is ready, otherwise creates a new
   * transaction.
   */
  readTx(tx?: IExtendedStorageTransaction): IExtendedStorageTransaction {
    return tx?.status().status === "ready" ? tx : this.edit();
  }

  // Cell factory methods
  getCell<S extends JSONSchema = JSONSchema>(
    space: MemorySpace,
    cause: any,
    schema: S,
    tx?: IExtendedStorageTransaction,
  ): Cell<Schema<S>>;
  getCell<T>(
    space: MemorySpace,
    cause: any,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<T>;
  getCell(
    space: MemorySpace,
    cause: any,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<any> {
    return this.getCellFromLink(
      {
        id: toURI(createRef({}, cause)),
        path: [],
        space,
        type: "application/json",
      },
      schema,
      tx,
    );
  }

  // Cell factory methods
  getSpaceCell<T = SpaceCellContents>(
    space: MemorySpace,
    schema?: undefined,
    tx?: IExtendedStorageTransaction,
  ): Cell<T>;
  getSpaceCell<S extends JSONSchema = JSONSchema>(
    space: MemorySpace,
    schema: S,
    tx?: IExtendedStorageTransaction,
  ): Cell<Schema<S>>;
  getSpaceCell<T>(
    space: MemorySpace,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<T>;
  getSpaceCell(
    space: MemorySpace,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<any> {
    return this.getCell(
      space,
      space, // Use space DID as cause
      schema ?? spaceCellSchema,
      tx,
    );
  }

  getCellFromEntityId<T>(
    space: MemorySpace,
    entityId: EntityId | string,
    path?: readonly PropertyKey[],
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<T>;
  getCellFromEntityId<S extends JSONSchema = JSONSchema>(
    space: MemorySpace,
    entityId: EntityId | string,
    path: readonly PropertyKey[],
    schema: S,
    tx?: IExtendedStorageTransaction,
  ): Cell<Schema<S>>;
  getCellFromEntityId(
    space: MemorySpace,
    entityId: EntityId | string,
    path: readonly PropertyKey[] = [],
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<any> {
    return this.getCellFromLink(
      {
        id: toURI(entityId),
        path: path?.map(String) ?? [],
        space,
        type: "application/json",
      },
      schema,
      tx,
    );
  }

  getCellFromLink<T>(
    cellLink: CellLink | NormalizedLink | AnyCell<unknown>,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<T>;
  getCellFromLink<S extends JSONSchema = JSONSchema>(
    cellLink: CellLink | NormalizedLink | AnyCell<unknown>,
    schema: S,
    tx?: IExtendedStorageTransaction,
  ): Cell<Schema<S>>;
  getCellFromLink(
    cellLink: CellLink | NormalizedLink | AnyCell<unknown>,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<any> {
    let link = isCellLink(cellLink)
      ? parseLink(cellLink)
      : isNormalizedFullLink(cellLink)
      ? cellLink
      : undefined;
    if (!link) throw new Error("Invalid cell link");
    if (schema !== undefined) link = { ...link, schema, rootSchema: schema };
    return createCell(this, link as NormalizedFullLink, tx);
  }

  getImmutableCell<T>(
    space: MemorySpace,
    data: T,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<T>;
  getImmutableCell<S extends JSONSchema = JSONSchema>(
    space: MemorySpace,
    data: any,
    schema: S,
    tx?: IExtendedStorageTransaction,
  ): Cell<Schema<S>>;
  getImmutableCell(
    space: MemorySpace,
    data: any,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<any> {
    const asDataURI = `data:application/json,${
      encodeURIComponent(JSON.stringify({ value: data }))
    }` as const as `${string}:${string}`;
    return createCell(this, {
      space,
      path: [],
      id: asDataURI,
      type: "application/json",
      schema,
    }, tx);
  }

  getHomeSpaceCell(
    tx?: IExtendedStorageTransaction,
  ): Cell<HomeSpaceCellContents> {
    return this.getCell(
      this.userIdentityDID,
      this.userIdentityDID,
      homeSpaceCellSchema,
      tx,
    ) as Cell<HomeSpaceCellContents>;
  }

  // Convenience methods that delegate to the runner
  setup<T, R>(
    tx: IExtendedStorageTransaction | undefined,
    recipeFactory: NodeFactory<T, R>,
    argument: T,
    resultCell: Cell<R>,
  ): Promise<Cell<R>>;
  setup<T, R = any>(
    tx: IExtendedStorageTransaction | undefined,
    recipe: Recipe | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
  ): Promise<Cell<R>>;
  setup<T, R = any>(
    tx: IExtendedStorageTransaction | undefined,
    recipeOrModule: Recipe | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
  ): Promise<Cell<R>> {
    return this.runner.setup<T, R>(tx, recipeOrModule, argument, resultCell);
  }
  run<T, R>(
    tx: IExtendedStorageTransaction | undefined,
    recipeFactory: NodeFactory<T, R>,
    argument: T,
    resultCell: Cell<R>,
  ): Cell<R>;
  run<T, R = any>(
    tx: IExtendedStorageTransaction | undefined,
    recipe: Recipe | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
  ): Cell<R>;
  run<T, R = any>(
    tx: IExtendedStorageTransaction | undefined,
    recipeOrModule: Recipe | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
  ): Cell<R> {
    return this.runner.run<T, R>(tx, recipeOrModule, argument, resultCell);
  }

  runSynced(
    resultCell: Cell<any>,
    recipe: Recipe | Module,
    inputs?: any,
  ) {
    return this.runner.runSynced(resultCell, recipe, inputs);
  }

  start<T = any>(resultCell: Cell<T>): void {
    return this.runner.start(resultCell);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(new URL("/_health", this.apiUrl));
      return res.ok;
    } catch (_) {
      return false;
    }
  }
}
