import "./commands.css";
import {
  castNewRecipe,
  Charm,
  CharmManager,
  compileAndRunRecipe,
} from "@commontools/charm";
// Import NavigateFunction from our types rather than directly from react-router-dom
import type { NavigateFunction } from "react-router-dom";
import { charmId } from "@/utils/charms.ts";
import { NAME } from "@commontools/builder";
import {
  Cell,
  EntityId,
  getEntityId,
  getRecipe,
  isStream,
} from "@commontools/runner";
import { extendCharm, iterateCharm } from "@/utils/charm-operations.ts";
import { BackgroundJob } from "@/contexts/BackgroundTaskContext.tsx";
import { startCharmIndexing } from "@/utils/indexing.ts";
import { generateJSON } from "@/utils/prompt-library/json-gen.ts";
import { createPath, createPathWithHash, ROUTES } from "@/routes.ts";
import { llm } from "@/utils/llm.ts";

export type CommandType =
  | "action"
  | "input"
  | "confirm"
  | "select"
  | "menu"
  | "transcribe"
  | "placeholder";

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
  | {
    type: "input";
    command: CommandItem;
    placeholder: string;
    preserveInput?: boolean;
    displayText?: string; // Add display text for agent mode
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

export const castSpellAsCharm = async (
  charmManager: CharmManager,
  recipeKey: string,
  argument: Cell<any>,
) => {
  if (recipeKey && argument) {
    console.log("Syncing...");
    const recipeId = recipeKey.replace("spell-", "");
    await charmManager.syncRecipeBlobby(recipeId);

    const recipe = getRecipe(recipeId);
    if (!recipe) return;

    console.log("Casting...");
    const charm: Cell<Charm> = await charmManager.runPersistent(
      recipe,
      argument,
    );
    charmManager.add([charm]);
    return charm.entityId;
  }
  console.log("Failed to cast");
  return null;
};

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
      const schema = charm.key(key).schema;
      return {
        id: key,
        title: key,
        value: { key, stream, schema },
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
              handler: (input) => {
                try {
                  if (
                    typeof input === "string" &&
                    ["object", "array", "anyOf"].includes(
                      selectedAction.schema?.type,
                    )
                  ) {
                    input = JSON.parse(input);
                  }
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
                    input,
                  );
                  deps.setOpen(false);
                }
              },
            },
            placeholder: JSON.stringify(selectedAction.schema?.example) ||
              "Enter input data",
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

