// Import types from various modules
import type { Signer } from "@commontools/identity";
import type { StorageProvider } from "./storage/base.ts";
import type { Cell, CellLink } from "./cell.ts";
import type { DocImpl } from "./doc.ts";
import { isDoc } from "./doc.ts";
import type { EntityId } from "./doc-map.ts";
import type { Cancel } from "./cancel.ts";
import type { Action, EventHandler, ReactivityLog } from "./scheduler.ts";
import type { Harness } from "./harness/harness.ts";
import { UnsafeEvalHarness } from "./harness/eval-harness.ts";
import type {
  JSONSchema,
  Module,
  NodeFactory,
  Recipe,
  Schema,
} from "@commontools/builder";
import { isBrowser, isDeno } from "@commontools/utils/env";

// Interface definitions that were previously in separate files

export type ErrorWithContext = Error & {
  action: Action;
  charmId: string;
  space: string;
  recipeId: string;
};

import type { ConsoleEvent } from "./harness/console.ts";
import { ConsoleMethod } from "./harness/console.ts";
export type ConsoleHandler = (
  metadata: { charmId?: string; recipeId?: string; space?: string } | undefined,
  method: ConsoleMethod,
  args: any[],
) => any[];
export type ErrorHandler = (error: ErrorWithContext) => void;

// ConsoleEvent and ConsoleMethod are now imported from harness/console.ts
export type { ConsoleEvent } from "./harness/console.ts";
export { ConsoleMethod } from "./harness/console.ts";

export interface CharmMetadata {
  name?: string;
  description?: string;
  version?: string;
  [key: string]: any;
}

export interface RuntimeOptions {
  storageUrl: string;
  signer?: Signer;
  enableCache?: boolean;
  consoleHandler?: ConsoleHandler;
  errorHandlers?: ErrorHandler[];
  blobbyServerUrl?: string;
  recipeEnvironment?: string;
  debug?: boolean;
}

export interface IRuntime {
  readonly scheduler: IScheduler;
  readonly storage: IStorage;
  readonly recipeManager: IRecipeManager;
  readonly moduleRegistry: IModuleRegistry;
  readonly documentMap: IDocumentMap;
  readonly harness: Harness;
  readonly runner: IRunner;
  idle(): Promise<void>;
  dispose(): Promise<void>;

  // Cell factory methods
  getCell<T>(
    space: string,
    cause: any,
    schema?: JSONSchema,
    log?: ReactivityLog,
  ): Cell<T>;
  getCell<S extends JSONSchema = JSONSchema>(
    space: string,
    cause: any,
    schema: S,
    log?: ReactivityLog,
  ): Cell<Schema<S>>;
  getCellFromEntityId<T>(
    space: string,
    entityId: EntityId,
    path?: PropertyKey[],
    schema?: JSONSchema,
    log?: ReactivityLog,
  ): Cell<T>;
  getCellFromEntityId<S extends JSONSchema = JSONSchema>(
    space: string,
    entityId: EntityId,
    path: PropertyKey[],
    schema: S,
    log?: ReactivityLog,
  ): Cell<Schema<S>>;
  getCellFromLink<T>(
    cellLink: CellLink,
    schema?: JSONSchema,
    log?: ReactivityLog,
  ): Cell<T>;
  getCellFromLink<S extends JSONSchema = JSONSchema>(
    cellLink: CellLink,
    schema: S,
    log?: ReactivityLog,
  ): Cell<Schema<S>>;
  getImmutableCell<T>(
    space: string,
    data: T,
    schema?: JSONSchema,
    log?: ReactivityLog,
  ): Cell<T>;
  getImmutableCell<S extends JSONSchema = JSONSchema>(
    space: string,
    data: any,
    schema: S,
    log?: ReactivityLog,
  ): Cell<Schema<S>>;

  // Convenience methods that delegate to the runner
  run<T, R>(
    recipeFactory: NodeFactory<T, R>,
    argument: T,
    resultCell: DocImpl<R>,
  ): DocImpl<R>;
  run<T, R = any>(
    recipe: Recipe | Module | undefined,
    argument: T,
    resultCell: DocImpl<R>,
  ): DocImpl<R>;
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
  queueEvent(eventRef: CellLink, event: any): void;
  addEventHandler(handler: EventHandler, ref: CellLink): Cancel;
  runningPromise: Promise<unknown> | undefined;
}

export interface IStorage {
  readonly runtime: IRuntime;
  readonly id: string;
  syncCell<T = any>(
    cell: DocImpl<T> | Cell<any>,
    expectedInStorage?: boolean,
    schemaContext?: any,
  ): Promise<DocImpl<T>> | DocImpl<T>;
  syncCellById<T>(
    space: string,
    id: EntityId | string,
    expectedInStorage?: boolean,
  ): Promise<DocImpl<T>> | DocImpl<T>;
  synced(): Promise<void>;
  cancelAll(): Promise<void>;
  setSigner(signer: Signer): void;
}

