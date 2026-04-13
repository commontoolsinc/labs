# Pattern Development Guide

This is the canonical reference for building Common Fabric patterns.

## Core Working Style

- Plan before building. Scale the plan to the problem size.
- Start simple and keep the first implementation runnable.
- Prefer one-file patterns first. Split files only when complexity demands it.
- Iterate through `Sketch -> Run -> Verify -> Improve`.
- Prefer validated docs and references over blindly copying an existing pattern.

## Planning Scale

Use enough planning for the task, but no more:

- simple pattern:
  - one file, types plus handlers plus UI together
  - minimal clarification needed
  - plan in a couple of sentences
- medium pattern:
  - maybe split schemas if types become hard to follow
  - clarify data shape and key actions up front
  - plan in a short list
- complex pattern:
  - identify entities, relationships, actions, and boundaries
  - consider sub-patterns only when concepts are genuinely distinct
  - plan with structure, but do not over-specify the end state

Always start simple. Split only when it helps the next iteration.

## Pattern Structure

Start with:

```text
packages/patterns/<name>/main.tsx
```

Only split into `schemas.tsx` or additional modules when:

- types become hard to follow
- a helper has clear reuse value
- the main file becomes harder to evolve than to split

Do not split by default. A moderate pattern with a few entities can still live
comfortably in one file while you discover the right shape.

## Development Loop: Sketch -> Run -> Iterate

Do not write the finished code up front. Write the minimum needed to see real
behavior:

1. Sketch
   - define the types
   - add one handler or action
   - render the simplest useful UI
2. Run it
   - use `deno task cf check <pattern>.tsx`
3. Verify
   - does it render?
   - do the core interactions fire?
   - do the values move the way you expect?
4. Iterate
   - add one more meaningful piece and rerun

If you cannot run what you have written, you have probably written too much
before validating enough.

## Verification Loop

Use the runtime, not just static reasoning:

- `deno task cf check <pattern>.tsx`
- `deno task cf check <pattern>.tsx --no-run` for faster type validation
- `deno task cf check <pattern>.tsx --show-transformed` when you need to
  inspect how the transformer lowered a conditional or reactive expression site
- `deno task cf test <pattern>.test.tsx` when tests are justified

Primary verification is still runtime behavior. Tests are for logic that is
awkward, fragile, or expensive to verify by clicking.

## Delegation and Review Rhythm

If your runtime supports delegation, the most useful split is usually:

- a code-writing role for implementation
- a deploy/runtime-testing role
- a critic/review role before release or first deploy

Use delegation to reduce context mixing, not to overcomplicate small tasks.
Simple patterns can stay in one session; larger or more failure-prone work
benefits from role separation.

## action() vs handler()

Default to `action()` when the behavior is specific to one pattern instance and
can close over pattern-local state.

Use `handler()` when:

- you need different bound data per instantiation
- the same implementation is reused across items or contexts
- you are binding per-item behavior inside `.map()`

Decision rule:

- if the behavior needs different data at different call sites, use `handler()`
- otherwise, use `action()`

### Correct `action()` usage

```tsx
const Note = pattern<NoteInput, NoteOutput>(({ title, content }) => {
  const menuOpen = Writable.of(false);

  const toggleMenu = action(() => menuOpen.set(!menuOpen.get()));
  const clearContent = action(() => content.set(""));

  return {
    [UI]: (
      <>
        <cf-button onClick={toggleMenu}>Menu</cf-button>
        <cf-button onClick={clearContent}>Clear</cf-button>
      </>
    ),
    content,
  };
});
```

### Correct `handler()` usage

```tsx
const deleteItem = handler<void, { index: number; items: Writable<Item[]> }>(
  (_, { index, items }) => {
    const list = items.get();
    items.set(list.filter((_, itemIndex) => itemIndex !== index));
  },
);

const List = pattern<ListInput, ListOutput>(({ items }) => ({
  [UI]: (
    <ul>
      {items.map((item, index) => (
        <li>
          {item.name}
          <cf-button onClick={deleteItem({ index, items })}>Delete</cf-button>
        </li>
      ))}
    </ul>
  ),
  items,
}));
```

## SES Authoring Limits and Escape Hatches

Patterns now run inside a verified SES subset. The practical authoring rules
are:

- keep module scope declarative:
  - use `const`
  - define `pattern()`, `handler()`, `lift()`, schemas, and plain data
  - avoid top-level `let`, `var`, classes, or ad hoc mutable caches
