import "./commands.css";
import { castNewRecipe, Charm, CharmManager, compileAndRunRecipe } from "@commontools/charm";
import { NavigateFunction } from "react-router-dom";
import { castSpell } from "@/search";
import { charmId } from "@/utils/charms";
import { NAME } from "@commontools/builder";
import { DocImpl, getRecipe } from "@commontools/runner";
import { performIteration } from "@/utils/charm-iteration";
import { BackgroundJob } from "@/contexts/BackgroundTaskContext";
import { startCharmIndexing } from "@/utils/indexing";
import { generateJSON } from "@/utils/prompt-library/json-gen";

export type CommandType = "action" | "input" | "confirm" | "select" | "menu" | "transcribe";

export interface CommandItem {
  id: string;
  type: CommandType;
  title: string; // No longer needs to be a function
  placeholder?: string;
  group?: string;
  children?: CommandItem[]; // No longer needs to be a function
  handler?: (value?: any) => Promise<void> | void; // No context param needed
  validate?: (input: string) => boolean;
  message?: string;
  predicate?: boolean; // Can be computed value instead of function
}

export function getTitle(
  title: string | ((context: CommandContext) => string),
  context: CommandContext,
): string {
  return typeof title === "function" ? title(context) : title;
}

export function getChildren(
  children: CommandItem[] | ((context: CommandContext) => CommandItem[]) | undefined,
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
  preferredModel?: string;
  setPreferredModel: (model: string) => void;
  setLoading: (loading: boolean) => void;
  setModeWithInput: (mode: CommandMode, initialInput: string) => void;
  listJobs: () => BackgroundJob[];
  startJob: (name: string) => string;
  stopJob: (jobId: string) => void;
  addJobMessage: (jobId: string, message: string) => void;
  updateJobProgress: (jobId: string, progress: number) => void;
  commandPathIds: string[];
}

export type CommandMode =
  | { type: "main" }
  | { type: "menu"; path: string[]; parent: CommandItem }
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

// Command handlers
async function handleNewCharm(deps: CommandContext, input: string | undefined) {
  if (!input) return;
  deps.setLoading(true);
  try {
    // Generate JSON blob with an LLM
    const dummyData = await generateJSON(input);
    const id = await castNewRecipe(deps.charmManager, dummyData, input);
    if (id) {
      deps.navigate(`/${deps.focusedReplicaId}/${charmId(id)}`);
    }
  } finally {
    deps.setLoading(false);
    deps.setOpen(false);
  }
}

