/// <cts-enable />
import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commontools";

// ===== Types =====

interface Input {
  value: Writable<Default<number, 0>>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  value: number;
  increment: Stream<void>;
  decrement: Stream<void>;
}

// ===== Handlers at module scope =====
// Handler<Args, Context> - Args is what .send() receives, Context is bound state

const increment = handler<void, { value: Writable<number> }>(
  (_, { value }) => {
    value.set(value.get() + 1);
  },
);

const decrement = handler<void, { value: Writable<number> }>(
  (_, { value }) => {
    value.set(value.get() - 1);
  },
);

// ===== Helper functions =====

function ordinal(n: number): string {
  const num = n ?? 0;
  if (num === 1) return "1st";
  if (num === 2) return "2nd";
  if (num === 3) return "3rd";
  return `${num}th`;
}

// ===== Pattern =====

export default pattern<Input, Output>(({ value }) => {
  // Bind handlers with their required context
  const boundIncrement = increment({ value });
  const boundDecrement = decrement({ value });

  // Computed values - ordinal needs computed() to work with reactive value
  const displayName = computed(() => `Counter: ${value}`);
  const ordinalDisplay = computed(() => ordinal(value.get()));

  return {
    [NAME]: displayName,
    [UI]: (
      <ct-screen>
        <ct-vstack slot="header" gap="1">
          <ct-heading level={4}>Simple Counter</ct-heading>
        </ct-vstack>

        <ct-vstack gap="3" style="padding: 2rem; align-items: center;">
          <div
            style={{
              fontSize: "3rem",
              fontWeight: "bold",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {value}
          </div>

          <div style={{ color: "var(--ct-color-gray-500)" }}>
            The {ordinalDisplay} number
          </div>

          <ct-hstack gap="2">
            <ct-button
              id="counter-decrement"
              variant="secondary"
              onClick={() => boundDecrement.send()}
            >
              - Decrement
            </ct-button>
            <ct-button
              id="counter-increment"
              variant="primary"
              onClick={() => boundIncrement.send()}
            >
              + Increment
            </ct-button>
          </ct-hstack>
        </ct-vstack>
      </ct-screen>
    ),
    value,
    increment: boundIncrement,
    decrement: boundDecrement,
  };
});
