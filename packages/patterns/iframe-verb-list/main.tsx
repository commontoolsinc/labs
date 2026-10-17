/**
 * A list shown in a sandboxed iframe, whose items belong to this pattern and
 * change only through its `addItem` verb. The frame of `frame.tsx`, generated
 * from `contract.ts` and `guest.ts`, takes the verb as an input, and its guest
 * adds an item by sending the verb an event. A caller with no browser sends
 * the same verb, so an item added either way appears in every open frame.
 */

import {
  action,
  type Default,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  type Writable,
} from "commonfabric";
import {
  type AddItemEvent,
  type IframeOutputData,
  type IframeStateData,
  type ListItem,
} from "./contract.ts";
import Frame from "./frame.tsx";

/** What a verb list is instantiated with. */
export interface VerbListInput {
  /** The items on the list. Left out, the list starts empty. */
  items?: Writable<ListItem[] | Default<[]>>;
}

/** What `addItem` added, or found there already. */
export interface AddItemResult {
  /** The item as the list holds it. */
  item: ListItem;

  /** Whether this call added it: `false` when the list held its id already. */
  added: boolean;
}

/**
 * A list of items, each of which can be checked off. Read `items` for what is
 * on it, and add to it with `addItem`.
 */
export interface VerbListOutput {
  [NAME]: string;
  [UI]: VNode;

  /** Every item on the list, in the order they were added. */
  items: ListItem[];

  /** Which items are checked off, by item id, as the frame stores it. */
  state: IframeStateData;

  /** How many items are checked off, as the frame last counted them. */
  output: IframeOutputData;

  /**
   * Add one item. Mint a fresh `id` for each item; sending an id the list
   * holds already adds nothing, so sending the same event again is safe.
   */
  addItem: Stream<AddItemEvent, AddItemResult>;
}

export default pattern<VerbListInput, VerbListOutput>(({ items }) => {
  const addItem = action<AddItemEvent, AddItemResult>(({ id, text }) => {
    if (typeof id !== "string" || id === "") {
      throw new Error("An item needs an id.");
    }
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (trimmed === "") throw new Error("An item needs text.");
    const existing = items.get().find((item) => item.id === id);
    if (existing !== undefined) return { item: existing, added: false };
    const item = { id, text: trimmed };
    items.push(item);
    return { item, added: true };
  });

  const frame = Frame({ input: { items }, addItem });
  // Destructuring binds each name to a link into the frame's result, so this
  // piece's `state` and `output` are the frame's cells rather than copies.
  const { state, output, [UI]: view } = frame;

  return {
    [NAME]: "Verb list",
    [UI]: view,
    items,
    state,
    output,
    addItem,
  };
});
