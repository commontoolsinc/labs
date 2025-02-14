import { Command } from "cmdk";
import "./commands.css";
import { castNewRecipe, Charm, CharmManager, compileAndRunRecipe } from "@commontools/charm";
import { NavigateFunction } from "react-router-dom";
import { castSpell } from "@/search";
import { charmId } from "@/utils/charms";
import { NAME } from "@commontools/builder";
import { DocImpl, getRecipe } from "@commontools/runner";
import { performIteration } from "@/utils/charm-iteration";

export type CommandType = "action" | "input" | "confirm" | "select" | "menu" | "transcribe";

export interface CommandItem {
  id: string;
  type: CommandType;
  title: string | ((context: CommandContext) => string);
  placeholder?: string;
  group?: string;
  children?: CommandItem[];
  handler?: (context: CommandContext, value?: any) => Promise<void> | void;
  validate?: (input: string) => boolean;
  message?: string;
  predicate?: (context: CommandContext) => boolean; // New field
}

export function getTitle(title: string | ((context: CommandContext) => string), context: CommandContext): string {
  return typeof title === 'function' ? title(context) : title;
}

export interface CommandContext {
  charmManager: CharmManager;
  navigate: NavigateFunction;
  focusedCharmId: string | null;
  focusedReplicaId: string | null;
  setOpen: (open: boolean) => void;
  setMode: (mode: CommandMode) => void;
  loading: boolean;
  preferredModel?: string;
  setPreferredModel: (model: string) => void;
  setLoading: (loading: boolean) => void;
  setModeWithInput: (mode: CommandMode, initialInput: string) => void;
}

export type CommandMode =
  | { type: "main" }
  | { type: "menu"; path: CommandItem[]; parent: CommandItem }
  | { type: "input"; command: CommandItem; placeholder: string; preserveInput?: boolean }
  | { type: "confirm"; command: CommandItem; message: string }
  | { type: "select"; command: CommandItem; options: SelectOption[] }
  | { type: "transcribe"; command: CommandItem; placeholder: string }
  | { type: "loading" };

export interface SelectOption {
  id: string;
  title: string;
  value: any;
}

export const castSpellAsCharm = async (charmManager: CharmManager, result: any, blob: any) => {
  const recipeKey = result?.key;

  if (recipeKey && blob) {
    console.log("Syncing...");
    const recipeId = recipeKey.replace("spell-", "");
    await charmManager.syncRecipeBlobby(recipeId);

    const recipe = getRecipe(recipeId);
    if (!recipe) return;

    console.log("Casting...");
    const doc = await charmManager.sync({ "/": blob.key }, true);
    const charm: DocImpl<Charm> = await charmManager.runPersistent(recipe, {
      cell: doc,
      path: ["argument"],
    });
    charmManager.add([charm]);
    return charm.entityId;
  }
  console.log("Failed to cast");
  return null;
};

