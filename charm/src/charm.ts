import {
  JSONSchema,
  Module,
  NAME,
  Recipe,
  Schema,
  TYPE,
  UI,
} from "@commontools/builder";
import {
  type Cell,
  type CellLink,
  createRef,
  DocImpl,
  EntityId,
  getDoc,
  getEntityId,
  getRecipe,
  idle,
  isCell,
  maybeGetCellLink,
  run,
  syncRecipeBlobby,
} from "@commontools/runner";
import { storage } from "@commontools/runner";
import { DID, Identity, type Session } from "@commontools/identity";
import { isObj } from "@commontools/utils";

export type Charm = {
  [NAME]?: string;
  [UI]?: any;
  [key: string]: any;
};

export const charmSchema = {
  type: "object",
  properties: {
    [NAME]: { type: "string" },
    [UI]: { type: "object" },
  },
  required: [UI, NAME],
} as const satisfies JSONSchema satisfies JSONSchema;

export const charmListSchema = {
  type: "array",
  items: { ...charmSchema, asCell: true },
} as const satisfies JSONSchema satisfies JSONSchema;

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
    lineage: {
      type: "array",
      items: charmLineageSchema,
      default: [],
    },
  },
} as const satisfies JSONSchema;

export const processSchema = {
  type: "object",
  properties: {
    argument: { type: "object" },
    [TYPE]: { type: "string" },
  },
  required: [TYPE],
} as const satisfies JSONSchema;

/**
 * Helper to consistently compare entity IDs between cells
 */
function isSameEntity(
  a: Cell<Charm> | string | EntityId,
  b: Cell<Charm> | string | EntityId,
): boolean {
  const idA = getEntityId(a);
  const idB = getEntityId(b);
  return idA && idB ? idA["/"] === idB["/"] : false;
}

/**
 * Filters an array of charms by removing any that match the target entity
 */
function filterOutEntity(
  list: Cell<Cell<Charm>[]>,
  target: Cell<Charm> | string | EntityId,
): Cell<Charm>[] {
  const targetId = getEntityId(target);
  if (!targetId) return list.get();

  return list.get().filter((charm) => !isSameEntity(charm, targetId));
}

export class CharmManager {
  private space: string;
  private charmsDoc: DocImpl<CellLink[]>;
  private pinned: DocImpl<CellLink[]>;
  private trash: DocImpl<CellLink[]>;

  private charms: Cell<Cell<Charm>[]>;
  private pinnedCharms: Cell<Cell<Charm>[]>;
  private trashedCharms: Cell<Cell<Charm>[]>;

  /**
   * Promise resolved when the charm manager gets the charm list.
   */
  ready: Promise<void>;

  constructor(
    private session: Session,
  ) {
    this.space = this.session.space;
    this.charmsDoc = getDoc<CellLink[]>([], "charms", this.space);
    this.pinned = getDoc<CellLink[]>([], "pinned-charms", this.space);
    this.trash = getDoc<CellLink[]>([], "trash", this.space);
    this.charms = this.charmsDoc.asCell([], undefined, charmListSchema);

    storage.setSigner(session.as);
    this.pinnedCharms = this.pinned.asCell([], undefined, charmListSchema);
    this.trashedCharms = this.trash.asCell([], undefined, charmListSchema);

    this.ready = Promise.all(
      this.primaryDocs.map((doc) => storage.syncCell(doc)),
    ).then();
  }

  get primaryDocs() {
    return [
      this.charmsDoc,
      this.pinned,
      this.trash,
    ];
  }

  getSpace(): string {
    return this.space;
  }

  async synced(): Promise<void> {
    await this.ready;
    return await storage.synced();
  }

  async pin(charm: Cell<Charm>) {
    await storage.syncCell(this.pinned);
    // Check if already pinned
    if (
      !filterOutEntity(this.pinnedCharms, charm).some((c) =>
        isSameEntity(c, charm)
      )
    ) {
      this.pinnedCharms.push(charm);
      await idle();
    }
  }

  async unpinById(charmId: EntityId) {
    await storage.syncCell(this.pinned);
    const newPinnedCharms = filterOutEntity(this.pinnedCharms, charmId);

    if (newPinnedCharms.length !== this.pinnedCharms.get().length) {
      this.pinnedCharms.set(newPinnedCharms);
      await idle();
      return true;
    }

    return false;
  }

