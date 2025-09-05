import { StaticCache } from "@commontools/static";
import { RuntimeTelemetry } from "@commontools/runner";
import type {
  JSONSchema,
  Module,
  NodeFactory,
  Recipe,
  Schema,
} from "./builder/types.ts";
import type { RecipeEnvironment } from "./builder/env.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { setRecipeEnvironment } from "./builder/env.ts";
import type {
  IExtendedStorageTransaction,
  IStorageManager,
  IStorageProvider,
  IStorageSubscriptionCapability,
  MemorySpace,
} from "./storage/interface.ts";
import { type Cell, createCell } from "./cell.ts";
import { createRef, type EntityId } from "./create-ref.ts";
import type { Cancel } from "./cancel.ts";
import {
  type Action,
  type EventHandler,
  type ReactivityLog,
  Scheduler,
} from "./scheduler.ts";
import type { RuntimeProgram } from "./harness/types.ts";
import { Engine } from "./harness/index.ts";
import { ConsoleMethod } from "./harness/console.ts";
import {
  type CellLink,
  isLink,
  isNormalizedFullLink,
  type NormalizedFullLink,
  type NormalizedLink,
  parseLink,
} from "./link-utils.ts";
import { RecipeManager, RecipeMeta } from "./recipe-manager.ts";
import { ModuleRegistry } from "./module.ts";
import { Runner } from "./runner.ts";
import { registerBuiltins } from "./builtins/index.ts";
import { ExtendedStorageTransaction } from "./storage/extended-storage-transaction.ts";
import { toURI } from "./uri-utils.ts";

// @ts-ignore - This is temporary to debug integration test
Error.stackTraceLimit = 500;

export const DEFAULT_MAX_RETRIES = 5;

export type { IExtendedStorageTransaction, IStorageProvider, MemorySpace };

export type ErrorWithContext = Error & {
  action: Action;
  charmId: string;
  space: MemorySpace;
  recipeId: string;
  spellId: string | undefined;
};

export type ConsoleHandler = (
  metadata: { charmId?: string; recipeId?: string; space?: string } | undefined,
  method: ConsoleMethod,
  args: any[],
) => any[];
export type ErrorHandler = (error: ErrorWithContext) => void;

export type NavigateCallback = (target: Cell<any>) => void;

export interface CharmMetadata {
  name?: string;
  description?: string;
  version?: string;
  [key: string]: any;
}

export interface RuntimeOptions {
  storageManager: IStorageManager;
  consoleHandler?: ConsoleHandler;
  errorHandlers?: ErrorHandler[];
  blobbyServerUrl: string;
  recipeEnvironment?: RecipeEnvironment;
  navigateCallback?: NavigateCallback;
  staticAssetServerUrl?: URL;
  debug?: boolean;
  telemetry?: RuntimeTelemetry;
}

export interface IRuntime {
  readonly id: string;
  readonly scheduler: IScheduler;
  readonly recipeManager: IRecipeManager;
  readonly moduleRegistry: IModuleRegistry;
  readonly harness: Engine;
  readonly runner: IRunner;
  readonly blobbyServerUrl: string;
  readonly navigateCallback?: NavigateCallback;
  readonly cfc: ContextualFlowControl;
  readonly staticCache: StaticCache;
  readonly storageManager: IStorageManager;
  readonly telemetry: RuntimeTelemetry;

  idle(): Promise<void>;
  dispose(): Promise<void>;

  // Storage transaction method
  edit(): IExtendedStorageTransaction;
  editWithRetry(
    fn: (tx: IExtendedStorageTransaction) => void,
    maxRetries?: number,
  ): Promise<boolean>;
  readTx(tx?: IExtendedStorageTransaction): IExtendedStorageTransaction;

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

