/// <cts-enable />
import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  recipe,
  str,
  toSchema,
} from "commontools";

const childIncrement = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const next = (context.value.get() ?? 0) + amount;
    context.value.set(next);
  },
);

const spawnedChild = recipe<{ value: Default<number, 0> }, SpawnedChildState>(
  "Spawned Child Counter",
  ({ value }) => {
    return {
      value,
      label: str`Child value ${value}`,
      increment: childIncrement({ value }),
    };
  },
);

type SpawnedChildState = {
  value: number;
  label: string;
  increment: { amount?: number };
};

interface HandlerSpawnArgs {
  children: Default<SpawnedChildState[], []>;
}

const addChild = lift(
  toSchema<
    {
      child: Cell<number>;
      children: Cell<SpawnedChildState[]>;
      initialized: Cell<boolean>;
    }
  >(),
  toSchema<never>(),
  ({ child, children, initialized }) => {
    if (!initialized.get()) {
      children.push(child);
      initialized.set(true);
    }
  },
);

const spawnChild = handler(
  (
    event: { seed?: number },
    context: { children: Cell<SpawnedChildState[]> },
  ) => {
    const seed = typeof event?.seed === "number" ? event.seed : 0;
    const child = spawnedChild({ value: seed });
    return addChild({
      child,
      children: context.children,
      initialized: cell(false),
    });
  },
);

export const counterWithHandlerSpawn = recipe<HandlerSpawnArgs>(
  "Counter With Handler Spawn",
  ({ children }) => {
    return {
      children,
      spawn: spawnChild({ children }),
    };
  },
);
