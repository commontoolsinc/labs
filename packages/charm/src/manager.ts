import {
  type Cell,
  Classification,
  EntityId,
  getEntityId,
  type IExtendedStorageTransaction,
  isCell,
  isLink,
  JSONSchema,
  type MemorySpace,
  Module,
  NAME,
  parseLink,
  Recipe,
  Runtime,
  type Schema,
  TYPE,
  UI,
  URI,
} from "@commontools/runner";
import { vdomSchema } from "@commontools/html";
import { type Session } from "@commontools/identity";
import { isObject, isRecord } from "@commontools/utils/types";

/**
 * Extracts the ID from a charm.
 * @param charm - The charm to extract ID from
 * @returns The charm ID string, or undefined if no ID is found
 */
export function charmId(charm: Cell<unknown>): string | undefined {
  const id = charm.entityId;
  if (!id) return undefined;
  const idValue = id["/"];
  return typeof idValue === "string" ? idValue : undefined;
}

export const nameSchema = {
  type: "object",
  properties: { [NAME]: { type: "string" } },
  required: [NAME],
} as const satisfies JSONSchema;

export type NameSchema = Schema<typeof nameSchema>;

export const uiSchema = {
  type: "object",
  properties: { [UI]: vdomSchema },
  required: [UI],
} as const satisfies JSONSchema;

export type UISchema = Schema<typeof uiSchema>;

export const charmListSchema = {
  type: "array",
  items: { asCell: true },
} as const satisfies JSONSchema;

export const charmLineageSchema = {
  type: "object",
  properties: {
    charm: { type: "object", asCell: true },
    relation: { type: "string" },
    timestamp: { type: "number" },
  },
  required: ["charm", "relation", "timestamp"],
} as const satisfies JSONSchema;
export type CharmLineage = Schema<typeof charmLineageSchema>;

export const charmSourceCellSchema = {
  type: "object",
  properties: {
    [TYPE]: { type: "string" },
    spell: { type: "object" },
    lineage: {
      type: "array",
      items: charmLineageSchema,
      default: [],
    },
    llmRequestId: { type: "string" },
  },
} as const satisfies JSONSchema;

export const processSchema = {
  type: "object",
  properties: {
    argument: { type: "object" },
    [TYPE]: { type: "string" },
    spell: { type: "object" },
  },
  required: [TYPE],
} as const satisfies JSONSchema;

/**
 * Helper to consistently compare entity IDs between cells
 */
function isSameEntity(
  a: Cell<unknown> | string | EntityId,
  b: Cell<unknown> | string | EntityId,
): boolean {
  const idA = getEntityId(a);
  const idB = getEntityId(b);
  return idA && idB ? idA["/"] === idB["/"] : false;
}

/**
 * Filters an array of charms by removing any that match the target entity
 */
function filterOutEntity(
  list: Cell<Cell<unknown>[]>,
  target: Cell<unknown> | string | EntityId,
): Cell<unknown>[] {
  const targetId = getEntityId(target);
  const listContents = list.get();
  if (listContents === undefined) {
    return [];
  }
  if (!targetId) return listContents as Cell<unknown>[];

  return listContents.filter((charm) => !isSameEntity(charm, targetId));
}

export class CharmManager {
  private space: MemorySpace;

  private charms: Cell<Cell<unknown>[]>;
  private pinnedCharms: Cell<Cell<unknown>[]>;
  private trashedCharms: Cell<Cell<unknown>[]>;

  /**
   * Promise resolved when the charm manager gets the charm list.
   */
  ready: Promise<void>;

  constructor(
    private session: Session,
    public runtime: Runtime,
  ) {
    this.space = this.session.space;

    this.charms = this.runtime.getCell(
      this.space,
      "charms",
      charmListSchema,
    );
    this.pinnedCharms = this.runtime.getCell(
      this.space,
      "pinned-charms",
      charmListSchema,
    );
    this.trashedCharms = this.runtime.getCell(
      this.space,
      "trash",
      charmListSchema,
    );

    this.ready = Promise.all([
      this.syncCharms(this.charms),
      this.syncCharms(this.pinnedCharms),
      this.syncCharms(this.trashedCharms),
    ]).then(() => {});
  }

