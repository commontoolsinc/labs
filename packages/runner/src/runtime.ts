import type { Signer } from "@commontools/identity";
import type {
  JSONSchema,
  Module,
  NodeFactory,
  Recipe,
  RecipeEnvironment,
  Schema,
} from "@commontools/builder";
import {
  ContextualFlowControl,
  setRecipeEnvironment,
} from "@commontools/builder";

import type {
  IStorageManager,
  IStorageProvider,
  MemorySpace,
} from "./storage/interface.ts";

export type { IStorageManager, IStorageProvider, MemorySpace };
import type { Cell, CellLink } from "./cell.ts";
import type { DocImpl } from "./doc.ts";
import { isDoc } from "./doc.ts";
import { type EntityId, getEntityId } from "./doc-map.ts";
import type { Cancel } from "./cancel.ts";
import type { Action, EventHandler, ReactivityLog } from "./scheduler.ts";
import type { Harness } from "./harness/harness.ts";
import { UnsafeEvalHarness } from "./harness/index.ts";
import { ConsoleMethod } from "./harness/console.ts";

export type ErrorWithContext = Error & {
  action: Action;
  charmId: string;
  space: MemorySpace;
  recipeId: string;
};

export type ConsoleHandler = (
  metadata: { charmId?: string; recipeId?: string; space?: string } | undefined,
  method: ConsoleMethod,
  args: any[],
) => any[];
export type ErrorHandler = (error: ErrorWithContext) => void;

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
  debug?: boolean;
}

export interface IRuntime {
  readonly id: string;
  readonly scheduler: IScheduler;
  readonly storage: IStorage;
  readonly recipeManager: IRecipeManager;
  readonly moduleRegistry: IModuleRegistry;
  readonly documentMap: IDocumentMap;
  readonly harness: Harness;
  readonly runner: IRunner;
  readonly blobbyServerUrl: string;
  readonly cfc: ContextualFlowControl;

  idle(): Promise<void>;
  dispose(): Promise<void>;

  // Cell factory methods
  getCell<T>(
    space: MemorySpace,
    cause: any,
    schema?: JSONSchema,
    log?: ReactivityLog,
  ): Cell<T>;
  getCell<S extends JSONSchema = JSONSchema>(
    space: MemorySpace,
    cause: any,
    schema: S,
    log?: ReactivityLog,
  ): Cell<Schema<S>>;
  getCellFromEntityId<T>(
    space: MemorySpace,
    entityId: EntityId,
    path?: PropertyKey[],
    schema?: JSONSchema,
    log?: ReactivityLog,
  ): Cell<T>;
  getCellFromEntityId<S extends JSONSchema = JSONSchema>(
    space: MemorySpace,
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
    space: MemorySpace,
    data: T,
    schema?: JSONSchema,
    log?: ReactivityLog,
  ): Cell<T>;
  getImmutableCell<S extends JSONSchema = JSONSchema>(
    space: MemorySpace,
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
  syncCell<T = any>(
    cell: DocImpl<T> | Cell<any>,
    expectedInStorage?: boolean,
    schemaContext?: any,
  ): Promise<DocImpl<T>> | DocImpl<T>;
  synced(): Promise<void>;
  cancelAll(): Promise<void>;
}

export interface IRecipeManager {
  readonly runtime: IRuntime;
  recipeById(id: string): any;
  generateRecipeId(recipe: any, src?: string): string;
  loadRecipe(id: string, space?: string): Promise<any>;
  getRecipeMeta(input: any): any;
  registerRecipe(
    params: {
      recipeId: string;
      space: MemorySpace;
      recipe: Recipe | Module;
      recipeMeta: any;
    },
  ): Promise<boolean>;
  publishToBlobby(recipeId: string): Promise<void>;
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
    createIfNotFound?: boolean,
    sourceIfCreated?: DocImpl<any>,
  ): DocImpl<T> | undefined;
  registerDoc<T>(entityId: EntityId, doc: DocImpl<T>, space: MemorySpace): void;
  getDoc<T>(value: T, cause: any, space: MemorySpace): DocImpl<T>;
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
}

import { Scheduler } from "./scheduler.ts";
import { Storage } from "./storage.ts";
import { RecipeManager } from "./recipe-manager.ts";
import { ModuleRegistry } from "./module.ts";
import { DocumentMap } from "./doc-map.ts";
import { Runner } from "./runner.ts";
import { registerBuiltins } from "./builtins/index.ts";

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
  readonly harness: Harness;
  readonly runner: IRunner;
  readonly blobbyServerUrl: string;
  readonly cfc: ContextualFlowControl;

  constructor(options: RuntimeOptions) {
    // Create harness first (no dependencies on other services)
    this.harness = new UnsafeEvalHarness(this);
    this.id = options.storageManager.id;

    // Create core services with dependencies injected
    this.scheduler = new Scheduler(
      this,
      options.consoleHandler,
      options.errorHandlers,
    );

    if (!options.blobbyServerUrl) {
      throw new Error("blobbyServerUrl is required");
    }

    this.storage = new Storage(this, options.storageManager);

    this.documentMap = new DocumentMap(this);
    this.moduleRegistry = new ModuleRegistry(this);
    this.recipeManager = new RecipeManager(this);
    this.runner = new Runner(this);
    this.cfc = new ContextualFlowControl();

    // Register built-in modules with runtime injection
    registerBuiltins(this);

    // Set this runtime as the current runtime for global cell compatibility
    // Removed setCurrentRuntime call - no longer using singleton pattern

    // The blobby server URL would be used by recipe manager for publishing
    this.blobbyServerUrl = new URL(
      "/api/storage/blobby",
      options.blobbyServerUrl,
    ).toString();

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

  // Cell factory methods
  getCell<T>(
    space: MemorySpace,
    cause: any,
    schema?: JSONSchema,
    log?: ReactivityLog,
  ): Cell<T>;
  getCell<S extends JSONSchema = JSONSchema>(
    space: MemorySpace,
    cause: any,
    schema: S,
    log?: ReactivityLog,
  ): Cell<Schema<S>>;
  getCell(
    space: MemorySpace,
    cause: any,
    schema?: JSONSchema,
    log?: ReactivityLog,
  ): Cell<any> {
    const doc = this.documentMap.getDoc<any>(undefined as any, cause, space);
    // Use doc.asCell method to avoid circular dependency
    return doc.asCell([], log, schema);
  }

  getCellFromEntityId<T>(
    space: MemorySpace,
    entityId: EntityId | string,
    path?: PropertyKey[],
    schema?: JSONSchema,
    log?: ReactivityLog,
  ): Cell<T>;
  getCellFromEntityId<S extends JSONSchema = JSONSchema>(
    space: MemorySpace,
    entityId: EntityId | string,
    path: PropertyKey[],
    schema: S,
    log?: ReactivityLog,
  ): Cell<Schema<S>>;
  getCellFromEntityId(
    space: MemorySpace,
    entityId: EntityId | string,
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
        cellLink.space as MemorySpace,
        getEntityId(cellLink.cell)!,
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
    space: MemorySpace,
    data: T,
    schema?: JSONSchema,
    log?: ReactivityLog,
  ): Cell<T>;
  getImmutableCell<S extends JSONSchema = JSONSchema>(
    space: MemorySpace,
    data: any,
    schema: S,
    log?: ReactivityLog,
  ): Cell<Schema<S>>;
  getImmutableCell(
    space: MemorySpace,
    data: any,
    schema?: JSONSchema,
    log?: ReactivityLog,
  ): Cell<any> {
    const doc = this.documentMap.getDoc<any>(data, { immutable: data }, space);
    doc.freeze("immutable cell");
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
