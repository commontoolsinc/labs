import "./commands.css";
import {
  addGithubRecipe,
  castSpellAsCharm,
  Charm,
  CharmManager,
  compileAndRunRecipe,
  createDataCharm,
  processWorkflow,
  renameCharm,
  searchCharms,
  WorkflowForm,
} from "@commontools/charm";
import { formatJsonImportPrompt } from "@commontools/llm";
import { charmId } from "@commontools/charm";
import type { NavigateFunction } from "react-router-dom";
import { NAME } from "@commontools/builder";
import { isStream } from "@commontools/runner";
import { createPath, createPathWithHash, ROUTES } from "@/routes.ts";
import { LanguageModelId } from "@/components/common/ModelSelector.tsx";

export type CommandType =
  | "action"
  | "input"
  | "confirm"
  | "select"
  | "menu"
  | "transcribe"
  | "placeholder";

// Base interface with common properties
interface BaseCommandItem {
  id: string;
  type: CommandType;
  title: string;
  group?: string;
  predicate?: boolean;
}

// Action command
export interface ActionCommandItem extends BaseCommandItem {
  type: "action";
  handler: () => Promise<void> | void;
}

// Input command
export interface InputCommandItem extends BaseCommandItem {
  type: "input";
  placeholder?: string;
  handler: (ctx: CommandContext, input: string) => Promise<void> | void;
  validate?: (input: string) => boolean;
}

// Confirm command
export interface ConfirmCommandItem extends BaseCommandItem {
  type: "confirm";
  message: string;
  handler: (context: CommandContext) => Promise<void> | void;
}

// Select command
export interface SelectCommandItem extends BaseCommandItem {
  type: "select";
  handler: (selected: any) => Promise<void> | void;
}

// Menu command
export interface MenuCommandItem extends BaseCommandItem {
  type: "menu";
  children: CommandItem[];
}

// Transcribe command
export interface TranscribeCommandItem extends BaseCommandItem {
  type: "transcribe";
  placeholder?: string;
  handler: (transcription: string) => Promise<void> | void;
}

// Placeholder command
export interface PlaceholderCommandItem extends BaseCommandItem {
  type: "placeholder";
}

// Union type for all command types
export type CommandItem =
  | ActionCommandItem
  | InputCommandItem
  | ConfirmCommandItem
  | SelectCommandItem
  | MenuCommandItem
  | TranscribeCommandItem
  | PlaceholderCommandItem;

export interface Recipe {
  argumentSchema: any; // Schema type from jsonschema
  resultSchema: any; // Schema type from jsonschema
  initial?: any;
}

export interface Spell {
  recipe: Recipe;
  spec: string;
  recipeName?: string;
  spellbookTitle?: string;
  spellbookTags?: string[];
}

export function getTitle(
  title: string | ((context: CommandContext) => string),
  context: CommandContext,
): string {
  return typeof title === "function" ? title(context) : title;
}

export function getChildren(
  // TODO(bf): type signature is sus
  children:
    | CommandItem[]
    | ((context: CommandContext) => CommandItem[])
    | undefined,
  context: CommandContext,
): CommandItem[] {
  if (!children) return [];
  return typeof children === "function" ? children(context) : children;
}

export interface CommandContext {
  charmManager: CharmManager;
  userPreferredModel: LanguageModelId;
  navigate: NavigateFunction;
  focusedCharmId: string | null;
  focusedReplicaId: string | null;
  setOpen: (open: boolean) => void;
  setMode: (mode: CommandMode) => void;
  loading: boolean;
  setLoading: (loading: boolean) => void;
  setModeWithInput: (mode: CommandMode, initialInput: string) => void;
  commandPathIds: string[];
  previewForm?: Partial<WorkflowForm>;
  onClearAuthentication: () => void;
}

export type CommandMode =
  | { type: "main" }
  | { type: "menu"; path: string[]; parent: CommandItem }
  | {
    type: "input";
    command: CommandItem;
    placeholder: string;
    preserveInput?: boolean;
  }
  | { type: "confirm"; command: CommandItem; message: string }
  | { type: "select"; command: CommandItem; options: SelectOption[] }
  | { type: "transcribe"; command: CommandItem; placeholder: string }
  | { type: "loading" }
  | { type: "placeholder" };

export interface SelectOption {
  id: string;
  title: string;
  value: any;
}

