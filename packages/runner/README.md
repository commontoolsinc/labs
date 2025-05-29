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
- **Dependency Injection**: No singleton patterns - all services are injected
  through a central Runtime instance

## Architecture

The Runner has been refactored to eliminate singleton patterns in favor of
dependency injection through a central Runtime instance. This provides better
testability, isolation, and control over service configuration.

### Runtime-Centric Design

All services are now accessed through a `Runtime` instance:

```typescript
import { Runtime } from "@commontools/runner";

// Create a runtime instance with configuration
const runtime = new Runtime({
  storageUrl: "https://example.com/storage", // Required
  signer: myIdentitySigner, // Optional, for remote storage
  enableCache: true, // Optional, default true
  consoleHandler: myConsoleHandler, // Optional
  errorHandlers: [myErrorHandler], // Optional
  blobbyServerUrl: "https://example.com/blobby", // Optional
  recipeEnvironment: { apiUrl: "https://api.example.com" }, // Optional
  debug: false, // Optional
});

// Access services through the runtime
const cell = runtime.getCell("my-space", "my-cause", schema);
const doc = runtime.documentMap.getDoc(value, cause, space);
await runtime.storage.syncCell(cell);
const recipe = await runtime.recipeManager.loadRecipe(recipeId);

// Wait for all operations to complete
await runtime.idle();

// Clean up when done
await runtime.dispose();
```

## Code Organization

The Runner codebase is organized around several core concepts that work together
to provide a reactive runtime system. Here's a map of the key files and their
purposes:

### Core Files

- `src/index.ts`: The main entry point that exports the public API
- `src/runtime.ts`: Central orchestrator that creates and manages all services
- `src/cell.ts`: Defines the `Cell` abstraction and its implementation
- `src/doc.ts`: Implements `DocImpl` which represents stored documents in storage
- `src/runner.ts`: Provides the runtime for executing recipes
- `src/scheduler.ts`: Manages execution order and batching of reactive updates
- `src/storage.ts`: Manages persistence and synchronization
- `src/doc-map.ts`: Manages the mapping between entities and documents
- `src/recipe-manager.ts`: Handles recipe loading, compilation, and caching
- `src/module.ts`: Manages module registration and retrieval

## Core Concepts

### Document vs Cell Abstractions

One of the most important concepts to understand in the Runner is the
relationship between documents and cells:

- **DocImpl**: Represents raw documents stored in storage. These are the actual
  persistence units that get saved and synchronized.

- **Cell**: The user-facing abstraction that provides a reactive view over one
  or more documents. Cells are defined by schemas and can traverse document
  relationships through cell links and aliases.

While DocImpl handles the low-level storage concerns, Cells provide the
higher-level programming model with schema validation, reactivity, and
relationship traversal. When you're working with data in the Runner, you'll
almost always interact with Cells rather than directly with DocImpl instances.

### Schema and Validation

The schema system defines both the structure of data and how it's represented in
storage:

- Schemas are based on JSON Schema with extensions for reactivity and references
- Each Cell has an associated schema that validates its data
- Schemas can define nested cells with `asCell: true`
- Schema validation happens automatically when setting values

### CellLink and Aliases

Cells can reference other cells through links and aliases:

- **CellLink**: A reference to another cell, containing a space ID and document
  ID
- **Aliases**: Named references within documents that point to other documents
- These mechanisms allow building complex, interconnected data structures
- The system automatically traverses links when needed

### Recipe System

Recipes define computational graphs that process data:

- Created using the Builder package (`@commontools/builder`)
- Define inputs, outputs, and transformation logic
- Can be composed into larger recipes
- Executed by the Runner with automatic dependency tracking

### Storage Layer

The storage system handles persistence and synchronization:

- Multiple storage implementations (memory, remote)
- Document-based persistence model
- Identity-based access control
- Synchronization through a publish/subscribe mechanism
- Primitives for conflict resolution strategies, although right now only
  compare-and-swap is implemented and failed transactions just reset the data

### Reactivity System

The reactivity system is what makes the Runner dynamic:

- Based on observable patterns and subscriptions
- Changes automatically propagate through the system
- Fine-grained updates minimize unnecessary recalculations

### Scheduler

The scheduler manages the execution order of reactive updates:

- Ensures updates happen in a predictable order
- Batches related updates for efficiency
- Prevents infinite update loops
- Provides hooks for synchronization points via `idle()`

## Core Components

### Cells

Cells are reactive data containers that notify subscribers when their values
change. They support various operations and can be linked to form complex data
structures.

Cells are now created through the Runtime instance rather than global functions:

