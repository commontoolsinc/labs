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
 * A primitive exposes three things, in priority order:
 *   1. **Cells + Streams** pre-bound to the caller's data — the real product.
 *   2. A **convenience layer** of fuzzy, text-addressed Streams for agents.
 *   3. An **optional default `[UI]`** so a caller who just wants a list gets
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
 *       // ...render list.items yourself, call list.toggleItem.send({ id }) etc.
 *
 * ### Identity, NOT index, NOT title
 *
 * Every mutation in the CORE layer addresses an item by its stable `id`.
 * removeItem/updateItem/toggleItem never take an array index — index-based
 * mutation is exactly the fragility (reorder/concurrent-edit races) this
 * overhaul kills. addItem mints an `id` if the caller doesn't supply one.
 *
 * ### Title/text addressing is a SEPARATE convenience layer
 *
 * `addItemByText` / `updateItemByText` / `removeItemByText` are fuzzy
 * (case-insensitive `label` match), provided so an LLM can drive the list with
 * the words it already has. They are explicitly NOT the identity model: on
 * duplicate labels they touch the first match. Prefer the id-based streams in
 * code; reach for the text streams only from agent tool-calls.
 *
 * ### What the DEFAULT UI assumes about item shape (headless does not)
 *
 * The item type is intentionally minimal-but-extensible (an index signature
 * lets callers carry extra fields). The default row reads exactly two keys:
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
 * So the contract exposes id-based Streams the parent wires by simply passing
 * its cell; no parent-side handler plumbing is required.
 */