  async unpin(charm: Cell<Charm> | string | EntityId) {
    const id = getEntityId(charm);
    if (!id) return false;

    return await this.unpinById(id);
  }

  getPinned(): Cell<Cell<Charm>[]> {
    storage.syncCell(this.pinned);
    return this.pinnedCharms;
  }

  getTrash(): Cell<Cell<Charm>[]> {
    storage.syncCell(this.trash);
    return this.trashedCharms;
  }

  async restoreFromTrash(idOrCharm: string | EntityId | Cell<Charm>) {
    await storage.syncCell(this.trash);
    await storage.syncCell(this.charmsDoc);

    const id = getEntityId(idOrCharm);
    if (!id) return false;

    // Find the charm in trash
    const trashedCharm = this.trashedCharms.get().find((charm) =>
      isSameEntity(charm, id)
    );

    if (!trashedCharm) return false;

    // Remove from trash
    const newTrashedCharms = filterOutEntity(this.trashedCharms, id);
    this.trashedCharms.set(newTrashedCharms);

    // Add back to charms
    await this.add([trashedCharm]);

    await idle();
    return true;
  }

  async emptyTrash() {
    await storage.syncCell(this.trash);
    this.trashedCharms.set([]);
    await idle();
    return true;
  }

  // FIXME(ja): this says it returns a list of charm, but it isn't! you will
  // have to call .get() to get the actual charm (this is missing the schema)
  // how can we fix the type here?
  getCharms(): Cell<Cell<Charm>[]> {
    // Start syncing if not already syncing. Will trigger a change to the list
    // once loaded.
    storage.syncCell(this.charmsDoc);
    return this.charms;
  }

  private async add(newCharms: Cell<Charm>[]) {
    await storage.syncCell(this.charmsDoc);
    await idle();

    newCharms.forEach((charm) => {
      if (!this.charms.get().some((otherCharm) => otherCharm.equals(charm))) {
        this.charms.push(charm);
      }
    });

    await idle();
  }

  // FIXME(ja): if we are already running the charm, can we just return it?
  // if a charm has sideeffects we might multiple versions...
  async get<T = Charm>(
    id: string | Cell<Charm>,
    runIt: boolean = true,
    asSchema?: JSONSchema,
  ): Promise<Cell<T> | undefined> {
    // Load the charm from storage.
    let charm: Cell<Charm> | undefined;
    if (isCell(id)) {
      charm = id;
    } else {
      const idAsDocId = JSON.stringify({ "/": id });
      const doc = await storage.syncCellById(this.space, idAsDocId);
      charm = doc.asCell();
    }

    // Make sure we have the recipe so we can run it!
    let recipeId: string | undefined;
    let recipe: Recipe | Module | undefined;
    try {
      recipeId = await this.syncRecipe(charm);
      recipe = getRecipe(recipeId!)!;
    } catch (e) {
      console.warn("recipeId", recipeId);
      console.warn("recipe", recipe);
      console.warn("charm", charm.get());
      console.warn(
        `Not a charm (check toolshed?): ${JSON.stringify(getEntityId(charm))}`,
      );
      throw e;
    }

    let resultSchema: JSONSchema | undefined = recipe?.resultSchema;

    // If there is no result schema, create one from top level properties that omits UI, NAME
    if (!resultSchema) {
      const resultValue = charm.get();
      if (isObj(resultValue)) {
        resultSchema = {
          type: "object",
          properties: Object.fromEntries(
            Object.keys(resultValue).filter((key) => !key.startsWith("$")).map((
              key,
            ) => [key, {}]), // Empty schema == any
          ),
        };
      }
    }

    if (runIt) {
      // Make sure the charm is running. This is re-entrant and has no effect if
      // the charm is already running.
      return run(undefined, undefined, charm.getAsCellLink().cell!).asCell(
        [],
        undefined,
        asSchema ?? resultSchema,
      );
    } else {
      return charm.asSchema<T>(asSchema ?? resultSchema);
    }
  }

  getLineage(charm: Cell<Charm>) {
    return charm.getSourceCell(charmSourceCellSchema)?.key("lineage").get() ??
      [];
  }

