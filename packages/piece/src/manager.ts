import {
  type Cell,
  cellEntityIdString,
  Console as RuntimeConsole,
  EntityId,
  entityIdFrom,
  getEntityId,
  getMetaLink,
  getPatternIdentityRef,
  isCell,
  isLink,
  isStream,
  JSONSchema,
  KeepAsCell,
  type MemorySpace,
  Module,
  parseLink,
  Pattern,
  Runtime,
  type Schema,
  type SpaceCellContents,
} from "@commonfabric/runner";
import type { CellScope } from "@commonfabric/api";
import { cfcAtom } from "@commonfabric/api/cfc";
import {
  type EntityRef,
  entityRefToString,
  isEntityRef,
} from "@commonfabric/data-model/cell-rep";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { type Session } from "@commonfabric/identity";
import { isRecord } from "@commonfabric/utils/types";
import { getLogger } from "@commonfabric/utils/logger";
import { ensureNotRenderThread } from "@commonfabric/utils/env";
import {
  NameSchema,
  nameSchema,
  pieceListSchema,
} from "@commonfabric/runner/schemas";
import { getResultCellWithSourceSchema } from "../../runner/src/piece-helpers.ts";
ensureNotRenderThread();

const PRIVILEGED_PIECE_LIST_SCHEMA = internSchema({
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  default: [],
  ifc: { confidentiality: [cfcAtom.resource("PrivilegedPieceList")] },
});

/**
 * Extracts the ID from a piece.
 * @param piece - The piece to extract ID from
 * @returns The piece ID string, or undefined if no ID is found
 */
export function pieceId(piece: Cell<unknown>): string | undefined {
  return cellEntityIdString(piece);
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

const PIECE_TRACE_TIMINGS = typeof Deno !== "undefined" &&
  Deno.env.get("CF_CLI_TRACE_TIMINGS") === "1";

// Timing stats record even while the logger is disabled, so every phase is
// visible in the load summaries (browser worker included, where the
// CF_CLI_TRACE_TIMINGS console path cannot run) as `piece/phase/<label>`.
const pieceTimingLogger = getLogger("piece", { enabled: false });

async function timePiecePhase<T>(
  label: string,
  run: () => T | Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    return await run();
  } finally {
    pieceTimingLogger.time(start, "phase", label);
    if (PIECE_TRACE_TIMINGS) {
      const elapsed = Math.round(performance.now() - start);
      console.error(`[piece-phase] ${elapsed}ms :: ${label}`);
    }
  }
}

export class PieceManager {
  private space: MemorySpace;

  private spaceCell: Cell<SpaceCellContents>;

  private diagnosticConsole: RuntimeConsole;

  /**
   * Promise resolved when the piece manager is ready.
   */
  ready: Promise<void>;

