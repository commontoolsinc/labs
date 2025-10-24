# Implementation plan

- [ ] Disable ShadowRef/unsafe_ and see what breaks, ideally remove it
- [ ] Update Cell API types to already unify them
  - [ ] Create an `AnyCell<>` type with a symbol based brand, with the value be
    `Record<string, boolean>`
  - [ ] Factor out parts of the cell interfaces along reading, writing, .send
    (for stream-like) and derives (which is currently just .map)
  - [ ] Define `OpaqueCell<>`, `Cell<>` and `Stream<>` by using these factored
    out parts, combined with the brand set to `{ opaque: true, read: false,
    write: false, stream: false }` for `OpaqueRef`, `{ opaque: false, read:
    true, write: true, stream: true }` for `Cell`, and `{ opaque: false, read:
    false, write: false, stream: true }` for `Stream`.
  - [ ] Add `ComparableCell<>` that is all `false` above.
  - [ ] Add `ReadonlyCell` and `WriteonlyCell`.
  - [ ] Make `OpaqueRef` a variant of `OpaqueCell` with the current proxy
    behavior, i.e. each key is an `OpaqueRef` again. That's just for now, until
    the AST does a .key transformation under the hood.
  - [ ] Update `CellLike` to be based on `AnyCell` but allow nesting.
  - [ ] `Opaque<T>` accepts `T` or any `CellLike<T>` at any nesting level
  - [ ] Simplify most wrap/unwrap types to use `CellLike`. We need
    - [ ] "Accept any T where any sub part of T can be wrapped in one ore more
      `AnyCell`" (for inputs to node factories)
    - [ ] "Strip any `AnyCell` from T and then wrap it in OpaqueRef<>" (for
      outputs of node factories, where T is the output of the inner function)
    - [ ] Make passing the output of the second into the first work. Tricky
      because we're doing almost opposite expansions on the type.
- [ ] Add ability to create a cell without a link yet.
  - [ ] Change constructor for RegularCell to make link optional
  - [ ] Add .for method to set a cause (within current context)
    - [ ] second parameter to make it optional/flexible:
      - [ ] ignores the .for if link already exists
      - [ ] adds extension if cause already exists (see tracker below)
  - [ ] Make .key work even if there is no cause yet.
  - [ ] Add some method to force creation of cause, which errors if in
    non-handler context and no other information was given (as e.g. deriving
    nodes, which do have ids, after asking for them -- this walks the graph up
    until it hits the passed in cells)
  - [ ] For now though throw in non-handler context when needing a link and it
    isn't there, e.g. because we need to create a link to the cell (when passed
    into `anotherCell.set()` for example). We want to encourage .for use in
    ambiguous cases.
