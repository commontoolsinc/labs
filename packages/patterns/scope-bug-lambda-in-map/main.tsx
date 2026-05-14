/**
 * Repro: cf-button onClick lambda not firing when inside derive().map()
 *
 * Bug: clicking a cf-button whose onClick is a lambda `() => stream.send({id})`
 * inside a `derive(...).map(...)` does not invoke the lambda. The same lambda
 * shape inside a direct reactive-property `.map(...)` works fine.
 *
 * Two side-by-side columns demonstrate the contrast:
 *   Left  — items.map(...)  direct property map    → onClick lambda WORKS
 *   Right — derived.map(...) derived-cell map       → onClick lambda BROKEN
 *
 * Both columns bind the same `boundIncrement` stream and use the same lambda
 * shape: `() => boundIncrement.send({ id: item.id })`.
 */

import {
  Default,
  derive,
  handler,
  NAME,
  pattern,
  type PerSpace,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export interface Item {
  id: string;
  label: string;
  clicks: number | Default<0>;
}

export interface IncrementEvent {
  id: string;
  step?: "single" | "double";
}

type ItemsCell = Writable<Item[] | Default<[]>>;

const incrementClicks = handler<IncrementEvent, { items: ItemsCell }>(
  ({ id, step }, { items }) => {
    const all = items.get();
    const idx = all.findIndex((i) => i.id === id);
    if (idx < 0) return;
    const inc = step === "double" ? 2 : 1;
    items.key(idx).key("clicks").set((all[idx].clicks as number ?? 0) + inc);
  },
);

export interface LambdaInMapInput {
  items?: PerSpace<Item[] | Default<[]>>;
}

export interface LambdaInMapOutput {
  [NAME]: string;
  [UI]: VNode;
  items: readonly Item[];
  increment: Stream<IncrementEvent>;
}

export default pattern<LambdaInMapInput, LambdaInMapOutput>(({ items }) => {
  const boundIncrement = incrementClicks({ items });

  // Derived array — same data, but now a reactive derived cell rather than a
  // direct property reference. This is the shape used by cozy-poll-scoped's
  // `ranked` cell.
  const derived = derive(
    { items },
    ({ items }) => [...items].sort((a, b) => b.clicks - a.clicks),
  );

  return {
    [NAME]: "Lambda-in-map repro",
    [UI]: (
      <cf-screen>
        <cf-vstack slot="header" gap="1" padding="4">
          <cf-heading level={2}>cf-button onClick in map() repro</cf-heading>
          <div>
            Left: <code>items.map()</code>{" "}
            — direct reactive property map (expected: working)
            <br />
            Right: <code>derived.map()</code>{" "}
            — derived cell map (suspected broken)
            <br />
            Both use <code>{"() => boundIncrement.send({ id: item.id })"}</code>
          </div>
        </cf-vstack>

        <cf-hstack gap="4" padding="4" align="start">
          {/* LEFT: direct reactive-property map */}
          <cf-vstack gap="2" style="flex:1">
            <cf-heading level={4}>Direct: items.map()</cf-heading>
            {items.map((item) => (
              <cf-card>
                <cf-hstack slot="content" gap="2" align="center">
                  <span style="flex:1">
                    {item.label} — clicks: {item.clicks}
                  </span>
                  <cf-button
                    id={`direct-btn-${item.id}`}
                    onClick={() => boundIncrement.send({ id: item.id })}
                  >
                    +1
                  </cf-button>
                </cf-hstack>
              </cf-card>
            ))}
          </cf-vstack>

          {/* MIDDLE: derive().map() with terse arrow body — should still work */}
          <cf-vstack gap="2" style="flex:1">
            <cf-heading level={4}>derived.map(terse)</cf-heading>
            {derived.map((item) => (
              <cf-card>
                <cf-hstack slot="content" gap="2" align="center">
                  <span style="flex:1">
                    {item.label} — clicks: {item.clicks}
                  </span>
                  <cf-button
                    id={`derived-btn-${item.id}`}
                    onClick={() => boundIncrement.send({ id: item.id })}
                  >
                    +1
                  </cf-button>
                </cf-hstack>
              </cf-card>
            ))}
          </cf-vstack>

          {/* MIDDLE-RIGHT: block body + hoisted const */}
          <cf-vstack gap="2" style="flex:1">
            <cf-heading level={4}>block + hoisted</cf-heading>
            {derived.map((item) => {
              const id = item.id;
              const label = item.label;
              return (
                <cf-card>
                  <cf-hstack slot="content" gap="2" align="center">
                    <span style="flex:1">
                      {label} — clicks: {item.clicks}
                    </span>
                    <cf-button
                      id={`hoisted-btn-${id}`}
                      onClick={() => boundIncrement.send({ id })}
                    >
                      +1
                    </cf-button>
                  </cf-hstack>
                </cf-card>
              );
            })}
          </cf-vstack>

          {/* MIDDLE-FAR: inner derive() inside map body */}
          <cf-vstack gap="2" style="flex:1">
            <cf-heading level={4}>block + inner derive</cf-heading>
            {derived.map((item) => {
              const iid = item.id;
              const isPositive = derive(
                { items, target: iid },
                ({ items, target }) =>
                  (items.find((i) => i.id === target)?.clicks ?? 0) > 0,
              );
              return (
                <cf-card>
                  <cf-hstack slot="content" gap="2" align="center">
                    <span style="flex:1">
                      {item.label} — positive? {isPositive ? "yes" : "no"}
                    </span>
                    <cf-button
                      id={`innerderive-btn-${iid}`}
                      onClick={() => boundIncrement.send({ id: iid })}
                    >
                      +1
                    </cf-button>
                  </cf-hstack>
                </cf-card>
              );
            })}
          </cf-vstack>

          {/* RIGHT: 3 buttons w/ STRING LITERAL in payload — cozy-poll's shape */}
          <cf-vstack gap="2" style="flex:1">
            <cf-heading level={4}>
              literal in payload (cozy-poll shape)
            </cf-heading>
            {derived.map((item) => {
              const iid = item.id;
              return (
                <cf-card>
                  <cf-hstack slot="content" gap="1" align="center">
                    <span style="flex:1">
                      {item.label} ({item.clicks})
                    </span>
                    <cf-button
                      id={`lit-a-${iid}`}
                      onClick={() =>
                        boundIncrement.send({ id: iid, step: "single" })}
                    >
                      +1
                    </cf-button>
                    <cf-button
                      id={`lit-b-${iid}`}
                      onClick={() =>
                        boundIncrement.send({ id: iid, step: "double" })}
                    >
                      +2
                    </cf-button>
                  </cf-hstack>
                </cf-card>
              );
            })}
          </cf-vstack>
        </cf-hstack>
      </cf-screen>
    ),
    items: derive(items, (i) => i),
    increment: boundIncrement,
  };
});
