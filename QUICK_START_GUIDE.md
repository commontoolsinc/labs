# Quick Start Guide

## Table of Contents

1. [Installation & Setup](#installation--setup)
2. [Your First Recipe](#your-first-recipe)
3. [Working with Cells](#working-with-cells)
4. [Using AI Services](#using-ai-services)
5. [Building UI Components](#building-ui-components)
6. [Storage & Persistence](#storage--persistence)
7. [CLI Tools](#cli-tools)
8. [Next Steps](#next-steps)

## Installation & Setup

### Prerequisites

- **Deno 2.0+**: [Install Deno](https://deno.land/manual/getting_started/installation)
- **Redis** (for storage): [Install Redis](https://redis.io/docs/latest/install/)
- **Git**: For cloning the repository

### Clone the Repository

```bash
git clone https://github.com/commontoolsinc/labs.git
cd labs
```

### Start the Backend (Toolshed)

```bash
cd packages/toolshed
cp .env.example .env  # Configure your environment variables
deno task dev
```

The backend will be available at `http://localhost:8000`.

### Start the Frontend (Jumble)

```bash
cd packages/jumble
deno task dev
```

The frontend will be available at `http://localhost:5173`.

### Install the CLI

```bash
deno install --allow-net --allow-read --allow-write --allow-env -n ct packages/cli/mod.ts
```

## Your First Recipe

Recipes are the core computational units in Common Labs. Let's create a simple recipe.

### 1. Create a Basic Recipe

```typescript
import { recipe, derive, str } from "@commontools/api";

// Define input schema
const inputSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "number" }
  },
  required: ["name"],
  default: { name: "World", age: 25 }
};

// Create the recipe
const greetingRecipe = recipe(inputSchema, (input) => {
  // Create reactive computations
  const greeting = str`Hello, ${input.name}!`;
  const ageGroup = derive(input.age, (age) => {
    if (age < 18) return "minor";
    if (age < 65) return "adult";
    return "senior";
  });
  
  // Return outputs
  return {
    message: greeting,
    category: ageGroup,
    isAdult: derive(input.age, (age) => age >= 18)
  };
});

export default greetingRecipe;
```

### 2. Run the Recipe

```typescript
import { Runtime } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Identity } from "@commontools/identity";

// Set up runtime
const signer = await Identity.fromPassphrase("my-passphrase");
const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({ storageManager });

// Create input data
const inputData = { name: "Alice", age: 30 };

// Create output cell
const outputCell = runtime.documentMap.getDoc(undefined, "greeting-result", "my-space");

// Run the recipe
const result = runtime.runner.run(greetingRecipe, inputData, outputCell);

// Wait for computation to complete
await runtime.idle();

// Get the result
console.log(result.get());
// Output: { message: "Hello, Alice!", category: "adult", isAdult: true }

// Clean up
await runtime.dispose();
```

## Working with Cells

Cells are reactive data containers that automatically update when their dependencies change.

### 1. Creating and Using Cells

```typescript
import { Runtime } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Identity } from "@commontools/identity";

// Set up runtime
const signer = await Identity.fromPassphrase("my-passphrase");
const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({ storageManager });

// Create a cell with schema
const userCell = runtime.getCell("users", "user-1", {
  type: "object",
  properties: {
    name: { type: "string" },
    email: { type: "string" },
    preferences: {
      type: "object",
      properties: {
        theme: { type: "string" },
        notifications: { type: "boolean" }
      },
      asCell: true, // Make this a nested cell
      default: { theme: "dark", notifications: true }
    }
  },
  default: { name: "User", email: "user@example.com" }
});

// Get current value
console.log(userCell.get());

// Update the cell
userCell.set({
  name: "Alice",
  email: "alice@example.com"
});

// Work with nested cells
const preferencesCell = userCell.get().preferences;
preferencesCell.set({ theme: "light", notifications: false });

// Subscribe to changes
const cleanup = userCell.sink((user) => {
  console.log("User updated:", user);
});

// Update individual properties
userCell.key("name").set("Bob");

// Clean up subscription
cleanup();
await runtime.dispose();
```

### 2. Cell Relationships and Linking

```typescript
// Create related cells
const profileCell = runtime.getCell("users", { parent: userCell, id: "profile" }, {
  type: "object",
  properties: {
    bio: { type: "string" },
    avatar: { type: "string" }
  },
  default: { bio: "", avatar: "" }
});

// Cells with the same causal ID will sync automatically
const syncedUserCell = runtime.getCell("users", "user-1", userSchema);
// This cell will have the same data as userCell
```

## Using AI Services

### 1. Text Generation

```typescript
import { llm } from "@commontools/api";

// Create an LLM recipe
const chatRecipe = recipe({
  type: "object",
  properties: {
    message: { type: "string" },
    model: { type: "string", default: "claude-3-sonnet" }
  },
  required: ["message"]
}, (input) => {
  return {
    response: llm({
      model: input.model,
      messages: [{ role: "user", content: input.message }],
      system: "You are a helpful assistant."
    })
  };
});

// Use the recipe
const chatResult = runtime.runner.run(
  chatRecipe, 
  { message: "What is the capital of France?" },
  outputCell
);

await runtime.idle();
console.log(chatResult.get().response.get());
```

### 2. Structured Object Generation

```typescript
import { generateObject } from "@commontools/api";

const dataGenRecipe = recipe({
  type: "object",
  properties: {
    prompt: { type: "string" }
  },
  required: ["prompt"]
}, (input) => {
  return {
    userData: generateObject({
      prompt: input.prompt,
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
  };
});

// Generate structured data
const dataResult = runtime.runner.run(
  dataGenRecipe,
  { prompt: "Generate a profile for a software developer" },
  outputCell
);

await runtime.idle();
console.log(dataResult.get().userData.get());
```

### 3. Direct HTTP API Usage

```typescript
// Direct API call without recipes
const response = await fetch("http://localhost:8000/api/ai/llm", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "claude-3-sonnet",
    messages: [{ role: "user", content: "Hello!" }]
  })
});

const result = await response.json();
console.log(result.body.content);
```

## Building UI Components

### 1. Using Existing UI Components

```html
<!DOCTYPE html>
<html>
<head>
  <script type="module">
    import "@commontools/ui/v2/components/ct-button";
    import "@commontools/ui/v2/components/ct-input";
    import "@commontools/ui/v2/components/ct-card";
    import "@commontools/ui/v2/components/ct-vstack";
  </script>
</head>
<body>
  <ct-card>
    <ct-vstack gap="4">
      <h2>User Form</h2>
      <ct-input id="nameInput" placeholder="Enter your name"></ct-input>
      <ct-input id="emailInput" type="email" placeholder="Enter your email"></ct-input>
      <ct-button id="submitBtn">Submit</ct-button>
    </ct-vstack>
  </ct-card>

  <script>
    document.getElementById('submitBtn').addEventListener('click', () => {
      const name = document.getElementById('nameInput').value;
      const email = document.getElementById('emailInput').value;
      console.log('Form data:', { name, email });
    });
  </script>
</body>
</html>
```

### 2. Creating Custom Components

```typescript
import { BaseElement } from "@commontools/ui/v2/core/base-element";
import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("user-profile")
export class UserProfile extends BaseElement {
  @property() name = "";
  @property() email = "";
  @property({ type: Boolean }) editable = false;

  static styles = css`
    :host {
      display: block;
      padding: 1rem;
      border: 1px solid var(--border-color);
      border-radius: 0.5rem;
    }
  `;

  render() {
    return html`
      <ct-vstack gap="3">
        <h3>User Profile</h3>
        
        ${this.editable ? html`
          <ct-input 
            .value=${this.name} 
            @input=${this.handleNameChange}
            placeholder="Name"
          ></ct-input>
          <ct-input 
            .value=${this.email} 
            @input=${this.handleEmailChange}
            type="email" 
            placeholder="Email"
          ></ct-input>
          <ct-button @click=${this.handleSave}>Save</ct-button>
        ` : html`
          <p><strong>Name:</strong> ${this.name}</p>
          <p><strong>Email:</strong> ${this.email}</p>
          <ct-button @click=${this.handleEdit}>Edit</ct-button>
        `}
      </ct-vstack>
    `;
  }

  private handleNameChange(e: Event) {
    this.name = (e.target as HTMLInputElement).value;
  }

  private handleEmailChange(e: Event) {
    this.email = (e.target as HTMLInputElement).value;
  }

  private handleEdit() {
    this.editable = true;
  }

  private handleSave() {
    this.editable = false;
    this.dispatchEvent(new CustomEvent('user-updated', {
      detail: { name: this.name, email: this.email }
    }));
  }
}
```

### 3. React Components (Jumble)

```typescript
import React, { useState } from 'react';
import { Composer } from "@commontools/jumble/components/Composer";
import { CharmRunner } from "@commontools/jumble/components/CharmRunner";

export function MyApp() {
  const [recipe, setRecipe] = useState(null);
  const [charmCell, setCharmCell] = useState(null);

  const handleRecipeChange = (newRecipe) => {
    setRecipe(newRecipe);
  };

  const handleResult = (result) => {
    console.log('Recipe result:', result);
  };

  return (
    <div className="app">
      <div className="editor-panel">
        <Composer 
          recipe={recipe}
          onChange={handleRecipeChange}
          showPreview={true}
        />
      </div>
      
      <div className="runner-panel">
        {charmCell && (
          <CharmRunner 
            charm={charmCell}
            onResult={handleResult}
            autoRun={true}
          />
        )}
      </div>
    </div>
  );
}
```

## Storage & Persistence

### 1. Memory Storage with Facts

```typescript
// Using the memory API directly
const memoryPatch = {
  "my-space": {
    assert: {
      the: "application/json",
      of: "user:123",
      is: {
        name: "Alice",
        email: "alice@example.com",
        created: new Date().toISOString()
      },
      cause: { "/": "initial-state" }
    }
  }
};

const response = await fetch("http://localhost:8000/api/storage/memory", {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(memoryPatch)
});

const result = await response.json();
console.log(result); // { ok: {} }
```

### 2. Cell Synchronization

```typescript
// Sync cells with remote storage
await runtime.storage.syncCell(userCell);

// Sync by entity ID
const syncedCell = await runtime.storage.syncCellById("my-space", "user:123");

// Wait for all sync operations
await runtime.storage.synced();
```

### 3. Real-time Updates via WebSocket

```typescript
// Subscribe to memory changes
const ws = new WebSocket('ws://localhost:8000/api/storage/memory/ws');

ws.onopen = () => {
  // Subscribe to user changes
  ws.send(JSON.stringify({
    watch: {
      "my-space": {
        the: "application/json",
        of: "user:123"
      }
    }
  }));
};

ws.onmessage = (event) => {
  const notification = JSON.parse(event.data);
  console.log('Memory update:', notification);
};
```

## CLI Tools

### 1. Initialize a New Project

```bash
ct init my-project
cd my-project
```

### 2. Development Server

```bash
ct dev --port 3000
```

### 3. Identity Management

```bash
# Create a new identity
ct id create

# List identities
ct id list

# Use a specific identity
ct id use did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi
```

### 4. Charm Operations

```bash
# Create a new charm
ct charm create my-charm

# List available charms
ct charm list

# Run a charm
ct charm run charm-id-123

# Publish a charm
ct charm publish ./my-charm
```

## Next Steps

### 1. Explore Advanced Features

- **Complex Recipes**: Learn about recipe composition and advanced patterns
- **Custom Modules**: Create reusable computational modules
- **Advanced Storage**: Work with complex data relationships and queries
- **Security**: Implement proper authentication and authorization

### 2. Build Real Applications

- **Todo App**: Build a reactive todo application with persistence
- **Chat Interface**: Create an AI-powered chat application
- **Data Dashboard**: Build a real-time data visualization dashboard
- **Collaborative Editor**: Create a collaborative document editor

### 3. Contribute to the Platform

- **Submit Issues**: Report bugs or request features
- **Create Components**: Build and share UI components
- **Write Recipes**: Create and publish useful recipes
- **Improve Documentation**: Help improve the documentation

### 4. Resources

- **API Documentation**: `API_DOCUMENTATION.md`
- **Component Reference**: `COMPONENT_REFERENCE.md`
- **Backend API Reference**: `BACKEND_API_REFERENCE.md`
- **Source Code**: Explore the packages for detailed examples
- **Community**: Join discussions and get help

### 5. Common Patterns

#### Recipe with UI

```typescript
const uiRecipe = recipe(inputSchema, (input) => {
  return {
    ui: h("div", {}, [
      h("h1", {}, input.title),
      h("p", {}, input.content),
      h("button", { onclick: () => console.log("Clicked!") }, "Click me")
    ])
  };
});
```

#### Data Transformation Pipeline

```typescript
const pipelineRecipe = recipe(inputSchema, (input) => {
  const step1 = derive(input.data, (data) => data.map(item => item.value));
  const step2 = derive(step1, (values) => values.filter(v => v > 0));
  const step3 = derive(step2, (filtered) => filtered.reduce((a, b) => a + b, 0));
  
  return {
    processed: step1,
    filtered: step2,
    sum: step3
  };
});
```

#### Real-time Data Integration

```typescript
const realtimeRecipe = recipe(inputSchema, (input) => {
  const apiData = fetchData({ url: input.apiUrl });
  const processedData = derive(apiData, (response) => {
    if (response.pending) return null;
    return response.result.data.map(item => ({
      id: item.id,
      name: item.name,
      timestamp: new Date(item.created_at)
    }));
  });
  
  return {
    loading: derive(apiData, (response) => response.pending),
    data: processedData,
    error: derive(apiData, (response) => response.error)
  };
});
```

---

This quick start guide provides a foundation for working with Common Labs. As you become more familiar with the platform, explore the detailed API documentation and component references for advanced usage patterns and best practices.