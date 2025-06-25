import { isObject, isRecord } from "@commontools/utils/types";
import {
  isModule,
  isOpaqueRef,
  isRecipe,
  isStreamValue,
  type JSONSchema,
  type JSONValue,
  type Module,
  type NodeFactory,
  type Recipe,
  TYPE,
  unsafe_materializeFactory,
  unsafe_originalRecipe,
  type UnsafeBinding,
} from "./builder/types.ts";
import {
  popFrame,
  pushFrameFromCause,
  recipeFromFrame,
} from "./builder/recipe.ts";
import { type DocImpl, isDoc } from "./doc.ts";
import { type Cell } from "./cell.ts";
import { type Action, type ReactivityLog } from "./scheduler.ts";
import { diffAndUpdate } from "./data-updating.ts";
import {
  findAllLegacyAliasedCells,
  unsafe_noteParentOnRecipes,
  unwrapOneLevelAndBindtoDoc,
} from "./recipe-binding.ts";
import { followWriteRedirects } from "./link-resolution.ts";
import {
  areLinksSame,
  isLink,
  isWriteRedirectLink,
  parseLink,
  parseToLegacyAlias,
} from "./link-utils.ts";
import { sendValueToBinding } from "./recipe-binding.ts";
import { type AddCancel, type Cancel, useCancelGroup } from "./cancel.ts";
import "./builtins/index.ts";
import { isCell } from "./cell.ts";
import { type LegacyCellLink } from "./sigil-types.ts";
import type { IRunner, IRuntime } from "./runtime.ts";

export class Runner implements IRunner {
  readonly cancels = new WeakMap<DocImpl<any>, Cancel>();
  private allCancels = new Set<Cancel>();

  constructor(readonly runtime: IRuntime) {}

