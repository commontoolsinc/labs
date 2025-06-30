# Common Labs API Documentation

## Table of Contents

1. [Overview](#overview)
2. [Core APIs](#core-apis)
   - [Builder API (@commontools/api)](#builder-api-commontoolsapi)
   - [Runner API (@commontools/runner)](#runner-api-commontoolsrunner)
   - [Memory API (@commontools/memory)](#memory-api-commontoolsmemory)
   - [LLM API (@commontools/llm)](#llm-api-commontoolsllm)
3. [Backend APIs](#backend-apis)
   - [Toolshed HTTP API](#toolshed-http-api)
   - [AI Services](#ai-services)
4. [Frontend APIs](#frontend-apis)
   - [UI Components (@commontools/ui)](#ui-components-commontoolsui)
   - [Jumble Components](#jumble-components)
5. [CLI API (@commontools/cli)](#cli-api-commontoolscli)
6. [Utility APIs](#utility-apis)
7. [Examples and Usage](#examples-and-usage)

## Overview

Common Labs is a reactive computing platform built on Deno that provides:
- **Cell-based reactivity**: Reactive data containers that notify subscribers of changes
- **Recipe execution**: Computational graphs with automatic dependency tracking
- **Storage integration**: Persistent, transactional memory store
- **AI integration**: Built-in LLM and AI services
- **Modern UI components**: Web components library built with Lit

## Core APIs

### Builder API (@commontools/api)

The Builder API is the main public interface for creating reactive applications.

#### Core Types

```typescript
import { Cell, OpaqueRef, Opaque, JSONSchema } from "@commontools/api";

// Cell interface - reactive data container
interface Cell<T = any> {
  get(): T;
  set(value: T): void;
  send(value: T): void; // alias for set
  update(values: Partial<T>): void;
  push(...value: T extends (infer U)[] ? U[] : never): void;
  equals(other: Cell<any>): boolean;
  key<K extends keyof T>(valueKey: K): Cell<T[K]>;
}

// Stream interface - event emitter
interface Stream<T> {
  send(event: T): void;
}

// Opaque references for type-safe reactive programming
type OpaqueRef<T> = OpaqueRefMethods<T> & (
  T extends Array<infer U> ? Array<OpaqueRef<U>>
  : T extends object ? { [K in keyof T]: OpaqueRef<T[K]> }
  : T
);
```

#### Recipe Functions

```typescript
// Create recipes - computational graphs
export declare const recipe: RecipeFunction;

// Example usage:
const myRecipe = recipe(
  // Input schema
  {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" }
    },
    required: ["name"]
  },
  // Implementation
  (input) => {
    return {
      greeting: str`Hello ${input.name}!`,
      isAdult: derive(input.age, age => age >= 18)
    };
  }
);
```

#### Reactive Functions

```typescript
// Derive computed values
export declare const derive: DeriveFunction;
// Usage: derive(sourceCell, (value) => transformedValue)

// Create computed values
export declare const compute: ComputeFunction;
// Usage: compute(() => someComputation())

// Template string interpolation
export declare const str: StrFunction;
// Usage: str`Hello ${nameCell}!`

// Conditional logic
export declare const ifElse: IfElseFunction;
// Usage: ifElse(condition, trueValue, falseValue)
```

#### AI Functions

```typescript
// LLM text generation
export declare const llm: LLMFunction;
// Usage: llm({ messages: ["Hello"], model: "claude-3-sonnet" })

// Structured object generation
export declare const generateObject: GenerateObjectFunction;
// Usage: generateObject({ prompt: "Generate user data", schema: userSchema })
```

#### Data Functions

```typescript
// HTTP data fetching
export declare const fetchData: FetchDataFunction;
// Usage: fetchData({ url: "https://api.example.com/data" })

// Streaming data
export declare const streamData: StreamDataFunction;
// Usage: streamData({ url: "https://stream.example.com" })

// Code compilation and execution
export declare const compileAndRun: CompileAndRunFunction;
// Usage: compileAndRun({ files: [{ name: "main.ts", contents: "..." }], main: "main.ts" })
```

#### Cell Creation

```typescript
// Create reactive cells
export declare const cell: CellFunction;
// Usage: cell(initialValue, schema)

// Create event streams
export declare const stream: StreamFunction;
// Usage: stream(initialValue)

// Create cells from references
export declare const byRef: ByRefFunction;
// Usage: byRef("entity-id")
```

### Runner API (@commontools/runner)

The Runner provides the reactive runtime for executing recipes.

#### Runtime Class

```typescript
import { Runtime } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

// Create runtime instance
const runtime = new Runtime({
  storageManager: new StorageManager({ /* config */ }),
  consoleHandler?: ConsoleHandler,
  errorHandlers?: ErrorHandler[],
  blobbyServerUrl?: string,
  recipeEnvironment?: RecipeEnvironment,
  debug?: boolean
});

// Core methods
await runtime.idle(); // Wait for operations to complete
await runtime.dispose(); // Clean up resources
```

#### Cell Management

```typescript
// Get or create cells
const cell = runtime.getCell(
  "my-space",           // Space identifier
  "entity-id",          // Causal ID
  schema               // JSON Schema with defaults
);

// Example with typed schema
const userCell = runtime.getCell(
  "users",
  "user-123",
  {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" },
      settings: {
        type: "object",
        properties: {
          theme: { type: "string" }
        },
        asCell: true, // Make this a nested cell
        default: { theme: "dark" }
      }
    },
    default: { name: "User", age: 25 }
  }
);

// Access nested cells
const settingsCell = userCell.get().settings;
settingsCell.set({ theme: "light" });
```

#### Recipe Execution

```typescript
// Run recipes
const result = runtime.runner.run(
  recipe,              // Recipe to execute
  inputData,          // Input arguments
  outputCell          // Cell to store results
);

// Stop recipe execution
runtime.runner.stop(result);
```

#### Storage Operations

```typescript
// Sync cells with storage
await runtime.storage.syncCell(cell);
await runtime.storage.syncCellById("space", "entity-id");
await runtime.storage.synced(); // Wait for all sync operations
```

### Memory API (@commontools/memory)

Persistent, transactional memory store using a fact-based data model.

#### Data Model

```typescript
// Facts represent discrete state in time
type Fact = {
  the: string;    // Type of fact (usually "application/json")
  of: string;     // Entity identifier
  is: JSONValue;  // Value
  cause: Reference<Fact> | Reference<Unclaimed>; // Causal reference
};

// Spaces are sharing boundaries
type Space = string; // Usually a did:key identifier
```

#### HTTP API

The Memory service provides HTTP endpoints for data operations:

**PATCH /**: Transact (assert/retract facts)
```typescript
// Request body
type Patch = {
  [space: string]: {
    assert?: {
      the: string;
      of: string;
      is: JSONValue;
      cause: Reference<Fact>;
    };
    retract?: {
      the: string;
      of: string;
      cause: Reference<Fact>;
    };
  };
};

// Response
type Response = { ok: {} } | { error: { conflict: any } };
```

**WebSocket**: Subscribe to memory updates
```typescript
// Subscribe to changes
type Watch = {
  watch: {
    [space: string]: {
      the: string;
      of: string;
    };
  };
};

// Notifications
type Notification = {
  [space: string]: Fact | Unclaimed;
};
```

### LLM API (@commontools/llm)

AI and language model integration.

#### Types

```typescript
// LLM request parameters
interface LLMRequest {
  messages: LLMMessage[];
  system?: string;
  model?: string;
  maxTokens?: number;
  stop?: string;
  stream?: boolean;
  mode?: "json";
  metadata?: Record<string, any>;
  cache?: boolean;
}

// Message format
interface LLMMessage {
  role: "user" | "assistant";
  content: string | LLMTypedContent[];
}

interface LLMTypedContent {
  type: "text" | "image";
  data: string;
}
```

#### Client Usage

```typescript
import { LLMClient } from "@commontools/llm";

const client = new LLMClient("https://api.example.com");

// Generate text
const response = await client.generateText({
  model: "claude-3-sonnet",
  messages: [{ role: "user", content: "Hello!" }]
});

// Generate structured objects
const object = await client.generateObject({
  prompt: "Generate user profile",
  schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "number" }
    }
  }
});
```

## Backend APIs

### Toolshed HTTP API

The backend provides RESTful APIs for various services.

#### Base URL
- Development: `http://localhost:8000`
- Production: `https://toolshed.commontools.dev`

#### AI Services

**GET /api/ai/llm/models**
```typescript
// Query parameters
interface GetModelsQuery {
  search?: string;
  capability?: string;
  task?: string;
}

// Response
type ModelsResponse = Record<string, {
  name: string;
  capabilities: {
    contextWindow: number;
    maxOutputTokens: number;
    streaming: boolean;
    systemPrompt: boolean;
    images: boolean;
    // ... other capabilities
  };
  aliases: string[];
}>;
```

**POST /api/ai/llm**
```typescript
// Request body: LLMRequest (see above)
// Response: LLMMessage or ReadableStream (if streaming)
```

**POST /api/ai/llm/generateObject**
```typescript
// Request body
interface GenerateObjectRequest {
  prompt: string;
  schema: JSONSchema;
  system?: string;
  cache?: boolean;
  maxTokens?: number;
  model?: string;
  metadata?: Record<string, any>;
}

// Response
interface GenerateObjectResponse {
  object: any;
  id?: string;
}
```

**POST /api/ai/llm/feedback**
```typescript
// Submit feedback on LLM responses
interface FeedbackRequest {
  span_id: string;
  name?: string;
  annotator_kind?: "HUMAN" | "LLM";
  result: {
    label?: string;
    score?: number;
    explanation?: string;
  };
  metadata?: Record<string, unknown>;
}
```

#### Other Services

The backend also provides routes for:
- Image generation (`/api/ai/img/`)
- Voice transcription (`/api/ai/voice/`)
- Web reading (`/api/ai/webreader/`)
- Spell management (`/api/ai/spell/`)
- Health checks (`/api/health/`)
- Storage operations (`/api/storage/`)
- Identity management (`/api/whoami/`)

## Frontend APIs

### UI Components (@commontools/ui)

Modern web components built with Lit Element.

#### Base Component

```typescript
import { BaseElement } from "@commontools/ui/v2/core/base-element";

export abstract class BaseElement extends LitElement {
  // Base functionality for all components
}
```

#### Button Component

```typescript
import { CTButton } from "@commontools/ui/v2/components/ct-button";

// Types
type ButtonVariant = "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
type ButtonSize = "default" | "sm" | "lg" | "icon";

// Usage in HTML
<ct-button variant="primary" size="lg">Click me</ct-button>

// Usage in TypeScript
const button = new CTButton();
button.variant = "outline";
button.size = "sm";
button.textContent = "Submit";
```

#### Form Components

```typescript
// Input
import { CTInput } from "@commontools/ui/v2/components/ct-input";
<ct-input type="text" placeholder="Enter name" value=""></ct-input>

// Textarea
import { CTTextarea } from "@commontools/ui/v2/components/ct-textarea";
<ct-textarea placeholder="Enter description" rows="4"></ct-textarea>

// Select
import { CTSelect } from "@commontools/ui/v2/components/ct-select";
<ct-select>
  <option value="1">Option 1</option>
  <option value="2">Option 2</option>
</ct-select>

// Checkbox
import { CTCheckbox } from "@commontools/ui/v2/components/ct-checkbox";
<ct-checkbox checked>Accept terms</ct-checkbox>

// Radio Group
import { CTRadioGroup, CTRadio } from "@commontools/ui/v2/components/ct-radio-group";
<ct-radio-group value="option1">
  <ct-radio value="option1">Option 1</ct-radio>
  <ct-radio value="option2">Option 2</ct-radio>
</ct-radio-group>
```

#### Layout Components

```typescript
// Stacks
import { CTVStack, CTHStack } from "@commontools/ui/v2/components";
<ct-vstack gap="4">
  <div>Item 1</div>
  <div>Item 2</div>
</ct-vstack>

// Grid
import { CTGrid } from "@commontools/ui/v2/components/ct-grid";
<ct-grid columns="3" gap="4">
  <div>Cell 1</div>
  <div>Cell 2</div>
  <div>Cell 3</div>
</ct-grid>

// Card
import { CTCard } from "@commontools/ui/v2/components/ct-card";
<ct-card>
  <h3>Card Title</h3>
  <p>Card content</p>
</ct-card>
```

#### Navigation Components

```typescript
// Tabs
import { CTTabs, CTTabList, CTTab, CTTabPanel } from "@commontools/ui/v2/components";
<ct-tabs value="tab1">
  <ct-tab-list>
    <ct-tab value="tab1">Tab 1</ct-tab>
    <ct-tab value="tab2">Tab 2</ct-tab>
  </ct-tab-list>
  <ct-tab-panel value="tab1">Content 1</ct-tab-panel>
  <ct-tab-panel value="tab2">Content 2</ct-tab-panel>
</ct-tabs>

// Accordion
import { CTAccordion, CTAccordionItem } from "@commontools/ui/v2/components";
<ct-accordion type="single">
  <ct-accordion-item value="item1">
    <h3 slot="trigger">Section 1</h3>
    <p>Content for section 1</p>
  </ct-accordion-item>
</ct-accordion>
```

#### Feedback Components

```typescript
// Alert
import { CTAlert } from "@commontools/ui/v2/components/ct-alert";
<ct-alert variant="destructive">
  <strong>Error!</strong> Something went wrong.
</ct-alert>

// Badge
import { CTBadge } from "@commontools/ui/v2/components/ct-badge";
<ct-badge variant="secondary">New</ct-badge>

// Progress
import { CTProgress } from "@commontools/ui/v2/components/ct-progress";
<ct-progress value="60" max="100"></ct-progress>

// Skeleton
import { CTSkeleton } from "@commontools/ui/v2/components/ct-skeleton";
<ct-skeleton variant="text" width="200px" height="20px"></ct-skeleton>
```

### Jumble Components

React-based frontend components for the main application.

#### Core Components

```typescript
// Composer - Main recipe editing interface
import { Composer } from "@commontools/jumble/components/Composer";
<Composer recipe={recipe} onChange={handleChange} />

// CharmRunner - Execute and display charm results
import { CharmRunner } from "@commontools/jumble/components/CharmRunner";
<CharmRunner charm={charm} onResult={handleResult} />

// NetworkInspector - Debug network requests
import { NetworkInspector } from "@commontools/jumble/components/NetworkInspector";
<NetworkInspector requests={networkRequests} />

// User - User profile and settings
import { User } from "@commontools/jumble/components/User";
<User user={currentUser} onUpdate={handleUserUpdate} />
```

#### Specialized Components

```typescript
// CharmCodeEditor - Code editing with syntax highlighting
import { CharmCodeEditor } from "@commontools/jumble/components/CharmCodeEditor";
<CharmCodeEditor 
  code={sourceCode} 
  language="typescript"
  onChange={handleCodeChange}
/>

// AudioRecorderInput - Voice input component
import { AudioRecorderInput } from "@commontools/jumble/components/AudioRecorderInput";
<AudioRecorderInput onRecording={handleAudioData} />

// FeedbackDialog - User feedback collection
import { FeedbackDialog } from "@commontools/jumble/components/FeedbackDialog";
<FeedbackDialog 
  open={showFeedback}
  onSubmit={handleFeedback}
  onClose={() => setShowFeedback(false)}
/>
```

## CLI API (@commontools/cli)

Command-line interface for Common Tools development.

### Installation

```bash
# Install the CLI
deno install --allow-net --allow-read --allow-write --allow-env -n ct packages/cli/mod.ts
```

### Commands

#### `ct init`
Initialize a new Common Tools project.

```bash
ct init [project-name]
# Creates a new project with basic structure
```

#### `ct dev`
Start development server.

```bash
ct dev [options]
# --port, -p: Port number (default: 8000)
# --host: Host address (default: localhost)
```

#### `ct charm`
Charm-related operations.

```bash
ct charm create <name>     # Create a new charm
ct charm list             # List available charms
ct charm run <charm-id>   # Run a specific charm
ct charm publish <path>   # Publish a charm
```

#### `ct id`
Identity management.

```bash
ct id create              # Create a new identity
ct id list               # List identities
ct id use <identity-id>  # Switch to an identity
```

### Configuration

The CLI uses configuration files in the project root:

```typescript
// ct.config.ts
export default {
  apiUrl: "https://toolshed.commontools.dev",
  identity: "did:key:...",
  spaces: ["default-space"],
  // ... other config options
};
```

## Utility APIs

### Environment Detection

```typescript
import { isDeno, isBrowser } from "@commontools/utils/env";

if (isDeno()) {
  // Deno-specific code
}

if (isBrowser()) {
  // Browser-specific code
}
```

### Zod Utilities

```typescript
import { toZod, UserModel, UserCreatePayload } from "@commontools/utils/zod-utils";

// Create Zod schemas from TypeScript types
const schema = toZod<UserModel>().with({
  name: z.string(),
  age: z.number()
});
```

### Event Management

```typescript
import { debounce, throttle, createEvent, EventManager } from "@commontools/ui/v2/utils/events";

// Debounce function calls
const debouncedFn = debounce((value: string) => {
  console.log(value);
}, 300);

// Throttle function calls
const throttledFn = throttle((value: string) => {
  console.log(value);
}, 100);

// Create custom events
const customEvent = createEvent("custom-event", { detail: "data" });

// Event management
const eventManager = new EventManager();
eventManager.on("event-name", handler);
eventManager.emit("event-name", data);
```

## Examples and Usage

### Basic Recipe Example

```typescript
import { recipe, cell, derive, str } from "@commontools/api";

// Define a simple greeting recipe
const greetingRecipe = recipe(
  {
    type: "object",
    properties: {
      name: { type: "string" },
      title: { type: "string", default: "Mr." }
    },
    required: ["name"]
  },
  (input) => {
    const greeting = str`Hello, ${input.title} ${input.name}!`;
    const length = derive(greeting, (text) => text.length);
    
    return {
      message: greeting,
      messageLength: length,
      isLong: derive(length, (len) => len > 20)
    };
  }
);
```

### Runtime Usage Example

```typescript
import { Runtime } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Identity } from "@commontools/identity";

// Set up runtime
const signer = await Identity.fromPassphrase("my-passphrase");
const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({ storageManager });

// Create and use cells
const userCell = runtime.getCell("users", "user-1", {
  type: "object",
  properties: {
    name: { type: "string" },
    preferences: {
      type: "object",
      properties: { theme: { type: "string" } },
      asCell: true,
      default: { theme: "dark" }
    }
  },
  default: { name: "Alice" }
});

// Subscribe to changes
const cleanup = userCell.sink((user) => {
  console.log("User updated:", user);
});

// Update data
userCell.key("name").set("Bob");
userCell.get().preferences.set({ theme: "light" });

// Run a recipe
const resultCell = runtime.documentMap.getDoc(undefined, "result", "workspace");
const result = runtime.runner.run(greetingRecipe, { name: "Alice" }, resultCell);

await runtime.idle();
console.log("Result:", result.get());

// Cleanup
cleanup();
await runtime.dispose();
```

### UI Component Example

```typescript
import { html, css, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("my-component")
export class MyComponent extends LitElement {
  @property() name = "";
  
  static styles = css`
    :host {
      display: block;
      padding: 16px;
    }
  `;
  
  render() {
    return html`
      <ct-card>
        <ct-vstack gap="4">
          <h2>Hello, ${this.name}!</h2>
          <ct-button @click=${this.handleClick}>
            Click me
          </ct-button>
        </ct-vstack>
      </ct-card>
    `;
  }
  
  private handleClick() {
    this.dispatchEvent(new CustomEvent("button-clicked", {
      detail: { name: this.name }
    }));
  }
}
```

### HTTP API Example

```typescript
// Using the LLM API
const response = await fetch("http://localhost:8000/api/ai/llm", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "claude-3-sonnet",
    messages: [
      { role: "user", content: "What is the capital of France?" }
    ],
    stream: false
  })
});

const result = await response.json();
console.log(result.body.content);

// Using the generateObject API
const objectResponse = await fetch("http://localhost:8000/api/ai/llm/generateObject", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    prompt: "Generate a user profile",
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
        hobbies: { type: "array", items: { type: "string" } }
      },
      required: ["name", "age"]
    }
  })
});

const { object } = await objectResponse.json();
console.log("Generated user:", object);
```

---

This documentation covers the major public APIs, functions, and components in the Common Labs codebase. For more detailed information about specific components or advanced usage patterns, refer to the individual package documentation and source code.