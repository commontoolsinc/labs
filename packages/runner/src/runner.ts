import { refer } from "merkle-reference/json";
import { getLogger } from "@commontools/utils/logger";
import { isObject, isRecord, type Mutable } from "@commontools/utils/types";
import { vdomSchema } from "@commontools/html";
import {
  isModule,
  isOpaqueRef,
  isRecipe,
  isStreamValue,
  type JSONSchema,
  type JSONValue,
  type Module,
  NAME,
  type NodeFactory,
  type Recipe,
  TYPE,
  UI,
  unsafe_materializeFactory,
  unsafe_originalRecipe,
  type UnsafeBinding,
} from "./builder/types.ts";
import {
  popFrame,
  pushFrameFromCause,
  recipeFromFrame,
} from "./builder/recipe.ts";
import { type Cell } from "./cell.ts";
import { type Action } from "./scheduler.ts";
import { diffAndUpdate } from "./data-updating.ts";
import {
  findAllWriteRedirectCells,
  unsafe_noteParentOnRecipes,
  unwrapOneLevelAndBindtoDoc,
} from "./recipe-binding.ts";
import { resolveLink } from "./link-resolution.ts";
import {
  areNormalizedLinksSame,
  createSigilLinkFromParsedLink,
  isLink,
  isWriteRedirectLink,
  type NormalizedFullLink,
  parseLink,
} from "./link-utils.ts";
import { deepEqual } from "./path-utils.ts";
import { sendValueToBinding } from "./recipe-binding.ts";
import { type AddCancel, type Cancel, useCancelGroup } from "./cancel.ts";
import { LINK_V1_TAG, SigilLink } from "./sigil-types.ts";
import type { IRunner, IRuntime } from "./runtime.ts";
import type {
  IExtendedStorageTransaction,
  IStorageSubscription,
  MemorySpace,
  URI,
} from "./storage/interface.ts";
import { ignoreReadForScheduling } from "./scheduler.ts";
import { FunctionCache } from "./function-cache.ts";
import "./builtins/index.ts";

const logger = getLogger("runner");

export class Runner implements IRunner {
  readonly cancels = new Map<`${MemorySpace}/${URI}`, Cancel>();
  private allCancels = new Set<Cancel>();
  private functionCache = new FunctionCache();
  // Map whose key is the result cell's full key, and whose values are the
  // recipes as strings
  private resultRecipeCache = new Map<`${MemorySpace}/${URI}`, string>();

  constructor(readonly runtime: IRuntime) {
    this.runtime.storageManager.subscribe(this.createStorageSubscription());
  }

  /**
   * Creates and returns a new storage subscription.
   *
   * This will be used to remove the cached recipe information when the result
   * cell changes. As a result, if we are scheduled, we will run that recipe
   * and regenerate the result.
   *
   * @returns A new IStorageSubscription instance
   */
  private createStorageSubscription(): IStorageSubscription {
    return {
      next: (notification) => {
        const space = notification.space;
        if ("changes" in notification) {
          for (const change of notification.changes) {
            this.resultRecipeCache.delete(`${space}/${change.address.id}`);
          }
        }
        return { done: false };
      },
    };
  }

  /**
   * Prepare a charm for running by creating/updating its process and result
   * cells, registering the recipe, and applying defaults/arguments.
   * This does not schedule any nodes. Use start() to schedule execution.
   */
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

  /**
   * Configure charm without running it. If the charm is already running and the
   * recipe changes, it will stop the charm.
   */
  setup<T, R = any>(
    providedTx: IExtendedStorageTransaction | undefined,
    recipeOrModule: Recipe | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
  ): Promise<Cell<R>> {
    if (providedTx) {
      this.setupInternal(providedTx, recipeOrModule, argument, resultCell);
      return Promise.resolve(resultCell);
    } else {
      // Ignore errors after retrying for now, as outside the tx, we'll see the
      // latest true value, it just lost the ract against someone else changing
      // the recipe or argument. Correct action is anyhow similar to what would
      // have happened if the write succeeded and was immediately overwritten.
      return this.runtime.editWithRetry((tx) => {
        this.setupInternal(tx, recipeOrModule, argument, resultCell);
      }).then(() => resultCell);
    }
  }