  /**
   * Run a recipe.
   *
   * resultCell is required and should have an id. processCell is created if not
   * already set.
   *
   * If no recipe is provided, the previous one is used, and the recipe is started
   * if it isn't already started.
   *
   * If no argument is provided, the previous one is used, and the recipe is
   * started if it isn't already running.
   *
   * If a new recipe or any argument value is provided, a currently running recipe
   * is stopped, the recipe and argument replaced and the recipe restarted.
   *
   * @param recipeFactory - Function that takes the argument and returns a recipe.
   * @param argument - The argument to pass to the recipe. Can be static data
   * and/or cell references, including cell value proxies, docs and regular cells.
   * @param resultDoc - Doc to run the recipe off.
   * @returns The result cell.
   */
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
  run<T, R>(
    recipeFactory: NodeFactory<T, R>,
    argument: T,
    resultCell: Cell<R>,
  ): Cell<R>;
  run<T, R = any>(
    recipe: Recipe | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
  ): Cell<R>;
  run<T, R = any>(
    recipeOrModule: Recipe | Module | undefined,
    argument: T,
    resultCell: DocImpl<R> | Cell<R>,
  ): DocImpl<R> | Cell<R> {
    // Cell version delegates to DocImpl version
    if (isCell(resultCell)) {
      this.run(recipeOrModule, argument, resultCell.getDoc());
      return resultCell;
    }

    // Otherwise run existing DocImpl logic
    const resultDoc = resultCell as DocImpl<R>;

    let processCell: DocImpl<{
      [TYPE]: string;
      argument?: T;
      internal?: JSONValue;
      resultRef: { cell: DocImpl<R>; path: PropertyKey[] };
    }>;

    if (resultDoc.sourceCell !== undefined) {
      processCell = resultDoc.sourceCell;
    } else {
      processCell = this.runtime.documentMap.getDoc(
        undefined,
        { cell: resultDoc, path: [] },
        resultDoc.space,
      ) as any;
      resultDoc.sourceCell = processCell;
    }

    let recipeId: string | undefined;

    if (!recipeOrModule && processCell.get()?.[TYPE]) {
      recipeId = processCell.get()[TYPE];
      recipeOrModule = this.runtime.recipeManager.recipeById(recipeId);
      if (!recipeOrModule) throw new Error(`Unknown recipe: ${recipeId}`);
    } else if (!recipeOrModule) {
      console.warn(
        "No recipe provided and no recipe found in process doc. Not running.",
      );
      return resultCell;
    }

    let recipe: Recipe;

    // If this is a module, not a recipe, wrap it in a recipe that just runs,
    // passing arguments in unmodified and passing all results through as is
    if (isModule(recipeOrModule)) {
      const module = recipeOrModule as Module;
      recipeId ??= this.runtime.recipeManager.generateRecipeId(module);

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

    recipeId ??= this.runtime.recipeManager.generateRecipeId(recipe);

    if (this.cancels.has(resultDoc)) {
      // If it's already running and no new recipe or argument are given,
      // we are just returning the result doc
      if (argument === undefined && recipeId === processCell.get()?.[TYPE]) {
        return resultDoc;
      }

      // TODO(seefeld): If recipe is the same, but argument is different, just update the argument without stopping

      // Otherwise stop execution of the old recipe. TODO: Await, but this will
      // make all this async.
      this.stop(resultDoc);
    }

    // Keep track of subscriptions to cancel them later
    const [cancel, addCancel] = useCancelGroup();
    this.cancels.set(resultDoc, cancel);
    this.allCancels.add(cancel);

    // If the bindings are a cell, doc or doc link, convert them to an alias
    if (isLink(argument)) {
      argument = parseToLegacyAlias(argument) as T;
    }

    // Walk the recipe's schema and extract all default values
    const defaults = extractDefaultValues(recipe.argumentSchema) as Partial<T>;

    // Important to use DeepCopy here, as the resulting object will be modified!
    const previousInternal = processCell.get()?.internal;
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
    if (!processCell.get()?.argument) {
      argument = mergeObjects<T>(argument as any, defaults);
    }

    const recipeChanged = recipeId !== processCell.get()?.[TYPE];

    processCell.send({
      ...processCell.get(),
      [TYPE]: recipeId || "unknown",
      resultRef: { cell: resultDoc, path: [] },
      internal,
    });
    if (argument) {
      diffAndUpdate(
        { cell: processCell, path: ["argument"] },
        argument,
        undefined,
        processCell,
      );
    }

    // Send "query" to results to the result doc only on initial run or if recipe
    // changed. This preserves user modifications like renamed charms.
    if (recipeChanged) {
      // TODO(seefeld): Be smarter about merging in case result changed. But since
      // we don't yet update recipes, this isn't urgent yet.
      resultDoc.send(
        unwrapOneLevelAndBindtoDoc<R, any>(recipe.result as R, processCell),
      );
    }

    // [unsafe closures:] For recipes from closures, add a materialize factory
    if (recipe[unsafe_originalRecipe]) {
      recipe[unsafe_materializeFactory] = (log: any) => (path: PropertyKey[]) =>
        processCell.getAsQueryResult(path, log);
    }

    for (const node of recipe.nodes) {
      this.instantiateNode(
        node.module,
        node.inputs,
        node.outputs,
        processCell,
        addCancel,
        recipe,
      );
    }

    // NOTE(ja): perhaps this should actually return as a Cell<Charm>?
    return resultDoc;
  }

  async runSynced(
    resultCell: Cell<any>,
    recipe: Recipe | Module,
    inputs?: any,
  ) {
    await this.runtime.storage.syncCell(resultCell);

    const synced = await this.syncCellsForRunningRecipe(
      resultCell,
      recipe,
      inputs,
    );

    this.run(recipe, inputs, resultCell.getDoc());

    // If a new recipe was specified, make sure to sync any new cells
    // TODO(seefeld): Possible race condition here with lifted functions running
    // and using old data to update a value that arrives just between starting and
    // finishing the computation. Should be fixed by changing conflict resolution
    // for derived values to be based on what they are derived from.
    if (recipe || !synced) {
      await this.syncCellsForRunningRecipe(resultCell, recipe);
    }

    return recipe?.resultSchema
      ? resultCell.asSchema(recipe.resultSchema)
      : resultCell;
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
        const maybePromise = this.runtime.storage.syncCell(
          this.runtime.getCellFromLink(link),
        );
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

    await this.runtime.storage.syncCell(sourceCell);

    // We could support this by replicating what happens in runner, but since
    // we're calling this again when returning false, this is good enough for now.
    if (isModule(recipe)) return false;

    const cells: Cell<any>[] = [];

    for (const node of recipe.nodes) {
      const sourceDoc = sourceCell.getDoc();
      const inputs = findAllLegacyAliasedCells(node.inputs, sourceDoc);
      const outputs = findAllLegacyAliasedCells(node.outputs, sourceDoc);

      // TODO(seefeld): This ignores schemas provided by modules, so it might
      // still fetch a lot.
      [...inputs, ...outputs].forEach((c) => {
        const cell = c.cell.asCell(c.path);
        cells.push(cell);
      });
    }

    if (recipe.resultSchema) {
      cells.push(resultCell.asSchema(recipe.resultSchema));
    }

    await Promise.all(cells.map((c) => this.runtime.storage.syncCell(c)));

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
  stop<T>(resultCell: DocImpl<T> | Cell<T>): void {
    const doc = isDoc(resultCell)
      ? resultCell
      : (resultCell as Cell<T>).getDoc();
    this.cancels.get(doc)?.();
    this.cancels.delete(doc);
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

  private instantiateNode(
    module: Module,
    inputBindings: JSONValue,
    outputBindings: JSONValue,
    processCell: DocImpl<any>,
    addCancel: AddCancel,
    recipe: Recipe,
  ) {
    if (isModule(module)) {
      switch (module.type) {
        case "ref":
          this.instantiateNode(
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
    module: Module,
    inputBindings: JSONValue,
    outputBindings: JSONValue,
    processCell: DocImpl<any>,
    addCancel: AddCancel,
    recipe: Recipe,
  ) {
    const inputs = unwrapOneLevelAndBindtoDoc(
      inputBindings,
      processCell,
    );

    const reads = findAllLegacyAliasedCells(inputs, processCell);

    const outputs = unwrapOneLevelAndBindtoDoc(outputBindings, processCell);
    const writes = findAllLegacyAliasedCells(outputs, processCell);

    let fn = (
      typeof module.implementation === "string"
        ? this.runtime.harness.getInvocation(module.implementation)
        : module.implementation
    ) as (inputs: any) => any;

    if (module.wrapper && module.wrapper in moduleWrappers) {
      fn = moduleWrappers[module.wrapper](fn);
    }

    // Check if any of the read cells is a stream alias
    let streamRef: LegacyCellLink | undefined = undefined;
    if (isRecord(inputs)) {
      for (const key in inputs) {
        let doc = processCell;
        let path: PropertyKey[] = [key];
        let value = inputs[key];
        while (isWriteRedirectLink(value)) {
          const ref = followWriteRedirects(value, processCell);
          doc = ref.cell;
          path = ref.path;
          value = doc.getAtPath(path);
        }
        if (isStreamValue(value)) {
          streamRef = { cell: doc, path } satisfies LegacyCellLink;
          break;
        }
      }
    }

    if (streamRef) {
      // Register as event handler for the stream
      const stream = { ...streamRef };

      const handler = (event: any) => {
        if (event.preventDefault) event.preventDefault();
        const eventInputs = { ...(inputs as Record<string, any>) };
        const cause = { ...(inputs as Record<string, any>) };
        for (const key in eventInputs) {
          if (isWriteRedirectLink(eventInputs[key])) {
            // Use format-agnostic comparison for aliases
            const alias = eventInputs[key];

            if (
              areLinksSame(
                alias,
                streamRef,
                processCell.asCell(),
              )
            ) {
              eventInputs[key] = event;
              cause[key] = crypto.randomUUID();
            }
          }
        }

        const inputsCell = processCell.runtime!.documentMap.getDoc(
          eventInputs,
          cause,
          processCell.space,
        );
        inputsCell.freeze("event handler");

        const frame = pushFrameFromCause(cause, {
          recipe,
          materialize: (path: PropertyKey[]) =>
            processCell.getAsQueryResult(path),
        });

        const argument = module.argumentSchema
          ? inputsCell.asCell([], undefined, module.argumentSchema).get()
          : inputsCell.getAsQueryResult([], undefined);
        const result = fn(argument);

        const postRun = (result: any) => {
          if (containsOpaqueRef(result)) {
            const resultRecipe = recipeFromFrame(
              "event handler result",
              undefined,
              () => result,
            );

            const resultCell = this.run(
              resultRecipe,
              undefined,
              processCell.runtime!.documentMap.getDoc(undefined, {
                resultFor: cause,
              }, processCell.space),
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

      addCancel(this.runtime.scheduler.addEventHandler(handler, stream));
    } else {
      if (isRecord(inputs) && "$event" in inputs) {
        throw new Error(
          "Handler used as lift, because $stream: true was overwritten",
        );
      }

      // Schedule the action to run when the inputs change
      const inputsCell = processCell.runtime!.documentMap.getDoc(inputs, {
        immutable: inputs,
      }, processCell.space);
      inputsCell.freeze("javascript node");

      let previousResultDoc: DocImpl<any> | undefined;
      let previousResultRecipeAsString: string | undefined;

      const action: Action = (log: ReactivityLog) => {
        const argument = module.argumentSchema
          ? inputsCell.asCell([], log, module.argumentSchema).get()
          : inputsCell.getAsQueryResult([], log);

        const frame = pushFrameFromCause(
          { inputs, outputs, fn: fn.toString() },
          {
            recipe,
            materialize: (path: PropertyKey[]) =>
              processCell.getAsQueryResult(path, log),
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

            // If nothing changed, don't rerun the recipe
            const resultRecipeAsString = JSON.stringify(resultRecipe);
            if (previousResultRecipeAsString === resultRecipeAsString) return;
            previousResultRecipeAsString = resultRecipeAsString;

            const resultDoc = this.run(
              resultRecipe,
              undefined,
              previousResultDoc ??
                processCell.runtime!.documentMap.getDoc(
                  undefined,
                  { resultFor: { inputs, outputs, fn: fn.toString() } },
                  processCell.space,
                ),
            );
            addCancel(() => this.stop(resultDoc));

            if (!previousResultDoc) {
              previousResultDoc = resultDoc;
              sendValueToBinding(
                processCell,
                outputs,
                { cell: resultDoc, path: [] },
                log,
              );
            }
          } else {
            sendValueToBinding(processCell, outputs, result, log);
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

      addCancel(
        this.runtime.scheduler.schedule(
          action,
          { reads, writes } satisfies ReactivityLog,
        ),
      );
    }
  }

  private instantiateRawNode(
    module: Module,
    inputBindings: JSONValue,
    outputBindings: JSONValue,
    processCell: DocImpl<any>,
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

    const inputCells = findAllLegacyAliasedCells(
      mappedInputBindings,
      processCell,
    );
    const outputCells = findAllLegacyAliasedCells(
      mappedOutputBindings,
      processCell,
    );

    const action = module.implementation(
      processCell.runtime!.documentMap.getDoc(
        mappedInputBindings,
        { immutable: mappedInputBindings },
        processCell.space,
      ),
      (result: any) =>
        sendValueToBinding(processCell, mappedOutputBindings, result),
      addCancel,
      inputCells, // cause
      processCell,
      this.runtime,
    );

    addCancel(
      this.runtime.scheduler.schedule(action, {
        reads: inputCells,
        writes: outputCells,
      }),
    );
  }

  private instantiatePassthroughNode(
    module: Module,
    inputBindings: JSONValue,
    outputBindings: JSONValue,
    processCell: DocImpl<any>,
    addCancel: AddCancel,
    recipe: Recipe,
  ) {
    const inputs = unwrapOneLevelAndBindtoDoc(inputBindings, processCell);
    const inputsCell = processCell.runtime!.documentMap.getDoc(inputs, {
      immutable: inputs,
    }, processCell.space);
    const reads = findAllLegacyAliasedCells(inputs, processCell);

    const outputs = unwrapOneLevelAndBindtoDoc(outputBindings, processCell);
    const writes = findAllLegacyAliasedCells(outputs, processCell);

    const action: Action = (log: ReactivityLog) => {
      const inputsProxy = inputsCell.getAsQueryResult([], log);
      sendValueToBinding(processCell, outputBindings, inputsProxy, log);
    };

    addCancel(
      this.runtime.scheduler.schedule(
        action,
        { reads, writes } satisfies ReactivityLog,
      ),
    );
  }

  private instantiateRecipeNode(
    module: Module,
    inputBindings: JSONValue,
    outputBindings: JSONValue,
    processCell: DocImpl<any>,
    addCancel: AddCancel,
    recipe: Recipe,
  ) {
    if (!isRecipe(module.implementation)) throw new Error(`Invalid recipe`);
    const recipeImpl = unwrapOneLevelAndBindtoDoc(
      module.implementation,
      processCell,
    );
    const inputs = unwrapOneLevelAndBindtoDoc(inputBindings, processCell);
    const resultCell = processCell.runtime!.documentMap.getDoc(
      undefined,
      {
        recipe: module.implementation,
        parent: processCell,
        inputBindings,
        outputBindings,
      },
      processCell.space,
    );
    this.run(recipeImpl, inputs, resultCell);
    sendValueToBinding(processCell, outputBindings, {
      cell: resultCell,
      path: [],
    });
    // TODO(seefeld): Make sure to not cancel after a recipe is elevated to a
    // charm, e.g. via navigateTo. Nothing is cancelling right now, so leaving
    // this as TODO.
    addCancel(this.cancels.get(resultCell.sourceCell!));
  }
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
    fn.bind(props)(props.$event, props),
};
