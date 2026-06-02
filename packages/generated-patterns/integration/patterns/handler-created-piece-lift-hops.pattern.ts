import { type Cell, Default, handler, lift, pattern, str } from "commonfabric";

// Repro for the "lift() in a handler-created piece resolves only at 1 hop"
// gotcha. The structure mirrors a real cold-load chain:
//
//   Root --(handler: spawn)--> Viewer({ items })
//     Viewer builds a lift from `items` in its OWN body          (1 hop)
//     Viewer also delegates `items` to a nested Child pattern,
//     which builds a lift from `items` in ITS body              (2 hops)
//
// The original hypothesis: the 1-hop lift resolves but the 2-hop (nested
// child) lift comes back empty. This pattern + its test verify whether that
// is actually true.

type Item = { label: string };

// A lift that summarizes the passed-in items list. Used at both hop depths so
// the only difference between the two readings is WHERE the lift is built.
const summarizeItems = lift((items: Item[] | undefined) => {
  const list = Array.isArray(items) ? items : [];
  return {
    count: list.length,
    labels: list.map((it) => it?.label ?? "").join(","),
  };
});

interface ChildArgs {
  items: Default<Item[], []>;
}

type ItemSummary = { count: number; labels: string };

interface ChildState {
  // 2-hop lift: built inside the nested child the Viewer instantiates.
  nestedSummary: ItemSummary;
  nestedLabel: string;
}

// Nested child pattern: receives `items` (delegated down from Viewer) and
// builds the lift here — two hops from the handler that created the Viewer.
const Child = pattern<ChildArgs, ChildState>(({ items }) => {
  const nestedSummary = summarizeItems(items);
  return {
    nestedSummary,
    nestedLabel: str`nested:${nestedSummary.count}`,
  };
});

interface ViewerArgs {
  items: Default<Item[], []>;
}

interface ViewerState {
  // 1-hop lift: built in the Viewer's own body.
  ownSummary: ItemSummary;
  ownLabel: string;
  child: ChildState;
}

// The handler-created piece. Builds a lift from `items` in its own body (1
// hop) AND delegates `items` to a nested Child that builds the same lift (2
// hops).
const Viewer = pattern<ViewerArgs, ViewerState>(({ items }) => {
  const ownSummary = summarizeItems(items);
  return {
    ownSummary,
    ownLabel: str`own:${ownSummary.count}`,
    child: Child({ items }),
  };
});

type SpawnedViewer = ViewerState;

interface RootArgs {
  items: Default<Item[], []>;
  viewers: Default<SpawnedViewer[], []>;
}

// Handler that creates the Viewer piece, passing the root's `items` cell down
// through it. This is the handler -> create-piece path the gotcha is about.
const spawnViewer = handler(
  (
    _event: unknown,
    context: { items: Cell<Item[]>; viewers: Cell<SpawnedViewer[]> },
  ) => {
    const viewer = Viewer({ items: context.items });
    context.viewers.push(viewer);
  },
);

export const handlerCreatedPieceLiftHops = pattern<RootArgs>(
  ({ items, viewers }) => {
    return {
      items,
      viewers,
      spawn: spawnViewer({ items, viewers }),
    };
  },
);

export default handlerCreatedPieceLiftHops;
