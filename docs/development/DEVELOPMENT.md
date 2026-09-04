<!-- @reviewed 2025-12-10 docs-rationalization -->

# Development Guide

This guide covers coding standards, design principles, and build/test workflows
for Common Fabric development.

Dependency declarations, version rolls, and dependency troubleshooting are
covered in [Dependencies](DEPENDENCIES.md).

The other development documents — testing, debugging, configuration,
continuous integration, and the rest — are indexed in
[the development README](README.md). Documents about a single feature, or
about one aspect of the runtime, are indexed in
[the features README](../features/README.md).

## Style & Conventions

### Formatting

- Line width is **80 characters**.
- Indent with **2 spaces**.
- **Semicolons are required.**
- Use **double quotes** for strings.
- Always run `deno fmt` before committing.

### Imports

- Group imports by source: standard library, external, then internal, with a
  blank line between the groups.
- Prefer named exports over default exports.
- Use package names to import from another package.
- Use relative paths to import from within your own package. A file that names
  the package it belongs to reaches a file of that same package the long way
  round, through the `exports` map and back, so one module ends up with two
  spellings. Naming the bare package name is worse than that. The entry point
  reaches every module the package exports, so naming it from inside completes
  a cycle, and the order in which the package's modules initialize starts to
  depend on the order the entry point lists its exports. The
  `cf-package/no-self-import` lint rule (`tasks/lint-self-import.ts`,
  registered in the root `deno.jsonc`) reports both forms, so a plain
  `deno lint` catches them. It exempts a package's own tests, which name their
  package on purpose: the surface a consumer sees is the thing they are there
  to check.
- Destructure when importing multiple names from the same module.
- Import either from `@commonfabric/api` (internal API) or
  `@commonfabric/api/interface` (external API), but not both.
- Collate a package's imports. Every specifier naming the same top-level
  package, or the same namespace-and-package pair, sits in one contiguous run:
  `@commonfabric/utils/base64url` next to `@commonfabric/utils/types`,
  `@std/testing/bdd` next to `@std/testing/time`. A package that appears in two
  places in the list reads as two dependencies, and the second appearance hides
  from anyone scanning for what the file rests on.
- Alpha-sorting each run is strongly suggested. Sorting is what makes a list
  scannable rather than merely grouped, and it answers by rule the question of
  where a new import goes. Sort on the specifier, comparing without regard to
  case, so that `codec-type-tags.ts` precedes `NullLiveEnvironment.ts`
  the way a reader expects. Where sorting and the grouping above disagree, the
  grouping wins: sort within the standard-library, external, and internal
  blocks, not across them.
- A bare `import "x";` is there for its side effect, so where it sits is part of
  what it does. A polyfill, or a setup module that installs globals, running
  after the code relying on it has already run is a different program, and
  nothing type-checks that. So grouping, collation and sorting all yield to this
  one: leave a bare import where it is, and move no other import across it. They
  then apply to each run of imports between bare ones rather than to the file as
  a whole — a file with a bare import in the middle has two groupings, two
  collations and two sorts, and a checker that reads it as one will call correct
  code wrong. A bare import of a module the file also imports by name is a
  separate matter, and which way it goes turns on the kind of that named import.
  Against a value import the bare one adds nothing, since the value import
  evaluates the module, side effects included: drop it, and put what it was
  there for in a comment on the surviving statement. Against nothing but an
  `import type`, it stays — a type-only import is erased and evaluates nothing,
  so the bare import is the only thing producing the effect.
- Import a given module in exactly one or two statements. Two shapes are
  allowed:
  - One unified statement, marking any type-only names inline:
    `import { type Foo, bar } from "x";`.
  - One statement of each kind, kept adjacent:
    `import type { Foo } from "x";` above `import { bar } from "x";`.

  A file uses whichever reads better; neither is preferred. What neither shape
  allows is a second statement of the same kind — two value imports from one
  module, or two `import type`s from it. Those represent one dependency as
  though it were two, and the second is easy to miss when the first is being
  edited or removed, so merge their specifier lists. A bare `import "x";` counts
  toward the total.
