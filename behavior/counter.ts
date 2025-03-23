import { Behavior, FX } from "./state-machine.ts";
import { CommandDef, createCommandDef, CommandsFromRegistry } from "./behavior-utils.ts";

// Define command registry with strong typing using the helper
export const CommandRegistry = {
  echo: createCommandDef(
    "echo",
    "Echoes back the input text",
    {
      text: { type: "string", description: "The text to echo back" },
    },
    ["text" as const],
    {
      condition: () => true,
      timeout: 5000,
      resultExtractor: (state) => state
    }
  ),
  increment: createCommandDef(
    "increment",
    "Increments the counter by a given amount",
    {
      amount: { type: "number", description: "The amount to increment by (defaults to 1)" },
    },
    [],
    {
      condition: (state, prevState) => state.counter > prevState.counter,
      timeout: 5000,
      resultExtractor: (state) => ({ counter: state.counter })
    }
  ),
  decrement: createCommandDef(
    "decrement",
    "Decrements the counter",
    {},
    [],
    {
      condition: (state, prevState) => state.counter < prevState.counter,
      timeout: 5000,
      resultExtractor: (state) => ({ counter: state.counter })
    }
  ),
  reset: createCommandDef(
    "reset",
    "Reset the counter to zero",
    {},
    [],
    {
      condition: (state) => state.counter === 0,
      timeout: 5000,
      resultExtractor: (state) => ({ counter: state.counter })
    }
  ),
};

// Derive Command type from the registry using the utility type
export type Command = CommandsFromRegistry<typeof CommandRegistry>;

// Model type
export type Model = {
  messages: string[];
  counter: number;
};

// Create behavior for our state machine
export const behavior: Behavior<Model, Command> = {
  *init() {
    return {
      messages: [],
      counter: 0,
    };
  },
  *update(model: Model, command: Command) {
    switch (command.type) {
      case "echo": {
        const newMessages = [...model.messages, command.text as string];
        return { ...model, messages: newMessages };
      }
      case "increment": {
        const amount = typeof command.amount === 'number' ? command.amount : 1;
        return { ...model, counter: model.counter + amount };
      }
      case "decrement": {
        return { ...model, counter: model.counter - 1 };
      }
      case "reset": {
        return { ...model, counter: 0 };
      }
      default:
        return model;
    }
  }
};