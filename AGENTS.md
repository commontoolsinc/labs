# Repository Guidelines for AI Agents

The instructions in this document apply to the entire repository.

## Basics

### Build & Test

- Check typings with `deno task check`.
- Run all tests using `deno task test`.
- To run a single test file use `deno test path/to/test.ts`.
- To test a specific package, `cd` into the package directory and run
  `deno task test`.

### `ct`

Before ever calling `ct` you MUST read `.claude/commands/common/ct.md`.

### CommonTools Development

- **[Handler Patterns Guide](.claude/commands/handlers-guide.md)** - Comprehensive guide to handler usage, TypeScript patterns, and common pitfalls
- **[CT Binary Usage](.claude/commands/common/ct.md)** - CT command reference and setup

### Formatting

- Line width is **80 characters**.
- Indent with **2 spaces**.
- **Semicolons are required.**
- Use **double quotes** for strings.
- Always run `deno fmt` before committing.

### TypeScript

- Export types explicitly using `export type { ... }`.
- Provide descriptive JSDoc comments on public interfaces.
- Prefer strong typing with interfaces or types instead of `any`.
- Update package-level README.md files.

### Imports

- Group imports by source: standard library, external, then internal.
- Prefer named exports over default exports.
- Use package names for internal imports.
- Destructure when importing multiple names from the same module.
- Import either from `@commontools/api` (internal API) or
  `@commontools/api/interface` (external API), but not both.

### Error Handling

- Write descriptive error messages.
- Propagate errors using async/await.
- Document possible errors in JSDoc.

### Testing

- Structure tests with `@std/testing/bdd` (`describe`/`it`).
- Use `@std/expect` for assertions.
- Give tests descriptive names.

## Good Patterns & Practices

Not all the code fits these patterns. For bigger changes, follow these
guidelines and consider refactoring existing code towards these practices.

### Avoid Singletons

The singleton pattern may be useful when there's a single global state. But
running multiple instances, unit tests, and reflecting state from another state
becomes impossible. Additionally, this pattern is infectious, often requiring
consuming code to also only support a single instance.

> **❌ Avoid**

```ts
const cache = new Map();
export const set = (key: string, value: string) => cache.set(key, value);
export const get = (key: string): string | undefined => cache.get(key);
```

```ts
export const cache = new Map();
export const instance = new Foo();
```

> **✅ Prefer**

In both cases, we can maintain multiple caches, or instances of cache consumers.

```ts
export class Cache {
  private map: Map<string, string> = new Map();
  get(key: string): string | undefined {
    return this.map.get(key);
  }
  set(key: string, value: string) {
    this.map.set(key, value);
  }
}
```

Or with a functional pattern:

```ts
export type Cache = Map;
export const get = (cache: Cache, key: string): string | undefined =>
  cache.get(key);
export const set = (cache: Cache, key: string, value: string) =>
  cache.set(key, value);
```

### Keep the Module Graph clean

We execute our JavaScript modules in many different environments:

