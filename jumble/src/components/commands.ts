import "./commands.css";
import {
  addGithubRecipe,
  castNewRecipe,
  castSpellAsCharm,
  Charm,
  CharmManager,
  compileAndRunRecipe,
  createWorkflowForm,
  renameCharm,
  WorkflowForm,
  WorkflowType,
} from "@commontools/charm";
import {
  executeWorkflow,
  ExecutionPlan,
  modifyCharm,
} from "@commontools/charm";
// Import NavigateFunction from our types rather than directly from react-router-dom
import type { NavigateFunction } from "react-router-dom";
import { charmId } from "@/utils/charms.ts";
import { NAME } from "@commontools/builder";
import { EntityId, isStream } from "@commontools/runner";
import { BackgroundJob } from "@/contexts/BackgroundTaskContext.tsx";
import { startCharmIndexing } from "@/utils/indexing.ts";
import { createPath, createPathWithHash, ROUTES } from "@/routes.ts";
import { grabCells, SourceSet } from "@/utils/format.ts";

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
  handler: (input: string, sources?: any) => Promise<void> | void;
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
  navigate: NavigateFunction;
  focusedCharmId: string | null;
  focusedReplicaId: string | null;
  setOpen: (open: boolean) => void;
  setMode: (mode: CommandMode) => void;
  loading: boolean;
  setLoading: (loading: boolean) => void;
  setModeWithInput: (mode: CommandMode, initialInput: string) => void;
  listJobs: () => BackgroundJob[];
  startJob: (name: string) => string;
  stopJob: (jobId: string) => void;
  addJobMessage: (jobId: string, message: string) => void;
  updateJobProgress: (jobId: string, progress: number) => void;
  commandPathIds: string[];
  previewForm?: Partial<WorkflowForm>;
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