async function handleExecuteCharmAction(ctx: CommandContext) {
  ctx.setLoading(true);
  try {
    if (!ctx.focusedCharmId || !ctx.focusedReplicaId) {
      throw new Error("No charm is focused");
    }

    const charm = await ctx.charmManager.get(ctx.focusedCharmId);
    if (!charm) {
      throw new Error("Failed to load charm");
    }

    const entries = Object.entries(charm.get());
    // Filter entries to find stream objects (which have .send and .sink functions)
    const actions = entries.filter(([_, value]) => isStream(value));

    if (actions.length === 0) {
      ctx.setOpen(false);
      return;
    }

    // Create options for the select menu with key as the action name
    const actionOptions = actions.map(([key, stream]) => {
      const example = JSON.stringify(charm.key(key).schema?.example);
      return {
        id: key,
        title: key,
        value: { key, stream, example },
      };
    });

    // Show selection menu for actions
    ctx.setMode({
      type: "select",
      command: {
        id: "charm-action-select",
        type: "select",
        title: "Select Action to Execute",
        handler: (selectedAction) => {
          // Prompt for input parameters for the action
          ctx.setMode({
            type: "input",
            command: {
              id: "action-params",
              type: "input",
              title: `Input for ${selectedAction.key}`,
              placeholder: selectedAction.example || "Enter input data",
              handler: (input) => {
                try {
                  // Execute the action by calling .send with the user input
                  selectedAction.stream.send(input);
                  console.log(
                    `Executed action ${selectedAction.key} with input:`,
                    input,
                  );
                  ctx.setOpen(false);
                } catch (error) {
                  console.error(
                    `Error executing action ${selectedAction.key}:`,
                    error,
                  );
                  ctx.setOpen(false);
                }
              },
            },
            placeholder: selectedAction.example || "Enter input data",
          });
        },
      },
      options: actionOptions,
    });
  } catch (error) {
    console.error("Error fetching charm actions:", error);
  } finally {
    ctx.setLoading(false);
  }
}

function navigateToCharm(ctx: CommandContext, charm: Charm | string) {
  // Navigate to the new charm
  const id = typeof charm === "string" ? charm : charmId(charm);
  if (!id || !ctx.focusedReplicaId) {
    throw new Error("Missing charm ID or replica name");
  }

  ctx.navigate(
    createPath("charmShow", {
      charmId: id,
      replicaName: ctx.focusedReplicaId,
    }),
  );
}

async function handleNewCharm(
  ctx: CommandContext,
  input: string,
) {
  if (!input) return;

  try {
    const form = await processWorkflow(
      input,
      ctx.charmManager,
      {
        prefill: ctx.previewForm,
        model: ctx.userPreferredModel,
        permittedWorkflows: ["imagine", "cast-spell"],
      },
    );
    const charm = form.generation?.charm;
    if (charm) {
      navigateToCharm(ctx, charm);
    }
  } catch (error) {
    console.error("New charm operation error:", error);
  } finally {
    ctx.setOpen(false);
  }
}

async function handleRenameCharm(
  ctx: CommandContext,
  input: string | undefined,
) {
  if (!input || !ctx.focusedCharmId || !ctx.focusedReplicaId) return;
  ctx.setLoading(true);

  await renameCharm(ctx.charmManager, ctx.focusedCharmId, input);

  ctx.setLoading(false);
  ctx.setOpen(false);
}

async function handleDeleteCharm(ctx: CommandContext) {
  if (!ctx.focusedCharmId) return;
  const result = await ctx.charmManager.remove(ctx.focusedCharmId);
  if (result) ctx.navigate(ROUTES.root);
  else ctx.setOpen(false);
}

async function handleImportJSON(ctx: CommandContext) {
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

    ctx.setOpen(false);

    const newCharm = await createDataCharm(
      ctx.charmManager,
      data,
      undefined,
      title,
    );
    if (!newCharm) throw new Error("Failed to create new charm");

    navigateToCharm(ctx, newCharm);
  } finally {
    ctx.setOpen(false);
  }
}

async function handleLoadRecipe(ctx: CommandContext) {
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
    const newCharm = await compileAndRunRecipe(
      ctx.charmManager,
      src,
      "imported",
      {},
    );
    if (!newCharm) {
      throw new Error("Failed to cast charm");
    }

    navigateToCharm(ctx, newCharm);
  } finally {
    ctx.setLoading(false);
    ctx.setOpen(false);
  }
}

