# Chapter 6 — The Development Workflow

You now know the language; this chapter is the toolchain. The loop is:
**sketch → check → deploy → drive → test**, all through the `cf` CLI
(run as `deno task cf ...` from the repo root). Keep this chapter open while
you build your first pattern.

## Check: the fast inner loop

```bash
deno task cf check pattern.tsx                 # compile + execute once (quiet on success)
deno task cf check pattern.tsx --no-run        # typecheck only (fastest)
deno task cf check pattern.tsx --show-transformed   # print the compiled output
deno task cf check pattern.tsx --verbose-errors     # more error context
```

`cf check` runs the full compiler pipeline (Chapter 7) and instantiates the
pattern once, so it catches both type errors and graph-construction errors
("reactive reference outside context", handlers in the wrong scope, ...).
`--show-transformed` is your X-ray: when behavior is mysterious, look at
what your source actually compiled into before theorizing. The transformed
output is dense — pipe it into `cf view`, an interactive syntax-aware pager
that colors builders, schemas, and closures and lets you navigate the
structure tree:

```bash
deno task cf check pattern.tsx --show-transformed --no-run | deno task cf view
```

## Set up identity and server

You need a running server and a key. For a local server, see
`docs/development/LOCAL_DEV_SERVERS.md` (short version: there's a task that
runs Toolshed on `localhost:8000`; use `dev-local` for the shell, not
`dev`). Then:

```bash
# Create a unique dev key. Redirect from `deno run -A packages/cli/mod.ts`,
# never `deno task cf` — the task wrapper prints ANSI preamble that corrupts
# the key file. (Chapter 10 covers the shared `implicit trust` dev identity
# and the narrow case where you'd derive it instead.)
deno run -A packages/cli/mod.ts id new > cf.key

export CF_IDENTITY=./cf.key
export CF_API_URL=http://localhost:8000
```

Every piece command below takes `-i/--identity`, `-a/--api-url`,
`-s/--space` — or reads them from `CF_IDENTITY`, `CF_API_URL`, and a `-s`
space name. (What the key actually is, and how a space name becomes a DID,
is Chapter 10.)

## Deploy and iterate

```bash
# First deploy only — SAVE THE PRINTED PIECE ID
deno task cf piece new pattern.tsx -s myspace

# Every iteration after that: update the SAME piece in place
deno task cf piece setsrc pattern.tsx --piece fid1:abc... -s myspace
```

The most common workflow mistake is rerunning `piece new` after each edit —
that creates a new piece every time, and your space fills with stale
duplicates. `new` once, `setsrc` forever after.

## Drive a deployed piece from the CLI

Everything a pattern exports (Chapter 3) is drivable without a browser:

```bash
deno task cf piece ls -s myspace                       # list pieces
deno task cf piece search -s myspace "invoice"         # find pieces by their data
deno task cf piece inspect --piece <ID>                # dump structure/state
deno task cf piece get --piece <ID> items              # read one exported field
deno task cf piece call addItem '{"title": "Test"}' --piece <ID>   # send to a stream
echo '"hello"' | deno task cf piece set --piece <ID> title          # write a field
deno task cf piece step --piece <ID>                   # force recompute
deno task cf piece view --piece <ID>                   # render the UI in the terminal
deno task cf piece link <srcID>/items <dstID>/items    # wire two pieces
deno task cf piece set-slug myslug <ID>                # pretty URL
```