  /**
   * Internal setup that returns whether scheduling is required.
   */
  private setupInternal<T, R = any>(
    providedTx: IExtendedStorageTransaction | undefined,
    recipeOrModule: Recipe | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
  ): {
    resultCell: Cell<R>;
    recipe?: Recipe;
    processCell?: Cell<any>;
    needsStart: boolean;
  } {
    const tx = providedTx ?? this.runtime.edit();

    type ProcessCellData = {
      [TYPE]: string;
      spell?: SigilLink;
      argument?: T;
      internal?: JSONValue;
      resultRef: SigilLink;
    };

    let processCell: Cell<ProcessCellData>;

    const sourceCell = resultCell.withTx(tx).getSourceCell();
    if (sourceCell !== undefined) {
      processCell = sourceCell as Cell<ProcessCellData>;
    } else {
      processCell = this.runtime.getCell<ProcessCellData>(
        resultCell.space,
        resultCell, // Cause
        undefined,
        tx,
      );
      resultCell.withTx(tx).setSourceCell(processCell);
    }

    logger.debug(() => [
      `resultCell: ${resultCell.getAsNormalizedFullLink().id}`,
      `processCell: ${
        resultCell.withTx(tx).getSourceCell()?.getAsNormalizedFullLink().id
      }`,
    ]);

    let recipeId: string | undefined;

    const previousRecipeId = processCell.withTx(tx).key(TYPE).getRaw({
      meta: ignoreReadForScheduling,
    });

    if (!recipeOrModule && previousRecipeId) {
      recipeId = previousRecipeId;
      recipeOrModule = this.runtime.recipeManager.recipeById(recipeId!);
      if (!recipeOrModule) throw new Error(`Unknown recipe: ${recipeId}`);
    } else if (!recipeOrModule) {
      console.warn(
        "No recipe provided and no recipe found in process doc. Not running.",
      );
      return { resultCell, needsStart: false };
    }

    let recipe: Recipe;

    // If this is a module, not a recipe, wrap it in a recipe that just runs,
    // passing arguments in unmodified and passing all results through as is
    if (isModule(recipeOrModule)) {
      const module = recipeOrModule as Module;
      recipeId ??= this.runtime.recipeManager.registerRecipe(module);

      recipe = {
        argumentSchema: module.argumentSchema ?? {},
        resultSchema: module.resultSchema ?? {},
        result: { $alias: { path: ["internal"] } },
        nodes: [
          {
            module,
            inputs: { $alias: { path: ["argument"] } },
            outputs: { $alias: { path: ["internal"] } },
          },
        ],
      } satisfies Recipe;
    } else {
      recipe = recipeOrModule as Recipe;
    }

    recipeId ??= this.runtime.recipeManager.registerRecipe(recipe);
    this.runtime.recipeManager.saveRecipe({
      recipeId,
      space: resultCell.space,
    }, tx);

    // If the bindings are a cell, doc or doc link, convert them to an alias
    if (isLink(argument)) {
      argument = createSigilLinkFromParsedLink(
        parseLink(argument),
        { base: processCell, includeSchema: true, overwrite: "redirect" },
      ) as T;
    }

    const key = this.getDocKey(resultCell);
    const alreadyRunning = this.cancels.has(key);

    if (alreadyRunning) {
      // If it's already running and no new recipe or argument are given,
      // we are just returning the result doc
      if (argument === undefined && recipeId === previousRecipeId) {
        return { resultCell, needsStart: false };
      }

      if (previousRecipeId === recipeId) {
        // If the recipe is the same, but argument is different, just update the
        // argument without stopping
        diffAndUpdate(
          this.runtime,
          tx,
          processCell.key("argument").getAsNormalizedFullLink(),
          argument,
          processCell.getAsNormalizedFullLink(),
        );
        return { resultCell, needsStart: false };
      }

      // Otherwise stop execution of the old recipe.
      this.stop(resultCell);
    }

    // Walk the recipe's schema and extract all default values
    const defaults = extractDefaultValues(recipe.argumentSchema) as Partial<T>;

    // Important to use DeepCopy here, as the resulting object will be modified!
    const previousInternal = processCell.key("internal").getRaw({
      meta: ignoreReadForScheduling,
    });
    const internal: JSONValue = Object.assign(
      {},
      cellAwareDeepCopy(
        (defaults as unknown as { internal: JSONValue })?.internal,
      ),
      cellAwareDeepCopy(
        isRecord(recipe.initial) && isRecord(recipe.initial.internal)
          ? recipe.initial.internal
          : {},
      ),
      isRecord(previousInternal) ? previousInternal : {},
    );

    // Still necessary until we consistently use schema for defaults.
    // Only do it on first load.
    if (
      !processCell.key("argument").getRaw({ meta: ignoreReadForScheduling })
    ) {
      argument = mergeObjects<T>(argument as any, defaults);
    }

    processCell.withTx(tx).setRaw({
      ...processCell.getRaw({ meta: ignoreReadForScheduling }),
      [TYPE]: recipeId || "unknown",
      resultRef: resultCell.getAsLink({ base: processCell }),
      internal,
      ...(recipeId !== undefined) ? { spell: getSpellLink(recipeId) } : {},
    });
    if (argument) {
      diffAndUpdate(
        this.runtime,
        tx,
        processCell.key("argument").getAsNormalizedFullLink(),
        argument,
        processCell.getAsNormalizedFullLink(),
      );
    }

    // Send "query" to results to the result doc only on initial run or if
    // recipe changed. This preserves user modifications like renamed charms.
    let result = unwrapOneLevelAndBindtoDoc<R, any>(
      recipe.result as R,
      processCell,
    );
    const previousResult = resultCell.withTx(tx).getRaw({
      meta: ignoreReadForScheduling,
    });
    if (isRecord(previousResult) && previousResult[NAME]) {
      result = { ...result, [NAME]: previousResult[NAME] };
    }
    if (!deepEqual(result, previousResult)) {
      resultCell.withTx(tx).setRaw(result);
    }

    // [unsafe closures:] For recipes from closures, add a materialize factory
    if (recipe[unsafe_originalRecipe]) {
      recipe[unsafe_materializeFactory] =
        (tx: any) => (path: readonly PropertyKey[]) =>
          processCell.getAsQueryResult(path as PropertyKey[], tx);
    }

    // Discover and cache all JavaScript functions in the recipe before start
    this.discoverAndCacheFunctions(recipe);

    return { resultCell, recipe, processCell, needsStart: true };
  }