async function handleSearchCharms(deps: CommandContext) {
  deps.setLoading(true);
  try {
    const charms = deps.charmManager.getCharms().get();
    const results = await Promise.all(
      charms.map(async (charm) => {
        const data = charm.cell.get();
        const title = data?.[NAME] ?? "Untitled";
        return {
          title: title + ` (#${charmId(charm.cell.entityId!).slice(-4)})`,
          id: charmId(charm.cell.entityId!),
          value: charm.cell.entityId,
        };
      }),
    );
    deps.setMode({
      type: "select",
      command: {
        id: "charm-select",
        type: "select",
        title: "Select Charm",
        handler: async (id) => {
          console.log("Select handler called with:", id);
          console.log("Navigating to:", `/${deps.focusedReplicaId}/${charmId(id)}`);
          deps.navigate(`/${deps.focusedReplicaId}/${charmId(id)}`);
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

async function handleSpellcaster(deps: CommandContext, input: string | undefined) {
  if (!input || !deps.focusedReplicaId) return;
  deps.setLoading(true);
  try {
    const spells = await castSpell(deps.focusedReplicaId, input);
    const compatibleSpells = spells.filter(
      (spell) => spell.compatibleBlobs && spell.compatibleBlobs.length > 0,
    );

    deps.setMode({
      type: "select",
      command: {
        id: "spell-select",
        type: "select",
        title: "Select Spell",
        handler: async (spell: any) => {
          if (spell.compatibleBlobs.length === 1) {
            const entityId = await castSpellAsCharm(
              deps.charmManager,
              spell,
              spell.compatibleBlobs[0],
            );
            if (entityId) {
              deps.navigate(`/${deps.focusedReplicaId}/${charmId(entityId)}`);
            }
            deps.setOpen(false);
          } else {
            deps.setMode({
              type: "select",
              command: {
                id: "blob-select",
                type: "select",
                title: "Select Blob",
                handler: async (blob) => {
                  const entityId = await castSpellAsCharm(deps.charmManager, spell, blob);
                  if (entityId) {
                    deps.navigate(`/${deps.focusedReplicaId}/${charmId(entityId)}`);
                  }
                  deps.setOpen(false);
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
    deps.setLoading(false);
  }
}

async function handleEditRecipe(deps: CommandContext, input: string | undefined) {
  if (!input || !deps.focusedCharmId || !deps.focusedReplicaId) return;
  deps.setLoading(true);
  const newCharmPath = await performIteration(
    deps.charmManager,
    deps.focusedCharmId,
    deps.focusedReplicaId,
    input,
    false,
    deps.preferredModel,
  );
  if (newCharmPath) {
    deps.navigate(newCharmPath);
  }
  deps.setLoading(false);
  deps.setOpen(false);
}

async function handleDeleteCharm(deps: CommandContext) {
  if (!deps.focusedCharmId) return;
  const charm = await deps.charmManager.get(deps.focusedCharmId);
  if (!charm?.entityId) return;
  const result = await deps.charmManager.remove(charm.entityId);
  if (result) {
    deps.navigate("/");
  }
  deps.setOpen(false);
}

async function handleStartCounterJob(deps: CommandContext) {
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

    const currentCount = parseInt(job.messages[job.messages.length - 1]?.split(": ")[1] || "0");
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

    const id = await castNewRecipe(deps.charmManager, data, title);
    if (id) {
      deps.navigate(`/${deps.focusedReplicaId}/${charmId(id)}`);
    }
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
    const id = await compileAndRunRecipe(deps.charmManager, src, "imported", {});
    if (id) {
      deps.navigate(`/${deps.focusedReplicaId}/${charmId(id)}`);
    }
  } finally {
    deps.setLoading(false);
    deps.setOpen(false);
  }
}

async function handleSelectModel(deps: CommandContext) {
  deps.setLoading(true);
  try {
    const response = await fetch("/api/ai/llm/models");
    const models = await response.json();

    const modelOptions = Object.entries(models).map(([key, model]: [string, any]) => ({
      id: key,
      title: `${key} (${model.capabilities.contextWindow.toLocaleString()} tokens)`,
      value: {
        id: key,
        ...model,
      },
    }));

    deps.setMode({
      type: "select",
      command: {
        id: "model-select",
        type: "select",
        title: "Select Model",
        handler: async (selectedModel) => {
          deps.setPreferredModel(selectedModel.id);
          deps.setOpen(false);
        },
      },
      options: modelOptions,
    });
  } catch (error) {
    console.error("Failed to fetch models:", error);
  } finally {
    deps.setLoading(false);
  }
}

async function handleIndexCharms(deps: CommandContext) {
  startCharmIndexing(deps.charmManager, {
    startJob: deps.startJob,
    stopJob: deps.stopJob,
    addJobMessage: deps.addJobMessage,
    updateJobProgress: deps.updateJobProgress,
    listJobs: deps.listJobs,
  });
  deps.setOpen(false);
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
      id: "spellcaster",
      type: "input",
      title: "Spellcaster",
      group: "Create",
      predicate: !!deps.focusedReplicaId,
      handler: (input) => handleSpellcaster(deps, input),
    },
    {
      id: "edit-recipe",
      type: "input",
      title: `Iterate${deps.preferredModel ? ` (${deps.preferredModel})` : ""}`,
      group: "Edit",
      predicate: !!deps.focusedCharmId,
      placeholder: "What would you like to change?",
      handler: (input) => handleEditRecipe(deps, input),
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
      id: "view-detail",
      type: "action",
      title: "View Detail",
      group: "View",
      predicate: !!deps.focusedCharmId,
      handler: () => {
        if (!deps.focusedCharmId) {
          deps.setOpen(false);
          return;
        }
        deps.navigate(`/${deps.focusedReplicaId}/${deps.focusedCharmId}/detail`);
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
        if (!deps.focusedCharmId) {
          deps.setOpen(false);
          return;
        }
        deps.navigate(`/${deps.focusedReplicaId}/${deps.focusedCharmId}/detail#code`);
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
        if (!deps.focusedCharmId) {
          deps.setOpen(false);
          return;
        }
        deps.navigate(`/${deps.focusedReplicaId}/${deps.focusedCharmId}/detail#data`);
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
        if (!deps.focusedCharmId) {
          deps.setOpen(false);
          return;
        }
        deps.navigate(`/${deps.focusedReplicaId}/${deps.focusedCharmId}`);
        deps.setOpen(false);
      },
    },
    {
      id: "back",
      type: "action",
      title: "Navigate Back",
      group: "Navigation",
      handler: () => {
        window.history.back();
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
          deps.navigate(`/${deps.focusedReplicaId}`);
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
          title: "Switch Replica",
          placeholder: "Enter replica name",
          handler: (input) => {
            if (input) {
              window.location.href = `/${input}`;
            }
            deps.setOpen(false);
          },
        },
      ],
    },
    {
      id: "select-model",
      type: "action",
      title: "Select AI Model",
      group: "Settings",
      handler: () => handleSelectModel(deps),
    },
    {
      id: "edit-recipe-voice",
      type: "transcribe",
      title: `Iterate (Voice)${deps.preferredModel ? ` (${deps.preferredModel})` : ""}`,
      group: "Edit",
      predicate: !!deps.focusedCharmId,
      handler: async (transcription) => {
        if (!transcription) return;

        const commands = getCommands(deps);
        const editRecipeCommand = commands.find((cmd) => cmd.id === "edit-recipe")!;

        deps.setModeWithInput(
          {
            type: "input",
            command: editRecipeCommand,
            placeholder: "What would you like to change?",
            preserveInput: true,
          },
          transcription,
        );
      },
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
                handler: async () => {
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
                handler: async () => {
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
          handler: async () => {
            // deps.clearCompletedJobs();
            deps.setMode({ type: "main" });
          },
        },
      ],
    },
  ];
}