export interface IRecipeManager {
  readonly runtime: IRuntime;
  compileRecipe(source: string, space?: string): Promise<any>;
  recipeById(id: string): any;
  generateRecipeId(recipe: any, src?: string): string;
  loadRecipe(id: string, space?: string): Promise<any>;
  getRecipeMeta(input: any): any;
  registerRecipe(
    params: { recipeId: string; space: string; recipe: any; recipeMeta: any },
  ): Promise<boolean>;
}

export interface IModuleRegistry {
  readonly runtime: IRuntime;
  register(name: string, module: any): void;
  get(name: string): any;
  clear(): void;
  addModuleByRef(ref: string, module: any): void;
  getModule(ref: string): any;
}

export interface IDocumentMap {
  readonly runtime: IRuntime;
  getDocByEntityId<T = any>(
    space: string,
    entityId: EntityId | string,
    createIfNotFound?: boolean,
    sourceIfCreated?: DocImpl<any>,
  ): DocImpl<T> | undefined;
  registerDoc<T>(entityId: EntityId, doc: DocImpl<T>, space: string): void;
  createRef(
    source?: Record<string | number | symbol, any>,
    cause?: any,
  ): EntityId;
  getEntityId(value: any): EntityId | undefined;
  getDoc<T>(value: T, cause: any, space: string): DocImpl<T>;
  cleanup(): void;
}

export interface IRunner {
  readonly runtime: IRuntime;

  run<T, R>(
    recipeFactory: NodeFactory<T, R>,
    argument: T,
    resultCell: DocImpl<R>,
  ): DocImpl<R>;
  run<T, R = any>(
    recipe: Recipe | Module | undefined,
    argument: T,
    resultCell: DocImpl<R>,
  ): DocImpl<R>;

  runSynced(
    resultCell: Cell<any>,
    recipe: Recipe | Module,
    inputs?: any,
  ): any;
  stop<T>(resultCell: DocImpl<T>): void;
  stopAll(): void;
  isRunning<T>(doc: DocImpl<T>): boolean;
  listRunningDocs(): DocImpl<any>[];
}

import { Scheduler } from "./scheduler.ts";
import { Storage } from "./storage.ts";
import { RecipeManager } from "./recipe-manager.ts";
import { ModuleRegistry } from "./module.ts";
import { DocumentMap } from "./doc-map.ts";
import { Runner } from "./runner.ts";
import { VolatileStorageProvider } from "./storage/volatile.ts";
import { registerBuiltins } from "./builtins/index.ts";
// Removed setCurrentRuntime import - no longer using singleton pattern

