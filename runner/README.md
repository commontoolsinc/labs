# Runner

The Runner package provides a reactive runtime for executing recipes
(computational graphs) with automatic dependency tracking, state management, and
persistence.

## Key Features

- **Cell-based Reactivity**: Create, manage, and observe reactive data cells
- **Recipe Execution**: Run computational graphs defined as recipes
- **Automatic Dependency Tracking**: Changes propagate through your application
  automatically
- **Schema Validation**: Validate and transform data against JSON Schema
  definitions
- **Storage Integration**: Optional persistence and synchronization of data

## Core Components

### Cells

Cells are reactive data containers that notify subscribers when their values
change. They support various operations and can be linked to form complex data
structures.

User-land, cells are accessed via recipes (see below), but in the system, e.g.
in the renderer or system UI, they are used directly:

```typescript
import { getCell, getImmutableCell } from "@commontools/runner";

// Create a cell with schema and default values
const settingsCell = getCell(
  "my-space", // The space this cell belongs to
  "settings", // Causal ID - a string identifier
  { // JSON Schema with default values
    type: "object",
    properties: {
      theme: { type: "string" },
      fontSize: { type: "number" },
    },
    default: { theme: "dark", fontSize: 14 },
  },
);

// Create a related cell using an object with references as causal ID
// This establishes a semantic relationship between cells
const profileCell = getCell(
  "my-space", // The space this cell belongs to
  { parent: settingsCell, id: "profile" }, // Causal ID with reference to parent
  { // JSON Schema with default values
    type: "object",
    properties: {
      name: { type: "string" },
      language: { type: "string" },
    },
    default: { name: "User", language: "en" },
  },
);

// Two cells with the same causal ID will be synced automatically
// when using storage, even across different instances

// Create an immutable cell (cannot be modified after creation)
// For immutable cells, the value is provided directly and the ID is derived from it
const configCell = getImmutableCell(
  "my-space", // The space this cell belongs to
  { version: "1.0", readOnly: true }, // The immutable value (ID derived from it)
  { // Optional schema for type checking
    type: "object",
    properties: {
      version: { type: "string" },
      readOnly: { type: "boolean" },
    },
  },
);

// Get and set values
const settings = settingsCell.get();
settingsCell.set({ theme: "light", fontSize: 16 });

// Work with nested properties
const themeProperty = settingsCell.key("theme");
themeProperty.set("system");

// Subscribe to changes
// sink() will immediately call the callback with the current value,
// and then call it again whenever the value changes
const cleanup = settingsCell.sink((value) => {
  console.log("Settings value:", value); // Called immediately, then on changes
  // Returns the current theme: "dark" initially, then "system" after the update

  // Can return a cleanup function that will be called when unsubscribing
  // or before the next callback invocation
  return () => {
    console.log("Cleaning up subscription for value:", value);
  };
});

// Clean up subscription when done
cleanup();
```

### Cells with Type-Safe Schemas

Using cells with schemas is highly recommended as it provides type checking,
validation, and automatic transformation of data. The `Schema<>` helper from the
Builder package provides TypeScript type inference.

```typescript
import { getCell } from "@commontools/runner";
import type { JSONSchema } from "@commontools/builder";

// Define a schema with type assertions for TypeScript inference
const userSchema = {
  type: "object",
  properties: {
    id: { type: "number" },
    name: { type: "string" },
    settings: {
      type: "object",
      properties: {
        theme: { type: "string" },
        notifications: { type: "boolean" },
      },
      // Make settings a nested cell that can be observed independently
      asCell: true,
      default: { theme: "light", notifications: true },
    },
    tags: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["id", "name"],
  default: {
    id: 123,
    name: "Alice",
    tags: [],
    // settings will use its own default value
  },
} as const satisfies JSONSchema;

// Create a cell with schema validation
const userCell = getCell(
  "my-space",
  "user-123", // Causal ID - identifies this particular user
  userSchema, // Schema for validation, typing, and default values
);

// Access the typed data
const user = userCell.get();
console.log(user.name); // "Alice"

// Access nested cells
const settingsCell = user.settings; // This is a cell
const settings = settingsCell.get();
console.log(settings.theme); // "light"

// Update nested cells
settingsCell.set({ theme: "dark", notifications: false });

// Key navigation preserves schema
const nameCell = userCell.key("name");
console.log(nameCell.get()); // "Alice"
```

### Running Recipes

Recipes define computational graphs that process data. Recipes are created using
the Builder package and executed by the Runner, which manages dependencies and
updates results automatically.

