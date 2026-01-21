import {
  type Cell,
  Classification,
  EntityId,
  getEntityId,
  isCell,
  isLink,
  isStream,
  JSONSchema,
  type MemorySpace,
  Module,
  parseLink,
  Recipe,
  Runtime,
  type Schema,
  type SpaceCellContents,
  TYPE,
  URI,
} from "@commontools/runner";
import { type Session } from "@commontools/identity";
import { isRecord } from "@commontools/utils/types";
import { ensureNotRenderThread } from "@commontools/utils/env";
import {
  charmListSchema,
  charmSourceCellSchema,
  defaultPatternHandlersSchema,
  NameSchema,
  nameSchema,
  processSchema,
} from "@commontools/runner/schemas";
ensureNotRenderThread();

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

/**
 * Filters an array of charms by removing any that match the target cell
 */
function filterOutCell(
  list: Cell<Cell<unknown>[]>,
  target: Cell<unknown>,
): Cell<unknown>[] {
  const resolvedTarget = target.resolveAsCell();
  return list.get().filter((charm) =>
    !charm.resolveAsCell().equals(resolvedTarget)
  );
}

export class CharmManager {
  private space: MemorySpace;

  private spaceCell: Cell<SpaceCellContents>;

  /**
   * Promise resolved when the charm manager is ready.
   */
  ready: Promise<void>;

  constructor(
    private session: Session,
    public runtime: Runtime,
  ) {
    this.space = this.session.space;

    // Use the space DID as the cause - it's derived from the space name
    // and consistently available everywhere
    const isHomeSpace = this.space === this.runtime.userIdentityDID;
    this.spaceCell = isHomeSpace
      ? this.runtime.getHomeSpaceCell()
      : this.runtime.getSpaceCell(this.space);

    const syncSpaceCellContents = Promise.resolve(this.spaceCell.sync());

    // Note: allCharms and recentCharms are now managed by the default pattern,
    // not directly on the space cell. The space cell only contains a link to defaultPattern.
    // Default pattern creation is handled by CharmsController.ensureDefaultPattern()
    // which is called by CLI/shell entry points. CharmManager doesn't auto-create it.
    this.ready = syncSpaceCellContents.then(() => {});
  }

  getSpace(): MemorySpace {
    return this.space;
  }

  getSpaceName(): string | undefined {
    return this.session.spaceName;
  }

  async synced(): Promise<void> {
    await this.ready;
    return await this.runtime.storageManager.synced();
  }

  getSpaceCellContents(): Cell<SpaceCellContents> {
    return this.spaceCell;
  }

  /**
   * Link the default pattern cell to the space cell.
   * This should be called after the default pattern is created.
   * @param defaultPatternCell - The cell representing the default pattern
   */
  async linkDefaultPattern(
    defaultPatternCell: Cell<any>,
  ): Promise<void> {
    await this.runtime.editWithRetry((tx) => {
      const spaceCellWithTx = this.spaceCell.withTx(tx);
      spaceCellWithTx.key("defaultPattern").set(defaultPatternCell.withTx(tx));
    });
    await this.runtime.idle();
  }

  /**
   * Clears the defaultPattern link from the space cell.
   * Used when the default pattern is being deleted.
   */
  async unlinkDefaultPattern(): Promise<void> {
    await this.runtime.editWithRetry((tx) => {
      const spaceCellWithTx = this.spaceCell.withTx(tx);
      spaceCellWithTx.key("defaultPattern").set(undefined);
    });
    await this.runtime.idle();
  }

  /**
   * Get the default pattern cell from the space cell.
   * @returns The default pattern cell, or undefined if not set
   */
  async getDefaultPattern(): Promise<Cell<NameSchema> | undefined> {
    const cell = await this.spaceCell.key("defaultPattern").sync();
    if (!cell.get().get()) {
      return undefined;
    }
    return this.get(
      cell.get(),
      true,
      nameSchema,
    );
  }

  /**
   * Get the cell containing the list of all charms in this space.
   * Reads from the default pattern's allCharms export.
   */
  async getCharms(): Promise<Cell<Cell<unknown>[]>> {
    const defaultPattern = await this.getDefaultPattern();
    if (!defaultPattern) {
      // Return empty array cell if no default pattern
      return this.runtime.getCell(this.space, "empty-charms", charmListSchema);
    }

    const cell = defaultPattern.asSchema({
      type: "object",
      properties: {
        allCharms: charmListSchema,
      },
    });
    const charmsCell = cell.key("allCharms") as Cell<Cell<unknown>[]>;
    await this.syncCharms(charmsCell);
    return charmsCell;
  }

