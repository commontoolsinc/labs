/// <cts-enable />
import {
  type Cell,
  Default,
  derive,
  handler,
  lift,
  recipe,
  str,
} from "commontools";

interface ReorderableListArgs {
  items: Default<number[], []>;
}

interface PositionState {
  index: number;
  value: number;
}

function normalizeItems(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is number =>
    typeof item === "number" && Number.isFinite(item)
  );
}

function initializeItems(cell: Cell<number[]>): number[] {
  const raw = cell.get();
  const normalized = normalizeItems(raw);
  if (
    !Array.isArray(raw) ||
    normalized.length !== raw.length ||
    normalized.some((item, index) => item !== raw[index])
  ) {
    cell.set(normalized);
  }
  return normalized;
}

function clampIndex(candidate: unknown, size: number): number {
  if (size <= 1) {
    return 0;
  }
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    const index = Math.trunc(candidate);
    if (index < 0) return 0;
    if (index >= size) return size - 1;
    return index;
  }
  return 0;
}

const reorderItems = handler(
  (
    event: { from?: number; to?: number } | undefined,
    context: { items: Cell<number[]> },
  ) => {
    const current = initializeItems(context.items);
    const length = current.length;
    if (length === 0) {
      return;
    }

    const fromIndex = clampIndex(event?.from, length);
    const toIndex = clampIndex(event?.to, length);
    if (fromIndex === toIndex) {
      return;
    }

    const next = current.slice();
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    context.items.set(next);
  },
);

export const counterWithReorderableList = recipe<ReorderableListArgs>(
  "Counter With Reorderable List",
  ({ items }) => {
    const positions = derive(
      items,
      (values): PositionState[] =>
        normalizeItems(values).map((value, index) => ({ index, value })),
    );
    const size = lift((values: number[] | undefined) =>
      normalizeItems(values).length
    )(items);
    const orderText = derive(
      items,
      (values) => {
        const normalized = normalizeItems(values);
        if (normalized.length === 0) {
          return "(empty)";
        }
        return normalized.map((value) => `${value}`).join(" -> ");
      },
    );

    return {
      items,
      positions,
      size,
      label: str`Order: ${orderText}`,
      reorder: reorderItems({ items }),
    };
  },
);
