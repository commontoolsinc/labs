Builder (Behavioral Spec)

- Scope: High-level recipe authoring model, opaque references, node
  instantiation, and how builder artifacts translate into executable graphs.
  Behaviorally specifies how to construct recipes, modules, and cells for a new
  implementation.

Core Abstractions

- Recipe: A declarative graph with input schema, output schema, initial
  defaults, and a list of nodes. Recipes serialize and can be registered and
  rehydrated at runtime.
- Module: Executable unit. Types include: javascript (function), recipe (nested
  recipe), ref (registry lookup), raw (provides an Action factory), passthrough
  (wire values), isolated/passthrough as needed by environment. Each module may
  have argument/result schemas.
- OpaqueRef: Typed placeholders for values (cells/streams/primitives) used
  during recipe construction. They support `.set`, `.key`, `.setDefault`,
  `.setSchema`, and can connect to NodeRefs. They serialize to allow
  re-materialization into runtime bindings.
- Node: A module invocation with bound input/output shapes expressed as JSON
  containing OpaqueRefs, links, or literals.

Recipe Construction API

- `recipe(argumentSchema, [resultSchema], fn)`: Creates a factory that, when
  invoked, yields a Recipe object. Within `fn`, authors operate on an
  `OpaqueRef` representing the argument, construct outputs using OpaqueRefs and
  literals, and compose modules.
- `lift`, `handler`, `derive`: Builder utilities to construct modules from
  functions, define event handlers/transformations, and renderers. Lifted code
  runs within a frame that provides a cause (used for causal ids) and
  materialization helpers. (`derive` is just a shortcut for `lift`:
  `lift(f)(x) == derive(x, f)`).
- `cell(schema?, name?, value?)`: Produces an `OpaqueRef` that represents a cell
  to be created; new implementations must associate it with a runtime space and
  tx available from the current builder frame; optionally set an initial value.
- Built-ins: `str`, `ifElse`, `llm`, `generateObject`, `fetchData`,
  `streamData`, `compileAndRun`, `navigateTo` represent common modules with
  standardized shapes and schemas.

Frames and Materialization

- Builder operations occur within a “frame” capturing context: current recipe,
  cause for identity, space, and a materialize function to turn a path into a
  query result proxy. Frames nest (e.g., lifted code, handlers) and propagate
  cause information for deterministic identities.
- OpaqueRefs created inside a frame must capture the frame and serialize with
  their bindings (cell link + path, defaults, schema, nodes referencing them).

Graph Extraction

- After `fn` completes, the system traverses the constructed value graph to
  collect:
  - Cells and ShadowRefs referenced by OpaqueRefs.
  - NodeRefs (module invocations) connected to these cells via input/output
    bindings.
  - Names/paths for OpaqueRefs: Inputs receive `argument` path; internal cells
    receive `internal/...` paths, with deterministic but implementation-defined
    identifiers; outputs may be aliased to `internal` or mapped to `result`.
- Apply input interface to outputs so types/schemas flow from inputs to outputs;
  augment names based on node assignments for usability.

Schemas

- `argumentSchema` describes the input shape; `resultSchema` describes the
  output shape. During construction, builder should propagate schemas into
  OpaqueRefs and sanitize schemas to ensure no `asCell/asStream` wrappers are
  serialized where not intended.
- Defaults: Extract default values from schemas to seed initial internal state
  for recipes at runtime.

Serialization

- Recipes and modules must serialize to pure data: modules serialize by type and
  implementation identifier/body; recipes serialize with nodes, schemas, and
  enough metadata to re-materialize frames and bindings within the runtime.

Constraints

- Builder functions must throw if invoked outside an active frame (e.g.,
  creating a cell outside a lifted function or handler).
- Names/paths chosen during extraction must be stable across runs for a given
  recipe structure to avoid unnecessary churn; however, perfect stability is not
  required provided semantic links are preserved.

Examples

- Recipe Extraction
  - Author code:
    - `recipe({ argsSchema }, (input) => { const c = cell(...); return { out: compute(f)(input.x, c) }; })`
  - Builder behavior:
    1. Frame created; `input` is OpaqueRef with schema.
    2. `cell(...)` creates an OpaqueRef bound to frame; registered as internal
       cell.
    3. `compute(...)(...)` constructs a NodeRef with inputs/outputs referencing
       OpaqueRefs.
    4. After fn returns, traversal collects OpaqueRefs and NodeRefs; assigns
       paths: `input` -> `argument`, internal cell -> `internal/__#0`, output
       mapping -> `result`.
    5. Recipe serializes to JSON with nodes and bindings using sanitized
       schemas.

- map-like Raw Module
  - Author passes a closure recipe as an input (e.g., a map transformation).
  - Builder behavior:
    - Traversal sees a nested recipe in an input value; marks closure recipes
      and their OpaqueRefs, creating ShadowRefs when crossing frame boundaries.
      Names and paths assigned as if those were internal nodes bound under the
      current frame.

  Code
  ```ts
  const mapModule: Module = {
    type: "raw",
    implementation: (
      inputsCell,
      send,
      addCancel,
      ctx,
      processCell,
      runtime,
    ) => {
      const action = (tx) => {
        const items = inputsCell.key("items").get();
        const fnRecipe = inputsCell.key("fn").get(); // closure recipe
        // Runner will have extracted fnRecipe and its OpaqueRefs as shadow refs
        const mapped = items.map((x) => /* invoke fnRecipe on x */ x);
        send(tx, { mapped });
      };
      return action;
    },
  };
  ```