  /**
   * Start scheduling nodes for a previously set up charm.
   * If already started, this is a no-op.
   */
  start<T = any>(resultCell: Cell<T>): void {
    const tx = this.runtime.edit();
    try {
      this.startWithTx(tx, resultCell);
    } finally {
      // No writes expected; commit to release resources.
      tx.commit();
    }
  }

  private startWithTx<T = any>(
    tx: IExtendedStorageTransaction,
    resultCell: Cell<T>,
    givenRecipe?: Recipe,
  ): void {
    const key = this.getDocKey(resultCell);
    if (this.cancels.has(key)) return; // Already started

    const processCell = resultCell.withTx(tx).getSourceCell();
    if (!processCell) {
      console.warn("Cannot start: process cell missing. Did you call setup()?");
      return;
    }

    let recipe: Recipe | undefined = givenRecipe;
    if (!recipe) {
      const recipeId = processCell.withTx(tx).key(TYPE).getRaw({
        meta: ignoreReadForScheduling,
      });
      if (!recipeId) {
        console.warn("Cannot start: recipe id missing in process cell.");
        return;
      }
      const resolved = this.runtime.recipeManager.recipeById(recipeId);
      if (!resolved) throw new Error(`Unknown recipe: ${recipeId}`);
      if (isModule(resolved)) {
        const module = resolved as Module;
        recipe = {
          argumentSchema: module.argumentSchema ?? {},
          resultSchema: module.resultSchema ?? {},
          result: { $alias: { path: ["internal"] } },
          nodes: [
            {
              module,
              inputs: { $alias: { path: ["argument"] } },
              outputs: { $alias: { path: ["internal"] } },
            },
          ],
        } satisfies Recipe;
      } else {
        recipe = resolved as Recipe;
      }
    }

    // Keep track of subscriptions to cancel them later
    const [cancel, addCancel] = useCancelGroup();
    this.cancels.set(key, cancel);
    this.allCancels.add(cancel);

    // Re-discover functions to be safe (idempotent)
    this.discoverAndCacheFunctions(recipe);

    for (const node of recipe.nodes) {
      this.instantiateNode(
        tx,
        node.module,
        node.inputs,
        node.outputs,
        processCell,
        addCancel,
        recipe,
      );
    }
  }

