import { isDeno } from "@commontools/utils/env";
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
  StorageNotification,
} from "./storage/interface.ts";
import { type Cell, createCell } from "./cell.ts";
import type { DocImpl } from "./doc.ts";
import { DocumentMap, type EntityId } from "./doc-map.ts";
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
import { ShimStorageManager } from "./storage/transaction-shim.ts";
import {
  type CellLink,
  isLink,
  isNormalizedFullLink,
  type NormalizedFullLink,
  type NormalizedLink,
  parseLink,
} from "./link-utils.ts";
import { Storage } from "./storage.ts";
import { RecipeManager, RecipeMeta } from "./recipe-manager.ts";
import { ModuleRegistry } from "./module.ts";
import { Runner } from "./runner.ts";
import { registerBuiltins } from "./builtins/index.ts";
import { StaticCache } from "@commontools/static";
import { RuntimeTelemetry } from "@commontools/runner";

const DEFAULT_USE_REAL_TRANSACTIONS = isDeno()
  ? ["1", "true", "on", "yes"].includes(Deno.env.get("USE_REAL_TRANSACTIONS")!)
  : false;

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
  /**
   * When true, uses the StorageManager's native transaction API instead of the
   * transaction shim. This allows for better integration with the underlying
   * storage system's transaction capabilities.
   * @default false
   */
  useStorageManagerTransactions?: boolean;
  telemetry?: RuntimeTelemetry;
}

export interface IRuntime {
  readonly id: string;
  readonly scheduler: IScheduler;
  readonly storage: IStorage;
  readonly recipeManager: IRecipeManager;
  readonly moduleRegistry: IModuleRegistry;
  readonly documentMap: IDocumentMap;
  readonly harness: Engine;
  readonly runner: IRunner;
  readonly blobbyServerUrl: string;
  readonly navigateCallback?: NavigateCallback;
  readonly cfc: ContextualFlowControl;
  readonly staticCache: StaticCache;
  readonly useStorageManagerTransactions?: boolean;
  readonly storageManager: IStorageManager;
  readonly shimStorageManager?: ShimStorageManager;
  readonly telemetry: RuntimeTelemetry;

  idle(): Promise<void>;
  dispose(): Promise<void>;

  // Storage transaction method
  edit(): IExtendedStorageTransaction;
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
}

export interface IScheduler {
  readonly runtime: IRuntime;
  idle(): Promise<void>;
  schedule(action: Action, log: ReactivityLog): Cancel;
  subscribe(action: Action, log: ReactivityLog): Cancel;
  run(action: Action): Promise<any>;
  unschedule(action: Action): void;
  onConsole(fn: ConsoleHandler): void;
  onError(fn: ErrorHandler): void;
  queueEvent(eventRef: NormalizedFullLink, event: any): void;
  addEventHandler(handler: EventHandler, ref: NormalizedFullLink): Cancel;
  runningPromise: Promise<unknown> | undefined;
}

export interface IStorage extends IStorageSubscriptionCapability {
  readonly runtime: IRuntime;
  edit(): IExtendedStorageTransaction;

  syncCell<T = any>(
    cell: Cell<any>,
    expectedInStorage?: boolean,
    schemaContext?: any,
  ): Promise<Cell<T>> | Cell<T>;
  synced(): Promise<void>;
  cancelAll(): Promise<void>;

  shim: boolean;
  shimNotifySubscribers(notification: StorageNotification): void;
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
  getRecipeMeta(input: any): RecipeMeta;
  saveRecipe(
    params: {
      recipeId: string;
      space: MemorySpace;
      recipe?: Recipe | Module;
      recipeMeta?: RecipeMeta;
    },
    tx?: IExtendedStorageTransaction,
  ): boolean;
  saveAndSyncRecipe(
    params: {
      recipeId: string;
      space: MemorySpace;
      recipe?: Recipe | Module;
      recipeMeta?: RecipeMeta;
    },
    tx?: IExtendedStorageTransaction,
  ): Promise<void>;
}

export interface IModuleRegistry {
  readonly runtime: IRuntime;
  addModuleByRef(ref: string, module: Module): void;
  getModule(ref: string): Module;
  clear(): void;
}

export interface IDocumentMap {
  readonly runtime: IRuntime;
  getDocByEntityId<T = any>(
    space: MemorySpace,
    entityId: EntityId | string,
    createIfNotFound?: true,
    sourceIfCreated?: DocImpl<any>,
  ): DocImpl<T>;
  getDocByEntityId<T = any>(
    space: MemorySpace,
    entityId: EntityId | string,
    createIfNotFound: false,
    sourceIfCreated?: DocImpl<any>,
  ): DocImpl<T> | undefined;
  registerDoc<T>(entityId: EntityId, doc: DocImpl<T>, space: MemorySpace): void;
  getDoc<T>(value: T, cause: any, space: MemorySpace): DocImpl<T>;
  cleanup(): void;
}

export interface IRunner {
  readonly runtime: IRuntime;

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
  stop<T>(resultCell: DocImpl<T> | Cell<T>): void;
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
  readonly storage: IStorage;
  readonly recipeManager: IRecipeManager;
  readonly moduleRegistry: IModuleRegistry;
  readonly documentMap: IDocumentMap;
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

    this.storage = new Storage(
      this,
      options.storageManager,
      options.useStorageManagerTransactions ?? DEFAULT_USE_REAL_TRANSACTIONS,
    );

    this.documentMap = new DocumentMap(this);
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
        storage: !!this.storage,
        recipeManager: !!this.recipeManager,
        moduleRegistry: !!this.moduleRegistry,
        documentMap: !!this.documentMap,
        harness: !!this.harness,
        runner: !!this.runner,
        useStorageManagerTransactions: !!this.storage.shim,
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

    // Clean up document map
    this.documentMap.cleanup();

    // Clear module registry
    this.moduleRegistry.clear();

    // Cancel all storage operations
    await this.storage.cancelAll();

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
    return this.storage.edit();
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
    const doc = this.documentMap.getDoc<any>(undefined as any, cause, space);
    // Use doc.asCell method to avoid circular dependency
    return doc.asCell([], schema, undefined, tx);
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
    const doc = this.documentMap.getDocByEntityId(space, entityId, true)!;
    return doc.asCell(path, schema, undefined, tx);
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
  ): DocImpl<R> | Cell<R> {
    return this.runner.run<T, R>(tx, recipeOrModule, argument, resultCell);
  }

  runSynced(
    resultCell: Cell<any>,
    recipe: Recipe | Module,
    inputs?: any,
  ) {
    return this.runner.runSynced(resultCell, recipe, inputs);
  }
}
