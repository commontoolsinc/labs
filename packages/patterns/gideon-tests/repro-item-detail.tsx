/// <cts-enable />
import {
  computed,
  Default,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commontools";

export type ItemType = "a" | "b";
export type ItemStatus = "pending" | "active" | "done";

interface ItemInput {
  name?: Writable<Default<string, "">>;
  description?: Writable<Default<string, "">>;
  type?: Writable<Default<ItemType, "a">>;
  status?: Writable<Default<ItemStatus, "pending">>;
  priority?: Writable<Default<number | null, null>>;
  // Non-Writable Default fields like reading-item-detail
  createdAt?: Default<number, 0>;
  completedAt?: Default<number | null, null>;
}

export interface ItemOutput {
  [NAME]: string;
  [UI]: VNode;
  name: string;
  description: string;
  type: ItemType;
  status: ItemStatus;
  priority: number | null;
  createdAt: number;
  completedAt: number | null;
}

export default pattern<ItemInput, ItemOutput>(({
  name,
  description,
  type,
  status,
  priority,
  createdAt,
  completedAt,
}) => ({
  [NAME]: computed(() => `Item: ${name.get()}`),
  [UI]: (
    <div
      style={computed(
        () =>
          `padding: 0.5rem; background: ${
            type.get() === "a" ? "#e0f0ff" : "#ffe0e0"
          }; border-radius: 4px;`,
      )}
    >
      {name} (Type {computed(() => type.get().toUpperCase())}, Status: {status})
    </div>
  ),
  name,
  description,
  type,
  status,
  priority,
  createdAt,
  completedAt,
}));
