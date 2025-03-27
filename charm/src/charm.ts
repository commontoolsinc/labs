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
    
    if (!charm) return result;
    
    try {
      // Get the argument data - this is where references to other charms are stored
      const argumentCell = this.getArgument(charm);
      if (!argumentCell) return result;
      
      // Get the raw argument value
      const argumentLink = argumentCell.getAsCellLink();
      if (!argumentLink || !argumentLink.cell) return result;
      
      const argumentValue = argumentLink.cell.getAtPath(argumentLink.path);
      
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
        
        if (matchingCharm && !isSameEntity(matchingCharm, charm) &&
            !result.some((c) => isSameEntity(c, matchingCharm))) {
          result.push(matchingCharm);
          console.log("Added reference to charm:", entityIdStr);
        }
      };
      
      // SIMPLEST APPROACH: Only scan the top-level properties for references
      // This avoids any recursion and potential stack overflow issues
      console.log("Scanning top-level properties for references");
      if (argumentValue && typeof argumentValue === 'object') {
        // Check each top-level property
        for (const key in argumentValue) {
          const value = argumentValue[key];
          if (!value || typeof value !== 'object') continue;
          
          // Look for alias references ($alias property)
          if (value.$alias && value.$alias.cell) {
            const aliasId = getEntityId(value.$alias.cell);
            if (aliasId && aliasId["/"]) {
              console.log(`Found alias reference in property "${key}":`, aliasId["/"]);
              addMatchingCharm(aliasId);
            }
          }
          
          // Look for direct cell references (cell + path properties)
          if (value.cell && value.path !== undefined) {
            const cellId = getEntityId(value.cell);
            if (cellId && cellId["/"]) {
              console.log(`Found direct cell reference in property "${key}":`, cellId["/"]);
              addMatchingCharm(cellId);
            }
          }
        }
      }
      
      // Use findAllAliasedDocs for additional reference detection
      // This is a safer approach than deep recursion
      try {
        console.log("Using findAllAliasedDocs for additional reference detection");
        const argumentReferences = findAllAliasedDocs(
          argumentValue,
          argumentLink.cell
        );
        
        console.log(`Found ${argumentReferences.length} references via findAllAliasedDocs`);
        for (const docRef of argumentReferences) {
          const docId = getEntityId(docRef.cell);
          if (!docId) continue;
          console.log("- Reference found:", docId["/"]);
          addMatchingCharm(docId);
        }
      } catch (err) {
        console.warn("Error in findAllAliasedDocs:", err);
      }
    } catch (error) {
      console.warn("Error finding references in charm arguments:", error);
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
      
      if (!result.some(c => isSameEntity(c, otherCharm))) {
        result.push(otherCharm);
        console.log("Found charm reading from target:", entityIdStr);
      }
    };
    
    // Check each charm to see if it references this charm
    for (const otherCharm of allCharms) {
      if (isSameEntity(otherCharm, charm)) continue; // Skip self
      
      // First check the charm document using findAllAliasedDocs
      try {
        console.log("Checking if charm references our target");
        const otherCellLink = otherCharm.getAsCellLink();
        if (!otherCellLink.cell) continue;
        
        // Use findAllAliasedDocs to find all references in the entire charm document
        const referencedDocs = findAllAliasedDocs(
          otherCellLink.cell.get(),
          otherCellLink.cell,
        );
        
        // Check if any of the references point to our charm
        const references = referencedDocs.some((docRef) => {
          const refId = getEntityId(docRef.cell);
          return refId && refId["/"] === charmId["/"];
        });
        
        if (references) {
          console.log("Found reference in charm document");
          addReadingCharm(otherCharm);
          continue; // Skip additional checks for this charm since we already found a reference
        }
      } catch (err) {
        console.warn("Error checking charm references:", err);
      }
      
      // Also specifically check the argument data where references are commonly found
      try {
        console.log("Checking charm's argument data for references");
        const argumentCell = this.getArgument(otherCharm);
        if (argumentCell) {
          const argumentLink = argumentCell.getAsCellLink();
          if (argumentLink && argumentLink.cell) {
            // Get raw argument value
            const argumentValue = argumentLink.cell.getAtPath(
              argumentLink.path,
            );
            
            // Flat check of top-level properties
            if (argumentValue && typeof argumentValue === 'object') {
              let foundReference = false;
              
              // Check each top-level property for references to our charm
              for (const key in argumentValue) {
                const value = argumentValue[key];
                if (!value || typeof value !== 'object') continue;
                
                // Check for direct cell reference to our target charm
                if (value.cell && value.path !== undefined) {
                  const docId = getEntityId(value.cell);
                  if (docId && docId["/"] === charmId["/"]) {
                    console.log(`Found direct reference to our charm in ${key}`);
                    foundReference = true;
                    break;
                  }
                }
                
                // Check for alias reference to our target charm
                if (value.$alias && value.$alias.cell) {
                  const aliasId = getEntityId(value.$alias.cell);
                  if (aliasId && aliasId["/"] === charmId["/"]) {
                    console.log(`Found alias reference to our charm in ${key}`);
                    foundReference = true;
                    break;
                  }
                }
              }
              
              if (foundReference) {
                addReadingCharm(otherCharm);
                continue;
              }
            }
            
            // Also check with findAllAliasedDocs
            try {
              console.log("Using findAllAliasedDocs for argument check");
              const argumentReferences = findAllAliasedDocs(
                argumentValue,
                argumentLink.cell,
              );
              
              // Check if any of these references point to our charm
              const hasReference = argumentReferences.some((docRef) => {
                const refId = getEntityId(docRef.cell);
                return refId && refId["/"] === charmId["/"];
              });
              
              if (hasReference) {
                console.log("Found reference via findAllAliasedDocs");
                addReadingCharm(otherCharm);
              }
            } catch (err) {
              console.warn("Error in findAllAliasedDocs for argument:", err);
            }
          }
        }
      } catch (error) {
        console.warn("Error checking argument references for charm:", error);
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
