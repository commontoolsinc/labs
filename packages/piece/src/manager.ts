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
  NameSchema,
  nameSchema,
  pieceListSchema,
  pieceSourceCellSchema,
  processSchema,
} from "@commontools/runner/schemas";
ensureNotRenderThread();

/**
 * Extracts the ID from a piece.
 * @param piece - The piece to extract ID from
 * @returns The piece ID string, or undefined if no ID is found
 */
export function pieceId(piece: Cell<unknown>): string | undefined {
  const id = piece.entityId;
  if (!id) return undefined;
  const idValue = id["/"];
  return typeof idValue === "string" ? idValue : undefined;
}

/**
 * Filters an array of pieces by removing any that match the target cell
 */
function filterOutCell(
  list: Cell<Cell<unknown>[]>,
  target: Cell<unknown>,
): Cell<unknown>[] {
  const resolvedTarget = target.resolveAsCell();
  return list.get().filter((piece) =>
    !piece.resolveAsCell().equals(resolvedTarget)
  );
}

export class PieceManager {
  private space: MemorySpace;

  private spaceCell: Cell<SpaceCellContents>;

  /**
   * Promise resolved when the piece manager is ready.
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

    // Note: allPieces and recentPieces are now managed by the default pattern,
    // not directly on the space cell. The space cell only contains a link to defaultPattern.
    // Default pattern creation is handled by PiecesController.ensureDefaultPattern()
    // which is called by CLI/shell entry points. PieceManager doesn't auto-create it.
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
   * Get the cell containing the list of all pieces in this space.
   * Reads from the default pattern's allPieces export.
   */
  async getPieces(): Promise<Cell<Cell<unknown>[]>> {
    const defaultPattern = await this.getDefaultPattern();
    if (!defaultPattern) {
      // Return empty array cell if no default pattern
      return this.runtime.getCell(this.space, "empty-pieces", pieceListSchema);
    }

    const cell = defaultPattern.asSchema({
      type: "object",
      properties: {
        allPieces: pieceListSchema,
      },
    });
    const piecesCell = cell.key("allPieces") as Cell<Cell<unknown>[]>;
    await this.syncPieces(piecesCell);
    return piecesCell;
  }

  async add(newPieces: Cell<unknown>[]): Promise<void> {
    const defaultPattern = await this.getDefaultPattern();
    if (!defaultPattern) {
      throw new Error("Cannot add pieces: default pattern not available");
    }

    const cell = defaultPattern.asSchema({
      type: "object",
      properties: {
        addPiece: { asStream: true },
      },
    });

    const addPieceHandler = cell.key("addPiece").get();
    if (!isStream(addPieceHandler)) {
      throw new Error(
        "Cannot add pieces: addPiece handler not found on default pattern",
      );
    }

    // Send each piece and wait for transaction commit.
    // The onCommit callback fires both on success AND when retries are
    // exhausted (scheduler.ts ~line 2089). We must check tx.status() to
    // distinguish the two — otherwise pieces are silently dropped.
    //
    // When the addPiece handler's transaction conflicts (e.g. during
    // default-app reactive graph stabilization), we retry after waiting
    // for the scheduler to settle. The idle() wait is key: the conflict
    // happens because computed values are still updating concurrently,
    // and once idle the graph has stabilized.
    const MAX_ADD_RETRIES = 3;
    for (const piece of newPieces) {
      let lastError: Error | undefined;
      for (let attempt = 0; attempt < MAX_ADD_RETRIES; attempt++) {
        try {
          await new Promise<void>((resolve, reject) => {
            addPieceHandler.send({ piece }, (tx) => {
              if (tx.status().status === "error") {
                reject(
                  new Error(
                    "Piece registration failed: addPiece transaction aborted after retries",
                  ),
                );
              } else {
                resolve();
              }
            });
          });
          lastError = undefined;
          break;
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
          // Wait for the reactive graph to settle before retrying
          await this.runtime.idle();
        }
      }
      if (lastError) {
        throw lastError;
      }
    }

    await this.runtime.idle();
    await this.synced();
  }