  /**
   * Run a recipe.
   *
   * resultCell is required and should have an id. processCell is created if not
   * already set.
   *
   * If no recipe is provided, the previous one is used, and the recipe is
   * started if it isn't already started.
   *
   * If no argument is provided, the previous one is used, and the recipe is
   * started if it isn't already running.
   *
   * If a new recipe or any argument value is provided, a currently running
   * recipe is stopped, the recipe and argument replaced and the recipe
   * restarted.
   *
   * @param recipeFactory - Function that takes the argument and returns a
   * recipe.
   * @param argument - The argument to pass to the recipe. Can be static data
   * and/or cell references, including cell value proxies, docs and regular
   * cells.
   * @param resultCell - Cell to run the recipe off.
   * @returns The result cell.
   */
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
    providedTx: IExtendedStorageTransaction,
    recipeOrModule: Recipe | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
  ): Cell<R> {
    const tx = providedTx ?? this.runtime.edit();

    const { needsStart, recipe } = this.setupInternal(
      tx,
      recipeOrModule,
      argument,
      resultCell,
    );

    if (needsStart) {
      this.startWithTx(tx, resultCell, recipe);
    }

    if (!providedTx) tx.commit();

    return resultCell;
  }

  async runSynced(
    resultCell: Cell<any>,
    recipe: Recipe | Module,
    inputs?: any,
  ) {
    await resultCell.sync();

    const synced = await this.syncCellsForRunningRecipe(
      resultCell,
      recipe,
      inputs,
    );

    // Run the recipe.
    //
    // If the result cell has a transaction attached, and it is still open,
    // we'll use it for all reads and writes as it might be a pending read.
    //
    // TODO(seefeld): There is currently likely a race condition with the
    // scheduler if the transaction isn't committed before the first functions
    // run. Though most likely the worst case is just extra invocations.
    const givenTx = resultCell.tx?.status().status === "ready" && resultCell.tx;
    let setupRes: ReturnType<typeof this.setupInternal> | undefined;
    if (givenTx) {
      // If tx is given, i.e. result cell was part of a tx that is still open,
      // caller manages retries
      setupRes = this.setupInternal(
        givenTx,
        recipe,
        inputs,
        resultCell.withTx(givenTx),
      );
    } else {
      const error = await this.runtime.editWithRetry((tx) => {
        setupRes = this.setupInternal(
          tx,
          recipe,
          inputs,
          resultCell.withTx(tx),
        );
      });
      if (error) {
        logger.error("Error setting up recipe", error);
        setupRes = undefined;
      }
    }

    // If a new recipe was specified, make sure to sync any new cells
    if (recipe || !synced) {
      await this.syncCellsForRunningRecipe(resultCell, recipe);
    }

    if (setupRes?.needsStart) {
      const tx = givenTx || this.runtime.edit();
      this.startWithTx(tx, resultCell.withTx(tx), setupRes.recipe);
      if (!givenTx) {
        // Should be unnecessary as the start itself is read-only
        // TODO(seefeld): Enforce this by adding a read-only flag for tx
        await tx.commit().then(({ error }) => {
          if (error) {
            logger.error("Error committing transaction", error);
          }
        });
      }
    }

    return recipe?.resultSchema
      ? resultCell.asSchema(recipe.resultSchema)
      : resultCell;
  }

  private getDocKey(cell: Cell<any>): `${MemorySpace}/${URI}` {
    const { space, id } = cell.getAsNormalizedFullLink();
    return `${space}/${id}`;
  }

  private async syncCellsForRunningRecipe(
    resultCell: Cell<any>,
    recipe: Module | Recipe,
    inputs?: any,
  ): Promise<boolean> {
    const seen = new Set<Cell<any>>();
    const promises = new Set<Promise<any>>();

    const syncAllMentionedCells = (value: any) => {
      if (seen.has(value)) return;
      seen.add(value);

      const link = parseLink(value, resultCell);

      if (link) {
        const maybePromise = this.runtime.getCellFromLink(link).sync();
        if (maybePromise instanceof Promise) promises.add(maybePromise);
      } else if (isRecord(value)) {
        for (const key in value) syncAllMentionedCells(value[key]);
      }
    };

    syncAllMentionedCells(inputs);
    await Promise.all(promises);

    const sourceCell = resultCell.getSourceCell({
      type: "object",
      properties: {
        [TYPE]: { type: "string" },
        argument: recipe.argumentSchema ?? {},
      },
      required: [TYPE],
    });
    if (!sourceCell) return false;

    await sourceCell.sync();

    // We could support this by replicating what happens in runner, but since
    // we're calling this again when returning false, this is good enough for now.
    if (isModule(recipe)) return false;

    const cells: Cell<any>[] = [];

    // Sync all the inputs and outputs of the recipe nodes.
    for (const node of recipe.nodes) {
      const inputs = findAllWriteRedirectCells(node.inputs, sourceCell);
      const outputs = findAllWriteRedirectCells(node.outputs, sourceCell);

      // TODO(seefeld): This ignores schemas provided by modules, so it might
      // still fetch a lot.
      [...inputs, ...outputs].forEach((link) => {
        cells.push(this.runtime.getCellFromLink(link));
      });
    }

    // Sync all the previously computed results.
    if (recipe.resultSchema) {
      cells.push(resultCell.asSchema(recipe.resultSchema));
    }

    // If the result has a UI and it wasn't already included in the result
    // schema, sync it as well. This prevents the UI from flashing, because it's
    // first locally computed, then conflicts on write and only then properly
    // received from the server.
    if (
      isRecord(recipe.result) &&
      recipe.result[UI] &&
      (!isRecord(recipe.resultSchema) ||
        !recipe.resultSchema.properties?.[UI])
    ) {
      cells.push(resultCell.key(UI).asSchema(vdomSchema));
    }

    await Promise.all(cells.map((c) => c.sync()));

    return true;
  }

  /**
   * Stop a recipe. This will cancel the recipe and all its children.
   *
   * TODO: This isn't a good strategy, as other instances might depend on behavior
   * provided here, even if the user might no longer care about e.g. the UI here.
   * A better strategy would be to schedule based on effects and unregister the
   * effects driving execution, e.g. the UI.
   *
   * @param resultCell - The result doc or cell to stop.
   */
  stop<T>(resultCell: Cell<T>): void {
    const key = this.getDocKey(resultCell);
    this.cancels.get(key)?.();
    this.cancels.delete(key);
  }

  stopAll(): void {
    // Cancel all tracked operations
    for (const cancel of this.allCancels) {
      try {
        cancel();
      } catch (error) {
        console.warn("Error canceling operation:", error);
      }
    }
    this.allCancels.clear();
  }

  /**
   * Discover and cache JavaScript functions from a recipe.
   * This recursively traverses the recipe structure to find all JavaScript modules
   * with string implementations and evaluates them for caching.
   *
   * @param recipe The recipe to discover functions from
   */
  private discoverAndCacheFunctions(
    recipe: Recipe,
    seen: Set<object> = new Set(),
  ): void {
    if (seen.has(recipe)) return;
    seen.add(recipe);

    for (const node of recipe.nodes) {
      this.discoverAndCacheFunctionsFromModule(node.module, seen);

      // Also check inputs for nested recipes (e.g., in map operations)
      this.discoverAndCacheFunctionsFromValue(node.inputs, seen);
    }
  }

  /**
   * Discover and cache functions from a module.
   *
   * @param module The module to process
   */
  private discoverAndCacheFunctionsFromModule(
    module: Module,
    seen: Set<object>,
  ): void {
    if (seen.has(module)) return;
    seen.add(module);

    if (!isModule(module)) return;

    switch (module.type) {
      case "javascript":
        // Cache JavaScript functions that are already function objects
        if (
          typeof module.implementation === "function" &&
          !this.functionCache.has(module)
        ) {
          this.functionCache.set(module, module.implementation);
        }
        break;

      case "recipe":
        // Recursively discover functions in nested recipes
        if (isRecipe(module.implementation)) {
          this.discoverAndCacheFunctions(module.implementation, seen);
        }
        break;

      case "ref":
        // Resolve reference and process the referenced module
        try {
          const referencedModule = this.runtime.moduleRegistry.getModule(
            module.implementation as string,
          );
          this.discoverAndCacheFunctionsFromModule(referencedModule, seen);
        } catch (error) {
          console.warn(
            `Failed to resolve module reference for implementation "${module.implementation}":`,
            error,
          );
        }
        break;
    }
  }

  /**
   * Discover and cache functions from a value that might contain recipes.
   * This handles cases where recipes are passed as inputs (e.g., to map operations).
   *
   * @param value The value to search for recipes
   */
  private discoverAndCacheFunctionsFromValue(
    value: JSONValue,
    seen: Set<object>,
  ): void {
    if (!isRecord(value)) return;

    if (seen.has(value)) return;
    seen.add(value);

    if (isRecipe(value)) {
      this.discoverAndCacheFunctions(value, seen);
    } else if (isModule(value)) {
      this.discoverAndCacheFunctionsFromModule(value, seen);
    } else { // = isRecord(value)
      // Recursively search in objects and arrays
      if (Array.isArray(value)) {
        for (const item of value) {
          this.discoverAndCacheFunctionsFromValue(item, seen);
        }
      } else {
        for (const key in value) {
          this.discoverAndCacheFunctionsFromValue(
            value[key] as JSONValue,
            seen,
          );
        }
      }
    }
  }

  private instantiateNode(
    tx: IExtendedStorageTransaction,
    module: Module,
    inputBindings: JSONValue,
    outputBindings: JSONValue,
    processCell: Cell<any>,
    addCancel: AddCancel,
    recipe: Recipe,
  ) {
    if (isModule(module)) {
      switch (module.type) {
        case "ref":
          this.instantiateNode(
            tx,
            this.runtime.moduleRegistry.getModule(
              module.implementation as string,
            ),
            inputBindings,
            outputBindings,
            processCell,
            addCancel,
            recipe,
          );
          break;
        case "javascript":
          this.instantiateJavaScriptNode(
            tx,
            module,
            inputBindings,
            outputBindings,
            processCell,
            addCancel,
            recipe,
          );
          break;
        case "raw":
          this.instantiateRawNode(
            tx,
            module,
            inputBindings,
            outputBindings,
            processCell,
            addCancel,
            recipe,
          );
          break;
        case "passthrough":
          this.instantiatePassthroughNode(
            tx,
            module,
            inputBindings,
            outputBindings,
            processCell,
            addCancel,
            recipe,
          );
          break;
        case "recipe":
          this.instantiateRecipeNode(
            tx,
            module,
            inputBindings,
            outputBindings,
            processCell,
            addCancel,
            recipe,
          );
          break;
        default:
          throw new Error(`Unknown module type: ${module.type}`);
      }
    } else if (isWriteRedirectLink(module)) {
      // TODO(seefeld): Implement, a dynamic node
    } else {
      throw new Error(`Unknown module: ${JSON.stringify(module)}`);
    }
  }

  private instantiateJavaScriptNode(
    tx: IExtendedStorageTransaction,
    module: Module,
    inputBindings: JSONValue,
    outputBindings: JSONValue,
    processCell: Cell<any>,
    addCancel: AddCancel,
    recipe: Recipe,
  ) {
    const inputs = unwrapOneLevelAndBindtoDoc(
      inputBindings,
      processCell,
    );

    const reads = findAllWriteRedirectCells(inputs, processCell);

    const outputs = unwrapOneLevelAndBindtoDoc(outputBindings, processCell);
    const writes = findAllWriteRedirectCells(outputs, processCell);

    let fn: (inputs: any) => any;

    if (typeof module.implementation === "string") {
      // Try to get from cache first
      const cached = this.functionCache.get(module);
      if (cached) {
        fn = cached as (inputs: any) => any;
      } else {
        // Fall back to evaluating and cache it
        fn = this.runtime.harness.getInvocation(module.implementation) as (
          inputs: any,
        ) => any;
        this.functionCache.set(module, fn);
      }
    } else {
      fn = module.implementation as (inputs: any) => any;
    }

    if (module.wrapper && module.wrapper in moduleWrappers) {
      fn = moduleWrappers[module.wrapper](fn);
    }

    // Check if any of the read cells is a stream alias
    let streamLink: NormalizedFullLink | undefined = undefined;
    if (isRecord(inputs)) {
      for (const key in inputs) {
        let value = inputs[key];
        while (isWriteRedirectLink(value)) {
          const maybeStreamLink = resolveLink(
            tx,
            parseLink(value, processCell),
            "writeRedirect",
          );
          value = tx.readValueOrThrow(maybeStreamLink);
        }
        if (isStreamValue(value)) {
          streamLink = parseLink(inputs[key], processCell);
          break;
        }
      }
    }

    if (streamLink) {
      // Register as event handler for the stream
      const handler = (tx: IExtendedStorageTransaction, event: any) => {
        // TODO(seefeld): Scheduler has to create the transaction instead
        if (event.preventDefault) event.preventDefault();
        const eventInputs = { ...(inputs as Record<string, any>) };
        const cause = { ...(inputs as Record<string, any>) };
        for (const key in eventInputs) {
          if (isWriteRedirectLink(eventInputs[key])) {
            // Use format-agnostic comparison for links
            const eventLink = parseLink(eventInputs[key], processCell);

            if (areNormalizedLinksSame(eventLink, streamLink)) {
              eventInputs[key] = event;
              cause[key] = crypto.randomUUID();
            }
          }
        }

        const inputsCell = this.runtime.getImmutableCell(
          processCell.space,
          eventInputs,
          undefined,
          tx,
        );

        const frame = pushFrameFromCause(cause, {
          recipe,
          materialize: (path: readonly PropertyKey[]) =>
            processCell.getAsQueryResult(path),
          space: processCell.space,
          tx,
        });

        const argument = module.argumentSchema
          ? inputsCell.asSchema(module.argumentSchema).get()
          : inputsCell.getAsQueryResult([], tx);
        const result = fn(argument);

        const postRun = (result: any) => {
          if (containsOpaqueRef(result)) {
            const resultRecipe = recipeFromFrame(
              "event handler result",
              undefined,
              () => result,
            );

            const resultCell = this.run(
              tx,
              resultRecipe,
              undefined,
              this.runtime.getCell(
                processCell.space,
                { resultFor: cause },
                undefined,
                tx,
              ),
            );
            addCancel(() => this.stop(resultCell));
          }

          popFrame(frame);
          return result;
        };

        if (result instanceof Promise) {
          return result.then(postRun);
        } else {
          return postRun(result);
        }
      };

      const wrappedHandler = Object.assign(handler, {
        reads,
        writes,
        module,
        recipe,
      });
      addCancel(
        this.runtime.scheduler.addEventHandler(wrappedHandler, streamLink),
      );
    } else {
      if (isRecord(inputs) && "$event" in inputs) {
        throw new Error(
          "Handler used as lift, because $stream: true was overwritten",
        );
      }

      // Schedule the action to run when the inputs change
      const inputsCell = this.runtime.getImmutableCell(
        processCell.space,
        inputs,
        undefined,
        tx,
      );

      // Cache the result cell, so we don't regenerate it
      // This will break if we altered the process cell to point to a
      // different result, so don't do that.
      let previousResultCell: Cell<any> | undefined;

      const action: Action = (tx: IExtendedStorageTransaction) => {
        const argument = module.argumentSchema
          ? inputsCell.asSchema(module.argumentSchema).withTx(tx).get()
          : inputsCell.getAsQueryResult([], tx);

        const frame = pushFrameFromCause(
          { inputs, outputs, fn: fn.toString() },
          {
            recipe,
            materialize: (path: readonly PropertyKey[]) =>
              processCell.getAsQueryResult(path, tx),
            space: processCell.space,
            tx,
          } satisfies UnsafeBinding,
        );
        const result = fn(argument);

        const postRun = (result: any) => {
          if (containsOpaqueRef(result)) {
            const resultRecipe = recipeFromFrame(
              "action result",
              undefined,
              () => result,
            );
            const resultCell = previousResultCell ??
              this.runtime.getCell(
                processCell.space,
                { resultFor: { inputs, outputs, fn: fn.toString() } },
                undefined,
                tx,
              );

            // If nothing changed, don't rerun the recipe
            const resultRecipeAsString = JSON.stringify(resultRecipe);
            const previousResultRecipeAsString = this.resultRecipeCache.get(
              `${resultCell.space}/${resultCell.sourceURI}`,
            );
            if (previousResultRecipeAsString === resultRecipeAsString) return;
            this.resultRecipeCache.set(
              `${resultCell.space}/${resultCell.sourceURI}`,
              resultRecipeAsString,
            );

            this.run(
              tx,
              resultRecipe,
              undefined,
              resultCell,
            );
            addCancel(() => this.stop(resultCell));

            if (!previousResultCell) {
              previousResultCell = resultCell;
              sendValueToBinding(
                tx,
                processCell,
                outputs,
                resultCell.getAsLink({ base: processCell }),
              );
            }
          } else {
            sendValueToBinding(
              tx,
              processCell,
              outputs,
              result,
            );
          }

          popFrame(frame);
          return result;
        };

        if (result instanceof Promise) {
          return result.then(postRun);
        } else {
          return postRun(result);
        }
      };

      const wrappedAction = Object.assign(action, {
        reads,
        writes,
        module,
        recipe,
      });
      addCancel(
        this.runtime.scheduler.subscribe(
          wrappedAction,
          { reads, writes },
          true,
        ),
      );
    }
  }

  private instantiateRawNode(
    tx: IExtendedStorageTransaction,
    module: Module,
    inputBindings: JSONValue,
    outputBindings: JSONValue,
    processCell: Cell<any>,
    addCancel: AddCancel,
    recipe: Recipe,
  ) {
    if (typeof module.implementation !== "function") {
      throw new Error(
        `Raw module is not a function, got: ${module.implementation}`,
      );
    }

    const mappedInputBindings = unwrapOneLevelAndBindtoDoc(
      inputBindings,
      processCell,
    );
    const mappedOutputBindings = unwrapOneLevelAndBindtoDoc(
      outputBindings,
      processCell,
    );

    // For `map` and future other node types that take closures, we need to
    // note the parent recipe on the closure recipes.
    unsafe_noteParentOnRecipes(recipe, mappedInputBindings);

    const inputCells = findAllWriteRedirectCells(
      mappedInputBindings,
      processCell,
    );
    const outputCells = findAllWriteRedirectCells(
      mappedOutputBindings,
      processCell,
    );

    const inputsCell = this.runtime.getImmutableCell(
      processCell.space,
      mappedInputBindings,
      undefined,
      tx,
    );

    const action = module.implementation(
      inputsCell,
      (tx: IExtendedStorageTransaction, result: any) => {
        sendValueToBinding(
          tx,
          processCell,
          mappedOutputBindings,
          result,
        );
      },
      addCancel,
      { inputs: inputsCell, parents: processCell.entityId },
      processCell,
      this.runtime,
    );

    addCancel(
      this.runtime.scheduler.subscribe(
        action,
        { reads: inputCells, writes: outputCells },
        true,
      ),
    );
  }

  private instantiatePassthroughNode(
    tx: IExtendedStorageTransaction,
    module: Module,
    inputBindings: JSONValue,
    outputBindings: JSONValue,
    processCell: Cell<any>,
    addCancel: AddCancel,
    recipe: Recipe,
  ) {
    const inputs = unwrapOneLevelAndBindtoDoc(inputBindings, processCell);

    sendValueToBinding(tx, processCell, outputBindings, inputs);
  }

  private instantiateRecipeNode(
    tx: IExtendedStorageTransaction,
    module: Module,
    inputBindings: JSONValue,
    outputBindings: JSONValue,
    processCell: Cell<any>,
    addCancel: AddCancel,
    recipe: Recipe,
  ) {
    if (!isRecipe(module.implementation)) throw new Error(`Invalid recipe`);
    const recipeImpl = unwrapOneLevelAndBindtoDoc(
      module.implementation,
      processCell,
    );
    const inputs = unwrapOneLevelAndBindtoDoc(inputBindings, processCell);
    const resultCell = this.runtime.getCell(
      processCell.space,
      {
        recipe: module.implementation,
        parent: processCell.entityId,
        inputBindings,
        outputBindings,
      },
      undefined,
      tx,
    );
    this.run(tx, recipeImpl, inputs, resultCell);
    sendValueToBinding(
      tx,
      processCell,
      outputBindings,
      resultCell.getAsLink({ base: processCell }),
    );
    // TODO(seefeld): Make sure to not cancel after a recipe is elevated to a
    // charm, e.g. via navigateTo. Nothing is cancelling right now, so leaving
    // this as TODO.
    addCancel(this.cancels.get(this.getDocKey(resultCell.getSourceCell()!)));
  }
}