```typescript
import { getCell, run, stop } from "@commontools/runner";
import { derive, recipe } from "@commontools/builder";

// Define a recipe with input and output schemas
const doubleNumberRecipe = recipe(
  // Input schema
  {
    type: "object",
    properties: {
      value: { type: "number" },
    },
    default: { value: 0 },
  },
  // Output schema
  {
    type: "object",
    properties: {
      result: { type: "number" },
    },
    required: ["result"],
  },
  // Implementation function
  (input) => {
    return { result: derive(input.value, (value) => value * 2) };
  },
);

// Create a cell to store results
const resultCell = getCell(
  "my-space",
  "calculation-result",
  {}, // Empty schema as we'll let the recipe define the structure
);

// Run the recipe
const result = run(doubleNumberRecipe, { value: 5 }, resultCell);

// Await the computation graph to settle
await idle();

// Access results (which update automatically)
console.log(result.get()); // { result: 10 }

// Update input and watch result change automatically
const sourceCell = result.sourceCell;
sourceCell.key("argument").key("value").set(10);
await idle();
console.log(result.get()); // { result: 20 }

// Stop recipe execution when no longer needed
stop(result);
```

### Storage

The storage system provides persistence for cells and synchronization across
clients.

```typescript
import { storage } from "@commontools/runner";

// Configure storage with remote endpoint
storage.setRemoteStorage(new URL("https://example.com/api"));

// Set identity signer for authentication
storage.setSigner(mySigner);

// Sync a cell with storage
await storage.syncCell(userCell);

// Sync by entity ID
const cell = await storage.syncCellById("my-space", "entity-id");

// Wait for all pending sync operations to complete
await storage.synced();

// When cells with the same causal ID are synced across instances,
// they will automatically be kept in sync with the latest value
```

## Advanced Features

### Reactive Data Transformation

You can map and transform data using cells with schemas:

```typescript
import { getCell } from "@commontools/runner";
import type { JSONSchema } from "@commontools/builder";

// Original data source cell
const sourceCell = getCell(
  "my-space",
  "source-data",
  {
    type: "object",
    properties: {
      id: { type: "number" },
      metadata: {
        type: "object",
        properties: {
          createdAt: { type: "string" },
          type: { type: "string" },
        },
      },
      tags: {
        type: "array",
        items: { type: "string" },
      },
    },
    default: {
      id: 1,
      metadata: {
        createdAt: "2023-01-01",
        type: "user",
      },
      tags: ["tag1", "tag2"],
    },
  },
);

// Create a mapping cell that reorganizes the data
const mappingCell = getCell(
  "my-space",
  "data-mapping",
  {
    type: "object",
    properties: {
      id: { type: "number" },
      changes: {
        type: "array",
        items: { type: "string" },
      },
      kind: { type: "string" },
      firstTag: { type: "string" },
    },
    default: {
      // References to source cell values
      id: { cell: sourceCell, path: ["id"] },
      // Turn single value to array
      changes: [{ cell: sourceCell, path: ["metadata", "createdAt"] }],
      // Rename field and uplift from nested element
      kind: { cell: sourceCell, path: ["metadata", "type"] },
      // Reference to first array element
      firstTag: { cell: sourceCell, path: ["tags", 0] },
    },
  },
);

// The schema is already applied - just get the result
const result = mappingCell.get();
console.log(result);
// {
//   id: 1,
//   changes: ["2023-01-01"],
//   kind: "user",
//   firstTag: "tag1"
// }
```

### Nested Reactivity

Cells can react to changes in deeply nested structures:

```typescript
import { getCell } from "@commontools/runner";

const rootCell = getCell(
  "my-space",
  "nested-example",
  {
    type: "object",
    properties: {
      value: { type: "string" },
      current: {
        type: "object",
        properties: {
          label: { type: "string" },
        },
        // Make nested object a cell so it can be observed independently
        asCell: true,
      },
    },
    default: {
      value: "root",
      current: {
        label: "nested",
      },
    },
  },
);

// Subscribe to changes in the whole cell
// This callback is called immediately with the current value,
// and then again whenever the value changes
rootCell.sink((value) => {
  console.log("Root changed:", value); // Called immediately with initial value

  // Also subscribe to changes in the nested property
  // (this is a cell because we used asCell: true in the schema)
  // This inner sink is also called immediately with the current nested value
  const cancel = value.current.sink((nestedValue) => {
    console.log("Nested value:", nestedValue); // Called immediately, then on changes
  });

  // Return a cleanup function that will be called when unsubscribing
  // or before the next callback invocation
  return () => {
    console.log("Root subscription cancelled");
    cancel(); // Clean up nested subscription
  };
});

// Subscribe to a specific nested path
rootCell.key("current").key("label").sink((value) => {
  console.log("Label value:", value); // Called immediately with "nested"
});

// Changing values will trigger the callbacks
rootCell.key("current").key("label").set("updated");
// This will log:
// "Label value: updated"
// "Nested value: { label: 'updated' }"
// "Root changed: { value: 'root', current: { label: 'updated' } }"
```

## TypeScript Support

All APIs are fully typed with TypeScript to provide excellent IDE support and
catch errors at compile time.

## Contributing

See the project's main contribution guide for details on development workflow,
testing, and submitting changes.