async function handleUseDataInSpell(ctx: CommandContext) {
  ctx.setLoading(true);
  try {
    if (!ctx.focusedCharmId || !ctx.focusedReplicaId) {
      return;
    }

    const response = await fetch("/api/ai/spell/reuse", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        charmId: ctx.focusedCharmId,
        replica: ctx.focusedReplicaId,
      }),
    });

    ctx.setLoading(false);

    const result = await response.json();
    const compatibleSpells: Record<string, Spell> = result.compatibleSpells;

    const spells = Object.entries(compatibleSpells).map(([spellId, spell]) => ({
      id: spellId,
      title: `${spell.recipeName} (#${spellId.slice(-4)}) - ${spell.spec}`,
      value: { ...spell, id: spellId },
    }));

    ctx.setMode({
      type: "select",
      command: {
        id: "spell-select",
        type: "select",
        title: "Select Spell to Use",
        handler: async (selectedSpell) => {
          console.log("Selected spell:", selectedSpell);
          if (!ctx.focusedCharmId) {
            throw new Error("No charm selected");
          }

          const charm = await ctx.charmManager.get(ctx.focusedCharmId);
          if (!charm) throw new Error("No current charm found");
          const argument = ctx.charmManager.getArgument(charm);

          ctx.setLoading(true);
          const newCharm = await castSpellAsCharm(
            ctx.charmManager,
            selectedSpell.id,
            argument,
          );

          if (!newCharm) {
            throw new Error("No source cell found");
          }
          navigateToCharm(ctx, newCharm);
          ctx.setOpen(false);
          ctx.setLoading(false);
        },
      },
      options: spells,
    });
  } catch (e) {
    console.error("Error casting spell:", e);
  } finally {
    ctx.setLoading(false);
  }
}

async function handleUseSpellOnOtherData(ctx: CommandContext) {
  ctx.setLoading(true);
  try {
    if (!ctx.focusedCharmId || !ctx.focusedReplicaId) {
      return;
    }

    const response = await fetch("/api/ai/spell/recast", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        charmId: ctx.focusedCharmId,
        replica: ctx.focusedReplicaId,
      }),
    });

    // {
    //   spell: {...},
    //   cells: {
    //     'id': { argument: { test: 1 } , ...},
    //     'id2': {...}
    //   }
    // }

    ctx.setLoading(false);

    const result = await response.json();
    const spellId: string = result.spellId;
    const cells: Record<string, { argument: any }> = result.cells;

    const charms = Object.entries(cells).map(([id, cell]) => ({
      id,
      title: `${JSON.stringify(cell.argument).slice(0, 30)}... (#${
        id.slice(-4)
      })`,
      value: { id, cell },
    }));

    ctx.setMode({
      type: "select",
      command: {
        id: "charm-select",
        type: "select",
        title: "Select Cell to Use Spell On",
        handler: async (selectedCell) => {
          console.log("Selected cell:", selectedCell);
          if (!selectedCell.id) {
            throw new Error("No cell selected");
          }

          ctx.setLoading(true);

          console.log("Syncing blob...");
          // TODO(ben,seefeld): We might want spellcaster to return docId/path
          // pairs and use those directly instead of hardcoding `argument` here.
          const argument = await ctx.charmManager.getCellById({
            "/": selectedCell.id,
          }, ["argument"]);

          const newCharm = await castSpellAsCharm(
            ctx.charmManager,
            spellId,
            argument,
          );
          if (!newCharm) throw new Error("Failed to cast spell");

          navigateToCharm(ctx, newCharm);
          ctx.setOpen(false);
          ctx.setLoading(false);
        },
      },
      options: charms,
    });
  } catch (e) {
    console.error("Error casting spell:", e);
  } finally {
    ctx.setLoading(false);
  }
}

async function handleAddRemoteRecipe(
  ctx: CommandContext,
  filename: string,
  name: string,
) {
  ctx.setLoading(true);
  try {
    const newCharm = await addGithubRecipe(
      ctx.charmManager,
      filename,
      name,
      {},
    );

    navigateToCharm(ctx, newCharm);
  } catch (error) {
    console.error(`Error loading ${filename}:`, error);
  } finally {
    ctx.setLoading(false);
    ctx.setOpen(false);
  }
}

export function handleOpenFullscreenInspector() {
  const url = new URL(globalThis.location.origin);
  url.pathname = "/inspector";
  globalThis.open(url.href, "_blank");
}

