/// <cts-enable />
import { recipe, NAME, handler, toSchema, Cell, Stream } from "commontools";

// Define types using TypeScript - more compact!
interface UpdaterInput {
  newValues: string[];
}

interface RecipeInput {
  values: Cell<string[]>;
}

interface RecipeOutput {
  values: string[];
  updater: Stream<UpdaterInput>;
}

// Transform to schema at compile time
const updaterSchema = toSchema<UpdaterInput>({
  title: "Update Values",
  description: "Append `newValues` to the list.",
  examples: [{ newValues: ["foo", "bar"] }],
  default: { newValues: [] },
});

const inputSchema = toSchema<RecipeInput>({
  default: { values: [] },
});

const outputSchema = toSchema<RecipeOutput>();

// Use with handler - type safe!
const updater = handler(
  updaterSchema,
  inputSchema,
  (event: UpdaterInput, state: RecipeInput) => {
    event.newValues.forEach((value) => {
      state.values.push(value);
    });
  },
);

// Example with more complex types
interface User {
  name: string;
  age: number;
  email?: string; // Optional property
  tags: string[];
  metadata: {
    created: Date;
    updated: Date;
  };
}

const userSchema = toSchema<User>({
  description: "A user in the system",
});

export default recipe("test", (state) => {
  return {
    [NAME]: "test",
  };
});
