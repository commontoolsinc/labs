import { Module, Recipe, NAME, TYPE, UI, JSONSchema } from "@commontools/builder";
import {
  getDoc,
  type DocLink,
  DocImpl,
  EntityId,
  idle,
  createRef,
  run,
  type Cell,
  getEntityId,
  isCell,
  getRecipe,
} from "@commontools/runner";
import { storage } from "./storage.js";
import { syncRecipeBlobby } from "./syncRecipe.js";
import { getSpace, Space } from "@commontools/runner";

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
} as const;

export const charmListSchema: JSONSchema = {
  type: "array",
  items: { ...charmSchema, asCell: true },
} as const;

export const processSchema: JSONSchema = {
  type: "object",
  properties: {
    [TYPE]: { type: "string" },
  },
} as const;

export class CharmManager {
  private space: Space;
  private charmsDoc: DocImpl<DocLink[]>;
  private charms: Cell<Cell<Charm>[]>;

  constructor(private spaceId: string) {
    this.space = getSpace(this.spaceId);
    this.charmsDoc = getDoc<DocLink[]>([], "charms", this.space);
    this.charms = this.charmsDoc.asCell([], undefined, charmListSchema);
  }

  getReplica(): string | undefined {
    return this.space.uri;
  }

  getSpace(): Space {
    return this.space;
  }

  async synced(): Promise<void> {
    return await storage.synced();
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
      if (!this.charms.get().some((otherCharm) => otherCharm.equals(charm)))
        this.charms.push(charm);
    });

    await idle();
  }

  async get(id: string | Cell<Charm>, runIt: boolean = true): Promise<Cell<Charm> | undefined> {
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
    const recipe = getRecipe(recipeId);

    let resultSchema = recipe?.resultSchema;

    // Unless there is a non-object schema, add UI and NAME properties if present
    if (!resultSchema || resultSchema.type === "object") {
      const { [UI]: hasUI, [NAME]: hasName } = charm.getAsDocLink().cell!.get();
      if (hasUI || hasName) {
        // Copy the original schema, so we can modify properties without
        // affecting other uses of the same spell.
        resultSchema = {
          ...resultSchema,
          properties: {
            ...resultSchema?.properties,
          },
        };
        if (hasUI && !resultSchema.properties![UI])
          resultSchema.properties![UI] = { type: "object" }; // TODO: vdom schema
        if (hasName && !resultSchema.properties![NAME])
          resultSchema.properties![NAME] = { type: "string" };
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
      return charm.asSchema(resultSchema);
    }
  }

  async getCellById<T>(
    id: EntityId | string,
    path: string[] = [],
    schema?: JSONSchema,
  ): Promise<Cell<T>> {
    return (await storage.syncCellById(this.space, id)).asCell(path, undefined, schema);
  }

  // Return Cell with argument content according to the schema of the charm.
  getArgument<T = any>(charm: Cell<Charm | T>): T {
    const source = charm.getSourceCell();
    const recipeId = source?.get()?.[TYPE];
    const recipe = getRecipe(recipeId);
    const argumentSchema = recipe?.argumentSchema;
    return source?.key("argument").asSchema(argumentSchema!) as T;
  }

  // note: removing a charm doesn't clean up the charm's cells
  async remove(idOrCharm: string | EntityId | Cell<Charm>) {
    await storage.syncCell(this.charmsDoc);
    // bf: horrible code, this indicates inconsistent data structures somewhere
    const id = getEntityId(idOrCharm);
    if (!id) return false;

    const newCharms = this.charms.get().filter((charm) => getEntityId(charm)?.["/"] !== id?.["/"]);
    if (newCharms.length !== this.charms.get().length) {
      this.charms.set(newCharms);
      await idle();
      return true;
    }

    return false;
  }

  async runPersistent(recipe: Recipe | Module, inputs?: any, cause?: any): Promise<Cell<Charm>> {
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
      if (isCell(value)) promises.push(storage.syncCell(value.getAsDocLink().cell));
      else if (typeof value === "object" && value !== null)
        for (const key in value) promises.push(syncAllMentionedCells(value[key], promises));
      return promises;
    };

    await syncAllMentionedCells(inputs);

    const doc = await storage.syncCellById(this.space, createRef({ recipe, inputs }, cause));
    const resultDoc = run(recipe, inputs, doc);

    // FIXME(ja): should we add / sync explicitly here?
    // await this.add([charm]);
    // await this.storage.syncCell(this.charms, true);
    return resultDoc.asCell([], undefined, charmSchema);
  }

  // FIXME(JA): this really really really needs to be revisited
  syncRecipe(charm: Cell<Charm>): Promise<string> {
    const recipeId = charm.getSourceCell()?.get()?.[TYPE];

    return Promise.all([this.syncRecipeCells(recipeId), this.syncRecipeBlobby(recipeId)]).then(
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