  constructor(
    private session: Session,
    public runtime: Runtime,
  ) {
    this.diagnosticConsole = new RuntimeConsole(runtime.harness);
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
  async getDefaultPattern(
    runIt: boolean = true,
  ): Promise<Cell<NameSchema> | undefined> {
    const cell = await timePiecePhase(
      "getDefaultPattern.spaceCell.sync",
      () => this.spaceCell.key("defaultPattern").sync(),
    );
    const defaultPattern = cell.get();
    if (!defaultPattern) {
      return undefined;
    }

    await timePiecePhase(
      "getDefaultPattern.defaultPattern.sync",
      () => defaultPattern.sync(),
    );
    if (
      defaultPattern.getRaw() === undefined &&
      getPatternIdentityRef(defaultPattern) === undefined
    ) {
      return undefined;
    }
    return await timePiecePhase(
      `getDefaultPattern.get(runIt=${runIt})`,
      () =>
        this.get(
          defaultPattern,
          runIt,
          nameSchema,
        ),
    );
  }

  /**
   * Get the cell containing the list of all pieces in this space.
   * Reads from the default pattern's allPieces export.
   */
  async getPieces(): Promise<Cell<Cell<unknown>[]>> {
    const defaultPattern = await this.getDefaultPattern(true);
    if (!defaultPattern) {
      // Return empty array cell if no default pattern. Loud on purpose: any
      // subscription made against this placeholder never fires again, so a
      // cold-cache miss here silently freezes piece listings (e.g. FUSE).
      console.warn(
        `getPieces: no default pattern found for space ${this.space}; ` +
          "returning detached empty piece list",
      );
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
    const defaultPattern = await timePiecePhase(
      "add.getDefaultPattern",
      () => this.getDefaultPattern(true),
    );
    if (!defaultPattern) {
      throw new Error("Cannot add pieces: default pattern not available");
    }

    const cell = defaultPattern.asSchema({
      type: "object",
      properties: {
        addPiece: { asCell: ["stream"] },
      },
    });

    const addPieceHandler = await cell.key("addPiece").pull();
    if (!isStream(addPieceHandler)) {
      throw new Error(
        "Cannot add pieces: addPiece handler not found on default pattern",
      );
    }

    // Send each piece and wait for transaction commit.
    // The onCommit callback fires both on success AND when retries are
    // exhausted (scheduler.ts ~line 2089). We check tx.status() to
    // distinguish the two — otherwise pieces are silently dropped.
    // Retries are handled by the scheduler internally.
    for (const piece of newPieces) {
      await timePiecePhase(
        "add.send",
        () =>
          new Promise<void>((resolve, reject) => {
            addPieceHandler.send({ piece }, (tx) => {
              const txStatus = tx.status();
              if (txStatus.status === "error") {
                console.error(
                  "Piece registration failed: addPiece transaction error:",
                  txStatus.error,
                );
                reject(
                  new Error(
                    "Piece registration failed: addPiece transaction aborted after retries",
                  ),
                );
              } else {
                resolve();
              }
            });
          }),
      );
    }

    await timePiecePhase("add.runtime.idle", () => this.runtime.idle());
    await timePiecePhase("add.synced", () => this.synced());
  }

  syncPieces(cell: Cell<Cell<unknown>[]>) {
    // TODO(@ubik2) We use elevated permissions here temporarily.
    // Our request for the piece list will walk the schema tree, and that will
    // take us into confidential data of pieces. If that happens, we still want
    // this bit to work, so we elevate this request.
    return cell.asSchema(PRIVILEGED_PIECE_LIST_SCHEMA).pull();
  }

  async get<S extends JSONSchema = JSONSchema>(
    id: string | Cell<unknown>,
    runIt: boolean,
    asSchema: S,
    scope?: CellScope,
  ): Promise<Cell<Schema<S>>>;
  async get<T = unknown>(
    id: string | Cell<unknown>,
    runIt?: boolean,
    asSchema?: JSONSchema,
    scope?: CellScope,
  ): Promise<Cell<T>>;
  async get<T = unknown>(
    id: string | Cell<unknown>,
    runIt: boolean = false,
    asSchema?: JSONSchema,
    scope?: CellScope,
  ): Promise<Cell<T>> {
    // Get the piece cell
    const addressed: Cell<unknown> = isCell(id)
      ? id
      : this.runtime.getCellFromEntityId(
        this.space,
        entityIdFrom(id),
        [],
        undefined,
        undefined,
        scope,
      );

    // Load the addressed cell. Syncing a value-link "slot" address also loads
    // its link target — the piece's canonical result cell — together with that
    // cell's `argument`/`patternIdentity` meta, because the query follows the
    // top-of-doc value link and returns the target's meta docs. So this one sync
    // makes both the slot and the canonical cell (with its metadata) local.
    await timePiecePhase("get.piece.sync", () => addressed.sync());

    // Canonicalize the value-link "slot" to the piece's canonical result cell.
    // A piece created inside a handler and stored into a list/object (e.g. the
    // topics board's `addTopic` doing `topics.push(Topic({...}))`) is addressed
    // by a plain value-link that redirects to the result cell, where setup wrote
    // `patternIdentity` and the `argument` meta-link. start() needs that identity
    // and reads need that metadata, so resolving here makes start / read / stop
    // operate on the real piece rather than the wrapper. The sync above already
    // made the canonical cell local, so this resolves over local links with no
    // further sync. Idempotent for a normal top-level piece.
    const piece = addressed.resolveAsCell();

    if (runIt) {
      // start() handles pattern loading and running. It's idempotent - no
      // effect if already running.
      await timePiecePhase(
        "get.runtime.start",
        () => this.runtime.start(piece),
      );
    }

    // If caller provided a schema, use it
    if (asSchema) {
      return piece.asSchema<T>(asSchema);
    }

    // Otherwise, recover the result schema from the cell's metadata if present.
    return getResultCellWithSourceSchema(piece as Cell<T>);
  }

  /**
   * Find all pieces that the given piece reads data from via sigil links.
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
        this.diagnosticConsole.debug("Error getting argument value:", err);
        return result;
      }

      // Helper function to add a matching piece to the result
      const addMatchingPiece = (docId: EntityRef) => {
        if (!isEntityRef(docId)) return;

        const entityIdStr = entityRefToString(docId);

        // Skip if we've already processed this entity
        if (seenEntityIds.has(entityIdStr)) return;
        seenEntityIds.add(entityIdStr);

        // Find matching piece by entity ID
        const matchingPiece = allPieces.find((c) => {
          const cId = getEntityId(c);
          return isEntityRef(cId) && entityRefToString(cId) === entityIdStr;
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

      // Find references in the argument structure
      const processValue = (
        value: unknown,
        parent: Cell<unknown>,
        visited = new Set<unknown>(), // Track objects directly, not string representations
        depth = 0,
      ) => {
        // TODO(danfuzz): The argument value here is `argumentCell.getRaw()`, a
        // raw `FabricValue`; this `isRecord`/`Object.keys` walk (guards only
        // `isLink`) decomposes a `FabricPrimitive` and walks a `FabricInstance`
        // by internal slots rather than codec contents.
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

            const resultCell = followCellToResult(
              this.runtime.getCellFromLink(link),
              this.diagnosticConsole,
              new Set(),
              0,
            );
            if (resultCell !== undefined) addMatchingPiece(resultCell.entityId);
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
                this.diagnosticConsole.debug(
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
                this.diagnosticConsole.debug(
                  `Error processing object property '${key}':`,
                  err,
                );
              }
            }
          }
        } catch (err) {
          this.diagnosticConsole.debug("Error in processValue:", err);
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
      this.diagnosticConsole.debug(
        "Error finding references in piece arguments:",
        error,
      );
      // Don't throw the error - return an empty result instead
    }

    return result;
  }

  /**
   * Find all pieces that read data from the given piece via sigil links.
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
      if (!isEntityRef(otherPieceId)) return;

      const entityIdStr = entityRefToString(otherPieceId);

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

    // Helper to check if a document refers to our target piece
    const checkRefersToTarget = (
      value: unknown,
      parent: Cell<unknown>,
      visited = new Set<unknown>(), // Track objects directly, not string representations
      depth = 0,
    ): boolean => {
      // TODO(danfuzz): Same as `processValue` above — walks a raw `FabricValue`
      // (`getRaw()`) by enumerable own-props with no `FabricSpecialObject`
      // guard, mishandling `FabricPrimitive` and `FabricInstance`.
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
            const resultCell = followCellToResult(
              this.runtime.getCellFromLink(link),
              this.diagnosticConsole,
              new Set(),
              0,
            );
            if (resultCell?.sourceURI === piece.sourceURI) return true;
          } catch (err) {
            this.diagnosticConsole.debug(
              "Error handling cell link in checkRefersToTarget:",
              err,
            );
          }
          return false; // Don't traverse runtime metadata link contents
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
              this.diagnosticConsole.debug(
                `Error checking array item at index ${i}:`,
                err,
              );
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
              this.diagnosticConsole.debug(
                `Error checking object property '${key}':`,
                err,
              );
            }
          }
        }
      } catch (err) {
        this.diagnosticConsole.debug("Error in checkRefersToTarget:", err);
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
    scope?: CellScope,
  ): Promise<Cell<T>> {
    const cell = this.runtime.getCellFromEntityId<T>(
      this.space,
      id,
      path,
      schema,
      undefined,
      scope,
    );
    await cell.sync();
    return cell;
  }

  // Return Cell with argument content, loading the pattern if needed.
  getArgument<T = unknown>(
    piece: Cell<unknown | T>,
  ): Cell<T> {
    // The piece is a result cell; read its argument metadata link directly.
    // With this approach, we aren't using the argumentSchema from the pattern
    // but that should have been written into the Result Cell's argument link.
    const argumentLink = getMetaLink(piece, "argument", {});
    if (argumentLink === undefined) {
      throw new Error("piece missing argument cell");
    }
    return this.runtime.getCellFromLink(argumentLink);
  }

  getResult<T = unknown>(
    piece: Cell<T>,
  ): Cell<T> {
    return piece;
  }

  // note: removing a piece doesn't clean up the piece's cells
  async remove(piece: Cell<unknown>) {
    const piecesCell = await this.getPieces();
    await this.syncPieces(piecesCell);

    // Check if this is the default pattern and clear the link
    const defaultPattern = await this.getDefaultPattern(false);
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
    pattern: Pattern | Module,
    inputs?: unknown,
    cause?: unknown,
    options?: { start?: boolean; repository?: string },
  ): Promise<Cell<T>> {
    const start = options?.start ?? true;
    const piece = await this.setupPersistent<T>(
      pattern,
      inputs,
      cause,
      { repository: options?.repository },
    );
    if (start) {
      await this.startPiece(piece);
    }
    return piece;
  }

  // Consistently return the `Cell<Piece>` of piece with
  // id `pieceId`, applies the provided `pattern` (which may be
  // its current pattern -- useful when we are only updating inputs),
  // and optionally applies `inputs` if provided.
  async runWithPattern(
    pattern: Pattern | Module,
    pieceId: string,
    inputs?: object,
    options?: {
      start?: boolean;
      expectedPatternIdentity?: { identity: string; symbol: string };
      validateArgumentLinks?: (
        argumentCell: Cell<unknown>,
        argumentSchema: JSONSchema,
      ) => void;
      repository?: string;
    },
  ): Promise<Cell<unknown>> {
    const piece = this.runtime.getCellFromEntityId(
      this.space,
      entityIdFrom(pieceId),
    );
    await piece.sync();
    const start = options?.start ?? true;
    let currentPiece = piece;
    if (start) {
      currentPiece = await this.runtime.runSynced(piece, pattern, inputs, {
        expectedPatternIdentity: options?.expectedPatternIdentity,
        patternRepository: options?.repository,
        validateArgumentLinks: options?.validateArgumentLinks,
      });
    } else {
      if (options?.expectedPatternIdentity) {
        throw new Error("atomic pattern updates require starting the piece");
      }
      await this.runtime.setup(undefined, pattern, inputs ?? {}, piece, {
        patternRepository: options?.repository,
      });
    }
    await this.syncPattern(currentPiece);
    if (start) {
      await this.getResult(currentPiece).pull();
    }

    return currentPiece;
  }

  /**
   * Prepare a new piece by setting up its process/result cells and pattern
   * metadata without scheduling the pattern's nodes.
   */
  async setupPersistent<T = unknown>(
    pattern: Pattern | Module,
    inputs?: unknown,
    cause?: unknown,
    options?: { repository?: string },
  ): Promise<Cell<T>> {
    await timePiecePhase(
      "setupPersistent.runtime.idle",
      () => this.runtime.idle(),
    );
    const piece = this.runtime.getCell<T>(
      this.space,
      cause ?? { space: this.space, random: crypto.randomUUID() },
      pattern.resultSchema,
    );
    // Fast path: the pattern's content-addressed entry ref, if it carries one
    // (every space-compiled pattern does). Lets us load by identity without
    // waiting for the piece's `patternIdentity` meta to settle.
    const knownEntryRef = this.runtime.patternManager.getArtifactEntryRef(
      pattern,
    );
    await timePiecePhase(
      "setupPersistent.runtime.setup",
      () =>
        this.runtime.setup(undefined, pattern, inputs ?? {}, piece, {
          patternRepository: options?.repository,
        }),
    );
    await timePiecePhase(
      "setupPersistent.syncPattern",
      () =>
        knownEntryRef
          ? this.syncPatternByIdentity(knownEntryRef)
          : this.syncPattern(piece),
    );

    return piece;
  }

  /** Start scheduling and running a prepared piece. */
  async startPiece<T = unknown>(
    pieceOrId: string | Cell<T>,
    options: { schedulePatternUpdate?: boolean } = {},
  ): Promise<void> {
    const piece = typeof pieceOrId === "string"
      ? await timePiecePhase("startPiece.get", () => this.get<T>(pieceOrId))
      : pieceOrId;
    if (!piece) throw new Error("Piece not found");
    await timePiecePhase(
      "startPiece.runtime.start",
      () => this.runtime.start(piece, options),
    );
    await timePiecePhase(
      "startPiece.result.pull",
      () => this.getResult(piece).pull(),
    );
    await timePiecePhase("startPiece.synced", () => this.synced());
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
  async syncPattern(piece: Cell<unknown>) {
    await timePiecePhase("syncPattern.piece.sync", () => piece.sync());

    // When we subscribe to a doc, our subscription includes the doc's pattern
    // pointer (`patternIdentity`), so read that.
    let ref = getPatternIdentityRef(piece);
    if (!ref) {
      // Under remote sync, metadata can transiently lag the result value even
      // though setup just wrote both. Wait for storage to settle and retry once
      // before treating the pattern metadata as missing.
      await timePiecePhase("syncPattern.retry.synced", () => this.synced());
      await timePiecePhase("syncPattern.retry.piece.sync", () => piece.sync());
      ref = getPatternIdentityRef(piece);
    }
    if (!ref) throw new Error("piece missing pattern identity");

    return await timePiecePhase(
      "syncPattern.loadPattern",
      () => this.syncPatternByIdentity(ref),
    );
  }

  async syncPatternByIdentity(ref: { identity: string; symbol: string }) {
    if (!ref) throw new Error("pattern identity is required");
    const pattern = await this.runtime.patternManager.loadPatternByIdentity(
      ref.identity,
      ref.symbol,
      this.space,
    );
    return pattern;
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

  /**
   * Set the target cell's argument cell at target path to be a link to the
   * link cell's content at linkPath.
   *
   * @param linkPieceId
   * @param linkPath
   * @param targetPieceId
   * @param targetPath
   * @param options
   */
  async link(
    linkPieceId: string,
    linkPath: (string | number)[],
    targetPieceId: string,
    targetPath: (string | number)[],
    options?: {
      start?: boolean;
      sourceScope?: CellScope;
      targetScope?: CellScope;
    },
  ): Promise<void> {
    const start = options?.start ?? true;
    let linkCell = this.runtime.getCellFromEntityId(
      this.space,
      entityIdFrom(linkPieceId),
      [],
      undefined,
      undefined,
      options?.sourceScope,
    );
    await linkCell.sync();
    linkCell = linkCell.asSchemaFromLinks(); // Make sure we have the full schema
    linkCell = linkCell.key(...linkPath);
    // Keep Piece result links anchored at the public result projection. Its
    // durable, monotonically narrowing result schema is the producer contract;
    // resolving through an alias here would discard that contract and point at
    // an untyped internal cell instead.

    // Get target cell (piece or arbitrary cell)
    const { cell: targetCell, isPiece: targetIsPiece } =
      await getCellByIdOrPiece(
        this,
        targetPieceId,
        "Target",
        options,
      );

    const result = await this.runtime.editWithRetry((tx) => {
      let targetInputCell = targetCell.withTx(tx);
      if (targetIsPiece) {
        // For pieces, target fields are in the result cell's argument
        const resultCell = followCellToResult(
          targetInputCell,
          this.diagnosticConsole,
        );
        if (!resultCell) {
          throw new Error("Target piece has no result cell");
        }
        const targetArgumentLink = getMetaLink(resultCell, "argument");
        if (targetArgumentLink === undefined) {
          throw new Error("Target piece has no argument cell");
        }
        targetInputCell = resultCell.runtime.getCellFromLink(
          targetArgumentLink,
          undefined,
          tx,
        );
      }

      targetInputCell.key(...targetPath).setRawUntyped(
        linkCell.getAsLink({
          base: targetInputCell,
          includeSchema: true,
          keepAsCell: KeepAsCell.OnlyStream,
        }),
      );
    });
    if (result.error) throw result.error;

    if (targetIsPiece && start) {
      await this.getResult(targetCell).pull();
    }
    await this.synced();
  }
}

async function getCellByIdOrPiece(
  manager: PieceManager,
  cellId: string,
  label: string,
  options?: { start?: boolean; targetScope?: CellScope },
): Promise<{ cell: Cell<unknown>; isPiece: boolean }> {
  const start = options?.start ?? true;
  try {
    // Try to get as a piece first
    const piece = await manager.get(
      cellId,
      start,
      undefined,
      options?.targetScope,
    );
    if (!piece) {
      throw new Error(`Piece ${cellId} not found`);
    }
    if (
      getMetaLink(piece, "result") === undefined &&
      getPatternIdentityRef(piece) === undefined
    ) {
      throw new Error(
        `Piece ${cellId} has neither a parent result nor a pattern`,
      );
    }
    return { cell: piece, isPiece: true };
  } catch (_) {
    // If manager.get() fails (e.g., "patternId is required"), try as arbitrary cell ID
    try {
      const cell = await manager.getCellById(
        entityIdFrom(cellId),
        [],
        undefined,
        options?.targetScope,
      );

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

// Helper function to follow alias chain to its source
const MAX_DEPTH = 10;
function followCellToResult(
  cell: Cell<unknown>,
  diagnosticConsole: RuntimeConsole,
  visited = new Set<string>(),
  depth = 0,
): Cell<unknown> | undefined {
  if (depth > MAX_DEPTH) return undefined; // Prevent infinite recursion

  try {
    const docId = cell.entityId;
    if (!isEntityRef(docId)) return undefined;

    const docIdStr = entityRefToString(docId);

    // Prevent cycles
    if (visited.has(docIdStr)) return undefined;
    visited.add(docIdStr);

    try {
      // If document has result metadata, follow it to the owning result cell.
      const resultLink = getMetaLink(cell, "result");
      if (resultLink !== undefined) {
        const resultCell = cell.runtime.getCellFromLink(resultLink);
        return followCellToResult(
          resultCell,
          diagnosticConsole,
          visited,
          depth + 1,
        );
      }
    } catch (err) {
      // Ignore errors getting doc value
      diagnosticConsole.debug("Error getting doc value:", err);
    }

    return cell; // Return the current document's ID if no further references
  } catch (err) {
    diagnosticConsole.debug("Error in followCellToResult:", err);
    return undefined;
  }
}
