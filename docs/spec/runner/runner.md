Runner (Behavioral Spec)

- Scope: Execution engine for recipes and modules. Manages process cells,
  argument/default state, node instantiation, function caching, event handling,
  and reactive scheduling. This spec defines the observable behaviors for a new
  implementation.

Top-Level Responsibilities

- Start/stop/update recipe executions bound to a result cell in a memory space.
- Materialize arguments from literals/links/cells, apply defaults, and maintain
  internal state.
- Instantiate nodes according to module types and wire their inputs/outputs.
- Register actions and event handlers with the scheduler using explicit
  read/write dependencies.
- Cache function implementations for javascript modules across invocations.

Process Cell and Result Cell

- For a provided `resultCell`, the runner must maintain a paired “process cell”
  that stores runtime execution state:
  - TYPE: recipe identifier used to resolve and resume executions.
  - spell: link to a causal spell reference for the recipe.
  - argument: normalized argument (literals and links), writable for live
    updates.
  - internal: internal runtime state seeded from schema defaults and
    recipe.initial.
  - resultRef: a link to the current result tree or to nested result cells.
- If `resultCell` already has a `sourceCell`, reuse it as the process cell;
  otherwise, create one in the same space and link it as the source of
  `resultCell` for future runs.

Running and Updating

- If called without a recipe and the process cell records a previous recipe id,
  resolve and resume that recipe; otherwise do nothing and return the provided
  result cell.
- If the recipe argument is a link/cell/doc, normalize it into a write-redirect
  sigil link relative to the process cell so runtime can track live changes.
- If an execution for the same process cell is already active:
  - If both recipe id and argument are unchanged, return early without
    restarting.
  - If recipe id is unchanged but argument differs, update the process cell’s
    argument in place and continue running without a restart.
  - If recipe id is different, stop the previous execution and start a new one.

Defaults and Internal State

- Before node instantiation, compute `internal` by merging:
  - Defaults extracted from `argumentSchema` (object traversal producing
    defaults for nested properties).
  - `recipe.initial.internal` when provided.
  - Previously stored `internal` values from the process cell.
- On first run, if no process cell exists, seed TYPE and spell fields and write
  `internal` and `argument` entries.

Node Instantiation

- For each node in the recipe, instantiate based on `module.type`:
  - ref: resolve the module from a registry, then instantiate per resolved type.
  - javascript: obtain implementation (cached function, harness invocation, or
    provided function), optionally wrap with a module wrapper, and build an
    Action that:
    - Reads bound inputs (resolving write-redirect aliases and streams) and
      materializes argument via schema when provided.
    - Computes result (sync/async). If result contains OpaqueRefs (i.e., is a
      recipe subtree), create a sub-recipe from the current frame and run it
      into a nested result cell; bind output link to process outputs.
    - Otherwise, send raw result to bound outputs using binding utilities.
  - raw: call the module’s factory to obtain an Action given input cells, a
    result sender, addCancel, execution context, process cell, and runtime;
    schedule with declared read/write cells.
  - passthrough: forward unwrapped inputs to outputs immediately.
  - recipe: unwrap nested recipe and run it with unwrapped inputs into a fresh
    nested result cell; set output binding to link to that result cell.

Streams and Event Handlers

- When any input binding resolves (through write-redirects) to a stream marker
  value, treat the javascript module as an event handler for that stream:
  - Subscribe a handler that, upon receiving an event, clones inputs, replaces
    the stream input with the event payload, pushes a new frame with a fresh
    cause, materializes arguments using schema if present, runs the module
    function, and writes outputs (spawning sub-recipes if the result contains
    OpaqueRefs).
  - Event handlers should be scheduled via the scheduler’s subscription
    mechanism keyed to the stream address; the handler receives a transaction
    when invoked.

Scheduling and Dependencies

- For each instantiated node, determine read/write dependencies by scanning the
  unwrapped input and output bindings for write-redirect cells/links. Provide
  these addresses to the scheduler when registering Actions or event handlers so
  the scheduler can invalidate and re-run nodes in dependency order.

Function Caching and Module Discovery

- The runner must proactively discover and cache function implementations:
  - For javascript modules with function objects, cache directly on first sight.
  - For recipe modules, recursively discover nested modules and cache their
    javascript implementations.
  - For ref modules, resolve once and cache for reuse.
  - When recipes appear as values in inputs/outputs (e.g., closures for map),
    recursively discover and cache functions within those values too.

Stopping Executions

- Runner must track cancel functions for each active result/process pair.
  Stopping an execution cancels all scheduled actions and event handlers
  associated with that pair and cleans up internal tracking. Nested executions
  created for sub-recipes should be canceled when their parent is stopped unless
  elevated (e.g., navigated to a charm) per product rules.

Error Handling and Logging

- Errors during instantiation, execution, or module resolution should be
  surfaced with context and should not leave the runner in a
  partially-initialized state. Non-fatal module resolution failures (e.g.,
  missing ref) should log warnings and skip that node.

Interoperability

- Runner must work with the scheduler’s run/subscribe APIs and with the
  storage/transaction semantics described in the Transactions spec.
  Inputs/outputs bindings use the same link and diffing semantics described in
  the Data Updating and Links spec.

Cross-Links

- See: `./cell.md` for Cell behavior, `./schema.md` for schema-driven reads,
  `./data-updating-and-links.md` for write normalization, and
  `./scheduler.md` for scheduler semantics.