  async add(newCharms: Cell<unknown>[]): Promise<void> {
    const defaultPattern = await this.getDefaultPattern();
    if (!defaultPattern) {
      throw new Error("Cannot add charms: default pattern not available");
    }

    // Use the shared schema that declares addCharm as a stream handler
    const cell = defaultPattern.asSchema(defaultPatternHandlersSchema);

    const addCharmHandler = cell.key("addCharm").get();
    if (!isStream(addCharmHandler)) {
      throw new Error(
        "Cannot add charms: addCharm handler not found on default pattern",
      );
    }

    // Send each charm and wait for transaction commit
    for (const charm of newCharms) {
      await new Promise<void>((resolve) => {
        addCharmHandler.send({ charm }, () => resolve());
      });
    }

    await this.runtime.idle();
    await this.synced();
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
    runIt: boolean = false,
    asSchema?: JSONSchema,
  ): Promise<Cell<T>> {
    // Get the charm cell
    const charm: Cell<unknown> = isCell(id)
      ? id
      : this.runtime.getCellFromEntityId(this.space, { "/": id });

    if (runIt) {
      // start() handles sync, recipe loading, and running
      // It's idempotent - no effect if already running
      await this.runtime.start(charm);
    } else {
      // Just sync the cell if not running
      await charm.sync();
    }

    // If caller provided a schema, use it
    if (asSchema) {
      return charm.asSchema<T>(asSchema);
    }

    // Otherwise, get result cell with schema from processCell.resultRef
    // The resultRef was created with includeSchema: true during setup
    const processCell = charm.getSourceCell();
    if (processCell) {
      const resultRefCell = processCell.key("resultRef").resolveAsCell();
      if (resultRefCell?.schema) {
        return charm.asSchema<T>(resultRefCell.schema);
      }
    }

    // Fallback: return charm without schema
    return charm as Cell<T>;
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
  async getReadingFrom(charm: Cell<unknown>): Promise<Cell<unknown>[]> {
    // Get all charms that might be referenced
    const charmsCell = await this.getCharms();
    const allCharms = charmsCell.get();
    const result: Cell<unknown>[] = [];
    const seenEntityIds = new Set<string>(); // Track entities we've already processed
    const maxDepth = 10; // Prevent infinite recursion
    const maxResults = 50; // Prevent too many results from overwhelming the UI
    const resolvedCharm = charm.resolveAsCell();

    if (!charm) return result;

    try {
      // Get the argument data - this is where references to other charms are stored
      const argumentCell = await this.getArgument(charm);
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

        if (matchingCharm) {
          const resolvedMatching = matchingCharm.resolveAsCell();
          const isNotSelf = !resolvedMatching.equals(resolvedCharm);
          const notAlreadyInResult = !result.some((c) =>
            c.resolveAsCell().equals(resolvedMatching)
          );

          if (isNotSelf && notAlreadyInResult && result.length < maxResults) {
            result.push(matchingCharm);
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
  async getReadByCharms(charm: Cell<unknown>): Promise<Cell<unknown>[]> {
    // Get all charms to check
    const charmsCell = await this.getCharms();
    const allCharms = charmsCell.get();
    const result: Cell<unknown>[] = [];
    const seenEntityIds = new Set<string>(); // Track entities we've already processed
    const maxDepth = 10; // Prevent infinite recursion
    const maxResults = 50; // Prevent too many results from overwhelming the UI

    if (!charm) return result;

    const charmId = getEntityId(charm);
    if (!charmId) return result;

    const resolvedCharm = charm.resolveAsCell();

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

      const resolvedOther = otherCharm.resolveAsCell();
      const notAlreadyInResult = !result.some((c) =>
        c.resolveAsCell().equals(resolvedOther)
      );

      if (notAlreadyInResult && result.length < maxResults) {
        result.push(otherCharm);
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
      if (otherCharm.resolveAsCell().equals(resolvedCharm)) continue; // Skip self

      if (checkRefersToTarget(otherCharm, otherCharm, new Set(), 0)) {
        addReadingCharm(otherCharm);
        continue; // Skip additional checks for this charm
      }

      // Also specifically check the argument data where references are commonly found
      try {
        const argumentCell = await this.getArgument(otherCharm);
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
      } catch (_) {
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

  // Return Cell with argument content, loading the recipe if needed.
  async getArgument<T = unknown>(
    charm: Cell<unknown | T>,
  ): Promise<Cell<T>> {
    const source = charm.getSourceCell(processSchema);
    const recipeId = source?.get()?.[TYPE]!;
    if (!recipeId) throw new Error("charm missing recipe ID");
    const recipe = await this.runtime.recipeManager.loadRecipe(
      recipeId,
      this.space,
    );
    return source.key("argument").asSchema<T>(recipe.argumentSchema);
  }

  getResult<T = unknown>(
    charm: Cell<T>,
  ): Cell<T> {
    // Get result cell with schema from processCell.resultRef
    const processCell = charm.getSourceCell();
    if (processCell) {
      const resultRefCell = processCell.key("resultRef").resolveAsCell();
      if (resultRefCell?.schema) {
        return charm.asSchema<T>(resultRefCell.schema);
      }
    }
    // Fallback: return charm without schema
    return charm;
  }

  // note: removing a charm doesn't clean up the charm's cells
  async remove(charm: Cell<unknown>) {
    const charmsCell = await this.getCharms();
    await this.syncCharms(charmsCell);

    // Check if this is the default pattern and clear the link
    const defaultPattern = await this.getDefaultPattern();
    if (
      defaultPattern &&
      charm.resolveAsCell().equals(defaultPattern.resolveAsCell())
    ) {
      await this.unlinkDefaultPattern();
    }

    const { ok } = await this.runtime.editWithRetry((tx) => {
      const charms = charmsCell.withTx(tx);

      // Remove from main list
      const newCharms = filterOutCell(charms, charm);
      if (newCharms.length !== charms.get().length) {
        charms.set(newCharms);
        return true;
      } else {
        return false;
      }
    });

    return !!ok;
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
    await this.runtime.start(charm);
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

  async sync(entity: Cell<unknown>, _waitForStorage: boolean = false) {
    await entity.sync();
  }

  // Returns the charm from our active charm list if it is present,
  // or undefined if it is not
  async getActiveCharm(charmCell: Cell<unknown>) {
    const charmsCell = await this.getCharms();
    const resolved = charmCell.resolveAsCell();
    return charmsCell.get().find((charm) =>
      charm.resolveAsCell().equals(resolved)
    );
  }

  async link(
    linkCharmId: string,
    linkPath: (string | number)[],
    targetCharmId: string,
    targetPath: (string | number)[],
    options?: { start?: boolean },
  ): Promise<void> {
    let linkCell = this.runtime.getCellFromEntityId(this.space, {
      "/": linkCharmId,
    });
    await linkCell.sync();
    linkCell = linkCell.asSchemaFromLinks(); // Make sure we have the full schema
    linkCell = linkCell.key(...linkPath);

    // Get target cell (charm or arbitrary cell)
    const { cell: targetCell, isCharm: targetIsCharm } =
      await getCellByIdOrCharm(
        this,
        targetCharmId,
        "Target",
        options,
      );

    await this.runtime.editWithRetry((tx) => {
      let targetInputCell = targetCell.withTx(tx);
      if (targetIsCharm) {
        // For charms, target fields are in the source cell's argument
        const sourceCell = targetCell.getSourceCell(processSchema);
        if (!sourceCell) {
          throw new Error("Target charm has no source cell");
        }
        targetInputCell = sourceCell.key("argument");
      }

      targetInputCell.key(...targetPath).resolveAsCell().setRaw(
        linkCell.getAsLink({
          base: targetInputCell,
          includeSchema: true,
          keepStreams: true,
        }),
      );
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
  options?: { start?: boolean },
): Promise<{ cell: Cell<unknown>; isCharm: boolean }> {
  const start = options?.start ?? true;
  try {
    // Try to get as a charm first
    const charm = await manager.get(cellId, start);
    if (!charm) {
      throw new Error(`Charm ${cellId} not found`);
    }
    return { cell: charm, isCharm: true };
  } catch (_) {
    // If manager.get() fails (e.g., "recipeId is required"), try as arbitrary cell ID
    try {
      const cell = await manager.getCellById({ "/": cellId });

      // Check if this cell is actually a charm by looking at the charms list
      const charmsCell = await manager.getCharms();
      const charms = charmsCell.get();
      const isActuallyCharm = charms.some((charm: Cell<unknown>) => {
        const id = charmId(charm);
        // If we can't get the charm ID, it's not a valid charm
        if (!id) return false;
        return id === cellId;
      });

      return { cell, isCharm: isActuallyCharm };
    } catch (_) {
      throw new Error(`${label} "${cellId}" not found as charm or cell`);
    }
  }
}