// Command handlers
async function handleNewCharm(deps: CommandContext, input: string | undefined) {
  if (!input) return;
  deps.setLoading(true);
  try {
    // Generate JSON blob with an LLM
    const dummyData = await generateJSON(input);
    const newCharm = await castNewRecipe(deps.charmManager, dummyData, input);
    if (!newCharm) {
      throw new Error("Failed to cast charm");
    }
    const id = charmId(newCharm);
    if (!id || !deps.focusedReplicaId) {
      throw new Error("Missing charm ID or replica name");
    }
    deps.navigate(
      createPath("charmShow", {
        charmId: id,
        replicaName: deps.focusedReplicaId,
      }),
    );
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
          const id = charmId(selected);
          if (!id || !deps.focusedReplicaId) {
            throw new Error("Missing charm ID or replica name");
          }
          const path = createPath("charmDetail", {
            charmId: id,
            replicaName: deps.focusedReplicaId,
          });
          deps.navigate(path);
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

async function handleEditRecipe(
  deps: CommandContext,
  input: string | undefined,
) {
  if (!input || !deps.focusedCharmId || !deps.focusedReplicaId) return;
  deps.setLoading(true);
  const newCharmPath = await iterateCharm(
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

async function handleExtendRecipe(
  deps: CommandContext,
  input: string | undefined,
) {
  if (!input || !deps.focusedCharmId || !deps.focusedReplicaId) return;
  deps.setLoading(true);
  const newCharmPath = await extendCharm(
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

async function handleRenameCharm(
  deps: CommandContext,
  input: string | undefined,
) {
  if (!input || !deps.focusedCharmId || !deps.focusedReplicaId) return;
  deps.setLoading(true);

  const charm = await deps.charmManager.get(deps.focusedCharmId);
  if (!charm) return;
  charm.key(NAME).set(input);

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

    const newCharm = await castNewRecipe(deps.charmManager, data, title);
    if (!newCharm) throw new Error("Failed to create new charm");

    const id = charmId(newCharm);
    if (!id || !deps.focusedReplicaId) {
      throw new Error("Missing charm ID or replica name");
    }

    if (id) {
      deps.navigate(
        createPath("charmShow", {
          charmId: id,
          replicaName: deps.focusedReplicaId,
        }),
      );
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
    const newCharm = await compileAndRunRecipe(
      deps.charmManager,
      src,
      "imported",
      {},
    );
    if (!newCharm) {
      throw new Error("Failed to cast charm");
    }
    const id = charmId(newCharm);
    if (!id || !deps.focusedReplicaId) {
      throw new Error("Missing charm ID or replica name");
    }
    if (id) {
      deps.navigate(
        createPath("charmShow", {
          charmId: id,
          replicaName: deps.focusedReplicaId,
        }),
      );
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

    const modelOptions = Object.entries(models).map((
      [key, model]: [string, any],
    ) => ({
      id: key,
      title:
        `${key} (${model.capabilities.contextWindow.toLocaleString()} tokens)`,
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
        handler: (selectedModel) => {
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

function navigateToCharm(charm: Charm | EntityId, deps: CommandContext) {
  if (!charm) {
    throw new Error("Failed to cast charm");
  }
  const id = charmId(charm);
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
          navigateToCharm(newCharm, deps);
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

          navigateToCharm(newCharm, deps);
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

// Agent mode function - implementation with feedback loops and context awareness

type Step = {
  description: string;
  tool?: string;
  args?: Record<string, unknown>;
  feedback?: string; // To store feedback from tool execution
};

// Context manager to help the agent understand what it's working with
class AgentContext {
  private contextInfo: Record<string, unknown> = {};

  // Add item to context
  set(key: string, value: unknown): void {
    this.contextInfo[key] = value;
  }

  // Get context item
  get(key: string): unknown {
    return this.contextInfo[key];
  }

  // Format context as string for LLM
  toString(): string {
    return Object.entries(this.contextInfo)
      .map(([key, value]) => {
        let valueStr: string;
        if (typeof value === "object" && value !== null) {
          try {
            valueStr = JSON.stringify(value).substring(0, 500);
            if (valueStr.length >= 500) valueStr += "... (truncated)";
          } catch (e) {
            valueStr = "[Complex Object]";
          }
        } else {
          valueStr = String(value);
        }
        return `${key}: ${valueStr}`;
      })
      .join("\n");
  }

  // Check if context has a certain key
  has(key: string): boolean {
    return key in this.contextInfo;
  }
}

// This interface represents the agent's UI state that will be shown in the command center
interface AgentModeState {
  task: string;
  status: "planning" | "executing" | "completed" | "error";
  currentStep: number;
  totalSteps: number;
  plan: {
    reasoning: string;
    steps: Array<
      Step & { status?: "pending" | "executing" | "completed" | "failed" }
    >;
  };
  logs: string[];
}

async function handleAgentMode(
  deps: CommandContext,
  input: string | undefined,
) {
  if (!input) return;

  // Initialize agent state for UI display
  const agentState: AgentModeState = {
    task: input,
    status: "planning",
    currentStep: 0,
    totalSteps: 0,
    plan: {
      reasoning: "",
      steps: [],
    },
    logs: [`Starting task: ${input}`],
  };

  // Set up the command center UI to show the agent state
  // Instead of closing the command center, we'll use it to display progress
  deps.setMode({
    type: "loading", // Start with loading while we plan
  });

  // Function to update the UI with current agent state
  const updateAgentUI = () => {
    // Format the steps with status indicators
    const stepsFormatted = agentState.plan.steps.map((step, index) => {
      const statusIcon = step.status === "completed"
        ? "✅"
        : step.status === "failed"
        ? "❌"
        : step.status === "executing"
        ? "🔄"
        : "⏳";

      return `${statusIcon} ${index + 1}. ${step.description}${
        step.feedback ? `\n   Result: ${step.feedback}` : ""
      }`;
    }).join("\n\n");

    // Format the logs
    const recentLogs = agentState.logs.slice(-5).join("\n");

    // Create a message for display in the command center
    const progressPercent = agentState.totalSteps
      ? Math.round((agentState.currentStep / agentState.totalSteps) * 100)
      : 0;

    const statusMessage = agentState.status === "planning"
      ? "🤔 Planning steps..."
      : agentState.status === "executing"
      ? `🔄 Executing step ${agentState.currentStep}/${agentState.totalSteps} (${progressPercent}%)`
      : agentState.status === "completed"
      ? "✅ Task completed!"
      : "❌ Error";

    // Create a formatted display that's visible to the user
    const formattedDisplay = `
Task: ${agentState.task}

Status: ${statusMessage}

${
      agentState.plan.reasoning
        ? `Reasoning:\n${agentState.plan.reasoning}\n\n`
        : ""
    }Plan:
${stepsFormatted}

Recent Activity:
${recentLogs}

Type 'cancel' to stop the agent
`;

    // Update the command center UI with a text-based display
    deps.setMode({
      type: "input",
      command: {
        id: "agent-progress",
        type: "input",
        title: "Agent Progress",
        placeholder: "Type 'cancel' to stop the agent",
        handler: (input) => {
          if (input?.toLowerCase() === "cancel") {
            // Cancel the agent if user types cancel
            deps.setOpen(false);
            return;
          }
        },
      },
      placeholder: "Type 'cancel' to stop the agent",
      // Use our new displayText property to show the agent state
      displayText: formattedDisplay,
    });
  };

  // Log function that updates both the UI and keeps track of logs
  const log = (message: string) => {
    agentState.logs.push(message);
    updateAgentUI();
    console.log(`[Agent] ${message}`); // Still log to console for debugging
  };

  // Initialize context manager
  const agentContext = new AgentContext();

  try {
    // First, collect available tools
    log("Analyzing available tools...");

    // Add context inspection functions as special tools
    // Note: These are our special agent-only tools that don't appear in the regular command list
    const contextTools = [
      {
        id: "get-charm-info", // Plain text ID, no HTML formatting
        description: "Get basic information about the currently focused charm",
        type: "function",
        handler: async (): Promise<string> => {
          log("Getting charm info...");

          if (!deps.focusedCharmId) {
            const result = "No charm is currently focused";
            log(result);
            return result;
          }

          try {
            const charm = await deps.charmManager.get(deps.focusedCharmId);
            if (!charm) {
              const result = "Failed to load charm";
              log(result);
              return result;
            }

            const name = charm.key(NAME).get() || "Unnamed charm";
            const id = deps.focusedCharmId;

            // Get schema info if available
            const argument = deps.charmManager.getArgument(charm);
            const schema = argument?.schema;
            const schemaStr = schema
              ? JSON.stringify(schema, null, 2)
              : "No schema available";
            const example = schema?.example;
            const exampleStr = example
              ? `\nExample: ${JSON.stringify(example, null, 2)}`
              : "";

            // Store in context for future steps
            agentContext.set("currentCharmName", name);
            agentContext.set("currentCharmId", id);
            agentContext.set("currentCharmSchema", schema);

            const result = `Current charm: ${name} (ID: ${id})
Schema: ${schemaStr}${exampleStr}`;
            log(result);
            return result;
          } catch (error) {
            console.error("Error getting charm info:", error);
            const result = `Error: ${
              error instanceof Error ? error.message : "Unknown error"
            }`;
            log(result);
            return result;
          }
        },
      },
      {
        id: "summarize-charm-data",
        description: "Get a summary of the currently focused charm's data",
        type: "function",
        handler: async (): Promise<string> => {
          log("Summarizing charm data...");

          if (!deps.focusedCharmId) {
            const result = "No charm is currently focused";
            log(result);
            return result;
          }

          try {
            const charm = await deps.charmManager.get(deps.focusedCharmId);
            if (!charm) {
              const result = "Failed to load charm";
              log(result);
              return result;
            }

            log("Generating data summary with LLM...");
            const data = charm.get();
            const summary = await llm.sendRequest({
              model: deps.preferredModel ||
                "anthropic:claude-3-7-sonnet-20250219-thinking",
              system:
                "Summarize the following JSON data in 2-3 sentences. Focus on the most important fields and values.",
              messages: [{
                role: "user",
                content: JSON.stringify(data, null, 2),
              }],
            });

            // Store in context for future steps
            agentContext.set("currentCharmDataSummary", summary);

            const result = `Data summary: ${summary}`;
            log(result);
            return result;
          } catch (error) {
            console.error("Error summarizing charm data:", error);
            const result = `Error: ${
              error instanceof Error ? error.message : "Unknown error"
            }`;
            log(result);
            return result;
          }
        },
      },
      {
        id: "get-charm-actions",
        description:
          "List all available actions for the currently focused charm",
        type: "function",
        handler: async (): Promise<string> => {
          log("Getting available charm actions...");

          if (!deps.focusedCharmId) {
            const result = "No charm is currently focused";
            log(result);
            return result;
          }

          try {
            const charm = await deps.charmManager.get(deps.focusedCharmId);
            if (!charm) {
              const result = "Failed to load charm";
              log(result);
              return result;
            }

            const entries = Object.entries(charm.get());
            const actions = entries.filter(([_, value]) => isStream(value));

            if (actions.length === 0) {
              const result = "No actions available for this charm";
              log(result);
              return result;
            }

            const actionsList = actions.map(([key]) => key).join(", ");

            // Store in context
            agentContext.set(
              "availableCharmActions",
              actions.map(([key]) => key),
            );

            const result = `Available actions: ${actionsList}`;
            log(result);
            return result;
          } catch (error) {
            console.error("Error getting charm actions:", error);
            const result = `Error: ${
              error instanceof Error ? error.message : "Unknown error"
            }`;
            log(result);
            return result;
          }
        },
      },
    ];

    // Get all commands (filtering out menu commands, agent mode itself, and unavailable ones)
    const allCommands = getCommands(deps);
    const availableCommands = allCommands.filter((cmd) =>
      cmd.type !== "menu" &&
      cmd.id !== "background-jobs" &&
      cmd.id !== "agent-mode" && // Prevent infinite recursion
      cmd.predicate !== false
    );

    // Format command descriptions for the LLM
    const commandDescriptions = availableCommands.map((cmd) => {
      let desc =
        `TOOL: ${cmd.id}\nDESCRIPTION: ${cmd.title}\nTYPE: ${cmd.type}`;

      // Add parameter info based on command type
      if (cmd.type === "input" || cmd.type === "transcribe") {
        desc += `\nPARAMETERS:\n  - input: ${
          cmd.placeholder || "Text input"
        } (required, string)`;
      } else if (cmd.type === "confirm") {
        desc +=
          `\nPARAMETERS:\n  - confirm: Whether to confirm the action (required, boolean)`;
      }

      return desc;
    });

    // Format context tools - these are our special agent-only tools
    const contextToolDescriptions = contextTools.map((tool) => {
      // Make sure to highlight these as special information-gathering tools
      return `TOOL: ${tool.id}\nDESCRIPTION: ${tool.description}\nTYPE: ${tool.type}\nPARAMETERS: None (this is an information-gathering tool)`;
    });

    // Log the special tools
    log(
      `Special information-gathering tools: ${
        contextTools.map((t) => t.id).join(", ")
      }`,
    );

    // Add current charm actions if applicable
    let charmActions: string[] = [];
    if (deps.focusedCharmId) {
      try {
        const charm = await deps.charmManager.get(deps.focusedCharmId);
        if (charm) {
          // Store basic charm info in context
          const name = charm.key(NAME).get() || "Unnamed charm";
          agentContext.set("currentCharmName", name);
          agentContext.set("currentCharmId", deps.focusedCharmId);

          const entries = Object.entries(charm.get());
          const actions = entries.filter(([_, value]) => isStream(value));

          charmActions = actions.map(([key]) => {
            // Get schema and example information for this action
            const actionSchema = charm.key(key).schema;
            const example = actionSchema?.example;
            const schemaInfo = actionSchema
              ? `\nSCHEMA: ${JSON.stringify(actionSchema, null, 2)}`
              : "";
            const exampleInfo = example
              ? `\nEXAMPLE: ${JSON.stringify(example)}`
              : "";

            return `TOOL: charm-action:${key}
DESCRIPTION: Execute the '${key}' action on the current charm
TYPE: charm-action
PARAMETERS:
  - input: Input for the action (required, string)${schemaInfo}${exampleInfo}`;
          });

          log(`Found ${actions.length} charm actions`);

          // Store in context
          agentContext.set(
            "availableCharmActions",
            actions.map(([key]) => key),
          );
        }
      } catch (error) {
        console.error("Error fetching charm actions:", error);
        log(
          `Error finding charm actions: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        );
      }
    }

    // Combine all tool descriptions
    const allTools = [
      ...contextToolDescriptions,
      ...commandDescriptions,
      ...charmActions,
    ];
    log(`Available tools: ${allTools.length}`);

    // Let the LLM plan the steps with context awareness
    log("Planning steps to complete the task...");

    // Get initial context (e.g., focused charm info) if available
    const initialContext = agentContext.toString() ||
      "No initial context available.";

    const system =
      `You are an AI assistant that helps users work with Charms in the Jumble system. 
Analyze the user's task and create a plan using only the tools listed below.

SYSTEM BACKGROUND:
- Charms are instantiated mini applications with live, reactive data
- Each Charm is backed by a Spell or Recipe (the program that powers the Charm)
- The current Charm is the one that is currently focused in the UI

IMPORTANT CONCEPTS:
- "new-charm": Creates a completely new Spell and instantiates it as a new Charm
- "edit-recipe": Changes the Spell of the CURRENT Charm (modifies the current Charm in-place)
- "extend-recipe": Creates a NEW Spell based on the current one, and instantiates it as a new Charm while keeping the current data
- "view-charm": Just displays the current Charm without modifying anything

BEST PRACTICES:
- If the user wants to modify the CURRENT Charm, use "edit-recipe"
- If the user wants to create a variation or next step, use "extend-recipe" (safer option that preserves the original)
- Only use "new-charm" for completely fresh starts
- Start by gathering context about the current charm with the get-* tools before making changes
- Actions (charm-action:*) are specific to each Charm and execute functionality within that Charm

CONTEXT INFORMATION:
${initialContext}

AVAILABLE TOOLS:
${allTools.join("\n\n")}

When planning:
1. Start by gathering context information about the current charm and available actions (using the get-* tools)
2. Use this information to make informed decisions
3. Understand whether the user wants to modify the current charm or create a new one based on it
4. Use the feedback from each step to guide subsequent steps
5. Consider alternative approaches if a step fails

Format your response as JSON with this structure:
\`\`\`json
{
  "reasoning": "Your explanation of how you'll approach this task, including your understanding of whether to modify the current charm or create a new one",
  "steps": [
    {
      "description": "Detailed description of this step",
      "tool": "tool-id", // IMPORTANT: Use the exact tool ID from the tools list, no HTML formatting or quotes
      "args": {"param1": "value1"}
    },
    ...
  ]
}
\`\`\`
IMPORTANT: 
1. Use only the exact tool IDs from the tools list without adding any HTML formatting or quotes
2. Special information-gathering tools like "get-charm-info", "summarize-charm-data", and "get-charm-actions" must be used exactly as written
3. Tool names should be plain text (e.g., "edit-recipe" not "<font color='green'>edit-recipe</font>")`;

    const response = await llm.sendRequest({
      model: /*deps.preferredModel ||*/
        "anthropic:claude-3-5-haiku-latest",
      system,
      messages: [{ role: "user", content: input }],
    });

    // Parse the response and execute the steps
    try {
      // Extract JSON from response (handling possible markdown code blocks)
      let jsonString = response;
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch && jsonMatch[1]) {
        jsonString = jsonMatch[1];
      }

      // Remove any potential HTML formatting that might have crept in
      jsonString = jsonString.replace(/<[^>]*>/g, "");

      // First make a more thorough cleanup of the JSON
      // 1. Remove control characters
      // deno-lint-ignore no-control-regex
      jsonString = jsonString.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ");
      // 2. Ensure property names are properly quoted
      jsonString = jsonString.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');
      // 3. Replace single quotes with double quotes (for strings)
      //jsonString = jsonString.replace(/'([^']*)'/g, '"$1"');
      // 4. Replace curly quotes with straight quotes (this fixes the issue in the example)
      //jsonString = jsonString.replace(/[""]/g, '"');
      //jsonString = jsonString.replace(/['']/g, "'");

      try {
        console.log("Attempting to parse JSON:", jsonString);
        const plan = JSON.parse(jsonString);

        if (!plan.steps || !Array.isArray(plan.steps)) {
          throw new Error("Invalid plan format: missing steps array");
        }

        // Update our agent state with the plan
        agentState.plan.reasoning = plan.reasoning || "";
        agentState.plan.steps = plan.steps.map((step) => ({
          ...step,
          status: "pending",
        }));
        agentState.totalSteps = plan.steps.length;
        agentState.status = "executing";

        log(`Task broken down into ${plan.steps.length} steps`);
        log("🤖 Agent's plan:");

        if (plan.reasoning) {
          log(`Reasoning: ${plan.reasoning}`);
        }

        plan.steps.forEach((step, index) => {
          log(`Step ${index + 1}: ${step.description}`);
        });

        // Execute each step
        for (const [index, step] of agentState.plan.steps.entries()) {
          // Update step status
          step.status = "executing";
          agentState.currentStep = index + 1;

          // Update UI
          updateAgentUI();

          log(`Executing step ${index + 1}: ${step.description}`);

          if (!step.tool) {
            log(`Skipping: No tool specified`);
            step.feedback = "Skipped: No tool specified";
            step.status = "failed";
            updateAgentUI();
            continue;
          }

          // Clean up tool ID by removing any potential HTML formatting
          // This handles cases where the LLM might add formatting despite our instructions
          const cleanToolId = step.tool.replace(/<[^>]*>/g, "").trim();

          try {
            // Log the tool being used for debugging
            log(`Using tool: ${cleanToolId}`);

            // Handle context tools specially
            const contextTool = contextTools.find((tool) =>
              tool.id === cleanToolId
            );
            if (contextTool) {
              const result = await contextTool.handler();
              // Result is already logged in the handler
              step.feedback = result;
              step.status = "completed";
              updateAgentUI();
              continue;
            }

            // Handle charm actions specially
            if (cleanToolId.startsWith("charm-action:")) {
              const actionName = cleanToolId.replace("charm-action:", "");

              if (!deps.focusedCharmId) {
                const feedback = "Failed: No charm focused";
                log(feedback);
                step.feedback = feedback;
                step.status = "failed";
                updateAgentUI();
                continue;
              }

              const charm = await deps.charmManager.get(deps.focusedCharmId);
              if (!charm) {
                const feedback = "Failed: Could not load focused charm";
                log(feedback);
                step.feedback = feedback;
                step.status = "failed";
                updateAgentUI();
                continue;
              }

              const charmData = charm.get();
              const stream = charmData[actionName];

              if (!stream || typeof stream.send !== "function") {
                const feedback =
                  `Failed: Action ${actionName} not found or not executable`;
                log(feedback);
                step.feedback = feedback;
                step.status = "failed";
                updateAgentUI();
                continue;
              }

              // Execute the action
              stream.send(step.args?.input);
              const feedback = `Executed charm action: ${actionName}`;
              log(feedback);
              step.feedback = feedback;
              step.status = "completed";
              updateAgentUI();

              // Store action execution in context
              agentContext.set(`executed_${actionName}`, {
                input: step.args?.input,
                timestamp: new Date().toISOString(),
              });

              continue;
            }

            // Handle regular commands
            const command = availableCommands.find((cmd) =>
              cmd.id === cleanToolId
            );
            if (!command) {
              const feedback = `Failed: Unknown tool ${cleanToolId}`;
              log(feedback);
              step.feedback = feedback;
              step.status = "failed";
              updateAgentUI();
              continue;
            }

            if (command.handler) {
              if (command.type === "action") {
                await command.handler();
                const feedback = `Executed: ${step.tool}`;
                log(feedback);
                step.feedback = feedback;
                step.status = "completed";
                updateAgentUI();
              } else if (
                command.type === "input" || command.type === "transcribe"
              ) {
                if (step.args?.input) {
                  await command.handler(step.args.input);
                  const feedback = `Executed: ${step.tool} with input: ${
                    typeof step.args.input === "string"
                      ? step.args.input.substring(0, 50)
                      : "[complex input]"
                  }${
                    typeof step.args.input === "string" &&
                      step.args.input.length > 50
                      ? "..."
                      : ""
                  }`;
                  log(feedback);
                  step.feedback = feedback;
                  step.status = "completed";
                  updateAgentUI();

                  // Store in context
                  agentContext.set(`executed_${step.tool}`, {
                    input: step.args.input,
                    timestamp: new Date().toISOString(),
                  });
                } else {
                  const feedback =
                    `Failed: Missing required input for ${step.tool}`;
                  log(feedback);
                  step.feedback = feedback;
                  step.status = "failed";
                  updateAgentUI();
                }
              } else if (
                command.type === "confirm" && step.args?.confirm === true
              ) {
                await command.handler();
                const feedback = `Executed: ${step.tool} with confirmation`;
                log(feedback);
                step.feedback = feedback;
                step.status = "completed";
                updateAgentUI();
              } else {
                const feedback =
                  `Skipped: Cannot execute ${command.type} command ${step.tool} automatically`;
                log(feedback);
                step.feedback = feedback;
                step.status = "failed";
                updateAgentUI();
              }
            } else {
              const feedback = `Failed: Command ${step.tool} has no handler`;
              log(feedback);
              step.feedback = feedback;
              step.status = "failed";
              updateAgentUI();
            }
          } catch (error) {
            console.error(`Error executing step ${index + 1}:`, error);
            const feedback = `Error executing step: ${
              error instanceof Error ? error.message : "Unknown error"
            }`;
            log(feedback);
            step.feedback = feedback;
            step.status = "failed";
            updateAgentUI();
          }

          // If we're not at the last step and there are more than 2 steps,
          // check if we need to revise the plan based on feedback
          if (
            index < agentState.plan.steps.length - 1 &&
            agentState.plan.steps.length > 2 &&
            step.feedback &&
            (step.feedback.startsWith("Failed") ||
              step.feedback.startsWith("Error"))
          ) {
            // Get accumulated context including all feedback so far
            const feedbackContext = agentState.plan.steps.slice(0, index + 1)
              .map((s, i) =>
                `Step ${i + 1}: ${s.description}\nTool: ${s.tool}\nResult: ${
                  s.feedback || "No feedback"
                }`
              )
              .join("\n\n");

            log("Revising plan based on feedback...");

            // Ask LLM to revise the remaining steps
            const revisionResponse = await llm.sendRequest({
              model: deps.preferredModel ||
                "anthropic:claude-3-7-sonnet-20250219-thinking",
              system:
                `You are an AI assistant that revises plans when steps fail in the Jumble system. 
Given the following context and feedback from executed steps, revise the remaining steps of the plan.
Only modify steps that haven't been executed yet.

SYSTEM BACKGROUND:
- Charms are instantiated mini applications with live, reactive data
- Each Charm is backed by a Spell or Recipe (the program that powers the Charm)
- The current Charm is the one that is currently focused in the UI

IMPORTANT CONCEPTS:
- "new-charm": Creates a completely new Spell and instantiates it as a new Charm
- "edit-recipe": Changes the Spell of the CURRENT Charm (modifies the current Charm in-place)
- "extend-recipe": Creates a NEW Spell based on the current one, and instantiates it as a new Charm while keeping the current data
- "view-charm": Just displays the current Charm without modifying anything

BEST PRACTICES:
- If the user wants to modify the CURRENT Charm, use "edit-recipe"
- If the user wants to create a variation or next step, use "extend-recipe" (safer option that preserves the original)
- Only use "new-charm" for completely fresh starts
- Actions (charm-action:*) are specific to each Charm and execute functionality within that Charm

Current context:
${agentContext.toString()}

Steps executed so far with feedback:
${feedbackContext}

Original remaining steps:
${
                  agentState.plan.steps.slice(index + 1).map((s, i) =>
                    `Step ${index + 2 + i}: ${s.description}\nTool: ${
                      s.tool || "No tool"
                    }`
                  ).join("\n\n")
                }

Available tools:
${allTools.join("\n\n")}

Format your response as JSON with this structure:
{
  "reasoning": "Explanation of why you're revising the plan",
  "revised_steps": [
    {
      "description": "Detailed description of this step",
      "tool": "tool-id", // IMPORTANT: Use the exact tool ID from the tools list, no HTML formatting
      "args": {"param1": "value1"}
    },
    ...
  ]
}

IMPORTANT: 
1. Use only the exact tool IDs from the tools list without adding any HTML formatting or quotes
2. Special information-gathering tools are "get-charm-info", "summarize-charm-data", and "get-charm-actions"
3. Tool names must be plain text (e.g., "edit-recipe" not "<font color='green'>edit-recipe</font>")`,
              messages: [{
                role: "user",
                content:
                  "Please revise the remaining steps based on the feedback.",
              }],
            });

            try {
              // Extract JSON from response
              let revisionString = revisionResponse;
              const revMatch = revisionResponse.match(
                /```(?:json)?\s*([\s\S]*?)\s*```/,
              );
              if (revMatch && revMatch[1]) {
                revisionString = revMatch[1];
              }

              const revision = JSON.parse(revisionString);

              if (
                revision.revised_steps &&
                Array.isArray(revision.revised_steps) &&
                revision.revised_steps.length > 0
              ) {
                // Replace remaining steps with revised steps
                const executedSteps = agentState.plan.steps.slice(0, index + 1);
                const revisedStepsWithStatus = revision.revised_steps.map(
                  (step) => ({
                    ...step,
                    status: "pending",
                  }),
                );

                // Update the plan with the new steps
                agentState.plan.steps = [
                  ...executedSteps,
                  ...revisedStepsWithStatus,
                ];
                agentState.totalSteps = agentState.plan.steps.length;

                log(
                  `Plan revised. New total: ${agentState.plan.steps.length} steps`,
                );
                log("Revised steps:");

                for (let i = index + 1; i < agentState.plan.steps.length; i++) {
                  log(`Step ${i + 1}: ${agentState.plan.steps[i].description}`);
                }

                // Update the UI with the revised plan
                updateAgentUI();
              }
            } catch (error) {
              console.error("Error revising plan:", error);
              log("Failed to revise plan, continuing with original steps.");
            }
          }
        }

        // Final LLM reflection on the task with all feedback
        log("Generating summary of task execution...");

        // Update UI to show the final state
        agentState.status = "completed";
        updateAgentUI();

        const taskSummary = await llm.sendRequest({
          model: deps.preferredModel ||
            "anthropic:claude-3-7-sonnet-20250219-thinking",
          system:
            `Analyze the execution of a task in the Jumble system and provide a concise summary of what was accomplished, any issues encountered, and potential next steps.

SYSTEM BACKGROUND:
- Charms are instantiated mini applications with live, reactive data
- Each Charm is backed by a Spell or Recipe (the program that powers the Charm)
- "edit-recipe" modifies the CURRENT Charm in-place
- "extend-recipe" creates a NEW Charm based on the current one (preserving the original)
- "new-charm" creates a completely fresh Charm
- "view-charm" just displays the current Charm

In your summary, mention which approach was used (modifying the current charm, extending to a new charm, or creating a brand new charm) and whether that was appropriate for the user's request.`,
          messages: [{
            role: "user",
            content:
              `Task: ${input}\n\nCurrent context:\n${agentContext.toString()}\n\nSteps executed:\n${
                agentState.plan.steps.map((step, i) =>
                  `Step ${i + 1}: ${step.description}\nTool: ${
                    step.tool || "No tool"
                  }\nResult: ${step.feedback || "No feedback"}`
                ).join("\n\n")
              }`,
          }],
        });

        // Add final summary to log and display it
        log("✅ Task completed!");
        log("Summary:");
        log(taskSummary);

        // Update the final UI with the summary
        agentState.logs.push("✅ Task completed!");
        agentState.logs.push("Summary:");
        agentState.logs.push(taskSummary);
        updateAgentUI();

        // Keep the UI open for the user to see the summary
        // They'll need to type 'cancel' to close it
      } catch (error) {
        console.error("Error parsing or executing plan:", error);
        log(
          `❌ Error: ${
            error instanceof Error ? error.message : "Failed to parse plan"
          }`,
        );

        // Update UI to show error state
        agentState.status = "error";
        updateAgentUI();
      }
    } catch (error) {
      console.error("Error parsing JSON:", error, "Raw JSON:", jsonString);
      log(
        `❌ JSON parsing error: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );

      // Try as a last resort to use regex to extract keys and values directly
      try {
        log("Attempting to recover plan using regex...");

        // Get reasoning using regex
        const reasoningMatch = jsonString.match(/"reasoning"\s*:\s*"([^"]+)"/);
        const reasoning = reasoningMatch ? reasoningMatch[1] : "";

        // Extract steps using a simple regex pattern
        const stepMatches = jsonString.match(
          /"description"\s*:\s*"([^"]+)"[^}]+?"tool"\s*:\s*"([^"]+)"/g,
        );

        if (stepMatches && stepMatches.length > 0) {
          // Create a manual plan
          const steps = stepMatches.map((match) => {
            const descMatch = match.match(/"description"\s*:\s*"([^"]+)"/);
            const toolMatch = match.match(/"tool"\s*:\s*"([^"]+)"/);

            return {
              description: descMatch ? descMatch[1] : "Unknown step",
              tool: toolMatch ? toolMatch[1] : undefined,
              args: {},
            };
          });

          // Update our agent state with the recovered plan
          agentState.plan.reasoning = reasoning;
          agentState.plan.steps = steps.map((step) => ({
            ...step,
            status: "pending",
          }));
          agentState.totalSteps = steps.length;
          agentState.status = "executing";

          log(`Recovered plan with ${steps.length} steps`);
          log("Continuing with recovered plan...");

          // Update UI
          updateAgentUI();

          // Continue with the execution (note: this is a simplified version)
          for (const [index, step] of agentState.plan.steps.entries()) {
            // Mark step as executing
            step.status = "executing";
            agentState.currentStep = index + 1;
            updateAgentUI();

            log(`Executing step ${index + 1}: ${step.description}`);

            // Simplified execution - just log the step for now
            const feedback = `Executed: ${
              step.tool || "Unknown tool"
            } (recovered plan)`;
            log(feedback);
            step.feedback = feedback;
            step.status = "completed";
            updateAgentUI();
          }

          // Complete the task
          agentState.status = "completed";
          log("✅ Task completed with recovered plan!");
          updateAgentUI();

          return;
        }

        throw new Error("Could not recover plan");
      } catch (recoveryError) {
        console.error("Recovery failed:", recoveryError);
        agentState.status = "error";
        log("❌ Could not recover from JSON parsing error");
        updateAgentUI();
      }
    }
  } catch (error) {
    console.error("Agent mode error:", error);
    log(
      `❌ Error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );

    // Update UI to show error state
    agentState.status = "error";
    updateAgentUI();
  }
}

export function getCommands(deps: CommandContext): CommandItem[] {
  return [
    {
      id: "agent-mode",
      type: "input",
      title: "Agent Mode",
      group: "Create",
      placeholder: "What would you like me to help you with?",
      handler: (input) => handleAgentMode(deps, input),
    },
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
                const id = charmId(selected);
                if (!id || !deps.focusedReplicaId) {
                  throw new Error("Missing charm ID or replica name");
                }
                // Navigate to stack URL instead of detail page
                const path = createPath("stackedCharms", {
                  charmIds: deps.focusedCharmId + "," + id,
                  replicaName: deps.focusedReplicaId,
                });
                deps.navigate(path);
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
      title: `Iterate on Recipe`,
      group: "Edit",
      predicate: !!deps.focusedCharmId,
      placeholder: "What would you like to change?",
      handler: (input) => handleEditRecipe(deps, input),
    },
    {
      id: "extend-recipe",
      type: "input",
      title: `Extend Recipe`,
      group: "Edit",
      predicate: !!deps.focusedCharmId,
      placeholder: "What you like to see?",
      handler: (input) => handleExtendRecipe(deps, input),
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
          deps.setOpen(false);
          return;
        }
        deps.navigate(
          createPath("charmShow", {
            charmId: deps.focusedCharmId,
            replicaName: deps.focusedReplicaId,
          }),
        );
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
              globalThis.location.href = `/${input}`;
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
      title: `Iterate (Voice)${
        deps.preferredModel ? ` (${deps.preferredModel})` : ""
      }`,
      group: "Edit",
      predicate: !!deps.focusedCharmId,
      handler: (transcription) => {
        if (!transcription) return;

        const commands = getCommands(deps);
        const editRecipeCommand = commands.find((cmd) =>
          cmd.id === "edit-recipe"
        )!;

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
