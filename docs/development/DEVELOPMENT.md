<!-- @reviewed 2025-12-10 docs-rationalization -->

# Development Guide

This guide covers coding standards, design principles, and build/test workflows for Common Fabric development.

## Style & Conventions

### Formatting

- Line width is **80 characters**.
- Indent with **2 spaces**.
- **Semicolons are required.**
- Use **double quotes** for strings.
- Always run `deno fmt` before committing.

### Imports

- Group imports by source: standard library, external, then internal.
- Prefer named exports over default exports.
- Use package names for internal imports.
- Destructure when importing multiple names from the same module.
- Import either from `@commonfabric/api` (internal API) or
  `@commonfabric/api/interface` (external API), but not both.

## Code Design & Principles

### Error Handling

- Write descriptive error messages.
- Propagate errors using async/await.
- Document possible errors in JSDoc.

### TypeScript

- Export types explicitly using `export type { ... }`.
- Provide descriptive JSDoc comments on public interfaces.
- Prefer strong typing with interfaces or types instead of `any`.
- Update package-level README.md files.

### Async only when you await

The `require-await` lint flags any `async` function whose body has no `await`,
`for await`, or `await using`. The fix is almost always to make the function
synchronous, not to keep it asynchronous:

- Remove the `async` keyword and drop the `Promise<...>` from the return type.
- Update callers to invoke it directly and delete the now-redundant `await`.

> **❌ Avoid**

- Reaching for `.then()`, `Promise.resolve()`, or `new Promise(...)` to keep the
  `Promise` return type only so the lint passes. That dresses a synchronous
  operation up as an asynchronous one, which forces every caller to keep
  awaiting it for no reason.

> **✅ Prefer**

- A synchronous signature when the work is synchronous. Add `async` back only
  when you introduce a real `await`.

Keep `async` and suppress the lint with `// deno-lint-ignore require-await` only
when the asynchronous signature is fixed by a contract the body does not yet
exercise. An interface method whose other implementations await, or an
overridable hook that callers already await, are the usual cases. Write that
reason in a comment next to the suppression.

### Keep the Module Graph clean

We execute our JavaScript modules in many different environments:

