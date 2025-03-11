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
import { storage } from "@commontools/runner";
import { DID, Identity } from "@commontools/identity";

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
  private charmsDoc: DocImpl<DocLink[]>;
  private pinned: DocImpl<DocLink[]>;

  private charms: Cell<Cell<Charm>[]>;
  private pinnedCharms: Cell<Cell<Charm>[]>;

  constructor(
    private session: Session,
  ) {
    this.charmsDoc = getDoc<DocLink[]>([], "charms", this.space);
    this.pinned = getDoc<DocLink[]>([], "pinned-charms", this.space);
    this.charms = this.charmsDoc.asCell([], undefined, charmListSchema);

    storage.setSigner(session.as);
    this.pinnedCharms = this.pinned.asCell([], undefined, charmListSchema);
  }

  get space() {
    return getSpace(this.session.space);
  }

  getReplica(): string | undefined {
    return this.space;
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

  async add(newCharms: Cell<Charm>[]) {
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

    // Fill in missing parameters from other charms. It's a simple match on
    // hashtags: For each top-level argument prop that has a hashtag in the
    // description, look for a charm that has a top-level output prop with the
    // same hashtag in the description, or has the hashtag in its own description.
    // If there is a match, assign the first one to the input property.

    // TODO(seefeld,ben): This should be in spellcaster.
    /*
    if (
      !isDoc(inputs) && // Adding to a cell input is not supported yet
      !isDocLink(inputs) && // Neither for cell reference
      recipe.argumentSchema &&
      (recipe.argumentSchema as any).type === "object"
    ) {
      const properties = (recipe.argumentSchema as any).properties;
      const inputProperties =
        typeof inputs === "object" && inputs !== null ? Object.keys(inputs) : [];
      for (const key in properties) {
        if (!(key in inputProperties) && properties[key].description?.includes("#")) {
          const hashtag = properties[key].description.match(/#(\w+)/)?.[1];
          if (hashtag) {
            this.charms.get().forEach((charm) => {
              const type = charm.getAsDocLink().cell?.sourceCell?.get()?.[TYPE];
              const recipe = getRecipe(type);
              const charmProperties = (recipe?.resultSchema as any)?.properties as any;
              const matchingProperty = Object.keys(charmProperties ?? {}).find((property) =>
                charmProperties[property].description?.includes(`#${hashtag}`),
              );
              if (matchingProperty) {
                inputs = {
                  ...inputs,
                  [key]: { $alias: { cell: charm.getAsDocLink().cell, path: [matchingProperty] } },
                };
              }
            });
          }
        }
      }
    }*/

    const syncAllMentionedCells = (value: any, promises: any[] = []) => {
      if (isCell(value)) {
        promises.push(storage.syncCell(value.getAsDocLink().cell));
      } else if (typeof value === "object" && value !== null) {
        for (const key in value) {
          promises.push(syncAllMentionedCells(value[key], promises));
        }
      }
      return promises;
    };

    await syncAllMentionedCells(inputs);

    const doc = await storage.syncCellById(
      this.space,
      createRef({ recipe, inputs }, cause),
    );
    const resultDoc = run(recipe, inputs, doc);

    // FIXME(ja): should we add / sync explicitly here?
    // await this.add([charm]);
    // await this.storage.syncCell(this.charms, true);
    return resultDoc.asCell([], undefined, charmSchema);
  }

  // FIXME(JA): this really really really needs to be revisited
  syncRecipe(charm: Cell<Charm>): Promise<string | undefined> {
    const recipeId = charm.getSourceCell()?.get()?.[TYPE];
    if (!recipeId) return Promise.resolve(undefined);

    return Promise.all([
      this.syncRecipeCells(recipeId),
      this.syncRecipeBlobby(recipeId),
    ]).then(
      () => recipeId,
    );
  }

  async syncRecipeCells(recipeId: string) {
    // NOTE(ja): I don't think this actually syncs the recipe
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