  getSpace(): MemorySpace {
    return this.space;
  }

  getSpaceName(): string {
    return this.session.name;
  }

  async synced(): Promise<void> {
    await this.ready;
    return await this.runtime.storageManager.synced();
  }

  async pin(charm: Cell<unknown>) {
    await this.syncCharms(this.pinnedCharms);
    // Check if already pinned
    if (
      !filterOutEntity(this.pinnedCharms, charm).some((c) =>
        isSameEntity(c, charm)
      )
    ) {
      this.pinnedCharms.push(charm);
      await this.runtime.idle();
    }
  }

  async unpinById(charmId: EntityId) {
    let changed = false;

    await this.syncCharms(this.pinnedCharms);
    return (!await this.runtime.editWithRetry((tx) => {
      const pinnedCharms = this.pinnedCharms.withTx(tx);
      const newPinnedCharms = filterOutEntity(pinnedCharms, charmId);
      if (newPinnedCharms.length !== pinnedCharms.get()!.length) {
        this.pinnedCharms.withTx(tx).set(newPinnedCharms);
        changed = true;
      } else {
        changed = false;
      }
    })) && changed;
  }

  async unpin(charm: Cell<unknown> | string | EntityId) {
    const id = getEntityId(charm);
    if (!id) return false;

    return await this.unpinById(id);
  }

  getPinned(): Cell<Cell<unknown>[]> {
    this.syncCharms(this.pinnedCharms);
    return this.pinnedCharms;
  }

  getTrash(): Cell<Cell<unknown>[]> {
    this.syncCharms(this.trashedCharms);
    return this.trashedCharms;
  }

  async restoreFromTrash(idOrCharm: string | EntityId | Cell<unknown>) {
    await this.syncCharms(this.trashedCharms);
    await this.syncCharms(this.charms);

    const error = await this.runtime.editWithRetry((tx) => {
      const trashedCharms = this.trashedCharms.withTx(tx);

      const id = getEntityId(idOrCharm);
      if (!id) return false;

      // Find the charm in trash
      const trashedCharm = trashedCharms.get()!.find((charm) =>
        isSameEntity(charm, id)
      );

      if (!trashedCharm) return false;

      // Remove from trash
      const newTrashedCharms = filterOutEntity(trashedCharms, id);
      trashedCharms.set(newTrashedCharms);

      // Add back to charms
      this.addCharms([trashedCharm], tx);
    });

    await this.runtime.idle();

    return !error;
  }

  async emptyTrash() {
    await this.syncCharms(this.trashedCharms);
    await this.runtime.editWithRetry((tx) => {
      const trashedCharms = this.trashedCharms.withTx(tx);
      trashedCharms.set([]);
    });
  }

  // FIXME(ja): this says it returns a list of charm, but it isn't! you will
  // have to call .get() to get the actual charm (this is missing the schema)
  // how can we fix the type here?
  getCharms(): Cell<Cell<unknown>[]> {
    // Start syncing if not already syncing. Will trigger a change to the list
    // once loaded.
    this.syncCharms(this.charms);
    return this.charms;
  }

  private addCharms(
    newCharms: Cell<unknown>[],
    tx: IExtendedStorageTransaction,
  ) {
    const charms = this.charms.withTx(tx);
    const charmsData = charms.get();
    if (charmsData === undefined) {
      return;
    }
    newCharms.forEach((charm) => {
      if (!charmsData.some((otherCharm) => otherCharm.equals(charm))) {
        charms.push(charm);
      }
    });
  }

  async add(newCharms: Cell<unknown>[], tx?: IExtendedStorageTransaction) {
    await this.syncCharms(this.charms);
    await this.runtime.idle();

    if (tx) {
      this.addCharms(newCharms, tx);
    } else {
      await this.runtime.editWithRetry((tx) => {
        this.addCharms(newCharms, tx);
      });
    }
  }