- Browsers (Vite built)
- Browsers (deno-web-test>esbuild Built)
- Browsers (eval'd patterns)
- Deno (scripts and servers)
- Deno (eval'd patterns)
- Deno Workers
- Deno workers (eval'd patterns)

> **❌ Avoid**

- Modules depending on each other
- Large quantity of module exports
- Adding module-specific dependencies to workspace deno.jsonc
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
// Shown inside a pattern body.
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
// Shown at module scope.
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
// Shown at module scope.
enum Model {
  Default = "default model",
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
// Shown for illustration only.
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
    console.error("There was an error", e);
  }
}
```

> **✅ Prefer**

In this case, we expect `getData()` to throw, or always return a `string`. Less
handling here, and let the caller determine what to do on failure.

```ts
// Shown for illustration only.
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
// Shown at module scope.
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
export type Cache = Map<string, string>;
export const get = (cache: Cache, key: string): string | undefined =>
  cache.get(key);
export const set = (cache: Cache, key: string, value: string) =>
  cache.set(key, value);
```

## Build & Test

### Environment Setup

#### Installing Deno

If Deno is not installed, install it using the official installer:

```bash
curl -fsSL https://deno.land/install.sh | sh
```

This installs Deno to `~/.deno/bin/deno`. Add it to your PATH:

```bash
export PATH="$HOME/.deno/bin:$PATH"
```

For persistent configuration, add this to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.).

#### SSL Certificate Issues

In some CI/test environments, you may encounter SSL certificate errors when Deno downloads npm packages:

```
error: Failed caching npm package: invalid peer certificate: UnknownIssuer
```

This occurs when the system's CA (Certificate Authority) certificate bundle is missing or outdated. Install/update CA certificates on your system:

```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y ca-certificates

# Alpine Linux (common in Docker containers)
apk add --no-cache ca-certificates

# Update certificate store
sudo update-ca-certificates
```

### The TypeScript compiler dependency

The runtime compiles patterns itself, using the TypeScript compiler API at
runtime. Eight packages (`js-compiler`, `ts-transformers`, `schema-generator`,
`runner`, `cli`, `static`, `test-support`, `deno-web-test`) import
`npm:typescript` and pin the same version in their `deno.jsonc` import maps.
This npm dependency is separate from the TypeScript that `deno check` uses:
Deno bundles its own copy of the compiler. Keeping the npm pin on the same
minor version as the Deno-bundled compiler (`deno --version` prints it) avoids
the two disagreeing about what type-checks.

To roll the version, update every pin and the lockfile in one step, then verify:

```bash
deno outdated --update --recursive typescript@<version>
deno task check
deno task test
(cd packages/static && deno task check-cfc-types)
```

The last of those is a CI gate that `deno task test` does not cover; see the
note on `cfc.ts` below.

#### Why the pin stops at 6.x

The `typescript` npm package now serves two different compilers. The 6.x line is
the original JavaScript implementation, developed in `microsoft/TypeScript`. The
7.x line is the Go rewrite, developed in `microsoft/typescript-go` and intended
to replace the JavaScript one rather than sit alongside it permanently; upstream
expects to merge that repository back into `microsoft/TypeScript` in time.

Only the 6.x line works here. The 7.x package ships platform binaries, and its
main entry point exports nothing but a version constant, so the in-process
compiler API that our packages are built on is absent. The replacement drives
the native binary from a separate process, and upstream currently marks that API
"not ready", meaning not yet worth building against. So this is not a port we
could choose to do early: until that API is ready there is nothing to port onto.
Treat 6.x as a holding position, and treat the Go compiler's API reaching a
usable state as the signal to re-evaluate.

The practical trap is that a bare `npm:typescript` specifier resolves to the
newest version on npm, which is now the Go line — hence the explicit 6.x pins.

#### The vendored type libraries

Pattern compilation runs outside Node and cannot read the compiler's type
libraries off disk, so it uses ambient libraries vendored in
`packages/static/assets/types`. The two have different provenance:
`es2023.d.ts` is flattened from the `lib` directory of a TypeScript source
checkout by `packages/static/scripts/compile-type-lib.ts`, while `dom.d.ts` is
a hand-maintained subset of the web APIs the runtime actually provides.

A compiler roll does not regenerate either one. They declare the API surface
patterns are allowed to use, which is a product decision rather than a
compiler-version one, and the compiler type-checks against whatever ambient
declarations it is handed. The `js-compiler` tests exercise the rolled compiler
against these files.

The third file in that directory, `cfc.ts`, is different: it comes out of the
compiler's declaration emit, via `packages/static/scripts/generate-cfc-types.ts`.
A roll can therefore change it, which is why `check-cfc-types` is part of the
sequence above. It reports whether the committed file still matches what the new
compiler emits. If it does not, regenerate with `deno task gen-cfc-types` and
commit the result.

### Running Tests

> **Note:** CI enforces that `main` always type-checks and all tests pass, so
> you don't need to verify the baseline against a clean tree before testing your
> changes.

- For CI wall-time optimization, follow
  [CI Performance Policy](CI_PERFORMANCE.md). Do not keep splitting jobs once
  the required test jobs are already in the same rough timing band.
- Check typings with `deno task check`.
- Run linter with `deno lint`.
- Run all tests using `deno task test` (NOT `deno test`)
- To run a single test file use `deno test path/to/test.ts`.
- To test a specific package, `cd` into the package directory and run
  `deno task test`.

### Adding New Workspace Packages

Every workspace package must be registered and configured correctly, or the test
suite will break.

1. **Register the package.** Add its path (e.g., `./packages/my-package`) to the
   `"workspace"` array in the root `deno.jsonc`.

2. **Include a test task.** The package's `deno.jsonc` **must** have a `"tasks"`
   object with a `"test"` entry. The root test runner (`tasks/test.ts`) iterates
   all workspace members and runs `deno task test` in each package directory. If
   a package lacks a test task, Deno resolves the task name against the root
   workspace instead, which re-runs the entire test suite recursively. This
   causes exponential process spawning and will time out CI.

   Use `"deno test"` for packages with tests, or `"echo 'No tests defined.'"` as
   a stub for packages that don't have tests yet.

3. **Minimal `deno.jsonc` example:**

   ```json
   {
     "name": "@commonfabric/my-package",
     "exports": { ".": "./mod.ts" },
     "tasks": { "test": "deno test" }
   }
   ```

See `packages/utils` and `packages/leb128` for real examples.

### Running Integration Tests

Integration tests require running servers. Use the repo-level integration
runner:

```bash
# Run all integration tests (auto-starts servers, cleans up after)
deno task integration

# Run integration tests for a specific package
deno task integration cli
deno task integration patterns
deno task integration shell

# Filter tests by name within a package
deno task integration patterns counter
```

**How it works:**

- Generates a random `PORT_OFFSET` (100-1000) to avoid port conflicts
- Starts local dev servers on offset ports (Toolshed: 8000+offset, Shell:
  5173+offset)
- Runs integration tests with `API_URL` pointing to the local server
- **Automatically stops servers after tests complete**

**Available packages:** `runner`, `runtime-client`, `shell`,
`background-piece-service`, `patterns`, `cli`, `generated-patterns`

**Log files:** After servers start, check these if something goes wrong:

- `packages/shell/local-dev-shell.log`
- `packages/toolshed/local-dev-toolshed.log`

**Advanced usage with --port-offset:**

Use `--port-offset=N` to specify a port offset. When set, servers are left
running after tests complete:

```bash
# Use port offset 500 (Toolshed on 8500, Shell on 5673)
deno task integration --port-offset=500

# Combine with package filter
deno task integration --port-offset=500 cli
```

This is useful when you want to inspect the servers or manually test after the
integration tests finish.
