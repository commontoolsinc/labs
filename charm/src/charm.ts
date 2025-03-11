import {
  JSONSchema,
  Module,
  NAME,
  Recipe,
  TYPE,
  UI,
} from "@commontools/builder";
import {
  type Cell,
  createRef,
  DocImpl,
  type DocLink,
  EntityId,
  getDoc,
  getEntityId,
  getRecipe,
  idle,
  isCell,
  run,
  syncRecipeBlobby,
} from "@commontools/runner";
import { getSpace, Space, storage } from "@commontools/runner";
import { DID, Identity, Signer } from "@commontools/identity";

export type Charm = {
  [NAME]?: string;
  [UI]?: any;
  [key: string]: any;
};

export const charmSchema: JSONSchema = {
  type: "object",
  properties: {
    [NAME]: { type: "string" },
    [UI]: { type: "object" },
  },
  required: [UI, NAME],
} as const;

export const charmListSchema: JSONSchema = {
  type: "array",
  items: { ...charmSchema, asCell: true },
} as const;

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
  private space: Space;
  private charmsDoc: DocImpl<DocLink[]>;
  private pinned: DocImpl<DocLink[]>;

  private charms: Cell<Cell<Charm>[]>;
  private pinnedCharms: Cell<Cell<Charm>[]>;

  static async open(
    { space, signer }: { space: DID; signer?: Signer },
  ) {
    return new this(
      space,
      signer ?? await Identity.fromPassphrase("charm manager"),
    );
  }

  constructor(
    private spaceId: string,
    private signer: Signer,
  ) {
    this.space = getSpace(this.spaceId);
    this.charmsDoc = getDoc<DocLink[]>([], "charms", this.space);
    this.pinned = getDoc<DocLink[]>([], "pinned-charms", this.space);
    this.charms = this.charmsDoc.asCell([], undefined, charmListSchema);

    storage.setSigner(signer);
    this.pinnedCharms = this.pinned.asCell([], undefined, charmListSchema);
  }

  getReplica(): string | undefined {
    return this.space.uri;
  }

  async synced(): Promise<void> {
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

  async unpin(charm: Cell<Charm>) {
    await storage.syncCell(this.pinned);
    const newPinnedCharms = filterOutEntity(this.pinnedCharms, charm);

    if (newPinnedCharms.length !== this.pinnedCharms.get().length) {
      this.pinnedCharms.set(newPinnedCharms);
      await idle();
      return true;
    }

    return false;
  }

  getPinned(): Cell<Cell<Charm>[]> {
    storage.syncCell(this.pinned);
    return this.pinnedCharms;
  }

  getCharms(): Cell<Cell<Charm>[]> {
    // Start syncing if not already syncing. Will trigger a change to the list
    // once loaded.
    storage.syncCell(this.charmsDoc);
    return this.charms;
  }

  // NOTE(ja): making a private method, as runPersistent ensures the charm
  // and recipe are persisted.. cleanup?
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

  async get<T = Charm>(
    id: string | Cell<Charm>,
    runIt: boolean = true,
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
    const recipeId = await this.syncRecipe(charm);
    const recipe = recipeId ? getRecipe(recipeId) : undefined;

    if (!recipe || charm.get() === undefined) {
      console.warn("recipeId", recipeId);
      console.warn("recipe", recipe);
      console.warn("charm", charm.get());
      console.warn(`Not a charm: ${JSON.stringify(getEntityId(charm))}`);
    }

    let resultSchema: JSONSchema | undefined = recipe?.resultSchema;

    // Unless there is a non-object schema, add UI and NAME properties if present
    if (!resultSchema || resultSchema.type === "object") {
      const { [UI]: hasUI, [NAME]: hasName } =
        charm.getAsDocLink().cell.get() ?? {};
      if (hasUI || hasName) {
        // Copy the original schema, so we can modify properties without
        // affecting other uses of the same spell.
        resultSchema = {
          ...resultSchema,
          properties: {
            ...resultSchema?.properties,
          },
        };
        if (hasUI && !resultSchema.properties![UI]) {
          (resultSchema.properties as any)[UI] = { type: "object" }; // TODO(seefeld): make this the vdom schema
        }
        if (hasName && !resultSchema.properties![NAME]) {
          (resultSchema.properties as any)[NAME] = { type: "string" };
        }
      }
    }

    if (runIt) {
      // Make sure the charm is running. This is re-entrant and has no effect if
      // the charm is already running.
      return run(undefined, undefined, charm.getAsDocLink().cell!).asCell(
        [],
        undefined,
        resultSchema,
      );
    } else {
      return charm.asSchema<T>(resultSchema);
    }
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
  async remove(idOrCharm: string | EntityId | Cell<Charm>) {
    await storage.syncCell(this.charmsDoc);
    const id = getEntityId(idOrCharm);
    if (!id) return false;

    const newCharms = filterOutEntity(this.charms, id);

    if (newCharms.length !== this.charms.get().length) {
      this.charms.set(newCharms);

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

    const syncAllMentionedCells = (item: any, promises: any[] = []) => {
      if (isCell(item)) {
        promises.push(storage.syncCell(item.getAsDocLink().cell));
      } else if (typeof item === "object" && item !== null) {
        Object.values(item).forEach((v) => syncAllMentionedCells(v, promises));
      }
      return promises;
    };

    await Promise.all(syncAllMentionedCells(inputs));

    const doc = await storage.syncCellById(
      this.space,
      createRef({ recipe, inputs }, cause),
    );
    const resultDoc = run(recipe, inputs, doc);

    const newCharm = resultDoc.asCell([], undefined, charmSchema);

    await this.add([newCharm]);
    await this.syncRecipe(newCharm);

    return newCharm;
  }

  // FIXME(JA): this really really really needs to be revisited
  async syncRecipe(charm: Cell<Charm>): Promise<string | undefined> {
    const recipeId = charm.getSourceCell()?.get()?.[TYPE];
    if (!recipeId) return Promise.reject(new Error("No recipe ID found"));

    await Promise.all([
      this.syncRecipeCells(recipeId),
      this.syncRecipeBlobby(recipeId),
    ]);
    return recipeId;
  }

  syncRecipeCells(recipeId: string) {
    // NOTE(ja): I don't think this actually syncs the recipe
    if (recipeId) return storage.syncCellById(this.space, { "/": recipeId });
  }

  // FIXME(ja): blobby seems to be using toString not toJSON
  syncRecipeBlobby(recipeId: string) {
    return syncRecipeBlobby(recipeId);
  }

  sync(entity: Cell<any>, waitForStorage: boolean = false) {
    return storage.syncCell(entity, waitForStorage);
  }
}
