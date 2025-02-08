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
} from "@commontools/runner";
import { createStorage, Storage } from "./storage.js";
import { syncRecipeBlobby } from "./syncRecipe.js";

export type Charm = {
  [NAME]?: string;
  [UI]?: any;
  [TYPE]?: string;
  [key: string]: any;
};

export type StorageType = "remote" | "memory" | "local";

export class CharmManager {
  private storage: Storage;
  private charms: DocImpl<DocLink[]>;
  private replica?: string;

  constructor(replica = "common-knowledge", storageType: StorageType) {
    this.storage = createStorage(storageType, replica);
    this.charms = getDoc<DocLink[]>([], "charms");
    if (storageType === "remote") {
      this.replica = replica;
    }
  }

  getReplica(): string | undefined {
    return this.replica;
  }

  getCharms(): DocImpl<DocLink[]> {
    return this.charms;
  }

  async init() {
    await this.storage.syncCell(this.charms);
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
    const charm = this.charms.get().find(({ cell }) => JSON.stringify(cell.entityId) === JSON.stringify({'/' : id}));
    if (!charm) return undefined;
    return charm.cell;
  }

  async remove(id: EntityId) {
    const newCharms = this.charms.get().filter(({ cell }) => cell.entityId !== id);
    if (newCharms.length !== this.charms.get().length) this.charms.send(newCharms);
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

    const charm = run(recipe, inputs, await this.storage.syncCell(createRef({ recipe, inputs }, cause)));
    await idle()
    await this.add([charm]);
    await idle()

    console.log("syncing charms...");
    await this.storage.syncCell(this.charms, true);
    console.log("charms count", this.charms.get().length);

    console.log("latest charm", charm.entityId?.toJSON()?.["/"]);
    await idle()
        return charm;
  }

  // FIXME(JA): this really really really needs to be revisited
  async syncRecipe(charm: Charm) {
    await this.syncRecipeCells(charm);
    await this.syncRecipeBlobby(charm.sourceCell?.get()?.[TYPE]);
  }

  async syncRecipeCells(charm: Charm) {
    const recipeId = charm.sourceCell?.get()?.[TYPE];
    if (recipeId) await this.storage.syncCell({'/': recipeId});
  }

  // FIXME(ja): blobby seems to be using toString not toJSON
  async syncRecipeBlobby(entityId: string) {
    if (typeof entityId === "string") {
      await syncRecipeBlobby(entityId);
    } else  {
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