  syncPieces(cell: Cell<Cell<unknown>[]>) {
    // TODO(@ubik2) We use elevated permissions here temporarily.
    // Our request for the piece list will walk the schema tree, and that will
    // take us into classified data of pieces. If that happens, we still want
    // this bit to work, so we elevate this request.
    const privilegedSchema = {
      ...pieceListSchema,
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
    // Get the piece cell
    const piece: Cell<unknown> = isCell(id)
      ? id
      : this.runtime.getCellFromEntityId(this.space, { "/": id });

    if (runIt) {
      // start() handles sync, recipe loading, and running
      // It's idempotent - no effect if already running
      await this.runtime.start(piece);
    } else {
      // Just sync the cell if not running
      await piece.sync();
    }

    // If caller provided a schema, use it
    if (asSchema) {
      return piece.asSchema<T>(asSchema);
    }

    // Otherwise, get result cell with schema from processCell.resultRef
    // The resultRef was created with includeSchema: true during setup
    const processCell = piece.getSourceCell();
    if (processCell) {
      const resultRefCell = processCell.key("resultRef").resolveAsCell();
      if (resultRefCell?.schema) {
        return piece.asSchema<T>(resultRefCell.schema);
      }
    }

    // Fallback: return piece without schema
    return piece as Cell<T>;
  }

  getLineage(piece: Cell<unknown>) {
    return piece.getSourceCell(pieceSourceCellSchema)?.key("lineage").get() ??
      [];
  }

  getLLMTrace(piece: Cell<unknown>): string | undefined {
    return piece.getSourceCell(pieceSourceCellSchema)?.key("llmRequestId")
      .get() ?? undefined;
  }

  /**
   * Find all pieces that the given piece reads data from via aliases or links.
   * This identifies dependencies that the piece has on other pieces.
   * @param piece The piece to check
   * @returns Array of pieces that are read from
   */
  async getReadingFrom(piece: Cell<unknown>): Promise<Cell<unknown>[]> {
    // Get all pieces that might be referenced
    const piecesCell = await this.getPieces();
    const allPieces = piecesCell.get();
    const result: Cell<unknown>[] = [];
    const seenEntityIds = new Set<string>(); // Track entities we've already processed
    const maxDepth = 10; // Prevent infinite recursion
    const maxResults = 50; // Prevent too many results from overwhelming the UI
    const resolvedPiece = piece.resolveAsCell();

    if (!piece) return result;

    try {
      // Get the argument data - this is where references to other pieces are stored
      const argumentCell = await this.getArgument(piece);
      if (!argumentCell) return result;

      // Get the raw argument value
      let argumentValue;

      try {
        argumentValue = argumentCell.getRaw();
      } catch (err) {
        console.debug("Error getting argument value:", err);
        return result;
      }

      // Helper function to add a matching piece to the result
      const addMatchingPiece = (docId: EntityId) => {
        if (!docId || !docId["/"]) return;

        const entityIdStr = typeof docId["/"] === "string"
          ? docId["/"]
          : JSON.stringify(docId["/"]);

        // Skip if we've already processed this entity
        if (seenEntityIds.has(entityIdStr)) return;
        seenEntityIds.add(entityIdStr);

        // Find matching piece by entity ID
        const matchingPiece = allPieces.find((c) => {
          const cId = getEntityId(c);
          return cId && docId["/"] === cId["/"];
        });

        if (matchingPiece) {
          const resolvedMatching = matchingPiece.resolveAsCell();
          const isNotSelf = !resolvedMatching.equals(resolvedPiece);
          const notAlreadyInResult = !result.some((c) =>
            c.resolveAsCell().equals(resolvedMatching)
          );

          if (isNotSelf && notAlreadyInResult && result.length < maxResults) {
            result.push(matchingPiece);
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
              addMatchingPiece(getEntityId(link.id)!);
            }

            const sourceRefId = followSourceToResultRef(
              this.runtime.getCellFromLink(link),
              new Set(),
              0,
            );
            if (sourceRefId) addMatchingPiece(sourceRefId);
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
      console.debug("Error finding references in piece arguments:", error);
      // Don't throw the error - return an empty result instead
    }

    return result;
  }

  /**
   * Find all pieces that read data from the given piece via aliases or links.
   * This identifies which pieces depend on this piece.
   * @param piece The piece to check
   * @returns Array of pieces that read from this piece
   */
  async getReadByPieces(piece: Cell<unknown>): Promise<Cell<unknown>[]> {
    // Get all pieces to check
    const piecesCell = await this.getPieces();
    const allPieces = piecesCell.get();
    const result: Cell<unknown>[] = [];
    const seenEntityIds = new Set<string>(); // Track entities we've already processed
    const maxDepth = 10; // Prevent infinite recursion
    const maxResults = 50; // Prevent too many results from overwhelming the UI

    if (!piece) return result;

    const pieceId = getEntityId(piece);
    if (!pieceId) return result;

    const resolvedPiece = piece.resolveAsCell();

    // Helper function to add a matching piece to the result
    const addReadingPiece = (otherPiece: Cell<unknown>) => {
      const otherPieceId = getEntityId(otherPiece);
      if (!otherPieceId || !otherPieceId["/"]) return;

      const entityIdStr = typeof otherPieceId["/"] === "string"
        ? otherPieceId["/"]
        : JSON.stringify(otherPieceId["/"]);

      // Skip if we've already processed this entity
      if (seenEntityIds.has(entityIdStr)) return;
      seenEntityIds.add(entityIdStr);

      const resolvedOther = otherPiece.resolveAsCell();
      const notAlreadyInResult = !result.some((c) =>
        c.resolveAsCell().equals(resolvedOther)
      );

      if (notAlreadyInResult && result.length < maxResults) {
        result.push(otherPiece);
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

    // Helper to check if a document refers to our target piece
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
            if (link.id === piece.sourceURI) return true;

            // Check if cell link's source chain leads to our target
            const sourceResultRefURI = followSourceToResultRef(
              this.runtime.getCellFromLink(link),
              new Set(),
              0,
            );
            if (sourceResultRefURI === piece.sourceURI) return true;
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

    // Check each piece to see if it references this piece
    for (const otherPiece of allPieces) {
      if (otherPiece.resolveAsCell().equals(resolvedPiece)) continue; // Skip self

      if (checkRefersToTarget(otherPiece, otherPiece, new Set(), 0)) {
        addReadingPiece(otherPiece);
        continue; // Skip additional checks for this piece
      }

      // Also specifically check the argument data where references are commonly found
      try {
        const argumentCell = await this.getArgument(otherPiece);
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
              addReadingPiece(otherPiece);
            }
          }
        }
      } catch (_) {
        // Error checking argument references for piece
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
    piece: Cell<unknown | T>,
  ): Promise<Cell<T>> {
    const source = piece.getSourceCell(processSchema);
    const recipeId = source?.get()?.[TYPE]!;
    if (!recipeId) throw new Error("piece missing recipe ID");
    const recipe = await this.runtime.recipeManager.loadRecipe(
      recipeId,
      this.space,
    );
    return source.key("argument").asSchema<T>(recipe.argumentSchema);
  }

  getResult<T = unknown>(
    piece: Cell<T>,
  ): Cell<T> {
    // Get result cell with schema from processCell.resultRef
    const processCell = piece.getSourceCell();
    if (processCell) {
      const resultRefCell = processCell.key("resultRef").resolveAsCell();
      if (resultRefCell?.schema) {
        return piece.asSchema<T>(resultRefCell.schema);
      }
    }
    // Fallback: return piece without schema
    return piece;
  }

  // note: removing a piece doesn't clean up the piece's cells
  async remove(piece: Cell<unknown>) {
    const piecesCell = await this.getPieces();
    await this.syncPieces(piecesCell);

    // Check if this is the default pattern and clear the link
    const defaultPattern = await this.getDefaultPattern();
    if (
      defaultPattern &&
      piece.resolveAsCell().equals(defaultPattern.resolveAsCell())
    ) {
      await this.unlinkDefaultPattern();
    }

    const { ok } = await this.runtime.editWithRetry((tx) => {
      const pieces = piecesCell.withTx(tx);

      // Remove from main list
      const newPieces = filterOutCell(pieces, piece);
      if (newPieces.length !== pieces.get().length) {
        pieces.set(newPieces);
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
    const piece = await this.setupPersistent<T>(
      recipe,
      inputs,
      cause,
      llmRequestId,
    );
    if (start) {
      await this.startPiece(piece);
    }
    return piece;
  }

  // Consistently return the `Cell<Piece>` of piece with
  // id `pieceId`, applies the provided `recipe` (which may be
  // its current recipe -- useful when we are only updating inputs),
  // and optionally applies `inputs` if provided.
  async runWithRecipe(
    recipe: Recipe | Module,
    pieceId: string,
    inputs?: object,
    options?: { start?: boolean },
  ): Promise<Cell<unknown>> {
    const piece = this.runtime.getCellFromEntityId(this.space, {
      "/": pieceId,
    });
    await piece.sync();
    const start = options?.start ?? true;
    if (start) {
      await this.runtime.runSynced(piece, recipe, inputs);
    } else {
      this.runtime.setup(undefined, recipe, inputs ?? {}, piece);
    }
    await this.syncRecipe(piece);

    return piece;
  }

  /**
   * Prepare a new piece by setting up its process/result cells and recipe
   * metadata without scheduling the recipe's nodes.
   */
  async setupPersistent<T = unknown>(
    recipe: Recipe | Module,
    inputs?: unknown,
    cause?: unknown,
    llmRequestId?: string,
  ): Promise<Cell<T>> {
    await this.runtime.idle();
    const piece = this.runtime.getCell<T>(
      this.space,
      cause,
      recipe.resultSchema,
    );
    this.runtime.setup(undefined, recipe, inputs ?? {}, piece);
    await this.syncRecipe(piece);

    if (llmRequestId) {
      this.runtime.editWithRetry((tx) => {
        piece.getSourceCell(pieceSourceCellSchema)?.key("llmRequestId")
          .withTx(tx)
          .set(llmRequestId);
      });
    }

    return piece;
  }

  /** Start scheduling and running a prepared piece. */
  async startPiece<T = unknown>(pieceOrId: string | Cell<T>): Promise<void> {
    const piece = typeof pieceOrId === "string"
      ? await this.get<T>(pieceOrId)
      : pieceOrId;
    if (!piece) throw new Error("Piece not found");
    await this.runtime.start(piece);
    await this.runtime.idle();
    await this.synced();
  }

  /** Stop a running piece (no-op if not running). */
  async stopPiece<T = unknown>(pieceOrId: string | Cell<T>): Promise<void> {
    const piece = typeof pieceOrId === "string"
      ? await this.get<T>(pieceOrId)
      : pieceOrId;
    if (!piece) throw new Error("Piece not found");
    this.runtime.runner.stop(piece);
    await this.runtime.idle();
  }

  // FIXME(JA): this really really really needs to be revisited
  async syncRecipe(piece: Cell<unknown>) {
    await piece.sync();

    // When we subscribe to a doc, our subscription includes the doc's source,
    // so get that.
    const sourceCell = piece.getSourceCell();
    if (!sourceCell) throw new Error("piece missing source cell");
    await sourceCell.sync();

    const recipeId = sourceCell.get()?.[TYPE];
    if (!recipeId) throw new Error("piece missing recipe ID");

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

  // Returns the piece from our active piece list if it is present,
  // or undefined if it is not
  async getActivePiece(pieceCell: Cell<unknown>) {
    const piecesCell = await this.getPieces();
    const resolved = pieceCell.resolveAsCell();
    return piecesCell.get().find((piece) =>
      piece.resolveAsCell().equals(resolved)
    );
  }

  async link(
    linkPieceId: string,
    linkPath: (string | number)[],
    targetPieceId: string,
    targetPath: (string | number)[],
    options?: { start?: boolean },
  ): Promise<void> {
    let linkCell = this.runtime.getCellFromEntityId(this.space, {
      "/": linkPieceId,
    });
    await linkCell.sync();
    linkCell = linkCell.asSchemaFromLinks(); // Make sure we have the full schema
    linkCell = linkCell.key(...linkPath);

    // Get target cell (piece or arbitrary cell)
    const { cell: targetCell, isPiece: targetIsPiece } =
      await getCellByIdOrPiece(
        this,
        targetPieceId,
        "Target",
        options,
      );

    await this.runtime.editWithRetry((tx) => {
      let targetInputCell = targetCell.withTx(tx);
      if (targetIsPiece) {
        // For pieces, target fields are in the source cell's argument
        const sourceCell = targetInputCell.getSourceCell(processSchema);
        if (!sourceCell) {
          throw new Error("Target piece has no source cell");
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

export const getRecipeIdFromPiece = (piece: Cell<unknown>): string => {
  const sourceCell = piece.getSourceCell(processSchema);
  if (!sourceCell) throw new Error("piece missing source cell");
  return sourceCell.get()?.[TYPE]!;
};

async function getCellByIdOrPiece(
  manager: PieceManager,
  cellId: string,
  label: string,
  options?: { start?: boolean },
): Promise<{ cell: Cell<unknown>; isPiece: boolean }> {
  const start = options?.start ?? true;
  try {
    // Try to get as a piece first
    const piece = await manager.get(cellId, start);
    if (!piece) {
      throw new Error(`Piece ${cellId} not found`);
    }
    return { cell: piece, isPiece: true };
  } catch (_) {
    // If manager.get() fails (e.g., "recipeId is required"), try as arbitrary cell ID
    try {
      const cell = await manager.getCellById({ "/": cellId });

      // Check if this cell is actually a piece by looking at the pieces list
      const piecesCell = await manager.getPieces();
      const pieces = piecesCell.get();
      const isActuallyPiece = pieces.some((piece: Cell<unknown>) => {
        const id = pieceId(piece);
        // If we can't get the piece ID, it's not a valid piece
        if (!id) return false;
        return id === cellId;
      });

      return { cell, isPiece: isActuallyPiece };
    } catch (_) {
      throw new Error(`${label} "${cellId}" not found as piece or cell`);
    }
  }
}
