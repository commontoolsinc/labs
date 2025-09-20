/// <cts-enable />
import { handler, Cell } from "commontools";

interface Item {
    text: string;
}

interface ListState {
    items: Cell<Item[]>;
}

const removeItem = handler<unknown, ListState & { index: number }>(
    (_, { items, index }) => {
        const next = items.get().slice();
        if (index >= 0 && index < next.length) next.splice(index, 1);
        items.set(next);
    },
);

// alias-based intersection variant
type ListStateWithIndex = ListState & { index: number };
const removeItemAlias = handler<unknown, ListStateWithIndex>(
    (_, { items, index }) => {
        const next = items.get().slice();
        if (index >= 0 && index < next.length) next.splice(index, 1);
        items.set(next);
    },
);

export { removeItem, removeItemAlias };