// This takes a recipe id and returns a sigil link with the corresponding entity.
function getSpellLink(recipeId: string): SigilLink {
  const id = refer({ causal: { recipeId, type: "recipe" } }).toJSON()["/"];
  return { "/": { [LINK_V1_TAG]: { id: `of:${id}` } } };
}

function containsOpaqueRef(value: unknown): boolean {
  if (isOpaqueRef(value)) return true;
  if (isLink(value)) return false;
  if (isRecord(value)) {
    return Object.values(value).some(containsOpaqueRef);
  }
  return false;
}

export function cellAwareDeepCopy<T = unknown>(value: T): Mutable<T> {
  if (isLink(value)) return value as Mutable<T>;
  if (isRecord(value)) {
    return Array.isArray(value)
      ? value.map(cellAwareDeepCopy) as unknown as Mutable<T>
      : Object.fromEntries(
        Object.entries(value).map((
          [key, value],
        ) => [key, cellAwareDeepCopy(value)]),
      ) as unknown as Mutable<T>;
    // Literal value:
  } else return value as Mutable<T>;
}

/**
 * Extracts default values from a JSON schema object.
 * @param schema - The JSON schema to extract defaults from
 * @returns An object containing the default values, or undefined if none found
 */
export function extractDefaultValues(
  schema: JSONSchema,
): JSONValue | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;

  if (
    schema.type === "object" && schema.properties && isObject(schema.properties)
  ) {
    // Ignore the schema.default if it's not an object, since it's not a valid
    // default value for an object.
    const obj = cellAwareDeepCopy(
      isRecord(schema.default) ? schema.default : {},
    );
    for (const [propKey, propSchema] of Object.entries(schema.properties)) {
      const value = extractDefaultValues(propSchema);
      if (value !== undefined) {
        (obj as Record<string, unknown>)[propKey] = value;
      }
    }

    return Object.entries(obj).length > 0 ? obj : undefined;
  }

  return schema.default;
}