async function handleExecuteCharmAction(deps: CommandContext) {
  deps.setLoading(true);
  try {
    if (!deps.focusedCharmId || !deps.focusedReplicaId) {
      throw new Error("No charm is focused");
    }

    const charm = await deps.charmManager.get(deps.focusedCharmId);
    if (!charm) {
      throw new Error("Failed to load charm");
    }

    const entries = Object.entries(charm.get());
    // Filter entries to find stream objects (which have .send and .sink functions)
    const actions = entries.filter(([_, value]) => isStream(value));

    if (actions.length === 0) {
      deps.setOpen(false);
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
    deps.setMode({
      type: "select",
      command: {
        id: "charm-action-select",
        type: "select",
        title: "Select Action to Execute",
        handler: (selectedAction) => {
          // Prompt for input parameters for the action
          deps.setMode({
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
                  deps.setOpen(false);
                } catch (error) {
                  console.error(
                    `Error executing action ${selectedAction.key}:`,
                    error,
                  );
                  deps.setOpen(false);
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
    deps.addJobMessage(
      deps.startJob("Action Error"),
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    deps.setLoading(false);
  }
}

function navigateToCharm(deps: CommandContext, charm: Charm | string) {
  // Navigate to the new charm
  const id = typeof charm === "string" ? charm : charmId(charm);
  if (!id || !deps.focusedReplicaId) {
    throw new Error("Missing charm ID or replica name");
  }

  deps.navigate(
    createPath("charmShow", {
      charmId: id,
      replicaName: deps.focusedReplicaId,
    }),
  );
}

// Command handlers
// Unified handler for charm operations using the imagine function
async function handleModifyCharm(
  deps: CommandContext,
  input: string,
  options?: { model: string },
) {
  if (!input) return;
  deps.setLoading(true);

  try {
    let newCharm;

    // bf: I suspect this is pointless and already handled in executeWorkflow
    if (deps.focusedCharmId) {
      // Get the current charm
      const charm = await deps.charmManager.get(deps.focusedCharmId, false);
      if (!charm) {
        throw new Error("Failed to load charm");
      }

      newCharm = await modifyCharm(
        deps.charmManager,
        input,
        charm,
        deps.previewForm,
        options?.model,
      );
    } else {
      console.warn("Attempted to modify charm without a focused charm ID");
    }

    if (!newCharm) {
      throw new Error("Failed to create charm");
    }

    navigateToCharm(deps, newCharm.get());
  } catch (error) {
    console.error("Imagine operation error:", error);
  } finally {
    deps.setLoading(false);
    deps.setOpen(false);
  }
}

async function handleNewCharm(
  deps: CommandContext,
  input: string,
  options?: { model: string },
) {
  if (!input) return;
  deps.setLoading(true);

  try {
    const newCharm = await executeWorkflow(
      deps.charmManager,
      input,
      {
        prefill: deps.previewForm,
        model: options?.model,
      },
    );

    navigateToCharm(deps, newCharm.get());
  } catch (error) {
    console.error("New charm operation error:", error);
  } finally {
    deps.setLoading(false);
    deps.setOpen(false);
  }
}

async function handleSearchCharms(deps: CommandContext) {
  deps.setLoading(true);
  try {
    const charms = deps.charmManager.getCharms();
    await deps.charmManager.sync(charms);
    const results = charms.get().map((charm) => {
      const data = charm.get();
      const title = data?.[NAME] ?? "Untitled";
      return {
        title: title + ` (#${charmId(charm.entityId!)!.slice(-4)})`,
        id: charmId(charm.entityId!)!,
        value: charm.entityId!,
      };
    });
    deps.setMode({
      type: "select",
      command: {
        id: "charm-select",
        type: "select",
        title: "Select Charm",
        handler: (selected) => {
          navigateToCharm(deps, selected);
          deps.setOpen(false);
        },
      },
      options: results,
    });
  } catch (error) {
    console.error("Search charms error:", error);
  } finally {
    deps.setLoading(false);
  }
}

async function handleRenameCharm(
  deps: CommandContext,
  input: string | undefined,
) {
  if (!input || !deps.focusedCharmId || !deps.focusedReplicaId) return;
  deps.setLoading(true);

  await renameCharm(deps.charmManager, deps.focusedCharmId, input);

  deps.setLoading(false);
  deps.setOpen(false);
}

async function handleDeleteCharm(deps: CommandContext) {
  if (!deps.focusedCharmId) return;
  const result = await deps.charmManager.remove(deps.focusedCharmId);
  if (result) deps.navigate(ROUTES.root);
  else deps.setOpen(false);
}

function handleStartCounterJob(deps: CommandContext) {
  const jobId = deps.startJob("Counter Job");
  console.log("Started counter job with ID:", jobId);

  const interval = setInterval(() => {
    const job = deps.listJobs().find((j) => j.id === jobId);
    console.log("Current job state:", job);

    if (!job || job.status !== "running") {
      console.log("Job stopped or not found, clearing interval");
      clearInterval(interval);
      return;
    }

    const currentCount = parseInt(
      job.messages[job.messages.length - 1]?.split(": ")[1] || "0",
    );
    const newCount = currentCount + 1;
    console.log("Updating count from", currentCount, "to", newCount);

    deps.addJobMessage(jobId, `Count: ${newCount}`);
    console.log(`Count: ${newCount}`);
    deps.updateJobProgress(jobId, (newCount % 100) / 100);

    if (newCount >= 1000) {
      console.log("Reached max count, stopping job");
      deps.stopJob(jobId);
      clearInterval(interval);
    }
  }, 1000);

  console.log("Adding initial message");
  deps.addJobMessage(jobId, "Count: 0");
  deps.setOpen(false);
}

async function handleImportJSON(deps: CommandContext) {
  deps.setLoading(true);
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

    const form = createWorkflowForm({ input: title });
    form.input.references = data;

    const newCharm = await castNewRecipe(deps.charmManager, form);
    if (!newCharm) throw new Error("Failed to create new charm");

    navigateToCharm(deps, newCharm);
  } finally {
    deps.setLoading(false);
    deps.setOpen(false);
  }
}

async function handleLoadRecipe(deps: CommandContext) {
  deps.setLoading(true);
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
      deps.charmManager,
      src,
      "imported",
      {},
    );
    if (!newCharm) {
      throw new Error("Failed to cast charm");
    }

    navigateToCharm(deps, newCharm);
  } finally {
    deps.setLoading(false);
    deps.setOpen(false);
  }
}

function handleIndexCharms(deps: CommandContext) {
  startCharmIndexing(deps.charmManager, {
    startJob: deps.startJob,
    stopJob: deps.stopJob,
    addJobMessage: deps.addJobMessage,
    updateJobProgress: deps.updateJobProgress,
    listJobs: deps.listJobs,
  });
  deps.setOpen(false);
}

async function handleUseDataInSpell(deps: CommandContext) {
  deps.setLoading(true);
  try {
    if (!deps.focusedCharmId || !deps.focusedReplicaId) {
      return;
    }

    const response = await fetch("/api/ai/spell/reuse", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        charmId: deps.focusedCharmId,
        replica: deps.focusedReplicaId,
      }),
    });

    deps.setLoading(false);

    const result = await response.json();
    const compatibleSpells: Record<string, Spell> = result.compatibleSpells;

    const spells = Object.entries(compatibleSpells).map(([spellId, spell]) => ({
      id: spellId,
      title: `${spell.recipeName} (#${spellId.slice(-4)}) - ${spell.spec}`,
      value: { ...spell, id: spellId },
    }));

    deps.setMode({
      type: "select",
      command: {
        id: "spell-select",
        type: "select",
        title: "Select Spell to Use",
        handler: async (selectedSpell) => {
          console.log("Selected spell:", selectedSpell);
          if (!deps.focusedCharmId) {
            throw new Error("No charm selected");
          }

          const charm = await deps.charmManager.get(deps.focusedCharmId);
          if (!charm) throw new Error("No current charm found");
          const argument = deps.charmManager.getArgument(charm);
          if (!argument) {
            throw new Error("No sourceCell/argument found for current charm");
          }

          deps.setLoading(true);
          const newCharm = await castSpellAsCharm(
            deps.charmManager,
            selectedSpell.id,
            argument,
          );

          if (!newCharm) {
            throw new Error("No source cell found");
          }
          navigateToCharm(deps, newCharm);
          deps.setOpen(false);
          deps.setLoading(false);
        },
      },
      options: spells,
    });
  } catch (e) {
    console.error("Error casting spell:", e);
  } finally {
    deps.setLoading(false);
  }
}

async function handleUseSpellOnOtherData(deps: CommandContext) {
  deps.setLoading(true);
  try {
    if (!deps.focusedCharmId || !deps.focusedReplicaId) {
      return;
    }

    const response = await fetch("/api/ai/spell/recast", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        charmId: deps.focusedCharmId,
        replica: deps.focusedReplicaId,
      }),
    });

    // {
    //   spell: {...},
    //   cells: {
    //     'id': { argument: { test: 1 } , ...},
    //     'id2': {...}
    //   }
    // }

    deps.setLoading(false);

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

    deps.setMode({
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

          deps.setLoading(true);

          console.log("Syncing blob...");
          // TODO(ben,seefeld): We might want spellcaster to return docId/path
          // pairs and use those directly instead of hardcoding `argument` here.
          const argument = await deps.charmManager.getCellById({
            "/": selectedCell.id,
          }, ["argument"]);

          const newCharm = await castSpellAsCharm(
            deps.charmManager,
            spellId,
            argument,
          );
          if (!newCharm) throw new Error("Failed to cast spell");

          navigateToCharm(deps, newCharm);
          deps.setOpen(false);
          deps.setLoading(false);
        },
      },
      options: charms,
    });
  } catch (e) {
    console.error("Error casting spell:", e);
  } finally {
    deps.setLoading(false);
  }
}

