/**
 * EditableList — composable list PRIMITIVE
 * =========================================
 *
 * The first occupant of the `primitives/` tier: a pattern designed to be
 * embedded inside other patterns (used as a JSX tag), not deployed standalone.
 * It owns the *logic and model* of an editable, checkable list; the host owns
 * (or borrows) the rendering.
 *
 * ## The composition contract this establishes
 *
 * A primitive exposes two things, in priority order:
 *   1. **Cells + Streams** pre-bound to the caller's data — the real product.
 *   2. An **optional default `[UI]`** so a caller who just wants a list gets
 *      one for free, without wiring any rows.
 *
 * ### Headless vs default UI
 *
 * - **Default**: drop `<EditableList items={myItems} />` into your vdom and you
 *   get a working list — per-item rows (checkbox + editable text + delete), a
 *   quick-add row (cf-message-input), and a cf-empty-state when empty.
 * - **Headless**: don't render its `[UI]`. Instead embed it for the model and
 *   `.map()` your OWN rows, calling the exposed streams. There is deliberately
 *   NO VNode / render-prop input — render props fight the CTS transformer.
 *   Headless looks like:
 *       const list = EditableList({ items: myItems });
 *       // ...render list.items yourself, call list.toggleItem.send({ item }).
 *
 * ### Identity comes from the DATA MODEL, not from an id field
 *
 * Every mutation in the CORE layer addresses an item by the live item
 * reference itself: `removeItem` calls `items.remove(item)` and
 * `toggleItem`/`updateItem` locate the item with `equals()` — both compare by
 * the runtime's own entity identity, which survives reorder and concurrent
 * edits. removeItem/updateItem/toggleItem never take an array index (the
 * reorder/race fragility this overhaul kills) and there is deliberately NO
 * user-land `id` field. NEVER mint ids (UUIDs, counters, timestamps) on items
 * — the reactive fabric is an object graph, not a keyed database, and the
 * runtime already gives array items stable identity. See
 * docs/common/concepts/identity.md and
 * docs/development/debugging/gotchas/custom-id-property-pitfall.md.
 *
 * Updates must also PRESERVE that identity: `updateItem`/`toggleItem` write
 * through the element's cells (`items.key(i).key(field).set(...)` — the same
 * route as the default row's `$checked={item.done}` binding). Replacing an
 * array slot with a fresh object literal (`toSpliced(i, 1, { ...old, ...new })`)
 * re-mints the entity identity and orphans every previously-held reference —
 * a selection cell or any caller that read the item earlier stops
 * `equals()`-matching it, and later mutations sent with that reference
 * silently no-op. Structural ops (remove, clearDone) genuinely drop entries,
 * so rebuilding the array there is correct.
 *
 * ### Agents address items the same way: pass the item
 *
 * There is deliberately NO text-addressed ("ByText") or string-token layer.
 * LLM tool-calls do not need one: the serialization layer round-trips item
 * references through tool arguments (cells/items serialize to `@link`
 * references and re-cellify on the way back — see `traverseAndSerialize` /
 * `traverseAndCellify`), so an agent that has read the list can send the
 * item itself, exactly like JSX callers do. Grounding a natural-language
 * phrase ("the milk one") against the list is the AGENT's job — read, match,
 * send the reference — not a mutation API this primitive should ship.
 *
 * ### What the DEFAULT UI assumes about item shape (headless does not)
 *
 * The item type is intentionally minimal-but-extensible (an index signature
 * lets callers carry extra PLAIN-DATA fields — see the EditableListItem doc:
 * live-cell / Writable extras are NOT supported through the passthrough). The
 * default row reads exactly two keys:
 *   - `done: boolean`  → the checkbox
 *   - `label: string`  → the editable text
 * A headless caller may ignore `label` entirely and key its own rows off
 * whatever fields it added. Only the default `[UI]` is opinionated about keys.
 *
 * ### Can a sub-pattern mutate a parent-owned cell? YES.
 *
 * This is the crux of the contract and it is RESOLVED in the affirmative.
 * When a parent does `EditableList({ items: myItems })`, the sub-pattern
 * receives the *same* `Writable<TItem[]>` cell — not a copy. `.push()` /
 * `.set()` from inside the sub-pattern's handlers mutate the parent's cell and
 * the change syncs back. Evidence:
 *   - docs/common/concepts/reactivity.md: `Writable<>` is write *intent* on a
 *     shared reactive cell, not a fresh cell.
 *   - packages/patterns/examples/cf-render.tsx: `Counter({ value: state.value })`
 *     — the sub-pattern's handlers `.set()` the parent's `state.value`.
 *   - docs/common/patterns/composition.md: "Both patterns receive the same
 *     `items` cell - changes sync automatically."
 * So the contract exposes reference-addressed Streams the parent wires by
 * simply passing its cell; no parent-side handler plumbing is required.
 */
