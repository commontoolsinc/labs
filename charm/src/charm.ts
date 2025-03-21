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
import { DID, Identity } from "@commontools/identity";
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

/**
 * Representation authorization session.
 */
export interface Session {
  /**
   * Whether session is for a private space vs public access space.
   */
  private: boolean;

  /**
   * Session name, which is pet name of the space session is for.
   */
  name: string;

  /**
   * DID identifier of the space this is a session for.
   */
  space: DID;

  /**
   * Identity used in this session.
   */
  as: Identity;
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