  syncCharms(cell: Cell<Cell<unknown>[]>) {
    // TODO(@ubik2) We use elevated permissions here temporarily.
    // Our request for the charm list will walk the schema tree, and that will
    // take us into classified data of charms. If that happens, we still want
    // this bit to work, so we elevate this request.
    const privilegedSchema = {
      ...charmListSchema,
      ifc: { classification: [Classification.Secret] },
    } as const satisfies JSONSchema;
    return cell.asSchema(privilegedSchema).sync();
  }

  async get<S extends JSONSchema = JSONSchema>(
    id: string | Cell<unknown>,
    runIt: boolean,
    asSchema: S,
  ): Promise<Cell<Schema<S>>>;
  async get<T = unknown>(
    id: string | Cell<unknown>,
    runIt?: boolean,
    asSchema?: JSONSchema,
  ): Promise<Cell<T>>;
  async get<T = unknown>(
    id: string | Cell<unknown>,
    runIt: boolean = true,
    asSchema?: JSONSchema,
  ): Promise<Cell<T>> {
    // Load the charm from storage.
    let charm: Cell<unknown>;

    if (isCell(id)) charm = id;
    else charm = this.runtime.getCellFromEntityId(this.space, { "/": id });

    await charm.sync();

    const recipeId = getRecipeIdFromCharm(charm);
    if (!recipeId) throw new Error("recipeId is required");

    // Make sure we have the recipe so we can run it!
    let recipe: Recipe | Module | undefined;
    try {
      recipe = await this.runtime.recipeManager.loadRecipe(
        recipeId,
        this.space,
      );
    } catch (e) {
      console.warn("loadRecipe: error", e);
      console.warn("recipeId", recipeId);
      console.warn("recipe", recipe);
      console.warn("charm", charm.get());
      console.warn(
        `Not a charm (check toolshed?): ${JSON.stringify(getEntityId(charm))}`,
      );
      throw e;
    }

    const resultSchema = this.#getResultSchema(charm, recipe);

    if (runIt) {
      // Make sure the charm is running. This is re-entrant and has no effect if
      // the charm is already running.
      if (!recipe) {
        throw new Error(`Recipe not found for charm ${getEntityId(charm)}`);
      }
      const newCharm = await this.runtime.runSynced(charm, recipe);
      return newCharm.asSchema(asSchema ?? resultSchema);
    } else {
      return charm.asSchema<T>(asSchema ?? resultSchema);
    }
  }

