# Planning Server

A simple `deno` server that exposes an API to interact with LLMs.

It supports tool calling collaboratively between the client and server, with the client providing a set of tools to the server in addition to the server's inbuilt toolkit.

This enables AI collaboration via standard function calls in the frontend application.

## Start

`npm run start`

## Configure `.env`

Create a `.env` file in the root of the project (copying `.env.local`) and substitute the values with your own.

## Memory Cache

The server retains a lookup of all threads since startup _and_ will cache responses for identical system + message pairs it encounters. **This is not fit for deployment.**

## Create Client

```ts
import { LLMClient } from "@commontools/llm-client";
const client = new LLMClient({
  serverUrl: "http://localhost:8000", // Assumes default port
  tools: [ // These are the tools the _client_ is making available to the server
    {
      name: "calculator",
      input_schema: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description: "A mathematical expression to evaluate"
          }
        },
        required: ["expression"]
      },
      implementation: async ({ expression }) => {
        return `${await eval(expression)}`;
      }
    }
  ],
  system: "use your tools to answer the request"
});
```

## Create a Thread

```ts

const thread = await client.createThread("what is 2+2*3?");

console.log(thread.conversation[1]);
// Tool called: calculator (2+2*3)
// Tool result: 8
// Assistant: The answer is 8
```

## Append to Thread

```ts
const thread = await client.createThread("can you exaggerate this: I am having a _day_");

await client.continueThread(thread.id, "I am having a _great_ day");
```