export const commands: CommandItem[] = [
  {
    id: "new-charm",
    type: "input",
    title: "New Charm",
    group: "Create",
    handler: async (ctx, input) => {
      if (!input) return;
      ctx.setLoading(true);
      try {
        const dummyData = {
          gallery: [{ title: "pizza", prompt: "a yummy pizza" }],
        };
        const id = await castNewRecipe(ctx.charmManager, { gallery: [dummyData] }, input);
        if (id) {
          ctx.navigate(`/${ctx.focusedReplicaId}/${charmId(id)}`);
        }
      } finally {
        ctx.setLoading(false);
        ctx.setOpen(false);
      }
    },
  },
  {
    id: "search-charms",
    type: "action",
    title: "Search Charms",
    group: "Navigation",
    handler: async (ctx) => {
      ctx.setLoading(true);
      try {
        const charms = ctx.charmManager.getCharms().get();
        const results = await Promise.all(
          charms.map(async (charm) => {
            const data = charm.cell.get();
            const title = data?.[NAME] ?? 'Untitled';
            return {
              title: title + ` (#${charmId(charm.cell.entityId!).slice(-4)})`,
              id: charmId(charm.cell.entityId!),
              value: charm.cell.entityId,
            };
          }),
        );
        ctx.setMode({
          type: "select",
          command: {
            id: "charm-select",
            type: "select",
            title: "Select Charm",
            handler: async (ctx, id) => {
              console.log("Select handler called with:", id);
              console.log("Navigating to:", `/${ctx.focusedReplicaId}/${charmId(id)}`);
              ctx.navigate(`/${ctx.focusedReplicaId}/${charmId(id)}`);
              ctx.setOpen(false);
            },
          },
          options: results,
        });
      } catch (error) {
        console.error("Search charms error:", error);
      } finally {
        ctx.setLoading(false);
      }
    },
  },
  {
    id: "spellcaster",
    type: "input",
    title: "Spellcaster",
    group: "Create",
    predicate: (ctx) => !!ctx.focusedReplicaId,
    handler: async (ctx, input) => {
      if (!input || !ctx.focusedReplicaId) return;
      ctx.setLoading(true);
      try {
        const spells = await castSpell(ctx.focusedReplicaId, input);
        const compatibleSpells = spells.filter(
          (spell) => spell.compatibleBlobs && spell.compatibleBlobs.length > 0,
        );

        ctx.setMode({
          type: "select",
          command: {
            id: "spell-select",
            type: "select",
            title: "Select Spell",
            handler: async (ctx, spell: any) => {
              if (spell.compatibleBlobs.length === 1) {
                const entityId = await castSpellAsCharm(
                  ctx.charmManager,
                  spell,
                  spell.compatibleBlobs[0],
                );
                if (entityId) {
                  ctx.navigate(`/${ctx.focusedReplicaId}/${charmId(entityId)}`);
                }
                ctx.setOpen(false);
              } else {
                ctx.setMode({
                  type: "select",
                  command: {
                    id: "blob-select",
                    type: "select",
                    title: "Select Blob",
                    handler: async (ctx, blob) => {
                      const entityId = await castSpellAsCharm(ctx.charmManager, spell, blob);
                      if (entityId) {
                        ctx.navigate(`/${ctx.focusedReplicaId}/${charmId(entityId)}`);
                      }
                      ctx.setOpen(false);
                    },
                  },
                  options: spell.compatibleBlobs.map((blob: any, i: number) => ({
                    id: String(i),
                    title: `Blob ${i + 1}`,
                    value: blob,
                  })),
                });
              }
            },
          },
          options: compatibleSpells.map((spell: any, i: number) => ({
            id: String(i),
            title: `${spell.description}#${spell.name.slice(-4)} (${spell.compatibleBlobs.length})`,
            value: spell,
          })),
        });
      } catch (error) {
        console.error("Spellcaster error:", error);
      } finally {
        ctx.setLoading(false);
      }
    },
  },
  {
    id: "edit-recipe",
    type: "input",
    title: (ctx) => `Iterate${ctx.preferredModel ? ` (${ctx.preferredModel})` : ""}`,
    group: "Edit",
    predicate: (ctx) => !!ctx.focusedCharmId,
    placeholder: "What would you like to change?",
    handler: async (ctx, input) => {
      if (!input || !ctx.focusedCharmId || !ctx.focusedReplicaId) return;
      ctx.setLoading(true);
      const newCharmPath = await performIteration(
        ctx.charmManager,
        ctx.focusedCharmId,
        ctx.focusedReplicaId,
        input,
        false,
        ctx.preferredModel,
      );
      if (newCharmPath) {
        ctx.navigate(newCharmPath);
      }
      ctx.setLoading(false);
    },
  },
  {
    id: "delete-charm",
    type: "confirm",
    title: "Delete Charm",
    group: "Edit",
    predicate: (ctx) => !!ctx.focusedCharmId,
    message: "Are you sure you want to delete this charm?",
    handler: async (ctx) => {
      if (!ctx.focusedCharmId) return;
      const charm = await ctx.charmManager.get(ctx.focusedCharmId);
      if (!charm?.entityId) return;
      const result = await ctx.charmManager.remove(charm.entityId);
      if (result) {
        ctx.navigate("/");
      }
      ctx.setOpen(false);
    },
  },
  {
    id: "view-detail",
    type: "action",
    title: "View Detail",
    group: "View",
    predicate: (ctx) => !!ctx.focusedCharmId,
    handler: (ctx) => {
      if (!ctx.focusedCharmId) {
        ctx.setOpen(false);
        return;
      }
      ctx.navigate(`/${ctx.focusedReplicaId}/${ctx.focusedCharmId}/detail`);
      ctx.setOpen(false);
    },
  },
  {
    id: "edit-code",
    type: "action",
    title: "Edit Code",
    group: "View",
    predicate: (ctx) => !!ctx.focusedCharmId,
    handler: (ctx) => {
      if (!ctx.focusedCharmId) {
        ctx.setOpen(false);
        return;
      }
      ctx.navigate(`/${ctx.focusedReplicaId}/${ctx.focusedCharmId}/detail#code`);
      ctx.setOpen(false);
    },
  },
  {
    id: "view-data",
    type: "action",
    title: "View Backing Data",
    group: "View",
    predicate: (ctx) => !!ctx.focusedCharmId,
    handler: (ctx) => {
      if (!ctx.focusedCharmId) {
        ctx.setOpen(false);
        return;
      }
      ctx.navigate(`/${ctx.focusedReplicaId}/${ctx.focusedCharmId}/detail#data`);
      ctx.setOpen(false);
    },
  },
  {
    id: "view-charm",
    type: "action",
    title: "View Charm",
    group: "View",
    predicate: (ctx) => !!ctx.focusedCharmId,
    handler: (ctx) => {
      if (!ctx.focusedCharmId) {
        ctx.setOpen(false);
        return;
      }
      ctx.navigate(`/${ctx.focusedReplicaId}/${ctx.focusedCharmId}`);
      ctx.setOpen(false);
    },
  },
  {
    id: "back",
    type: "action",
    title: "Navigate Back",
    group: "Navigation",
    handler: (ctx) => {
      window.history.back();
      ctx.setOpen(false);
    },
  },
  {
    id: "home",
    type: "action",
    title: "Navigate Home",
    group: "Navigation",
    predicate: (ctx) => !!ctx.focusedReplicaId,
    handler: (ctx) => {
      if (ctx.focusedReplicaId) {
        ctx.navigate(`/${ctx.focusedReplicaId}`);
      }
      ctx.setOpen(false);
    },
  },
  {
    id: "advanced",
    type: "menu",
    title: "Advanced",
    children: [
      {
        id: "import-json",
        type: "action",
        title: "Import JSON",
        handler: async (ctx) => {
          ctx.setLoading(true);
          try {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = ".json";

            const file = await new Promise<File>((resolve) => {
              input.onchange = (e) => {
                const file = (e.target as HTMLInputElement).files?.[0];
                if (file) resolve(file);
              };
              input.click();
            });

            const text = await file.text();
            const data = JSON.parse(text);
            const title = prompt("Enter a title for your imported recipe:");
            if (!title) return;

            const id = await castNewRecipe(ctx.charmManager, data, title);
            if (id) {
              ctx.navigate(`/${ctx.focusedReplicaId}/${charmId(id)}`);
            }
          } finally {
            ctx.setLoading(false);
            ctx.setOpen(false);
          }
        },
      },
      {
        id: "load-recipe",
        type: "action",
        title: "Load Recipe",
        handler: async (ctx) => {
          ctx.setLoading(true);
          try {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = ".tsx";

            const file = await new Promise<File>((resolve) => {
              input.onchange = (e) => {
                const file = (e.target as HTMLInputElement).files?.[0];
                if (file) resolve(file);
              };
              input.click();
            });

            const src = await file.text();
            const id = await compileAndRunRecipe(ctx.charmManager, src, "imported", {});
            if (id) {
              ctx.navigate(`/${ctx.focusedReplicaId}/${charmId(id)}`);
            }
          } finally {
            ctx.setLoading(false);
            ctx.setOpen(false);
          }
        },
      },
      {
        id: "switch-replica",
        type: "input",
        title: "Switch Replica",
        placeholder: "Enter replica name",
        handler: (ctx, input) => {
          if (input) {
            // FIXME(ja): chatting with seefeld - cell should know about
            // their replica / storage provider
            // force a full reload otherwise charms and other cells are
            // written to the new replica but not all the data, and then
            // things hang!
            window.location.href = `/${input}`;
          }
          ctx.setOpen(false);
        },
      },
    ],
  },
  {
    id: "select-model",
    type: "action",
    title: "Select AI Model",
    group: "Settings",
    handler: async (ctx) => {
      ctx.setLoading(true);
      try {
        // Fetch models from API
        const response = await fetch("/api/ai/llm/models");
        const models = await response.json();

        // Transform the dictionary into select options
        const modelOptions = Object.entries(models).map(([key, model]: [string, any]) => ({
          id: key,
          title: `${key} (${model.capabilities.contextWindow.toLocaleString()} tokens)`,
          value: {
            id: key,
            ...model,
          },
        }));

        ctx.setMode({
          type: "select",
          command: {
            id: "model-select",
            type: "select",
            title: "Select Model",
            handler: async (ctx, selectedModel) => {
              ctx.setPreferredModel(selectedModel.id);
              ctx.setOpen(false);
            },
          },
          options: modelOptions,
        });
      } catch (error) {
        console.error("Failed to fetch models:", error);
      } finally {
        ctx.setLoading(false);
      }
    },
  },
  {
    id: "edit-recipe-voice",
    type: "transcribe",
    title: (ctx) => `Iterate (Voice)${ctx.preferredModel ? ` (${ctx.preferredModel})` : ""}`,
    group: "Edit",
    predicate: (ctx) => !!ctx.focusedCharmId,
    handler: async (ctx, transcription) => {
      if (!transcription) return;

      // Find the edit-recipe command
      const editRecipeCommand = commands.find(cmd => cmd.id === "edit-recipe")!;

      // Set the mode to input with the transcribed text pre-filled
      ctx.setModeWithInput({
        type: "input",
        command: editRecipeCommand,
        placeholder: "What would you like to change?",
        preserveInput: true
      }, transcription);
    },
  }
];