Examples

- Process Cell Lifecycle Code
  ```ts
  const tx = runtime.edit();
  const result = runtime.getCell(space, { name: "demo" }, {}, tx);

  // First run
  runner.run(tx, recipeFactoryR, { x: 1 }, result);
  tx.commit();

  // Update argument without restart (same recipe)
  const tx2 = runtime.edit();
  runner.run(tx2, undefined, { x: 2 }, result);
  tx2.commit();

  // Restart with new recipe
  const tx3 = runtime.edit();
  runner.run(tx3, recipeFactoryR2, { y: 3 }, result);
  tx3.commit();
  ```
  1. First run:
     - Input: `run(tx, recipe R, arg A, resultCell)` where `A` is a literal.
     - Runner creates/uses a process cell `P` in the same space as `resultCell`
       and sets:
       - `P.TYPE = R.id`; `P.spell = spellLink(R.id)`;
       - `P.argument = A` (normalized; links become write-redirect sigils);
       - `P.internal = merge(defaults(R.argumentSchema).internal, R.initial.internal, P.internal)`;
       - `P.resultRef = link(result subtree or nested result cell)`.
     - Instantiate nodes and schedule actions/handlers; return `resultCell`.
  2. Update argument without restart:
     - Input: `run(tx, undefined, A2, resultCell)` and `P.TYPE === R.id`.
     - Runner writes `P.argument = A2` (normalized) and continues; no restart.
  3. Restart on recipe change:
     - Input: `run(tx, recipe R2, A3, resultCell)`.
     - Runner cancels previous subscriptions for `P`; updates `P.TYPE`/`spell`;
       re-seeds internal defaults; re-instantiates nodes for R2.

  Sequence (first run)
  - Caller -> Runner: run(R, A, resultCell)
  - Runner -> Storage: create/find processCell P; seed TYPE, spell, argument,
    internal; set resultRef
  - Runner -> Scheduler: schedule actions/handlers with (reads, writes)
  - Runner -> Caller: return resultCell

  ASCII
  ```
  Caller      Runner           Storage          Scheduler
    |           |                 |                 |
    | run(R,A)  |                 |                 |
    |---------> |                 |                 |
    |           | create P        |                 |
    |           |---------------> |                 |
    |           | write fields    |                 |
    |           |---------------> |                 |
    |           | deps (reads/writes)               |
    |           |---------------------------------> |
    |           |                 |    enqueue      |
    |           |                 |<----------------|
    |  return   |                 |                 |
    |<----------|                 |                 |
  ```

- JavaScript Node With Stream Input Code
  ```ts
  // Module N: (evt is a stream, foo is literal or link)
  const N: Module = {
    type: "javascript",
    argumentSchema: { type: "object", properties: { evt: {}, foo: {} } },
    resultSchema: { type: "object", properties: { out: {} } },
    implementation: ({ evt, foo }) => ({ out: `${foo}:${evt.payload}` }),
  };
  ```
  - Context: node N has inputs `{ evt: <link to stream S>, foo: X }` and output
    `{ out: Y }`.
  - Runner detects `evt` resolves to a stream marker; registers handler H:
    1. On event E at S:
       - Clone inputs; replace `evt` with E; create cause; push frame.
       - Materialize argument via `argumentSchema` if present, else proxy.
       - Call function `fn(argument)`; await if Promise.
       - If result contains OpaqueRefs: build sub-recipe Rsub from frame and run
         into nested `resultCell_sub`; bind Y to `resultCell_sub` link.
       - Else: write result to Y directly.

  Sequence (event)
  - Storage -> Scheduler: write at S triggers H
  - Scheduler -> Runner/H: invoke H(tx, E)
  - H -> Harness/Function: fn(argument)
  - H -> Storage: writes to bound outputs (possibly via sub-recipe)

  ASCII
  ```
  Storage (S)   Scheduler     Handler(H)      Storage
      |             |             |              |
      | event(E)    |             |              |
      |-----------> |             |              |
      |             | invoke H    |              |
      |             |-----------> |              |
      |             |   read args |              |
      |             |<------------|              |
      |             |   fn(arg)   |              |
      |             |------------>|              |
      |             |   writes    |              |
      |             |<------------|--------------|
  ```

- Nested Recipe Node Wiring Code
  ```ts
  const child = recipe(childArgSchema, (input) => ({ out: input.x }));
  const parent = recipe(parentArgSchema, (input) => ({
    nested: { $alias: { path: ["internal"] } },
  })); // runner instantiates child and stores link in `nested`
  ```
  - Module type `recipe` with implementation Rchild; inputs `I` and outputs `O`.
    Runner:
    1. Unwraps Rchild and `I` relative to process cell P.
    2. Creates a fresh child `resultCell_child` in P.space.
    3. Runs Rchild with `I` into `resultCell_child`.
    4. Binds parent `O` to a link referencing `resultCell_child`.

  Result
  - Parent outputs now contain a link; consumers can treat it as a cell and read
    `resultCell_child.get()` or follow links depending on schema.

Gotchas

- Function caching: If modules are referenced by id and later change their
  implementation, ensure cache invalidation on recipe/module update events.
- Event handler reentrancy: Avoid long-running handlers blocking scheduler
  progress; consider yielding and ensuring handler execution is bounded.
- Resuming without recipe: Only resume when a valid recipe id is present;
  otherwise, do not start execution implicitly.