One subtlety: neither `piece set` nor `piece call` refreshes *computed*
outputs. `set` writes the cell without running anything; `call` runs the
handler (so the handler's own writes land and sync), but the scheduler is
lazy — derived values recompute only when something observes them
(Chapter 8), and nothing in the ephemeral CLI session does. Run
`cf piece step --piece <ID>` — which pulls the piece, forcing
recomputation — before inspecting computed fields with `get`/`inspect`.

This CLI surface is also exactly how *agents* drive the system — same
streams, same cells. The browser shell is just one more client.

## Testing patterns

Tests are patterns that test patterns: instantiate the subject, alternate
`action` steps and `computed(() => boolean)` assertions, and return them as
a `tests` array. From `packages/patterns/counter/counter.test.tsx`:

```tsx
// Shown at module scope.
import { action, computed, pattern } from "commonfabric";
import Counter from "./counter.tsx";

export default pattern(() => {
  const counter = Counter({});

  const action_increment = action(() => {
    counter.increment.send();
  });

  const assert_initial_value_is_0 = computed(() => counter.value === 0);
  const assert_value_is_1 = computed(() => counter.value === 1);

  return {
    tests: [
      { assertion: assert_initial_value_is_0 },
      { action: action_increment },
      { assertion: assert_value_is_1 },
    ],
    counter, // exposed for debugging
  };
});
```

```bash
deno task cf test packages/patterns/counter/counter.test.tsx --verbose
deno task cf test packages/patterns/my-pattern/      # all tests in a directory
```

Notice what makes the subject *testable*: dual type parameters on
`pattern<Input, Output>()` and exported `Stream<T>` actions. That's why
Chapter 3 insisted on them. Keep assertions deterministic — no
`Date.now()` or randomness inside them. Patterns that fetch external data
(`fetchJson` and friends) can still be tested deterministically: export a
module-scope `fetchMocks` array from the test file and the harness injects
it as the runtime's fetch (worked examples in
`packages/patterns/examples/fetch-mock.test.tsx`). The guidance from the
canonical guide: primary verification is still runtime behavior; write
tests for logic that's awkward or expensive to verify by clicking.

## The gotcha checklist

Before your first deploy, scan your pattern against the ten most common
failures (each links to a full writeup under
`docs/development/debugging/gotchas/` or the development guide):

1. **`computed()` gating JSX** — cells are truthy objects inside the
   closure; use ternaries in JSX instead.
2. **Writing upstream cells inside `computed()`** — reactive cycle;
   derivation in computeds, mutation in actions.
3. **Echoing a `$value` binding from its own change handler** — feedback
   loop; the binding is the value path.
4. **`handler()`/`lift()` inside the pattern body** — must be module scope;
   use `action()` for closures.
5. **`new Writable(reactiveValue)`** — initialize with statics; copy from
   inputs inside an action.
6. **`onClick={stream.send(x)}`** — invokes during render; pass
   `() => stream.send(x)`.
7. **Storing a cell reference to mark selection** — later writes can land on
   the referenced item (sub-path writes and pattern bindings follow links)
   instead of changing the selection; box it: `selected.set({ item })`.
8. **`ifElse` on a composed pattern's cell** — hangs; bridge through a local
   `computed()`.
9. **`Date.now()` / `Math.random()` / `setTimeout` / `new Proxy()`** — `setTimeout`
   and `new Proxy()` are not available under SES. `Date.now()`, no-argument
   `new Date()`, and `Math.random()` are gated: call them directly in handlers or
   one-time initialization (the clock reads at one-second resolution there), but in
   `computed()`/`lift()` they throw a `TimeCapabilityError`. For reactive time in a
   `computed()`, use the `#now` wish.
10. **Unguarded scoped-cell reads while rendering** — `PerSession` cells are
    `undefined` until first sync; guard with `?? []`.

When something still goes wrong: `docs/development/debugging/` has the error
reference, and the repo-local `pattern-critic` agent/skill reviews a pattern
against the full rule list mechanically. For storage-level surprises ("what
is actually stored?", "who overwrote this?"), `cf inspect` performs an
offline autopsy of a space's SQLite database — see the `state-inspector`
skill.

---

This closes Part I — you can now build, deploy, link, and test patterns.
**Part II begins with [Chapter 7 — From TypeScript to a runnable
graph](07-compilation.md):** what actually happens when `cf check` compiles
your file.