import {
  computed,
  Default,
  equals,
  handler,
  ifElse,
  NAME,
  type OpaqueRef,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// ===== Item shape =====

/**
 * The minimal, extensible item contract.
 *
 * Required by the model: a `done` flag. Read by the DEFAULT UI only: `label`.
 * There is NO `id` field: identity is the runtime's own entity identity
 * (compare with `equals()`, remove with `items.remove(item)`) — see
 * docs/common/concepts/identity.md.
 * The index signature lets callers carry arbitrary extra fields (priority,
 * dueDate, plain refs, ...) that the model passes through untouched and that
 * headless rows can render.
 *
 * IMPORTANT — extras pass through as PLAIN DATA only. The index signature emits
 * `additionalProperties: true`, which carries no `asCell` marker, so a
 * `Writable<>` / cell-link extra read back through this schema will NOT be
 * re-hydrated as a live Cell (the "any → true schema → can't distinguish
 * Writable from computed" gotcha). Scalars and plain objects round-trip fine; a
 * primitive that needs a nested *live* cell must declare it as a typed field
 * with `asCell` rather than relying on the passthrough.
 */
export interface EditableListItem {
  /** Completion flag — drives the default row's checkbox. */
  done: boolean | Default<false>;
  /** Text label — the only text key the default row reads. */
  label: Default<string, "">;
  // deno-lint-ignore no-explicit-any
  [extra: string]: any;
}

/**
 * Plain change-set / item-payload shape for stream events.
 *
 * Deliberately NOT `Partial<EditableListItem>`: the interface's `Default<>`
 * annotations would make the event schema fill absent fields with their
 * defaults (`done: false`), and a default-filled `done` clobbers the
 * `{ ...current, ...changes }` merge in update handlers. Plain optionals
 * stay absent when not sent.
 */
export interface EditableListItemPatch {
  label?: string;
  done?: boolean;
  // deno-lint-ignore no-explicit-any
  [extra: string]: any;
}

// ===== Input / Output =====

export interface EditableListInput {
  /** Caller-owned list cell. The sub-pattern mutates THIS cell in place. */
  items?: Writable<EditableListItem[] | Default<[]>>;
  /** Whether the default UI shows the cf-message-input quick-adder. */
  adder?: Default<"quick" | "none", "quick">;
  /** Empty-state copy for the default UI. */
  emptyMessage?: Default<string, "No items yet">;
}

export interface EditableListOutput {
  [NAME]: string;
  [UI]: VNode;
  items: EditableListItem[];

  // ----- counts (named computed cells) -----
  total: number;
  active: number;
  done: number;

  // ----- CORE: reference-addressed streams -----
  /** Append an item. You may pass extra fields via `item`. */
  addItem: OpaqueRef<
    Stream<{ label?: string; item?: EditableListItemPatch }>
  >;
  /** Remove this item (matched by `equals()` identity). No-op if absent. */
  removeItem: OpaqueRef<Stream<{ item: EditableListItem }>>;
  /** Patch this item (matched by `equals()`). Only provided fields change. */
  updateItem: OpaqueRef<
    Stream<{ item: EditableListItem; changes: EditableListItemPatch }>
  >;
  /** Flip (or set) `done` on this item (matched by `equals()`). */
  toggleItem: OpaqueRef<Stream<{ item: EditableListItem; done?: boolean }>>;
  /** Drop every item whose `done` is true. */
  clearDone: OpaqueRef<Stream<unknown>>;
}

// ===== CORE handlers (reference-addressed) =====

const addItemHandler = handler<
  { label?: string; item?: EditableListItemPatch },
  { items: Writable<EditableListItem[]> }
>(({ label, item }, { items }) => {
  const provided = item ?? {};
  const text = (label ?? provided.label ?? "").trim();
  // Allow empty-label items only when the caller explicitly supplies item data
  // (a headless row may not use `label` at all).
  if (!text && item === undefined) return;
  items.push({
    ...provided,
    label: text,
    done: provided.done ?? false,
  });
});

const removeItemHandler = handler<
  { item: EditableListItem },
  { items: Writable<EditableListItem[]> }
>(({ item }, { items }) => {
  // `remove` locates the item with the same `equals()` identity machinery.
  items.remove(item);
});

const updateItemHandler = handler<
  { item: EditableListItem; changes: EditableListItemPatch },
  { items: Writable<EditableListItem[]> }
>(({ item, changes }, { items }) => {
  const current = items.get() ?? [];
  const i = current.findIndex((x) => equals(x, item));
  if (i < 0) return;
  // Write THROUGH the element's cells (`items.key(i)` resolves through the
  // slot's link into the entity doc) — never replace the slot with a fresh
  // object literal: a fresh literal re-mints entity identity, so every
  // previously-held reference to the item (a selection cell, a caller that
  // read it earlier) stops equals()-matching and later mutations with it
  // silently no-op. Same mechanism the default row's `$checked={item.done}`
  // two-way binding uses.
  const element = items.key(i);
  for (const k of Object.keys(changes)) {
    element.key(k).set(changes[k]);
  }
});

const toggleItemHandler = handler<
  { item: EditableListItem; done?: boolean },
  { items: Writable<EditableListItem[]> }
>(({ item, done }, { items }) => {
  const current = items.get() ?? [];
  const i = current.findIndex((x) => equals(x, item));
  // Per-field write through the element cell — see updateItemHandler for why
  // slot replacement (toSpliced with a fresh literal) is forbidden here.
  if (i >= 0) items.key(i).key("done").set(done ?? !current[i].done);
});

const clearDoneHandler = handler<
  unknown,
  { items: Writable<EditableListItem[]> }
>((_, { items }) => {
  const current = items.get() ?? [];
  const next = current.filter((i) => !i.done);
  if (next.length !== current.length) items.set(next);
});

// ===== The primitive =====

export const EditableList = pattern<EditableListInput, EditableListOutput>(
  ({ items, adder, emptyMessage }) => {
    // Counts — named computed cells (resolve through runSynced + .get()).
    const total = computed(() => (items.get() ?? []).length);
    const active = computed(() =>
      (items.get() ?? []).filter((i) => i && !i.done).length
    );
    const done = computed(() =>
      (items.get() ?? []).filter((i) => i && i.done).length
    );
    const isEmpty = computed(() => (items.get() ?? []).length === 0);
    const showAdder = computed(() => (adder ?? "quick") !== "none");

    // Bind core streams to the caller's cell.
    const addItem = addItemHandler({ items });
    const removeItem = removeItemHandler({ items });
    const updateItem = updateItemHandler({ items });
    const toggleItem = toggleItemHandler({ items });
    const clearDone = clearDoneHandler({ items });

    // Default rows. Checkbox + text use $checked/$value two-way binding
    // (no setter handler — that would just write the same value back). Delete
    // reuses the already-exposed `removeItem` stream (removal lives in ONE
    // place), sending the live item reference the row already holds from
    // `items.map(...)` — NOT an array index, NOT a minted id.
    const rows = items.map((item: EditableListItem) => (
      <cf-hstack gap="2" align="center" style="padding: 4px 0;">
        <cf-checkbox $checked={item.done} />
        <cf-input $value={item.label} placeholder="..." style="flex: 1;" />
        <cf-button
          variant="ghost"
          size="sm"
          onClick={() =>
            removeItem.send({ item })}
        >
          x
        </cf-button>
      </cf-hstack>
    ));

    return {
      [NAME]: computed(() => `List (${active} / ${total})`),
      [UI]: (
        <cf-vstack gap="1">
          {ifElse(
            isEmpty,
            <cf-empty-state
              message={computed(() => emptyMessage ?? "No items yet")}
            />,
            <cf-vstack gap="0">{rows}</cf-vstack>,
          )}
          {ifElse(
            showAdder,
            <cf-message-input
              placeholder="Add item..."
              button-text="+"
              oncf-send={(e: { detail?: { message?: string } }) => {
                const text = e.detail?.message?.trim();
                if (text) addItem.send({ label: text });
              }}
            />,
            null,
          )}
        </cf-vstack>
      ),
      items,
      total,
      active,
      done,
      addItem,
      removeItem,
      updateItem,
      toggleItem,
      clearDone,
    };
  },
);

export default EditableList;