- keep pattern-owned callback bodies straight-line:
  - avoid `let`, `var`, reassignment, and loop statements
  - prefer array methods, `computed()`, `derive()`, or a module-scope helper
- do not rely on authored timers or proxies:
  - `setTimeout()`, `setInterval()`, and `new Proxy()` are not part of the
    authored runtime surface yet
- use explicit time/random escape hatches only when needed:
  - use `safeDateNow()` instead of `Date.now()`
  - use `nonPrivateRandom()` instead of `Math.random()`
  - prefer calling them from `action()`, `handler()`, or one-time
    initialization rather than inside `computed()` or `derive()`

The current exported helper names are `safeDateNow()` and
`nonPrivateRandom()`. Older shorthand such as `dateNow` or `insecureRandom`
does not match the current API.

```tsx
const createItem = action(() => {
  items.push({
    id: `item-${nonPrivateRandom().toString(36).slice(2, 8)}`,
    createdAt: safeDateNow(),
    title: title.get(),
  });
});
```

If a pattern needs richer time, scheduling, or entropy behavior, prefer an
explicit runtime capability or service over hiding imperative state in authored
callbacks.

## Common Pitfalls

### Conditional JSX

Do not use `computed()` to gate JSX sections. Use direct authored expressions
instead, usually plain ternaries.

Current main handles ordinary ternaries correctly in normal pattern code, not
just in JSX children. If you're debugging a less common site, inspect the
emitted output with `cf check --show-transformed` instead of reasoning from old
transformer limitations.

```tsx
// Wrong
{computed(() => {
  if (!showAdmin.get()) return null;
  return <div>{showForm ? <form>...</form> : null}</div>;
})}

// Right
{showAdmin
  ? <div>{showForm ? <form>...</form> : null}</div>
  : null}
```

Inside `computed()`, a `Writable<boolean>` is just a JS object and therefore
truthy. That leads to subtle incorrect rendering because ternaries inside the
`computed()` body are plain JS, not transformer-lowered conditionals.

That distinction matters because explicit computation callbacks like
`computed`, `derive`, `action`, `lift`, and `handler` are preserved-JavaScript
control-flow boundaries. Inside those callback bodies, use `.get()` when you
need the raw boolean value.

### CORS and `fetchData`

Patterns run in the browser. Any URL used with `fetchData` must be
CORS-compatible. RSS feeds, private APIs, and many XML endpoints do not expose
the required headers. Prefer public JSON APIs that explicitly allow
cross-origin requests.

If a brief requests a non-CORS source, substitute a compatible equivalent and
note the change instead of shipping a pattern that cannot run in the browser.

### Reactive Cycles

Do not call `.set()` on upstream cells from inside `computed()`. If the write
feeds back into the same reactive graph, the runtime will cycle and eventually
throw.

```tsx
// Wrong
const sorted = computed(() => {
  const items = allItems.get();
  statusMessage.set(`${items.length} items`);
  return items.sort(compareFn);
});

// Right
const sorted = computed(() => [...allItems.get()].sort(compareFn));
const updateStatus = action(() => {
  statusMessage.set(`${allItems.get().length} items`);
});
```

Use `computed()` for derivation and `action()` for side effects.

### Composition Contracts

When one pattern feeds another, output field names and input field names must
match exactly. There is no automatic name mapping. `chartData` and
`chartEntries` are different contracts.

Coordinate naming across related patterns before implementation. Mismatched
field names create silent friction later and are easy to miss during assembly.

## Workflow Guidance

The common operating rhythm is:

1. build the smallest coherent version
2. run it locally
3. review against the documented gotchas
4. deploy or runtime-check it in a representative environment
5. tighten or expand only after the earlier slice works

Always review before first deploy when the change is larger than a trivial fix.
The fast review step catches many convention and reactivity mistakes before
they become runtime debugging sessions.

At clear milestones, offer a commit or checkpoint so useful progress is not
left ephemeral.

## Documentation Priorities

Start with `docs/common/patterns/`, especially the meta guidance under
`docs/common/patterns/meta/`.

Then consult the targeted references as needed:

- `docs/common/concepts/types-and-schemas/`
- `docs/common/concepts/action.md`
- `docs/common/concepts/handler.md`
- `docs/common/workflows/pattern-testing.md`
- `docs/common/components/COMPONENTS.md`
- `docs/development/debugging/`

Prefer documentation over existing patterns in `packages/patterns/`. Existing
patterns are useful reference points but may include older idioms or locally
driven compromises.