  /**
   * Find all charms that the given charm reads data from via aliases or links.
   * This identifies dependencies that the charm has on other charms.
   * @param charm The charm to check
   * @returns Array of charms that are read from
   */
  getReadingFrom(charm: Cell<Charm>): Cell<Charm>[] {
    // Get all charms that might be referenced
    const allCharms = this.getCharms().get();
    const result: Cell<Charm>[] = [];
    const seenEntityIds = new Set<string>(); // Track entities we've already processed
    const maxDepth = 10; // Prevent infinite recursion
    const maxResults = 50; // Prevent too many results from overwhelming the UI

    if (!charm) return result;

    try {
      // Get the argument data - this is where references to other charms are stored
      const argumentCell = this.getArgument(charm);
      if (!argumentCell) return result;

      // Get the raw argument value
      let argumentValue: any;
      let argumentLink: any;
      
      try {
        argumentLink = argumentCell.getAsCellLink();
        if (!argumentLink || !argumentLink.cell) return result;

        argumentValue = argumentLink.cell.getAtPath(argumentLink.path);
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
        doc: DocImpl<any>,
        visited = new Set<string>(),
        depth = 0
      ): EntityId | undefined => {
        if (depth > maxDepth) return undefined; // Prevent infinite recursion
        
        const docId = getEntityId(doc);
        if (!docId || !docId["/"]) return undefined;
        
        const docIdStr = typeof docId["/"] === "string" 
          ? docId["/"] 
          : JSON.stringify(docId["/"]);
          
        // Prevent cycles
        if (visited.has(docIdStr)) return undefined;
        visited.add(docIdStr);
        
        // If document has a sourceCell, follow it
        const value = doc.get();
        if (value && typeof value === "object" && value.sourceCell) {
          return followSourceToResultRef(value.sourceCell, visited, depth + 1);
        }
        
        // If we've reached the end and have a resultRef, return it
        if (value && typeof value === "object" && value.resultRef) {
          return getEntityId(value.resultRef);
        }
        
        return docId; // Return the current document's ID if no further references
      };

      // Find references in the argument structure
      const processValue = (
        value: any, 
        parent: DocImpl<any>,
        visited = new Set<any>(), // Track objects directly, not string representations
        depth = 0
      ) => {
        if (!value || typeof value !== "object" || depth > maxDepth) return;
        
        // Prevent cycles in our traversal by tracking object references directly
        if (visited.has(value)) return;
        visited.add(value);
        
        // Process aliases - follow them to their sources
        try {
          if (value && typeof value === 'object' && 
              value.$alias && value.$alias.cell) {
            // First handle the direct alias
            try {
              const aliasId = getEntityId(value.$alias.cell);
              if (aliasId && aliasId["/"]) {
                addMatchingCharm(aliasId);
              }
            } catch (err) {
              // Ignore errors getting entity ID
            }
            
            // Then follow through sourceCell chain if it exists
            try {
              const doc = value.$alias.cell;
              const sourceRefId = followSourceToResultRef(doc, new Set(), 0);
              if (sourceRefId) {
                addMatchingCharm(sourceRefId);
              }
            } catch (err) {
              // Ignore errors in this experimental deep traversal
            }
          }
        } catch (err) {
          // Safely ignore any errors accessing $alias
        }
        
        // Process direct cell references
        try {
          if (value && typeof value === 'object' &&
              value.cell && value.path !== undefined) {
            // Handle direct cell reference
            try {
              const cellId = getEntityId(value.cell);
              if (cellId && cellId["/"]) {
                addMatchingCharm(cellId);
              }
            } catch (err) {
              // Ignore errors getting entity ID
            }
            
            // Then follow through sourceCell chain if it exists
            try {
              const sourceRefId = followSourceToResultRef(value.cell, new Set(), 0);
              if (sourceRefId) {
                addMatchingCharm(sourceRefId);
              }
            } catch (err) {
              // Ignore errors in this experimental deep traversal
            }
          }
        } catch (err) {
          // Safely ignore any errors accessing cell or path
        }
        
        // Recursively process object properties - be VERY careful not to copy cells
        if (Array.isArray(value)) {
          // Safety check - do not process the array if it might contain cells
          // This check helps prevent accidental spreading or copying of cells
          let mightContainCells = false;
          for (let i = 0; i < value.length && !mightContainCells; i++) {
            const item = value[i];
            if (item && typeof item === 'object') {
              try {
                // Check for cell-like properties that might trigger the copy trap
                mightContainCells = 'getAsCellLink' in item || 
                                    'get' in item || 
                                    'getSourceCell' in item ||
                                    'cell' in item ||
                                    '$alias' in item;
              } catch (err) {
                // If checking properties throws, assume it might contain cells to be safe
                mightContainCells = true;
              }
            }
          }
          
          if (!mightContainCells) {
            for (let i = 0; i < value.length; i++) {
              // Use a new visited set for each path
              const newVisited = new Set(visited);
              try {
                processValue(value[i], parent, newVisited, depth + 1);
              } catch (err) {
                // Skip items that cause errors - don't let one bad item break the whole traversal
                console.debug(`Error processing array item at index ${i}:`, err);
              }
            }
          }
        } else {
          // For objects, use for-in to iterate over keys which is safer with potential proxy objects
          for (const key in value) {
            // Skip non-own properties or symbols
            if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
            // Skip properties that might be Cell objects or lead to them
            if (key === 'sourceCell' || key === 'cell' || key === 'value' || 
                key === 'getAsCellLink' || key === 'getSourceCell') {
              continue;
            }
            
            // Use a new visited set for each path
            const newVisited = new Set(visited);
            try {
              processValue(value[key], parent, newVisited, depth + 1);
            } catch (err) {
              // Skip properties that cause errors
              console.debug(`Error processing object property '${key}':`, err);
            }
          }
        }
      };

      // Start processing from the argument value
      if (argumentValue && typeof argumentValue === "object") {
        processValue(argumentValue, argumentLink.cell, new Set(), 0);
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
  getReadByCharms(charm: Cell<Charm>): Cell<Charm>[] {
    // Get all charms to check
    const allCharms = this.getCharms().get();
    const result: Cell<Charm>[] = [];
    const seenEntityIds = new Set<string>(); // Track entities we've already processed
    const maxDepth = 10; // Prevent infinite recursion
    const maxResults = 50; // Prevent too many results from overwhelming the UI

    if (!charm) return result;

    const charmId = getEntityId(charm);
    if (!charmId) return result;

    // Helper function to add a matching charm to the result
    const addReadingCharm = (otherCharm: Cell<Charm>) => {
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
      doc: DocImpl<any>,
      visited = new Set<string>(),
      depth = 0
    ): EntityId | undefined => {
      if (depth > maxDepth) return undefined; // Prevent infinite recursion
      
      const docId = getEntityId(doc);
      if (!docId || !docId["/"]) return undefined;
      
      const docIdStr = typeof docId["/"] === "string" 
        ? docId["/"] 
        : JSON.stringify(docId["/"]);
        
      // Prevent cycles
      if (visited.has(docIdStr)) return undefined;
      visited.add(docIdStr);
      
      // If document has a sourceCell, follow it
      const value = doc.get();
      if (value && typeof value === "object" && value.sourceCell) {
        return followSourceToResultRef(value.sourceCell, visited, depth + 1);
      }
      
      // If we've reached the end and have a resultRef, return it
      if (value && typeof value === "object" && value.resultRef) {
        return getEntityId(value.resultRef);
      }
      
      return docId; // Return the current document's ID if no further references
    };
    
    // Helper to check if a document refers to our target charm
    const checkRefersToTarget = (
      value: any, 
      parent: DocImpl<any>,
      visited = new Set<any>(), // Track objects directly, not string representations
      depth = 0
    ): boolean => {
      if (!value || typeof value !== "object" || depth > maxDepth) return false;
      
      // Prevent cycles in our traversal by tracking object references directly
      if (visited.has(value)) return false;
      visited.add(value);
      
      // Check aliases
      try {
        if (value && typeof value === 'object' && 
            value.$alias && value.$alias.cell) {
          // Direct alias reference
          try {
            const aliasId = getEntityId(value.$alias.cell);
            if (aliasId && aliasId["/"] === charmId["/"]) {
              return true;
            }
          } catch (err) {
            // Ignore errors getting entity ID
          }
          
          // Check sourceCell chain
          try {
            const doc = value.$alias.cell;
            const sourceRefId = followSourceToResultRef(doc, new Set(), 0);
            if (sourceRefId && sourceRefId["/"] === charmId["/"]) {
              return true;
            }
          } catch (err) {
            // Ignore errors in sourceCell traversal
          }
        }
      } catch (err) {
        // Safely ignore any errors accessing $alias
      }
      
      // Check direct cell references
      try {
        if (value && typeof value === 'object' &&
            value.cell && value.path !== undefined) {
          // Direct cell reference
          try {
            const cellId = getEntityId(value.cell);
            if (cellId && cellId["/"] === charmId["/"]) {
              return true;
            }
          } catch (err) {
            // Ignore errors getting entity ID
          }
          
          // Check sourceCell chain
          try {
            const sourceRefId = followSourceToResultRef(value.cell, new Set(), 0);
            if (sourceRefId && sourceRefId["/"] === charmId["/"]) {
              return true;
            }
          } catch (err) {
            // Ignore errors in sourceCell traversal
          }
        }
      } catch (err) {
        // Safely ignore any errors accessing cell or path
      }
      
      // Recursively check object properties and array items - be VERY careful not to copy cells
      if (Array.isArray(value)) {
        // Safety check - do not process the array if it might contain cells
        // This check helps prevent accidental spreading or copying of cells
        let mightContainCells = false;
        for (let i = 0; i < value.length && !mightContainCells; i++) {
          const item = value[i];
          if (item && typeof item === 'object') {
            try {
              // Check for cell-like properties that might trigger the copy trap
              mightContainCells = 'getAsCellLink' in item || 
                                  'get' in item || 
                                  'getSourceCell' in item ||
                                  'cell' in item ||
                                  '$alias' in item;
            } catch (err) {
              // If checking properties throws, assume it might contain cells to be safe
              mightContainCells = true;
            }
          }
        }
        
        if (!mightContainCells) {
          for (let i = 0; i < value.length; i++) {
            // Use a new visited set for each path
            const newVisited = new Set(visited);
            try {
              if (checkRefersToTarget(value[i], parent, newVisited, depth + 1)) {
                return true;
              }
            } catch (err) {
              // Skip items that cause errors
              console.debug(`Error checking array item at index ${i}:`, err);
            }
          }
        }
      } else {
        // For objects, use for-in to iterate over keys which is safer with potential proxy objects
        for (const key in value) {
          // Skip non-own properties or symbols
          if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
          // Skip properties that might be Cell objects or lead to them
          if (key === 'sourceCell' || key === 'cell' || key === 'value' || 
              key === 'getAsCellLink' || key === 'getSourceCell') {
            continue;
          }
          
          // Use a new visited set for each path
          const newVisited = new Set(visited);
          try {
            if (checkRefersToTarget(value[key], parent, newVisited, depth + 1)) {
              return true;
            }
          } catch (err) {
            // Skip properties that cause errors
            console.debug(`Error checking object property '${key}':`, err);
          }
        }
      }
      
      return false;
    };

    // Check each charm to see if it references this charm
    for (const otherCharm of allCharms) {
      if (isSameEntity(otherCharm, charm)) continue; // Skip self

      // First check the charm document
      try {
        const otherCellLink = otherCharm.getAsCellLink();
        if (!otherCellLink.cell) continue;

        const charmValue = otherCellLink.cell.get();
        
        // Check if the charm document references our target
        if (charmValue && typeof charmValue === "object") {
          if (checkRefersToTarget(charmValue, otherCellLink.cell, new Set(), 0)) {
            addReadingCharm(otherCharm);
            continue; // Skip additional checks for this charm
          }
        }
      } catch (err) {
        // Error checking charm references - continue to check argument references
      }

      // Also specifically check the argument data where references are commonly found
      try {
        const argumentCell = this.getArgument(otherCharm);
        if (argumentCell) {
          const argumentLink = argumentCell.getAsCellLink();
          if (argumentLink && argumentLink.cell) {
            const argumentValue = argumentLink.cell.getAtPath(
              argumentLink.path,
            );
            
            // Check if the argument references our target
            if (argumentValue && typeof argumentValue === "object") {
              if (checkRefersToTarget(argumentValue, argumentLink.cell, new Set(), 0)) {
                addReadingCharm(otherCharm);
              }
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
    return (await storage.syncCellById(this.space, id)).asCell(
      path,
      undefined,
      schema,
    );
  }

  // Return Cell with argument content according to the schema of the charm.
  getArgument<T = any>(charm: Cell<Charm | T>): Cell<T> | undefined {
    const source = charm.getSourceCell(processSchema);
    const recipeId = source?.get()?.[TYPE];
    const recipe = getRecipe(recipeId);
    const argumentSchema = recipe?.argumentSchema;
    return source?.key("argument").asSchema(argumentSchema!) as
      | Cell<T>
      | undefined;
  }

  // note: removing a charm doesn't clean up the charm's cells
  // Now moves the charm to trash instead of just removing it
  async remove(idOrCharm: string | EntityId | Cell<Charm>) {
    await storage.syncCell(this.charmsDoc);
    await storage.syncCell(this.pinned);
    await storage.syncCell(this.trash);

    const id = getEntityId(idOrCharm);
    if (!id) return false;

    await this.unpin(idOrCharm);

    // Find the charm in the main list
    const charm = this.charms.get().find((c) => isSameEntity(c, id));
    if (!charm) return false;

    // Move to trash if not already there
    if (!this.trashedCharms.get().some((c) => isSameEntity(c, id))) {
      this.trashedCharms.push(charm);
    }

    // Remove from main list
    const newCharms = filterOutEntity(this.charms, id);
    if (newCharms.length !== this.charms.get().length) {
      this.charms.set(newCharms);
      await idle();
      return true;
    }

    return false;
  }

  // Permanently delete a charm (from trash or directly)
  async permanentlyDelete(idOrCharm: string | EntityId | Cell<Charm>) {
    await storage.syncCell(this.trash);

    const id = getEntityId(idOrCharm);
    if (!id) return false;

    // Remove from trash if present
    const newTrashedCharms = filterOutEntity(this.trashedCharms, id);
    if (newTrashedCharms.length !== this.trashedCharms.get().length) {
      this.trashedCharms.set(newTrashedCharms);
      await idle();
      return true;
    }

    return false;
  }

  async runPersistent(
    recipe: Recipe | Module,
    inputs?: any,
    cause?: any,
  ): Promise<Cell<Charm>> {
    await idle();

    const seen = new Set<Cell<any>>();
    const promises = new Set<Promise<any>>();

    const syncAllMentionedCells = (value: any) => {
      if (seen.has(value)) return;
      seen.add(value);

      const link = maybeGetCellLink(value);

      if (link && link.cell) {
        const maybePromise = storage.syncCell(link.cell);
        if (maybePromise instanceof Promise) promises.add(maybePromise);
      } else if (typeof value === "object" && value !== null) {
        for (const key in value) syncAllMentionedCells(value[key]);
      }
    };

    syncAllMentionedCells(inputs);
    await Promise.all(promises);

    const doc = await storage.syncCellById(
      this.space,
      createRef({ recipe, inputs }, cause),
    );
    const resultDoc = run(recipe, inputs, doc);

    const charm = resultDoc.asCell([], undefined, charmSchema);
    await this.syncRecipe(charm);
    await this.add([charm]);
    return charm;
  }

  // FIXME(JA): this really really really needs to be revisited
  async syncRecipe(charm: Cell<Charm>): Promise<string> {
    const recipeId = charm.getSourceCell()?.get()?.[TYPE];
    if (!recipeId) throw new Error("charm missing recipe ID");

    await Promise.all([
      this.syncRecipeCells(recipeId),
      this.syncRecipeBlobby(recipeId),
    ]);
    return recipeId;
  }

  async syncRecipeCells(recipeId: string) {
    // NOTE(ja): this doesn't sync recipe to storage
    if (recipeId) await storage.syncCellById(this.space, { "/": recipeId });
  }

  // FIXME(ja): blobby seems to be using toString not toJSON
  async syncRecipeBlobby(recipeId: string) {
    await syncRecipeBlobby(recipeId);
  }

  async sync(entity: Cell<any>, waitForStorage: boolean = false) {
    await storage.syncCell(entity, waitForStorage);
  }
}
