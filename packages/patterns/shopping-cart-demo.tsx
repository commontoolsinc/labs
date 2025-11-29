/// <cts-enable />
import {
  cell,
  handler,
  Cell,
  NAME,
  recipe,
  UI,
  VNode,
} from "commontools";

/**
 * Shopping Cart Demo - Showcases reduce() and keyed map() with the Cell API
 *
 * This pattern demonstrates:
 * 1. cell.map(fn, { key }) - Keyed mapping that tracks items by ID
 * 2. cell.reduce(initial, reducer) - Aggregating array data
 *
 * The key function syntax { key: (item) => item.id } is transformed by the
 * ts-transformer to use mapByKey internally, which:
 * - Tracks items by their key instead of array index
 * - Reuses computation when items reorder
 * - Handles additions/removals efficiently
 */

type CartItem = {
  id: string;
  name: string;
  price: number;
  quantity: number;
};

type ShoppingCartInput = {
  initialItems?: CartItem[];
};

type ShoppingCartOutput = {
  items: Cell<CartItem[]>;
  total: number;
  itemCount: number;
  ui: VNode;
};

export default recipe<ShoppingCartInput, ShoppingCartOutput>(
  "Shopping Cart Demo",
  ({ initialItems }) => {
    // Initialize cart with sample items
    const items = cell<CartItem[]>(
      initialItems ?? [
        { id: "apple", name: "Apple", price: 1.5, quantity: 2 },
        { id: "bread", name: "Bread", price: 3.0, quantity: 1 },
        { id: "milk", name: "Milk", price: 2.5, quantity: 1 },
      ],
    );

    // NEW API: cell.reduce() - Compute total price
    // Reactively aggregates the array whenever items change
    const total = items.reduce(
      0,
      (acc: number, item: CartItem) => acc + item.price * item.quantity,
    );

    // NEW API: cell.reduce() - Count total items
    const itemCount = items.reduce(
      0,
      (acc: number, item: CartItem) => acc + item.quantity,
    );

    // NEW API: cell.map(fn, { key }) - Keyed mapping
    // The key function tells the framework how to identify each item
    // This is transformed to mapByKey(items, "id", fn) by the ts-transformer
    const itemCards = items.map(
      (item: CartItem) => {
        const subtotal = item.price * item.quantity;
        return (
          <ct-card key={item.id} style="margin-bottom: 0.5rem;">
            <ct-hstack gap="2" align="center">
              <ct-vstack flex gap="1">
                <ct-text weight="bold">{item.name}</ct-text>
                <ct-text size="sm" color="secondary">
                  ${item.price.toFixed(2)} × {item.quantity}
                </ct-text>
              </ct-vstack>
              <ct-text weight="bold">${subtotal.toFixed(2)}</ct-text>
            </ct-hstack>
          </ct-card>
        );
      },
      { key: (item: CartItem) => item.id },
    );

    // Handlers for modifying the cart
    const addItem = handler<void, { items: Cell<CartItem[]> }>(
      (_, { items }) => {
        const newId = `item-${Date.now()}`;
        items.push({
          id: newId,
          name: `New Item`,
          price: Math.round(Math.random() * 10 * 100) / 100,
          quantity: 1,
        });
      },
    );

    const clearCart = handler<void, { items: Cell<CartItem[]> }>(
      (_, { items }) => {
        items.set([]);
      },
    );

    const ui = (
      <ct-screen>
        <ct-vstack slot="header" gap="2">
          <ct-heading level={4}>Shopping Cart Demo</ct-heading>
          <ct-text size="sm" color="secondary">
            Demonstrates reduce() and keyed map() with Cell API
          </ct-text>
        </ct-vstack>

        <ct-vscroll flex showScrollbar fadeEdges>
          <ct-vstack gap="3" style="padding: 1rem;">
            {/* Summary using reduce() results */}
            <ct-card>
              <ct-vstack gap="2">
                <ct-heading level={5}>Summary</ct-heading>
                <ct-hstack gap="2" justify="space-between">
                  <ct-text>Items in cart:</ct-text>
                  <ct-text weight="bold">{itemCount}</ct-text>
                </ct-hstack>
                <ct-hstack gap="2" justify="space-between">
                  <ct-text>Total:</ct-text>
                  <ct-text weight="bold" size="lg">
                    ${total.toFixed(2)}
                  </ct-text>
                </ct-hstack>
              </ct-vstack>
            </ct-card>

            {/* Cart items using keyed map() */}
            <ct-vstack gap="1">
              <ct-heading level={5}>Cart Items</ct-heading>
              {itemCards}
            </ct-vstack>

            {/* Actions */}
            <ct-hstack gap="2">
              <ct-button onClick={addItem({ items })}>Add Random Item</ct-button>
              <ct-button onClick={clearCart({ items })} variant="secondary">
                Clear Cart
              </ct-button>
            </ct-hstack>
          </ct-vstack>
        </ct-vscroll>
      </ct-screen>
    );

    return {
      [NAME]: "Shopping Cart Demo",
      [UI]: ui,
      items,
      total,
      itemCount,
      ui,
    };
  },
);