/**
 * Merges objects into a single object, preferring values from later objects.
 * Recursively calls itself for nested objects, passing on any objects that
 * matching properties.
 * @param objects - Objects to merge
 * @returns A merged object, or undefined if no objects provided
 */
export function mergeObjects<T>(
  ...objects: (Partial<T> | undefined)[]
): T {
  objects = objects.filter((obj) => obj !== undefined);
  if (objects.length === 0) return {} as T;
  if (objects.length === 1) return objects[0] as T;

  const seen = new Set<PropertyKey>();
  const result: Record<string, unknown> = {};

  for (const obj of objects) {
    // If we have a literal value, return it. Same for arrays, since we wouldn't
    // know how to merge them. Note that earlier objects take precedence, so if
    // an earlier was e.g. an object, we'll return that instead of the literal.
    if (!isObject(obj) || isLink(obj)) {
      return obj as T;
    }

    // Then merge objects, only passing those on that have any values.
    for (const key of Object.keys(obj)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const merged = mergeObjects<T[keyof T]>(
        ...objects.map((obj) =>
          (obj as Record<string, unknown>)?.[key] as T[keyof T]
        ),
      );
      if (merged !== undefined) result[key] = merged;
    }
  }

  return result as T;
}

const moduleWrappers = {
  handler: (fn: (event: any, ...props: any[]) => any) => (props: any) =>
    fn(props.$event, props.$ctx),
};
