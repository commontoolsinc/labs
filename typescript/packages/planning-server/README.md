# planning-server

`planning-server` is an HTTP service with an API for calling many LLMs.

## Available models

We currently support a variety of LLM providers; including anthropic, groq, openai, and google. Below is a list of all of the available models.

NOTE: This list is bound to be stale, to find the latest-and-greatest list of available models, check out the `models.ts` file.

```
anthropic:claude-3-5-haiku-20241022
anthropic:claude-3-5-sonnet-20241022
anthropic:claude-3-opus-20240229

groq:llama-3.1-70b-versatile
groq:llama-3.1-8b-instant
groq:llama-3.2-11b-vision-preview
groq:llama-3.2-90b-vision-preview
groq:llama-3.2-3b-preview

openai:gpt-4o-2024-08-06
openai:gpt-4o-mini-2024-07-18
openai:o1-preview-2024-09-12
openai:o1-mini-2024-09-12

google:gemini-1.5-flash-002
google:gemini-1.5-pro-002
```

## Configure `.env`

To configure `planning-server` to use various providers, you'll need to setup some environment variables. To get started, run following command, then fill in the blanks in `.env`

```bash
cp .env.local .env
```

If you plan to use google, you'll need to first fetch a default application credentials bundle. You can do that by running the following.

```bash
gcloud auth application-default login
```

## Run the server

```bash
npm run start
```

## Testing language models

To run a quick battery of tests on all configured live LLMs, use the `livetest.ts` cli script.

```bash
# Run tests against ALL configured models
npm run livetest

or

npm run livetest:all
```

Run tests against all models from a specific provider, run one of the following

```bash
npm run livetest:anthropic
npm run livetest:openai
npm run livetest:google
npm run livetest:groq
```

To get a list of all available models, run

```bash
deno run --allow-env --allow-read --allow-net  ./src/livetest.ts
```

Finally, you can test a remote `planning-server` endpoint by overriding the URL with the `PLANNING_SERVER_BASE_URL` environment variable.

For example

```bash
PLANNING_API_URL="https://paas.saga-castor.ts.net/planning-service" npm run livetest:anthropic
```

## Searching available models

To list the available models for a given `planning-server` instance, you can simply `GET /models` for a list of all supported models and their capabilities.

```bash
curl http://localhost:8000/models
```

returns an object like

```json
{
  "anthropic:claude-3-5-haiku-20241022": {
    "capabilities": {
      "contextWindow": 200000,
      "maxOutputTokens": 8192,
      "images": true,
      "prefill": true,
      "systemPrompt": true,
      "stopSequences": true,
      "streaming": true
    },
    "aliases": ["anthropic:claude-3-5-haiku-latest", "claude-3-5-haiku"]
  },
  "anthropic:claude-3-5-sonnet-20241022": {
    "capabilities": {
      "contextWindow": 200000,
      "maxOutputTokens": 8192,
      "images": true,
      "prefill": true,
      "systemPrompt": true,
      "stopSequences": true,
      "streaming": true
    },
    "aliases": ["anthropic:claude-3-5-sonnet-latest", "claude-3-5-sonnet"]
  },
  "anthropic:claude-3-opus-20240229": {
    "capabilities": {
      "contextWindow": 200000,
      "maxOutputTokens": 4096,
      "images": true,
      "prefill": true,
      "systemPrompt": true,
      "stopSequences": true,
      "streaming": true
    },
    "aliases": ["anthropic:claude-3-opus-latest", "claude-3-opus"]
  }
  ...
}
```

You can also search this endpoint by using the `search` query parameter

```bash
curl http://localhost:8000/models?search=o1-mini
```

returns

```json
{
  "openai:o1-mini-2024-09-12": {
    "capabilities": {
      "contextWindow": 128000,
      "maxOutputTokens": 65536,
      "images": false,
      "prefill": false,
      "systemPrompt": false,
      "stopSequences": false,
      "streaming": false
    },
    "aliases": ["openai:o1-mini-latest", "openai:o1-mini", "o1-mini"]
  }
}
```

This also supports searching by provider name or any part of an alias like:

```bash
curl http://localhost:8000/models?search=anthropic
curl http://localhost:8000/models?search=google
curl http://localhost:8000/models?search=openai
curl http://localhost:8000/models?search=claude
```

There is also a very primitive way of searching by capability, for example if you want to search for openai models that support the `systemPrompt` capability and streaming, you can use:

```bash
curl http://localhost:8000/models?search=groq&capability=images

or multiple capabilities.

curl http://localhost:8000/models?search=openai&capability=systemPrompt,streaming
```

## Tool calling

`planning-server` supports tool calling collaboratively between the client and server, with the client providing a set of tools to the server in addition to the server's inbuilt toolkit.

This enables AI collaboration via standard function calls in the frontend application.

See below for an example of how to do this.

```ts
import { LLMClient } from "@commontools/llm-client";
const client = new LLMClient({
  serverUrl: "http://localhost:8000", // Assumes default port
  tools: [
    // These are the tools the _client_ is making available to the server
    {
      name: "calculator",
      input_schema: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description: "A mathematical expression to evaluate",
          },
        },
        required: ["expression"],
      },
      implementation: async ({ expression }) => {
        return `${await eval(expression)}`;
      },
    },
  ],
  system: "use your tools to answer the request",
});
```

## Memory Cache

The server retains a lookup of all threads since startup _and_ will cache responses for identical system + message pairs it encounters. **This is not fit for deployment.**

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
const thread = await client.createThread(
  "can you exaggerate this: I am having a _day_",
);

await client.continueThread(thread.id, "I am having a _great_ day");
```

## Continuous Integration (CI)

This project uses GitHub Actions for continuous integration. The CI pipeline is defined in `.github/workflows/planning-server.yml` and includes the following steps:

1. **Setup**: Prepares the environment and sets up variables.
2. **Build**: Compiles the Deno entrypoint for multiple target architectures (Linux x86_64/aarch64, Windows x86_64, macOS x86_64/aarch64).
3. **Lint**: Runs `deno lint` to check for code quality issues.
4. **Format**: Verifies code formatting using `deno fmt --check`.
5. **Test**: Executes tests using `deno test` and generates a coverage report.
6. **Docker Test**: Builds and tests the Docker image locally.
7. **Docker Push**: If on the main branch or manually triggered, builds and pushes the Docker image to Docker Hub.

The CI pipeline runs on pushes to the `main` branch and on pull requests that modify files in the `typescript/packages/planning-server/` directory or the workflow file itself.

### CI Artifacts

The following artifacts are generated during the CI process:

- Compiled binaries for different architectures
- Test coverage report
- Docker image

### Docker Image

The Docker image is built using a multi-stage process and is pushed to Docker Hub with the following tags:

- `latest`
- A short commit hash (e.g., `abcdef123456`)

The image is built for both `linux/amd64` and `linux/arm64` platforms.