  getCellFromEntityId<S extends JSONSchema = JSONSchema>(
    space: MemorySpace,
    entityId: EntityId,
    path: PropertyKey[],
    schema: S,
    tx?: IExtendedStorageTransaction,
  ): Cell<Schema<S>>;
  getCellFromEntityId<T>(
    space: MemorySpace,
    entityId: EntityId,
    path?: PropertyKey[],
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<T>;

  getCellFromLink<S extends JSONSchema = JSONSchema>(
    cellLink: CellLink | NormalizedLink,
    schema: S,
    tx?: IExtendedStorageTransaction,
  ): Cell<Schema<S>>;
  getCellFromLink<T>(
    cellLink: CellLink | NormalizedLink,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<T>;

  getImmutableCell<S extends JSONSchema = JSONSchema>(
    space: MemorySpace,
    data: any,
    schema: S,
    tx?: IExtendedStorageTransaction,
  ): Cell<Schema<S>>;
  getImmutableCell<T>(
    space: MemorySpace,
    data: T,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<T>;

  // Convenience methods that delegate to the runner
  setup<T, R>(
    tx: IExtendedStorageTransaction,
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
  run<T, R>(
    tx: IExtendedStorageTransaction,
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
  runSynced(
    resultCell: Cell<any>,
    recipe: Recipe | Module,
    inputs?: any,
  ): any;
  start<T = any>(resultCell: Cell<T>): void;
}

export interface IScheduler {
  readonly runtime: IRuntime;
  idle(): Promise<void>;
  subscribe(
    action: Action,
    log: ReactivityLog,
    scheduleImmediately?: boolean,
  ): Cancel;
  unsubscribe(action: Action): void;
  onConsole(fn: ConsoleHandler): void;
  onError(fn: ErrorHandler): void;
  queueEvent(eventRef: NormalizedFullLink, event: any): void;
  addEventHandler(handler: EventHandler, ref: NormalizedFullLink): Cancel;
  runningPromise: Promise<unknown> | undefined;
}

export interface IRecipeManager {
  readonly runtime: IRuntime;
  recipeById(id: string): any;
  registerRecipe(recipe: any, src?: string | RuntimeProgram): string;
  loadRecipe(
    id: string,
    space?: MemorySpace,
    tx?: IExtendedStorageTransaction,
  ): Promise<Recipe>;
  compileRecipe(input: string | RuntimeProgram): Promise<Recipe>;
  loadRecipeMeta(recipeId: string, space: MemorySpace): Promise<RecipeMeta>;
  getRecipeMeta(input: any): RecipeMeta;
  saveRecipe(
    params: {
      recipeId: string;
      space: MemorySpace;
    },
    tx?: IExtendedStorageTransaction,
  ): boolean;
  saveAndSyncRecipe(
    params: {
      recipeId: string;
      space: MemorySpace;
    },
    tx?: IExtendedStorageTransaction,
  ): Promise<void>;
  setRecipeMetaFields(recipeId: string, fields: Partial<RecipeMeta>): void;
}

export interface IModuleRegistry {
  readonly runtime: IRuntime;
  addModuleByRef(ref: string, module: Module): void;
  getModule(ref: string): Module;
  clear(): void;
}

export interface IRunner {
  readonly runtime: IRuntime;

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

  runSynced(
    resultCell: Cell<any>,
    recipe: Recipe | Module,
    inputs?: any,
  ): any;
  start<T = any>(resultCell: Cell<T>): void;
  stop<T>(resultCell: Cell<T>): void;
  stopAll(): void;
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
 *   remoteStorageUrl: 'https://storage.example.com',
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
export class Runtime implements IRuntime {
  readonly id: string;
  readonly scheduler: IScheduler;
  readonly recipeManager: IRecipeManager;
  readonly moduleRegistry: IModuleRegistry;
  readonly harness: Engine;
  readonly runner: IRunner;
  readonly blobbyServerUrl: string;
  readonly navigateCallback?: NavigateCallback;
  readonly cfc: ContextualFlowControl;
  readonly staticCache: StaticCache;
  readonly storageManager: IStorageManager;
  readonly telemetry: RuntimeTelemetry;

  constructor(options: RuntimeOptions) {
    this.id = options.storageManager.id;
    this.staticCache = options.staticAssetServerUrl
      ? new StaticCache({
        baseUrl: options.staticAssetServerUrl,
      })
      : new StaticCache();
    this.telemetry = options.telemetry ?? new RuntimeTelemetry();

    // Create harness first (no dependencies on other services)
    this.harness = new Engine(this);

    if (!options.blobbyServerUrl) {
      throw new Error("blobbyServerUrl is required");
    }

    this.storageManager = options.storageManager;
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

    // The blobby server URL would be used by recipe manager for publishing
    this.blobbyServerUrl = new URL(
      "/api/storage/blobby",
      options.blobbyServerUrl,
    ).toString();

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

    // Clear the current runtime reference
    // Removed setCurrentRuntime call - no longer using singleton pattern
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
  editWithRetry(
    fn: (tx: IExtendedStorageTransaction) => void,
    maxRetries: number = DEFAULT_MAX_RETRIES,
  ): Promise<boolean> {
    const tx = this.edit();
    fn(tx);
    return tx.commit().then(({ error }) => {
      if (error) {
        if (maxRetries > 0) {
          return this.editWithRetry(fn, maxRetries - 1);
        }
        return false;
      }
      return true;
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
  getCellFromEntityId<T>(
    space: MemorySpace,
    entityId: EntityId | string,
    path?: PropertyKey[],
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<T>;
  getCellFromEntityId<S extends JSONSchema = JSONSchema>(
    space: MemorySpace,
    entityId: EntityId | string,
    path: PropertyKey[],
    schema: S,
    tx?: IExtendedStorageTransaction,
  ): Cell<Schema<S>>;
  getCellFromEntityId(
    space: MemorySpace,
    entityId: EntityId | string,
    path: PropertyKey[] = [],
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
    cellLink: CellLink | NormalizedLink,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<T>;
  getCellFromLink<S extends JSONSchema = JSONSchema>(
    cellLink: CellLink | NormalizedLink,
    schema: S,
    tx?: IExtendedStorageTransaction,
  ): Cell<Schema<S>>;
  getCellFromLink(
    cellLink: CellLink | NormalizedLink,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<any> {
    let link = isLink(cellLink)
      ? parseLink(cellLink)
      : isNormalizedFullLink(cellLink)
      ? cellLink
      : undefined;
    if (!link) throw new Error("Invalid cell link");
    if (schema) link = { ...link, schema, rootSchema: schema };
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
}