- [ ] First merge of OpaqueRef and RegularCell
  - [ ] Add methods that allow linking to node invocations
    - [ ] `setPreExisting` can be deprecated (used in toOpaqueRef which itself
      can go away, see below)
    - [ ] `setDefault` can be deprecated
    - [ ] `setSchema` is tricky (asSchema is cleaner). Let's support it for now,
      but only if the cause isn't set yet.
    - [ ] `connect` copy over and add a direction field, so can distinguish
      where this node is used as input vs where the passed node is an input to
      this node.
    - [ ] `export` make the analogous version, if link is present use that as
      `external`.
    - [ ] `map` and `mapWithPattern`: Copy over
    - [ ] `toJSON` return `null` when no link otherwise what Cell does.
  - [ ] No need for `toOpaqueRef` anymore, since all cells are now also
    OpaqueRef. So remove all that.
  - [ ] Call that for returned value in lift/handler, with a .for("assigned
    variable of property", true)
  - [ ] For now treat result as recipe, but it should be one where all nodes
    already have links associated with them (no internal necessary).
- [ ] Add tracking for used causes and created cells in contexts, when popping
  context write those down, with schemas used.
  - [ ] Set `source` in context, so that created cells copy it and write it as
    metadata.
  - [ ] Keep track of all created cells, make sure to track those as well for
    the recipe creation in lift/handler, so we don't need to return them in e.g.
    a handler.
  - [ ] Add a helper for cause generation that checks that no other created cell
    already has that cause.
- [ ] In lift/handler, change how recipes are invoked to directly go off the
  created graph.
  - [ ] For each created cell (as that's always the case when introducing a
    reactive node), schedule it, unless it didn't change (see next task)
  - [ ] Remember all scheduled nodes by result link, so we don't need to restart
    if there was no change.
  - [ ] Write metadata into result cell of the lift,
    - [ ] source, coming from context
    - [ ] `process`:
      - [ ] the `Module`, which includes the `Program` (as link, using
      `cid:hash` and maybe using `cid:hash` links for the individual files as
      well)
      - [ ] (P2) the created cells with link to module and/or schema (can leave schema off if it's same as module)
      - [ ] (P2) keep a history of previously used ones, we'll eventually need
        this for safe updating on schema changes
- [ ] Change lifecycle of recipes so that they are run like a lift, with an
  OpaqueRef already tied to the arguments cell as input.
  - [ ] This should allow us to remove the JSON recipe representation
- [ ] Add `Cell.for(cause)` cell factory, replacing `cell` and `createCell`.
- [ ] Have `Cell.set` return itself, so `Cell.for(..).set(..)` works
- [ ] `cell.assign(otherCell)` applies `cell`'s link to `otherCell` if it
  doesn't have one yet. Useful to make self-referential loops.
- [ ] In AST transformation add `.for(variableName, true)` for `const var = `
  cases
- [ ] Update JSON Schema to support new way to describe cells

## Random nits

- [ ] Rename `.update` to `.updateWith`
  - [ ] Consider .update with a function callback, but not sure how useful that
  is.
- [ ] Add `.remove` and `.removeAll` which removes the element matching the
  parameter from the list.
- [ ] Add overload to `.key` that accepts an array of keys
- [ ] Make name parameter in recipe optional

## Planned Future Work

- [ ] **Serializable node factories** (see `node-factory-shipping.md`)
  - [ ] Implement `nodeFactory@1` sigil format for shipping factories
  - [ ] Add `.curry(value, argIndex)` method for partial application
  - [ ] Support rehydration of serialized factories from cells/events
  - [ ] Ensure currying metadata is preserved during serialization

## Open Questions

### Type System Questions

- Should Opaque be a flag, or is it inferred from read, write and stream being
  false?
  - What's necessary for .equals() to be available? Should we make a new cell
    type just for that (useful to just reference an item, don't read or write,
    but also with the link itself not being opaque)
- How should we handle streams vs the current { $stream: true } behavior?
  - Use just the schema instead, e.g. in the redirect link. What's the override
    rule? We can't turn a non-cell link into a Stream<>, so it should just be
    for narrowing.

### Implementation Clarification Needed

- **What actually breaks when ShadowRef/unsafe_ is disabled?** (Task line 3)
  - Need to run the experiment to see what fails
  - This will inform how we approach the migration
- **What does "adds extension if cause already exists" mean?** (Task line 24)
  - Need to clarify the extension mechanism for the flexible `.for()` parameter
  - How does this relate to the cause tracking work (lines 39-46)?
- **What is "First merge of OpaqueRef and RegularCell"?** (Task line 33)
  - This seems like a major milestone - needs clearer definition
  - What specifically gets merged and how?
- **What does "treat result as recipe" mean?** (Task line 37-38)
  - Need to clarify what "recipe" means in this context
  - How does this differ from normal cell results?
- **Where is AST transformation implemented?** (Task line 69)
  - Need to locate existing AST transformation code
  - Should there be a spec for this work?

### Lifecycle and Runtime Questions

- What should happen with orphaned cells on pattern updates?
  - E.g. a lift previously wrote into x and now it now longer does, because the
    code changed
  - Ideally we know enough about `x` to be able to write a redirect into
    whatever the new thing is, but this is only useful if there are any links to
    it
  - So we could do that lazily when that is read
  - Its `source` already points to lift result cell
  - Keep a list of previously used ids in the metadata?
- What to do with `cell.key("foo").assign(otherCell)`?
  - That's closer to how in regular JS one would make a circular reference work
    (pass foo = {} to first function, assign output of second function to
    foo.bar)
  - It should result in a writeRedirect being written into `cell` and path
    `foo`. So maybe that's what we need to keep track of and do on runs
    - Maybe a link is sufficient as the destination isn't mutable anyway. Should
      the link be mutable, breaking the cycle, if that's indeed what we meant?
      But also, it's part of a reactive flow, so it should be expected to be
      overwritten again at any point
  - How is this different from .set? It works on opaques!
- What cause should we use in Cell.set(opaque)?
  - That should mean that cell.set(opaqueCell) triggers the opaqueCell creating
    a link
  - Interestingly, we call that from within normalizeAndDiff, which has extra
    context, e.g. the cell we set this to
  - Should we use this? It's conceptually equivalent to
    cell.set(opaqueCell.for(cell))
  - In a handler it feels right, but is also unnecessary. Should we error in a
    lift or just derive it from the source? If the latter we get a bunch of
    orphans, and this is so rare, that I think we should error
  - = Let's error for now and see how it feels