- Within a package that defines the `@/` import alias, address the aliased tree
  as `@/...` rather than by a `../` path that climbs out of the current
  directory to reach it. The alias exists so that a module's address does not
  depend on where the importing file sits, and a `../` path spends that. The
  rule is about `../` and nothing else: a `./` path addresses the importing
  file's own directory or something under it, and so never states how two
  directories sit relative to each other. `./` and `@/` are both fine, and a
  file may use each where it reads better. A `../` path whose target lies
  outside the aliased tree has no `@/` form at all, and stays as it is — a
  `bench/` or `test/` file reaching a fixture in its own tree, in a package
  whose alias covers `src/`.
- These rules govern the declaration list. What may not be written outside it
  at all — a type spelled `import("./mod.ts").Thing`, and a module loaded by an
  `import("./mod.ts")` expression under some function — is
  [`imports.md`](imports.md), which two lint rules enforce.

### Classes

- Use JavaScript `#privateName` fields and methods rather than TypeScript's
  `private` modifier. `protected` has no such counterpart, and stays a
  TypeScript modifier.
- A class exposes no enumerable properties, instance or static. Hold the
  value in a `#privateName` field and expose a getter, and a setter when the
  value is meant to be settable. This holds for a constructor parameter
  property too, which is a field declaration in disguise. Depart from it only
  for a strong and compelling reason. A module-internal class — one its module
  does not export, whose instances therefore never reach a stranger — is
  exempt: the confusion the rule prevents is between an instance and a plain
  object, and there is no one there to be confused. Two things follow from
  it:
  - An instance stops looking like a plain object. Enumerating one, spreading
    it, or serializing it yields nothing, so code that mistakes an instance
    for data fails where it stands instead of quietly half-working. A `#`
    field is not an own property at all, whereas a field declared `private` or
    `protected` is: those modifiers are erased, and the property they describe
    is as enumerable as any other.
  - A whole class of bug becomes unreachable rather than merely discouraged. A
    `readonly` field is only a compile-time promise, so a cast can strip it and
    write through; a getter with no setter refuses the write at runtime.
- The default order of items within a class is:
  1. The exposed instance properties, which an exempt class is the only kind
     to have, ordered from least to most protection: public, then protected.
     A constructor parameter property is not one of these; it stays in the
     constructor.
  2. Private instance variables.
  3. The constructor.
  4. The abstract members, public and protected alike.
  5. The remaining instance members, ordered from most to least access: public,
     then protected, then private. Getters and setters come before methods.
  6. The exposed static properties, ordered as the exposed instance properties
     are.
  7. Private static variables.
  8. The remaining static members, ordered as the instance members are.
- Three of those groups take a
  [section marker](code-comment-style.md#section-markers), when the class has
  meaningful sections to delineate or is large enough for one to earn its
  keep: `Subclass contract` ahead of the abstract members, `Instance members`
  ahead of the remaining instance members, and `Static members` ahead of the
  exposed static properties.
- Depart from that order when there is a compelling reason to, not by default.

A class with every group filled, in order:

```ts
// Shown at module scope.

/**
 * Fryer of donuts. Being module-internal is what lets this one expose
 * properties directly; an exported class holds them in `#` fields behind
 * accessors.
 */
abstract class Fryer {
  /** How many batches have been fried. */
  batches = 0;

  /** Oil temperature, which subclasses consult. */
  protected temperature = 190;

  #basket: string[];

  /** Constructs an instance which fries the contents of `basket`. */
  constructor(basket: string[]) {
    this.#basket = basket;
  }

  //
  // Subclass contract
  //

  /** Fries one item, however this fryer does it. */
  abstract fry(item: string): string;

  /** Drains the oil, however this fryer does it. */
  protected abstract drain(): void;

  //
  // Instance members
  //

  /** What is waiting to be fried. */
  get basket(): readonly string[] {
    return this.#basket;
  }

  /** Fries everything waiting, and empties the basket. */
  fryAll(): string[] {
    const result = this.#basket.map((item) => this.fry(item));
    this.#empty();
    this.batches++;
    return result;
  }

  /** Reports the oil temperature, for a subclass's diagnostics. */
  protected report(): string {
    return `${this.temperature}C`;
  }

  /** Helper for `fryAll()`, which drains the oil and clears the basket. */
  #empty(): void {
    this.drain();
    this.#basket = [];
  }

  //
  // Static members
  //

  /** Temperature a fryer runs at unless told otherwise. */
  static defaultTemperature = 190;

  static #built = 0;

  /** How many fryers have been built. */
  static get built(): number {
    return Fryer.#built;
  }
}
```

#### Making a private member reachable from a test

A test sometimes needs what a class keeps to itself: a threshold to straddle,
a table to seed, a step to run on its own. Casting the instance to get at it —
`as unknown as { ... }`, `as never as { ... }`, `as any` — is not the way, and
the `#` convention takes it off the table: a `#` name is out of a cast's reach,
and a member left TypeScript-`private` so that a cast can find it is an own
enumerable property with a comment apologizing for it. The cast also types the
member however the test finds convenient, so nothing checks that what the test
reads is what the class holds, and a renamed member leaves the test reading
`undefined` and passing.