```typescript
import { Runtime } from "@commontools/runner";

// Create a runtime instance first
const runtime = new Runtime({
  storageUrl: "volatile://", // Use volatile storage for this example
});

// Create a cell with schema and default values
const settingsCell = runtime.getCell(
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
const profileCell = runtime.getCell(
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
import { Runtime } from "@commontools/runner";
import type { JSONSchema } from "@commontools/builder";

// Create runtime instance
const runtime = new Runtime({ storageUrl: "volatile://" });

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
const userCell = runtime.getCell(
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
import { Runtime } from "@commontools/runner";
import { derive, recipe } from "@commontools/builder";

// Create runtime instance
const runtime = new Runtime({ storageUrl: "volatile://" });

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
const resultCell = runtime.documentMap.getDoc(
  undefined,
  "calculation-result",
  "my-space",
);

// Run the recipe
const result = runtime.runner.run(doubleNumberRecipe, { value: 5 }, resultCell);

// Await the computation graph to settle
await runtime.idle();

// Access results (which update automatically)
console.log(result.get()); // { result: 10 }

// Update input and watch result change automatically
const sourceCell = result.sourceCell;
sourceCell.key("argument").key("value").set(10);
await runtime.idle();
console.log(result.get()); // { result: 20 }

// Stop recipe execution when no longer needed
runtime.runner.stop(result);
```

### Storage

The storage system provides persistence for cells and synchronization across
clients.

```typescript
import { Runtime } from "@commontools/runner";
import { Identity } from "@commontools/identity";

// Create signer for authentication
const signer = await Identity.fromPassphrase("my-passphrase");

// Configure runtime with remote storage
const runtime = new Runtime({
  storageUrl: "https://example.com/api",
  signer: signer,
  enableCache: true,
});

// Sync a cell with storage
await runtime.storage.syncCell(userCell);

// Sync by entity ID
const cell = await runtime.storage.syncCellById("my-space", "entity-id");

// Wait for all pending sync operations to complete
await runtime.storage.synced();

// When cells with the same causal ID are synced across instances,
// they will automatically be kept in sync with the latest value
```

## Advanced Features

### Reactive Data Transformation

You can map and transform data using cells with schemas:

```typescript
import { Runtime } from "@commontools/runner";
import type { JSONSchema } from "@commontools/builder";

// Create runtime instance
const runtime = new Runtime({ storageUrl: "volatile://" });

// Original data source cell
const sourceCell = runtime.getCell(
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
const mappingCell = runtime.getCell(
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
import { Runtime } from "@commontools/runner";

// Create runtime instance
const runtime = new Runtime({ storageUrl: "volatile://" });

const rootCell = runtime.getCell(
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

## Migration from Singleton Pattern

Previous versions of the Runner used global singleton functions. These have been
replaced with Runtime instance methods:

```typescript
// OLD (deprecated):
import { getCell, storage, idle } from "@commontools/runner";
const cell = getCell(space, cause, schema);
await storage.syncCell(cell);
await idle();

// NEW (current):
import { Runtime } from "@commontools/runner";
const runtime = new Runtime({ storageUrl: "volatile://" });
const cell = runtime.getCell(space, cause, schema);
await runtime.storage.syncCell(cell);
await runtime.idle();
```

### Key Changes

- `getCell()` → `runtime.getCell()`
- `getCellFromLink()` → `runtime.getCellFromLink()`
- `getDocByEntityId()` → `runtime.documentMap.getDocByEntityId()`
- `storage.*` → `runtime.storage.*`
- `idle()` → `runtime.idle()`
- `run()` → `runtime.runner.run()`
- Storage configuration now happens in Runtime constructor

### Runtime Configuration

The Runtime constructor accepts a configuration object:

```typescript
interface RuntimeOptions {
  storageUrl: string;              // Required: storage backend URL
  signer?: Signer;                 // Optional: for remote storage auth
  enableCache?: boolean;           // Optional: enable local caching
  consoleHandler?: ConsoleHandler; // Optional: custom console handling
  errorHandlers?: ErrorHandler[];  // Optional: error handling
  blobbyServerUrl?: string;        // Optional: blob storage URL
  recipeEnvironment?: RecipeEnvironment; // Optional: recipe env vars
  debug?: boolean;                 // Optional: debug logging
}
```

### Storage URL Patterns

- `"volatile://"` - In-memory storage (for testing)
- `"https://example.com/storage"` - Remote storage with schema queries
- Custom providers can be configured through options

## TypeScript Support

All APIs are fully typed with TypeScript to provide excellent IDE support and
catch errors at compile time.

## Data Flow in the Runner

Understanding the data flow in the Runner helps visualize how different
components interact:

1. **Input** → Data enters the system through Cell updates or recipe executions
2. **Validation** → Schema validation ensures data conforms to expected
   structure (so far only on get, not yet on write)
3. **Processing** → Recipes transform data according to their logic
4. **Reactivity** → Changes propagate to dependent cells and recipes
5. **Storage** → Updated data is persisted to storage if configured
6. **Synchronization** → Changes are synchronized across clients if enabled

This flow happens automatically once set up, allowing developers to focus on
business logic rather than managing data flow manually.

## Service Architecture

The Runtime coordinates several core services:

- **Scheduler**: Manages execution order and batching of reactive updates
- **Storage**: Handles persistence and synchronization with configurable backends
- **DocumentMap**: Maps entity IDs to document instances and manages creation
- **RecipeManager**: Loads, compiles, and caches recipe definitions
- **ModuleRegistry**: Manages module registration and retrieval for recipes
- **Runner**: Executes recipes and manages their lifecycle
- **Harness**: Provides the execution environment for recipe code

All services receive the Runtime instance as a dependency, enabling proper
isolation and testability without global state.

## Contributing

See the project's main contribution guide for details on development workflow,
testing, and submitting changes.