  #getResultSchema(
    charm: Cell<unknown>,
    recipe: Recipe,
  ): JSONSchema | undefined {
    if (
      isRecord(recipe.resultSchema) &&
      Object.keys(recipe.resultSchema).length > 0
    ) return recipe.resultSchema;

    // Ignore default cell schema to get to other values
    const resultValue = charm.asSchema().get();
    if (isObject(resultValue)) {
      const keys = Object.keys(resultValue).filter((key) =>
        !key.startsWith("$")
      );

      // Only generate a schema for charms that have more than $ props
      if (keys.length > 0) {
        return {
          type: "object",
          properties: Object.fromEntries(keys.map((key) => [key, true])),
        };
      }
    }

    return undefined;
  }

  getLineage(charm: Cell<unknown>) {
    return charm.getSourceCell(charmSourceCellSchema)?.key("lineage").get() ??
      [];
  }

  getLLMTrace(charm: Cell<unknown>): string | undefined {
    return charm.getSourceCell(charmSourceCellSchema)?.key("llmRequestId")
      .get() ?? undefined;
  }

  /**
   * Find all charms that the given charm reads data from via aliases or links.
   * This identifies dependencies that the charm has on other charms.
   * @param charm The charm to check
   * @returns Array of charms that are read from
   */
  getReadingFrom(charm: Cell<unknown>): Cell<unknown>[] {
    // Get all charms that might be referenced
    const allCharms = this.getCharms().get();
    const result: Cell<unknown>[] = [];
    const seenEntityIds = new Set<string>(); // Track entities we've already processed
    const maxDepth = 10; // Prevent infinite recursion
    const maxResults = 50; // Prevent too many results from overwhelming the UI

    if (allCharms === undefined || !charm) return result;

    try {
      // Get the argument data - this is where references to other charms are stored
      const argumentCell = this.getArgument(charm);
      if (!argumentCell) return result;

      // Get the raw argument value
      let argumentValue;

      try {
        argumentValue = argumentCell.getRaw();
      } catch (err) {
        console.debug("Error getting argument value:", err);
        return result;
      }

      // Helper function to add a matching charm to the result
      const addMatchingCharm = (docId: EntityId) => {
        if (!docId || !docId["/"]) return;

        const entityIdStr = typeof docId["/"] === "string"
          ? docId["/"]
          : JSON.stringify(docId["/"]);

        // Skip if we've already processed this entity
        if (seenEntityIds.has(entityIdStr)) return;
        seenEntityIds.add(entityIdStr);

        // Find matching charm by entity ID
        const matchingCharm = allCharms.find((c) => {
          const cId = getEntityId(c);
          return cId && docId["/"] === cId["/"];
        });

        if (
          matchingCharm && !isSameEntity(matchingCharm, charm) &&
          !result.some((c) => isSameEntity(c, matchingCharm))
        ) {
          // Check if we've already found too many references
          if (result.length < maxResults) {
            result.push(matchingCharm);
            // Reference added to result
          }
        }
      };

      // Helper function to follow alias chain to its source
      const followSourceToResultRef = (
        cell: Cell<unknown>,
        visited = new Set<string>(),
        depth = 0,
      ): EntityId | undefined => {
        if (depth > maxDepth) return undefined; // Prevent infinite recursion

        try {
          const docId = cell.entityId;
          if (!docId || !docId["/"]) return undefined;

          const docIdStr = typeof docId["/"] === "string"
            ? docId["/"]
            : JSON.stringify(docId["/"]);

          // Prevent cycles
          if (visited.has(docIdStr)) return undefined;
          visited.add(docIdStr);

          try {
            // If document has a sourceCell, follow it
            const value = cell.getRaw();
            const sourceCell = cell.getSourceCell();
            if (sourceCell) {
              return followSourceToResultRef(sourceCell, visited, depth + 1);
            } else if (isRecord(value) && value.resultRef) {
              // If we've reached the end and have a resultRef, return it
              const { id: source } = parseLink(value.resultRef, cell)!;
              if (source) return getEntityId(source);
            }
          } catch (err) {
            // Ignore errors getting doc value
            console.debug("Error getting doc value:", err);
          }

          return docId; // Return the current document's ID if no further references
        } catch (err) {
          console.debug("Error in followSourceToResultRef:", err);
          return undefined;
        }
      };

      // Find references in the argument structure
      const processValue = (
        value: unknown,
        parent: Cell<unknown>,
        visited = new Set<unknown>(), // Track objects directly, not string representations
        depth = 0,
      ) => {
        if (!isRecord(value) || depth > maxDepth) return;

        // Prevent cycles in our traversal by tracking object references directly
        if (visited.has(value)) return;
        visited.add(value);

        try {
          // Handle values that are themselves cells, docs, or cell links
          if (isLink(value)) {
            const link = parseLink(value, parent);
            if (link.id) {
              addMatchingCharm(getEntityId(link.id)!);
            }

            const sourceRefId = followSourceToResultRef(
              this.runtime.getCellFromLink(link),
              new Set(),
              0,
            );
            if (sourceRefId) addMatchingCharm(sourceRefId);
          } else if (Array.isArray(value)) {
            // Safe recursive processing of arrays
            for (let i = 0; i < value.length; i++) {
              try {
                processValue(
                  value[i],
                  parent,
                  new Set([...visited]),
                  depth + 1,
                );
              } catch (err) {
                console.debug(
                  `Error processing array item at index ${i}:`,
                  err,
                );
              }
            }
          } else if (typeof value === "object") {
            // Process regular object properties
            const keys = Object.keys(value);
            for (let i = 0; i < keys.length; i++) {
              const key = keys[i];

              try {
                processValue(
                  value[key],
                  parent,
                  new Set([...visited]),
                  depth + 1,
                );
              } catch (err) {
                console.debug(
                  `Error processing object property '${key}':`,
                  err,
                );
              }
            }
          }
        } catch (err) {
          console.debug("Error in processValue:", err);
        }
      };

      // Start processing from the argument value
      if (argumentValue && typeof argumentValue === "object") {
        processValue(
          argumentValue,
          argumentCell,
          new Set(),
          0,
        );
      }
    } catch (error) {
      console.debug("Error finding references in charm arguments:", error);
      // Don't throw the error - return an empty result instead
    }

    return result;
  }

  /**
   * Find all charms that read data from the given charm via aliases or links.
   * This identifies which charms depend on this charm.
   * @param charm The charm to check
   * @returns Array of charms that read from this charm
   */
  getReadByCharms(charm: Cell<unknown>): Cell<unknown>[] {
    // Get all charms to check
    const allCharms = this.getCharms().get();
    const result: Cell<unknown>[] = [];
    const seenEntityIds = new Set<string>(); // Track entities we've already processed
    const maxDepth = 10; // Prevent infinite recursion
    const maxResults = 50; // Prevent too many results from overwhelming the UI

    if (allCharms === undefined || !charm) return result;

    const charmId = getEntityId(charm);
    if (!charmId) return result;

    // Helper function to add a matching charm to the result
    const addReadingCharm = (otherCharm: Cell<unknown>) => {
      const otherCharmId = getEntityId(otherCharm);
      if (!otherCharmId || !otherCharmId["/"]) return;

      const entityIdStr = typeof otherCharmId["/"] === "string"
        ? otherCharmId["/"]
        : JSON.stringify(otherCharmId["/"]);

      // Skip if we've already processed this entity
      if (seenEntityIds.has(entityIdStr)) return;
      seenEntityIds.add(entityIdStr);

      if (!result.some((c) => isSameEntity(c, otherCharm))) {
        // Check if we've already found too many references
        if (result.length < maxResults) {
          result.push(otherCharm);
          // Charm reading from target added to result
        }
      }
    };

    // Helper function to follow alias chain to its source
    const followSourceToResultRef = (
      cell: Cell<unknown>,
      visited = new Set<string>(),
      depth = 0,
    ): URI | undefined => {
      if (depth > maxDepth) return undefined; // Prevent infinite recursion

      const cellURI = cell.sourceURI;

      // Prevent cycles
      if (visited.has(cellURI)) return undefined;
      visited.add(cellURI);

      // If document has a sourceCell, follow it
      const value = cell.getRaw();
      const sourceCell = cell.getSourceCell();
      if (sourceCell) {
        return followSourceToResultRef(sourceCell, visited, depth + 1);
      }

      // If we've reached the end and have a resultRef, return it
      if (isRecord(value) && value.resultRef) {
        return parseLink(value.resultRef, cell)?.id;
      }

      return cellURI; // Return the current document's ID if no further references
    };

    // Helper to check if a document refers to our target charm
    const checkRefersToTarget = (
      value: unknown,
      parent: Cell<unknown>,
      visited = new Set<unknown>(), // Track objects directly, not string representations
      depth = 0,
    ): boolean => {
      if (!isRecord(value) || depth > maxDepth) return false;

      // Prevent cycles in our traversal by tracking object references directly
      if (visited.has(value)) return false;
      visited.add(value);

      try {
        if (isLink(value)) {
          try {
            const link = parseLink(value, parent);

            // Check if the cell link's doc is our target
            if (link.id === charm.sourceURI) return true;

            // Check if cell link's source chain leads to our target
            const sourceResultRefURI = followSourceToResultRef(
              this.runtime.getCellFromLink(link),
              new Set(),
              0,
            );
            if (sourceResultRefURI === charm.sourceURI) return true;
          } catch (err) {
            console.debug(
              "Error handling cell link in checkRefersToTarget:",
              err,
            );
          }
          return false; // Don't process cell link contents
        }

        // Safe recursive processing of arrays
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i++) {
            try {
              if (
                checkRefersToTarget(
                  value[i],
                  parent,
                  new Set([...visited]),
                  depth + 1,
                )
              ) {
                return true;
              }
            } catch (err) {
              console.debug(`Error checking array item at index ${i}:`, err);
            }
          }
        } else if (isRecord(value)) {
          // Process regular object properties
          const keys = Object.keys(value);
          for (let i = 0; i < keys.length; i++) {
            const key = keys[i];

            try {
              if (
                checkRefersToTarget(
                  value[key],
                  parent,
                  new Set([...visited]),
                  depth + 1,
                )
              ) {
                return true;
              }
            } catch (err) {
              console.debug(`Error checking object property '${key}':`, err);
            }
          }
        }
      } catch (err) {
        console.debug("Error in checkRefersToTarget:", err);
      }

      return false;
    };

    // Check each charm to see if it references this charm
    for (const otherCharm of allCharms) {
      if (isSameEntity(otherCharm, charm)) continue; // Skip self

      if (checkRefersToTarget(otherCharm, otherCharm, new Set(), 0)) {
        addReadingCharm(otherCharm);
        continue; // Skip additional checks for this charm
      }

      // Also specifically check the argument data where references are commonly found
      try {
        const argumentCell = this.getArgument(otherCharm);
        if (argumentCell) {
          const argumentValue = argumentCell.getRaw();

          // Check if the argument references our target
          if (argumentValue && typeof argumentValue === "object") {
            if (
              checkRefersToTarget(
                argumentValue,
                argumentCell,
                new Set(),
                0,
              )
            ) {
              addReadingCharm(otherCharm);
            }
          }
        }
      } catch (error) {
        // Error checking argument references for charm
      }
    }

    return result;
  }

  async getCellById<T>(
    id: EntityId | string,
    path: string[] = [],
    schema?: JSONSchema,
  ): Promise<Cell<T>> {
    const cell = this.runtime.getCellFromEntityId<T>(
      this.space,
      id,
      path,
      schema,
    );
    await cell.sync();
    return cell;
  }

  // Return Cell with argument content of already loaded recipe according
  // to the schema of the charm.
  getArgument<T = unknown>(
    charm: Cell<unknown | T>,
  ): Cell<T> {
    const source = charm.getSourceCell(processSchema);
    const recipeId = source?.get()?.[TYPE]!;
    if (!recipeId) throw new Error("charm missing recipe ID");
    const recipe = this.runtime.recipeManager.recipeById(recipeId);
    if (!recipe) throw new Error(`Recipe ${recipeId} not loaded`);
    return source.key("argument").asSchema<T>(recipe.argumentSchema);
  }

  getResult<T = unknown>(
    charm: Cell<T>,
  ): Cell<T> {
    const source = charm.getSourceCell(processSchema);
    const recipeId = source?.get()?.[TYPE]!;
    if (!recipeId) throw new Error("charm missing recipe ID");
    const recipe = this.runtime.recipeManager.recipeById(recipeId);
    if (!recipe) throw new Error(`Recipe ${recipeId} not loaded`);
    const resultSchema = this.#getResultSchema(charm, recipe);
    return charm.asSchema<T>(resultSchema);
  }

  // note: removing a charm doesn't clean up the charm's cells
  // Now moves the charm to trash instead of just removing it
  async remove(idOrCharm: string | EntityId | Cell<unknown>) {
    let success = false;

    await Promise.all([
      this.syncCharms(this.charms),
      this.syncCharms(this.pinnedCharms),
      this.syncCharms(this.trashedCharms),
    ]);

    const id = getEntityId(idOrCharm);
    if (!id) return false;

    await this.unpin(idOrCharm);

    return (!await this.runtime.editWithRetry((tx) => {
      const charms = this.charms.withTx(tx);
      const trashedCharms = this.trashedCharms.withTx(tx);

      // Find the charm in the main list
      // we've already awaited it above, so we can call get()!
      const charm = charms.get()!.find((c) => isSameEntity(c, id));
      if (!charm) {
        success = false;
      } else {
        // Move to trash if not already there
        if (!trashedCharms.get()!.some((c) => isSameEntity(c, id))) {
          trashedCharms.push(charm);
        }

        // Remove from main list
        const newCharms = filterOutEntity(charms, id);
        if (newCharms.length !== charms.get()!.length) {
          charms.set(newCharms);
        }

        success = true;
      }
    })) && success;
  }

  // Permanently delete a charm (from trash or directly)
  async permanentlyDelete(idOrCharm: string | EntityId | Cell<unknown>) {
    let success;

    await this.syncCharms(this.trashedCharms);

    const id = getEntityId(idOrCharm);
    if (!id) return false;

    return (!await this.runtime.editWithRetry((tx) => {
      // Remove from trash if present
      const trashedCharms = this.trashedCharms.withTx(tx);
      const newTrashedCharms = filterOutEntity(trashedCharms, id);
      if (newTrashedCharms.length !== trashedCharms.get()!.length) {
        trashedCharms.set(newTrashedCharms);
        success = true;
      } else {
        success = false;
      }
    })) && success;
  }

  async runPersistent<T = unknown>(
    recipe: Recipe | Module,
    inputs?: unknown,
    cause?: unknown,
    llmRequestId?: string,
    options?: { start?: boolean },
  ): Promise<Cell<T>> {
    const start = options?.start ?? true;
    const charm = await this.setupPersistent<T>(
      recipe,
      inputs,
      cause,
      llmRequestId,
    );
    if (start) {
      await this.startCharm(charm);
    }
    return charm;
  }

  // Consistently return the `Cell<Charm>` of charm with
  // id `charmId`, applies the provided `recipe` (which may be
  // its current recipe -- useful when we are only updating inputs),
  // and optionally applies `inputs` if provided.
  async runWithRecipe(
    recipe: Recipe | Module,
    charmId: string,
    inputs?: object,
    options?: { start?: boolean },
  ): Promise<Cell<unknown>> {
    const charm = this.runtime.getCellFromEntityId(this.space, {
      "/": charmId,
    });
    await charm.sync();
    const start = options?.start ?? true;
    if (start) {
      await this.runtime.runSynced(charm, recipe, inputs);
    } else {
      this.runtime.setup(undefined, recipe, inputs ?? {}, charm);
    }
    await this.syncRecipe(charm);

    await this.add([charm]);

    return charm;
  }

  /**
   * Prepare a new charm by setting up its process/result cells and recipe
   * metadata without scheduling the recipe's nodes.
   */
  async setupPersistent<T = unknown>(
    recipe: Recipe | Module,
    inputs?: unknown,
    cause?: unknown,
    llmRequestId?: string,
  ): Promise<Cell<T>> {
    await this.runtime.idle();
    const charm = this.runtime.getCell<T>(
      this.space,
      cause,
      recipe.resultSchema,
    );
    this.runtime.setup(undefined, recipe, inputs ?? {}, charm);
    await this.syncRecipe(charm);
    await this.add([charm]);

    if (llmRequestId) {
      this.runtime.editWithRetry((tx) => {
        charm.getSourceCell(charmSourceCellSchema)?.key("llmRequestId")
          .withTx(tx)
          .set(llmRequestId);
      });
    }

    return charm;
  }

  /** Start scheduling and running a prepared charm. */
  async startCharm<T = unknown>(charmOrId: string | Cell<T>): Promise<void> {
    const charm = typeof charmOrId === "string"
      ? await this.get<T>(charmOrId)
      : charmOrId;
    if (!charm) throw new Error("Charm not found");
    this.runtime.start(charm);
    await this.runtime.idle();
    await this.synced();
  }

  /** Stop a running charm (no-op if not running). */
  async stopCharm<T = unknown>(charmOrId: string | Cell<T>): Promise<void> {
    const charm = typeof charmOrId === "string"
      ? await this.get<T>(charmOrId)
      : charmOrId;
    if (!charm) throw new Error("Charm not found");
    this.runtime.runner.stop(charm);
    await this.runtime.idle();
  }

  // FIXME(JA): this really really really needs to be revisited
  async syncRecipe(charm: Cell<unknown>) {
    await charm.sync();

    // When we subscribe to a doc, our subscription includes the doc's source,
    // so get that.
    const sourceCell = charm.getSourceCell();
    if (!sourceCell) throw new Error("charm missing source cell");
    await sourceCell.sync();

    const recipeId = sourceCell.get()?.[TYPE];
    if (!recipeId) throw new Error("charm missing recipe ID");

    return await this.syncRecipeById(recipeId);
  }

  async syncRecipeById(recipeId: string) {
    if (!recipeId) throw new Error("recipeId is required");
    const recipe = await this.runtime.recipeManager.loadRecipe(
      recipeId,
      this.space,
    );
    return recipe;
  }

  async sync(entity: Cell<unknown>, waitForStorage: boolean = false) {
    await entity.sync();
  }

  // Returns the charm from one of our active charm lists if it is present,
  // or undefined if it is not
  getActiveCharm(charmId: Cell<unknown> | EntityId | string) {
    return this.charms.get()?.find((charm) => isSameEntity(charm, charmId)) ??
      this.pinnedCharms.get()?.find((charm) => isSameEntity(charm, charmId));
  }

  async link(
    sourceCharmId: string,
    sourcePath: (string | number)[],
    targetCharmId: string,
    targetPath: (string | number)[],
  ): Promise<void> {
    // Get source cell (charm or arbitrary cell)
    const { cell: sourceCell, isCharm: sourceIsCharm } =
      await getCellByIdOrCharm(
        this,
        sourceCharmId,
        "Source",
      );

    // Get target cell (charm or arbitrary cell)
    const { cell: targetCell, isCharm: targetIsCharm } =
      await getCellByIdOrCharm(
        this,
        targetCharmId,
        "Target",
      );

    await this.runtime.editWithRetry((tx) => {
      // Navigate to the source path
      // Cannot navigate `Cell<unknown>`
      // FIXME: types
      // deno-lint-ignore no-explicit-any
      let sourceResultCell = sourceCell.withTx(tx) as Cell<any>;
      // For charms, manager.get() already returns the result cell, so no need to add "result"

      for (const segment of sourcePath) {
        sourceResultCell = sourceResultCell.key(segment);
      }

      // Navigate to the target path
      const targetKey = targetPath.pop();
      if (targetKey === undefined) {
        throw new Error("Target path cannot be empty");
      }

      // Cannot navigate `Cell<unknown>`
      // FIXME: types
      // deno-lint-ignore no-explicit-any
      let targetInputCell = targetCell.withTx(tx) as Cell<any>;
      if (targetIsCharm) {
        // For charms, target fields are in the source cell's argument
        const sourceCell = targetCell.getSourceCell(processSchema);
        if (!sourceCell) {
          throw new Error("Target charm has no source cell");
        }
        targetInputCell = sourceCell.key("argument").withTx(tx);
      }

      for (const segment of targetPath) {
        targetInputCell = targetInputCell.key(segment);
      }

      targetInputCell.key(targetKey).set(sourceResultCell);
    });
    await this.runtime.idle();
    await this.synced();
  }
}

