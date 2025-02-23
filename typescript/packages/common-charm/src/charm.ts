import { Module, NAME, Recipe, TYPE, UI } from "@commontools/builder";
import {
  getDoc,
  type DocLink,
  DocImpl,
  EntityId,
  idle,
  createRef,
  getRecipe,
  isDoc,
  isDocLink,
  run,
  getEntityId,
} from "@commontools/runner";
import { type Storage } from "./storage.js";
import { syncRecipeBlobby } from "./syncRecipe.js";

export type Charm = {
  [NAME]?: string;
  [UI]?: any;
  [TYPE]?: string;
  [key: string]: any;
};

export type StorageType = "remote" | "memory" | "local";

export class CharmManager {
  private charms: DocImpl<DocLink[]>;

  constructor(private storage: Storage) {
    this.charms = getDoc<DocLink[]>([], "charms");
  }

  getReplica(): string | undefined {
    return this.storage.getReplica();
  }

  getCharms(): DocImpl<DocLink[]> {
    // Start syncing if not already syncing. Will trigger a change to the list
    // once loaded.
    this.storage.syncCell(this.charms);
    return this.charms;
  }

  async add(newCharms: DocImpl<any>[]) {
    await this.storage.syncCell(this.charms);
    await idle();

    const currentCharmsIds = this.charms.get().map(({ cell }) => JSON.stringify(cell.entityId));
    const charmsToAdd = newCharms.filter(
      (cell) => !currentCharmsIds.includes(JSON.stringify(cell.entityId)),
    );

    if (charmsToAdd.length > 0) {
      console.log("add charms", charmsToAdd);
      this.charms.send([
        ...this.charms.get(),
        ...charmsToAdd.map((cell) => ({ cell, path: [] }) satisfies DocLink),
      ]);
    }
  }

  async get(id: string): Promise<DocImpl<any> | undefined> {
    await this.storage.syncCell(this.charms);
    const charm = this.charms
      .get()
      .find(({ cell }) => JSON.stringify(cell.entityId) === JSON.stringify({ "/": id }));
    if (!charm) return undefined;

    // Make sure we have the recipe so we can run it!
    await this.syncRecipe(charm.cell);

    // Make sure the charm is running. This is re-entrant and has no effect if
    // the charm is already running.
    return run(undefined, undefined, charm.cell);
  }

  // note: removing a charm doesn't clean up the charm's cells
  async remove(idOrCharm: EntityId | DocLink) {
    await this.storage.syncCell(this.charms);
    // bf: horrible code, this indicates inconsistent data structures somewhere
    const id = isDocLink(idOrCharm) ? getEntityId(idOrCharm) : idOrCharm["/"];
    const newCharms = this.charms.get().filter(({ cell }) => {
      const cellId = cell.entityId?.toJSON?.()["/"] || cell.entityId?.["/"];
      return cellId !== String(id);
    });
    if (newCharms.length !== this.charms.get().length) {
      this.charms.send(newCharms);
      return true;
    }
    return false;
  }

  async runPersistent(recipe: Recipe | Module, inputs?: any, cause?: any): Promise<DocImpl<any>> {
    await idle();

    // Fill in missing parameters from other charms. It's a simple match on
    // hashtags: For each top-level argument prop that has a hashtag in the
    // description, look for a charm that has a top-level output prop with the
    // same hashtag in the description, or has the hashtag in its own description.
    // If there is a match, assign the first one to the input property.

    // TODO: This should really be extracted into a full-fledged query builder.
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
            this.charms.get().forEach(({ cell }) => {
              const type = cell.sourceCell?.get()?.[TYPE];
              const recipe = getRecipe(type);
              const charmProperties = (recipe?.resultSchema as any)?.properties as any;
              const matchingProperty = Object.keys(charmProperties ?? {}).find((property) =>
                charmProperties[property].description?.includes(`#${hashtag}`),
              );
              if (matchingProperty) {
                inputs = {
                  ...inputs,
                  [key]: { $alias: { cell, path: [matchingProperty] } },
                };
              }
            });
          }
        }
      }
    }

    const doc = await this.storage.syncCell(createRef({ recipe, inputs }, cause));
    const charm = run(recipe, inputs, doc);

    // FIXME(ja): should we add / sync explicitly here?
    // await this.add([charm]);
    // await this.storage.syncCell(this.charms, true);
    return charm;
  }

  // FIXME(JA): this really really really needs to be revisited
  async syncRecipe(charm: Charm) {
    await this.syncRecipeCells(charm);
    await this.syncRecipeBlobby(charm.sourceCell?.get()?.[TYPE]);
  }

  async syncRecipeCells(charm: Charm) {
    // NOTE(ja): I don't think this actually syncs the recipe
    const recipeId = charm.sourceCell?.get()?.[TYPE];
    if (recipeId) await this.storage.syncCell({ "/": recipeId });
  }

  // FIXME(ja): blobby seems to be using toString not toJSON
  async syncRecipeBlobby(entityId: string) {
    if (typeof entityId === "string") {
      await syncRecipeBlobby(entityId);
    } else {
      await syncRecipeBlobby(entityId["/"]);
    }
  }

  async sync(
    entityId: string | EntityId | DocImpl<any>,
    waitForStorage: boolean = false,
  ): Promise<DocImpl<Charm>> {
    return this.storage.syncCell(entityId, waitForStorage);
  }
}