The way is one public getter named `accessForTestingOnly`, which hands over
exactly what a test needs and nothing else. The name is the documentation:
everything behind it is internals free to change, and a reader who sees it in
a test knows the test is written against them. Its doc comment says what it
exposes, and the name says the rest.

- Instance members go behind an instance getter; static members behind a
  static one. A class may have both.
- The getter's return type is written inline on the getter, and the body is an
  object literal. Nothing else is exported, so the class's public surface grows
  by one member.
- A field the class never reassigns — a `Map` it mutates in place — is handed
  over as a plain property holding the reference. A field the class reassigns
  is a getter, so that a read is live, and gains a setter only when a test
  assigns it. A method is an arrow forwarding to the `#` method. An
  object-literal getter cannot see the class's `this`, so an accessor with one
  takes `const outerThis = this;` under `// deno-lint-ignore no-this-alias`;
  an accessor of plain properties and arrows needs no alias.
- Each entry is typed as the class types the member. A stand-in the test
  supplies then declares itself where it is passed in — an `as` on the
  argument, or one small helper taking a `Partial<T>` — rather than on the
  receiver, and a value the test reads back is what the class holds.
- It is a public getter, so it sits where the order above puts public getters,
  and first among them.
- Prose names the member `Class.#member`.

```ts
// Shown at module scope.

/** A fryer whose oil temperature a test has to set and whose log it reads. */
export class Fryer {
  #temperature = 190;
  #log = new Map<string, number>();

  /**
   * The oil temperature, the batch log, and the drain step, which a test
   * drives directly.
   */
  get accessForTestingOnly(): {
    temperature: number;
    log: Map<string, number>;
    drain(): void;
  } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      get temperature() {
        return outerThis.#temperature;
      },
      set temperature(value) {
        outerThis.#temperature = value;
      },
      log: this.#log,
      drain: () => this.#drain(),
    };
  }

  /** Fries one item at the current temperature. */
  fry(item: string): void {
    this.#log.set(item, this.#temperature);
  }

  #drain(): void {
    this.#temperature = 20;
  }
}

// In a test:
const fryer = new Fryer();
fryer.accessForTestingOnly.temperature = 200;
fryer.fry("cruller");
fryer.accessForTestingOnly.drain();
```

Three things a test reaches for that the getter does not cover, each wanting a
different answer:

- **A method the test replaces by assignment** — `obj.step = fake; ...;
  obj.step = original`. A `#` method cannot be reassigned, and the getter only
  forwards, so the test is asking for a seam the class does not offer. Offer
  one — a collaborator passed to the constructor, a hook the class calls — or
  rewrite the test against public behavior. Until then the member stays
  TypeScript-`private`, with a comment naming the test that replaces it.
- **A method called off the prototype against a stand-in receiver** —
  `Class.prototype.step.call(fake, ...)`. A `#` member throws on any receiver
  that is not a real instance, so the test wants rewriting to build one.
- **A helper that uses no instance state.** Make it `static #` behind the
  static getter, or a module-level function the test imports.

### Comments

- Comments explain **why**, not what, and describe the system as it stands.
- Every export, every class and public member, and every non-trivial internal
  function carries a JSDoc doc comment.
- [`code-comment-style.md`](code-comment-style.md) is the guide to both kinds,
  and to the Markdown markup that comments, error messages, and log messages
  all use.

### Word choice

Prose written in this repository — comments, documents, error and log messages,
test descriptions — standardizes on one spelling per word and one word per
concept. Both halves buy the same thing: a search for a word finds all of it,
and two files stating the same kind of fact read as though they do.

The rule is forward-looking. New prose follows it, an edit conforms the prose it
touches, and converting a whole file or package is its own change rather than a
side effect of another one.

#### Spelling