export const getRecipeIdFromCharm = (charm: Cell<unknown>): string => {
  const sourceCell = charm.getSourceCell(processSchema);
  if (!sourceCell) throw new Error("charm missing source cell");
  return sourceCell.get()?.[TYPE]!;
};

async function getCellByIdOrCharm(
  manager: CharmManager,
  cellId: string,
  label: string,
): Promise<{ cell: Cell<unknown>; isCharm: boolean }> {
  try {
    // Try to get as a charm first
    const charm = await manager.get(cellId, true);
    if (!charm) {
      throw new Error(`Charm ${cellId} not found`);
    }
    return { cell: charm, isCharm: true };
  } catch (error) {
    // If manager.get() fails (e.g., "recipeId is required"), try as arbitrary cell ID
    try {
      const cell = await manager.getCellById({ "/": cellId });

      // Check if this cell is actually a charm by looking at the charms list
      const charmsCell = manager.getCharms();
      await charmsCell.sync();
      const charms = charmsCell.get()!;
      const isActuallyCharm = charms.some((charm) => {
        const id = charmId(charm);
        // If we can't get the charm ID, it's not a valid charm
        if (!id) return false;
        return id === cellId;
      });

      return { cell, isCharm: isActuallyCharm };
    } catch (cellError) {
      throw new Error(`${label} "${cellId}" not found as charm or cell`);
    }
  }
}