- Browsers (Vite built)
- Browsers (deno-web-test>esbuild Built)
- Browsers (eval'd recipes)
- Deno (scripts and servers)
- Deno (eval'd recipes)
- Deno Workers
- Deno workers (eval'd recipes)

Each frontend bundle or script has a single entry point[^1]. For frontend
bundles, it's a single JS file with every workspace/dependency module included.
For deno environments, the module graph is built dynamically. While JavaScript
can run in many environments, there's work to be done to run the same code
across all invocations. We should strive for a clear module graph for all
potential entries (e.g. each script, each bundle) for both portability,
maintanance, and performance.

[^1]: Our vite frontend has multiple "pieces" for lazy loading JSDOM/TSC, but a
    single "main".

> **❌ Avoid**

- Modules depending on each other
- Large quantity of module exports
- Adding module-specific dependencies to workspace deno.json
- Non-standard JS (env vars, vite-isms): All of our different invocation
  mechanisms/environments need to handle these

> **✅ Prefer**

- Use
  [manifest exports](https://docs.deno.com/runtime/fundamentals/workspaces/#multiple-package-entries)
  to export a different entry point for a module. Don't pull in everything if
  only e.g. types are needed.
  - If needed, environment specific exports can be provided e.g.
    `@workspace/module/browser` | `@workspace/module/deno`.
- Consider leaf nodes in the graph: A `utils` module should not be heavy with
  dependencies, external or otherwise.
- Clean separation of public and private facing interfaces: only export what's
  needed.
- Add module-specific dependencies to that module's dependencies, not the entire
  workspace. We don't need `vite` in a deno server.

### Avoid Ambiguous Types

Softly-typed JS allows quite a bit. We often accept a range of inputs, and based
on type checking, perform actions.

> **❌ Avoid**

Minimize unknown type usage. Not only does `processData` allow any type, but
it's unclear what the intended types are:

```ts
function processData(data: any) {
  if (typeof data === "object") {
    if (!data) {
      processNull(data as null);
    } else if (Array.isArray(data)) {
      processArray(data as object[]);
    } else {
      processObject(data as object);
    }
  } else {
    processPrimitive(data, typeof data);
  }
}
```

> **✅ Prefer**

Wrap an `any` type as another type for consumers. There are many TypeScript
solutions here, but in general, only at serialization boundaries (postMessage,
HTTP requests) _must_ we transform untyped values. Elsewhere, we should have
validated types.

```ts
class Data {
  private inner: any;
  constructor(inner: any) {
    this.inner = inner;
  }
  process() {
    // if (typeof this.inner === "object")
  }
}

function processData(data: Data) {
  data.process();
}
```

### Avoid representing invalid state

Similarly, permissive interfaces (including nullable properties and
non-represented exclusive states e.g. "i accept a string or array of strings")
may represent an invalid state at intermediate stages that will need be checked
at every interface:

> **❌ Avoid**

```ts
interface LLMRequest {
  prompt?: string;
  messages?: string[];
  model?: string;
}

function request(req: LLMRequest) {
  // Not only do we have to modify `req` into a valid
  // state here, `processRequest` and any other user of `LLMRequest`
  // must also handle this.

  if (!req.model) {
    req.model = "default model";
  }
  // If both prompt and messages provided,
  // use only `messages`
  if (req.prompt && req.messages) {
    req.prompt = undefined;
  }
  processRequest(req);
}

request({ prompt: "hello world" });
```

> **✅ Prefer**

For interfaces/types, not allowing unrepresented exclusive states (the prompt
input is always an array; `model` is always defined) requires more explicit
inputs, but then `LLMRequest` is always complete and valid. **Making invalid
states unrepresentable is good**.

Constructing the request could be also be a class, if we always wanted to apply
appropriate e.g. defaults.

```ts
enum Model {
  Default = "default model";
}

interface LLMRequest {
  messages: string[],
  model: Model,
}

function request(req: LLMRequest) {
  // This is already a valid LLMRequest
  processRequest(req);
}

request({ messages: ["hello world"], model: inputModel ?? Model.Default });
```

### Appropriate Error Handling

If a function may throw, it's reasonable to wrap it in a try/catch. However, in
complex codebases, handling every error is both tedious and limiting, and may be
preferable to handle errors in a single place with context. Most importantly,
throwing errors is OK, and preventing execution of invalid states is desirable.

Whether or not an error should be handled in a subprocess could be determined by
whether its a "fatal error" or not: was an assumption invalidated? are we
missing some required capability? Throw an error. Can we continue safely
processing and need to take no further action? Maybe a low-level try/catch is
appropriate. LLMs generally don't have this context and are liberal in their
try/catch usage. Avoid this.

> **❌ Avoid**

In this scenario, errors are logged different ways; if `fetch` throws, we have a
console error log. If `getData()` returns `undefined`, something unexpected
occurred, and there's nothing to be done. `run` should be considered errored and
failed.

```ts
async function getData(): Promise<string | undefined> {
  try {
    const res = await fetch(URL);
    if (res.ok) {
      return res.text();
    }
    throw new Error("Unsuccessful HTTP response");
  } catch(e) {
    console.error(e);
  }
}

async function run() {
  try {
    const data = await getData();
    if (data) {
      // ..
    }
  } catch (e) {
    console.error("There was an error": e);
  }
}
```

> **✅ Prefer**

In this case, we expect `getData()` to throw, or always return a `string`. Less
handling here, and let the caller determine what to do on failure.

```ts
async function getData(): Promise<string> {
  const res = await fetch(URL);
  if (res.ok) {
    return res.text();
  }
  throw new Error("Unsuccessful HTTP response");
}

async function run() {
  const data = await getData();
  await processStr(data);
}

async function main() {
  try {
    await run();
  } catch (e) {
    console.error(e);
  }
}
```

Sometimes a low-level try/catch is appropriate, of course:

- `getData()` could have its own try/catch to e.g. retry on failure, throwing
  after 3 failed attempts.
- Exposing a `isFeatureSupported(): boolean` function that based on if some
  other function throws, determines if "feature" is supported. If we can handle
  both scenarios and translate the error into a boolean (e.g. are all of the
  ED25519 features we need supported natively for this platform? if not use a
  polyfill), then this is not a fatal error, and we explicitly do not want to
  throw and handle it elsewhere.