export function getCommands(ctx: CommandContext): CommandItem[] {
  return [
    {
      id: "new-charm",
      type: "input",
      title: "New Charm",
      group: "Charm",
      handler: handleNewCharm,
    },
    {
      id: "edit-mode",
      type: "action",
      title: "Edit Mode",
      group: "Charm",
      predicate: !!ctx.focusedCharmId &&
        !globalThis.location.hash.includes("#iterate"),
      handler: () => {
        if (!ctx.focusedCharmId || !ctx.focusedReplicaId) {
          ctx.setOpen(false);
          return;
        }
        ctx.navigate(
          createPathWithHash(
            "charmDetail",
            {
              charmId: ctx.focusedCharmId,
              replicaName: ctx.focusedReplicaId,
            },
            "iterate",
          ),
        );
        ctx.setOpen(false);
      },
    },
    {
      id: "view-mode",
      type: "action",
      title: "View Mode",
      group: "Charm",
      predicate: !!ctx.focusedCharmId &&
        globalThis.location.pathname.includes("/detail"),
      handler: () => {
        if (!ctx.focusedCharmId || !ctx.focusedReplicaId) {
          console.warn("Missing charm ID or replica name");
          ctx.setOpen(false);
          return;
        }
        navigateToCharm(ctx, ctx.focusedCharmId);
        ctx.setOpen(false);
      },
    },
    {
      id: "execute-charm-action",
      type: "action",
      title: "Execute Charm Action",
      group: "Action",
      predicate: !!ctx.focusedCharmId,
      handler: () => handleExecuteCharmAction(ctx),
    },
    {
      id: "open-in-stack",
      type: "action",
      title: "Open in Stack",
      group: "Navigation",
      predicate: !!ctx.focusedCharmId,
      handler: async () => {
        ctx.setLoading(true);
        try {
          const charms = ctx.charmManager.getCharms();
          await ctx.charmManager.sync(charms);
          const results = charms.get().map((charm) => {
            const data = charm.get();
            const title = data?.[NAME] ?? "Untitled";
            return {
              title: title + ` (#${charmId(charm.entityId!)!.slice(-4)})`,
              id: charmId(charm.entityId!)!,
              value: charm.entityId!,
            };
          });
          ctx.setMode({
            type: "select",
            command: {
              id: "stack-charm-select",
              type: "select",
              title: "Select Charm for Stack",
              handler: (selected) => {
                const id = charmId(selected);
                if (!id || !ctx.focusedReplicaId) {
                  throw new Error("Missing charm ID or replica name");
                }
                // Navigate to stack URL instead of detail page
                const path = createPath("stackedCharms", {
                  charmIds: ctx.focusedCharmId + "," + id,
                  replicaName: ctx.focusedReplicaId,
                });
                ctx.navigate(path);
                ctx.setOpen(false);
              },
            },
            options: results,
          });
        } catch (error) {
          console.error("Open in stack error:", error);
        } finally {
          ctx.setLoading(false);
        }
      },
    },
    {
      id: "spellcaster-menu",
      type: "menu",
      title: "Spellcaster",
      group: "Action",
      predicate: !!ctx.focusedReplicaId,
      children: [
        {
          id: "use-data-in-spell",
          type: "action",
          title: "Use Data with...",
          predicate: !!ctx.focusedCharmId,
          handler: () => handleUseDataInSpell(ctx),
        },
        {
          id: "use-spell-on-other-data",
          type: "action",
          title: "Re-cast Spell with...",
          predicate: !!ctx.focusedCharmId,
          handler: () => handleUseSpellOnOtherData(ctx),
        },
      ],
    },
    {
      id: "rename-charm",
      type: "input",
      title: "Rename Charm",
      group: "Charm",
      predicate: !!ctx.focusedCharmId,
      handler: handleRenameCharm,
    },
    {
      id: "duplicate-charm",
      type: "action",
      title: "Duplicate Charm",
      "group": "Charm",
      handler: async () => {
        if (!ctx.focusedCharmId) {
          ctx.setOpen(false);
          return;
        }

        ctx.setLoading(true);

        const charm = await ctx.charmManager.get(ctx.focusedCharmId);
        if (!charm) {
          ctx.setLoading(false);
          console.error("Failed to load charm", ctx.focusedCharmId);
          return;
        }

        const newCharm = await ctx.charmManager.duplicate(charm);
        navigateToCharm(ctx, newCharm);
        ctx.setLoading(false);
        ctx.setOpen(false);
      },
    },
    {
      id: "delete-charm",
      type: "confirm",
      title: "Delete Charm",
      group: "Charm",
      predicate: !!ctx.focusedCharmId,
      message: "Are you sure you want to delete this charm?",
      handler: () => handleDeleteCharm(ctx),
    },
    {
      id: "pin-charm",
      type: "action",
      title: "Pin Charm",
      group: "Action",
      predicate: !!ctx.focusedCharmId,
      handler: async () => {
        if (!ctx.focusedCharmId || !ctx.focusedReplicaId) {
          ctx.setOpen(false);
          return;
        }

        const charm = await ctx.charmManager.get(ctx.focusedCharmId);
        if (!charm) {
          console.error("Failed to load charm", ctx.focusedCharmId);
          return;
        }

        await ctx.charmManager.pin(charm);
        ctx.setOpen(false);
      },
    },
    {
      id: "unpin-charm",
      type: "action",
      title: "Unpin Charm",
      group: "Action",
      predicate: !!ctx.focusedCharmId,
      handler: async () => {
        if (!ctx.focusedCharmId || !ctx.focusedReplicaId) {
          ctx.setOpen(false);
          return;
        }

        const charm = await ctx.charmManager.get(ctx.focusedCharmId);
        if (!charm) {
          console.error("Failed to load charm", ctx.focusedCharmId);
          return;
        }

        await ctx.charmManager.unpin(charm);
        ctx.setOpen(false);
      },
    },

    {
      id: "back",
      type: "action",
      title: "Navigate Back",
      group: "Navigation",
      handler: () => {
        globalThis.history.back();
        ctx.setOpen(false);
      },
    },
    {
      id: "home",
      type: "action",
      title: "Navigate Home",
      group: "Navigation",
      predicate: !!ctx.focusedReplicaId,
      handler: () => {
        if (ctx.focusedReplicaId) {
          ctx.navigate(
            createPath("replicaRoot", { replicaName: ctx.focusedReplicaId }),
          );
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
          id: "enable-network-inspector",
          type: "action",
          title: "Enable Network Inspector",
          predicate: localStorage.getItem("networkInspectorVisible") !== "true",
          handler: () => {
            localStorage.setItem("networkInspectorVisible", "true");
            ctx.setOpen(false);
            // Refresh the page to ensure the setting takes effect
            globalThis.location.reload();
          },
        },
        {
          id: "disable-network-inspector",
          type: "action",
          title: "Disable Network Inspector",
          predicate: localStorage.getItem("networkInspectorVisible") === "true",
          handler: () => {
            localStorage.setItem("networkInspectorVisible", "false");
            ctx.setOpen(false);
            // Refresh the page to ensure the setting takes effect
            globalThis.location.reload();
          },
        },
        {
          id: "open-fs-network-inspector",
          type: "action",
          title: "Open Network Inspector (new tab)",
          handler: handleOpenFullscreenInspector,
        },
        {
          id: "import-json",
          type: "action",
          title: "Import JSON",
          handler: () => handleImportJSON(ctx),
        },
        {
          id: "load-recipe",
          type: "action",
          title: "Load Recipe",
          handler: () => handleLoadRecipe(ctx),
        },
        {
          id: "switch-replica",
          type: "input",
          title: "Switch Space",
          placeholder: "Enter space name",
          handler: (input) => {
            if (input) {
              globalThis.location.href = `/${input}`;
            }
            ctx.setOpen(false);
          },
        },
        {
          id: "add-gmail-importer",
          type: "action",
          title: "Add Gmail Importer",
          handler: () =>
            handleAddRemoteRecipe(ctx, "gmail.tsx", "GMail Importer"),
        },
        {
          id: "add-gcal-importer",
          type: "action",
          title: "Add GCal Importer",
          handler: () =>
            handleAddRemoteRecipe(ctx, "gcal.tsx", "GCal Importer"),
        },
        {
          id: "add-rss-importer",
          type: "action",
          title: "Add RSS Importer",
          handler: () => handleAddRemoteRecipe(ctx, "rss.tsx", "RSS Importer"),
        },
      ],
    },
    {
      id: "logout",
      type: "action",
      title: "Logout",
      group: "User",
      handler: () => {
        ctx.onClearAuthentication();
        ctx.setOpen(false);
      },
    },
  ];
}

export function isInputCommand(
  cmd: CommandItem,
): cmd is CommandItem & { type: "input" } {
  return cmd.type === "input";
}

export function isTranscribeCommand(
  cmd: CommandItem,
): cmd is CommandItem & { type: "transcribe" } {
  return cmd.type === "transcribe";
}

export function isConfirmCommand(
  cmd: CommandItem,
): cmd is CommandItem & { type: "confirm" } {
  return cmd.type === "confirm";
}