async function handleAddRemoteRecipe(
  deps: CommandContext,
  filename: string,
  name: string,
) {
  deps.setLoading(true);
  try {
    const newCharm = await addGithubRecipe(
      deps.charmManager,
      filename,
      name,
      {},
    );

    navigateToCharm(deps, newCharm);
  } catch (error) {
    console.error(`Error loading ${filename}:`, error);
  } finally {
    deps.setLoading(false);
    deps.setOpen(false);
  }
}

export function getCommands(deps: CommandContext): CommandItem[] {
  return [
    {
      id: "new-charm",
      type: "input",
      title: "New Charm",
      group: "Create",
      handler: (input) => handleNewCharm(deps, input),
    },
    {
      id: "search-charms",
      type: "action",
      title: "Search Charms",
      group: "Navigation",
      handler: () => handleSearchCharms(deps),
    },
    {
      id: "execute-charm-action",
      type: "action",
      title: "Execute Charm Action",
      group: "Action",
      predicate: !!deps.focusedCharmId,
      handler: () => handleExecuteCharmAction(deps),
    },
    {
      id: "open-in-stack",
      type: "action",
      title: "Open in Stack",
      group: "Navigation",
      handler: async () => {
        deps.setLoading(true);
        try {
          const charms = deps.charmManager.getCharms();
          await deps.charmManager.sync(charms);
          const results = charms.get().map((charm) => {
            const data = charm.get();
            const title = data?.[NAME] ?? "Untitled";
            return {
              title: title + ` (#${charmId(charm.entityId!)!.slice(-4)})`,
              id: charmId(charm.entityId!)!,
              value: charm.entityId!,
            };
          });
          deps.setMode({
            type: "select",
            command: {
              id: "stack-charm-select",
              type: "select",
              title: "Select Charm for Stack",
              handler: (selected) => {
                navigateToCharm(deps, selected);
                deps.setOpen(false);
              },
            },
            options: results,
          });
        } catch (error) {
          console.error("Open in stack error:", error);
        } finally {
          deps.setLoading(false);
        }
      },
    },
    {
      id: "spellcaster-menu",
      type: "menu",
      title: "Spellcaster",
      group: "Create",
      predicate: !!deps.focusedReplicaId,
      children: [
        {
          id: "use-data-in-spell",
          type: "action",
          title: "Use Data with...",
          predicate: !!deps.focusedCharmId,
          handler: () => handleUseDataInSpell(deps),
        },
        {
          id: "use-spell-on-other-data",
          type: "action",
          title: "Re-cast Spell with...",
          predicate: !!deps.focusedCharmId,
          handler: () => handleUseSpellOnOtherData(deps),
        },
      ],
    },
    {
      id: "rename-charm",
      type: "input",
      title: "Rename Charm",
      group: "Edit",
      predicate: !!deps.focusedCharmId,
      handler: (input) => handleRenameCharm(deps, input),
    },
    {
      id: "edit-recipe",
      type: "input",
      title: `Modify Charm`,
      group: "Edit",
      predicate: !!deps.focusedCharmId,
      placeholder: "What would you like to change?",
      handler: (input) => handleModifyCharm(deps, input),
    },
    {
      id: "delete-charm",
      type: "confirm",
      title: "Delete Charm",
      group: "Edit",
      predicate: !!deps.focusedCharmId,
      message: "Are you sure you want to delete this charm?",
      handler: () => handleDeleteCharm(deps),
    },
    {
      id: "pin-charm",
      type: "action",
      title: "Pin Charm",
      group: "View",
      predicate: !!deps.focusedCharmId,
      handler: async () => {
        if (!deps.focusedCharmId || !deps.focusedReplicaId) {
          deps.setOpen(false);
          return;
        }

        const charm = await deps.charmManager.get(deps.focusedCharmId);
        if (!charm) {
          console.error("Failed to load charm", deps.focusedCharmId);
          return;
        }

        await deps.charmManager.pin(charm);
        deps.setOpen(false);
      },
    },
    {
      id: "unpin-charm",
      type: "action",
      title: "Unpin Charm",
      group: "View",
      predicate: !!deps.focusedCharmId,
      handler: async () => {
        if (!deps.focusedCharmId || !deps.focusedReplicaId) {
          deps.setOpen(false);
          return;
        }

        const charm = await deps.charmManager.get(deps.focusedCharmId);
        if (!charm) {
          console.error("Failed to load charm", deps.focusedCharmId);
          return;
        }

        await deps.charmManager.unpin(charm);
        deps.setOpen(false);
      },
    },
    {
      id: "view-detail",
      type: "action",
      title: "View Detail",
      group: "View",
      predicate: !!deps.focusedCharmId,
      handler: () => {
        if (!deps.focusedCharmId || !deps.focusedReplicaId) {
          deps.setOpen(false);
          return;
        }
        deps.navigate(
          createPath("charmDetail", {
            charmId: deps.focusedCharmId,
            replicaName: deps.focusedReplicaId,
          }),
        );
        deps.setOpen(false);
      },
    },
    {
      id: "edit-code",
      type: "action",
      title: "Edit Code",
      group: "View",
      predicate: !!deps.focusedCharmId,
      handler: () => {
        if (!deps.focusedCharmId || !deps.focusedReplicaId) {
          deps.setOpen(false);
          return;
        }
        deps.navigate(
          createPathWithHash(
            "charmDetail",
            {
              charmId: deps.focusedCharmId,
              replicaName: deps.focusedReplicaId,
            },
            "code",
          ),
        );
        deps.setOpen(false);
      },
    },
    {
      id: "view-data",
      type: "action",
      title: "View Backing Data",
      group: "View",
      predicate: !!deps.focusedCharmId,
      handler: () => {
        if (!deps.focusedCharmId || !deps.focusedReplicaId) {
          deps.setOpen(false);
          return;
        }
        deps.navigate(
          createPathWithHash(
            "charmDetail",
            {
              charmId: deps.focusedCharmId,
              replicaName: deps.focusedReplicaId,
            },
            "data",
          ),
        );
        deps.setOpen(false);
      },
    },
    {
      id: "view-charm",
      type: "action",
      title: "View Charm",
      group: "View",
      predicate: !!deps.focusedCharmId,
      handler: () => {
        if (!deps.focusedCharmId || !deps.focusedReplicaId) {
          console.warn("Missing charm ID or replica name");
          deps.setOpen(false);
          return;
        }
        navigateToCharm(deps, deps.focusedCharmId);
        deps.setOpen(false);
      },
    },
    {
      id: "back",
      type: "action",
      title: "Navigate Back",
      group: "Navigation",
      handler: () => {
        globalThis.history.back();
        deps.setOpen(false);
      },
    },
    {
      id: "home",
      type: "action",
      title: "Navigate Home",
      group: "Navigation",
      predicate: !!deps.focusedReplicaId,
      handler: () => {
        if (deps.focusedReplicaId) {
          deps.navigate(
            createPath("replicaRoot", { replicaName: deps.focusedReplicaId }),
          );
        }
        deps.setOpen(false);
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
            deps.setOpen(false);
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
            deps.setOpen(false);
            // Refresh the page to ensure the setting takes effect
            globalThis.location.reload();
          },
        },
        {
          id: "open-fs-network-inspector",
          type: "action",
          title: "Open Network Inspector (new tab)",
          handler: () => {
            const url = new URL(globalThis.location.origin);
            url.pathname = "/inspector";
            globalThis.open(url.href, "_blank");
          },
        },
        {
          id: "start-counter-job",
          type: "action",
          title: "Start Counter Job",
          handler: () => handleStartCounterJob(deps),
        },
        {
          id: "index-charms",
          type: "action",
          title: "Index Charms",
          handler: () => handleIndexCharms(deps),
        },
        {
          id: "import-json",
          type: "action",
          title: "Import JSON",
          handler: () => handleImportJSON(deps),
        },
        {
          id: "load-recipe",
          type: "action",
          title: "Load Recipe",
          handler: () => handleLoadRecipe(deps),
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
            deps.setOpen(false);
          },
        },
        {
          id: "add-gmail-importer",
          type: "action",
          title: "Add Gmail Importer",
          handler: () =>
            handleAddRemoteRecipe(deps, "gmail.tsx", "GMail Importer"),
        },
        {
          id: "add-gcal-importer",
          type: "action",
          title: "Add GCal Importer",
          handler: () =>
            handleAddRemoteRecipe(deps, "gcal.tsx", "GCal Importer"),
        },
        {
          id: "add-rss-importer",
          type: "action",
          title: "Add RSS Importer",
          handler: () => handleAddRemoteRecipe(deps, "rss.tsx", "RSS Importer"),
        },
      ],
    },
    {
      id: "background-jobs",
      type: "menu",
      title: `Background Jobs (${deps.listJobs().length})`,
      group: "Other",
      children: [
        ...deps.listJobs().map(
          (job): CommandItem => ({
            id: `job-${job.id}`,
            type: "menu",
            title: `${job.name} (${job.status})`,
            children: [
              {
                id: `job-${job.id}-toggle`,
                type: "action",
                title: job.status === "running" ? "Pause" : "Resume",
                handler: () => {
                  if (job.status === "running") {
                    deps.stopJob(job.id);
                  } else {
                    // deps.resumeJob(job.id);
                  }
                  deps.setMode({ type: "main" });
                },
              },
              {
                id: `job-${job.id}-cancel`,
                type: "action",
                title: "Stop",
                handler: () => {
                  deps.stopJob(job.id);
                  deps.setMode({ type: "main" });
                },
              },
              {
                id: `job-${job.id}-messages`,
                type: "menu",
                title: "View Messages",
                children: job.messages.map(
                  (msg, i): CommandItem => ({
                    id: `msg-${job.id}-${i}`,
                    type: "action",
                    title: msg,
                    handler: () => {},
                  }),
                ),
              },
            ],
          }),
        ),
        {
          id: "clear-completed-jobs",
          type: "action",
          title: "Clear Completed Jobs",
          handler: () => {
            // deps.clearCompletedJobs();
            deps.setMode({ type: "main" });
          },
        },
      ],
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