/**
 * Main Runtime class that orchestrates all services in the runner package.
 *
 * This class eliminates the singleton pattern by providing a single entry point
 * for creating and managing all runner services with proper dependency injection.
 *
 * Usage:
 * ```typescript
 * const runtime = new Runtime({
 *   remoteStorageUrl: new URL('https://storage.example.com'),
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
  readonly scheduler: IScheduler;
  readonly storage: IStorage;
  readonly recipeManager: IRecipeManager;
  readonly moduleRegistry: IModuleRegistry;
  readonly documentMap: IDocumentMap;
  readonly harness: Harness;
  readonly runner: IRunner;

  constructor(options: RuntimeOptions) {
    // Create harness first (no dependencies on other services)
    this.harness = new UnsafeEvalHarness(this);

    // Create core services with dependencies injected
    this.scheduler = new Scheduler(
      this,
      options.consoleHandler,
      options.errorHandlers,
    );

    this.storage = new Storage(this, {
      remoteStorageUrl: new URL(options.storageUrl),
      signer: options.signer,
      enableCache: options.enableCache ?? true,
      id: crypto.randomUUID(),
    });

    this.documentMap = new DocumentMap(this);
    this.moduleRegistry = new ModuleRegistry(this);
    this.recipeManager = new RecipeManager(this);
    this.runner = new Runner(this);

    // Register built-in modules with runtime injection
    registerBuiltins(this);

    // Set this runtime as the current runtime for global cell compatibility
    // Removed setCurrentRuntime call - no longer using singleton pattern

    // Handle blobby server URL configuration if provided
    if (options.blobbyServerUrl) {
      // The blobby server URL would be used by recipe manager for publishing
      // This is handled internally by the getBlobbyServerUrl() function
      this._setBlobbyServerUrl(options.blobbyServerUrl);
    }

    // Handle recipe environment configuration
    if (options.recipeEnvironment) {
      this._setRecipeEnvironment(options.recipeEnvironment);
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

  private _setBlobbyServerUrl(url: string): void {
    // This would need to integrate with the blobby storage configuration
    // For now, we'll store it for future use
    (globalThis as any).__BLOBBY_SERVER_URL = url;
  }

  private _setRecipeEnvironment(environment: string): void {
    // This would need to integrate with recipe environment configuration
    // For now, we'll store it for future use
    (globalThis as any).__RECIPE_ENVIRONMENT = environment;
  }

  private _getOptions(): RuntimeOptions {
    // Return current configuration for forking
    return {
      storageUrl: "volatile://external-compat",
      blobbyServerUrl: (globalThis as any).__BLOBBY_SERVER_URL,
      recipeEnvironment: (globalThis as any).__RECIPE_ENVIRONMENT,
      // Note: We can't easily extract other options like signer, handlers, etc.
      // This would need to be improved if forking with full config is needed
    };
  }

  // Cell factory methods
  getCell<T>(
    space: string,
    cause: any,
    schema?: JSONSchema,
    log?: ReactivityLog,
  ): Cell<T>;
  getCell<S extends JSONSchema = JSONSchema>(
    space: string,
    cause: any,
    schema: S,
    log?: ReactivityLog,
  ): Cell<Schema<S>>;
  getCell(
    space: string,
    cause: any,
    schema?: JSONSchema,
    log?: ReactivityLog,
  ): Cell<any> {
    const doc = this.documentMap.getDoc<any>(undefined as any, cause, space);
    // Use doc.asCell method to avoid circular dependency
    return doc.asCell([], log, schema);
  }

  getCellFromEntityId<T>(
    space: string,
    entityId: EntityId,
    path?: PropertyKey[],
    schema?: JSONSchema,
    log?: ReactivityLog,
  ): Cell<T>;
  getCellFromEntityId<S extends JSONSchema = JSONSchema>(
    space: string,
    entityId: EntityId,
    path: PropertyKey[],
    schema: S,
    log?: ReactivityLog,
  ): Cell<Schema<S>>;
  getCellFromEntityId(
    space: string,
    entityId: EntityId,
    path: PropertyKey[] = [],
    schema?: JSONSchema,
    log?: ReactivityLog,
  ): Cell<any> {
    const doc = this.documentMap.getDocByEntityId(space, entityId, true)!;
    return doc.asCell(path, log, schema);
  }

  getCellFromLink<T>(
    cellLink: CellLink,
    schema?: JSONSchema,
    log?: ReactivityLog,
  ): Cell<T>;
  getCellFromLink<S extends JSONSchema = JSONSchema>(
    cellLink: CellLink,
    schema: S,
    log?: ReactivityLog,
  ): Cell<Schema<S>>;
  getCellFromLink(
    cellLink: CellLink,
    schema?: JSONSchema,
    log?: ReactivityLog,
  ): Cell<any> {
    let doc;

    if (isDoc(cellLink.cell)) {
      doc = cellLink.cell;
    } else if (cellLink.space) {
      doc = this.documentMap.getDocByEntityId(
        cellLink.space,
        this.documentMap.getEntityId(cellLink.cell)!,
        true,
      )!;
      if (!doc) {
        throw new Error(`Can't find ${cellLink.space}/${cellLink.cell}!`);
      }
    } else {
      throw new Error("Cell link has no space");
    }
    // If we aren't passed a schema, use the one in the cellLink
    return doc.asCell(cellLink.path, log, schema ?? cellLink.schema);
  }

  getImmutableCell<T>(
    space: string,
    data: T,
    schema?: JSONSchema,
    log?: ReactivityLog,
  ): Cell<T>;
  getImmutableCell<S extends JSONSchema = JSONSchema>(
    space: string,
    data: any,
    schema: S,
    log?: ReactivityLog,
  ): Cell<Schema<S>>;
  getImmutableCell(
    space: string,
    data: any,
    schema?: JSONSchema,
    log?: ReactivityLog,
  ): Cell<any> {
    const doc = this.documentMap.getDoc<any>(data, { immutable: data }, space);
    doc.freeze();
    return doc.asCell([], log, schema);
  }

  // Convenience methods that delegate to the runner
  run<T, R>(
    recipeFactory: NodeFactory<T, R>,
    argument: T,
    resultCell: DocImpl<R>,
  ): DocImpl<R>;
  run<T, R = any>(
    recipe: Recipe | Module | undefined,
    argument: T,
    resultCell: DocImpl<R>,
  ): DocImpl<R>;
  run<T, R = any>(
    recipeOrModule: Recipe | Module | undefined,
    argument: T,
    resultCell: DocImpl<R>,
  ): DocImpl<R> {
    return this.runner.run(recipeOrModule, argument, resultCell);
  }

  runSynced(
    resultCell: Cell<any>,
    recipe: Recipe | Module,
    inputs?: any,
  ) {
    return this.runner.runSynced(resultCell, recipe, inputs);
  }
}
