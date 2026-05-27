# perSession read inside a `computed()` nested in `.map()` silently never updates

**Symptom:** A list of rows is rendered with `someList.map((row) => { … })`. Each
row has an inline form (a delete-confirm, an edit form, a picker) gated on
per-row open-state, computed *inside* the map like:

```tsx
{rows.map((row) => {
  const isOpen = computed(() => openTarget.get() === row.id); // openTarget is perSession
  return <>{isOpen ? <Form/> : <button onClick={() => open.send({ id: row.id })}/>}</>;
})}
```

Clicking the trigger does **nothing** — the inline form never appears, the
`{isOpen ? … : …}` ternary never flips. There is **no compile error and no
runtime error**: just a permanently dead control. Sibling buttons that mutate a
**perSpace** cell (and reclassify the row) work fine, and a *top-level*
perSession read (e.g. a tab gate `{selectedTab.get() === "x" ? …}`) reacts
fine — which makes this maddening to localize.

**Cause:** The `.map()` runs in a **space-scoped reading context** whenever the
list it iterates derives from a `perSpace` cell (e.g.
`computed(() => myPerSpaceCell.get().map(…))`, or an input cell mapped
directly). A `computed()` defined *inside* that callback inherits the
space-scoped context, and the runner **blocks following a link into a narrower
scope** (`perSession` is narrower than `space`) — so `openTarget.get()` resolves
to nothing and never re-evaluates. The block is silent (no author-facing
diagnostic). See `packages/runner/src/scope.ts:61-69`, enforced at
`packages/runner/src/traverse.ts` / `link-resolution.ts`, pinned by
`packages/runner/test/schema-links.test.ts`.

Note the non-obvious trigger: if the mapped list is a **static JS array**, the
nested perSession read *works* — the bug only appears once the map iterates a
perSpace/input-derived list. (This is also why it can lurk unnoticed: it only
breaks once real data flows in.)

**Fix — hoist the perSession read into the top-level row computed.** Read the
`perSession` target cell once at the top (a top-level computed/derive read of a
narrower-scoped cell *does* resolve), and emit a plain boolean per row:

```tsx
const rows = computed(() => {
  const openId = openTarget.get();            // read perSession HERE, at top level
  return myPerSpaceCell.get().map((r) => ({
    ...r,
    isOpen: openId === r.id,                  // plain boolean per row
  }));
});
// …in JSX:
{rows.map((row) => (row.isOpen ? <Form/> : <button onClick={() => open.send({ id: row.id })}/>))}
```

The fix needs a `.get()`-able list cell, which depends on how the list is typed:

- A pattern-local `new Writable.perSpace<T[]>([…])` or an input typed
  `PerSpace<Writable<T[]>>` (e.g. parking-coordinator's
  `people?: PerSpace<PeopleCell>`) **exposes `.get()` in the body** — use the
  `computed()` above directly.
- An input typed `PerSpace<T[]>` (a *bare* array, e.g. cozy-poll's
  `options?: PerSpace<Option[]>`) deliberately **does not** expose `.get()`
  (`OpaqueCell` lacks it); you can only `.map()` it or read it via `derive`.

⚠️ **There is currently no clean fix for a `PerSpace<T[]>` input mapped
directly.** Substitutes that look plausible but FAIL (verified):

- Lifting the session value into a `computed()` and feeding it to a
  `derive({ items, openId }, …)` that produces the rows: the derive's result
  inherits **session scope** (it depends on a session-scoped value), so mapping
  it in the space-scoped render renders **empty** (not just stale).
- A per-row `derive({ openId, id }, …)` inside the map: never re-renders (same
  scope-follow block).
- `equals()` + a boxed reference via a lifted `computed`: never flips.

The only real options for that case are to **change the input type to
`PerSpace<Writable<T[]>>`** so `.get()` becomes available (then use the
`computed()` form), or to accept the limitation until the framework lifts the
narrower-scope-follow restriction (see `LINEAR-TICKET-scope-map-reactivity.md`).

Setting the perSession cell from an `onClick`/action is **not** affected — only
the nested *read* is. Don't reach for `equals()`, `ifElse`, or restructuring the
map; the scope of the read is the whole problem.

**Verify:** deploy, click the per-row trigger, confirm the inline form opens. A
unit-level analogue is the perSession-vs-perSpace control in the repro attached
to the framework ticket (`LINEAR-TICKET-scope-map-reactivity.md`): identical
nested computed, perSpace flips / perSession doesn't.

**Known-good references (post-fix):**
`packages/patterns/factory-outputs/lot-watch/main.tsx` (sighting rows + spot
picker) and `parking-coordinator/main.tsx`
(`adminPeopleData`/`adminSpotsData`) — both map `.get()`-able lists.
`cozy-poll-scoped/main.tsx` is the unfixed `PerSpace<Option[]>`-input case
described above.
