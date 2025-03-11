import { NAME } from "@commontools/builder";
import { Charm, CharmManager } from "@commontools/charm";
import { isStream } from "@commontools/runner";
import { CommandContext, CommandItem, CommandMode, getCommands } from "./commands.ts";
import { llm } from "@/utils/llm.ts";

// Agent mode function - implementation with feedback loops and context awareness

export type Step = {
  description: string;
  tool?: string;
  args?: Record<string, unknown>;
  feedback?: string; // To store feedback from tool execution
};

// Context manager to help the agent understand what it's working with
export class AgentContext {
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
export interface AgentModeState {
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

export async function handleAgentMode(
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
        handler: (input: string | undefined) => {
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
    const availableCommands = allCommands.filter((cmd: CommandItem) =>
      cmd.type !== "menu" &&
      cmd.id !== "background-jobs" &&
      cmd.id !== "agent-mode" && // Prevent infinite recursion
      cmd.predicate !== false
    );

    // Format command descriptions for the LLM
    const commandDescriptions = availableCommands.map((cmd: CommandItem) => {
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
        agentState.plan.steps = plan.steps.map((step: Step) => ({
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

        plan.steps.forEach((step: Step, index: number) => {
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

              const stream = charm.key(actionName);

              if (!isStream(stream)) {
                const feedback =
                  `Failed: Action ${actionName} not found or not executable`;
                log(feedback);
                step.feedback = feedback;
                step.status = "failed";
                updateAgentUI();
                continue;
              }

              // Execute the action
              stream.send(step.args);
              const feedback = `Executed charm action: ${actionName} ${
                step.args ?? "with no input"
              }`;
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
            const command = availableCommands.find((cmd: CommandItem) =>
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
                  (step: Step) => ({
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
      console.error("Error parsing JSON:", error, "Raw JSON:", response);
      log(
        `❌ JSON parsing error: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
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