American spellings: `behavior`, `color`, `center`, `serialize`, `analyze`,
`gray`. This is standardization rather than a claim about which English is
better, and it is the variety already in overwhelming use in these files.

Two carve-outs. Material quoted from outside — a dependency's name, a message
relayed from another system, a specification's wording, a data file's contents —
keeps whatever spelling it arrived with. And an identifier vocabulary already
established in the codebase, `cancelled` among them, is a rename rather than a
spelling fix: match the surrounding code, and treat a change to it as the code
change it is.

#### One word per concept

Where two words would do, this repository picks one. The list grows as the pairs
come up.

- **`returns`**, not `answers`, for what a call evaluates to. A call is not a
  question put to the code, and the metaphor stands in for a word that is
  already exact and already shorter.
  [`unit-test-coding-style.md`](unit-test-coding-style.md#writing-the-description-strings)
  states this for an `it()` description, which is where it comes up most often;
  it holds everywhere else too.
- **`represents`**, `denotes`, or `is written as` — not `spells` — for the
  relation between a construct and what it means. A path fragment denotes a ref
  that cannot resolve, and a non-positive bound means "don't wait". The verb
  belongs to orthography, and borrowing it dresses a semantic relation in
  orthographic clothes. Three uses survive: the noun names a surface form ("the
  same spelling the root span uses"), the verb is exact when the claim is about
  the form itself ("the string that spells the number"), and "spell out" is
  ordinary English for writing something at length. `spell` is additionally an
  identifier here — the retired name for a pattern, still read by the state
  inspector — so prose that borrows the word costs a search as well.
- **`visits`**, `reads`, `encounters`, `finds` — the list is open — not `meets`,
  for coming across something during a walk or on a channel. It is the word that
  is wrong here and not the sense, so pick what the site wants rather than one
  substitute throughout: a walk visits every node it descends through, a decoder
  reads what arrives, a format carrying no marker encounters data it never emits.
  Often the cleanest sentence names where the thing arrived and wants no such
  verb at all — "a cycle *here* arrived from a channel". What rules `meets` out
  is that two other senses are already at work in these files, and both stay.
  `meet` a requirement — `meet the condition`, `must meet the threshold` — is
  ordinary and exact, with the caveat that the verb takes the requirement itself
  as its object and not the artifact stating one: a value **satisfies** a schema,
  or meets the schema's *requirements*, where "meets the schema" reaches past
  what the verb selects for. And `meet` is the lattice operation the Contextual
  Flow Control code is built on, a technical term with test files named after it,
  where a stray prose use costs a search.

## Code Design & Principles

### Error Handling

- Write descriptive error messages, marked up as
  [`code-comment-style.md`](code-comment-style.md#error-and-log-messages)
  describes.
- Propagate errors using async/await.
- Document possible errors in JSDoc.

### TypeScript

- Export types explicitly using `export type { ... }`.
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

For import-map placement and dependency boundaries, follow
[Adding dependencies](DEPENDENCIES.md#adding-dependencies).

> **❌ Avoid**

- Modules depending on each other
- Large quantity of module exports
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
  #inner: any;
  constructor(inner: any) {
    this.#inner = inner;
  }
  process() {
    // if (typeof this.#inner === "object")
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
  #map: Map<string, string> = new Map();
  get(key: string): string | undefined {
    return this.#map.get(key);
  }
  set(key: string, value: string) {
    this.#map.set(key, value);
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
   workspace instead, which would re-run the entire test suite recursively,
   spawning processes exponentially. The runner reads every member's manifest
   before it runs any of their test tasks, and refuses to start when one has no
   `"test"` entry, naming the member; that check is what keeps a missing entry
   to a message rather than a CI timeout.

   Use `"deno test"` for packages with tests, or `"echo 'No tests defined.'"` as
   a stub for packages that don't have tests yet. A `"test"` task defined by its
   `"dependencies"` alone counts too: what the check asks is whether the name
   resolves in the package's own directory.

3. **Minimal `deno.jsonc` example:**

   ```json
   {
     "name": "@commonfabric/my-package",
     "exports": { ".": "./mod.ts" },
     "tasks": { "test": "deno test" }
   }
   ```

See `packages/utils` and `packages/leb128` for real examples.
If the new package needs registry dependencies, follow
[Adding dependencies](DEPENDENCIES.md#adding-dependencies).

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
