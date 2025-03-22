import { Behavior, FX, sleep } from "./state-machine.ts";

// Define command metadata with params type for inference
interface CommandDef<
  P extends Record<string, unknown> = Record<string, never>,
> {
  type: string;
  description: string;
  params: P;
  required?: Array<keyof P>;
  // Add wait condition metadata
  wait?: {
    condition: (state: any, previousState: any) => boolean;
    timeout?: number;
    resultExtractor?: (state: any) => any;
    errorDetector?: (state: any) => { isError: boolean; message?: string };
  };
}

// Command registry with strong typing
export const CommandRegistry = {
  echo: {
    type: "echo",
    description: "Echo back a message",
    params: {
      message: { type: "string", description: "Message to echo back" },
    },
    required: ["message" as const],
    // Add a simple wait condition that always returns true
    wait: {
      condition: () => true,
      timeout: 5000,
      resultExtractor: (state) => state
    }
  },
  increment: {
    type: "increment",
    description: "Increment the counter",
    params: {},
    // Add wait condition to ensure the increment has been processed
    wait: {
      condition: (state, prevState) => state.counter > prevState.counter,
      timeout: 5000,
      resultExtractor: (state) => ({ counter: state.counter })
    }
  },
  decrement: {
    type: "decrement",
    description: "Decrement the counter",
    params: {},
    // Add wait condition to ensure the decrement has been processed
    wait: {
      condition: (state, prevState) => state.counter < prevState.counter,
      timeout: 5000,
      resultExtractor: (state) => ({ counter: state.counter })
    }
  },
  reset: {
    type: "reset",
    description: "Reset the counter to zero",
    params: {},
    // Add wait condition to ensure the reset has been processed
    wait: {
      condition: (state) => state.counter === 0,
      timeout: 5000,
      resultExtractor: (state) => ({ counter: state.counter })
    }
  },
} as const;

// Derive Command type from the registry
type CommandRegistry = typeof CommandRegistry;
type CommandTypes = keyof CommandRegistry;

// Define payload type for each command based on its params
type CommandPayload<T extends CommandTypes> = {
  [K in keyof CommandRegistry[T]["params"]]: unknown;
};

// Final Command type derived from the registry
type Command = {
  [T in CommandTypes]: { type: T } & CommandPayload<T>;
}[CommandTypes];

// Model type
type Model = {
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
        const newMessages = [...model.messages, command.message as string];
        return { ...model, messages: newMessages };
      }
      case "increment": {
        // Directly update the counter without sleep
        return { ...model, counter: model.counter + 1 };
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
  },
  // Add handle and process methods to ensure proper completion
  *handle(effect) {
    // No custom handling needed for basic effects
    return undefined;
  },
  *process(model, result) {
    // Ensure we return a properly structured response when processing results
    return model;
  },
};