import {
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  nonPrivateRandom,
  type OpaqueRef,
  pattern,
  safeDateNow,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// ===== Item shape =====

/**
 * The minimal, extensible item contract.
 *
 * Required by the model: a stable `id` and a `done` flag.
 * Read by the DEFAULT UI only: `label`.
 * The index signature lets callers carry arbitrary extra fields (priority,
 * dueDate, refs, ...) that the model passes through untouched and that headless
 * rows can render.
 */
export interface EditableListItem {
  /** Stable identity. Minted by addItem if not provided. Never an index. */
  id: string;
  /** Completion flag — drives the default row's checkbox. */
  done: boolean | Default<false>;
  /** Text label — the only text key the default row reads. */
  label: Default<string, "">;
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

  // ----- CORE: identity-addressed streams -----
  /** Append an item. Mints an id if omitted; you may pass extra fields. */
  addItem: OpaqueRef<
    Stream<{ label?: string; item?: Partial<EditableListItem> }>
  >;
  /** Remove the item with this id. No-op if absent. */
  removeItem: OpaqueRef<Stream<{ id: string }>>;
  /** Patch the item with this id. Only provided fields change. */
  updateItem: OpaqueRef<
    Stream<{ id: string; changes: Partial<EditableListItem> }>
  >;
  /** Flip (or set) `done` on the item with this id. */
  toggleItem: OpaqueRef<Stream<{ id: string; done?: boolean }>>;
  /** Drop every item whose `done` is true. */
  clearDone: OpaqueRef<Stream<unknown>>;

  // ----- CONVENIENCE: fuzzy text-addressed streams (agent layer) -----
  /** Add by text. Convenience alias for addItem with a label. */
  addItemByText: OpaqueRef<Stream<{ text: string }>>;
  /** Update the first item whose label matches (case-insensitive). */
  updateItemByText: OpaqueRef<
    Stream<{ text: string; newText?: string; done?: boolean }>
  >;
  /** Remove the first item whose label matches (case-insensitive). */
  removeItemByText: OpaqueRef<Stream<{ text: string }>>;
}

// ===== id minting =====

function mintId(): string {
  const now = safeDateNow().toString(36);
  const rand = nonPrivateRandom().toString(36).slice(2, 10);
  return `${now}-${rand}`;
}

// ===== CORE handlers (identity-addressed) =====

const addItemHandler = handler<
  { label?: string; item?: Partial<EditableListItem> },
  { items: Writable<EditableListItem[]> }
>(({ label, item }, { items }) => {
  const provided = item ?? {};
  const text = (label ?? provided.label ?? "").trim();
  // Allow empty-label items only when the caller explicitly supplies item data
  // (a headless row may not use `label` at all).
  if (!text && item === undefined) return;
  items.push({
    ...provided,
    id: provided.id ?? mintId(),
    label: text,
    done: provided.done ?? false,
  });
});

const removeItemHandler = handler<
  { id: string },
  { items: Writable<EditableListItem[]> }
>(({ id }, { items }) => {
  const current = items.get() ?? [];
  const next = current.filter((i) => i.id !== id);
  if (next.length !== current.length) items.set(next);
});

const updateItemHandler = handler<
  { id: string; changes: Partial<EditableListItem> },
  { items: Writable<EditableListItem[]> }
>(({ id, changes }, { items }) => {
  const current = items.get() ?? [];
  let touched = false;
  const next = current.map((i) => {
    if (i.id !== id) return i;
    touched = true;
    // Never let a caller overwrite identity.
    const { id: _ignore, ...safe } = changes;
    return { ...i, ...safe };
  });
  if (touched) items.set(next);
});

const toggleItemHandler = handler<
  { id: string; done?: boolean },
  { items: Writable<EditableListItem[]> }
>(({ id, done }, { items }) => {
  const current = items.get() ?? [];
  let touched = false;
  const next = current.map((i) => {
    if (i.id !== id) return i;
    touched = true;
    return { ...i, done: done ?? !i.done };
  });
  if (touched) items.set(next);
});

const clearDoneHandler = handler<
  unknown,
  { items: Writable<EditableListItem[]> }
>((_, { items }) => {
  const current = items.get() ?? [];
  const next = current.filter((i) => !i.done);
  if (next.length !== current.length) items.set(next);
});

// ===== CONVENIENCE handlers (fuzzy text matching) =====

const addItemByTextHandler = handler<
  { text: string },
  { items: Writable<EditableListItem[]> }
>(({ text }, { items }) => {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return;
  items.push({ id: mintId(), label: trimmed, done: false });
});

const updateItemByTextHandler = handler<
  { text: string; newText?: string; done?: boolean },
  { items: Writable<EditableListItem[]> }
>(({ text, newText, done }, { items }) => {
  const current = items.get() ?? [];
  const needle = (text ?? "").toLowerCase();
  const idx = current.findIndex((i) =>
    (i.label ?? "").toLowerCase() === needle
  );
  if (idx === -1) return;
  const next = [...current];
  next[idx] = {
    ...next[idx],
    ...(newText !== undefined ? { label: newText } : {}),
    ...(done !== undefined ? { done } : {}),
  };
  items.set(next);
});

const removeItemByTextHandler = handler<
  { text: string },
  { items: Writable<EditableListItem[]> }
>(({ text }, { items }) => {
  const current = items.get() ?? [];
  const needle = (text ?? "").toLowerCase();
  const idx = current.findIndex((i) =>
    (i.label ?? "").toLowerCase() === needle
  );
  if (idx === -1) return;
  items.set(current.toSpliced(idx, 1));
});

// ===== Default-UI row helpers (per-item streams keyed by id) =====

const rowDeleteHandler = handler<
  unknown,
  { id: string; items: Writable<EditableListItem[]> }
>((_, { id, items }) => {
  const current = items.get() ?? [];
  items.set(current.filter((i) => i.id !== id));
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

    // Bind convenience streams.
    const addItemByText = addItemByTextHandler({ items });
    const updateItemByText = updateItemByTextHandler({ items });
    const removeItemByText = removeItemByTextHandler({ items });

    // Default rows. Checkbox + text use $checked/$value two-way binding
    // (no setter handler — that would just write the same value back). Delete
    // is keyed by the item's stable id, NOT its array index.
    const rows = items.map((item: EditableListItem) => (
      <cf-hstack gap="2" align="center" style="padding: 4px 0;">
        <cf-checkbox $checked={item.done} />
        <cf-input $value={item.label} placeholder="..." style="flex: 1;" />
        <cf-button
          variant="ghost"
          size="sm"
          onClick={rowDeleteHandler({ id: item.id, items })}
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
      addItemByText,
      updateItemByText,
      removeItemByText,
    };
  },
);

export default EditableList;
